import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { createInitialState } from "../core/state.ts";
import { parseLearningPack } from "../core/learning.ts";
import { SqliteSubjectStore } from "../adapters/storage/sqlite-subject.ts";
import { loadModel } from "../adapters/models/config.ts";
import { learningReport, runAutonomousLearning } from "./learning-runner.ts";

function readPack(path: string) {
  if (!isAbsolute(path)) throw new Error("Explicit absolute learning pack path required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64_000) throw new Error("Learning pack must be a bounded regular file");
    const buffer = Buffer.alloc(64_001);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > 64_000) throw new Error("Learning pack too large");
    return parseLearningPack(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { closeSync(fd); }
}

/** Explicit authorization/foreground execution. No DB upgrade, credential discovery or background launch. */
export async function runLearningCli(args: readonly string[], signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const command = args[0];
  if (!command || !["learning-init", "learning-status", "learning-run", "learning-stop", "learning-recover"].includes(command)) {
    throw new Error("Unknown learning command");
  }
  const allowed = command === "learning-init" ? ["--db", "--id", "--name", "--limit", "--learning-limit", "--pack"]
    : command === "learning-run" ? ["--db", "--model-config"] : ["--db"];
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !allowed.includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Invalid learning options");
    options.set(key, value);
  }
  if (allowed.some(key => !options.has(key))) throw new Error("Explicit learning options required");
  const path = options.get("--db")!;
  if (!isAbsolute(path)) throw new Error("Explicit absolute subject database required");
  let store: SqliteSubjectStore;
  if (command === "learning-init") {
    const limit = options.get("--limit")!, learningLimit = options.get("--learning-limit")!;
    if (!/^[1-9]\d*$/.test(limit) || !/^[1-9]\d*$/.test(learningLimit) || Number(limit) > 10000 ||
        Number(learningLimit) < 2 || Number(learningLimit) > 32 || Number(learningLimit) > Number(limit)) throw new Error("Invalid permanent learning budget");
    const pack = readPack(options.get("--pack")!);
    const initial = createInitialState(options.get("--id")!, options.get("--name")!, new Date().toISOString());
    const state = { ...initial, self: { ...initial.self, concerns: [
      { id: "understanding", description: "理解问题，诚实认识自己的未知", topics: ["学习", "理解", "探索"], weight: 0.7 },
      { id: "connection", description: "尊重边界，保持真诚交流", topics: ["交流", "信任", "陪伴"], weight: 0.7 },
    ] } };
    store = SqliteSubjectStore.createLearning(path, state, Number(limit), pack, Number(learningLimit), signal);
  } else { store = SqliteSubjectStore.open(path, signal); }
  try {
    const authorized = await store.learningStatus(signal);
    if (!authorized) throw new Error("This subject has no explicit learning authorization; no migration performed");
    if (command === "learning-run") {
      // Existing durable pending is not silently recovered: its prior process might still be alive.
      if (authorized.attempts.some(attempt => attempt.status === "pending")) throw new Error("Explicit recovery required after stopping all old runners");
      return await runAutonomousLearning(store, loadModel(options.get("--model-config")!), signal);
    }
    if (command === "learning-stop") await store.stopLearning(signal);
    if (command === "learning-recover") await store.recoverLearning(signal);
    const status = await store.learningStatus(signal);
    if (!status) throw new Error("Missing learning authorization");
    return learningReport(status);
  } finally { store.close(); }
}
