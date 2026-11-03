import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach, afterEach, mock } from "node:test";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { createInitialState } from "../src/core/state.ts";
import type { ConversationBatch } from "../src/core/conversation-source.ts";
import type { LearningPack } from "../src/core/learning.ts";

// Use a deterministic wall clock for persistence fixtures; real clock correction must not make unrelated replay tests flaky.
beforeEach(() => mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 2) }));
afterEach(() => mock.timers.reset());
const signal = () => new AbortController().signal;
const now = () => new Date().toISOString();
const expiry = () => new Date(Date.now() + 60_000).toISOString();
const initialAt = "2026-01-01T00:00:00.000Z";
const pack: LearningPack = { version: 1, id: "pack", title: "Synthetic pack", goals: [{ id: "one", title: "One",
  topics: ["learning"], material: "Synthetic material.", practice: [{ id: "p", prompt: "Practice?", answer: "A" }],
  assessment: [{ id: "a", prompt: "Assessment?", answer: "B" }] }] };
function batch(batchId = "batch"): ConversationBatch {
  return { version: 1, batchId, sessionId: "session", leafEntryId: "assistant", fragments: [
    { entryId: "owner", parentEntryId: null, textBlockIndex: 0, role: "user", text: "Owner statement.", sourceTimestamp: "2099-01-01T00:00:00.000Z" },
    { entryId: "assistant", parentEntryId: "owner", textBlockIndex: 0, role: "assistant", text: "Pi hypothesis.", sourceTimestamp: initialAt },
  ] };
}
async function fixture(work: (store: SqliteSubjectStore, path: string) => Promise<void>, processed = 0): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dawn-host-storage-"));
  const path = join(dir, "subject.sqlite");
  const base = createInitialState("dawn", "Dawn", initialAt);
  const store = SqliteSubjectStore.createHostLearning(path, { ...base, processedCycleIds: Array.from({ length: processed }, (_, i) => `old_${i}`) }, 6, pack, 4, signal());
  try { await work(store, path); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
async function accept(store: SqliteSubjectStore, b = batch()) {
  const grant = await store.authorizeConversation(b, "binding", expiry(), signal());
  await store.acceptConversation(b, grant.grantId, "binding", signal());
  return grant;
}
async function awake(store: SqliteSubjectStore) { await store.changeLifecycle(0, "awake", now(), signal()); }
function sql(path: string, work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try { work(db); } finally { db.close(); }
}

test("v4 imports owner statements and Pi inference in the same scope, deduplicates overlapping batches, and cold replays without history or fees", async () => {
  await fixture(async (store, path) => {
    assert.equal(store.supportsHostImport, true);
    await awake(store);
    const g = await accept(store);
    const first = await store.consumeConversation(g.batchId, g.grantId, "binding", now(), signal());
    assert.deepEqual(first, { batchId: "batch", status: "consumed", newSources: 2, revision: 3 });
    assert.deepEqual(await store.consumeConversation(g.batchId, g.grantId, "binding", now(), signal()), first);
    const overlap = await accept(store, batch("overlap"));
    assert.deepEqual(await store.consumeConversation(overlap.batchId, overlap.grantId, "binding", now(), signal()),
      { batchId: "overlap", status: "consumed", newSources: 0, revision: 3 });
    const state = await store.read(signal());
    assert.deepEqual(state.experiences.map(e => e.origin), ["user_statement", "inference"]);
    for (const e of state.experiences) {
      assert.deepEqual(e.sourceIds, []); assert.deepEqual(e.topics, ["pi-conversation"]);
      assert.match(e.id, /^pi_[a-f0-9]{64}$/); assert.equal(e.subjectId, "dawn"); assert.equal(e.scopeId, state.scopeId);
      assert.ok(e.occurredAt <= e.recordedAt);
    }
    assert.equal(state.memory.records.length, 2);
    assert.deepEqual(await store.history(signal()), []);
    assert.equal((await store.budget(signal())).reserved, 0);
    assert.doesNotMatch(JSON.stringify(await store.conversationImportStatus("batch", "binding", signal())), /Owner statement|Pi hypothesis/);
    store.close();
    const reopened = SqliteSubjectStore.open(path, signal());
    try { assert.deepEqual(await reopened.read(signal()), state); } finally { reopened.close(); }
  });
});

test("grants persist exact content and binding; duplicate authorize never renews or revives, conflicts reject atomically", async () => {
  await fixture(async (store, path) => {
    const b = batch(); const g = await accept(store, b);
    assert.deepEqual(await store.authorizeConversation(b, "binding", new Date(Date.now() + 120_000).toISOString(), signal()), g);
    assert.equal((await store.read(signal())).revision, 0);
    await assert.rejects(store.authorizeConversation(b, "other", expiry(), signal()), /conflict/);
    await assert.rejects(store.authorizeConversation({ ...b, leafEntryId: "changed" }, "binding", expiry(), signal()), /conflict/);
    await assert.rejects(store.acceptConversation(b, g.grantId, "other", signal()), /mismatch/);
    await assert.rejects(store.conversationImportStatus("batch", "other", signal()), /mismatch/);
    await assert.rejects(store.revokeConversation(g.grantId, "other", signal()), /mismatch/);
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /awake/);
    await awake(store);
    await store.revokeConversation(g.grantId, "binding", signal());
    await store.revokeConversation(g.grantId, "binding", signal());
    assert.deepEqual(await store.authorizeConversation(b, "binding", expiry(), signal()), { ...g, status: "revoked" });
    await assert.rejects(store.acceptConversation(b, g.grantId, "binding", signal()), /revoked/);
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /revoked/);
    store.close(); const reopened = SqliteSubjectStore.open(path, signal());
    try { await assert.rejects(reopened.consumeConversation("batch", g.grantId, "binding", now(), signal()), /revoked/); } finally { reopened.close(); }
  });
});

test("grant expiration is checked with wall clock at accept and consume; exact retries do not extend it", async () => {
  await fixture(async store => {
    await awake(store);
    const realNow = Date.now();
    const g = await store.authorizeConversation(batch(), "binding", new Date(realNow + 500).toISOString(), signal());
    await store.acceptConversation(batch(), g.grantId, "binding", signal());
    mock.timers.tick(550);
    await assert.rejects(store.acceptConversation(batch(), g.grantId, "binding", signal()), /expired/);
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", new Date(realNow + 100).toISOString(), signal()), /expired/);
    assert.deepEqual(await store.authorizeConversation(batch(), "binding", expiry(), signal()), g);
    await assert.rejects(store.authorizeConversation(batch("past"), "binding", initialAt, signal()), /expired/);
  });
});

test("same source location with changed text/role/parent/timestamp conflicts; no partial acceptance", async () => {
  await fixture(async (store, path) => {
    await accept(store);
    for (const [index, change] of [{ text: "Changed" }, { role: "assistant" as const }, { parentEntryId: "other" }, { sourceTimestamp: initialAt }].entries()) {
      const b = batch(`conflict_${index}`);
      const changed = { ...b, fragments: [{ ...b.fragments[0]!, ...change }] };
      const g = await store.authorizeConversation(changed, "binding", expiry(), signal());
      await assert.rejects(store.acceptConversation(changed, g.grantId, "binding", signal()), /source conflict/);
      assert.equal(await store.conversationImportStatus(changed.batchId, "binding", signal()), undefined);
    }
    sql(path, db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_records").get()?.n, 2));
  });
});

test("accepted batches recover locally; SQL failures roll back source marks, snapshot, domain and host events together", async () => {
  await fixture(async (store, path) => {
    await awake(store); const g = await accept(store); const before = await store.read(signal());
    sql(path, db => db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON source_records WHEN OLD.entryId = 'assistant'
      BEGIN SELECT RAISE(ABORT, 'synthetic source failure'); END;`));
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /synthetic source failure/);
    assert.deepEqual(await store.read(signal()), before);
    assert.equal((await store.conversationImportStatus("batch", "binding", signal()))?.status, "accepted");
    sql(path, db => {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_records WHERE consumedBatchId IS NOT NULL").get()?.n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_events").get()?.n, 2);
      db.exec("DROP TRIGGER fail_second");
    });
    store.close(); const reopened = SqliteSubjectStore.open(path, signal());
    try {
      assert.equal((await reopened.consumeConversation("batch", g.grantId, "binding", now(), signal())).newSources, 2);
      assert.equal((await reopened.budget(signal())).reserved, 0);
    } finally { reopened.close(); }
  });
});

test("acceptance source INSERT trigger fails all-or-nothing", async () => {
  await fixture(async (store, path) => {
    const g = await store.authorizeConversation(batch(), "binding", expiry(), signal());
    sql(path, db => db.exec(`CREATE TRIGGER fail_accept BEFORE INSERT ON source_records WHEN NEW.entryId = 'assistant'
      BEGIN SELECT RAISE(ABORT, 'synthetic accept failure'); END;`));
    await assert.rejects(store.acceptConversation(batch(), g.grantId, "binding", signal()), /synthetic accept failure/);
    sql(path, db => {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_records").get()?.n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()?.n, 0);
    });
    assert.equal((await store.read(signal())).revision, 0);
  });
});

test("conversation consumes cannot invalidate charged pending chat or pack, while v4 pack still completes and cold replays", async () => {
  await fixture(async (store, path) => {
    await awake(store); const g = await accept(store);
    const chat = await store.reserve("chat", "synthetic", 1, signal());
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /pending/);
    await store.fail(chat, signal());
    const study = await store.reserveLearning("one", "study", 1, signal());
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /pending/);
    const learned = await store.completeLearning(study, { notes: "Synthetic notes.", answers: [{ id: "p", answer: "A" }] }, now(), signal());
    await store.consumeConversation("batch", g.grantId, "binding", now(), signal());
    const assessment = await store.reserveLearning("one", "assessment", learned.revision + 2, signal());
    const result = await store.completeLearning(assessment, { notes: "", answers: [{ id: "a", answer: "B" }] }, now(), signal());
    assert.equal((await store.learningStatus(signal()))?.status, "completed");
    assert.deepEqual(await store.budget(signal()), { limit: 6, reserved: 3, completed: 2, failed: 1, pending: 0 });
    store.close(); const reopened = SqliteSubjectStore.open(path, signal());
    try { assert.deepEqual(await reopened.read(signal()), result); } finally { reopened.close(); }
  });
});

test("cold open rejects tampered source, grant, batch, host event or domain event, including unknown cycle event types", async () => {
  for (const mutate of [
    "UPDATE source_records SET textHash = 'fake'",
    "UPDATE source_records SET fragmentJSON = replace(fragmentJSON, 'Owner statement.', 'Injected text.') WHERE entryId = 'owner'",
    "UPDATE host_grants SET expiresAt = '2099-01-01T00:00:00.000Z'",
    "UPDATE host_grants SET batchHash = 'fake'",
    "UPDATE import_batches SET newSources = 0",
    "UPDATE import_batches SET status = 'accepted'",
    "UPDATE host_events SET eventJSON = replace(eventJSON, 'Owner statement.', 'Injected text.') WHERE sequence = 1",
    "UPDATE events SET eventJSON = replace(eventJSON, 'source_batch_consumed', 'arbitrary_cycles') WHERE revision = 3",
    "DELETE FROM events WHERE revision = 3",
    "DELETE FROM host_events WHERE sequence = 3",
  ]) {
    await fixture(async (store, path) => {
      await awake(store); const g = await accept(store);
      await store.consumeConversation("batch", g.grantId, "binding", now(), signal());
      sql(path, db => db.exec(mutate));
      await assert.rejects(store.read(signal()));
      store.close(); assert.throws(() => SqliteSubjectStore.open(path, signal()));
    });
  }
});

test("full-batch core capacity and serialized byte limits reject without charge or partial memory", async () => {
  await fixture(async store => {
    await awake(store); const g = await accept(store);
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /capacity/);
    assert.equal((await store.read(signal())).experiences.length, 0);
    assert.equal((await store.budget(signal())).reserved, 0);
    const b = batch("large");
    const huge = { ...b, fragments: Array.from({ length: 4 }, (_, i) => ({ ...b.fragments[0]!, entryId: `e_${i}`, text: "汉".repeat(4000) })) };
    await assert.rejects(store.authorizeConversation(huge, "binding", expiry(), signal()), /capacity/);
  }, 999);
});

test("v2/v3 reject every host entry point and exclusive v4 creation never migrates existing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-no-host-migration-"));
  try {
    for (const version of [2, 3]) {
      const path = join(dir, `${version}.sqlite`); const base = createInitialState("dawn", "Dawn", initialAt);
      const store = version === 2 ? SqliteSubjectStore.create(path, base, 6, signal()) : SqliteSubjectStore.createLearning(path, base, 6, pack, 4, signal());
      try {
        assert.equal(store.supportsHostImport, false);
        await assert.rejects(store.authorizeConversation(batch(), "binding", expiry(), signal()), /v4/);
        await assert.rejects(store.acceptConversation(batch(), "grant", "binding", signal()), /v4/);
        await assert.rejects(store.consumeConversation("batch", "grant", "binding", now(), signal()), /v4/);
        await assert.rejects(store.conversationImportStatus("batch", "binding", signal()), /v4/);
        await assert.rejects(store.revokeConversation("grant", "binding", signal()), /v4/);
        assert.throws(() => SqliteSubjectStore.createHostLearning(path, base, 6, pack, 4, signal()), /EEXIST/);
        sql(path, db => assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, version));
        assert.deepEqual(await store.read(signal()), base);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sleep atomically revokes all host grants, wake cannot revive them, and pack authorization survives", async () => {
  await fixture(async (store, path) => {
    await awake(store); const g = await accept(store);
    sql(path, db => db.exec(`CREATE TRIGGER fail_sleep BEFORE INSERT ON events WHEN NEW.revision = 2
      BEGIN SELECT RAISE(ABORT, 'synthetic sleep failure'); END;`));
    await assert.rejects(store.changeLifecycle(1, "sleeping", now(), signal()), /synthetic sleep failure/);
    assert.equal((await store.authorizeConversation(batch(), "binding", expiry(), signal())).status, "active");
    sql(path, db => db.exec("DROP TRIGGER fail_sleep"));
    await store.changeLifecycle(1, "sleeping", now(), signal());
    await store.changeLifecycle(2, "awake", now(), signal());
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /revoked/);
    assert.equal((await store.learningStatus(signal()))?.status, "active");
    store.close(); const reopened = SqliteSubjectStore.open(path, signal());
    try {
      await assert.rejects(reopened.consumeConversation("batch", g.grantId, "binding", now(), signal()), /revoked/);
      const study = await reopened.reserveLearning("one", "study", 3, signal());
      await reopened.failLearning(study, signal());
    } finally { reopened.close(); }
  });
});

test("already sleeping control also revokes grants accepted while asleep; cancellation never writes", async () => {
  await fixture(async store => {
    const g = await accept(store);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(store.revokeConversation(g.grantId, "binding", abort.signal));
    assert.equal((await store.authorizeConversation(batch(), "binding", expiry(), signal())).status, "active");
    await store.changeLifecycle(0, "sleeping", now(), signal());
    assert.equal((await store.read(signal())).revision, 0);
    assert.equal((await store.authorizeConversation(batch(), "binding", expiry(), signal())).status, "revoked");
  });
});

test("host source quota rejects source 1001 without partial batch acceptance", async () => {
  await fixture(async (store, path) => {
    // Exercise the helper under an explicit transaction to avoid quadratic domain replay in this quota fixture.
    // Production callers still use the single SqliteSubjectStore transaction owner.
    const { SqliteConversationLedger } = await import("../src/adapters/storage/sqlite-conversation.ts");
    const db = new DatabaseSync(path);
    try {
      const state = await store.read(signal()); const host = new SqliteConversationLedger(db); const ledger = host.validate(state);
      for (let i = 0; i < 63; i++) {
        const b = batch(`quota_${i}`);
        const many = { ...b, fragments: Array.from({ length: i === 62 ? 8 : 16 }, (_, j) => ({ ...b.fragments[0]!, entryId: `entry_${i}_${j}` })) };
        db.exec("BEGIN IMMEDIATE");
        try {
          const g = host.authorize(ledger, many, "binding", expiry());
          host.accept(ledger, state, many, g.grantId, "binding"); db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      const b = batch("overflow"); const g = await store.authorizeConversation(b, "binding", expiry(), signal());
      await assert.rejects(store.acceptConversation(b, g.grantId, "binding", signal()), /capacity/);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_records").get()?.n, 1000);
      assert.equal(await store.conversationImportStatus("overflow", "binding", signal()), undefined);
    } finally { db.close(); }
  });
});

test("host grant quota is bounded at 1000 and corrupt table constraints are rejected on cold open", async () => {
  await fixture(async (store, path) => {
    const { SqliteConversationLedger } = await import("../src/adapters/storage/sqlite-conversation.ts");
    const db = new DatabaseSync(path);
    try {
      const state = await store.read(signal()); const host = new SqliteConversationLedger(db); const ledger = host.validate(state);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < 1000; i++) host.authorize(ledger, batch(`g_${i}`), "binding", expiry());
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      await assert.rejects(store.authorizeConversation(batch("overflow"), "binding", expiry(), signal()), /capacity/);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_grants").get()?.n, 1000);
    } finally { db.close(); }
  });
  await fixture(async (store, path) => {
    store.close();
    sql(path, db => db.exec("ALTER TABLE host_grants ADD COLUMN arbitrary TEXT"));
    assert.throws(() => SqliteSubjectStore.open(path, signal()), /schema/);
  });
});

test("host source UTF8 text has an independent 4MiB ceiling", async () => {
  await fixture(async (store, path) => {
    const { SqliteConversationLedger } = await import("../src/adapters/storage/sqlite-conversation.ts");
    const db = new DatabaseSync(path);
    try {
      const state = await store.read(signal()); const host = new SqliteConversationLedger(db); const ledger = host.validate(state);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < 349; i++) {
          const b = batch(`bytes_${i}`);
          const large = { ...b, fragments: [{ ...b.fragments[0]!, entryId: `large_${i}`, text: "汉".repeat(4000) }] };
          const g = host.authorize(ledger, large, "binding", expiry());
          host.accept(ledger, state, large, g.grantId, "binding");
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      const b = batch("overflow");
      const large = { ...b, fragments: [{ ...b.fragments[0]!, text: "汉".repeat(4000) }] };
      const g = await store.authorizeConversation(large, "binding", expiry(), signal());
      await assert.rejects(store.acceptConversation(large, g.grantId, "binding", signal()), /4MiB/);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_records").get()?.n, 349);
    } finally { db.close(); }
  });
});

test("2MiB snapshot ceiling rolls back all source consumption even with fewer than 1000 core items", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-host-snapshot-"));
  try {
    const base = createInitialState("dawn", "Dawn", initialAt);
    const experiences = Array.from({ length: 140 }, (_, i) => ({ id: `existing_${i}`, subjectId: "dawn", scopeId: base.scopeId,
      kind: "reading" as const, origin: "document" as const, content: "x", topics: [], sourceIds: [], occurredAt: initialAt, recordedAt: initialAt }));
    const initial = { ...base, experiences };
    let remaining = 2 * 1024 * 1024 - 1500 - Buffer.byteLength(JSON.stringify(initial));
    for (const e of experiences) { const extra = Math.min(15999, remaining); e.content += "x".repeat(extra); remaining -= extra; }
    assert.equal(remaining, 0);
    const store = SqliteSubjectStore.createHostLearning(join(dir, "subject.sqlite"), initial, 6, pack, 4, signal());
    try {
      await awake(store);
      const b = batch(); const large = { ...b, fragments: [{ ...b.fragments[0]!, text: "a".repeat(4000) }] };
      const g = await accept(store, large);
      await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /oversized|size limit/);
      assert.equal((await store.read(signal())).experiences.length, 140);
      assert.equal((await store.conversationImportStatus("batch", "binding", signal()))?.status, "accepted");
      assert.equal((await store.budget(signal())).reserved, 0);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a backwards runtime clock rejects consumption atomically instead of backdating persisted experience", async () => {
  await fixture(async store => {
    const g = await accept(store);
    mock.timers.tick(1000);
    await awake(store);
    const before = await store.read(signal());
    mock.timers.setTime(Date.UTC(2026, 0, 2) + 500);
    await assert.rejects(store.consumeConversation("batch", g.grantId, "binding", now(), signal()), /predates subject state/);
    assert.deepEqual(await store.read(signal()), before);
    assert.equal((await store.conversationImportStatus("batch", "binding", signal()))?.status, "accepted");
    assert.equal((await store.budget(signal())).reserved, 0);
  });
});
