import { DatabaseSync } from "node:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";
import type { ChatBudget, ChatExchange, ChatReservation, ChatStore } from "../../runtime/chat-store.ts";

const APPLICATION_ID = 0x44434841; // DCHA, separate from the subject-state database.
const DB_VERSION = 1;
const MAX_MESSAGE_LENGTH = 16_000; // JavaScript UTF-16 code units.
const MAX_HISTORY_LENGTH = 24_000;
const MAX_HISTORY_PAIRS = 8;
const MAX_PAIR_JSON_BYTES = 192 * 1024;

function nonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Invalid ${name}`);
}

function safeRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid subject revision");
  }
}

function textLength(value: string): number {
  return value.length; // Explicitly count UTF-16 code units, matching JS string and upstream limits.
}

function validateMessage(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || textLength(value) > MAX_MESSAGE_LENGTH) {
    throw new Error(`Invalid ${name}`);
  }
}

function validatePairJson(user: string, assistant?: string): void {
  const encoded = assistant === undefined ? JSON.stringify([user]) : JSON.stringify([user, assistant]);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAIR_JSON_BYTES) throw new Error("Chat pair JSON exceeds size limit");
}

function validLimit(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Chat call limit must be an integer from 1 to 10000");
  }
}

interface StoredRequest {
  readonly sequence: number;
  readonly request_id: string;
  readonly subject_revision: number;
  readonly user_text: string;
  readonly state: string;
}

/** One subject-bound owner conversation and a permanent call budget per sidecar file. */
export class SqliteChatStore implements ChatStore {
  readonly #db: DatabaseSync;
  #closed = false;

  private constructor(db: DatabaseSync) { this.#db = db; }

  /** Explicitly create a new private sidecar; failed initialization is never silently replaced. */
  static create(path: string, subjectId: string, limit: number, signal: AbortSignal): SqliteChatStore {
    signal.throwIfAborted();
    nonEmptyString(subjectId, "subject id");
    validLimit(limit);
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      db.exec(`
        CREATE TABLE chat_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          subject_id TEXT NOT NULL,
          call_limit INTEGER NOT NULL CHECK(call_limit BETWEEN 1 AND 10000)
        ) STRICT;
        CREATE TABLE chat_requests (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL UNIQUE,
          subject_revision INTEGER NOT NULL CHECK(subject_revision >= 0),
          user_text TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'failed')),
          assistant_text TEXT,
          model_id TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          CHECK(
            (state = 'pending' AND assistant_text IS NULL AND model_id IS NULL AND input_tokens IS NULL AND output_tokens IS NULL) OR
            (state = 'failed' AND assistant_text IS NULL AND model_id IS NULL AND input_tokens IS NULL AND output_tokens IS NULL) OR
            (state = 'completed' AND assistant_text IS NOT NULL AND model_id IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
          )
        ) STRICT;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${DB_VERSION};
      `);
      db.prepare("INSERT INTO chat_meta (singleton, subject_id, call_limit) VALUES (1, ?, ?)").run(subjectId, limit);
      signal.throwIfAborted();
      db.exec("COMMIT");
      return new SqliteChatStore(db);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      db.close();
      throw error;
    }
  }

  /** Open an existing schema-v1 sidecar for exactly its recorded subject; never migrate/reset. */
  static open(path: string, subjectId: string, signal: AbortSignal): SqliteChatStore {
    signal.throwIfAborted();
    nonEmptyString(subjectId, "subject id");
    if (!lstatSync(path).isFile()) throw new Error("Chat database must be a regular non-symlink file");
    const db = new DatabaseSync(path);
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const app = db.prepare("PRAGMA application_id").get()?.application_id;
      if (version !== DB_VERSION || app !== APPLICATION_ID) {
        throw new Error("Unsupported chat database identity or schema version; no migration performed");
      }
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
      const store = new SqliteChatStore(db);
      store.#transaction("BEGIN", () => {
        const meta = db.prepare("SELECT subject_id, call_limit FROM chat_meta WHERE singleton = 1").get();
        if (!meta || typeof meta.subject_id !== "string" || meta.subject_id !== subjectId) {
          throw new Error("Chat database subject binding mismatch");
        }
        validLimit(meta.call_limit);
        // Preparing/reading the required table also rejects lookalike/partial schemas.
        const rows = db.prepare(`
          SELECT sequence, request_id, subject_revision, user_text, state,
                 assistant_text, model_id, input_tokens, output_tokens
          FROM chat_requests ORDER BY sequence
        `).all();
        for (const row of rows) {
          if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1 ||
              typeof row.request_id !== "string" || row.request_id.length === 0 ||
              !Number.isSafeInteger(row.subject_revision) || (row.subject_revision as number) < 0 ||
              !["pending", "completed", "failed"].includes(row.state as string)) {
            throw new Error("Invalid chat database contents");
          }
          validateMessage(row.user_text, "stored user message");
          validatePairJson(row.user_text);
          if (row.state === "completed") {
            if (typeof row.model_id !== "string" || row.model_id.trim().length === 0 ||
                !Number.isSafeInteger(row.input_tokens) || (row.input_tokens as number) < 0 ||
                !Number.isSafeInteger(row.output_tokens) || (row.output_tokens as number) < 0) {
              throw new Error("Invalid completed chat record");
            }
            validateMessage(row.assistant_text, "stored assistant message");
            validatePairJson(row.user_text, row.assistant_text);
          } else if (row.assistant_text !== null || row.model_id !== null || row.input_tokens !== null || row.output_tokens !== null) {
            throw new Error("Invalid incomplete chat record");
          }
        }
        if (rows.length > meta.call_limit) throw new Error("Chat database exceeds its recorded call limit");
      }, signal);
      return store;
    } catch (error) { db.close(); throw error; }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("Chat store is closed");
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

  #history(): readonly ChatExchange[] {
    const rows = this.#db.prepare(`
      SELECT user_text, assistant_text FROM chat_requests
      WHERE state = 'completed' ORDER BY sequence DESC LIMIT ?
    `).all(MAX_HISTORY_PAIRS);
    const newestFirst: ChatExchange[] = [];
    let total = 0;
    for (const row of rows) {
      if (typeof row.user_text !== "string" || typeof row.assistant_text !== "string") {
        throw new Error("Invalid completed chat record");
      }
      const size = textLength(row.user_text) + textLength(row.assistant_text);
      if (total + size > MAX_HISTORY_LENGTH) break;
      newestFirst.push({ user: row.user_text, assistant: row.assistant_text });
      total += size;
    }
    return newestFirst.reverse();
  }

  async reserve(requestId: string, user: string, subjectRevision: number, signal: AbortSignal): Promise<ChatReservation> {
    nonEmptyString(requestId, "request id");
    validateMessage(user, "user message");
    validatePairJson(user);
    safeRevision(subjectRevision);
    return this.#transaction("BEGIN IMMEDIATE", () => {
      const duplicate = this.#db.prepare("SELECT 1 AS found FROM chat_requests WHERE request_id = ?").get(requestId);
      if (duplicate) throw new Error("Chat request id has already been used");
      const budget = this.#db.prepare("SELECT call_limit, (SELECT COUNT(*) FROM chat_requests) AS reserved FROM chat_meta WHERE singleton = 1").get();
      if (!budget || !Number.isSafeInteger(budget.call_limit) || !Number.isSafeInteger(budget.reserved)) {
        throw new Error("Invalid chat budget metadata");
      }
      if ((budget.reserved as number) >= (budget.call_limit as number)) throw new Error("Chat call budget exhausted");
      const inserted = this.#db.prepare(`
        INSERT INTO chat_requests (request_id, subject_revision, user_text, state)
        VALUES (?, ?, ?, 'pending')
      `).run(requestId, subjectRevision, user);
      const sequence = Number(inserted.lastInsertRowid);
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid chat reservation sequence");
      return { requestId, sequence, subjectRevision, user, history: this.#history() };
    }, signal);
  }

  #matchReservation(reservation: ChatReservation): StoredRequest {
    if (reservation === null || typeof reservation !== "object") throw new Error("Invalid chat reservation");
    nonEmptyString(reservation.requestId, "request id");
    safeRevision(reservation.sequence);
    safeRevision(reservation.subjectRevision);
    if (typeof reservation.user !== "string") throw new Error("Invalid chat reservation");
    const row = this.#db.prepare(`
      SELECT sequence, request_id, subject_revision, user_text, state
      FROM chat_requests WHERE request_id = ?
    `).get(reservation.requestId) as StoredRequest | undefined;
    if (!row || row.sequence !== reservation.sequence || row.request_id !== reservation.requestId ||
        row.subject_revision !== reservation.subjectRevision || row.user_text !== reservation.user) {
      throw new Error("Chat reservation does not match stored request");
    }
    return row;
  }

  async complete(
    reservation: ChatReservation,
    assistant: string,
    usage: { readonly modelId: string; readonly inputTokens: number; readonly outputTokens: number },
    signal: AbortSignal,
  ): Promise<void> {
    validateMessage(assistant, "assistant message");
    if (reservation === null || typeof reservation !== "object") throw new Error("Invalid chat reservation");
    if (usage === null || typeof usage !== "object") throw new Error("Invalid chat usage");
    nonEmptyString(usage.modelId, "model id");
    if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 ||
        !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
      throw new Error("Invalid chat token usage");
    }
    this.#transaction("BEGIN IMMEDIATE", () => {
      const row = this.#matchReservation(reservation);
      validatePairJson(row.user_text, assistant);
      if (row.state !== "pending") throw new Error("Chat reservation is not pending");
      const latest = this.#db.prepare("SELECT MAX(sequence) AS sequence FROM chat_requests").get()?.sequence;
      if (latest !== reservation.sequence) throw new Error("Stale chat reservation cannot complete");
      const result = this.#db.prepare(`
        UPDATE chat_requests SET state = 'completed', assistant_text = ?, model_id = ?, input_tokens = ?, output_tokens = ?
        WHERE sequence = ? AND state = 'pending'
      `).run(assistant, usage.modelId, usage.inputTokens, usage.outputTokens, reservation.sequence);
      if (result.changes !== 1) throw new Error("Chat reservation completion failed");
    }, signal);
  }

  async fail(reservation: ChatReservation, signal: AbortSignal): Promise<void> {
    this.#transaction("BEGIN IMMEDIATE", () => {
      const row = this.#matchReservation(reservation);
      if (row.state !== "pending") throw new Error("Chat reservation is not pending");
      const result = this.#db.prepare("UPDATE chat_requests SET state = 'failed' WHERE sequence = ? AND state = 'pending'")
        .run(reservation.sequence);
      if (result.changes !== 1) throw new Error("Chat reservation failure update failed");
    }, signal);
  }

  async budget(signal: AbortSignal): Promise<ChatBudget> {
    return this.#transaction("BEGIN", () => {
      const meta = this.#db.prepare("SELECT call_limit FROM chat_meta WHERE singleton = 1").get();
      if (!meta || !Number.isSafeInteger(meta.call_limit)) throw new Error("Invalid chat budget metadata");
      const rows = this.#db.prepare("SELECT state, COUNT(*) AS amount FROM chat_requests GROUP BY state").all();
      const counts = { completed: 0, failed: 0, pending: 0 };
      for (const row of rows) {
        if (typeof row.state !== "string" || !Object.hasOwn(counts, row.state) || !Number.isSafeInteger(row.amount)) {
          throw new Error("Invalid chat budget records");
        }
        counts[row.state as keyof typeof counts] = row.amount as number;
      }
      const reserved = counts.completed + counts.failed + counts.pending;
      if (!Number.isSafeInteger(reserved) || reserved > (meta.call_limit as number)) throw new Error("Invalid chat budget totals");
      return { limit: meta.call_limit as number, reserved, ...counts };
    }, signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
