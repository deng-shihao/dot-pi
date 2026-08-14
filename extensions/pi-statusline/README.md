# Pi Statusline

A global pi extension that replaces the default editor with a full-width rounded input box.

The bottom-right border of the input box shows the active model and thinking level, matching `Grok 4.6 (high)` in the reference. A polished footer remains below the box with the working directory, git branch, token usage, cache efficiency, cost, context usage, and extension statuses (for example, `Δ 0  + 2`), but omits pi's duplicate provider/model/thinking label.

## Enable

This directory is already installed at:

```text
~/.pi/agent/extensions/pi-statusline/
```

Run `/reload` in pi, or restart pi, to load it.

## Notes

- The border color follows pi's active thinking level and bash mode.
- The extension replaces the editor and footer so the model appears only in the input box.
- The footer emphasizes the current directory, places the `pi-diff` count beside the directory/branch, uses semantic colors for traffic/cache/cost/context, and falls back to a compact layout on narrow terminals.
- The footer intentionally omits the duplicate `(provider) model • thinking` text.
- Another extension that replaces the editor or footer may override it depending on extension load order.
- Remove or rename this directory, then run `/reload`, to disable it.
