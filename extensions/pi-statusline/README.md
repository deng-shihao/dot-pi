# Pi Statusline

A global pi extension that replaces the default editor with a full-width rounded input box.

The bottom-right border of the input box shows the active model and thinking level, matching `Grok 4.6 (high)` in the reference. A polished footer remains below the box with the working directory, git branch, token usage, output speed (`tok/s`), cache efficiency, cost, context usage, and extension statuses (for example, `Δ 0  + 2`), but omits pi's duplicate provider/model/thinking label.

## Enable

This directory is already installed at:

```text
~/.pi/agent/extensions/pi-statusline/
```

Run `/reload` in pi, or restart pi, to load it.

## Notes

- The footer, editor border, prompt marker, and model label use `themes/rose-pine-dawn.json`, independent of pi's active theme. If Dawn is unavailable, they use the active theme. Run `/reload` after palette changes.
- The border color follows pi's active thinking level and bash mode within the Dawn palette.
- The extension replaces the editor and footer so the model appears only in the input box.
- The footer emphasizes the current directory, places the `pi-diff` count beside the directory/branch, uses semantic colors for traffic/cache/cost/context, and falls back to a compact layout on narrow terminals.
- `tok/s` shows the last response's reported output tokens divided by the time from stream start to completion. It excludes tool execution time and resets on session switches. It remains hidden until a response has measurable output and duration.
- `ctx` occupies its own full-width line. Its bracket-free progress bar expands to the space left by the percentage and context window size. Its filled cells use a smooth shaded-to-solid gradient, similar to the `cat-ui` logo. The bar tip and percentage keep Dawn's foam at or below 70%, gold above 70%, and love above 90%. The unfilled cells remain dim. A `?` marks unknown usage.
- The footer intentionally omits the duplicate `(provider) model • thinking` text.
- Another extension that replaces the editor or footer may override it depending on extension load order.
- Remove or rename this directory, then run `/reload`, to disable it.
