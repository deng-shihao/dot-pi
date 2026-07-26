/**
 * eza — modern directory listing for pi
 *
 * Built from scratch following createLsToolDefinition patterns:
 *   spawn + readline streaming
 *   AbortSignal with settle guard
 *   fsStat for path/isDirectory validation
 *   entry limit + truncateHead byte truncation
 *   renderCall/renderResult with lastComponent reuse + keyHint
 */

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { stat as fsStat } from "node:fs/promises";
import nodePath from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 500;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ezaSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory to list (default: current directory)" }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})`,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  pi.registerTool({
    name: "eza",
    label: "eza",
    description: `List directory contents using eza. Returns entries sorted with directories first, including dotfiles, permissions, sizes, and modification times. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    promptSnippet: "List directory contents with eza (git-aware, long format)",
    promptGuidelines: [
      "Prefer eza over ls for directory listings — eza provides better defaults, colors, and git awareness.",
    ],
    parameters: ezaSchema,

    // -- execute ---------------------------------------------------------

    async execute(
      _toolCallId: string,
      params: { path?: string; limit?: number },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
    ) {
      return new Promise<{
        content: Array<{ type: "text"; text: string }>;
        details?: Record<string, unknown>;
      }>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            fn();
          }
        };
        const onAbort = () =>
          settle(() => reject(new Error("Operation aborted")));
        signal?.addEventListener("abort", onAbort, { once: true });

        (async () => {
          try {
            const dirPath = nodePath.resolve(cwd, params.path || ".");
            const effectiveLimit = params.limit ?? DEFAULT_LIMIT;

            // Validate path
            let st: { isDirectory(): boolean };
            try {
              st = await fsStat(dirPath);
            } catch {
              settle(() =>
                reject(new Error(`Path not found: ${dirPath}`)),
              );
              return;
            }
            if (!st.isDirectory()) {
              settle(() =>
                reject(new Error(`Not a directory: ${dirPath}`)),
              );
              return;
            }

            // Spawn eza
            const child = spawn(
              "eza",
              [
                "--color=never",
                "--icons=never",
                "--group-directories-first",
                "-l",
                "-a",
                "--git",
                "--header",
                dirPath,
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            );

            const rl = createInterface({ input: child.stdout! });
            let stderr = "";
            const lines: string[] = [];

            child.stderr?.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });

            rl.on("line", (line: string) => {
              lines.push(line);
            });

            child.on("error", (error: Error) => {
              settle(() =>
                reject(new Error(`Failed to run eza: ${error.message}`)),
              );
            });

            child.on("close", (code: number | null) => {
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }

              if (code !== 0) {
                const errMsg =
                  stderr.trim() || `eza exited with code ${code}`;
                settle(() => reject(new Error(errMsg)));
                return;
              }

              if (lines.length === 0) {
                settle(() =>
                  resolve({
                    content: [{ type: "text", text: "(empty directory)" }],
                  }),
                );
                return;
              }

              // Apply entry limit
              const entryLimitReached = lines.length > effectiveLimit;
              const limited = lines.slice(0, effectiveLimit);

              // Apply byte truncation (no separate line limit — entry cap is enough)
              const rawOutput = limited.join("\n");
              const truncation = truncateHead(rawOutput, {
                maxLines: Number.MAX_SAFE_INTEGER,
              });

              let resultText = truncation.content;
              const details: Record<string, unknown> = {};
              const notices: string[] = [];

              if (entryLimitReached) {
                notices.push(
                  `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
                );
                details.entryLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(
                  `${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit reached`,
                );
                details.truncation = truncation;
              }

              if (notices.length > 0) {
                resultText += `\n\n[${notices.join(". ")}]`;
              }

              settle(() =>
                resolve({
                  content: [{ type: "text", text: resultText }],
                  details:
                    Object.keys(details).length > 0 ? details : undefined,
                }),
              );
            });
          } catch (e) {
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            settle(() => reject(e));
          }
        })();
      });
    },

    // -- renderCall ------------------------------------------------------

    renderCall(args: any, theme: any, context: any) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      const rawPath =
        typeof args?.path === "string" ? args.path : null;
      const displayPath = rawPath || ".";
      const limit = args?.limit;

      let out = `${theme.fg("toolTitle", theme.bold("eza"))} ${theme.fg("accent", displayPath)}`;
      if (limit !== undefined)
        out += theme.fg("toolOutput", ` (limit ${limit})`);

      text.setText(out);
      return text;
    },

    // -- renderResult ----------------------------------------------------

    renderResult(result: any, options: any, theme: any, _context: any) {
      const text = new Text("", 0, 0);

      const raw = (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join("\n")
        .trim();

      let out = "";

      if (raw) {
        const lines = raw.split("\n");
        const maxLines = options.expanded ? lines.length : 20;
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;

        out += `\n${displayLines
          .map((l: string) => theme.fg("toolOutput", l))
          .join("\n")}`;

        if (remaining > 0) {
          out += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
        }
      }

      // Match built-in formatLsResult warnings
      const entryLimit = result.details?.entryLimitReached as number | undefined;
      const truncation = result.details?.truncation as any;

      if (entryLimit || truncation?.truncated) {
        const warnings: string[] = [];
        if (entryLimit) warnings.push(`${entryLimit} entries limit`);
        if (truncation?.truncated)
          warnings.push(
            `${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`,
          );
        out += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
      }

      text.setText(out);
      return text;
    },
  });
}
