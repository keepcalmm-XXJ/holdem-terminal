import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SnapshotFile } from "../server/storage.mjs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

function setup(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "holdem-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("snapshot saves atomically, reloads and uses private permissions", (t) => {
  const root = setup(t);
  const path = join(root, "private", "state.json");
  const storage = new SnapshotFile(path);
  t.after(() => storage.close());
  assert.equal(storage.load(), undefined);
  storage.save({ version: 1, secret: "private-token", rooms: [] });
  assert.equal(statSync(join(root, "private")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  storage.save({ version: 2 });
  assert.deepEqual(storage.load(), { version: 2 });
  assert.deepEqual(readdirSync(join(root, "private")).sort(), [
    "state.json",
    "state.json.lock",
  ]);
  storage.close();
  const reopened = new SnapshotFile(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.load(), { version: 2 });
});

test("missing snapshot is distinct from every valid falsy JSON value", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const storage = new SnapshotFile(path);
  t.after(() => storage.close());
  assert.equal(storage.load(), undefined);
  for (const value of [null, false, 0, ""]) {
    storage.save(value);
    assert.equal(storage.load(), value);
  }
});

test("corrupt snapshots fail closed and never expose private content", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const secret = 'not-json "private-secret-token"';
  writeFileSync(path, secret);
  const storage = new SnapshotFile(path);
  t.after(() => storage.close());
  assert.throws(
    () => storage.load(),
    (error) =>
      error.code === "LOAD_FAILED" &&
      !String(error).includes("private-secret-token"),
  );
  assert.throws(() => storage.save({ reset: true }), { code: "SAVE_FAILED" });
  assert.equal(readFileSync(path, "utf8"), secret);
});

test("failed serialization preserves the committed snapshot without temp files", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const storage = new SnapshotFile(path);
  t.after(() => storage.close());
  storage.save({ committed: true });
  assert.throws(
    () =>
      storage.save({
        toJSON() {
          throw new Error("private-secret-token");
        },
      }),
    (error) =>
      error.code === "SAVE_FAILED" &&
      !String(error).includes("private-secret-token"),
  );
  assert.deepEqual(storage.load(), { committed: true });
  assert.deepEqual(readdirSync(root).sort(), ["state.json", "state.json.lock"]);
});

test("pre-rename disk failure preserves old snapshot and removes the temp", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const storage = new SnapshotFile(path);
  t.after(() => storage.close());
  storage.save({ committed: true });
  const original = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", () => {
    throw new Error("private-disk-details");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => storage.save({ committed: false }),
      (error) =>
        error.code === "SAVE_FAILED" &&
        error.committed === false &&
        !String(error).includes("private-disk-details"),
    );
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(storage.load(), { committed: true });
  assert.deepEqual(readdirSync(root).sort(), ["state.json", "state.json.lock"]);
});

test("post-rename sync failure is explicitly uncertain and blocks further writes", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const storage = new SnapshotFile(path);
  t.after(() => storage.close());
  storage.save({ version: 1 });
  const original = fs.fsyncSync;
  let syncs = 0;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (++syncs === 2) throw new Error("disk failure");
    return original(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => storage.save({ version: 2 }), {
      code: "COMMIT_UNCERTAIN",
      committed: true,
    });
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 2 });
  assert.throws(() => storage.save({ version: 3 }), { code: "SAVE_FAILED" });
});

test("snapshot rejects symlink files, directories and symlink ancestors", (t) => {
  const root = setup(t);
  const target = join(root, "target.json");
  writeFileSync(target, '{"untouched":true}');
  const link = join(root, "link.json");
  symlinkSync(target, link);
  assert.throws(() => new SnapshotFile(link), { code: "OPEN_FAILED" });
  const dir = join(root, "directory");
  mkdirSync(dir);
  assert.throws(() => new SnapshotFile(dir), { code: "OPEN_FAILED" });
  const linkedDir = join(root, "linked");
  symlinkSync(dir, linkedDir);
  assert.throws(() => new SnapshotFile(join(linkedDir, "state.json")), {
    code: "OPEN_FAILED",
  });
  assert.equal(readFileSync(target, "utf8"), '{"untouched":true}');
});

test("a substituted target is rejected without overwriting its destination", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const target = join(root, "target.json");
  const storage = new SnapshotFile(path);
  t.after(() => storage.close());
  storage.save({ first: true });
  writeFileSync(target, '{"untouched":true}');
  rmSync(path);
  symlinkSync(target, path);
  assert.throws(() => storage.save({ overwritten: true }), {
    code: "SAVE_FAILED",
  });
  assert.equal(readFileSync(target, "utf8"), '{"untouched":true}');
});

test("exclusive lifetime lock rejects a second writer and releases on close", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const first = new SnapshotFile(path);
  t.after(() => first.close());
  assert.throws(() => new SnapshotFile(path), { code: "OPEN_FAILED" });
  first.save({ retained: true });
  first.close();
  first.close();
  assert.throws(() => first.save({ bad: true }), { code: "SAVE_FAILED" });
  const second = new SnapshotFile(path);
  t.after(() => second.close());
  assert.deepEqual(second.load(), { retained: true });
});

test("lock from a demonstrably exited process is recovered after crash", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  const moduleUrl = new URL("../server/storage.mjs", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { SnapshotFile } from ${JSON.stringify(moduleUrl)};
       const storage = new SnapshotFile(process.argv[1]);
       storage.save({ beforeCrash: true });`,
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.ok(existsSync(`${path}.lock`));
  const recovered = new SnapshotFile(path);
  t.after(() => recovered.close());
  assert.deepEqual(recovered.load(), { beforeCrash: true });
  recovered.save({ afterCrash: true });
});

test("ambiguous or symlink locks fail closed", (t) => {
  const root = setup(t);
  const path = join(root, "state.json");
  mkdirSync(`${path}.lock`);
  assert.throws(() => new SnapshotFile(path), { code: "OPEN_FAILED" });
  rmSync(`${path}.lock`, { recursive: true });
  const other = join(root, "other");
  mkdirSync(other);
  symlinkSync(other, `${path}.lock`);
  assert.throws(() => new SnapshotFile(path), { code: "OPEN_FAILED" });
});
