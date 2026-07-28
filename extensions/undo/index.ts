import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isToolCallEventType,
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

type FileSnapshot = {
  absPath: string;
  relPath: string;
  originalContent: string | null; // null = file didn't exist (was created this turn)
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function stripAtPrefix(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

function normalizeToolPath(
  cwd: string,
  raw: string,
): { absPath: string; relPath: string } {
  const cleaned = stripAtPrefix(raw);
  const absPath = resolve(cwd, cleaned);
  const rel = relative(cwd, absPath);
  const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleaned;
  return { absPath, relPath };
}

async function readTextOrNull(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function ensureParentDir(absPath: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Per-turn state: file snapshots captured before edit/write operations.
  // Keyed by relPath. Only the FIRST snapshot per file per turn is kept.
  const snapshots = new Map<string, FileSnapshot>();
  // Pending snapshots keyed by toolCallId, waiting for tool_result to commit.
  const pendingByToolCallId = new Map<string, string>(); // toolCallId -> relPath

  function clearTurnState() {
    snapshots.clear();
    pendingByToolCallId.clear();
  }

  // ── File tracking ─────────────────────────────────────────────────────────

  // Capture file content before edit/write operations.
  pi.on("tool_call", async (event, ctx) => {
    if (
      isToolCallEventType("edit", event) ||
      isToolCallEventType("write", event)
    ) {
      const { absPath, relPath } = normalizeToolPath(ctx.cwd, event.input.path);

      // Only snapshot if we haven't already captured this file this turn.
      if (!snapshots.has(relPath)) {
        const originalContent = await readTextOrNull(absPath);
        snapshots.set(relPath, { absPath, relPath, originalContent });
      }

      // Track which tool call is touching which file.
      pendingByToolCallId.set(event.toolCallId, relPath);
    }
  });

  // On successful tool result, keep the snapshot. On error, discard it
  // (the file wasn't actually modified, so no need to revert).
  pi.on("tool_result", async (event) => {
    const relPath = pendingByToolCallId.get(event.toolCallId);
    pendingByToolCallId.delete(event.toolCallId);
    if (!relPath) return;

    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

    if (event.isError) {
      // The operation failed; remove the snapshot since no change was made.
      snapshots.delete(relPath);
    }
    // On success, keep the snapshot for undo.
  });

  pi.on("turn_start", () => {
    // Clear pending references from the previous turn but keep snapshots
    // accumulated during the current turn (they survive across retries).
    pendingByToolCallId.clear();
  });

  // Reset everything when a new user prompt starts.
  pi.on("before_agent_start", () => {
    clearTurnState();
  });

  // ── /undo command ─────────────────────────────────────────────────────────

  pi.registerCommand("undo", {
    description: "Undo the current turn: revert file changes and go back to your last message",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const force = args?.trim() === "-f" || args?.trim() === "--force";
      const hasFileChanges = snapshots.size > 0;

      // ── Confirm ──────────────────────────────────────────────────────────
      if (ctx.hasUI && !force) {
        const parts: string[] = [];
        if (hasFileChanges) {
          parts.push(`revert ${snapshots.size} file(s)`);
        }
        parts.push("go back to before your last message");

        const ok = await ctx.ui.confirm(
          "Undo this turn?",
          `This will ${parts.join(" and ")}.`,
        );
        if (!ok) return;
      } else if (!ctx.hasUI && !force) {
        throw new Error(
          "Undo requires confirmation in non-interactive mode. Use /undo --force to skip.",
        );
      }

      // ── Step 1: Revert file changes ───────────────────────────────────────
      if (hasFileChanges) {
        let revertCount = 0;
        const errors: string[] = [];

        // Take a copy since we'll be clearing.
        const entries = [...snapshots.entries()];

        for (const [relPath, snapshot] of entries) {
          try {
            if (snapshot.originalContent === null) {
              await rm(snapshot.absPath, { force: true });
            } else {
              await ensureParentDir(snapshot.absPath);
              await writeFile(snapshot.absPath, snapshot.originalContent, "utf-8");
            }
            revertCount++;
          } catch (e: any) {
            errors.push(`${relPath}: ${e?.message ?? String(e)}`);
          }
        }

        if (ctx.hasUI) {
          if (errors.length === 0) {
            ctx.ui.notify(
              `undo: reverted ${revertCount} file(s)`,
              "success",
            );
          } else {
            ctx.ui.notify(
              `undo: reverted ${revertCount} file(s), ${errors.length} error(s)`,
              "warning",
            );
            console.warn("[undo] revert errors:\n" + errors.join("\n"));
          }
        }
      }

      // ── Step 2: Fork to before the current user message ──────────────────
      const branch = ctx.sessionManager.getBranch();
      let lastUserEntryId: string | null = null;

      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" && entry.message.role === "user") {
          lastUserEntryId = entry.id;
          break;
        }
      }

      if (!lastUserEntryId) {
        if (ctx.hasUI && !hasFileChanges) {
          ctx.ui.notify("undo: nothing to undo.", "info");
        }
        clearTurnState();
        return;
      }

      try {
        // Fork before the current user message. The fork with
        // position:"before" restores that message text into the editor,
        // so the user can edit and re-submit.
        await ctx.fork(lastUserEntryId, {
          position: "before",
        });
        // Session is replaced at this point — this extension instance is
        // shut down and rebound. The new session starts fresh.
      } catch (e: any) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `undo: failed to fork session: ${e?.message ?? String(e)}`,
            "error",
          );
        }
        clearTurnState();
      }
    },
  });
}
