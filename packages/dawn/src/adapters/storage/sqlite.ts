import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { closeSync, lstatSync, openSync } from "node:fs";
import { assertSubjectState } from "../../legacy/validation.ts";
import type { SubjectState } from "../../legacy/state.ts";
import type { LifecycleChange, StateChangeEvent, StateStore } from "../../runtime/state-store.ts";
import { transitionLifecycle } from "../../runtime/lifecycle-transition.ts";

const APPLICATION_ID = 0x4441574e; // DAWN
const DB_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function decodeSnapshot(value: unknown): SubjectState {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_SNAPSHOT_BYTES) {
    throw new Error("Invalid stored snapshot");
  }
  let state: unknown;
  try { state = JSON.parse(value); } catch { throw new Error("Invalid stored snapshot JSON"); }
  assertSubjectState(state);
  return state;
}

function encodeSnapshot(state: SubjectState): string {
  assertSubjectState(state);
  const encoded = JSON.stringify(state);
  const decoded = decodeSnapshot(encoded);
  if (!isDeepStrictEqual(state, decoded)) throw new Error("Snapshot is not losslessly JSON serializable");
  return encoded;
}

/** One subject per database. All writes use BEGIN IMMEDIATE + CAS; no autonomous work. */
export class SqliteStateStore implements StateStore {
  readonly #db: DatabaseSync;
  #closed = false;

  private constructor(db: DatabaseSync) { this.#db = db; }

  /** Explicit initialization only. Never overwrite or silently adopt an existing file. */
  static create(path: string, initial: SubjectState, signal: AbortSignal): SqliteStateStore {
    signal.throwIfAborted();
    assertSubjectState(initial);
    if (initial.revision !== 0) throw new Error("New database requires revision zero");
    const snapshot = encodeSnapshot(initial);
    // Parent directory must already exist. No implicit source-tree or home-directory writes.
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      db.exec(`
        CREATE TABLE subject_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          revision INTEGER NOT NULL CHECK(revision >= 0),
          snapshot TEXT NOT NULL
        ) STRICT;
        CREATE TABLE bootstrap (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          snapshot TEXT NOT NULL
        ) STRICT;
        CREATE TABLE lifecycle_events (
          revision INTEGER PRIMARY KEY CHECK(revision > 0),
          id TEXT NOT NULL UNIQUE,
          from_state TEXT NOT NULL CHECK(from_state IN ('sleeping', 'awake')),
          to_state TEXT NOT NULL CHECK(to_state IN ('sleeping', 'awake')),
          at TEXT NOT NULL,
          CHECK(from_state <> to_state)
        ) STRICT;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${DB_VERSION};
      `);
      db.prepare("INSERT INTO subject_state VALUES (1, 0, ?)").run(snapshot);
      db.prepare("INSERT INTO bootstrap VALUES (1, ?)").run(snapshot);
      signal.throwIfAborted();
      db.exec("COMMIT");
      return new SqliteStateStore(db);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      db.close();
      // A failed initialization is deliberately retained, not silently retried or replaced.
      throw error;
    }
  }

  /** Open an existing v1 database only; never initialize, reset, downgrade or auto-migrate it. */
  static open(path: string, signal: AbortSignal): SqliteStateStore {
    signal.throwIfAborted();
    if (!lstatSync(path).isFile()) throw new Error("Database must be a regular non-symlink file");
    const db = new DatabaseSync(path);
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const app = db.prepare("PRAGMA application_id").get()?.application_id;
      if (version !== DB_VERSION || app !== APPLICATION_ID) {
        throw new Error("Unsupported Dawn database identity or schema version; no migration performed");
      }
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
      const store = new SqliteStateStore(db);
      store.#transaction("BEGIN", () => store.#readValidated(), signal);
      return store;
    } catch (error) { db.close(); throw error; }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("State store is closed");
  }

  #transaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", work: () => T, signal: AbortSignal): T {
    this.#ensureOpen();
    signal.throwIfAborted();
    this.#db.exec(begin);
    try {
      signal.throwIfAborted();
      const result = work();
      signal.throwIfAborted();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  #readValidated(): SubjectState {
    const row = this.#db.prepare("SELECT revision, snapshot FROM subject_state WHERE singleton = 1").get();
    const bootstrap = this.#db.prepare("SELECT snapshot FROM bootstrap WHERE singleton = 1").get();
    if (!row || !bootstrap) throw new Error("Missing subject or bootstrap; refusing to reset database");
    const state = decodeSnapshot(row.snapshot);
    const initial = decodeSnapshot(bootstrap.snapshot);
    if (initial.revision !== 0 || state.revision !== row.revision ||
        state.self.identity.id !== initial.self.identity.id || Date.parse(state.updatedAt) < Date.parse(initial.updatedAt)) {
      throw new Error("Stored subject identity or revision mismatch");
    }
    // v1 only has lifecycle writes. Replaying the chain also verifies non-lifecycle
    // fields have not changed without a supported event. This is not tamper-proof storage.
    let replay = initial;
    for (const event of this.#db.prepare("SELECT revision, id, from_state, to_state, at FROM lifecycle_events ORDER BY revision").iterate()) {
      if (event.revision !== replay.revision + 1 || event.id !== `${initial.self.identity.id}:${event.revision}` ||
          event.from_state !== replay.lifecycle || typeof event.at !== "string" ||
          (event.to_state !== "awake" && event.to_state !== "sleeping")) {
        throw new Error("Invalid lifecycle event chain");
      }
      const next = transitionLifecycle(replay, { expectedRevision: replay.revision, lifecycle: event.to_state, at: event.at });
      if (!next.event) throw new Error("Unexpected no-op lifecycle event");
      replay = next.state;
    }
    if (!isDeepStrictEqual(replay, state)) throw new Error("Snapshot and event history mismatch");
    return state;
  }

  async read(signal: AbortSignal): Promise<SubjectState> {
    return this.#transaction("BEGIN", () => this.#readValidated(), signal);
  }

  async changeLifecycle(change: LifecycleChange, signal: AbortSignal): Promise<SubjectState> {
    return this.#transaction("BEGIN IMMEDIATE", () => {
      const current = this.#readValidated();
      const next = transitionLifecycle(current, change);
      if (!next.event) return current;
      const snapshot = encodeSnapshot(next.state);
      const updated = this.#db.prepare("UPDATE subject_state SET revision = ?, snapshot = ? WHERE singleton = 1 AND revision = ?")
        .run(next.state.revision, snapshot, current.revision);
      if (updated.changes !== 1) throw new Error("State update failed");
      const e = next.event;
      this.#db.prepare("INSERT INTO lifecycle_events (revision, id, from_state, to_state, at) VALUES (?, ?, ?, ?, ?)")
        .run(e.revision, e.id, e.from, e.to, e.at);
      return next.state;
    }, signal);
  }

  /** Bounded diagnostic history; not long-term memory. */
  async events(afterRevision: number, limit: number, signal: AbortSignal): Promise<readonly StateChangeEvent[]> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Invalid event pagination");
    }
    return this.#transaction("BEGIN", () => {
      this.#readValidated();
      const rows = this.#db.prepare("SELECT revision, id, from_state, to_state, at FROM lifecycle_events WHERE revision > ? ORDER BY revision LIMIT ?")
        .all(afterRevision, limit);
      return rows.map(row => {
        if (typeof row.revision !== "number" || typeof row.id !== "string" || typeof row.at !== "string" ||
            (row.from_state !== "awake" && row.from_state !== "sleeping") ||
            (row.to_state !== "awake" && row.to_state !== "sleeping")) throw new Error("Invalid event row");
        return { id: row.id, type: "lifecycle_changed", revision: row.revision, from: row.from_state, to: row.to_state, at: row.at };
      });
    }, signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
