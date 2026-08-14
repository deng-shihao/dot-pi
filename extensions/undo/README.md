# Undo extension

This Pi extension adds `/undo`, which moves the conversation to before the latest user message, puts that message back in the editor, and restores file mutations recorded for that turn.
Run `/undo` repeatedly to move backward one turn at a time.
Use `/undo --force` or `/undo -f` to skip interactive confirmation.

## File coverage

File checkpoints are ephemeral and belong to the current extension instance.
They are deliberately not written into the Pi session and do not survive an extension or process reload.
After a reload, `/undo` still performs conversation-only undo and shows an explicit warning that file restore is unavailable.

The extension uses two kinds of coverage:

- `edit` and `write` snapshot only the exact target path immediately before the tool runs.
This includes ignored files and paths outside a Git worktree.
The first snapshot of a path in a turn is retained.
A direct snapshot is limited to 64 MiB per file and 128 MiB per turn; a tool call is blocked if its target cannot be snapshotted safely.
- `bash` and unknown custom tools lazily start broad Git coverage immediately before the tool runs.
The broad baseline includes tracked and untracked, non-ignored files in the containing worktree, plus the semantic state of the whole index.
A turn can start with direct snapshots and upgrade to broad coverage later.

Read-only built-ins (`read`, `grep`, `find`, and `ls`) do not create a file checkpoint.
Consequently, undoing a read-only turn does not inspect or restore unrelated manual changes.

Broad coverage does not include ignored files, files outside the worktree, nested-repository or submodule working-tree contents, or arbitrary side effects that Git cannot represent.
The command warns about the ignored/outside-worktree limits after a turn used bash or a custom tool; nested repositories and submodules remain an operational limitation of the parent worktree snapshot.
Direct `edit`/`write` snapshots still cover their exact ignored or outside-worktree paths.
Directories and non-regular direct targets are rejected rather than snapshotted ambiguously.
Git path parsing currently assumes UTF-8-compatible filenames.

## Safety and conflicts

Undo refuses file restore if a recorded path, broad Git path, or semantic index state changed after the turn settled.
Semantic index comparison includes staged entries, assume-unchanged, skip-worktree, and intent-to-add state.
This conflict check prevents later manual work from being overwritten.

Whole-index restore coordinates through Git's canonical `index.lock`.
A pre-existing lock is never bypassed or removed, and restore fails before changing files when the lock cannot be acquired.
Broad checkpoint blobs and trees are written only to an owner-only temporary object directory, with the repository object directory configured as a read-only alternate; checkpoint capture, finalization, restore, and disposal do not add objects to the repository object database.

File restore happens before conversation navigation.
A guarded compensation snapshot can put the turn's file state back if navigation is cancelled or throws.
If files change while navigation is in progress, compensation refuses to overwrite those changes.

The extension retains at most 20 live mutation checkpoints and 64 turn records.
Consumed records and records no longer on the active branch are pruned.
Eviction and `session_shutdown` dispose direct buffers and isolated Git object storage.
Undo of a turn whose checkpoint was evicted remains available for the conversation and emits an explicit file-coverage warning.
Broad checkpoint storage is count-bounded but not byte-bounded; a worktree with large dirty or untracked files can consume substantial temporary disk space until its checkpoint is consumed or evicted.

## Verification

Run these commands from this directory:

```sh
bun test ./index.test.ts ./turn-checkpoint.test.ts
PI_NODE_MODULES="$(cd "$(dirname "$(realpath "$(command -v pi)")")/../../.." && pwd)"
tsc --noEmit --skipLibCheck --allowImportingTsExtensions --moduleResolution bundler --module preserve --target es2022 --typeRoots "$PI_NODE_MODULES/@types" --baseUrl "$PI_NODE_MODULES" --ignoreDeprecations 6.0 index.ts turn-checkpoint.ts
pi --no-extensions -e . --list-models
git diff --check -- .
! grep -nHE '[[:blank:]]+$' README.md *.ts
```

`--skipLibCheck` is needed because the globally installed Pi dependency graph includes third-party declaration files that are not independently type-clean; the extension source is still checked against the installed Pi API declarations.
The `PI_NODE_MODULES` expression derives Pi's global dependency directory instead of assuming a particular Bun installation path.
