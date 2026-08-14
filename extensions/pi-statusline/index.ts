import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

function plainText(text: string): string {
	return text.replace(ANSI_SGR_PATTERN, "");
}

function sanitizeLabel(text: string): string {
	return text.replace(CONTROL_CHARACTER_PATTERN, "");
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").trim();
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = resolve(homedir());
	const resolvedCwd = resolve(cwd);
	const relativeToHome = relative(home, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

type UsageTotals = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite"> & {
	cost: number;
};

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function renderLocation(
	theme: Theme,
	cwd: string,
	branch: string | null,
	sessionName: string | undefined,
	status: string | undefined,
	width: number,
): string {
	const location = sanitizeLabel(formatCwd(cwd));
	const separatorIndex = Math.max(location.lastIndexOf("/"), location.lastIndexOf("\\"));
	const parent = separatorIndex >= 0 ? location.slice(0, separatorIndex + 1) : "";
	const directory = separatorIndex >= 0 ? location.slice(separatorIndex + 1) : location;
	let line = theme.fg("dim", parent) + theme.fg("muted", theme.bold(directory));

	if (branch) {
		line += ` ${theme.fg("muted", ` (${sanitizeLabel(branch)})`)}`;
	}
	if (sessionName) {
		line += ` ${theme.fg("borderMuted", "·")} ${theme.fg("muted", sanitizeLabel(sessionName))}`;
	}
	if (status) {
		line += ` ${theme.fg("borderMuted", "·")} ${sanitizeStatus(status)}`;
	}

	return truncateToWidth(line, width, theme.fg("dim", "…"));
}

function joinMetricGroups(theme: Theme, groups: string[]): string {
	return groups.filter(Boolean).join(theme.fg("borderMuted", " │ "));
}

function wrapMetricGroups(theme: Theme, groups: string[], width: number): string[] {
	const separator = theme.fg("borderMuted", " │ ");
	const lines: string[] = [];
	let current = "";

	for (const group of groups.filter(Boolean)) {
		const candidate = current ? `${current}${separator}${group}` : group;
		if (current && visibleWidth(candidate) > width) {
			lines.push(current);
			current = group;
		} else {
			current = candidate;
		}
	}

	if (current) lines.push(current);
	return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…")));
}

function isHorizontalBorder(line: string): boolean {
	const plain = plainText(line);
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more /.test(plain);
}

function renderBottomBorder(
	width: number,
	status: string,
	borderColor: (text: string) => string,
): string {
	const innerWidth = Math.max(0, width - 2);
	const fittedStatus = truncateToWidth(status, Math.max(0, innerWidth - 1), "");
	const fillWidth = Math.max(0, innerWidth - visibleWidth(fittedStatus) - 1);
	return `${borderColor("╰")}${borderColor("─".repeat(fillWidth))}${fittedStatus}${borderColor("─╯")}`;
}

type EditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

export default function piStatusline(pi: ExtensionAPI) {
	let previousEditor: EditorFactory;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			let usageCached = false;
			let cachedLeafId: string | null = null;
			let cachedTotals: UsageTotals = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
			};
			let cachedCacheHitRate: number | undefined;

			const refreshUsage = () => {
				const leafId = ctx.sessionManager.getLeafId();
				if (usageCached && leafId === cachedLeafId) return;

				const totals: UsageTotals = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
				};
				let latestCacheHitRate: number | undefined;
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const usage = (entry.message as AssistantMessage).usage;
						addUsage(totals, usage);
						const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate =
							promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
					} else if (
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.usage
					) {
						addUsage(totals, entry.message.usage);
					} else if (
						(entry.type === "branch_summary" || entry.type === "compaction") &&
						entry.usage
					) {
						addUsage(totals, entry.usage);
					}
				}

				usageCached = true;
				cachedLeafId = leafId;
				cachedTotals = totals;
				cachedCacheHitRate = latestCacheHitRate;
			};

			const unsubscribe = footerData.onBranchChange(() => {
				usageCached = false;
				tui.requestRender();
			});

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					refreshUsage();
					const totals = cachedTotals;
					const latestCacheHitRate = cachedCacheHitRate;
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					const detailedGroups: string[] = [];
					const compactGroups: string[] = [];

					const traffic: string[] = [];
					const compactTraffic: string[] = [];
					if (totals.input) {
						const value = formatTokens(totals.input);
						traffic.push(`${theme.fg("accent", "↑")} ${theme.fg("muted", theme.bold(value))}`);
						compactTraffic.push(`${theme.fg("accent", "↑")}${theme.fg("muted", value)}`);
					}
					if (totals.output) {
						const value = formatTokens(totals.output);
						traffic.push(`${theme.fg("success", "↓")} ${theme.fg("muted", theme.bold(value))}`);
						compactTraffic.push(`${theme.fg("success", "↓")}${theme.fg("muted", value)}`);
					}
					if (traffic.length > 0) detailedGroups.push(traffic.join(" "));
					if (compactTraffic.length > 0) compactGroups.push(compactTraffic.join(" "));

					const cache: string[] = [];
					const compactCache: string[] = [];
					if (totals.cacheRead) {
						const value = `R${formatTokens(totals.cacheRead)}`;
						cache.push(theme.fg("muted", theme.bold(value)));
						compactCache.push(theme.fg("muted", value));
					}
					if (totals.cacheWrite) {
						const value = `W${formatTokens(totals.cacheWrite)}`;
						cache.push(theme.fg("muted", theme.bold(value)));
						compactCache.push(theme.fg("muted", value));
					}
					if (latestCacheHitRate !== undefined) {
						const hitRate = `${latestCacheHitRate.toFixed(1)}%`;
						const coloredHitRate =
							latestCacheHitRate >= 90
								? theme.fg("success", theme.bold(hitRate))
								: latestCacheHitRate >= 70
									? theme.fg("accent", theme.bold(hitRate))
									: theme.fg("warning", theme.bold(hitRate));
						cache.push(`${coloredHitRate}${theme.fg("dim", " hit")}`);
						compactCache.push(`${theme.fg("dim", "CH")}${coloredHitRate}`);
					}
					if (cache.length > 0) {
						detailedGroups.push(`${theme.fg("dim", "cache ")}${cache.join(theme.fg("borderMuted", " · "))}`);
						compactGroups.push(compactCache.join(" "));
					}

					const provider = ctx.model && ctx.modelRegistry.getProvider(ctx.model.provider);
					const usingSubscription = Boolean(
						ctx.model &&
							(ctx.model.provider === "kimi-coding" ||
								(ctx.modelRegistry.isUsingOAuth(ctx.model) &&
									provider?.auth.oauth?.isSubscription)),
					);
					if (totals.cost || usingSubscription) {
						const cost = theme.fg("warning", theme.bold(`$${totals.cost.toFixed(3)}`));
						detailedGroups.push(
							usingSubscription ? `${cost}${theme.fg("dim", " · sub")}` : cost,
						);
						compactGroups.push(
							usingSubscription ? `${cost}${theme.fg("dim", " sub")}` : cost,
						);
					}

					const usage = ctx.getContextUsage();
					const contextWindow = formatTokens(
						usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
					);
					const percent = usage?.percent;
					const percentText = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
					const coloredPercent =
						percent !== null && percent !== undefined && percent > 90
							? theme.fg("error", theme.bold(percentText))
							: percent !== null && percent !== undefined && percent > 70
								? theme.fg("warning", theme.bold(percentText))
								: theme.fg("accent", theme.bold(percentText));
					detailedGroups.push(
						`${theme.fg("dim", "ctx ")}${coloredPercent}${theme.fg("dim", ` / ${contextWindow} · auto`)}`,
					);
					compactGroups.push(
						`${coloredPercent}${theme.fg("dim", `/${contextWindow} auto`)}`,
					);

					const allStatuses = [...footerData.getExtensionStatuses().entries()].sort(
						([left], [right]) => left.localeCompare(right),
					);
					const diffStatus = allStatuses.find(([id]) => id === "pi-diff")?.[1];
					const detailedStats = joinMetricGroups(theme, detailedGroups);
					const metricLines =
						visibleWidth(detailedStats) <= width
							? [detailedStats]
							: wrapMetricGroups(theme, compactGroups, width);
					const lines = [
						renderLocation(theme, ctx.cwd, branch, sessionName, diffStatus, width),
						...metricLines,
					];
					const statuses = allStatuses
						.filter(([id]) => id !== "pi-diff")
						.map(([, text]) => sanitizeStatus(text))
						.filter(Boolean);
					if (statuses.length > 0) {
						lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});

		class BoxedEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
			}

			render(width: number): string[] {
				if (width < 8) return super.render(width);

				const promptWidth = 3;
				const innerEditorWidth = width - 2 - promptWidth;
				const lines = super.render(innerEditorWidth);
				const bottomIndex = lines.findLastIndex((line, index) => index > 0 && isHorizontalBorder(line));
				if (bottomIndex < 1) return lines.map((line) => truncateToWidth(line, width));

				const theme = ctx.ui.theme;
				const borderColor = (text: string) => this.borderColor(text);
				const model = sanitizeLabel(ctx.model?.name || ctx.model?.id || "no model");
				const thinking = pi.getThinkingLevel();
				const status = ` ${theme.bold(theme.fg("muted", `${model} (${thinking})`))} `;
				const result: string[] = [
					`${borderColor("╭")}${borderColor("─".repeat(width - 2))}${borderColor("╮")}`,
				];

				for (let index = 1; index < bottomIndex; index += 1) {
					const prompt = index === 1 ? ` ${theme.fg("text", "❯")} ` : "   ";
					result.push(`${borderColor("│")}${prompt}${lines[index]}${borderColor("│")}`);
				}

				result.push(renderBottomBorder(width, status, borderColor));

				for (let index = bottomIndex + 1; index < lines.length; index += 1) {
					result.push(truncateToWidth(`   ${lines[index]}`, width));
				}

				return result;
			}
		}

		previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new BoxedEditor(tui, theme, keybindings),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent(previousEditor);
		previousEditor = undefined;
		ctx.ui.setFooter(undefined);
	});
}
