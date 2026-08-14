import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TurnCheckpoint, type RestoreResult } from "./turn-checkpoint.ts";

const BUILT_IN_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_RETAINED_MUTATION_CHECKPOINTS = 20;
const MAX_RETAINED_TURN_RECORDS = 64;

type UserEntry = { id: string; text: string };

type TurnRecord = {
  userEntryId?: string;
  promptText: string;
  checkpoint?: TurnCheckpoint;
  checkpointPromise?: Promise<TurnCheckpoint>;
  finalizing?: Promise<void>;
  mutationCheckpoint: boolean;
  checkpointEvicted: boolean;
  sawBashTool: boolean;
  sawCustomTool: boolean;
};

type ToolCallEvent = {
  toolName: string;
  input: unknown;
};

type PathToolCallEvent = ToolCallEvent & {
  toolName: "edit" | "write";
  input: { path: string };
};

function isPathToolCallEvent(event: ToolCallEvent): event is PathToolCallEvent {
  if (event.toolName !== "edit" && event.toolName !== "write") return false;
  return (
    typeof event.input === "object" &&
    event.input !== null &&
    "path" in event.input &&
    typeof (event.input as { path?: unknown }).path === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findLatestUserEntry(ctx: ExtensionContext): UserEntry | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message.role === "user") {
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
      return { id: entry.id, text };
    }
  }
  return undefined;
}

function contentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  return typeof content === "string"
    ? content
    : content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
}

function createTurnRecord(promptText: string): TurnRecord {
  return {
    promptText,
    mutationCheckpoint: false,
    checkpointEvicted: false,
    sawBashTool: false,
    sawCustomTool: false,
  };
}

export default function (pi: ExtensionAPI) {
  const turnHistory = new Map<string, TurnRecord>();
  let activeTurn: TurnRecord | undefined;
  let undoInProgress = false;

  function bindTurnToLatestUser(
    turn: TurnRecord,
    ctx: ExtensionContext,
  ): UserEntry | undefined {
    if (turn.userEntryId) {
      return { id: turn.userEntryId, text: turn.promptText };
    }
    const userEntry = findLatestUserEntry(ctx);
    if (!userEntry) return undefined;
    turn.userEntryId = userEntry.id;
    turn.promptText = userEntry.text;
    turnHistory.set(userEntry.id, turn);
    return userEntry;
  }

  function ensureActiveTurn(ctx: ExtensionContext): TurnRecord {
    if (!activeTurn) {
      activeTurn = createTurnRecord(findLatestUserEntry(ctx)?.text ?? "");
    }
    bindTurnToLatestUser(activeTurn, ctx);
    return activeTurn;
  }

  async function disposeRecord(record: TurnRecord): Promise<void> {
    const checkpoint =
      record.checkpoint ??
      (await record.checkpointPromise?.catch(() => undefined));
    await checkpoint?.dispose();
    record.checkpoint = undefined;
    record.checkpointPromise = undefined;
    record.finalizing = undefined;
  }

  async function pruneHistory(ctx: ExtensionContext): Promise<void> {
    const branchIds = new Set(
      ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
    );

    for (const [id, record] of [...turnHistory]) {
      if (!branchIds.has(id) && record !== activeTurn) {
        turnHistory.delete(id);
        await disposeRecord(record);
      }
    }

    while (turnHistory.size > MAX_RETAINED_TURN_RECORDS) {
      const oldest = [...turnHistory].find(([, record]) => record !== activeTurn);
      if (!oldest) break;
      turnHistory.delete(oldest[0]);
      await disposeRecord(oldest[1]);
    }

    const mutationRecords = [...turnHistory].filter(
      ([, record]) => record.mutationCheckpoint && record.checkpointPromise,
    );
    for (const [, record] of mutationRecords.slice(
      0,
      Math.max(0, mutationRecords.length - MAX_RETAINED_MUTATION_CHECKPOINTS),
    )) {
      if (record === activeTurn) continue;
      await record.finalizing;
      await disposeRecord(record);
      record.checkpointEvicted = true;
    }
  }

  async function getCheckpoint(
    turn: TurnRecord,
    ctx: ExtensionContext,
  ): Promise<TurnCheckpoint> {
    if (!turn.checkpointPromise) {
      turn.mutationCheckpoint = true;
      turn.checkpointEvicted = false;
      turn.checkpointPromise = TurnCheckpoint.create(ctx.cwd, ctx.signal).then(
        (created) => {
          turn.checkpoint = created;
          return created;
        },
      );
    }
    return turn.checkpointPromise;
  }

  async function finalizeTurn(
    turn: TurnRecord,
    ctx: ExtensionContext,
  ): Promise<void> {
    bindTurnToLatestUser(turn, ctx);
    if (!turn.checkpointPromise) return;
    if (!turn.finalizing) {
      turn.finalizing = turn.checkpointPromise.then(async (checkpoint) => {
        await checkpoint.finalize(ctx.signal);
      });
    }
    await turn.finalizing;
  }

  function coverageWarning(record: TurnRecord | undefined): string | undefined {
    if (!record) {
      return "This turn has no live file checkpoint (it may predate this extension load or retention window). Conversation undo is still available, but file changes cannot be restored.";
    }
    if (record.checkpointEvicted) {
      return "This turn's file checkpoint was evicted by the retention limit. Conversation undo is still available, but file changes cannot be restored.";
    }
    if (!record.mutationCheckpoint) return undefined;
    if (!record.checkpoint) {
      return "This turn has no live file checkpoint. Conversation undo is still available, but file changes cannot be restored.";
    }
    const usedBroadMutationTool = record.sawBashTool || record.sawCustomTool;
    if (!usedBroadMutationTool) return undefined;
    if (record.checkpoint.gitCoverage.status === "not-repository") {
      return "This turn ran bash or custom tools outside a Git worktree; their file changes cannot be detected completely.";
    }
    if (record.checkpoint.gitCoverage.status === "failed") {
      return `The Git checkpoint failed: ${record.checkpoint.gitCoverage.error}`;
    }
    return "Bash/custom-tool changes to ignored files or paths outside the Git worktree may not be detected.";
  }

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user" && activeTurn) {
      bindTurnToLatestUser(activeTurn, ctx);
    }
    await pruneHistory(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "user") return;
    if (activeTurn) await finalizeTurn(activeTurn, ctx);
    activeTurn = createTurnRecord(contentText(event.message.content));
    await pruneHistory(ctx);
  });

  pi.on("tool_call", async (rawEvent, ctx) => {
    const event = rawEvent as ToolCallEvent;
    const turn = ensureActiveTurn(ctx);

    if (event.toolName === "bash") {
      turn.sawBashTool = true;
      const checkpoint = await getCheckpoint(turn, ctx);
      await checkpoint.capture(ctx.signal);
      await pruneHistory(ctx);
      return;
    }

    if (!isPathToolCallEvent(event)) {
      if (!BUILT_IN_READ_ONLY_TOOLS.has(event.toolName)) {
        turn.sawCustomTool = true;
        const checkpoint = await getCheckpoint(turn, ctx);
        await checkpoint.capture(ctx.signal);
        await pruneHistory(ctx);
      }
      return;
    }

    const checkpoint = await getCheckpoint(turn, ctx);
    try {
      await checkpoint.captureFile(event.input.path, ctx.signal);
      await pruneHistory(ctx);
    } catch (error) {
      return {
        block: true,
        reason: `undo could not safely snapshot ${event.input.path}: ${errorMessage(error)}`,
      };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (activeTurn) await finalizeTurn(activeTurn, ctx);
    await pruneHistory(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    // The active /undo still owns its compensation storage until navigation
    // returns to the command handler.
    if (undoInProgress) return;
    const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
    if (activeTurn?.userEntryId && !branchIds.has(activeTurn.userEntryId)) {
      activeTurn = undefined;
    }
    await pruneHistory(ctx);
  });

  pi.on("session_shutdown", async () => {
    const records = new Set(turnHistory.values());
    if (activeTurn) records.add(activeTurn);
    turnHistory.clear();
    activeTurn = undefined;
    await Promise.all([...records].map(disposeRecord));
  });

  pi.registerCommand("undo", {
    description:
      "Undo one conversation checkpoint; repeat to step backward through earlier turns",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (undoInProgress) {
        ctx.ui.notify("undo: another undo is already in progress.", "warning");
        return;
      }
      undoInProgress = true;

      try {
        const option = args?.trim() ?? "";
        if (option && option !== "-f" && option !== "--force") {
          ctx.ui.notify("Usage: /undo [--force]", "warning");
          return;
        }
        const force = option === "-f" || option === "--force";
        const latestUserEntry = findLatestUserEntry(ctx);
        if (!latestUserEntry) {
          ctx.ui.notify(
            "undo: there is no earlier conversation checkpoint.",
            "info",
          );
          return;
        }

        const record = turnHistory.get(latestUserEntry.id);
        await record?.finalizing;
        const warning = coverageWarning(record);

        if (ctx.hasUI && !force) {
          const details = [
            "This will return to before the latest message, restore that message in the editor, and revert its recorded file changes. Run /undo again to step back one more checkpoint.",
            warning,
          ]
            .filter(Boolean)
            .join("\n\n");
          const confirmed = await ctx.ui.confirm("Undo one checkpoint?", details);
          if (!confirmed) return;
        } else if (!ctx.hasUI && !force) {
          throw new Error(
            "Undo requires confirmation without an interactive UI. Use /undo --force to proceed.",
          );
        }

        let rollback: (() => Promise<RestoreResult>) | undefined;
        let commit: (() => Promise<void>) | undefined;
        let restoredFileCount = 0;
        if (record?.checkpoint) {
          const result = await record.checkpoint.restore();
          if (result.errors.length > 0) {
            ctx.ui.notify(
              `undo: file restore failed; conversation was not changed. ${result.errors.slice(0, 3).join("; ")}`,
              "error",
            );
            return;
          }
          rollback = result.rollback;
          commit = result.commit;
          restoredFileCount = result.restoredFiles.length;
        }

        let navigation: { cancelled: boolean };
        try {
          navigation = await ctx.navigateTree(latestUserEntry.id, {
            summarize: false,
          });
        } catch (error) {
          const rollbackResult = await rollback?.();
          const rollbackErrors = rollbackResult?.errors ?? [];
          ctx.ui.notify(
            rollbackErrors.length > 0
              ? `undo: navigation failed and file rollback also refused or failed: ${rollbackErrors.slice(0, 3).join("; ")}`
              : `undo: navigation failed; file changes were put back. ${errorMessage(error)}`,
            "error",
          );
          return;
        }

        if (navigation.cancelled) {
          const rollbackResult = await rollback?.();
          const rollbackErrors = rollbackResult?.errors ?? [];
          ctx.ui.notify(
            rollbackErrors.length > 0
              ? `undo: navigation was cancelled and file rollback refused or failed: ${rollbackErrors.slice(0, 3).join("; ")}`
              : "undo: navigation was cancelled; file changes were put back.",
            rollbackErrors.length > 0 ? "error" : "warning",
          );
          return;
        }

        await commit?.();
        if (activeTurn?.userEntryId === latestUserEntry.id) activeTurn = undefined;
        await pruneHistory(ctx);
        if (ctx.hasUI) ctx.ui.setEditorText(latestUserEntry.text);
        if (restoredFileCount > 0) {
          ctx.ui.notify(`undo: restored ${restoredFileCount} file(s).`, "info");
        }

        ctx.ui.notify(
          warning
            ? `undo: moved back one checkpoint. Warning: ${warning}`
            : "undo: moved back one checkpoint; run /undo again to continue backward.",
          warning ? "warning" : "info",
        );
      } finally {
        undoInProgress = false;
      }
    },
  });
}
