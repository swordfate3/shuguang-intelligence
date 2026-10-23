import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertData, id, integer, object, timestamp } from "../../core/guards.ts";
import { assertSearchGrant, type SearchAttempt, type SearchGrant, type SearchTaskStatus, type SearchTaskStore } from "../../runtime/search-task.ts";
import { parseSearchJson } from "../../runtime/search-config.ts";
import { assertSearchResult, type SearchResult } from "../search/port.ts";

const APPLICATION_ID = 0x44535231; // DSR1: independent of every subject database format.
const VERSION = 1;
const SCHEMA = [
  `CREATE TABLE binding (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), subjectId TEXT NOT NULL, scopeId TEXT NOT NULL, grantJSON TEXT NOT NULL) STRICT`,
  `CREATE TABLE control (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), stopped INTEGER NOT NULL CHECK(stopped IN (0, 1))) STRICT`,
  `CREATE TABLE attempts (sequence INTEGER PRIMARY KEY, queryId TEXT NOT NULL UNIQUE, expectedRevision INTEGER NOT NULL CHECK(expectedRevision >= 0), status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')), resultJSON TEXT, reservedAt TEXT NOT NULL, at TEXT, CHECK((status = 'completed' AND resultJSON IS NOT NULL AND at IS NOT NULL) OR (status IN ('pending', 'failed') AND resultJSON IS NULL AND at IS NULL))) STRICT`,
  `CREATE TRIGGER immutable_binding_update BEFORE UPDATE ON binding BEGIN SELECT RAISE(ABORT, 'Immutable search binding'); END`,
  `CREATE TRIGGER immutable_binding_delete BEFORE DELETE ON binding BEGIN SELECT RAISE(ABORT, 'Immutable search binding'); END`,
  `CREATE TRIGGER irreversible_stop BEFORE UPDATE ON control WHEN OLD.stopped = 1 AND NEW.stopped <> 1 BEGIN SELECT RAISE(ABORT, 'Search stop is irreversible'); END`,
] as const;

function assertResult(value: unknown): asserts value is SearchResult {
  assertData(value);
  assertSearchResult(value);
}
function assertAttempt(value: unknown): asserts value is SearchAttempt {
  assertData(value);
  const attempt = object(value, ["sequence", "queryId", "expectedRevision", "status", "result"]);
  integer(attempt.sequence, 1, 10); id(attempt.queryId); integer(attempt.expectedRevision);
  if (attempt.status === "completed") assertResult(attempt.result);
  else if (!["pending", "failed"].includes(attempt.status as string) || attempt.result !== null) throw new Error("Invalid search attempt");
}
function encode(value: unknown): string {
  assertData(value);
  // Data-only detached copies never execute a caller-supplied toJSON method.
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return Object.setPrototypeOf(v.map(copy), null);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(v)) result[key] = copy(Object.getOwnPropertyDescriptor(v, key)!.value);
    return result;
  };
  const json = JSON.stringify(copy(value));
  if (Buffer.byteLength(json, "utf8") > 64_000) throw new Error("Search JSON too large");
  return json;
}

/** All ancestors must be real directories; only the immediate, owner-only parent may contain data. */
function privatePath(path: string): void {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw new Error("Explicit absolute search database path required");
  const parent = dirname(path), root = parse(parent).root;
  let current = parent;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Search database ancestors must not be symlinks");
    if (current === parent) {
      const uid = process.getuid?.();
      if (uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
        throw new Error("Private owner-only search database parent required");
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  // SQLite must not follow a preplanted journal/WAL path. Fail closed on crash debris as well.
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { lstatSync(path + suffix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Unexpected search SQLite sidecar");
  }
}
function privateFile(fd: number): Stats {
  const stat = fstatSync(fd), uid = process.getuid?.();
  if (!stat.isFile() || stat.nlink !== 1 || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Private owner0600 search database required");
  }
  return stat;
}

/** A bounded, independently identified search ledger. Never opens or migrates a subject database. */
export class SqliteSearchStore implements SearchTaskStore {
  readonly #db: DatabaseSync;
  readonly #binding: string;
  #closed = false;

  private constructor(db: DatabaseSync, signal: AbortSignal) {
    this.#db = db;
    this.#binding = "";
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#read();
      this.#binding = encode(this.#db.prepare("SELECT * FROM binding").all());
      signal.throwIfAborted(); db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  static create(path: string, subjectId: string, scopeId: string, grant: SearchGrant, signal: AbortSignal): SqliteSearchStore {
    signal.throwIfAborted(); id(subjectId); id(scopeId); assertSearchGrant(grant);
    const grantJSON = encode(grant);
    privatePath(path);
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let db: DatabaseSync | undefined;
    try {
      const stat = privateFile(fd);
      db = new DatabaseSync(path);
      this.#sameFile(path, stat);
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      try {
        for (const sql of SCHEMA) db.exec(sql);
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${VERSION};`);
        db.prepare("INSERT INTO binding VALUES (1, ?, ?, ?)").run(subjectId, scopeId, grantJSON);
        db.prepare("INSERT INTO control VALUES (1, 0)").run();
        signal.throwIfAborted(); db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return new SqliteSearchStore(db, signal);
    } catch (error) { db?.close(); throw error; }
    finally { closeSync(fd); }
    // A failed exclusive creation is deliberately retained, never deleted or overwritten.
  }

  static open(path: string, signal: AbortSignal): SqliteSearchStore {
    signal.throwIfAborted(); privatePath(path);
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("Search database must be a regular file, not a symlink");
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let db: DatabaseSync | undefined;
    try {
      const stat = privateFile(fd);
      if (before.dev !== stat.dev || before.ino !== stat.ino) throw new Error("Search database path changed");
      if (stat.size > 1024 * 1024) throw new Error("Search database too large");
      db = new DatabaseSync(path);
      this.#sameFile(path, stat);
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
      signal.throwIfAborted();
      const store = new SqliteSearchStore(db, signal);
      return store;
    } catch (error) { db?.close(); throw error; }
    finally { closeSync(fd); }
  }

  static #sameFile(path: string, stat: Stats): void {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Search database path changed");
  }
  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
  #ready(signal: AbortSignal): void { signal.throwIfAborted(); if (this.#closed) throw new Error("Search store closed"); }

  #metadata(): void {
    if (this.#db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
        this.#db.prepare("PRAGMA user_version").get()?.user_version !== VERSION) throw new Error("Unexpected search SQLite metadata");
    const schema = this.#db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY sql").all().map(row => row.sql);
    if (!isDeepStrictEqual(schema, [...SCHEMA].sort())) throw new Error("Unexpected search SQLite schema");
  }

  #read(): SearchTaskStatus {
    this.#metadata();
    const bindings = this.#db.prepare("SELECT * FROM binding").all();
    if (bindings.length !== 1 || bindings[0]!.singleton !== 1) throw new Error("Invalid search binding");
    if (this.#binding && encode(bindings) !== this.#binding) throw new Error("Search binding changed");
    const { subjectId, scopeId, grantJSON } = bindings[0]!;
    id(subjectId); id(scopeId);
    if (typeof grantJSON !== "string") throw new Error("Invalid search grant JSON");
    const grant = parseSearchJson(grantJSON); assertSearchGrant(grant);
    const controls = this.#db.prepare("SELECT * FROM control").all();
    if (controls.length !== 1 || controls[0]!.singleton !== 1 || ![0, 1].includes(controls[0]!.stopped as number)) throw new Error("Invalid search control");
    const rows = this.#db.prepare("SELECT * FROM attempts ORDER BY sequence").all();
    if (rows.length > grant.limit || rows.length > grant.queries.length) throw new Error("Search budget exceeded");
    const attempts: SearchAttempt[] = [], used = new Set<string>();
    let terminal = false;
    for (const row of rows) {
      if (terminal || row.sequence !== attempts.length + 1) throw new Error("Invalid search attempt order");
      const { sequence, queryId, expectedRevision, status, resultJSON, reservedAt, at } = row;
      integer(sequence, 1, 10); id(queryId); integer(expectedRevision); timestamp(reservedAt);
      if (reservedAt >= grant.expiresAt || !grant.queries.some(q => q.id === queryId) || used.has(queryId)) throw new Error("Invalid search reservation");
      used.add(queryId);
      const result = resultJSON === null ? null : typeof resultJSON === "string" ? parseSearchJson(resultJSON, 64_000) : undefined;
      const attempt = { sequence, queryId, expectedRevision, status, result };
      assertAttempt(attempt);
      if (attempt.status === "completed") {
        if (attempt.result!.provider !== grant.provider) throw new Error("Search result provider differs from authorization");
        timestamp(at);
        if (at >= grant.expiresAt || at < reservedAt || attempt.result!.retrievedAt < reservedAt || attempt.result!.retrievedAt > at) throw new Error("Invalid search completion time");
      } else {
        if (at !== null) throw new Error("Invalid unfinished search timestamp");
        terminal = true;
      }
      attempts.push(attempt);
    }
    return { subjectId, scopeId, grant, stopped: controls[0]!.stopped === 1, attempts };
  }

  #transaction<T>(signal: AbortSignal, work: (status: SearchTaskStatus) => T): T {
    this.#ready(signal); this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(this.#read());
      this.#read(); signal.throwIfAborted(); this.#db.exec("COMMIT"); return result;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  async status(signal: AbortSignal): Promise<SearchTaskStatus> {
    return this.#transaction(signal, status => status);
  }
  async results(signal: AbortSignal): Promise<SearchTaskStatus> { return this.status(signal); }

  async reserve(queryId: string, expectedRevision: number, at: string, signal: AbortSignal): Promise<SearchAttempt> {
    id(queryId); integer(expectedRevision); timestamp(at);
    return this.#transaction(signal, status => {
      if (status.stopped || at >= status.grant.expiresAt) throw new Error("Search stopped or expired");
      if (status.attempts.some(a => a.status !== "completed")) throw new Error("Pending or failed search exists; no retry");
      if (status.attempts.length >= status.grant.limit) throw new Error("Search budget exhausted");
      if (!status.grant.queries.some(q => q.id === queryId) || status.attempts.some(a => a.queryId === queryId)) throw new Error("Search query not approved or already reserved");
      const attempt: SearchAttempt = { sequence: status.attempts.length + 1, queryId, expectedRevision, status: "pending", result: null };
      this.#db.prepare("INSERT INTO attempts VALUES (?, ?, ?, 'pending', NULL, ?, NULL)").run(attempt.sequence, queryId, expectedRevision, at);
      return attempt;
    });
  }
  #pending(status: SearchTaskStatus, attempt: SearchAttempt): void {
    assertAttempt(attempt);
    if (attempt.status !== "pending" || !isDeepStrictEqual(status.attempts.find(a => a.sequence === attempt.sequence), attempt)) throw new Error("Search pending attempt CAS conflict");
  }
  async complete(attempt: SearchAttempt, result: SearchResult, at: string, signal: AbortSignal): Promise<void> {
    assertResult(result); timestamp(at);
    const json = encode(result);
    this.#transaction(signal, status => {
      this.#pending(status, attempt);
      if (status.stopped || at >= status.grant.expiresAt) throw new Error("Search stopped or expired");
      const changed = this.#db.prepare("UPDATE attempts SET status = 'completed', resultJSON = ?, at = ? WHERE sequence = ? AND status = 'pending'").run(json, at, attempt.sequence);
      if (changed.changes !== 1) throw new Error("Search completion CAS conflict");
    });
  }
  async fail(attempt: SearchAttempt, signal: AbortSignal): Promise<void> {
    this.#transaction(signal, status => {
      this.#pending(status, attempt);
      const changed = this.#db.prepare("UPDATE attempts SET status = 'failed' WHERE sequence = ? AND status = 'pending'").run(attempt.sequence);
      if (changed.changes !== 1) throw new Error("Search failure CAS conflict");
    });
  }
  async stop(signal: AbortSignal): Promise<void> {
    this.#transaction(signal, () => { this.#db.prepare("UPDATE control SET stopped = 1 WHERE singleton = 1").run(); });
  }
}
