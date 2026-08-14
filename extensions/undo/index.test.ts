import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "bun:test";

const pendingCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of pendingCleanups.splice(0)) cleanup();
});
import undoExtension from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

type MessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: { role: "user" | "assistant"; content: string };
};

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { handler: (args: string | undefined, ctx: any) => Promise<void> }
  >();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  };
  undoExtension(pi as any);
  return { handlers, commands };
}

function createContext() {
  let branch: MessageEntry[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "pi-undo-index-test-"));
  const notifications: Array<{ message: string; level: string }> = [];
  const editorTexts: string[] = [];
  const navigatedIds: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    signal: undefined,
    sessionManager: { getBranch: () => [...branch] },
    waitForIdle: async () => {},
    navigateTree: async (id: string) => {
      navigatedIds.push(id);
      const targetIndex = branch.findIndex((entry) => entry.id === id);
      branch = branch.slice(0, targetIndex);
      return { cancelled: false };
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      confirm: async () => true,
      setEditorText(text: string) {
        editorTexts.push(text);
      },
    },
  };

  function append(role: "user" | "assistant", id: string, content: string): void {
    branch.push({
      type: "message",
      id,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message: { role, content },
    });
  }

  const cleanup = () => rmSync(cwd, { recursive: true, force: true });
  pendingCleanups.push(cleanup);
  return {
    ctx,
    append,
    getBranch: () => [...branch],
    notifications,
    editorTexts,
    navigatedIds,
    cleanup,
  };
}

async function emit(
  handlers: Map<string, Handler[]>,
  name: string,
  event: any,
  ctx: any,
): Promise<unknown> {
  let result: unknown;
  for (const handler of handlers.get(name) ?? []) {
    const handlerResult = await handler(event, ctx);
    if (handlerResult !== undefined) result = handlerResult;
  }
  return result;
}

async function completeTurn(
  handlers: Map<string, Handler[]>,
  harness: ReturnType<typeof createContext>,
  turn: number,
): Promise<void> {
  const userMessage = { role: "user", content: `turn ${turn}` };
  await emit(handlers, "message_end", { message: userMessage }, harness.ctx);
  harness.append("user", `user-${turn}`, `turn ${turn}`);
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: `answer ${turn}` } },
    harness.ctx,
  );
  harness.append("assistant", `assistant-${turn}`, `answer ${turn}`);
  await emit(handlers, "agent_settled", {}, harness.ctx);
}

test("each repeated undo moves back exactly one recorded conversation turn", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();

  await completeTurn(handlers, harness, 1);
  await completeTurn(handlers, harness, 2);
  await completeTurn(handlers, harness, 3);

  const messageCounts: number[] = [];
  for (let count = 0; count < 3; count++) {
    await commands.get("undo")!.handler("--force", harness.ctx);
    messageCounts.push(harness.getBranch().length);
  }

  assert.deepEqual(messageCounts, [4, 2, 0]);
  assert.deepEqual(harness.navigatedIds, ["user-3", "user-2", "user-1"]);
  assert.deepEqual(harness.editorTexts, ["turn 3", "turn 2", "turn 1"]);
});

test("queued user messages each receive a separate checkpoint", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "turn 1" } },
    harness.ctx,
  );
  harness.append("user", "user-1", "turn 1");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "answer 1" } },
    harness.ctx,
  );
  harness.append("assistant", "assistant-1", "answer 1");

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "queued turn 2" } },
    harness.ctx,
  );
  harness.append("user", "user-2", "queued turn 2");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "answer 2" } },
    harness.ctx,
  );
  harness.append("assistant", "assistant-2", "answer 2");
  await emit(handlers, "agent_settled", {}, harness.ctx);

  await commands.get("undo")!.handler("--force", harness.ctx);
  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.deepEqual(harness.navigatedIds, ["user-2", "user-1"]);
  assert.deepEqual(harness.editorTexts, ["queued turn 2", "turn 1"]);
  assert.equal(harness.getBranch().length, 0);
});

test("turn records survive an intervening user message boundary", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();

  await completeTurn(handlers, harness, 1);
  await completeTurn(handlers, harness, 2);
  await commands.get("undo")!.handler("--force", harness.ctx);
  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.deepEqual(harness.navigatedIds, ["user-2", "user-1"]);
  assert.equal(harness.getBranch().length, 0);
});

test("historical turns without a live file checkpoint still support conversation undo", async () => {
  const { commands } = createHarness();
  const harness = createContext();
  harness.append("user", "historical-user", "old turn");
  harness.append("assistant", "historical-assistant", "old answer");

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.deepEqual(harness.navigatedIds, ["historical-user"]);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /no live file checkpoint/,
  );
});

async function completeFileTurn(
  handlers: Map<string, Handler[]>,
  harness: ReturnType<typeof createContext>,
  turn: number,
  file: string,
  result: string,
): Promise<void> {
  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: `file turn ${turn}` } },
    harness.ctx,
  );
  harness.append("user", `file-user-${turn}`, `file turn ${turn}`);
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );
  const toolResult = await emit(
    handlers,
    "tool_call",
    { toolName: "edit", toolCallId: `edit-${turn}`, input: { path: file } },
    harness.ctx,
  );
  assert.equal(toolResult, undefined);
  writeFileSync(file, result);
  harness.append("assistant", `file-assistant-${turn}`, "done");
  await emit(handlers, "agent_settled", {}, harness.ctx);
}

function checkpointTempDirectoriesSync(): Set<string> {
  return new Set(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith(`pi-undo-checkpoint-${process.pid}-`))
      .map((name) => join(tmpdir(), name)),
  );
}

test("undo restores files and conversation together", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "file.txt");
  writeFileSync(file, "before\n");

  await completeFileTurn(handlers, harness, 1, file, "after\n");
  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "before\n");
  assert.equal(harness.getBranch().length, 0);
  assert.deepEqual(harness.editorTexts, ["file turn 1"]);
});

test("a read-only turn does not restore an unrelated manual change", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "manual.txt");
  writeFileSync(file, "before\n");

  await completeTurn(handlers, harness, 1);
  writeFileSync(file, "manual after settle\n");
  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "manual after settle\n");
  assert.doesNotMatch(
    harness.notifications.at(-1)?.message ?? "",
    /no live file checkpoint/,
  );
});

test("cancelled navigation compensates a file restore", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "file.txt");
  writeFileSync(file, "before\n");
  await completeFileTurn(handlers, harness, 1, file, "turn result\n");
  harness.ctx.navigateTree = async () => ({ cancelled: true });

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "turn result\n");
  assert.equal(harness.getBranch().length, 2);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /navigation was cancelled; file changes were put back/,
  );
});

test("thrown navigation compensates a file restore", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "file.txt");
  writeFileSync(file, "before\n");
  await completeFileTurn(handlers, harness, 1, file, "turn result\n");
  harness.ctx.navigateTree = async () => {
    throw new Error("navigation failed");
  };

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "turn result\n");
  assert.equal(harness.getBranch().length, 2);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /navigation failed; file changes were put back/,
  );
});

test("post-navigation UI failures do not compensate or leak an already moved conversation", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "file.txt");
  execFileSync("git", ["init", "-q"], { cwd: harness.ctx.cwd });
  writeFileSync(file, "before\n");
  const before = checkpointTempDirectoriesSync();

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "run bash" } },
    harness.ctx,
  );
  harness.append("user", "ui-failure-user", "run bash");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );
  await emit(
    handlers,
    "tool_call",
    { toolName: "bash", toolCallId: "bash-ui-failure", input: { command: "true" } },
    harness.ctx,
  );
  writeFileSync(file, "turn result\n");
  harness.append("assistant", "ui-failure-assistant", "done");
  await emit(handlers, "agent_settled", {}, harness.ctx);
  harness.ctx.ui.setEditorText = () => {
    throw new Error("editor unavailable");
  };

  await assert.rejects(
    commands.get("undo")!.handler("--force", harness.ctx),
    /editor unavailable/,
  );

  assert.equal(readFileSync(file, "utf8"), "before\n");
  assert.equal(harness.getBranch().length, 0);
  assert.deepEqual(checkpointTempDirectoriesSync(), before);
});

test("success notifications cannot roll files forward after navigation", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "file.txt");
  writeFileSync(file, "before\n");
  await completeFileTurn(handlers, harness, 1, file, "turn result\n");
  harness.ctx.ui.notify = () => {
    throw new Error("notifications unavailable");
  };

  await assert.rejects(
    commands.get("undo")!.handler("--force", harness.ctx),
    /notifications unavailable/,
  );

  assert.equal(readFileSync(file, "utf8"), "before\n");
  assert.equal(harness.getBranch().length, 0);
});

test("cancelled navigation cannot compensate over a navigation-time change", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "file.txt");
  writeFileSync(file, "before\n");
  await completeFileTurn(handlers, harness, 1, file, "turn result\n");
  harness.ctx.navigateTree = async () => {
    writeFileSync(file, "navigation-time change\n");
    return { cancelled: true };
  };

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "navigation-time change\n");
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /rollback refused or failed.*changed after the turn settled/,
  );
});

test("an evicted file checkpoint falls back to conversation-only undo", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const oldestFile = join(harness.ctx.cwd, "file-0.txt");

  for (let turn = 0; turn < 21; turn++) {
    const file = join(harness.ctx.cwd, `file-${turn}.txt`);
    writeFileSync(file, `before ${turn}\n`);
    await completeFileTurn(handlers, harness, turn, file, `after ${turn}\n`);
  }

  for (let turn = 0; turn < 21; turn++) {
    await commands.get("undo")!.handler("--force", harness.ctx);
  }

  assert.equal(readFileSync(oldestFile, "utf8"), "after 0\n");
  assert.equal(harness.getBranch().length, 0);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /checkpoint was evicted.*Conversation undo is still available/,
  );
});

test("unsafe direct snapshots block the tool call", async () => {
  const { handlers } = createHarness();
  const harness = createContext();
  const directory = join(harness.ctx.cwd, "directory");
  execFileSync("mkdir", [directory]);

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "edit a directory" } },
    harness.ctx,
  );
  harness.append("user", "blocked-user", "edit a directory");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );

  const result = await emit(
    handlers,
    "tool_call",
    { toolName: "edit", toolCallId: "edit-directory", input: { path: directory } },
    harness.ctx,
  );

  assert.deepEqual(result, {
    block: true,
    reason: `undo could not safely snapshot ${directory}: path is not a regular file`,
  });
});

test("session shutdown disposes broad checkpoint storage", async () => {
  const { handlers } = createHarness();
  const harness = createContext();
  execFileSync("git", ["init", "-q"], { cwd: harness.ctx.cwd });
  const before = checkpointTempDirectoriesSync();

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "run bash" } },
    harness.ctx,
  );
  harness.append("user", "bash-user", "run bash");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );
  await emit(
    handlers,
    "tool_call",
    { toolName: "bash", toolCallId: "bash-1", input: { command: "true" } },
    harness.ctx,
  );
  const created = [...checkpointTempDirectoriesSync()].filter(
    (path) => !before.has(path),
  );
  assert.equal(created.length, 1);

  await emit(handlers, "session_shutdown", {}, harness.ctx);

  assert.equal(existsSync(created[0]), false);
});

test("successful broad undo disposes all checkpoint storage", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "file.txt");
  execFileSync("git", ["init", "-q"], { cwd: harness.ctx.cwd });
  writeFileSync(file, "before\n");
  const before = checkpointTempDirectoriesSync();

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "run bash" } },
    harness.ctx,
  );
  harness.append("user", "broad-user", "run bash");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );
  await emit(
    handlers,
    "tool_call",
    { toolName: "bash", toolCallId: "bash-broad", input: { command: "true" } },
    harness.ctx,
  );
  writeFileSync(file, "after\n");
  harness.append("assistant", "broad-assistant", "done");
  await emit(handlers, "agent_settled", {}, harness.ctx);
  assert.equal(
    [...checkpointTempDirectoriesSync()].filter((path) => !before.has(path)).length,
    1,
  );

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "before\n");
  assert.deepEqual(checkpointTempDirectoriesSync(), before);
});

test("a broad checkpoint remains anchored before a later direct edit", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "shared.txt");
  execFileSync("git", ["init", "-q"], { cwd: harness.ctx.cwd });
  execFileSync("git", ["config", "user.email", "undo@example.test"], {
    cwd: harness.ctx.cwd,
  });
  execFileSync("git", ["config", "user.name", "Undo Test"], {
    cwd: harness.ctx.cwd,
  });
  writeFileSync(file, "before turn\n");
  execFileSync("git", ["add", "."], { cwd: harness.ctx.cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: harness.ctx.cwd });

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "bash then edit" } },
    harness.ctx,
  );
  harness.append("user", "broad-first-user", "bash then edit");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );
  await emit(
    handlers,
    "tool_call",
    { toolName: "bash", toolCallId: "bash-first", input: { command: "true" } },
    harness.ctx,
  );
  writeFileSync(file, "after bash\n");
  await emit(
    handlers,
    "tool_call",
    { toolName: "edit", toolCallId: "edit-second", input: { path: file } },
    harness.ctx,
  );
  writeFileSync(file, "after edit\n");
  harness.append("assistant", "broad-first-assistant", "done");
  await emit(handlers, "agent_settled", {}, harness.ctx);

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "before turn\n");
});

test("a direct path remains anchored before the turn when broad coverage later changes it", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const file = join(harness.ctx.cwd, "shared.txt");
  execFileSync("git", ["init", "-q"], { cwd: harness.ctx.cwd });
  execFileSync("git", ["config", "user.email", "undo@example.test"], {
    cwd: harness.ctx.cwd,
  });
  execFileSync("git", ["config", "user.name", "Undo Test"], {
    cwd: harness.ctx.cwd,
  });
  writeFileSync(file, "before turn\n");
  execFileSync("git", ["add", "."], { cwd: harness.ctx.cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: harness.ctx.cwd });

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "edit then bash" } },
    harness.ctx,
  );
  harness.append("user", "shared-user", "edit then bash");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );
  await emit(
    handlers,
    "tool_call",
    { toolName: "edit", toolCallId: "edit-shared", input: { path: file } },
    harness.ctx,
  );
  writeFileSync(file, "after edit\n");
  await emit(
    handlers,
    "tool_call",
    { toolName: "bash", toolCallId: "bash-shared", input: { command: "true" } },
    harness.ctx,
  );
  writeFileSync(file, "after bash\n");
  harness.append("assistant", "shared-assistant", "done");
  await emit(handlers, "agent_settled", {}, harness.ctx);

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(file, "utf8"), "before turn\n");
});

test("a direct-only checkpoint can upgrade to broad coverage in one turn", async () => {
  const { handlers, commands } = createHarness();
  const harness = createContext();
  const directFile = join(harness.ctx.cwd, "direct.txt");
  const broadFile = join(harness.ctx.cwd, "broad.txt");
  execFileSync("git", ["init", "-q"], { cwd: harness.ctx.cwd });
  execFileSync("git", ["config", "user.email", "undo@example.test"], {
    cwd: harness.ctx.cwd,
  });
  execFileSync("git", ["config", "user.name", "Undo Test"], {
    cwd: harness.ctx.cwd,
  });
  writeFileSync(directFile, "direct before\n");
  writeFileSync(broadFile, "broad before\n");
  execFileSync("git", ["add", "."], { cwd: harness.ctx.cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: harness.ctx.cwd });

  await emit(
    handlers,
    "message_end",
    { message: { role: "user", content: "mixed tools" } },
    harness.ctx,
  );
  harness.append("user", "mixed-user", "mixed tools");
  await emit(
    handlers,
    "message_start",
    { message: { role: "assistant", content: "working" } },
    harness.ctx,
  );
  await emit(
    handlers,
    "tool_call",
    { toolName: "edit", toolCallId: "edit-mixed", input: { path: directFile } },
    harness.ctx,
  );
  writeFileSync(directFile, "direct after\n");
  await emit(
    handlers,
    "tool_call",
    { toolName: "bash", toolCallId: "bash-mixed", input: { command: "true" } },
    harness.ctx,
  );
  writeFileSync(broadFile, "broad after\n");
  harness.append("assistant", "mixed-assistant", "done");
  await emit(handlers, "agent_settled", {}, harness.ctx);

  await commands.get("undo")!.handler("--force", harness.ctx);

  assert.equal(readFileSync(directFile, "utf8"), "direct before\n");
  assert.equal(readFileSync(broadFile, "utf8"), "broad before\n");
});
