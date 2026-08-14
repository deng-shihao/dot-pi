# Global Instructions

Personal defaults across repositories. A nested `AGENTS.md` wins inside its tree. Stay on the current task and the project's native workflow; a preference here does not enlarge the request.

## Native tools

- Search with `rg`, discover files with `fd`, and list directories with `eza` when they are installed; otherwise a safe fallback.
- Drive the repo's own build system, task runner, formatter, linter, naming, and layout. Use `just` only when a `Justfile` is present.
- Stay on the repo's package manager and lockfile. For uv Python, `PYTHONUNBUFFERED=1 uv run python -u`. For pnpm JavaScript, `pnpm`.
- Reach for `ruff`, `basedpyright`, `gitleaks`, or `hyperfine` only when already installed and relevant to the task.

## Changes

- Ship the request complete and scoped. Unrelated cleanup, redesign, and roadmap work stay out of the diff. Leave existing behavior intact unless the task changes it.
- Prefer readable, debuggable code with explicit ownership and failure modes. An extra abstraction, layer, dependency, or clever trick has to earn its keep on this task.
- Ask before adding a production dependency the user did not request.
- Inspect the working tree first. Leave user-owned and unrelated work intact.
- Commit, push, open a PR, publish, or mutate an external system only when authorized. Destructive Git and discard-overwrites only on explicit request.
- After editing, review the diff for accidental changes.
- Keep new and changed code cohesive. Enlarge an oversized module only when the change has nowhere else to go; split a file only when the split is the task.
- Ship without leftover debug logs, prints, profiling, or commented-out experiments. User-facing and operational logging stays.
- Comments explain intent, constraints, and non-obvious logic, and stay true to the code.
- In plain Markdown, one line per paragraph or list item.

## Verification

Work is done when every requirement is met and every check is reported as observed: pass, fail, skip, or unavailable. Run the smallest native build, test, lint, or type-check, then widen with risk: existing tests, and a spot-check of anything the change could have touched.

- A skipped integration or real-environment test is unverified.
- For text changes in a Git worktree, run `git diff --check`.
- On failure, keep the exact command and the first actionable error.

## Communication

Lead with the outcome. Cite files, lines, commands, and observed evidence when they help the user verify. State assumptions, open risks, and unverified work.

## Handoffs

When compacting or handing off, preserve in this order:

1. Architecture decisions, invariants, and constraints, without changing their meaning.
2. Modified files and their key changes.
3. Verification commands and observed status.
4. Open TODOs, blockers, risks, and rollback notes.
5. Exact failing commands and the first relevant error; passing output may be a status line.
