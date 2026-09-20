import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, parse, resolve } from "node:path";

function failure(code) {
  const error = new Error(`Snapshot storage: ${code}.`);
  error.code = code;
  return error;
}

function regularFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure("UNSAFE_PATH");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function directory(path, create = false) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("UNSAFE_PATH");
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * One synchronous, process-locked JSON snapshot. Call close() on shutdown.
 * load() returns undefined only for a missing file; all JSON values, including
 * null, are returned unchanged for the caller's schema validation.
 */
export class SnapshotFile {
  #path;
  #lock;
  #marker;
  #lockStat;
  #closed = false;
  #loadFailed = false;

  constructor(path) {
    this.#path = resolve(path);
    this.#lock = `${this.#path}.lock`;
    try {
      directory(dirname(this.#path), true);
      regularFile(this.#path);
      this.#acquire();
    } catch {
      throw failure("OPEN_FAILED");
    }
  }

  #acquire() {
    // A unique marker makes concurrent stale-lock recovery safe: a contender
    // only removes the exact dead owner's marker, never a new owner's marker.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        mkdirSync(this.#lock, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        directory(this.#lock);
        const entries = readdirSync(this.#lock);
        if (entries.length !== 1) throw failure("LOCKED");
        const match = /^([1-9]\d*)-[0-9a-f-]{36}$/.exec(entries[0]);
        if (!match) throw failure("LOCKED");
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid)) throw failure("LOCKED");
        try {
          process.kill(pid, 0);
          throw failure("LOCKED");
        } catch (aliveError) {
          if (aliveError.code !== "ESRCH") throw failure("LOCKED");
        }
        const staleMarker = join(this.#lock, entries[0]);
        if (!regularFile(staleMarker)) continue;
        try {
          unlinkSync(staleMarker);
        } catch (unlinkError) {
          if (unlinkError.code === "ENOENT") continue;
          throw unlinkError;
        }
        try {
          rmdirSync(this.#lock);
        } catch (removeError) {
          if (removeError.code !== "ENOENT") throw removeError;
        }
        continue;
      }
      this.#lockStat = lstatSync(this.#lock);
      this.#marker = join(this.#lock, `${process.pid}-${randomUUID()}`);
      let fd;
      try {
        fd = openSync(
          this.#marker,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        fsyncSync(fd);
        if (!sameFile(this.#lockStat, lstatSync(this.#lock)))
          throw failure("LOCKED");
        return;
      } catch (error) {
        this.close();
        throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    throw failure("LOCKED");
  }

  #check() {
    if (this.#closed || this.#loadFailed) throw failure("UNAVAILABLE");
    directory(dirname(this.#path));
    directory(this.#lock);
    if (
      !sameFile(this.#lockStat, lstatSync(this.#lock)) ||
      !regularFile(this.#marker)
    )
      throw failure("LOCK_LOST");
    regularFile(this.#path);
  }

  load() {
    let fd;
    try {
      this.#check();
      try {
        fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
      if (!fstatSync(fd).isFile()) throw failure("UNSAFE_PATH");
      return JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      this.#loadFailed = true;
      throw failure("LOAD_FAILED");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  save(value) {
    let fd;
    let temp;
    let committed = false;
    try {
      this.#check();
      const json = JSON.stringify(value);
      if (json === undefined) throw failure("INVALID_JSON");
      temp = join(
        dirname(this.#path),
        `.${basename(this.#path)}.${randomUUID()}.tmp`,
      );
      fd = openSync(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      fchmodSync(fd, 0o600);
      writeFileSync(fd, json, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.#check();
      renameSync(temp, this.#path);
      committed = true;
      temp = undefined;
      // Persist the rename as well as the content before acknowledging success.
      fd = openSync(dirname(this.#path), constants.O_RDONLY);
      fsyncSync(fd);
    } catch {
      // Once rename succeeds, the old snapshot cannot safely be restored.
      // The caller must stop accepting mutations on this uncertain outcome.
      if (committed) this.#loadFailed = true;
      const error = failure(committed ? "COMMIT_UNCERTAIN" : "SAVE_FAILED");
      error.committed = committed;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (temp !== undefined) {
        try {
          unlinkSync(temp);
        } catch {
          // Never delete anything other than this save's uniquely named temp.
        }
      }
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#marker) return;
    try {
      directory(this.#lock);
      if (!sameFile(this.#lockStat, lstatSync(this.#lock))) return;
      unlinkSync(this.#marker);
      rmdirSync(this.#lock);
    } catch {
      // Lost or externally changed locks are not ours to remove.
    }
  }
}
