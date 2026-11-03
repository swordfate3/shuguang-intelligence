import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertConversationBatch, type ConversationBatch, type ConversationFragment } from "../../core/conversation-source.ts";
import { assertData, id, timestamp, object, integer } from "../../core/guards.ts";
import type { SubjectState } from "../../core/state.ts";
import type { CycleInput } from "../../core/cycle.ts";
import type { ConversationGrant, ConversationImportStatus } from "../../runtime/conversation-store.ts";

// Bounded, append-only host ledger. The caller owns every transaction (including domain commits).
const MAX_BATCH_BYTES = 24 * 1024;
const MAX_RECORDS = 1000;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const HOST_SCHEMA = `
      CREATE TABLE host_grants (
        grantId TEXT PRIMARY KEY, batchId TEXT NOT NULL UNIQUE, batchHash TEXT NOT NULL,
        bindingId TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
        expiresAt TEXT NOT NULL, batchJSON TEXT NOT NULL
      ) STRICT;
      CREATE TABLE import_batches (
        batchId TEXT PRIMARY KEY REFERENCES host_grants(batchId), grantId TEXT NOT NULL UNIQUE REFERENCES host_grants(grantId),
        acceptedAt TEXT NOT NULL, acceptedRevision INTEGER NOT NULL CHECK(acceptedRevision >= 0),
        status TEXT NOT NULL CHECK(status IN ('accepted','consumed')),
        newSources INTEGER NOT NULL CHECK(newSources BETWEEN 0 AND 16), revision INTEGER NOT NULL CHECK(revision >= 0)
      ) STRICT;
      CREATE TABLE source_records (
        sourceId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, entryId TEXT NOT NULL, textBlockIndex INTEGER NOT NULL CHECK(textBlockIndex BETWEEN 0 AND 1023),
        sourceRevision INTEGER NOT NULL CHECK(sourceRevision = 1), fragmentJSON TEXT NOT NULL, textHash TEXT NOT NULL,
        capturedAt TEXT NOT NULL, consumedBatchId TEXT REFERENCES import_batches(batchId),
        UNIQUE(sessionId,entryId,textBlockIndex,sourceRevision)
      ) STRICT;
      CREATE TABLE host_events (sequence INTEGER PRIMARY KEY, eventJSON TEXT NOT NULL) STRICT;
    `;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
function json(value: unknown): string {
  assertData(value);
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return Object.assign(Object.setPrototypeOf([], null), v.map(copy));
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(v)) out[key] = copy(Object.getOwnPropertyDescriptor(v, key)!.value);
    return out;
  };
  return JSON.stringify(copy(value));
}
function fragmentValue(f: ConversationFragment): ConversationFragment {
  return { entryId: f.entryId, parentEntryId: f.parentEntryId, textBlockIndex: f.textBlockIndex,
    role: f.role, text: f.text, sourceTimestamp: f.sourceTimestamp };
}
function batchJSON(batch: ConversationBatch): string {
  assertConversationBatch(batch);
  const result = json({ version: 1, batchId: batch.batchId, sessionId: batch.sessionId,
    leafEntryId: batch.leafEntryId, fragments: batch.fragments.map(fragmentValue) });
  if (Buffer.byteLength(result, "utf8") > MAX_BATCH_BYTES) throw new Error("Conversation batch capacity exceeded");
  return result;
}
function parseBatch(value: string): ConversationBatch {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_BATCH_BYTES) throw new Error("Invalid conversation batch size");
  const batch: unknown = JSON.parse(value);
  assertConversationBatch(batch);
  if (batchJSON(batch) !== value) throw new Error("Non-canonical conversation batch");
  return batch;
}
interface GrantRow extends ConversationGrant { batchJSON: string }
interface BatchRow {
  batchId: string; grantId: string; acceptedAt: string; acceptedRevision: number;
  status: "accepted" | "consumed"; newSources: number; revision: number;
}
interface SourceRow {
  sourceId: string; sessionId: string; entryId: string; textBlockIndex: number; sourceRevision: number;
  fragmentJSON: string; textHash: string; capturedAt: string; consumedBatchId: string | null;
}
export interface SourceConsumption {
  type: "source_batch_consumed"; batchId: string; expectedRevision: number; at: string; sourceIds: string[];
}
export interface ConversationLedger {
  grants: Map<string, GrantRow>; batches: Map<string, BatchRow>; sources: Map<string, SourceRow>;
  consumptions: Map<string, SourceConsumption>;
}
function sourceId(state: SubjectState, sessionId: string, f: ConversationFragment): string {
  return `pi_${hash(json([state.self.identity.id, state.scopeId, sessionId, f.entryId, f.textBlockIndex, 1]))}`;
}
function same(a: unknown, b: unknown): void {
  if (!isDeepStrictEqual(a, b)) throw new Error("Conversation ledger integrity mismatch");
}
function grantValue(g: GrantRow): ConversationGrant {
  return { grantId: g.grantId, batchId: g.batchId, batchHash: g.batchHash, bindingId: g.bindingId,
    status: g.status, expiresAt: g.expiresAt };
}
function statusValue(b: BatchRow): ConversationImportStatus {
  return { batchId: b.batchId, status: b.status, newSources: b.newSources, revision: b.revision };
}
export class SqliteConversationLedger {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }
  static create(db: DatabaseSync): void {
    db.exec(HOST_SCHEMA);
  }
  #audit(event: unknown): void {
    this.#db.prepare("INSERT INTO host_events(sequence,eventJSON) VALUES ((SELECT COALESCE(MAX(sequence),0)+1 FROM host_events),?)").run(json(event));
  }
  /** Rebuild control state and all source hashes from the audit, then compare every persisted row.
   * This is consistency checking, not protection against an administrator rewriting the whole database. */
  validate(state: SubjectState): ConversationLedger {
    // Compare declared columns, CHECK/unique/FK constraints and STRICT mode, not merely user_version.
    const normalized = (sql: string): string => sql.replace(/\s+/g, " ").trim();
    for (const declaration of HOST_SCHEMA.split(";").filter(part => part.trim())) {
      const name = /CREATE TABLE ([a-z_]+)/.exec(declaration)![1]!;
      const row = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      if (!row || typeof row.sql !== "string" || normalized(row.sql) !== normalized(declaration)) throw new Error("Invalid host ledger schema");
    }
    if (this.#db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Invalid host ledger foreign key");
    const ledger: ConversationLedger = { grants: new Map(), batches: new Map(), sources: new Map(), consumptions: new Map() };
    const events = this.#db.prepare("SELECT sequence,eventJSON FROM host_events ORDER BY sequence").all();
    if (events.length > MAX_RECORDS * 4) throw new Error("Conversation ledger capacity exceeded");
    let lastRevision = 0;
    events.forEach((row, index) => {
      if (row.sequence !== index + 1 || typeof row.eventJSON !== "string" || Buffer.byteLength(row.eventJSON) > 64 * 1024) throw new Error("Invalid host event");
      const event: unknown = JSON.parse(row.eventJSON);
      assertData(event);
      if (json(event) !== row.eventJSON) throw new Error("Non-canonical host event");
      const type = (event as { type?: unknown })?.type;
      if (type === "authorized") {
        const e = object(event, ["type", "grant", "at"]);
        timestamp(e.at);
        const g = object(e.grant, ["grantId", "batchId", "batchHash", "bindingId", "status", "expiresAt", "batchJSON"]) as unknown as GrantRow;
        id(g.grantId); id(g.bindingId); timestamp(g.expiresAt);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(g.grantId) ||
            g.status !== "active" || g.expiresAt <= e.at || ledger.grants.has(g.batchId)) throw new Error("Invalid conversation grant");
        const batch = parseBatch(g.batchJSON);
        if (g.batchHash !== hash(g.batchJSON) || g.batchId !== batch.batchId || [...ledger.grants.values()].some(old => old.grantId === g.grantId)) throw new Error("Invalid conversation grant hash or identity");
        ledger.grants.set(g.batchId, { ...g });
      } else if (type === "revoked") {
        const e = object(event, ["type", "batchId"]);
        const g = ledger.grants.get(e.batchId as string);
        if (!g || g.status !== "active") throw new Error("Invalid conversation revocation");
        ledger.grants.set(g.batchId, { ...g, status: "revoked" });
      } else if (type === "accepted") {
        const e = object(event, ["type", "batchId", "at", "revision"]);
        timestamp(e.at); integer(e.revision);
        const g = ledger.grants.get(e.batchId as string);
        if (!g || g.status !== "active" || e.at >= g.expiresAt || ledger.batches.has(g.batchId) || e.revision < lastRevision || e.revision > state.revision) throw new Error("Invalid conversation acceptance");
        lastRevision = e.revision;
        const batch = parseBatch(g.batchJSON);
        for (const f of batch.fragments) {
          const sid = sourceId(state, batch.sessionId, f);
          const old = ledger.sources.get(sid);
          if (old) {
            if (old.fragmentJSON !== json(fragmentValue(f))) throw new Error("Conversation source conflict");
          } else ledger.sources.set(sid, { sourceId: sid, sessionId: batch.sessionId, entryId: f.entryId,
            textBlockIndex: f.textBlockIndex, sourceRevision: 1, fragmentJSON: json(fragmentValue(f)), textHash: hash(f.text),
            capturedAt: e.at, consumedBatchId: null });
        }
        ledger.batches.set(g.batchId, { batchId: g.batchId, grantId: g.grantId, acceptedAt: e.at, acceptedRevision: e.revision,
          status: "accepted", newSources: 0, revision: e.revision });
      } else if (type === "source_batch_consumed") {
        const e = object(event, ["type", "batchId", "expectedRevision", "at", "sourceIds"]) as unknown as SourceConsumption;
        timestamp(e.at); integer(e.expectedRevision);
        const g = ledger.grants.get(e.batchId);
        const b = ledger.batches.get(e.batchId);
        if (!g || !b || b.status !== "accepted" || g.status !== "active" || e.at >= g.expiresAt || e.at < b.acceptedAt ||
            e.expectedRevision < lastRevision || e.expectedRevision > state.revision) throw new Error("Invalid conversation consumption");
        const batch = parseBatch(g.batchJSON);
        const sources = batch.fragments.map(f => ledger.sources.get(sourceId(state, batch.sessionId, f))!);
        const fresh = sources.filter(s => s.consumedBatchId === null);
        same(e.sourceIds, fresh.map(s => s.sourceId));
        for (const s of fresh) s.consumedBatchId = b.batchId;
        b.status = "consumed"; b.newSources = fresh.length; b.revision = e.expectedRevision + fresh.length;
        if (b.revision > state.revision) throw new Error("Invalid conversation consumed revision");
        lastRevision = b.revision;
        ledger.consumptions.set(b.batchId, e);
      } else throw new Error("Unknown host event");
    });
    this.#capacity(ledger);
    const grants = this.#db.prepare("SELECT grantId,batchId,batchHash,bindingId,status,expiresAt,batchJSON FROM host_grants").all();
    const batches = this.#db.prepare("SELECT batchId,grantId,acceptedAt,acceptedRevision,status,newSources,revision FROM import_batches").all();
    const sources = this.#db.prepare("SELECT sourceId,sessionId,entryId,textBlockIndex,sourceRevision,fragmentJSON,textHash,capturedAt,consumedBatchId FROM source_records").all();
    same(grants.length, ledger.grants.size); same(batches.length, ledger.batches.size); same(sources.length, ledger.sources.size);
    // node:sqlite returns null-prototype records; compare detached ordinary objects.
    for (const g of grants) same({ ...g }, ledger.grants.get(g.batchId as string));
    for (const b of batches) same({ ...b }, ledger.batches.get(b.batchId as string));
    for (const s of sources) same({ ...s }, ledger.sources.get(s.sourceId as string));
    return ledger;
  }
  #capacity(ledger: ConversationLedger): void {
    if (ledger.grants.size > MAX_RECORDS || ledger.batches.size > MAX_RECORDS || ledger.sources.size > MAX_RECORDS ||
        [...ledger.sources.values()].reduce((n, s) => n + Buffer.byteLength((JSON.parse(s.fragmentJSON) as ConversationFragment).text, "utf8"), 0) > MAX_SOURCE_BYTES) {
      throw new Error("Conversation ledger capacity exceeded (1000 grants/batches/sources; 4MiB source text)");
    }
  }
  authorize(ledger: ConversationLedger, batch: ConversationBatch, bindingId: string, expiresAt: string): ConversationGrant {
    id(bindingId); timestamp(expiresAt);
    const encoded = batchJSON(batch);
    const old = ledger.grants.get(batch.batchId);
    if (old) {
      if (old.bindingId !== bindingId || old.batchJSON !== encoded) throw new Error("Conversation batch conflict");
      return grantValue(old); // No renewal or revival, including expired/revoked grants.
    }
    const at = new Date().toISOString();
    if (expiresAt <= at) throw new Error("Conversation grant expired");
    const grant: GrantRow = { grantId: randomUUID(), batchId: batch.batchId, batchHash: hash(encoded), bindingId,
      status: "active", expiresAt, batchJSON: encoded };
    ledger.grants.set(batch.batchId, grant); this.#capacity(ledger);
    this.#db.prepare("INSERT INTO host_grants(grantId,batchId,batchHash,bindingId,status,expiresAt,batchJSON) VALUES (?,?,?,?,?,?,?)")
      .run(grant.grantId, grant.batchId, grant.batchHash, bindingId, grant.status, expiresAt, encoded);
    this.#audit({ type: "authorized", grant, at });
    return grantValue(grant);
  }
  #active(ledger: ConversationLedger, batchId: string, grantId: string, bindingId: string): GrantRow {
    id(batchId); id(grantId); id(bindingId);
    const grant = ledger.grants.get(batchId);
    if (!grant || grant.grantId !== grantId || grant.bindingId !== bindingId) throw new Error("Conversation binding or grant mismatch");
    if (grant.status !== "active") throw new Error("Conversation grant revoked");
    if (grant.expiresAt <= new Date().toISOString()) throw new Error("Conversation grant expired");
    return grant;
  }
  accept(ledger: ConversationLedger, state: SubjectState, batch: ConversationBatch, grantId: string, bindingId: string): ConversationImportStatus {
    const encoded = batchJSON(batch);
    const g = this.#active(ledger, batch.batchId, grantId, bindingId);
    if (g.batchJSON !== encoded || g.batchHash !== hash(encoded)) throw new Error("Conversation batch conflict");
    const old = ledger.batches.get(batch.batchId);
    if (old) return statusValue(old);
    const at = new Date().toISOString();
    if (at >= g.expiresAt) throw new Error("Conversation grant expired");
    const fresh: SourceRow[] = [];
    for (const f of batch.fragments) {
      const sid = sourceId(state, batch.sessionId, f);
      const oldSource = ledger.sources.get(sid);
      if (oldSource) {
        if (oldSource.fragmentJSON !== json(fragmentValue(f))) throw new Error("Conversation source conflict");
      } else {
        const s: SourceRow = { sourceId: sid, sessionId: batch.sessionId, entryId: f.entryId, textBlockIndex: f.textBlockIndex,
          sourceRevision: 1, fragmentJSON: json(fragmentValue(f)), textHash: hash(f.text), capturedAt: at, consumedBatchId: null };
        fresh.push(s); ledger.sources.set(sid, s);
      }
    }
    this.#capacity(ledger);
    const b: BatchRow = { batchId: batch.batchId, grantId, acceptedAt: at, acceptedRevision: state.revision,
      status: "accepted", newSources: 0, revision: state.revision };
    this.#db.prepare("INSERT INTO import_batches(batchId,grantId,acceptedAt,acceptedRevision,status,newSources,revision) VALUES (?,?,?,?,?,0,?)")
      .run(b.batchId, grantId, at, state.revision, b.status, state.revision);
    for (const s of fresh) this.#db.prepare("INSERT INTO source_records(sourceId,sessionId,entryId,textBlockIndex,sourceRevision,fragmentJSON,textHash,capturedAt,consumedBatchId) VALUES (?,?,?,?,1,?,?,?,NULL)")
      .run(s.sourceId, s.sessionId, s.entryId, s.textBlockIndex, s.fragmentJSON, s.textHash, at);
    this.#audit({ type: "accepted", batchId: b.batchId, at, revision: state.revision });
    return statusValue(b);
  }
  prepareConsume(ledger: ConversationLedger, state: SubjectState, batchId: string, grantId: string, bindingId: string, at: string): SourceConsumption | ConversationImportStatus {
    timestamp(at);
    const g = this.#active(ledger, batchId, grantId, bindingId);
    const b = ledger.batches.get(batchId);
    if (!b) throw new Error("Conversation batch not accepted");
    if (b.status === "consumed") return statusValue(b);
    if (state.lifecycle !== "awake") throw new Error("Subject must be awake to consume conversation");
    // 'at' is supplied by the trusted runtime clock, never by the external batch. Also enforce wall expiry above.
    if (at < b.acceptedAt) throw new Error("Conversation consumption predates acceptance");
    if (at < state.updatedAt) throw new Error("Conversation consumption predates subject state");
    if (at >= g.expiresAt) throw new Error("Conversation consumption grant expired");
    const batch = parseBatch(g.batchJSON);
    return { type: "source_batch_consumed", batchId, expectedRevision: state.revision, at,
      sourceIds: batch.fragments.map(f => sourceId(state, batch.sessionId, f)).filter(sid => ledger.sources.get(sid)!.consumedBatchId === null) };
  }
  cycles(ledger: ConversationLedger, state: SubjectState, event: SourceConsumption): CycleInput[] {
    if (event.expectedRevision !== state.revision || state.lifecycle !== "awake") throw new Error("Invalid source consumption revision or lifecycle");
    return event.sourceIds.map((sid, index) => {
      const source = ledger.sources.get(sid);
      if (!source) throw new Error("Missing conversation source");
      const f = JSON.parse(source.fragmentJSON) as ConversationFragment;
      return { cycleId: `cycle_${sid}`, expectedRevision: state.revision + index, at: event.at,
        experience: { id: sid, subjectId: state.self.identity.id, scopeId: state.scopeId, kind: "conversation",
          origin: f.role === "user" ? "user_statement" : "inference", content: f.text, topics: ["pi-conversation"],
          occurredAt: source.capturedAt, recordedAt: event.at, sourceIds: [] },
        appraisal: null, candidates: [], activities: [] };
    });
  }
  commitConsume(event: SourceConsumption): ConversationImportStatus {
    for (const sid of event.sourceIds) {
      const changed = this.#db.prepare("UPDATE source_records SET consumedBatchId = ? WHERE sourceId = ? AND consumedBatchId IS NULL").run(event.batchId, sid);
      if (changed.changes !== 1) throw new Error("Conversation source consumption conflict");
    }
    const revision = event.expectedRevision + event.sourceIds.length;
    const changed = this.#db.prepare("UPDATE import_batches SET status = 'consumed', newSources = ?, revision = ? WHERE batchId = ? AND status = 'accepted'")
      .run(event.sourceIds.length, revision, event.batchId);
    if (changed.changes !== 1) throw new Error("Conversation batch consumption conflict");
    this.#audit(event);
    return { batchId: event.batchId, status: "consumed", newSources: event.sourceIds.length, revision };
  }
  status(ledger: ConversationLedger, batchId: string, bindingId: string): ConversationImportStatus | undefined {
    id(batchId); id(bindingId);
    const g = ledger.grants.get(batchId);
    if (g && g.bindingId !== bindingId) throw new Error("Conversation binding mismatch");
    const b = ledger.batches.get(batchId);
    return b ? statusValue(b) : undefined;
  }
  /** Sleep is a durable conservative fence: wake never revives old host grants. Pack grants are untouched. */
  revokeAll(ledger: ConversationLedger): void {
    for (const g of ledger.grants.values()) if (g.status === "active") this.revoke(ledger, g.grantId, g.bindingId);
  }
  revoke(ledger: ConversationLedger, grantId: string, bindingId: string): void {
    id(grantId); id(bindingId);
    const g = [...ledger.grants.values()].find(g => g.grantId === grantId);
    if (!g || g.bindingId !== bindingId) throw new Error("Conversation binding or grant mismatch");
    if (g.status === "revoked") return;
    this.#db.prepare("UPDATE host_grants SET status = 'revoked' WHERE grantId = ?").run(grantId);
    this.#audit({ type: "revoked", batchId: g.batchId });
  }
}
