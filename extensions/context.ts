/**
 * /context — Visualize current context usage as a colored grid overlay.
 *
 * Shows a grid of colored squares representing token usage, broken down by:
 * - System prompt
 * - User messages
 * - Assistant text
 * - Assistant thinking
 * - Tool results (per tool: read, bash, edit, write, grep, find, ls, custom)
 * - Compaction summaries
 * - Custom/injected messages
 * - Images (estimated)
 * - Free space
 *
 * Also shows cache stats and optimization suggestions.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ContextUsage,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Category definitions ──────────────────────────────────────────────

interface Category {
	key: string;
	label: string;
	tokens: number;
	color: (theme: Theme, text: string) => string;
	square: string; // The actual rendered square character
}

type MessageContentBlock =
	| { type: "text"; text: string }
	| { type: "image" }
	| { type: string; [key: string]: unknown };

// Rosé Pine Dawn: https://rosepinetheme.com/palette/
const dawn = {
	love: 0xb4637a,
	gold: 0xea9d34,
	rose: 0xd7827e,
	pine: 0x286983,
	foam: 0x56949f,
	iris: 0x907aa9,
	muted: 0x9893a5,
	subtle: 0x797593,
	highlightMed: 0xdfdad9,
} as const;

const ansiRgbFg = (color: number, text: string) =>
	`\x1b[38;2;${color >> 16};${(color >> 8) & 255};${color & 255}m${text}\x1b[0m`;
const ansiRgbBg = (color: number, text: string) =>
	`\x1b[48;2;${color >> 16};${(color >> 8) & 255};${color & 255}m${text}\x1b[0m`;

// ── Token estimation for individual messages ──────────────────────────

function estimateStringTokens(text: string): number {
	// ~4 chars per token, rough but consistent with pi's estimateTokens
	return Math.ceil(text.length / 4);
}

function estimateContentTokens(content: string | MessageContentBlock[]): number {
	if (typeof content === "string") return estimateStringTokens(content);
	let total = 0;
	for (const block of content) {
		if (block.type === "text") {
			total += estimateStringTokens(typeof block.text === "string" ? block.text : "");
		} else if (block.type === "image") {
			// Images are typically ~1600 tokens for a standard image
			total += 1600;
		}
	}
	return total;
}

// ── Breakdown computation ─────────────────────────────────────────────

interface ContextBreakdown {
	categories: Category[];
	totalTokens: number;
	contextWindow: number;
	percent: number | null;
	cacheRead: number;
	cacheWrite: number;
	totalCost: number;
	messageCount: number;
	turnCount: number;
}

function computeBreakdown(ctx: ExtensionCommandContext): ContextBreakdown | null {
	const usage: ContextUsage | undefined = ctx.getContextUsage();
	if (!usage) return null;

	const { contextWindow } = usage;
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	const branch = ctx.sessionManager.getBranch();

	// Accumulators
	let userTokens = 0;
	let assistantTextTokens = 0;
	let thinkingTokens = 0;
	let compactionTokens = 0;
	let customMessageTokens = 0;
	let imageTokens = 0;
	const toolTokens: Record<string, number> = {};
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalCost = 0;
	let turnCount = 0;
	let messageCount = 0;

	const systemPromptTokens = estimateStringTokens(ctx.getSystemPrompt());

	// Count projected messages, not raw entries superseded by context edits.
	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				userTokens += estimateStringTokens(msg.content);
			} else {
				for (const block of msg.content) {
					if (block.type === "text") userTokens += estimateStringTokens(block.text);
					else if (block.type === "image") imageTokens += 1600;
				}
			}
		} else if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "text") assistantTextTokens += estimateStringTokens(block.text);
				else if (block.type === "thinking") thinkingTokens += estimateStringTokens(block.thinking);
				else if (block.type === "toolCall") assistantTextTokens += estimateStringTokens(JSON.stringify(block.arguments));
			}
		} else if (msg.role === "toolResult") {
			toolTokens[msg.toolName] = (toolTokens[msg.toolName] ?? 0) + estimateContentTokens(msg.content);
		} else if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
			compactionTokens += estimateStringTokens(msg.summary);
		} else if (msg.role === "custom") {
			customMessageTokens += estimateContentTokens(msg.content);
		} else if (msg.role === "bashExecution" && !msg.excludeFromContext) {
			toolTokens.bash = (toolTokens.bash ?? 0) + estimateStringTokens(msg.command + msg.output);
		}
	}

	// Usage and cost are session totals, while the category breakdown above is
	// limited to the compaction-aware context currently sent to the model.
	for (const entry of branch) {
		if (entry.type === "message") {
			messageCount++;
			if (entry.message.role === "assistant") {
				turnCount++;
			}
			if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
				const usage = entry.message.usage;
				if (usage) {
					cacheRead += usage.cacheRead;
					cacheWrite += usage.cacheWrite;
					totalCost += usage.cost.total;
				}
			}
		} else if (
			(entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") &&
			entry.usage
		) {
			cacheRead += entry.usage.cacheRead;
			cacheWrite += entry.usage.cacheWrite;
			totalCost += entry.usage.cost.total;
		}
	}

	// Build categories list
	const categories: Category[] = [];

	const addCat = (
		key: string,
		label: string,
		tokens: number,
		color: (theme: Theme, text: string) => string,
		square: string,
	) => {
		if (tokens > 0) {
			categories.push({ key, label, tokens, color, square });
		}
	};

	addCat("system", "System Prompt", systemPromptTokens,
		(_th, t) => ansiRgbFg(dawn.iris, t), ansiRgbBg(dawn.iris, "  "));

	addCat("user", "User Messages", userTokens,
		(_th, t) => ansiRgbFg(dawn.foam, t), ansiRgbBg(dawn.foam, "  "));

	addCat("assistant", "Assistant Text", assistantTextTokens,
		(_th, t) => ansiRgbFg(dawn.pine, t), ansiRgbBg(dawn.pine, "  "));

	addCat("thinking", "Thinking", thinkingTokens,
		(_th, t) => ansiRgbFg(dawn.gold, t), ansiRgbBg(dawn.gold, "  "));

	// Tool categories — sorted by tokens descending
	const builtinTools: Record<string, { label: string; color: number }> = {
		read: { label: "Tool: read", color: dawn.foam },
		bash: { label: "Tool: bash", color: dawn.love },
		edit: { label: "Tool: edit", color: dawn.gold },
		write: { label: "Tool: write", color: dawn.rose },
		grep: { label: "Tool: grep", color: dawn.pine },
		find: { label: "Tool: find", color: dawn.iris },
		ls: { label: "Tool: ls", color: dawn.subtle },
		subagent: { label: "Tool: subagent", color: dawn.iris },
		web_search: { label: "Tool: web_search", color: dawn.foam },
		web_fetch: { label: "Tool: web_fetch", color: dawn.pine },
		ask_user_question: { label: "Tool: ask_user", color: dawn.rose },
		video_extract: { label: "Tool: video", color: dawn.love },
		google_image_search: { label: "Tool: img_search", color: dawn.gold },
		youtube_search: { label: "Tool: yt_search", color: dawn.love },
	};

	// Custom tool fallback colors
	const customToolColors = [dawn.iris, dawn.rose, dawn.pine, dawn.love, dawn.gold, dawn.foam];
	let customColorIdx = 0;

	const sortedTools = Object.entries(toolTokens).sort((a, b) => b[1] - a[1]);
	for (const [name, tokens] of sortedTools) {
		const builtin = builtinTools[name];
		const color = builtin?.color ?? customToolColors[customColorIdx++ % customToolColors.length]!;
		const label = builtin?.label ?? `Tool: ${name}`;
		addCat(`tool:${name}`, label, tokens,
			(_th, t) => ansiRgbFg(color, t), ansiRgbBg(color, "  "));
	}

	addCat("compaction", "Compaction", compactionTokens,
		(_th, t) => ansiRgbFg(dawn.subtle, t), ansiRgbBg(dawn.subtle, "  "));

	addCat("custom", "Custom Messages", customMessageTokens,
		(_th, t) => ansiRgbFg(dawn.iris, t), ansiRgbBg(dawn.iris, "  "));

	addCat("images", "Images", imageTokens,
		(_th, t) => ansiRgbFg(dawn.rose, t), ansiRgbBg(dawn.rose, "  "));

	// Calculate used tokens from categories
	const usedFromCategories = categories.reduce((s, c) => s + c.tokens, 0);

	// Use the real context usage if available, otherwise use our estimate
	const totalTokens = usage.tokens ?? usedFromCategories;
	const freeTokens = Math.max(0, contextWindow - totalTokens);

	// Add free space
	categories.push({
		key: "free",
		label: "Free",
		tokens: freeTokens,
		color: (_th, t) => ansiRgbFg(dawn.muted, t),
		square: ansiRgbBg(dawn.highlightMed, "  "),
	});

	return {
		categories,
		totalTokens,
		contextWindow,
		percent: usage.percent,
		cacheRead,
		cacheWrite,
		totalCost,
		messageCount,
		turnCount,
	};
}

// ── Grid rendering ────────────────────────────────────────────────────

function renderGrid(
	breakdown: ContextBreakdown,
	width: number,
): string[] {
	const lines: string[] = [];
	const squareW = 2; // Each grid cell is 2 chars wide
	const cols = Math.floor(width / squareW);
	if (cols <= 0) return lines;

	// Target ~10-15 rows of grid for good visual density
	const targetRows = Math.min(15, Math.max(6, Math.floor(width / 8)));
	const cellsTotal = cols * targetRows;
	const estimatedUsed = breakdown.categories.filter((cat) => cat.key !== "free")
		.reduce((total, cat) => total + cat.tokens, 0);
	const usedFraction = Math.max(0, Math.min(1, breakdown.totalTokens / breakdown.contextWindow));
	const usedCells = Math.round(cellsTotal * usedFraction);

	// Build cell array
	const cells: string[] = [];
	let cumulativeTokens = 0;
	for (const cat of breakdown.categories.filter((cat) => cat.key !== "free")) {
		cumulativeTokens += cat.tokens;
		const end = Math.round((cumulativeTokens / estimatedUsed) * usedCells);
		while (cells.length < end) cells.push(cat.square);
	}
	const freeSquare = breakdown.categories.find((cat) => cat.key === "free")!.square;
	while (cells.length < cellsTotal) cells.push(freeSquare);

	// Calculate grid width and centering padding
	const gridW = cols * squareW;
	const leftPad = Math.floor((width - gridW) / 2);
	const leftPadStr = leftPad > 0 ? " ".repeat(leftPad) : "";

	// Render grid rows
	for (let row = 0; row < targetRows; row++) {
		const start = row * cols;
		const end = Math.min(start + cols, cells.length);
		let line = leftPadStr;
		for (let i = start; i < end; i++) {
			line += cells[i];
		}
		lines.push(line);
	}

	return lines;
}

// ── Overlay component ─────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function buildOverlay(
	breakdown: ContextBreakdown,
	theme: Theme,
	width: number,
): string[] {
	if (width < 4) return [truncateToWidth("Context", Math.max(0, width), "")];
	const lines: string[] = [];
	const innerW = width - 2; // two border chars (│ on each side)

	const pad = (s: string, len: number) => {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	};

	const row = (content: string) => {
		const fitted = truncateToWidth(` ${content}`, innerW, "");
		return theme.fg("border", "│") + pad(fitted, innerW) + theme.fg("border", "│");
	};

	const emptyRow = () => row("");

	const hr = () =>
		theme.fg("border", "│") +
		theme.fg("dim", "─".repeat(innerW)) +
		theme.fg("border", "│");

	// Top border
	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));

	// Title
	const pct = breakdown.percent !== null ? ` (${breakdown.percent.toFixed(1)}%)` : "";
	const titleText = `Context Window Usage${pct}`;
	lines.push(row(theme.bold(theme.fg("accent", titleText))));

	// Subtitle: model info
	const modelLine = `${formatTokens(breakdown.totalTokens)} / ${formatTokens(breakdown.contextWindow)} tokens`;
	lines.push(row(theme.fg("muted", modelLine)));

	lines.push(emptyRow());

	// Grid — render into innerW and wrap with borders
	const gridLines = renderGrid(breakdown, innerW);
	for (const gl of gridLines) {
		lines.push(
			theme.fg("border", "│") +
			pad(gl, innerW) +
			theme.fg("border", "│"),
		);
	}

	lines.push(emptyRow());
	lines.push(hr());
	lines.push(emptyRow());

	// Legend — two columns
	const nonFreeCategories = breakdown.categories.filter((c) => c.key !== "free");
	const freeCat = breakdown.categories.find((c) => c.key === "free");

	// Calculate column layout: 1 leading space (from row/pad) + 1 extra + colW + colW + trailing
	const colW = Math.floor((innerW - 2) / 2);

	const formatEntry = (cat: Category, w: number): string => {
		const pctStr = ((cat.tokens / breakdown.contextWindow) * 100).toFixed(1);
		const label = `${cat.square} ${cat.color(theme, cat.label)}`;
		const value = theme.fg("dim", `${formatTokens(cat.tokens)} (${pctStr}%)`);
		const entry = truncateToWidth(`${label} ${value}`, w, "");
		return pad(entry, w);
	};

	for (let i = 0; i < nonFreeCategories.length; i += 2) {
		const left = nonFreeCategories[i]!;
		const right = nonFreeCategories[i + 1];

		let content = " " + formatEntry(left, colW);
		if (right) {
			content += formatEntry(right, colW);
		}
		lines.push(
			theme.fg("border", "│") +
			pad(content, innerW) +
			theme.fg("border", "│"),
		);
	}

	// Free space entry
	if (freeCat && freeCat.tokens > 0) {
		const pctStr = ((freeCat.tokens / breakdown.contextWindow) * 100).toFixed(1);
		const label = `${freeCat.square} ${freeCat.color(theme, freeCat.label)}`;
		const value = theme.fg("dim", `${formatTokens(freeCat.tokens)} (${pctStr}%)`);
		lines.push(row(`${label} ${value}`));
	}

	lines.push(emptyRow());
	lines.push(hr());
	lines.push(emptyRow());

	// Stats section — wrap items to fit innerW
	const stats = [
		`Turns: ${breakdown.turnCount}`,
		`Messages: ${breakdown.messageCount}`,
		`Cache read: ${formatTokens(breakdown.cacheRead)}`,
		`Cache write: ${formatTokens(breakdown.cacheWrite)}`,
		`Cost: $${breakdown.totalCost.toFixed(4)}`,
	];
	lines.push(row(theme.fg("accent", theme.bold("Session Stats"))));
	const sep = theme.fg("dim", "  │  ");
	const sepW = visibleWidth(sep);
	// Available content width: innerW minus the leading space added by row()
	const contentW = innerW - 1;
	let currentLine = "";
	let currentW = 0;
	for (let i = 0; i < stats.length; i++) {
		const item = theme.fg("muted", stats[i]!);
		const itemW = visibleWidth(item);
		const needsSep = currentW > 0;
		const addW = (needsSep ? sepW : 0) + itemW;
		if (currentW > 0 && currentW + addW > contentW) {
			// Flush current line and start a new one
			lines.push(row(currentLine));
			currentLine = item;
			currentW = itemW;
		} else {
			currentLine += (needsSep ? sep : "") + item;
			currentW += addW;
		}
	}
	if (currentLine) lines.push(row(currentLine));

	// Warnings / suggestions
	const suggestions: string[] = [];
	if (breakdown.percent !== null && breakdown.percent > 80) {
		suggestions.push("⚠ Context usage above 80% — consider /compact");
	}
	if (breakdown.percent !== null && breakdown.percent > 95) {
		suggestions.push("🔴 Near context limit — compaction strongly recommended");
	}

	// Find biggest tool consumer
	const toolCats = breakdown.categories.filter((c) => c.key.startsWith("tool:"));
	const biggestTool = toolCats.sort((a, b) => b.tokens - a.tokens)[0];
	if (biggestTool && biggestTool.tokens > breakdown.contextWindow * 0.2) {
		const pct = ((biggestTool.tokens / breakdown.contextWindow) * 100).toFixed(0);
		suggestions.push(
			`💡 ${biggestTool.label} uses ${pct}% of context — consider summarizing large outputs`,
		);
	}

	if (suggestions.length > 0) {
		lines.push(emptyRow());
		lines.push(hr());
		lines.push(emptyRow());
		for (const s of suggestions) {
			lines.push(row(theme.fg("warning", s)));
		}
	}

	lines.push(emptyRow());

	// Help
	lines.push(row(theme.fg("dim", "Press Escape to close")));

	// Bottom border
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));

	return lines;
}

// ── Extension entry point ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Visualize current context usage as a colored grid",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) {
					ctx.ui.notify("The /context visualization is available in TUI mode only.", "warning");
				}
				return;
			}

			const breakdown = computeBreakdown(ctx);
			if (!breakdown) {
				ctx.ui.notify("No context usage data available yet. Send a message first.", "warning");
				return;
			}

			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) => {
					const cachedBreakdown = breakdown;

					return {
						handleInput(data: string) {
							if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "return")) {
								done(undefined);
							}
						},

						render(width: number): string[] {
							return buildOverlay(cachedBreakdown, theme, width);
						},

						invalidate() {},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "80%",
						minWidth: 40,
						maxHeight: "90%",
					},
				},
			);
		},
	});
}
