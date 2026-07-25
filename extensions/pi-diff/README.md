# pi-diff (pi extension)

Tracks files changed (modified/created) by **pi** via the built-in `edit` and `write` tools.

## Features

- Persistent log (stored in session as custom entries)
- Status line + widget listing changed files
- `/pi-diff` overlay to inspect diffs
- `/pi-diff-accept` to clear the log (keep files)
- `/pi-diff-decline` to revert logged changes (restore original contents / delete created files)

## Usage

1. Reload pi: `/reload`
2. Make changes through pi (using `edit`/`write`)
3. Run:
   - `/pi-diff` to inspect
   - `/pi-diff-accept` to accept (clear log)
   - `/pi-diff-decline` to decline (revert)

### Non-interactive usage

If `ctx.hasUI` is false (print/json mode), accept/decline require explicit confirmation:

- `/pi-diff-accept force`
- `/pi-diff-decline force`

## Notes

- Only tracks changes performed through `edit` and `write` tools.
- To support "decline", the extension stores the original file contents (before the first pi change) in the session file as a custom entry.
