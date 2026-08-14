import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";

let checkpointDirectoriesBeforeTest = new Set<string>();
beforeEach(async () => {
  checkpointDirectoriesBeforeTest = await checkpointTempDirectories();
});
afterEach(async () => {
  const after = await checkpointTempDirectories();
  await Promise.all(
    [...after]
      .filter((path) => !checkpointDirectoriesBeforeTest.has(path))
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
import { pathToFileURL } from "node:url";
import { TurnCheckpoint } from "./turn-checkpoint.ts";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-undo-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("restores edited and newly created files outside Git", async () => {
  await withTempDir(async (directory) => {
    const existing = join(directory, "existing.txt");
    const created = join(directory, "new", "created.txt");
    await writeFile(existing, "before\n");

    const checkpoint = await TurnCheckpoint.create(directory);
    assert.equal(checkpoint.gitCoverage.status, "not-requested");
    await checkpoint.captureFile(existing);
    await checkpoint.captureFile("new/created.txt");

    await writeFile(existing, "after\n");
    await mkdir(join(directory, "new"), { recursive: true });
    await writeFile(created, "created\n");
    assert.deepEqual(await checkpoint.finalize(), []);

    const result = await checkpoint.restore();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.restoredFiles, ["existing.txt", "new/created.txt"]);
    assert.equal(await readFile(existing, "utf8"), "before\n");
    await assert.rejects(readFile(created), { code: "ENOENT" });
    await assert.rejects(readFile(join(directory, "new")), { code: "ENOENT" });
  });
});

test("keeps the first snapshot when a file is captured more than once", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    await writeFile(file, "original");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(file);
    await writeFile(file, "intermediate");
    await checkpoint.captureFile(file);
    await writeFile(file, "final");

    const result = await checkpoint.restore();
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(file, "utf8"), "original");
  });
});

test("normalizes path aliases and keeps one original baseline", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    await writeFile(file, "original");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(`@${file}`);
    await writeFile(file, "intermediate");
    await checkpoint.captureFile(pathToFileURL(file).href);
    await writeFile(file, "final");

    const result = await checkpoint.restore();
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(file, "utf8"), "original");
  });
});

test("normalizes aliases through a symlinked parent before a new file exists", async () => {
  await withTempDir(async (directory) => {
    const targetDirectory = join(directory, "target");
    const aliasDirectory = join(directory, "alias");
    const targetFile = join(targetDirectory, "new.txt");
    await mkdir(targetDirectory);
    await symlink(targetDirectory, aliasDirectory);

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(join(aliasDirectory, "new.txt"));
    await writeFile(targetFile, "intermediate");
    await checkpoint.captureFile(targetFile);
    await writeFile(targetFile, "final");

    const result = await checkpoint.restore();
    assert.deepEqual(result.errors, []);
    await assert.rejects(readFile(targetFile), { code: "ENOENT" });
  });
});

test("does not overwrite changes made after the turn settled", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    await writeFile(file, "original");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(file);
    await writeFile(file, "turn result");
    assert.deepEqual(await checkpoint.finalize(), []);
    await writeFile(file, "external change");

    const result = await checkpoint.restore();
    assert.match(result.errors.join("\n"), /changed after the turn settled/);
    assert.equal(await readFile(file, "utf8"), "external change");
  });
});

test("can compensate a successful restore when conversation navigation fails", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    await writeFile(file, "original");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(file);
    await writeFile(file, "turn result");
    assert.deepEqual(await checkpoint.finalize(), []);

    const result = await checkpoint.restore();
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(file, "utf8"), "original");
    assert.ok(result.rollback);

    const rollback = await result.rollback();
    assert.deepEqual(rollback.errors, []);
    assert.equal(await readFile(file, "utf8"), "turn result");
  });
});

test("supports restoring consecutive turn checkpoints", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    await writeFile(file, "state 0");

    const first = await TurnCheckpoint.create(directory);
    await first.captureFile(file);
    await writeFile(file, "state 1");
    assert.deepEqual(await first.finalize(), []);

    const second = await TurnCheckpoint.create(directory);
    await second.captureFile(file);
    await writeFile(file, "state 2");
    assert.deepEqual(await second.finalize(), []);

    const secondUndo = await second.restore();
    assert.deepEqual(secondUndo.errors, []);
    assert.equal(await readFile(file, "utf8"), "state 1");

    assert.deepEqual(await first.finalize(), []);
    const firstUndo = await first.restore();
    assert.deepEqual(firstUndo.errors, []);
    assert.equal(await readFile(file, "utf8"), "state 0");
  });
});

test("older checkpoints reject manual changes made between turns", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    const secondTurnFile = join(directory, "second.txt");
    await writeFile(file, "state 0");
    await writeFile(secondTurnFile, "second 0");

    const first = await TurnCheckpoint.create(directory);
    await first.captureFile(file);
    await writeFile(file, "state 1");
    assert.deepEqual(await first.finalize(), []);

    await writeFile(file, "manual between turns");
    const second = await TurnCheckpoint.create(directory);
    await second.captureFile(secondTurnFile);
    await writeFile(secondTurnFile, "second 1");
    assert.deepEqual(await second.finalize(), []);

    const secondUndo = await second.restore();
    assert.deepEqual(secondUndo.errors, []);
    assert.equal(await readFile(file, "utf8"), "manual between turns");

    const firstUndo = await first.restore();
    assert.match(firstUndo.errors.join("\n"), /changed after the turn settled/);
    assert.equal(await readFile(file, "utf8"), "manual between turns");
  });
});

test("does not report unchanged snapshots as restored", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    await writeFile(file, "unchanged");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(file);

    const result = await checkpoint.restore();
    assert.deepEqual(result.restoredFiles, []);
    assert.deepEqual(result.errors, []);
  });
});

test("Git checkpoint restores bash-like changes without altering pre-existing work", async () => {
  await withTempDir(async (directory) => {
    git(directory, "init", "-q");
    git(directory, "config", "user.email", "undo@example.test");
    git(directory, "config", "user.name", "Undo Test");

    await writeFile(join(directory, "tracked.txt"), "tracked base\n");
    await writeFile(join(directory, "dirty.txt"), "dirty base\n");
    await writeFile(join(directory, "deleted.txt"), "delete base\n");
    await writeFile(join(directory, "staged.txt"), "staged base\n");
    await writeFile(join(directory, ".gitignore"), "ignored.txt\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");

    await writeFile(join(directory, "dirty.txt"), "pre-existing dirty\n");
    await writeFile(join(directory, "staged.txt"), "pre-existing staged\n");
    git(directory, "add", "staged.txt");
    await writeFile(join(directory, "untracked.txt"), "pre-existing untracked\n");
    const statusBefore = git(directory, "status", "--short");
    const stagedBefore = git(directory, "diff", "--cached", "--binary");

    const checkpoint = await TurnCheckpoint.create(directory);
    assert.equal(checkpoint.gitCoverage.status, "not-requested");
    await checkpoint.capture();
    assert.deepEqual(checkpoint.gitCoverage, {
      status: "available",
      root: await realpath(directory),
    });

    await writeFile(join(directory, "tracked.txt"), "turn change\n");
    await writeFile(join(directory, "dirty.txt"), "turn changed dirty\n");
    await writeFile(join(directory, "staged.txt"), "turn changed staged\n");
    await writeFile(join(directory, "untracked.txt"), "turn changed untracked\n");
    await rm(join(directory, "deleted.txt"));
    await writeFile(join(directory, "created.txt"), "turn created\n");
    await chmod(join(directory, "tracked.txt"), 0o755);
    assert.deepEqual(await checkpoint.finalize(), []);

    const result = await checkpoint.restore();

    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(join(directory, "tracked.txt"), "utf8"), "tracked base\n");
    assert.equal(await readFile(join(directory, "dirty.txt"), "utf8"), "pre-existing dirty\n");
    assert.equal(await readFile(join(directory, "staged.txt"), "utf8"), "pre-existing staged\n");
    assert.equal(await readFile(join(directory, "untracked.txt"), "utf8"), "pre-existing untracked\n");
    assert.equal(await readFile(join(directory, "deleted.txt"), "utf8"), "delete base\n");
    await assert.rejects(readFile(join(directory, "created.txt")), { code: "ENOENT" });
    assert.equal(git(directory, "status", "--short"), statusBefore);
    assert.equal(git(directory, "diff", "--cached", "--binary"), stagedBefore);
  });
});

test("Git checkpoint restores index-only changes and compensation puts them back", async () => {
  await withTempDir(async (directory) => {
    git(directory, "init", "-q");
    git(directory, "config", "user.email", "undo@example.test");
    git(directory, "config", "user.name", "Undo Test");
    await writeFile(join(directory, "file.txt"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");

    await writeFile(join(directory, "file.txt"), "pre-existing dirty\n");
    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    git(directory, "add", "file.txt");
    const turnIndex = git(directory, "diff", "--cached", "--binary");
    assert.notEqual(turnIndex, "");
    assert.deepEqual(await checkpoint.finalize(), []);

    const result = await checkpoint.restore();
    assert.deepEqual(result.errors, []);
    assert.equal(git(directory, "diff", "--cached", "--binary"), "");
    assert.equal(await readFile(join(directory, "file.txt"), "utf8"), "pre-existing dirty\n");

    assert.ok(result.rollback);
    const rollback = await result.rollback();
    assert.deepEqual(rollback.errors, []);
    assert.equal(git(directory, "diff", "--cached", "--binary"), turnIndex);
  });
});

test("does not overwrite Git index changes made after the turn settled", async () => {
  await withTempDir(async (directory) => {
    git(directory, "init", "-q");
    git(directory, "config", "user.email", "undo@example.test");
    git(directory, "config", "user.name", "Undo Test");
    await writeFile(join(directory, "file.txt"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    assert.deepEqual(await checkpoint.finalize(), []);
    await writeFile(join(directory, "file.txt"), "external\n");
    git(directory, "add", "file.txt");

    const result = await checkpoint.restore();
    assert.match(result.errors.join("\n"), /Git index changed after the turn settled/);
    assert.notEqual(git(directory, "diff", "--cached", "--binary"), "");
  });
});

test("treats absent and empty Git indexes as the same staged state", async () => {
  await withTempDir(async (directory) => {
    git(directory, "init", "-q");
    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    assert.deepEqual(await checkpoint.finalize(), []);

    git(directory, "read-tree", "--empty");
    const result = await checkpoint.restore();

    assert.doesNotMatch(result.errors.join("\n"), /Git index changed/);
    assert.deepEqual(result.errors, []);
  });
});

test("direct snapshots restore ignored files that Git does not cover", async () => {
  await withTempDir(async (directory) => {
    git(directory, "init", "-q");
    git(directory, "config", "user.email", "undo@example.test");
    git(directory, "config", "user.name", "Undo Test");
    await writeFile(join(directory, ".gitignore"), "ignored.txt\n");
    git(directory, "add", ".gitignore");
    git(directory, "commit", "-qm", "base");

    const ignored = join(directory, "ignored.txt");
    await writeFile(ignored, "before\n");
    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(ignored);
    await writeFile(ignored, "after\n");
    assert.deepEqual(await checkpoint.finalize(), []);

    const result = await checkpoint.restore();
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(ignored, "utf8"), "before\n");
  });
});

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(current, entry.name), relativePath);
      else files.push(relativePath);
    }
  }
  await visit(directory, "");
  return files.sort();
}

async function checkpointTempDirectories(): Promise<Set<string>> {
  return new Set(
    (await readdir(tmpdir()))
      .filter((name) => name.startsWith(`pi-undo-checkpoint-${process.pid}-`))
      .map((name) => join(tmpdir(), name)),
  );
}

function initializeRepository(directory: string): void {
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "undo@example.test");
  git(directory, "config", "user.name", "Undo Test");
}

test("broad snapshots do not add objects to the repository object database", async () => {
  await withTempDir(async (directory) => {
    initializeRepository(directory);
    await writeFile(join(directory, "file.txt"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");
    const objectDirectory = git(
      directory,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ).trim();
    const objectsBefore = await listFiles(objectDirectory);

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    await writeFile(join(directory, "file.txt"), "turn\n");
    await writeFile(join(directory, "created.txt"), "created\n");
    assert.deepEqual(await checkpoint.finalize(), []);
    assert.deepEqual((await checkpoint.restore()).errors, []);
    await checkpoint.dispose();

    assert.deepEqual(await listFiles(objectDirectory), objectsBefore);
  });
});

test("a pre-existing canonical index lock makes restore fail without mutation", async () => {
  await withTempDir(async (directory) => {
    initializeRepository(directory);
    const file = join(directory, "file.txt");
    await writeFile(file, "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    await writeFile(file, "turn\n");
    git(directory, "add", "file.txt");
    assert.deepEqual(await checkpoint.finalize(), []);
    const indexPath = git(
      directory,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ).trim();
    const lockPath = `${indexPath}.lock`;
    await writeFile(lockPath, "someone else's lock\n");
    const statusBefore = git(directory, "status", "--short");

    const result = await checkpoint.restore();

    assert.match(result.errors.join("\n"), /index is locked/);
    assert.equal(await readFile(file, "utf8"), "turn\n");
    assert.equal(git(directory, "status", "--short"), statusBefore);
    assert.equal(await readFile(lockPath, "utf8"), "someone else's lock\n");
  });
});

test("semantic index flag changes after finalization are conflicts", async () => {
  for (const flag of ["assume-unchanged", "skip-worktree"] as const) {
    await withTempDir(async (directory) => {
      initializeRepository(directory);
      await writeFile(join(directory, "file.txt"), "base\n");
      git(directory, "add", ".");
      git(directory, "commit", "-qm", "base");

      const checkpoint = await TurnCheckpoint.create(directory);
      await checkpoint.capture();
      git(directory, "update-index", `--${flag}`, "file.txt");
      assert.deepEqual(await checkpoint.finalize(), []);
      git(directory, "update-index", `--no-${flag}`, "file.txt");

      const result = await checkpoint.restore();
      assert.match(
        result.errors.join("\n"),
        /Git index changed after the turn settled/,
        flag,
      );
    });
  }

  await withTempDir(async (directory) => {
    initializeRepository(directory);
    await writeFile(join(directory, "file.txt"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    await writeFile(join(directory, "intent.txt"), "intent\n");
    git(directory, "add", "--intent-to-add", "intent.txt");
    assert.deepEqual(await checkpoint.finalize(), []);
    git(directory, "reset", "-q", "--", "intent.txt");

    const result = await checkpoint.restore();
    assert.match(
      result.errors.join("\n"),
      /Git index changed after the turn settled/,
    );
  });
});

test("intent-to-add and fully staged empty files have different semantic index state", async () => {
  await withTempDir(async (directory) => {
    initializeRepository(directory);
    const file = join(directory, "empty.txt");
    await writeFile(file, "");
    git(directory, "add", "--intent-to-add", "empty.txt");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    assert.deepEqual(await checkpoint.finalize(), []);
    git(directory, "add", "empty.txt");

    const result = await checkpoint.restore();
    assert.match(
      result.errors.join("\n"),
      /Git index changed after the turn settled/,
    );
  });
});

test("rollback refuses to overwrite changes made after a restore", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "file.txt");
    await writeFile(file, "before\n");
    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.captureFile(file);
    await writeFile(file, "turn\n");
    assert.deepEqual(await checkpoint.finalize(), []);

    const restored = await checkpoint.restore();
    assert.deepEqual(restored.errors, []);
    await writeFile(file, "navigation-time change\n");
    const rollback = await restored.rollback!();

    assert.match(rollback.errors.join("\n"), /changed after the turn settled/);
    assert.equal(await readFile(file, "utf8"), "navigation-time change\n");
  });
});

test("broad restore accepts a valid path whose name begins with two dots", async () => {
  await withTempDir(async (directory) => {
    initializeRepository(directory);
    const file = join(directory, "..valid.txt");
    await writeFile(file, "before\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    await writeFile(file, "after\n");
    assert.deepEqual(await checkpoint.finalize(), []);
    const result = await checkpoint.restore();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.restoredFiles, ["..valid.txt"]);
    assert.equal(await readFile(file, "utf8"), "before\n");
  });
});

test("dispose removes isolated object storage and invalidates the checkpoint", async () => {
  await withTempDir(async (directory) => {
    initializeRepository(directory);
    await writeFile(join(directory, "file.txt"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "base");
    const before = await checkpointTempDirectories();

    const checkpoint = await TurnCheckpoint.create(directory);
    await checkpoint.capture();
    const during = await checkpointTempDirectories();
    const created = [...during].filter((path) => !before.has(path));
    assert.equal(created.length, 1);

    await checkpoint.dispose();

    await assert.rejects(stat(created[0]), { code: "ENOENT" });
    await assert.rejects(checkpoint.restore(), /disposed/);
  });
});

test("direct snapshots reject oversized files before mutation", async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, "large.bin");
    await writeFile(file, "");
    await truncate(file, 64 * 1024 * 1024 + 1);
    const checkpoint = await TurnCheckpoint.create(directory);

    await assert.rejects(checkpoint.captureFile(file), /limited to/);
  });
});
