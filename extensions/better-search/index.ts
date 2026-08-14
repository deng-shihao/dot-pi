/**
 * better-search — fd + rg unified extension for pi
 *
 * Combines file discovery (fd) and text search (rg) into a single
 * extension so both tools are registered together. Wraps the
 * built-in createFindToolDefinition and createGrepToolDefinition
 * with custom names, labels, prompt metadata, and TUI rendering.
 *
 * Key advantages over built-in find/grep:
 * - Default .gitignore respect means ~187x fewer tokens in real projects
 * - 2-22x speed improvement over find/grep
 * - Simpler syntax for the LLM to generate correctly
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import type { Text as TextComponent } from "@earendil-works/pi-tui";
import { Text, type Component } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Inlined helpers (not exported from public API)
// ---------------------------------------------------------------------------

/** Returns string value or null if the arg is a non-string type (invalid). */
function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

/** Shorten absolute home-dir paths to ~/... */
function shortenPath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const home = homedir();
  if (raw === home) return "~";
  if (raw.startsWith(`${home}/`)) return `~${raw.slice(home.length)}`;
  return raw;
}

function invalidArgText(theme: any): string {
  return theme.fg("error", "[invalid arg]");
}

// ANSI escape stripper (simple, no dependency)
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Extract text content from a tool result. */
function getTextOutput(result: any): string {
  if (!result) return "";
  const content = result.content ?? [];
  const textBlocks = content.filter((c: any) => c.type === "text");
  return textBlocks
    .map((c: any) => (c.text ?? "").replace(ANSI_RE, "").replace(/\r/g, ""))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Shared render helpers
// ---------------------------------------------------------------------------

function formatFindCall(args: Record<string, unknown>, theme: any): string {
  const pattern = str(args?.pattern);
  const rawPath = str(args?.path);
  const pathStr = rawPath !== null ? shortenPath(rawPath || ".") : null;
  const limit = args?.limit;
  const invalidArg = invalidArgText(theme);

  let text =
    theme.fg("toolTitle", theme.bold("fd")) +
    " " +
    (pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
    theme.fg("toolOutput", ` in ${pathStr === null ? invalidArg : pathStr}`);
  if (limit !== undefined) {
    text += theme.fg("toolOutput", ` (limit ${limit})`);
  }
  return text;
}

function formatGrepCall(args: Record<string, unknown>, theme: any): string {
  const pattern = str(args?.pattern);
  const rawPath = str(args?.path);
  const pathStr = rawPath !== null ? shortenPath(rawPath || ".") : null;
  const glob = str(args?.glob);
  const limit = args?.limit;
  const invalidArg = invalidArgText(theme);

  let text =
    theme.fg("toolTitle", theme.bold("rg")) +
    " " +
    (pattern === null
      ? invalidArg
      : theme.fg("accent", `/${pattern || ""}/`)) +
    theme.fg("toolOutput", ` in ${pathStr === null ? invalidArg : pathStr}`);
  if (glob) text += theme.fg("toolOutput", ` (${glob})`);
  if (limit !== undefined)
    text += theme.fg("toolOutput", ` limit ${limit}`);
  return text;
}

function formatFindResult(
  result: any,
  options: { expanded?: boolean },
  theme: any,
): string {
  const output = getTextOutput(result).trim();
  let text = "";

  if (output) {
    const lines = output.split("\n");
    const maxLines = options.expanded ? lines.length : 20;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;

    text += `\n${displayLines
      .map((l: string) => theme.fg("toolOutput", l))
      .join("\n")}`;

    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
    }
  }

  const resultLimit = result.details?.resultLimitReached as number | undefined;
  const truncation = result.details?.truncation as
    | { truncated?: boolean; maxBytes?: number }
    | undefined;

  if (resultLimit || truncation?.truncated) {
    const warnings: string[] = [];
    if (resultLimit) warnings.push(`${resultLimit} results limit`);
    if (truncation?.truncated)
      warnings.push(
        `${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`,
      );
    text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
  }

  return text;
}

function formatGrepResult(
  result: any,
  options: { expanded?: boolean },
  theme: any,
): string {
  const output = getTextOutput(result).trim();
  let text = "";

  if (output) {
    const lines = output.split("\n");
    const maxLines = options.expanded ? lines.length : 15;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;

    text += `\n${displayLines
      .map((l: string) => theme.fg("toolOutput", l))
      .join("\n")}`;

    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
    }
  }

  const matchLimit = result.details?.matchLimitReached as number | undefined;
  const truncation = result.details?.truncation as
    | { truncated?: boolean; maxBytes?: number }
    | undefined;
  const linesTruncated = result.details?.linesTruncated as boolean | undefined;

  if (matchLimit || truncation?.truncated || linesTruncated) {
    const warnings: string[] = [];
    if (matchLimit) warnings.push(`${matchLimit} matches limit`);
    if (truncation?.truncated)
      warnings.push(
        `${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`,
      );
    if (linesTruncated) warnings.push("some lines truncated");
    text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
  }

  return text;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // -- Replace built-in find/grep with fd/rg -------------------------------

  pi.on("session_start", async (_event, _ctx) => {
    const active = pi.getActiveTools();
    const replaced = active.filter(
      (name) => name !== "find" && name !== "grep",
    );

    // Replace only search tools that were active. Do not enable fd/rg in
    // sessions that deliberately started without discovery or search tools.
    if (active.includes("find") && !replaced.includes("fd")) replaced.push("fd");
    if (active.includes("grep") && !replaced.includes("rg")) replaced.push("rg");
    pi.setActiveTools(replaced);
  });

  // -- fd ------------------------------------------------------------------

  pi.registerTool({
    ...createFindToolDefinition(cwd, {}),
    name: "fd",
    label: "fd",
    description: `Find files by glob pattern using fd. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    promptSnippet:
      "Find files by glob pattern with fd (respects .gitignore)",
    promptGuidelines: [
      "Prefer fd over find for file discovery — fd is faster, respects .gitignore, and has simpler syntax.",
      "fd respects .gitignore by default, automatically skipping node_modules, .git, dist, and other ignored directories without needing explicit exclusions.",
    ],

    renderCall(
      args: Record<string, unknown>,
      theme: any,
      context: { lastComponent?: Component },
    ): Component {
      const text = (context.lastComponent as TextComponent | undefined) ??
        new Text("", 0, 0);
      text.setText(formatFindCall(args, theme));
      return text;
    },

    renderResult(
      result: any,
      options: { expanded?: boolean },
      theme: any,
      context: { lastComponent?: Component },
    ): Component {
      const text = (context.lastComponent as TextComponent | undefined) ??
        new Text("", 0, 0);

      if (result.isError) {
        const output = getTextOutput(result).trim();
        text.setText(
          output
            ? `\n${theme.fg("error", output)}`
            : theme.fg("error", "Error running fd"),
        );
        return text;
      }

      text.setText(formatFindResult(result, options, theme));
      return text;
    },
  });

  // -- rg ------------------------------------------------------------------

  pi.registerTool({
    ...createGrepToolDefinition(cwd, {}),
    name: "rg",
    label: "ripgrep",
    description: `Search file contents using ripgrep (rg). Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to 500 chars.`,
    promptSnippet:
      "Search file contents with ripgrep (rg) — respects .gitignore",
    promptGuidelines: [
      "Prefer rg over grep for text search — rg is faster and respects .gitignore.",
      "rg respects .gitignore by default, automatically skipping node_modules, .git, dist, and other ignored directories without needing explicit exclusions.",
    ],

    renderCall(
      args: Record<string, unknown>,
      theme: any,
      context: { lastComponent?: Component },
    ): Component {
      const text = (context.lastComponent as TextComponent | undefined) ??
        new Text("", 0, 0);
      text.setText(formatGrepCall(args, theme));
      return text;
    },

    renderResult(
      result: any,
      options: { expanded?: boolean },
      theme: any,
      context: { lastComponent?: Component },
    ): Component {
      const text = (context.lastComponent as TextComponent | undefined) ??
        new Text("", 0, 0);

      if (result.isError) {
        const output = getTextOutput(result).trim();
        text.setText(
          output
            ? `\n${theme.fg("error", output)}`
            : theme.fg("error", "Error running rg"),
        );
        return text;
      }

      text.setText(formatGrepResult(result, options, theme));
      return text;
    },
  });
}
