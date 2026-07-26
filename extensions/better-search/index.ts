/**
 * better-search — fd + rg unified extension for pi
 *
 * Combines file discovery (fd) and text search (rg) into a single
 * extension so both tools are registered together. Wraps the
 * built-in createFindToolDefinition and createGrepToolDefinition
 * with custom names, labels, prompt metadata, and TUI rendering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function extractRawText(result: any): string {
  return (result.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n")
    .trim();
}

function renderTruncatedOutput(
  raw: string,
  maxLines: number,
  options: any,
  theme: any,
  warnings: string[],
): string {
  let out = "";

  if (raw) {
    const lines = raw.split("\n");
    const displayMax = options.expanded ? lines.length : maxLines;
    const displayLines = lines.slice(0, displayMax);
    const remaining = lines.length - displayMax;

    out += `\n${displayLines
      .map((l: string) => theme.fg("toolOutput", l))
      .join("\n")}`;

    if (remaining > 0) {
      out += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
    }
  }

  if (warnings.length > 0) {
    out += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // -- fd ------------------------------------------------------------------

  pi.registerTool({
    ...createFindToolDefinition(cwd, {}),
    name: "fd",
    label: "fd",
    description: `Find files by glob pattern using fd. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    promptSnippet: "Find files by glob pattern with fd (respects .gitignore)",
    promptGuidelines: [
      "Prefer fd over find for file discovery — fd is faster, respects .gitignore, and has simpler syntax.",
    ],

    renderCall(args: any, theme: any, context: any) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern =
        typeof args?.pattern === "string" ? args.pattern : "";
      const rawPath =
        typeof args?.path === "string" ? args.path : ".";
      const limit = args?.limit;

      let out = theme.fg("toolTitle", theme.bold("fd")) + " ";
      out += theme.fg("accent", pattern || "");
      out += theme.fg("toolOutput", ` in ${rawPath}`);
      if (limit !== undefined)
        out += theme.fg("toolOutput", ` (limit ${limit})`);

      text.setText(out);
      return text;
    },

    renderResult(result: any, options: any, theme: any, _context: any) {
      const text = new Text("", 0, 0);
      const raw = extractRawText(result);

      const resultLimit = result.details?.resultLimitReached as number | undefined;
      const truncation = result.details?.truncation as any;

      const warnings: string[] = [];
      if (resultLimit) warnings.push(`${resultLimit} results limit`);
      if (truncation?.truncated)
        warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);

      text.setText(renderTruncatedOutput(raw, 20, options, theme, warnings));
      return text;
    },
  });

  // -- rg ------------------------------------------------------------------

  pi.registerTool({
    ...createGrepToolDefinition(cwd, {}),
    name: "rg",
    label: "ripgrep",
    description: `Search file contents using ripgrep (rg). Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to 500 chars.`,
    promptSnippet: "Search file contents with ripgrep (rg) — respects .gitignore",
    promptGuidelines: [
      "Prefer rg over grep for text search — rg is faster and respects .gitignore.",
    ],

    renderCall(args: any, theme: any, context: any) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern =
        typeof args?.pattern === "string" ? args.pattern : "";
      const rawPath =
        typeof args?.path === "string" ? args.path : ".";
      const glob = typeof args?.glob === "string" ? args.glob : null;
      const limit = args?.limit;

      let out = theme.fg("toolTitle", theme.bold("rg")) + " ";
      out += theme.fg("accent", `"${pattern}"`);
      out += theme.fg("toolOutput", ` in ${rawPath}`);
      if (glob) out += theme.fg("toolOutput", ` (${glob})`);
      if (limit !== undefined)
        out += theme.fg("toolOutput", ` limit ${limit}`);

      text.setText(out);
      return text;
    },

    renderResult(result: any, options: any, theme: any, _context: any) {
      const text = new Text("", 0, 0);
      const raw = extractRawText(result);

      const matchLimit = result.details?.matchLimitReached as number | undefined;
      const truncation = result.details?.truncation as any;
      const linesTruncated = result.details?.linesTruncated as boolean | undefined;

      const warnings: string[] = [];
      if (matchLimit) warnings.push(`${matchLimit} matches limit`);
      if (truncation?.truncated)
        warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
      if (linesTruncated) warnings.push("some lines truncated");

      text.setText(renderTruncatedOutput(raw, 15, options, theme, warnings));
      return text;
    },
  });
}
