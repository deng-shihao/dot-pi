# Global Instructions

## Scope

- These are personal defaults across repositories. A repository or nested `AGENTS.md` may provide more specific instructions for its scope.
- Follow the current task and the project's native workflow. Do not broaden the task merely because a general preference is listed here.

## Tool Preferences

- Prefer `rg` for text search, `fd` for file discovery, and `eza` for directory listings when they are installed. Use a safe available fallback otherwise.
- Use the project's documented build system and task runner. Use `just` only when the repository provides a `Justfile`; do not replace native CMake, Cargo, or other project commands to satisfy a tool preference.
- Respect the package manager and lockfile already used by the project. For uv-managed Python projects, prefer `PYTHONUNBUFFERED=1 uv run python -u`; for pnpm-managed JavaScript projects, prefer `pnpm`. Otherwise use the documented environment, and do not switch ecosystems implicitly.
- Use optional tools such as `ruff`, `basedpyright`, `gitleaks`, and `hyperfine` only when they are installed and relevant. Do not install tools or dependencies solely to satisfy a preference.

## Engineering Defaults

- Implement the complete solution that solves the requested problem.
- Avoid heavy abstractions, extra layers, large dependencies, and cleverness unless they provide a clear, task-relevant benefit.
- Prefer readable, debuggable code with explicit ownership and failure modes.
- Preserve existing behavior unless the task requires a change.
- Do not mix unrelated cleanup, redesign, or speculative roadmap work into a focused change.
- Ask before adding a new production dependency unless the user explicitly requested it.

## Working Tree and Change Safety

- Inspect the working tree before editing and preserve user-owned or unrelated changes.
- Do not use destructive Git commands or overwrite files to discard changes unless the user explicitly requests that action.
- Do not create a commit unless the task authorizes it. Do not push, create a pull request, publish, or mutate an external system unless authorized.
- Keep edits scoped and review the final diff for accidental changes.

## Code Hygiene

- Do not leave temporary debug logging, prints, profiling instrumentation, or commented-out experiments in delivered code. Legitimate user-facing and operational logging is allowed.
- Keep new and modified code cohesive. Do not make an existing oversized module larger without need, and do not perform a broad file split unless it belongs to the task.
- Follow the repository's existing formatter, linter, naming, and organization conventions.
- Write self-explanatory code; use comments only to explain intent, constraints, and non-obvious logic, and keep them accurate and synchronized with the code.
- Use one line per paragraph or list item in plain Markdown, not semantic line breaks.

## Verification

When wrapping up a task, verify these questions before marking it complete:

- Has the goal been achieved? Confirm every requirement against the implemented changes.
- Have the changes been tested? Run relevant tests and evaluate whether the results match expectations.
- Do the changes follow best practices? Check for code clarity, error handling, and project conventions.
- Does existing functionality still work? Run existing tests and spot-check unaffected features.

After the checklist above, run the smallest relevant project-native build, test, lint, or type-check commands, then expand verification in proportion to risk.
- Never claim a check passed if it was not run. Report pass, fail, skip, and unavailable states distinctly.
- A skipped integration or real-environment test is unverified, not passed.
- Run `git diff --check` for text changes in a Git worktree when applicable.
- For failures, preserve the exact failing command and the first actionable error instead of reducing the result to a generic failure statement.

## Communication

- Lead with the outcome and keep explanations proportional to the task.
- Reference exact files, lines, commands, and observed evidence when they help the user verify the result.
- State assumptions, unresolved risks, and unverified work explicitly.

## Handoffs and Context Compaction

When producing a handoff or compressed context, preserve in this order:

1. Architecture decisions, invariants, and constraints without changing their meaning.
2. Modified files and their key changes.
3. Verification commands and pass, fail, skip, or unavailable status.
4. Open TODOs, blockers, risks, and rollback notes.
5. Exact failing commands and the first relevant error; passing tool output may be reduced to concise status.
