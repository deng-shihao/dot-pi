import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_DIRECT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DIRECT_CHECKPOINT_BYTES = 128 * 1024 * 1024;

type FileState =
  | { kind: "missing"; missingParents: string[] }
  | { kind: "file"; content: Buffer; mode: number };

type DirectSnapshot = {
  absPath: string;
  displayPath: string;
  original: FileState;
};

type GitTreeEntry = {
  mode: string;
  type: string;
  hash: string;
};

type GitTree = {
  hash: string;
  entries: Map<string, GitTreeEntry>;
};

type GitStorage = {
  directory: string;
  objectDirectory: string;
  alternateObjectDirectory: string;
};

type GitIndex = {
  path: string;
  content: Buffer | null;
  semanticState: Buffer;
};

type GitCheckpoint = {
  root: string;
  storage: GitStorage;
  tree: GitTree;
  index: GitIndex;
};

export type GitCoverage =
  | { status: "not-requested" }
  | { status: "available"; root: string }
  | { status: "not-repository" }
  | { status: "failed"; error: string };

export type RestoreResult = {
  restoredFiles: string[];
  errors: string[];
  rollback?: () => Promise<RestoreResult>;
  commit?: () => Promise<void>;
};

type GitRunOptions = {
  indexFile?: string;
  storage?: GitStorage;
  signal?: AbortSignal;
  input?: string | Buffer;
  allowedExitCodes?: number[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function pathDepth(path: string): number {
  return path.split(sep).length;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

async function runGit(
  cwd: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = { ...process.env };
    if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
    if (options.storage) {
      env.GIT_OBJECT_DIRECTORY = options.storage.objectDirectory;
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES =
        options.storage.alternateObjectDirectory;
    }

    const child = execFile(
      "git",
      args,
      {
        cwd,
        encoding: "buffer",
        env,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode =
            typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : undefined;
          if (exitCode !== undefined && options.allowedExitCodes?.includes(exitCode)) {
            resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
            return;
          }
          const detail = Buffer.isBuffer(stderr)
            ? stderr.toString("utf8").trim()
            : String(stderr ?? "").trim();
          rejectPromise(new Error(detail || error.message));
          return;
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function findGitRoot(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const output = await runGit(cwd, ["rev-parse", "--show-toplevel"], {
      signal,
    });
    return output.toString("utf8").trim() || null;
  } catch (error) {
    if (errorMessage(error).includes("not a git repository")) return null;
    throw error;
  }
}

function parseGitTree(output: Buffer): Map<string, GitTreeEntry> {
  const entries = new Map<string, GitTreeEntry>();
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, hash] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode && type && hash && path) {
      entries.set(path, { mode, type, hash });
    }
  }
  return entries;
}

async function createGitStorage(
  root: string,
  signal?: AbortSignal,
): Promise<GitStorage> {
  const alternateObjectDirectory = (
    await runGit(
      root,
      ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
      { signal },
    )
  )
    .toString("utf8")
    .trim();
  const directory = await mkdtemp(
    join(tmpdir(), `pi-undo-checkpoint-${process.pid}-`),
  );
  const objectDirectory = join(directory, "objects");
  try {
    await mkdir(objectDirectory, { mode: 0o700 });
    return { directory, objectDirectory, alternateObjectDirectory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function captureGitIndex(
  root: string,
  storage: GitStorage,
  signal?: AbortSignal,
): Promise<GitIndex> {
  const indexPath = (
    await runGit(
      root,
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      { storage, signal },
    )
  )
    .toString("utf8")
    .trim();
  const [entries, stagedDiff] = await Promise.all([
    runGit(root, ["ls-files", "--stage", "-v", "-z"], {
      storage,
      signal,
    }),
    runGit(
      root,
      ["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z"],
      { storage, signal },
    ),
  ]);
  const semanticState = Buffer.concat([
    entries,
    Buffer.from("\0pi-undo-staged-diff\0"),
    stagedDiff,
  ]);
  try {
    return { path: indexPath, content: await readFile(indexPath), semanticState };
  } catch (error) {
    if (isMissingError(error)) {
      return { path: indexPath, content: null, semanticState };
    }
    throw error;
  }
}

function gitIndexSemanticallyMatches(a: GitIndex, b: GitIndex): boolean {
  return a.path === b.path && a.semanticState.equals(b.semanticState);
}

class GitIndexLock {
  private handle: FileHandle | undefined;
  private finished = false;

  private constructor(
    private readonly lockPath: string,
    handle: FileHandle,
  ) {
    this.handle = handle;
  }

  static async acquire(indexPath: string): Promise<GitIndexLock> {
    const lockPath = `${indexPath}.lock`;
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(
          `Git index is locked (${lockPath}); refusing to bypass the existing lock`,
        );
      }
      throw error;
    }
    return new GitIndexLock(lockPath, handle);
  }

  async commit(index: GitIndex): Promise<void> {
    if (this.finished || !this.handle) throw new Error("Git index lock is closed");
    if (index.content === null) {
      await this.handle.close();
      this.handle = undefined;
      await rm(index.path, { force: true });
      await rm(this.lockPath, { force: true });
    } else {
      await this.handle.writeFile(index.content);
      await this.handle.sync();
      await this.handle.close();
      this.handle = undefined;
      await rename(this.lockPath, index.path);
    }
    this.finished = true;
  }

  async release(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.handle?.close();
    } finally {
      this.handle = undefined;
      await rm(this.lockPath, { force: true });
    }
  }
}

async function captureGitTree(
  root: string,
  storage: GitStorage,
  signal?: AbortSignal,
): Promise<GitTree> {
  const tempDir = await mkdtemp(join(storage.directory, "capture-"));
  const indexFile = join(tempDir, "index");

  try {
    await runGit(root, ["read-tree", "--empty"], {
      indexFile,
      storage,
      signal,
    });
    await runGit(root, ["add", "-A", "--", "."], {
      indexFile,
      storage,
      signal,
    });
    const treeHash = (
      await runGit(root, ["write-tree"], { indexFile, storage, signal })
    )
      .toString("utf8")
      .trim();
    const tree = await runGit(root, ["ls-tree", "-r", "-z", treeHash], {
      storage,
      signal,
    });
    return { hash: treeHash, entries: parseGitTree(tree) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readFileState(
  absPath: string,
  remainingBytes = MAX_DIRECT_FILE_BYTES,
): Promise<FileState> {
  try {
    const stats = await lstat(absPath);
    if (!stats.isFile()) throw new Error("path is not a regular file");
    if (stats.size > MAX_DIRECT_FILE_BYTES) {
      throw new Error(
        `file is ${stats.size} bytes; direct undo snapshots are limited to ${MAX_DIRECT_FILE_BYTES} bytes per file`,
      );
    }
    if (stats.size > remainingBytes) {
      throw new Error(
        `direct undo snapshots are limited to ${MAX_DIRECT_CHECKPOINT_BYTES} bytes per turn`,
      );
    }
    const content = await readFile(absPath);
    if (content.length > MAX_DIRECT_FILE_BYTES || content.length > remainingBytes) {
      content.fill(0);
      throw new Error(
        content.length > MAX_DIRECT_FILE_BYTES
          ? `file grew beyond the ${MAX_DIRECT_FILE_BYTES}-byte direct undo snapshot limit while being read`
          : `file grew beyond the ${MAX_DIRECT_CHECKPOINT_BYTES}-byte per-turn direct undo snapshot limit while being read`,
      );
    }
    return {
      kind: "file",
      content,
      mode: stats.mode & 0o777,
    };
  } catch (error) {
    if (!isMissingError(error)) throw error;

    const missingParents: string[] = [];
    let current = dirname(absPath);
    while (current !== dirname(current)) {
      try {
        await lstat(current);
        break;
      } catch (parentError) {
        if (!isMissingError(parentError)) throw parentError;
        missingParents.push(current);
        current = dirname(current);
      }
    }
    return { kind: "missing", missingParents };
  }
}

function fileStatesEqual(a: FileState, b: FileState): boolean {
  if (a.kind === "missing" || b.kind === "missing") return a.kind === b.kind;
  return a.mode === b.mode && a.content.equals(b.content);
}

async function fileStateMatches(
  absPath: string,
  expected: FileState,
): Promise<boolean> {
  try {
    return fileStatesEqual(await readFileState(absPath), expected);
  } catch {
    return false;
  }
}

async function removeNonDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      await rmdir(path);
      return;
    }
    await rm(path, { force: true });
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
}

async function restoreFileState(snapshot: DirectSnapshot): Promise<boolean> {
  if (await fileStateMatches(snapshot.absPath, snapshot.original)) return false;

  if (snapshot.original.kind === "missing") {
    await removeNonDirectory(snapshot.absPath);
    for (const parent of snapshot.original.missingParents.sort(
      (a, b) => pathDepth(b) - pathDepth(a),
    )) {
      try {
        await rmdir(parent);
      } catch (error) {
        const code = errorCode(error);
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      }
    }
    return true;
  }

  try {
    const current = await lstat(snapshot.absPath);
    if (current.isDirectory()) await rmdir(snapshot.absPath);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }

  await mkdir(dirname(snapshot.absPath), { recursive: true });
  await writeFile(snapshot.absPath, snapshot.original.content);
  await chmod(snapshot.absPath, snapshot.original.mode);
  return true;
}

function gitEntryEquals(
  a: GitTreeEntry | undefined,
  b: GitTreeEntry | undefined,
): boolean {
  return a?.mode === b?.mode && a?.type === b?.type && a?.hash === b?.hash;
}

function changedGitPaths(before: GitTree, after: GitTree): string[] {
  const allPaths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  return [...allPaths].filter(
    (path) => !gitEntryEquals(before.entries.get(path), after.entries.get(path)),
  );
}

async function restoreGitFiles(
  checkpoint: GitCheckpoint,
  relativePaths: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const errors = new Map<string, string>();
  if (relativePaths.length === 0) return errors;

  const tempDir = await mkdtemp(join(checkpoint.storage.directory, "restore-"));
  const indexFile = join(tempDir, "index");
  try {
    await runGit(checkpoint.root, ["read-tree", checkpoint.tree.hash], {
      indexFile,
      storage: checkpoint.storage,
      signal,
    });

    for (const relativePath of relativePaths) {
      const entry = checkpoint.tree.entries.get(relativePath);
      if (!entry) continue;
      if (entry.type !== "blob") {
        errors.set(relativePath, `unsupported Git entry type ${entry.type}`);
        continue;
      }

      const absPath = resolve(checkpoint.root, relativePath);
      if (!isPathWithin(checkpoint.root, absPath)) {
        errors.set(relativePath, "path escapes the Git worktree");
        continue;
      }

      try {
        try {
          const current = await lstat(absPath);
          if (current.isDirectory()) await rmdir(absPath);
        } catch (error) {
          if (!isMissingError(error)) throw error;
        }
        await runGit(
          checkpoint.root,
          ["checkout-index", "--force", "--", relativePath],
          { indexFile, storage: checkpoint.storage, signal },
        );
      } catch (error) {
        errors.set(relativePath, errorMessage(error));
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  return errors;
}

function displayPath(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  return rel && isPathWithin(cwd, absPath) ? rel : absPath;
}

function normalizeToolPath(rawPath: string): string {
  let normalized = rawPath.replace(
    /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g,
    " ",
  );
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  if (normalized.startsWith("~/")) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return normalized;
}

async function canonicalPath(cwd: string, rawPath: string): Promise<string> {
  const resolved = resolve(cwd, normalizeToolPath(rawPath));
  const missingSegments: string[] = [];
  let existingAncestor = resolved;

  while (true) {
    try {
      return resolve(await realpath(existingAncestor), ...missingSegments);
    } catch (error) {
      if (!isMissingError(error)) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return resolved;
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function clearFileState(state: FileState | undefined): void {
  if (state?.kind === "file") state.content.fill(0);
}

export class TurnCheckpoint {
  gitCoverage: GitCoverage = { status: "not-requested" };
  private readonly cwd: string;
  private gitCheckpoint?: GitCheckpoint;
  private broadCapturePromise?: Promise<void>;
  private readonly directSnapshots = new Map<string, DirectSnapshot>();
  private directSnapshotBytes = 0;
  private finalized = false;
  private finalizedGitTree?: GitTree;
  private finalizedGitIndex?: GitIndex;
  private readonly finalizedDirectStates = new Map<string, FileState>();
  private finalizationErrors: string[] = [];
  private disposed = false;

  private constructor(
    cwd: string,
    gitCoverage: GitCoverage = { status: "not-requested" },
    gitCheckpoint?: GitCheckpoint,
    private readonly ownsStorage = true,
  ) {
    this.cwd = cwd;
    this.gitCoverage = gitCoverage;
    this.gitCheckpoint = gitCheckpoint;
  }

  static async create(cwd: string, _signal?: AbortSignal): Promise<TurnCheckpoint> {
    const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
    return new TurnCheckpoint(canonicalCwd);
  }

  /** Lazily starts whole-worktree coverage. Call before bash or an unknown tool. */
  async capture(signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    if (this.finalized) throw new Error("checkpoint is already finalized");
    if (!this.broadCapturePromise) {
      this.broadCapturePromise = this.captureBroad(signal);
    }
    await this.broadCapturePromise;
  }

  private async captureBroad(signal?: AbortSignal): Promise<void> {
    let root: string | null;
    try {
      root = await findGitRoot(this.cwd, signal);
    } catch (error) {
      this.gitCoverage = { status: "failed", error: errorMessage(error) };
      return;
    }
    if (!root) {
      this.gitCoverage = { status: "not-repository" };
      return;
    }

    let storage: GitStorage | undefined;
    try {
      storage = await createGitStorage(root, signal);
      const [tree, index] = await Promise.all([
        captureGitTree(root, storage, signal),
        captureGitIndex(root, storage, signal),
      ]);
      this.gitCheckpoint = { root, storage, tree, index };
      this.gitCoverage = { status: "available", root };
    } catch (error) {
      if (storage) await rm(storage.directory, { recursive: true, force: true });
      this.gitCoverage = { status: "failed", error: errorMessage(error) };
    }
  }

  private async broadCoverageOwnsPath(
    absPath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const checkpoint = this.gitCheckpoint;
    if (!checkpoint || !isPathWithin(checkpoint.root, absPath)) return false;

    const relativePath = relative(checkpoint.root, absPath).split(sep).join("/");
    if (!relativePath) return false;
    for (const [entryPath, entry] of checkpoint.tree.entries) {
      if (
        entry.type === "commit" &&
        (relativePath === entryPath || relativePath.startsWith(`${entryPath}/`))
      ) {
        return false;
      }
    }
    if (checkpoint.tree.entries.has(relativePath)) return true;

    const ignored = await runGit(
      checkpoint.root,
      ["check-ignore", "--stdin", "-z"],
      {
        storage: checkpoint.storage,
        signal,
        input: `${relativePath}\0`,
        allowedExitCodes: [1],
      },
    );
    return ignored.length === 0;
  }

  async captureFile(rawPath: string, signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    if (this.finalized) throw new Error("checkpoint is already finalized");
    const absPath = await canonicalPath(this.cwd, rawPath);
    if (this.directSnapshots.has(absPath)) return;
    if (await this.broadCoverageOwnsPath(absPath, signal)) return;

    const original = await readFileState(
      absPath,
      MAX_DIRECT_CHECKPOINT_BYTES - this.directSnapshotBytes,
    );
    if (original.kind === "file") {
      this.directSnapshotBytes += original.content.length;
    }
    this.directSnapshots.set(absPath, {
      absPath,
      displayPath: displayPath(this.cwd, absPath),
      original,
    });
  }

  async finalize(signal?: AbortSignal): Promise<string[]> {
    this.assertUsable();
    if (this.finalized) return [...this.finalizationErrors];
    this.finalized = true;
    this.finalizationErrors = [];
    this.finalizedDirectStates.clear();

    if (this.gitCheckpoint) {
      try {
        [this.finalizedGitTree, this.finalizedGitIndex] = await Promise.all([
          captureGitTree(
            this.gitCheckpoint.root,
            this.gitCheckpoint.storage,
            signal,
          ),
          captureGitIndex(
            this.gitCheckpoint.root,
            this.gitCheckpoint.storage,
            signal,
          ),
        ]);
      } catch (error) {
        this.finalizationErrors.push(
          `Git worktree snapshot: ${errorMessage(error)}`,
        );
      }
    }

    let finalizedDirectBytes = 0;
    for (const snapshot of this.directSnapshots.values()) {
      try {
        const finalState = await readFileState(
          snapshot.absPath,
          MAX_DIRECT_CHECKPOINT_BYTES - finalizedDirectBytes,
        );
        if (finalState.kind === "file") {
          finalizedDirectBytes += finalState.content.length;
        }
        this.finalizedDirectStates.set(snapshot.absPath, finalState);
      } catch (error) {
        this.finalizationErrors.push(
          `${snapshot.displayPath}: ${errorMessage(error)}`,
        );
      }
    }

    return [...this.finalizationErrors];
  }

  async restore(signal?: AbortSignal): Promise<RestoreResult> {
    this.assertUsable();
    return this.restoreInternal(signal, true);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.broadCapturePromise?.catch(() => {});

    for (const snapshot of this.directSnapshots.values()) {
      clearFileState(snapshot.original);
    }
    for (const state of this.finalizedDirectStates.values()) clearFileState(state);
    this.directSnapshots.clear();
    this.finalizedDirectStates.clear();
    this.gitCheckpoint?.index.content?.fill(0);
    this.gitCheckpoint?.index.semanticState.fill(0);
    this.gitCheckpoint?.tree.entries.clear();
    this.finalizedGitIndex?.content?.fill(0);
    this.finalizedGitIndex?.semanticState.fill(0);
    this.finalizedGitTree?.entries.clear();

    if (this.ownsStorage && this.gitCheckpoint) {
      await rm(this.gitCheckpoint.storage.directory, {
        recursive: true,
        force: true,
      });
    }
    this.gitCheckpoint = undefined;
    this.finalizedGitTree = undefined;
    this.finalizedGitIndex = undefined;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("checkpoint is disposed");
  }

  private async restoreInternal(
    signal: AbortSignal | undefined,
    transactional: boolean,
    validateFinalized = true,
  ): Promise<RestoreResult> {
    const restored = new Set<string>();
    const errors: string[] = [];
    let currentGitTree: GitTree | undefined;
    let currentGitIndex: GitIndex | undefined;

    if (this.gitCheckpoint) {
      try {
        [currentGitTree, currentGitIndex] = await Promise.all([
          captureGitTree(
            this.gitCheckpoint.root,
            this.gitCheckpoint.storage,
            signal,
          ),
          captureGitIndex(
            this.gitCheckpoint.root,
            this.gitCheckpoint.storage,
            signal,
          ),
        ]);
      } catch (error) {
        errors.push(`Git worktree snapshot: ${errorMessage(error)}`);
      }
    }

    if (this.finalized && validateFinalized) {
      errors.push(...this.finalizationErrors);
      if (this.gitCheckpoint && this.finalizedGitTree && currentGitTree) {
        for (const path of changedGitPaths(this.finalizedGitTree, currentGitTree)) {
          errors.push(
            `${displayPath(this.cwd, resolve(this.gitCheckpoint.root, path))}: changed after the turn settled`,
          );
        }
      }
      if (
        this.finalizedGitIndex &&
        currentGitIndex &&
        !gitIndexSemanticallyMatches(this.finalizedGitIndex, currentGitIndex)
      ) {
        errors.push("Git index changed after the turn settled");
      }
      for (const snapshot of this.directSnapshots.values()) {
        const finalState = this.finalizedDirectStates.get(snapshot.absPath);
        if (
          !finalState ||
          !(await fileStateMatches(snapshot.absPath, finalState))
        ) {
          errors.push(`${snapshot.displayPath}: changed after the turn settled`);
        }
      }
    }

    if (errors.length > 0) return { restoredFiles: [], errors };

    let indexLock: GitIndexLock | undefined;
    const needsIndexRestore = Boolean(
      this.gitCheckpoint &&
        currentGitIndex &&
        !gitIndexSemanticallyMatches(this.gitCheckpoint.index, currentGitIndex),
    );
    if (needsIndexRestore && currentGitIndex) {
      try {
        indexLock = await GitIndexLock.acquire(currentGitIndex.path);
      } catch (error) {
        return { restoredFiles: [], errors: [`Git index: ${errorMessage(error)}`] };
      }
    }

    // Narrow the check/use window after acquiring the index lock. Broad tree
    // capture uses an isolated index, so it remains safe while the canonical
    // lock is held.
    if (this.gitCheckpoint && currentGitTree && currentGitIndex) {
      try {
        const [revalidatedTree, revalidatedIndex] = await Promise.all([
          captureGitTree(
            this.gitCheckpoint.root,
            this.gitCheckpoint.storage,
            signal,
          ),
          captureGitIndex(
            this.gitCheckpoint.root,
            this.gitCheckpoint.storage,
            signal,
          ),
        ]);
        if (revalidatedTree.hash !== currentGitTree.hash) {
          errors.push("Git worktree changed while preparing the restore");
        }
        if (!gitIndexSemanticallyMatches(revalidatedIndex, currentGitIndex)) {
          errors.push("Git index changed while preparing the restore");
        }
        currentGitTree = revalidatedTree;
        currentGitIndex = revalidatedIndex;
      } catch (error) {
        errors.push(`Git restore revalidation: ${errorMessage(error)}`);
      }
    }
    if (errors.length > 0) {
      await indexLock?.release();
      return { restoredFiles: [], errors };
    }

    const compensation = new TurnCheckpoint(
      this.cwd,
      this.gitCoverage,
      this.gitCheckpoint && currentGitTree && currentGitIndex
        ? {
            root: this.gitCheckpoint.root,
            storage: this.gitCheckpoint.storage,
            tree: currentGitTree,
            index: currentGitIndex,
          }
        : undefined,
      false,
    );
    let compensationDirectBytes = 0;
    for (const snapshot of this.directSnapshots.values()) {
      try {
        const original = await readFileState(
          snapshot.absPath,
          MAX_DIRECT_CHECKPOINT_BYTES - compensationDirectBytes,
        );
        if (original.kind === "file") {
          compensationDirectBytes += original.content.length;
        }
        const finalizedState = this.finalizedDirectStates.get(snapshot.absPath);
        if (
          this.finalized &&
          validateFinalized &&
          (!finalizedState || !fileStatesEqual(original, finalizedState))
        ) {
          clearFileState(original);
          errors.push(`${snapshot.displayPath}: changed while preparing the restore`);
          continue;
        }
        compensation.directSnapshots.set(snapshot.absPath, {
          absPath: snapshot.absPath,
          displayPath: snapshot.displayPath,
          original,
        });
      } catch (error) {
        errors.push(`${snapshot.displayPath}: ${errorMessage(error)}`);
      }
    }
    if (errors.length > 0) {
      await indexLock?.release();
      await compensation.dispose();
      return { restoredFiles: [], errors };
    }

    if (this.gitCheckpoint && currentGitTree) {
      const originalEntries = this.gitCheckpoint.tree.entries;
      const changedPaths = changedGitPaths(this.gitCheckpoint.tree, currentGitTree);
      const currentOnly = changedPaths
        .filter((path) => !originalEntries.has(path))
        .sort((a, b) => pathDepth(b) - pathDepth(a));

      for (const path of currentOnly) {
        const absPath = resolve(this.gitCheckpoint.root, path);
        if (!isPathWithin(this.gitCheckpoint.root, absPath)) {
          errors.push(`${path}: path escapes the Git worktree`);
          continue;
        }
        try {
          await removeNonDirectory(absPath);
          restored.add(displayPath(this.cwd, absPath));
        } catch (error) {
          errors.push(`${displayPath(this.cwd, absPath)}: ${errorMessage(error)}`);
        }
      }

      const pathsToRestore = changedPaths.filter((path) =>
        originalEntries.has(path),
      );
      try {
        const gitErrors = await restoreGitFiles(
          this.gitCheckpoint,
          pathsToRestore,
          signal,
        );
        for (const path of pathsToRestore) {
          const absPath = resolve(this.gitCheckpoint.root, path);
          const gitError = gitErrors.get(path);
          if (gitError) {
            errors.push(`${displayPath(this.cwd, absPath)}: ${gitError}`);
          } else {
            restored.add(displayPath(this.cwd, absPath));
          }
        }
      } catch (error) {
        errors.push(`Git worktree restore: ${errorMessage(error)}`);
      }
    }

    // Exact-path snapshots predate any later broad capture in the same turn, so
    // they must win when both mechanisms cover the same file.
    for (const snapshot of this.directSnapshots.values()) {
      try {
        if (await restoreFileState(snapshot)) restored.add(snapshot.displayPath);
      } catch (error) {
        errors.push(`${snapshot.displayPath}: ${errorMessage(error)}`);
      }
    }

    if (errors.length === 0 && indexLock && this.gitCheckpoint) {
      try {
        await indexLock.commit(this.gitCheckpoint.index);
      } catch (error) {
        errors.push(`Git index: ${errorMessage(error)}`);
      }
    } else {
      await indexLock?.release();
    }

    if (errors.length > 0 && transactional) {
      await indexLock?.release();
      const rollback = await compensation.restoreInternal(undefined, false);
      await compensation.dispose();
      return {
        restoredFiles: [],
        errors: [
          ...errors,
          ...rollback.errors.map((error) => `Rollback failed: ${error}`),
        ],
      };
    }

    if (errors.length > 0) {
      await compensation.dispose();
      return { restoredFiles: [...restored].sort(), errors };
    }

    if (!transactional) {
      await compensation.dispose();
      return { restoredFiles: [...restored].sort(), errors: [] };
    }

    const armErrors = await compensation.finalize();
    if (armErrors.length > 0) {
      const rollback = await compensation.restoreInternal(undefined, false, false);
      await compensation.dispose();
      return {
        restoredFiles: [],
        errors: [
          ...armErrors.map((error) => `Could not arm rollback: ${error}`),
          ...rollback.errors.map((error) => `Rollback failed: ${error}`),
        ],
      };
    }

    let compensationFinished = false;
    return {
      restoredFiles: [...restored].sort(),
      errors: [],
      rollback: async () => {
        if (compensationFinished) {
          return { restoredFiles: [], errors: ["rollback is no longer available"] };
        }
        compensationFinished = true;
        try {
          return await compensation.restoreInternal(undefined, false);
        } finally {
          await compensation.dispose();
        }
      },
      commit: async () => {
        if (compensationFinished) return;
        compensationFinished = true;
        await compensation.dispose();
      },
    };
  }
}
