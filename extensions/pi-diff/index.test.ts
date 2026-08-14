import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piDiffExtension from "./index.ts";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-diff-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

type Entry = {
	type: "custom";
	customType: string;
	data: unknown;
};

function createHarness(cwd: string, entries: Entry[] = []) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string | undefined, ctx: any) => Promise<void> }>();
	const statuses: unknown[] = [];
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
	};
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => entries },
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			setStatus: (_name: string, value: unknown) => statuses.push(value),
			setWidget() {},
			notify: (message: string) => notifications.push(message),
			confirm: async () => true,
		},
	};
	piDiffExtension(pi as any);
	return { commands, ctx, entries, handlers, notifications, statuses };
}

async function emit(harness: ReturnType<typeof createHarness>, name: string, event: any) {
	for (const handler of harness.handlers.get(name) ?? []) await handler(event, harness.ctx);
}

async function recordWrite(
	harness: ReturnType<typeof createHarness>,
	file: string,
	before: string,
	after: string,
) {
	await writeFile(file, before);
	const event = { toolName: "write", toolCallId: "call", input: { path: file } };
	await emit(harness, "tool_call", event);
	await writeFile(file, after);
	await emit(harness, "tool_result", { ...event, isError: false, content: [], details: {} });
}

test("decline restores an unchanged recorded file", async () => {
	await withTempDir(async (directory) => {
		const file = join(directory, "file.txt");
		const harness = createHarness(directory);
		await emit(harness, "session_start", {});
		await recordWrite(harness, file, "before\n", "after\n");

		await harness.commands.get("pi-diff-decline-file")!.handler(file, harness.ctx);

		assert.equal(await readFile(file, "utf8"), "before\n");
		assert.match(harness.notifications.at(-1) ?? "", /reverted/);
	});
});

test("decline preserves a later external change and keeps it tracked", async () => {
	await withTempDir(async (directory) => {
		const file = join(directory, "file.txt");
		const harness = createHarness(directory);
		await emit(harness, "session_start", {});
		await recordWrite(harness, file, "before\n", "after\n");
		await writeFile(file, "external\n");

		await harness.commands.get("pi-diff-decline-file")!.handler(file, harness.ctx);

		assert.equal(await readFile(file, "utf8"), "external\n");
		assert.match(harness.notifications.at(-1) ?? "", /changed after pi-diff/);
	});
});

test("post-change fingerprints survive session replay", async () => {
	await withTempDir(async (directory) => {
		const file = join(directory, "file.txt");
		const first = createHarness(directory);
		await emit(first, "session_start", {});
		await recordWrite(first, file, "before\n", "after\n");

		const replayed = createHarness(directory, [...first.entries]);
		await emit(replayed, "session_start", {});
		await writeFile(file, "external\n");
		await replayed.commands.get("pi-diff-decline-file")!.handler(file, replayed.ctx);

		assert.equal(await readFile(file, "utf8"), "external\n");
		assert.match(replayed.notifications.at(-1) ?? "", /changed after pi-diff/);
	});
});
