# Pi extension API reference

Reached from [`../SKILL.md`](../SKILL.md). Consult the section you need rather than reading the whole file.

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
