import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Color, colorToRgb, foregroundAnsi, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import piStatusline from "./index.ts";

test("context progress uses a responsive gradient with unchanged usage colors", () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	const colors = {
		text: parseColor("#464261"),
		dim: parseColor("#9893a5"),
		warning: parseColor("#ea9d34"),
		error: parseColor("#b4637a"),
	};
	const theme = {
		colors,
		fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		style: (text: string, { fg }: { fg: Color | keyof typeof colors }) =>
			`${foregroundAnsi(typeof fg === "string" ? colors[fg] : fg, "truecolor")}${text}\x1b[39m`,
	};
	let footer: { render(width: number): string[] };
	let percent: number | null | undefined = 50;
	let entries: unknown[] = [];
	const ctx = {
		mode: "tui",
		cwd: "/tmp/project",
		ui: {
			theme,
			getTheme: () => theme,
			getEditorComponent() {},
			setEditorComponent() {},
			setFooter(factory: any) {
				footer = factory({ requestRender() {} }, theme, {
					onBranchChange: () => () => {},
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map([["pi-diff", "Δ 0 + 2"], ["task", "working"]]),
				});
			},
		},
		sessionManager: {
			getLeafId: () => String(entries.length),
			getEntries: () => entries,
			getSessionName: () => "session",
		},
		getContextUsage: () => percent === undefined ? undefined : { percent, contextWindow: 200_000 },
	} as unknown as ExtensionContext;
	piStatusline({
		on: (event: string, handler: (...args: any[]) => void) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as unknown as ExtensionAPI);
	handlers.get("session_start")!({}, ctx);
	assert.equal(footer!.render(120).length, 3, "empty metrics must not add a blank line");
	entries = [{ type: "message", message: { role: "assistant", usage: {
		input: 1_000, output: 500, cacheRead: 9_000, cacheWrite: 100, cost: { total: 0.1 },
	} } }];

	for (percent of [0, 1, 50, 70, 70.1, 90, 90.1, 100, 120, -10, null, undefined]) {
		for (const width of [0, 1, 8, 20, 32, 80, 120, 200]) {
			const lines = footer!.render(width);
			assert(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
			if (width < 32) continue;
			const context = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
				.filter((line) => line.startsWith("ctx "));
			assert.equal(context.length, 1);
			assert.equal(visibleWidth(context[0]), width, "context row must fill terminal width");
			const label = percent == null ? "?" : `${percent.toFixed(1)}%`;
			const suffix = ` ${label} / ${percent === undefined ? "0" : "200k"} · auto`;
			const barWidth = width - visibleWidth(`ctx ${suffix}`);
			const filled = Math.round(Math.max(0, Math.min(100, percent ?? 0)) / 100 * barWidth);
			assert.equal(context[0], `ctx ${"█".repeat(filled)}${"░".repeat(barWidth - filled)}${suffix}`);
			const contextLine = lines.find((line) => line.includes("ctx "))!;
			const cellColors = [...contextLine.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m(█+)/g)]
				.flatMap((match) => Array<string>(match[2].length).fill(match[1]));
			assert.equal(cellColors.length, filled);
			if (filled > 1) assert(new Set(cellColors).size > 1, "filled cells must form a gradient");
			const expectedColor = percent == null ? colors.dim
				: percent > 90 ? colors.error : percent > 70 ? colors.warning : parseColor("#56949f");
			assert(contextLine.includes(`${foregroundAnsi(expectedColor, "truecolor")} ${label}`),
				"percentage color must retain the original usage thresholds");
			if (filled > 0) {
				const { r, g, b } = colorToRgb(expectedColor);
				assert.equal(cellColors.at(-1), `${r};${g};${b}`, "bar tip must retain the original usage color");
			}
			assert.equal(lines.filter((line) => /[█░]/.test(line)).length, 1);
			assert(lines.some((line) => line.includes("↑")), "traffic metrics must remain visible");
			if (width >= 80) assert(lines[0].includes("Δ 0 + 2"));
			assert(lines.at(-1)!.includes("working"));
		}
	}
});
