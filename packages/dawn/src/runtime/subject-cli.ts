import { isAbsolute } from "node:path";
import { createInitialState } from "../core/state.ts";
import { SqliteSubjectStore } from "../adapters/storage/sqlite-subject.ts";

/** Explicit new-format commands. No format discovery, migration or adoption of a v1 file. */
export async function runSubjectCli(args: readonly string[], signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const command = args[0];
  if (!command || !["subject-init", "subject-status", "subject-wake", "subject-sleep", "subject-budget"].includes(command)) throw new Error("Invalid subject command");
  const allowed = command === "subject-init" ? ["--db", "--id", "--name", "--limit"]
    : command === "subject-wake" || command === "subject-sleep" ? ["--db", "--revision"] : ["--db"];
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !allowed.includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Invalid subject options");
    options.set(key, value);
  }
  const path = options.get("--db");
  if (!path || !isAbsolute(path)) throw new Error("Explicit absolute subject database required");
  let store: SqliteSubjectStore;
  if (command === "subject-init") {
    const id = options.get("--id"), name = options.get("--name"), rawLimit = options.get("--limit");
    if (!id || !name || !rawLimit || !/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 10000) throw new Error("Explicit identity, name and lifetime limit 1..10000 required");
    const initial = createInitialState(id, name, new Date().toISOString());
    // Explicit bootstrap concerns, not a claim that the subject learned them from experience.
    const state = { ...initial, self: { ...initial.self, concerns: [
      { id: "understanding", description: "理解问题，诚实认识自己的未知", topics: ["学习", "理解", "探索"], weight: 0.7 },
      { id: "connection", description: "尊重边界，保持真诚交流", topics: ["交流", "信任", "陪伴"], weight: 0.7 },
    ] } };
    store = SqliteSubjectStore.create(path, state, Number(rawLimit), signal);
  } else { store = SqliteSubjectStore.open(path, signal); }
  try {
    if (command === "subject-budget") return { budget: await store.budget(signal), autonomy: false };
    const current = await store.read(signal);
    let state = current;
    if (command === "subject-wake" || command === "subject-sleep") {
      const revision = options.get("--revision");
      if (!revision || !/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error("Explicit safe revision required");
      state = await store.changeLifecycle(Number(revision), command === "subject-wake" ? "awake" : "sleeping", new Date().toISOString(), signal);
    }
    return { schemaVersion: state.schemaVersion, subjectId: state.self.identity.id, name: state.self.identity.name,
      revision: state.revision, lifecycle: state.lifecycle, updatedAt: state.updatedAt,
      experiences: state.experiences.length, memories: state.memory.records.length, beliefs: state.cognition.beliefs.length,
      growthCandidates: state.growth.proposals.filter(p => p.status === "candidate").length,
      bootstrapConcerns: state.self.concerns.map(c => c.id), autonomy: false };
  } finally { store.close(); }
}
