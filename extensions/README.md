# Local extensions

- `cat-ui`: gradient header and terminal title.
- `context.ts`: projected context breakdown and usage grid. `/context` uses [Rosé Pine Dawn](https://rosepinetheme.com/palette/) colors for category labels, grid cells, and free space; borders and headings follow Pi's active theme.
- `pi-diff`: persistent text-file change tracking and guarded accept/decline.
- `pi-statusline`: boxed editor and usage footer.
- `undo`: live per-turn file checkpoints and conversation undo.
- `herdr-agent-state.ts`: externally managed integration. Do not edit it here.

Run `/reload` after source changes. Pi loads direct TypeScript files in `extensions/` as extensions.

## Dependencies and checks

Installed dependencies are ignored, not vendored. Restore pi-diff's locked dependency when needed:

```sh
(cd extensions/pi-diff && npm ci --ignore-scripts)
```

Run these commands from the agent directory. The local symlink lets Bun resolve Pi's host-provided packages without installing duplicate runtimes:

```sh
PI_NODE_MODULES="$(cd "$(dirname "$(realpath "$(command -v pi)")")/../../.." && pwd)"
mkdir -p extensions/node_modules
[ -e extensions/node_modules/@earendil-works ] || ln -s "$PI_NODE_MODULES/@earendil-works" extensions/node_modules/@earendil-works
tsc --noEmit --skipLibCheck --allowImportingTsExtensions --moduleResolution bundler --module preserve --target es2023 --typeRoots "$PI_NODE_MODULES/@types" --baseUrl "$PI_NODE_MODULES" --ignoreDeprecations 6.0 --noUnusedLocals --noUnusedParameters extensions/context.ts extensions/*/index.ts extensions/undo/turn-checkpoint.ts extensions/pi-diff/diff.d.ts
git diff --check
git diff --cached --check
```

Type checking skips third-party declaration errors, but checks local sources against installed APIs. The managed Herdr integration has no local type-check guarantee.
