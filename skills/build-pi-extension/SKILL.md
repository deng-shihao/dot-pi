---
name: build-pi-extension
description: Build a pi extension — a TypeScript module that adds custom tools, slash commands, event hooks, UI, or providers. Use when creating, building, or scaffolding a pi extension.
---

# Build a Pi Extension

A pi extension is a TypeScript module that exports a default factory receiving `ExtensionAPI`. The factory can be sync or async.

## Extension Styles

```bash
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports default function)
    ├── tools.ts        # Helper module
    └── utils.ts        # Helper module
```

## Steps

### 1. Pin down what the extension must do

Ask the user if any of these are underspecified:

- **Trigger:** tool call by the model, slash command, event hook, or UI replacement?
- **Input:** what data does it need? From the model, the user, the session, or the filesystem?
- **Output:** what does it produce? Tool result, notification, UI, session mutation?
- **Scope:** one-shot test (`-e`), global (`~/.pi/agent/extensions/`), or project (`.pi/extensions/`)?
- **Distribution:** standalone file, directory, or pi package?

### 2. Read the relevant pi docs

Before writing any code, read the authoritative docs for the pattern you are about to use. The pi docs live under the pi package directory, resolved from the README path listed in the agent context:

- **Custom tools, events, commands, UI** → `docs/extensions.md`
- **TUI components (`SelectList`, overlays, theming)** → `docs/tui.md`
- **Custom providers, OAuth, custom streaming** → `docs/custom-provider.md`
- **Packaging for distribution (npm/git)** → `docs/packages.md`
- **SDK / programmatic usage** → `docs/sdk.md`

Read the full file for your pattern — this skill's reference section is a quick reminder, not a substitute. Pay special attention to:
- Return contracts for event handlers (wrong return shape = silent failure)
- `ExtensionContext` vs `ExtensionCommandContext` (commands have session-control methods that tools and event handlers do not)
- The `width` contract for TUI `render()` (every line ≤ width, or the TUI breaks)

### 3. Pick the pattern

Match the intent to the right `ExtensionAPI` method:

| Intent | Method | Notes |
|--------|--------|-------|
| Model-callable tool | `pi.registerTool({...})` | `typebox` for parameters; return `{ content, details }` |
| Slash command | `pi.registerCommand("name", {...})` | Handler gets `ExtensionCommandContext` |
| Block/modify tool calls | `pi.on("tool_call", ...)` | `isToolCallEventType()` for typed input |
| Modify tool results | `pi.on("tool_result", ...)` | Return partial patch |
| Inject context before agent | `pi.on("before_agent_start", ...)` | Return `{ message, systemPrompt }` |
| React to lifecycle | `pi.on("session_start" / "agent_start" / "turn_end" / ...)` | See events table below |
| Custom user-facing UI | `ctx.ui.custom(...)` | `SelectList`, `BorderedLoader`, `SettingsList` from `@earendil-works/pi-tui` |
| Persistent footer element | `ctx.ui.setStatus(...)` / `ctx.ui.setWidget(...)` | Widget can go above or below editor |
| Custom editor | `ctx.ui.setEditorComponent(...)` | Extend `CustomEditor` |
| Custom provider | `pi.registerProvider(...)` | Models, auth, streaming |

### 4. Scaffold the file

Write the extension at the chosen location. Use this skeleton:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, or event handlers
}
```

**Imports** always available: `typebox` (schema), `@earendil-works/pi-coding-agent` (types, events), `@earendil-works/pi-tui` (built-in components), `@earendil-works/pi-ai` (providers, `StringEnum`). Node built-ins (`node:fs`, `node:path`, `node:child_process`) are available. For npm deps, add a `package.json` next to the extension.

**Directory layout** for multi-file extensions:

```
my-extension/
├── index.ts        # default export
├── tools.ts        # tool definitions
└── utils.ts        # helpers
```

### 5. Implement

Build the extension against these rules:

- **Every tool must return** `{ content: ToolContent[], details: Record<string, unknown> }`.
- **Every event handler must return** a result matching its event contract (e.g. `{ block: true, reason: "..." }` for `tool_call`, `{ message, systemPrompt }` for `before_agent_start`). If no mutation is needed, return nothing (`undefined`).
- **TUI components** receive `render(width)`, `handleInput(data)`, `invalidate()`. Each line from `render` must not exceed `width`. Cache rendered output and clear on `invalidate`.
- **Use `ctx.signal`** for abort-aware fetch/model calls inside handlers.
- **Use `ctx.mode === "tui"`** to guard terminal-only features like `custom()`, component factories, and direct TUI rendering.
- **Use `ctx.hasUI`** to guard dialog methods (`select`, `confirm`, `input`, `editor`) and fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`).
- **Tools with UI** call `ctx.ui.custom(...)` inside `execute()`.
- **Async factories** (e.g. fetching remote models) are supported — pi waits for them before continuing startup.
- **Defer background resources** (processes, sockets, watchers) until `session_start`, and clean them up in `session_shutdown`.

### 6. Test

```bash
pi -e ./path/to/extension.ts          # one-shot test
pi -e ./path/to/extension-dir         # directory with index.ts
pi -e npm:package-name                # try a published package
```

For a project extension, place it in `.pi/extensions/`, trust the project, and test interactively. Use `pi --no-extensions -e ./ext.ts` to load only your extension.

### 7. Package (if distributing)

Add a `pi` manifest to `package.json`:

```json
{
  "name": "my-pi-extension",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Install from npm: `pi install npm:my-pi-extension`
Install from git: `pi install git:github.com/user/repo@v1`

## Reference

Event types, tool/command/provider registration, custom UI, and the context API: [`references/api.md`](references/api.md).

For return contracts, session replacement lifecycle, OAuth, and custom streaming, the authoritative docs live in the pi docs directory — `extensions.md`, `tui.md`, `custom-provider.md`, `sdk.md`, `packages.md`.
