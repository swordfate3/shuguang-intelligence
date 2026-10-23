import { isAbsolute, resolve } from "node:path";
import { SqliteSubjectStore } from "../adapters/storage/sqlite-subject.ts";
import { SqliteSearchStore } from "../adapters/storage/sqlite-search.ts";
import { createSearchProvider } from "../adapters/search/providers.ts";
import { parseSearchConfig, readSearchGrant, readSearchJson } from "./search-config.ts";
import { runAutonomousSearch, searchReport } from "./search-task.ts";

export async function runSearchCli(args: readonly string[], signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const command = args[0];
  const allowed = command === "search-init" ? ["--db", "--subject-db", "--grant"]
    : command === "search-run" ? ["--db", "--subject-db", "--search-config"]
    : ["search-status", "search-results", "search-stop"].includes(command ?? "") ? ["--db"] : undefined;
  if (!allowed) throw new Error("Unknown search command");
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !allowed.includes(key) || options.has(key) || !value || !isAbsolute(value)) throw new Error("Explicit absolute search paths required");
    options.set(key, value);
  }
  if (options.size !== allowed.length) throw new Error("Missing search options");
  const path = options.get("--db")!;
  if (options.get("--subject-db") && resolve(path) === resolve(options.get("--subject-db")!)) throw new Error("Search journal must not be the subject database");
  if (command === "search-init") {
    const grant = readSearchGrant(options.get("--grant")!);
    if (grant.expiresAt <= new Date().toISOString()) throw new Error("Search grant expired");
    const subject = SqliteSubjectStore.open(options.get("--subject-db")!, signal);
    try {
      const state = await subject.read(signal);
      const journal = SqliteSearchStore.create(path, state.self.identity.id, state.scopeId, grant, signal);
      try { return searchReport(await journal.status(signal), new Date().toISOString()); } finally { journal.close(); }
    } finally { subject.close(); }
  }
  const journal = SqliteSearchStore.open(path, signal);
  try {
    if (command === "search-stop") await journal.stop(signal);
    if (command === "search-results") {
      const status = await journal.status(signal);
      return { taskId: status.grant.id, untrustedSearchData: true, knowledgeVerified: false,
        attempts: status.attempts.map(a => ({ queryId: a.queryId, status: a.status, result: a.result })) };
    }
    if (command !== "search-run") return searchReport(await journal.status(signal), new Date().toISOString());
    const status = await journal.status(signal);
    // Closed/failed/pending tasks must not resolve credentials or initiate network I/O.
    const report = searchReport(status, new Date().toISOString()) as { status: string };
    if (report.status === "pending") throw new Error("Pending search exists; no automatic recovery");
    if (report.status !== "active") return report;
    const subject = SqliteSubjectStore.open(options.get("--subject-db")!, signal);
    try {
      const state = await subject.read(signal);
      if (state.self.identity.id !== status.subjectId || state.scopeId !== status.scopeId || state.lifecycle !== "awake") {
        throw new Error("Search requires the authorized awake subject");
      }
      const config = parseSearchConfig(readSearchJson(options.get("--search-config")!, 4096));
      const adapter = createSearchProvider(config, status.grant.provider);
      return await runAutonomousSearch(journal, subject, adapter, signal);
    } finally { subject.close(); }
  } finally { journal.close(); }
}
