import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
	Container,
	Key,
	Markdown,
	SelectList,
	Text,
	matchesKey,
} from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { dirname, relative, resolve } from "node:path";

// Custom session entry types
// New name: pi-diff
const ENTRY_BASELINE = "pi-diff:baseline";
const ENTRY_CLEAR = "pi-diff:clear";
const ENTRY_UPDATE = "pi-diff:update";
const ENTRY_UNTRACK = "pi-diff:untrack";

type Baseline = {
	path: string; // normalized path relative to ctx.cwd where possible
	absPath: string;
	originalContent: string | null; // null => file did not exist (created)
};

type TrackedFile = {
	path: string;
	absPath: string;
	displayPath: string;
	originalContent: string | null;
	currentContent: string | null;
	recordedHash: string | undefined;
	diff: string;
	added: number;
	removed: number;
	kind: "new" | "edited";
	updatedAt: number;
};

type PendingSnapshot = {
	path: string;
	absPath: string;
	before: string | null;
};

function stripAtPrefix(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

function normalizeToolPath(
	cwd: string,
	raw: string,
): { absPath: string; relPath: string } {
	const cleaned = stripAtPrefix(raw);
	const absPath = resolve(cwd, cleaned);
	// Use relative path for storage/UI when possible. If it escapes cwd, keep the cleaned input.
	const rel = relative(cwd, absPath);
	const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleaned;
	return { absPath, relPath };
}

async function readTextOrNull(absPath: string): Promise<string | null> {
	try {
		return await readFile(absPath, "utf-8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: string }).code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

function hashContent(content: string | null): string {
	return content === null
		? "missing"
		: createHash("sha256").update(content, "utf8").digest("hex");
}

function countDiffLines(unifiedDiff: string): {
	added: number;
	removed: number;
} {
	let added = 0;
	let removed = 0;
	for (const line of unifiedDiff.split("\n")) {
		if (
			line.startsWith("+++ ") ||
			line.startsWith("--- ") ||
			line.startsWith("@@")
		)
			continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function formatAddedRemovedPlain(added: number, removed: number): string {
	return `(+${added}/-${removed})`;
}

function styleAddedRemovedForList(theme: any, text: string): string {
	// File rows use "+x/-y" as description; other rows use normal sentences.
	const m = text.match(/^\+(\d+)\/-(\d+)$/);
	if (!m) return theme.fg("muted", text);
	const added = Number(m[1]);
	const removed = Number(m[2]);

	const plus =
		added === 0
			? theme.fg("text", `+${added}`)
			: theme.fg("success", `+${added}`);
	const minus =
		removed === 0
			? theme.fg("text", `-${removed}`)
			: theme.fg("error", `-${removed}`);
	return plus + theme.fg("text", "/") + minus;
}

function formatStatus(
	tracked: Map<string, TrackedFile>,
	theme?: any,
): string | undefined {
	if (tracked.size === 0) return undefined;
	let edited = 0;
	let created = 0;
	for (const t of tracked.values()) {
		if (t.kind === "new") created++;
		else edited++;
	}
	if (!theme) {
		return `◆ ${edited} changed · ✦ ${created} new`;
	}
	const changed = `${theme.fg("warning", "◆")} ${theme.bold(theme.fg("muted", `${edited}`))}${theme.fg("dim", " changed")}`;
	const added = `${theme.fg("success", "✦")} ${theme.bold(theme.fg("muted", `${created}`))}${theme.fg("dim", " new")}`;
	return `${changed} ${theme.fg("borderMuted", "·")} ${added}`;
}

function buildSummaryLines(
	tracked: Map<string, TrackedFile>,
): string[] | undefined {
	if (tracked.size === 0) return undefined;
	const items = [...tracked.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	const max = 8;
	const lines = items.slice(0, max).map((item) => {
		const tag = item.kind === "new" ? "+" : "Δ";
		return `${tag} ${item.displayPath} ${formatAddedRemovedPlain(item.added, item.removed)}`;
	});
	if (items.length > max) lines.push(`…and ${items.length - max} more`);
	return lines;
}

function patchFromBaseline(
	displayPath: string,
	original: string | null,
	current: string,
): string {
	return createTwoFilesPatch(
		displayPath,
		displayPath,
		original ?? "",
		current,
		"",
		"",
		{ context: 3 },
	);
}

async function ensureParentDir(absPath: string): Promise<void> {
	await mkdir(dirname(absPath), { recursive: true });
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed on session_start from custom entries)
	const baselines = new Map<string, Baseline>(); // key: relPath
	const tracked = new Map<string, TrackedFile>(); // key: relPath
	const recordedHashes = new Map<string, string>(); // key: relPath

	// Per-tool-call snapshot, only committed on successful tool_result
	const pendingByToolCallId = new Map<string, PendingSnapshot>();

	function updateUi(ctx: ExtensionContext) {
		if (!ctx?.hasUI) return;

		ctx.ui.setStatus("pi-diff", formatStatus(tracked, ctx.ui.theme));
		// Keep the change count in the footer, but do not render a file list above the editor.
		ctx.ui.setWidget("pi-diff", undefined);
	}

	async function recomputeTrackedFile(relPath: string) {
		const baseline = baselines.get(relPath);
		if (!baseline) return;

		const current = await readTextOrNull(baseline.absPath);
		if (baseline.originalContent === null) {
			// file was created
			if (current === null) {
				tracked.delete(relPath);
				return;
			}
			const displayPath = baseline.path;
			const diff = patchFromBaseline(displayPath, null, current);
			const { added, removed } = countDiffLines(diff);
			tracked.set(relPath, {
				path: baseline.path,
				absPath: baseline.absPath,
				displayPath,
				originalContent: null,
				currentContent: current,
				recordedHash: recordedHashes.get(relPath),
				diff,
				added,
				removed,
				kind: "new",
				updatedAt: Date.now(),
			});
			return;
		}

		// file existed before
		if (current === null) {
			// Deleted outside of tracked tools (or manually). Still track as edited; diff will show removal.
			const displayPath = baseline.path;
			const diff = patchFromBaseline(displayPath, baseline.originalContent, "");
			const { added, removed } = countDiffLines(diff);
			tracked.set(relPath, {
				path: baseline.path,
				absPath: baseline.absPath,
				displayPath,
				originalContent: baseline.originalContent,
				currentContent: null,
				recordedHash: recordedHashes.get(relPath),
				diff,
				added,
				removed,
				kind: "edited",
				updatedAt: Date.now(),
			});
			return;
		}

		if (current === baseline.originalContent) {
			// back to original; untrack
			tracked.delete(relPath);
			return;
		}

		const displayPath = baseline.path;
		const diff = patchFromBaseline(
			displayPath,
			baseline.originalContent,
			current,
		);
		const { added, removed } = countDiffLines(diff);
		tracked.set(relPath, {
			path: baseline.path,
			absPath: baseline.absPath,
			displayPath,
			originalContent: baseline.originalContent,
			currentContent: current,
			recordedHash: recordedHashes.get(relPath),
			diff,
			added,
			removed,
			kind: "edited",
			updatedAt: Date.now(),
		});
	}

	async function clearLog(
		ctx: ExtensionCommandContext,
		reason: "accept" | "decline",
	) {
		baselines.clear();
		tracked.clear();
		recordedHashes.clear();
		pendingByToolCallId.clear();
		pi.appendEntry(ENTRY_CLEAR, { timestamp: Date.now(), reason });
		updateUi(ctx);
	}

	async function revertTrackedFile(item: TrackedFile): Promise<void> {
		if (!item.recordedHash) {
			throw new Error("no post-change fingerprint is stored for this legacy entry");
		}
		const current = await readTextOrNull(item.absPath);
		if (hashContent(current) !== item.recordedHash) {
			throw new Error("file changed after pi-diff recorded its latest state");
		}

		if (item.originalContent === null) {
			await rm(item.absPath, { force: true });
		} else {
			await ensureParentDir(item.absPath);
			await writeFile(item.absPath, item.originalContent, "utf-8");
		}
	}

	async function declineAll(ctx: ExtensionCommandContext, force = false) {
		await ctx.waitForIdle();

		if (tracked.size === 0) {
			if (ctx.hasUI) ctx.ui.notify("pi-diff: nothing to decline.", "info");
			return;
		}

		if (ctx.hasUI && !force) {
			const ok = await ctx.ui.confirm(
				"Decline pi changes?",
				"This will revert ALL currently logged pi changes (overwrite files / delete created files).",
			);
			if (!ok) return;
		} else if (!ctx.hasUI && !force) {
			throw new Error(
				"Decline requires confirmation. Run: /pi-diff-decline force",
			);
		}

		const items = [...tracked.values()].sort(
			(a, b) => b.updatedAt - a.updatedAt,
		);
		let reverted = 0;
		const errors: string[] = [];

		for (const item of items) {
			try {
				await revertTrackedFile(item);
				untrackFile(item.path);
				reverted++;
			} catch (error) {
				errors.push(`${item.displayPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (errors.length === 0) {
			await clearLog(ctx, "decline");
		} else {
			updateUi(ctx);
		}

		if (ctx.hasUI) {
			if (errors.length === 0) {
				ctx.ui.notify(
					`pi-diff: declined changes for ${reverted} file(s).`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`pi-diff: reverted ${reverted} file(s); ${errors.length} unsafe or failed file(s) remain tracked.`,
					"warning",
				);
				console.warn("[pi-diff] decline errors:\n" + errors.join("\n"));
			}
		}
	}

	async function acceptAll(ctx: ExtensionCommandContext, force = false) {
		await ctx.waitForIdle();

		if (tracked.size === 0) {
			if (ctx.hasUI) ctx.ui.notify("pi-diff: nothing to accept.", "info");
			return;
		}

		if (ctx.hasUI && !force) {
			const ok = await ctx.ui.confirm(
				"Accept pi changes?",
				"This will keep current files as-is and clear the modification log.",
			);
			if (!ok) return;
		} else if (!ctx.hasUI && !force) {
			throw new Error(
				"Accept requires confirmation. Run: /pi-diff-accept force",
			);
		}

		const count = tracked.size;
		await clearLog(ctx, "accept");
		if (ctx.hasUI)
			ctx.ui.notify(
				`pi-diff: accepted changes for ${count} file(s).`,
				"info",
			);
	}

	function untrackFile(relPath: string) {
		baselines.delete(relPath);
		tracked.delete(relPath);
		recordedHashes.delete(relPath);
		pi.appendEntry(ENTRY_UNTRACK, { path: relPath, timestamp: Date.now() });
	}

	async function acceptFile(ctx: ExtensionCommandContext, relPath: string) {
		if (!baselines.has(relPath)) return false;
		untrackFile(relPath);
		updateUi(ctx);
		return true;
	}

	async function declineFile(
		ctx: ExtensionCommandContext,
		relPath: string,
	): Promise<"reverted" | "not-tracked" | "failed"> {
		const t = tracked.get(relPath);
		if (!t) return "not-tracked";
		try {
			await revertTrackedFile(t);
			untrackFile(relPath);
			updateUi(ctx);
			return "reverted";
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-diff: failed to revert ${t.displayPath}: ${message}`,
					"error",
				);
			}
			if (!ctx.hasUI) console.warn("[pi-diff] declineFile error:", error);
			return "failed";
		}
	}

	function notifyFileAction(
		ctx: ExtensionCommandContext,
		ok: boolean,
		action: "accepted" | "reverted",
		displayPath: string,
	) {
		if (ctx.hasUI && ok) {
			ctx.ui.notify(`pi-diff: ${action} ${displayPath}`, "info");
		}
	}

	function parseCommandArgs(args: string | undefined): string[] {
		if (!args) return [];
		return args
			.split(/\s+/g)
			.map((s) => s.trim())
			.filter(Boolean);
	}

	// Commands
	pi.registerCommand("pi-diff", {
		description: "Show files changed by pi and inspect diffs",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			updateUi(ctx);

			if (ctx.mode !== "tui") {
				const lines = buildSummaryLines(tracked) ?? [];
				const summary = lines.length > 0
					? lines.join("\n")
					: "pi-diff: no pi-made modifications recorded.";
				if (ctx.hasUI) {
					ctx.ui.notify(summary, "info");
				} else if (ctx.mode === "print") {
					console.log(summary);
				}
				return;
			}

			// Interactive loop: ESC in diff view returns to the modification log.
			while (true) {
				await ctx.waitForIdle();
				updateUi(ctx);

				const items = [...tracked.values()].sort(
					(a, b) => b.updatedAt - a.updatedAt,
				);
				if (items.length === 0) {
					ctx.ui.notify("pi-diff: no pi-made modifications recorded.", "info");
					return;
				}

				const selectItems: SelectItem[] = [
					{
						value: "__accept__",
						label: "Accept changes (clear log)",
						description: "Keep current files",
					},
					{
						value: "__decline__",
						label: "Undo changes (revert)",
						description: "Restore original contents",
					},
					{ value: "__sep__", label: "────────", description: "" },
					...items.map((t) => ({
						value: t.path,
						label: `${t.kind === "new" ? "+" : "Δ"} ${t.displayPath}`,
						description: `+${t.added}/-${t.removed}`,
					})),
				];

				const picked = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => {
						const container = new Container();
						container.addChild(
							new DynamicBorder((s: string) => theme.fg("accent", s)),
						);
						container.addChild(
							new Text(theme.fg("accent", theme.bold("File changes")), 1, 0),
						);

						const list = new SelectList(
							selectItems,
							Math.min(14, selectItems.length),
							{
								selectedPrefix: (t) => theme.fg("accent", t),
								selectedText: (t) => theme.fg("accent", t),
								description: (t) => styleAddedRemovedForList(theme, t),
								scrollInfo: (t) => theme.fg("dim", t),
								noMatch: (t) => theme.fg("warning", t),
							},
						);

						let selectedItem = selectItems[0];
						list.onSelectionChange = (item) => {
							selectedItem = item;
						};
						list.onSelect = (item) => {
							if (item.value === "__sep__") return;
							done(item.value);
						};
						list.onCancel = () => done(null);
						container.addChild(list);

						container.addChild(
							new Text(
								theme.fg("dim", "↑↓ navigate • enter view • a accept • d decline • esc close"),
								1,
								0,
							),
						);
						container.addChild(
							new DynamicBorder((s: string) => theme.fg("accent", s)),
						);

						return {
							render: (w) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data) => {
								// Per-file key bindings: a = accept, d = decline
								// vim-style nav: j = down, k = up
								if (matchesKey(data, "j")) {
									list.handleInput(Key.down);
									tui.requestRender();
									return;
								}
								if (matchesKey(data, "k")) {
									list.handleInput(Key.up);
									tui.requestRender();
									return;
								}
								if (matchesKey(data, "a")) {
									if (selectedItem && !selectedItem.value.startsWith("__")) {
										done(`__accept_file__:${selectedItem.value}`);
										return;
									}
								}
								if (matchesKey(data, "d")) {
									if (selectedItem && !selectedItem.value.startsWith("__")) {
										done(`__decline_file__:${selectedItem.value}`);
										return;
									}
								}
								list.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{ overlay: true },
				);

				if (!picked) return;
				if (picked === "__accept__") {
					await acceptAll(ctx);
					return;
				}
				if (picked === "__decline__") {
					await declineAll(ctx);
					return;
				}
				if (picked.startsWith("__accept_file__:")) {
					const relPath = picked.slice("__accept_file__:".length);
					notifyFileAction(ctx, await acceptFile(ctx, relPath), "accepted", relPath);
					continue;
				}
				if (picked.startsWith("__decline_file__:")) {
					const relPath = picked.slice("__decline_file__:".length);
					const outcome = await declineFile(ctx, relPath);
					notifyFileAction(ctx, outcome === "reverted", "reverted", relPath);
					continue;
				}

				const t = tracked.get(picked);
				if (!t) {
					ctx.ui.notify(
						"pi-diff: entry not found (maybe log was cleared).",
						"warning",
					);
					continue;
				}

				const md = "```diff\n" + (t.diff.trimEnd() || "(no diff)") + "\n```";
				const diffAction = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => {
						const container = new Container();
						container.addChild(
							new DynamicBorder((s: string) => theme.fg("accent", s)),
						);
						container.addChild(
							new Text(theme.fg("accent", theme.bold(t.displayPath)), 1, 0),
						);
						container.addChild(new Markdown(md, 1, 0, getMarkdownTheme()));
						container.addChild(
							new Text(theme.fg("dim", "a — accept  •  d — decline  •  esc — go back"), 1, 0),
						);
						container.addChild(
							new DynamicBorder((s: string) => theme.fg("accent", s)),
						);

						return {
							render: (w) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data) => {
								if (
									matchesKey(data, Key.escape) ||
									matchesKey(data, Key.ctrl("c"))
								) {
									done(null);
								} else if (matchesKey(data, "a")) {
									done("accept");
								} else if (matchesKey(data, "d")) {
									done("decline");
								} else {
									tui.requestRender();
								}
							},
						};
					},
					{ overlay: true },
				);

				if (diffAction === "accept") {
					notifyFileAction(ctx, await acceptFile(ctx, picked), "accepted", t.displayPath);
					continue;
				}
				if (diffAction === "decline") {
					const outcome = await declineFile(ctx, picked);
					notifyFileAction(ctx, outcome === "reverted", "reverted", t.displayPath);
					continue;
				}

				// After closing diff, loop back to the modification log.
			}
		},
	});

	pi.registerCommand("pi-diff-accept", {
		description: "Accept pi-made changes (keeps files, clears log)",
		handler: async (args, ctx) => {
			const options = parseCommandArgs(args);
			await acceptAll(ctx, options.includes("force") || options.includes("--force"));
		},
	});

	pi.registerCommand("pi-diff-decline", {
		description: "Decline pi-made changes (reverts files, clears log)",
		handler: async (args, ctx) => {
			const options = parseCommandArgs(args);
			await declineAll(ctx, options.includes("force") || options.includes("--force"));
		},
	});

	pi.registerCommand("pi-diff-accept-file", {
		description: "Accept changes to a specific file (keeps file, removes from log)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Usage: /pi-diff-accept-file <path>", "warning");
				}
				return;
			}
			await ctx.waitForIdle();
			const { relPath } = normalizeToolPath(ctx.cwd, args.trim());
			const ok = await acceptFile(ctx, relPath);
			if (ctx.hasUI) {
				if (ok) {
					ctx.ui.notify(`pi-diff: accepted ${relPath}`, "info");
				} else {
					ctx.ui.notify(`pi-diff: file not tracked: ${relPath}`, "warning");
				}
			}
		},
	});

	pi.registerCommand("pi-diff-decline-file", {
		description: "Decline changes to a specific file (reverts file, removes from log)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Usage: /pi-diff-decline-file <path>", "warning");
				}
				return;
			}
			await ctx.waitForIdle();
			const { relPath } = normalizeToolPath(ctx.cwd, args.trim());
			const outcome = await declineFile(ctx, relPath);
			if (ctx.hasUI) {
				if (outcome === "reverted") {
					ctx.ui.notify(`pi-diff: reverted ${relPath}`, "info");
				} else if (outcome === "not-tracked") {
					ctx.ui.notify(`pi-diff: file not tracked: ${relPath}`, "warning");
				}
			}
		},
	});

	async function rebuildFromSession(ctx: ExtensionContext): Promise<void> {
		baselines.clear();
		tracked.clear();
		recordedHashes.clear();
		pendingByToolCallId.clear();

		// Replay custom entries on current branch
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;

			if (entry.customType === ENTRY_CLEAR) {
				baselines.clear();
				tracked.clear();
				recordedHashes.clear();
				continue;
			}

			if (entry.customType === ENTRY_BASELINE) {
				const data = entry.data as { path?: unknown; originalContent?: unknown };
				if (
					typeof data?.path !== "string" ||
					(data.originalContent !== null && typeof data.originalContent !== "string")
				) {
					continue;
				}
				const { absPath, relPath } = normalizeToolPath(ctx.cwd, data.path);
				baselines.set(relPath, {
					path: relPath,
					absPath,
					originalContent: data.originalContent,
				});
				continue;
			}

			if (entry.customType === ENTRY_UPDATE) {
				const data = entry.data as { path?: unknown; contentHash?: unknown };
				if (typeof data?.path !== "string" || typeof data.contentHash !== "string") continue;
				const { relPath } = normalizeToolPath(ctx.cwd, data.path);
				recordedHashes.set(relPath, data.contentHash);
				continue;
			}

			if (entry.customType === ENTRY_UNTRACK) {
				const data = entry.data as { path?: unknown };
				if (typeof data?.path !== "string") continue;
				const { relPath } = normalizeToolPath(ctx.cwd, data.path);
				baselines.delete(relPath);
				tracked.delete(relPath);
				recordedHashes.delete(relPath);
			}
		}

		// Compute current diffs
		for (const relPath of baselines.keys()) {
			await recomputeTrackedFile(relPath);
		}

		updateUi(ctx);
	}

	// Rebuild state on any session/branch navigation events
	pi.on("session_start", async (_event, ctx) => {
		await rebuildFromSession(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("pi-diff", undefined);
		ctx.ui.setWidget("pi-diff", undefined);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await rebuildFromSession(ctx);
	});


	// Capture before snapshots for edit/write
	pi.on("tool_call", async (event, ctx) => {
		if (
			isToolCallEventType("edit", event) ||
			isToolCallEventType("write", event)
		) {
			const { absPath, relPath } = normalizeToolPath(ctx.cwd, event.input.path);
			const before = await readTextOrNull(absPath);
			pendingByToolCallId.set(event.toolCallId, {
				path: relPath,
				absPath,
				before,
			});
		}
	});

	// Commit on successful results
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			pendingByToolCallId.delete(event.toolCallId);
			return;
		}

		if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

		const pending = pendingByToolCallId.get(event.toolCallId);
		pendingByToolCallId.delete(event.toolCallId);
		if (!pending) return;

		// If no baseline exists yet for this file, create one now from the successful call's snapshot.
		if (!baselines.has(pending.path)) {
			baselines.set(pending.path, {
				path: pending.path,
				absPath: pending.absPath,
				originalContent: pending.before,
			});
			pi.appendEntry(ENTRY_BASELINE, {
				path: pending.path,
				originalContent: pending.before,
				timestamp: Date.now(),
			});
		}

		const baseline = baselines.get(pending.path)!;
		const current = await readTextOrNull(pending.absPath);
		const backToOriginal =
			(baseline.originalContent !== null && current === baseline.originalContent) ||
			(baseline.originalContent === null && current === null);

		if (backToOriginal) {
			untrackFile(pending.path);
		} else {
			const contentHash = hashContent(current);
			recordedHashes.set(pending.path, contentHash);
			pi.appendEntry(ENTRY_UPDATE, {
				path: pending.path,
				contentHash,
				timestamp: Date.now(),
			});
			await recomputeTrackedFile(pending.path);
		}

		updateUi(ctx);
	});
}
