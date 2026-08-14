---
name: build-pi-extension
description: Build a pi extension — a TypeScript module that extends pi with custom tools, slash commands, event hooks, custom UI, or custom providers. Use when the user wants to create, build, or scaffold a pi extension, add a custom tool, register a slash command, build TUI components, or register a custom provider.
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

### Event types

| Event | Fires when | Common return |
|-------|-----------|---------------|
| `project_trust` | Trust decision before project loading | `{ trusted: "yes" \| "no" \| "undecided", remember?: boolean }` |
| `session_start` | Session loaded or reloaded | — |
| `session_shutdown` | Session torn down (quit, reload, new, resume, fork) | — |
| `before_agent_start` | User submits prompt, before agent loop | `{ message?, systemPrompt? }` |
| `agent_start` / `agent_end` / `agent_settled` | Agent run lifecycle (settled = no auto-retry left) | — |
| `turn_start` / `turn_end` | Each LLM response + tool calls | — |
| `tool_call` | Before tool execution | `{ block: true, reason?: string }` or mutate `event.input` |
| `tool_result` | After tool execution, before result message | `{ content?, details?, isError?, usage? }` |
| `context` | Before each LLM call | `{ messages }` (replacing the context array) |
| `before_provider_headers` | Outgoing HTTP headers assembled | mutate `event.headers` in place |
| `before_provider_request` | Provider payload built | return replacement payload or `undefined` |
| `after_provider_response` | HTTP response received, before stream consumed | — |
| `input` | User input (before skill/template expansion) | `{ action: "continue" \| "transform" \| "handled", text? }` |
| `model_select` | Model changed | — |
| `thinking_level_select` | Thinking level changed | — |
| `session_before_compact` / `session_compact` | Compaction | `{ cancel: true }` or custom summary |
| `session_before_switch` / `session_before_fork` | Session replacement | `{ cancel: true }` |
| `resources_discover` | After session_start | `{ skillPaths?, promptPaths?, themePaths? }` |
| `user_bash` | User `!` or `!!` command | custom bash operations or result |

### Tool registration

```typescript
pi.registerTool({
  name: "my_tool",           // snake_case, model-facing
  label: "My Tool",          // human-readable (TUI)
  description: "What it does. Use when ...",  // LLM decides whether to call based on this
  parameters: Type.Object({
    param: Type.String({ description: "What this param is" }),
  }),
  promptSnippet: "my_tool: short one-line description",  // optional, for "Available tools" section
  promptGuidelines: [       // optional, appended to system prompt Guidelines
    "Use my_tool to ...",
    "Prefer my_tool over bash when ...",
  ],
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // signal: AbortSignal — abort-aware fetch / long work
    // onUpdate: (update: ToolExecutionUpdate) => void — stream partial output to TUI
    // ctx: ExtensionContext
    return {
      content: [{ type: "text", text: "Result" }],
      details: {},           // arbitrary structured data
    };
  },
});
```

`promptGuidelines` bullets must name the tool explicitly — "Use my_tool when..." not "Use this tool when...".

### Command registration

```typescript
pi.registerCommand("mycmd", {
  description: "What /mycmd does",
  handler: async (args, ctx) => {
    // args: string | undefined (everything after /mycmd)
    // ctx: ExtensionCommandContext (has session control methods)
    ctx.ui.notify(`Ran with args: ${args || "none"}`, "info");
  },
});
```

Commands bypass agent processing — the handler runs directly.

### Custom UI (TUI mode only)

```typescript
const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
  return {
    render: (width: number) => ["Line 1", "Line 2"],
    handleInput: (data: string) => { /* keyboard */ },
    invalidate: () => { /* clear cache */ },
  };
});

// Or as overlay
const result = await ctx.ui.custom<...>(factory, { overlay: true });
```

**Built-in components** from `@earendil-works/pi-tui`:
- `SelectList(items, visibleCount, theme)` — selection UI with keyboard nav
- `SettingsList(items, visibleCount, theme, onChange, onClose)` — toggle settings
- `BorderedLoader(tui, theme, message)` — spinner with cancel support
- `Container`, `Text`, `Box`, `Spacer`, `Markdown`, `DynamicBorder`
- `getSettingsListTheme()`, `getMarkdownTheme()`, `matchesKey(data, key)`

See the pi TUI docs for the full component API and key identifiers.

### Provider registration

```typescript
pi.registerProvider("provider-id", {
  name: "Display Name",
  baseUrl: "https://api.example.com",
  apiKey: "$ENV_VAR",
  api: "openai-completions",     // or anthropic-messages, etc.
  models: [{ id, name, reasoning, input, cost, contextWindow, maxTokens }],
  // Optional: OAuth, custom streaming, custom headers
});
```

Async factory for dynamic model discovery — pi waits before continuing startup.

### Context API quick reference

| Property | What it is |
|----------|-----------|
| `ctx.cwd` | Current working directory |
| `ctx.mode` | `"tui"`, `"rpc"`, `"json"`, or `"print"` |
| `ctx.hasUI` | `true` in TUI and RPC; false in print/json |
| `ctx.isProjectTrusted()` | Whether project trust is active |
| `ctx.signal` | Current agent abort signal (or undefined if idle) |
| `ctx.isIdle()` | Agent not processing, retrying, or continuing |
| `ctx.sessionManager` | Read-only session state |
| `ctx.model` | Active model |
| `ctx.thinkingLevel` | Current effective thinking level |
| `ctx.getSystemPrompt()` | Current system prompt string |
| `ctx.getContextUsage()` | Current token usage estimate |
| `ctx.shutdown()` | Request graceful shutdown |
| `ctx.ui.notify(msg, level)` | Toast notification (`"info"`, `"warning"`, `"error"`) |
| `ctx.ui.confirm(title, message)` | Confirm dialog (returns boolean) |
| `ctx.ui.select(title, options)` | Single-select dialog |
| `ctx.ui.input(title)` | Text input dialog |
| `ctx.ui.setStatus(id, text)` | Footer status line |
| `ctx.ui.setWidget(id, content)` | Widget above/below editor |
| `ctx.ui.setEditorComponent(factory)` | Replace editor |
| `ctx.ui.custom(factory, opts?)` | Full custom component |

**Command context** (`ctx` in command handlers) adds:
- `ctx.waitForIdle()` — block until agent settles
- `ctx.newSession(opts)` — create replacement session
- `ctx.fork(entryId, opts)` — fork session at entry
- `ctx.switchSession(path, opts)` — switch to another session
- `ctx.reload()` — same as `/reload`
- `ctx.getSystemPromptOptions()` — base inputs for system prompt

### Full API

For event details, return contracts, session replacement lifecycle, custom providers, OAuth, and custom streaming: the authoritative docs are at the pi docs directory — `extensions.md`, `tui.md`, `custom-provider.md`, `sdk.md`, `packages.md`.
