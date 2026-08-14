# pi-diff (pi extension)

Tracks files changed (modified/created) by **pi** via the built-in `edit` and `write` tools.

## Features

- Persistent log (stored in session as custom entries)
- Status line showing the number of changed files
- `/pi-diff` overlay to inspect diffs with per-file accept/decline
- `/pi-diff-accept` to clear the log (keep all files)
- `/pi-diff-decline` to revert all logged changes (restore original contents / delete created files)
- `/pi-diff-accept-file <path>` to accept a single file
- `/pi-diff-decline-file <path>` to revert a single file
- Per-file keyboard shortcuts in both file list and diff views (`a` to accept, `d` to decline)

## Usage

1. Reload pi: `/reload`
2. Make changes through pi (using `edit`/`write`)
3. Run:
   - `/pi-diff` to inspect — in the file list, press `a` to accept or `d` to decline the selected file; press Enter to view a diff where you can also press `a`/`d` for per-file actions
   - `/pi-diff-accept` to accept all changes (clear log)
   - `/pi-diff-decline` to decline all changes (revert)
   - `/pi-diff-accept-file <path>` to accept a specific file
   - `/pi-diff-decline-file <path>` to decline a specific file

### Non-interactive usage

If `ctx.hasUI` is false (print/json mode), accept/decline require explicit confirmation:

- `/pi-diff-accept force`
- `/pi-diff-decline force`

## Notes

- Only tracks changes performed through `edit` and `write` tools.
- To support "decline", the extension stores the original file contents (before the first pi change) in the session file as a custom entry.
- Revert fingerprints each recorded post-change state and refuses to overwrite a file that changed afterward; failed files remain tracked for inspection or retry.
