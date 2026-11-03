import { constants, fstatSync, openSync, closeSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { SearchProviderPort } from "./search-provider.ts";

/** Pi-side copies of Dawn's public research contract; deliberately no Dawn runtime import. */
export interface ResearchQuestion { readonly id: string; readonly prompt: string; readonly answer: string }
export interface ResearchGoal {
  readonly id: string; readonly question: string; readonly query: string; readonly topics: readonly string[];
  readonly practice: readonly ResearchQuestion[]; readonly assessment: readonly ResearchQuestion[];
}
export interface ResearchPlan {
  readonly version: 1; readonly runId: string; readonly goals: readonly ResearchGoal[];
  readonly maxSearches: number; readonly maxModelCalls: number; readonly expiresAt: string;
}
export interface ResearchTaskSummary {
  readonly runId: string; readonly taskId: string; readonly goalId: string; readonly revision: number;
  readonly capability: "web.search"; readonly status: "queued" | "claimed" | "accepted" | "completed" | "failed" | "unknown";
}
export interface ResearchClaim extends ResearchTaskSummary {
  readonly query: string; readonly claimId: string; readonly fence: number; readonly maxResults: 3; readonly expiresAt: string;
}
export interface ResearchGrade { readonly correct: number; readonly total: number; readonly passed: boolean }
export interface ResearchStatus {
  readonly runId: string; readonly status: "active" | "paused" | "paused_restart" | "stopped" | "completed" | "exhausted";
  readonly revision: number; readonly fence: number; readonly searchReserved: number; readonly modelReserved: number;
  readonly goals: readonly { readonly goalId: string; readonly stage: "unstarted" | ResearchTaskSummary["status"] | "study" | "assessment";
    readonly grade: ResearchGrade | null; readonly verification: "verification_pending" | "passed" | "failed" }[];
  readonly searchesReserved: number; readonly modelCallsReserved: number; readonly maxSearches: number; readonly maxModelCalls: number;
  readonly completedGoals: number; readonly totalGoals: number; readonly allGoalsPassed: boolean; readonly pendingModel: boolean;
  readonly verification: "verification_pending" | "passed" | "failed"; readonly tasks: readonly ResearchTaskSummary[];
}
export interface ResearchReceipt {
  readonly version: 1; readonly receiptId: string; readonly taskId: string; readonly providerId: string;
  readonly retrievedAt: string;
  readonly results: readonly { readonly url: string; readonly title: string; readonly text: string; readonly origin: "document" | "host_summary" }[];
}
export interface ResearchBridgeResponse {
  readonly type: "research"; readonly status: ResearchStatus;
}
export interface ResearchBridgeTaskResponse { readonly type: "research-task"; readonly task: ResearchTaskSummary | null }
export interface ResearchBridgeClaimResponse { readonly type: "research-claim"; readonly claim: ResearchClaim }
export type ResearchBridgeResult = ResearchBridgeResponse | ResearchBridgeTaskResponse | ResearchBridgeClaimResponse | { readonly type: "error"; readonly code: string };
export interface ResearchBridge {
  request(input: { readonly type: "research-status" | "research-next" | "research-step" | "research-pause"; readonly runId: string } |
    { readonly type: "research-claim"; readonly taskId: string; readonly expectedRevision: number } |
    { readonly type: "research-submit"; readonly receipt: ResearchReceipt }, signal?: AbortSignal): Promise<ResearchBridgeResult>;
  readonly signal?: AbortSignal;
  close(): void;
}

const PLAN_FILE_MAX_BYTES = 64 * 1024;
const PLAN_MAX_BYTES = 48 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const MAX_TASKS = 8;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function identifier(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && TIME.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);
}
function plainData(value: unknown): boolean {
  const seen = new Set<object>(); let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 50_000 || depth > 32) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item) && keys.length !== item.length + 1) return false;
    for (const key of keys) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string") return false;
      if (Array.isArray(item) && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(item); return true;
  };
  try { return visit(value, 0); } catch { return false; }
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function validateQuestions(value: unknown, seen: Set<string>, minimum: number): value is ResearchQuestion[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 4) return false;
  for (const raw of value) {
    if (!isRecord(raw) || !exact(raw, ["id", "prompt", "answer"]) || !identifier(raw.id) || seen.has(raw.id) ||
        !boundedText(raw.prompt, 1000) || !boundedText(raw.answer, 256)) return false;
    seen.add(raw.id);
  }
  return true;
}
export function isResearchPlan(value: unknown): value is ResearchPlan {
  try {
    if (!plainData(value) || !isRecord(value) || !exact(value, ["version", "runId", "goals", "maxSearches", "maxModelCalls", "expiresAt"]) ||
        value.version !== 1 || !identifier(value.runId) || !timestamp(value.expiresAt) ||
        !Number.isSafeInteger(value.maxSearches) || (value.maxSearches as number) < 1 || (value.maxSearches as number) > 8 ||
        !Number.isSafeInteger(value.maxModelCalls) || (value.maxModelCalls as number) < 2 || (value.maxModelCalls as number) > 32 ||
        !Array.isArray(value.goals) || value.goals.length < 1 || value.goals.length > MAX_TASKS) return false;
    const seen = new Set<string>();
    for (const raw of value.goals) {
      if (!isRecord(raw) || !exact(raw, ["id", "question", "query", "topics", "practice", "assessment"]) ||
          !identifier(raw.id) || seen.has(raw.id) || !boundedText(raw.question, 1000) || !boundedText(raw.query, 1000) ||
        /[\p{Cc}\p{Cf}\p{Surrogate}]/u.test(raw.query) ||
          !Array.isArray(raw.topics) || raw.topics.length > 6) return false;
      seen.add(raw.id);
      const topics = new Set<string>();
      for (const topic of raw.topics) {
        if (!boundedText(topic, 128) || topics.has(topic)) return false;
        topics.add(topic);
      }
      if (!validateQuestions(raw.practice, seen, 1) || !validateQuestions(raw.assessment, seen, 0)) return false;
    }
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= PLAN_MAX_BYTES;
  } catch { return false; }
}
export function assertResearchPlan(value: unknown): asserts value is ResearchPlan {
  if (!isResearchPlan(value)) throw new Error("研究计划无效或超出限制。");
}

/** Reject duplicate JSON keys before JSON.parse discards evidence of them. */
function rejectDuplicateKeys(source: string): void {
  let at = 0;
  const ws = (): void => { while (/\s/u.test(source[at] ?? "")) at += 1; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const ch = source[at++]!;
      if (ch === "\\") at += 1;
      else if (ch === '"') return JSON.parse(source.slice(start, at)) as string;
    }
    throw new Error();
  };
  const value = (): void => {
    ws(); const ch = source[at];
    if (ch === '"') { string(); return; }
    if (ch === "{") {
      at += 1; ws(); if (source[at] === "}") { at += 1; return; }
      const keys = new Set<string>();
      for (;;) {
        ws(); if (source[at] !== '"') throw new Error();
        const key = string(); if (keys.has(key)) throw new Error(); keys.add(key);
        ws(); if (source[at++] !== ":") throw new Error(); value(); ws();
        const sep = source[at++]; if (sep === "}") return; if (sep !== ",") throw new Error();
      }
    }
    if (ch === "[") {
      at += 1; ws(); if (source[at] === "]") { at += 1; return; }
      for (;;) { value(); ws(); const sep = source[at++]; if (sep === "]") return; if (sep !== ",") throw new Error(); }
    }
    while (at < source.length && !/[\s,\]}]/u.test(source[at]!)) at += 1;
    if (at === 0) throw new Error();
  };
  value(); ws(); if (at !== source.length) throw new Error();
}
/** Explicit absolute regular file; no symlink, foreign owner, writable-by-others or partial reads. */
export function loadResearchPlan(path: string): ResearchPlan {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)) {
    throw new Error("研究计划必须使用有效的绝对文件路径。");
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 2 || stat.size > PLAN_FILE_MAX_BYTES ||
        (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) throw new Error();
    const bytes = Buffer.alloc(PLAN_FILE_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > PLAN_FILE_MAX_BYTES) throw new Error();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    rejectDuplicateKeys(source);
    const parsed: unknown = JSON.parse(source);
    assertResearchPlan(parsed);
    return structuredClone(parsed);
  } catch { throw new Error("研究计划无效、不可读取或不属于当前用户。"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function validateTask(value: unknown): value is ResearchTaskSummary {
  return isRecord(value) && exact(value, ["runId", "taskId", "goalId", "revision", "capability", "status"]) &&
    identifier(value.runId) && identifier(value.taskId) && identifier(value.goalId) && Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 && value.capability === "web.search" &&
    ["queued", "claimed", "accepted", "completed", "failed", "unknown"].includes(String(value.status));
}
export function isResearchStatus(value: unknown): value is ResearchStatus {
  if (!isRecord(value) || !exact(value, ["runId", "status", "revision", "fence", "searchReserved", "modelReserved", "goals", "searchesReserved", "modelCallsReserved", "maxSearches", "maxModelCalls", "completedGoals", "totalGoals", "allGoalsPassed", "pendingModel", "verification", "tasks"])) return false;
  const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): boolean => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
  if (!identifier(value.runId) || !["active", "paused", "paused_restart", "stopped", "completed", "exhausted"].includes(String(value.status)) ||
      !integer(value.revision) || !integer(value.fence) || !integer(value.maxSearches, 1, 8) || !integer(value.maxModelCalls, 2, 32) ||
      !integer(value.searchReserved, 0, value.maxSearches as number) || !integer(value.modelReserved, 0, value.maxModelCalls as number) ||
      value.searchReserved !== value.searchesReserved || value.modelReserved !== value.modelCallsReserved ||
      !integer(value.totalGoals, 1, 8) || !integer(value.completedGoals, 0, value.totalGoals as number) || typeof value.allGoalsPassed !== "boolean" || typeof value.pendingModel !== "boolean" ||
      !["verification_pending", "passed", "failed"].includes(String(value.verification)) || !Array.isArray(value.goals) ||
      value.goals.length !== value.totalGoals || !Array.isArray(value.tasks) || value.tasks.length > 8 || !value.tasks.every(validateTask)) return false;
  for (const item of value.goals) {
    if (!isRecord(item) || !exact(item, ["goalId", "stage", "grade", "verification"]) || !identifier(item.goalId) ||
        !["unstarted", "queued", "claimed", "accepted", "completed", "failed", "unknown", "study", "assessment"].includes(String(item.stage)) ||
        !["verification_pending", "passed", "failed"].includes(String(item.verification))) return false;
    if (item.grade !== null) {
      if (!isRecord(item.grade) || !exact(item.grade, ["correct", "total", "passed"]) || !integer(item.grade.total, 1, 4) ||
          !integer(item.grade.correct, 0, item.grade.total as number) || item.grade.passed !== (item.grade.correct === item.grade.total)) return false;
    }
  }
  return true;
}
export function assertResearchStatus(value: unknown): asserts value is ResearchStatus {
  if (!isResearchStatus(value)) throw new Error("无效的研究状态响应。");
}
export function assertResearchClaim(value: unknown): asserts value is ResearchClaim {
  if (!isRecord(value) || !exact(value, ["runId", "taskId", "goalId", "revision", "capability", "status", "query", "claimId", "fence", "maxResults", "expiresAt"]) ||
      !validateTask({ runId: value.runId, taskId: value.taskId, goalId: value.goalId, revision: value.revision, capability: value.capability, status: value.status }) ||
      value.status !== "claimed" || !boundedText(value.query, 1000) || !identifier(value.claimId) ||
      !Number.isSafeInteger(value.fence) || (value.fence as number) < 0 || value.maxResults !== 3 || !timestamp(value.expiresAt)) {
    throw new Error("无效的研究领取响应。");
  }
}
export function assertResearchReceipt(value: unknown): asserts value is ResearchReceipt {
  if (!isRecord(value) || !exact(value, ["version", "receiptId", "taskId", "providerId", "retrievedAt", "results"]) ||
      value.version !== 1 || !identifier(value.receiptId) || !identifier(value.taskId) || !identifier(value.providerId) ||
      !timestamp(value.retrievedAt) || !Array.isArray(value.results) || value.results.length > 3) throw new Error("无效的检索收据。");
  let chars = 0;
  for (const raw of value.results) {
    if (!isRecord(raw) || !exact(raw, ["url", "title", "text", "origin"]) || !boundedText(raw.url, 2048) ||
        !/^https:\/\/[^\s]+$/u.test(raw.url) || /https:\/\/[^/]*@/u.test(raw.url) || !boundedText(raw.title, 512) ||
        !boundedText(raw.text, 16000) || !["document", "host_summary"].includes(String(raw.origin))) throw new Error("无效的检索收据。");
    chars += raw.url.length + raw.title.length + raw.text.length;
  }
  if (chars > 16000 || Buffer.byteLength(value.results.map((r: any) => r.url + r.title + r.text).join(""), "utf8") > 32768) {
    throw new Error("检索收据超出限制。");
  }
}

export function researchPlanPreview(plan: ResearchPlan, providerName: string, modelDisclosure: string): string {
  assertResearchPlan(plan);
  // Public query text is shown exactly. Practice and held-out answer keys are deliberately omitted.
  return JSON.stringify({
    runId: plan.runId,
    goals: plan.goals.map(goal => ({ question: goal.question, query: goal.query, topics: goal.topics })),
    limits: { maxSearches: plan.maxSearches, maxModelCalls: plan.maxModelCalls, expiresAt: plan.expiresAt },
    model: modelDisclosure,
    searchProvider: providerName,
    billing: "研究模型阶段共享曙光主体永久模型额度；失败和不确定的已预占调用不退款、不自动重派。搜索在领取后单次调用；失败/未知不自动重试。",
    assessment: "独立测验答案保存在私有计划中，不展示在此预览、Pi transcript或宿主模型上下文。",
  }, null, 2);
}

export interface ResearchLoopOptions {
  readonly bridge: ResearchBridge;
  readonly provider: SearchProviderPort;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly onStatus?: (status: ResearchStatus) => void;
  readonly initialStatus?: ResearchStatus;
  readonly expiresAt: string;
  readonly now?: () => number;
  readonly pauseOnTimeoutMs?: number;
}
function responseStatus(result: ResearchBridgeResult): ResearchStatus {
  if (result.type !== "research") throw new Error("研究服务暂不可用；未自动重试。");
  assertResearchStatus(result.status);
  return result.status;
}
function safeStatus(options: ResearchLoopOptions, status: ResearchStatus): ResearchStatus {
  assertResearchStatus(status);
  if (status.runId !== options.runId) throw new Error("研究服务响应不匹配。");
  options.onStatus?.(status);
  return status;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = (): void => { cleanup(); reject(new Error("研究任务已取消；不自动重试。")); };
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** Private bounded executor loop. It has no Pi tool registration or model/tool-context access. */
export async function runResearchLoop(options: ResearchLoopOptions): Promise<ResearchStatus> {
  // EOF can happen while no protocol request is pending, including before provider DNS finishes.
  options = { ...options, signal: options.bridge.signal ? AbortSignal.any([options.signal, options.bridge.signal]) : options.signal };
  const now = options.now ?? Date.now;
  const timeoutMs = options.pauseOnTimeoutMs ?? 35_000;
  const request = (input: Parameters<ResearchBridge["request"]>[0]): Promise<ResearchBridgeResult> =>
    options.bridge.request(input, options.signal);
  const pauseBestEffort = async (): Promise<void> => {
    if (options.signal.aborted) return;
    try { await request({ type: "research-pause", runId: options.runId }); } catch { /* no reconnect or retry */ }
  };
  let status = safeStatus(options, options.initialStatus ?? responseStatus(await request({ type: "research-status", runId: options.runId })));
  try {
    while (status.status === "active") {
      options.signal.throwIfAborted();
      if (Date.parse(options.expiresAt) <= now()) throw new Error("研究计划已过期；没有重试未确认任务。");

      // A queued task is the only state authorized to enter claim/search. Claim precharges first.
      const next = await request({ type: "research-next", runId: options.runId });
      if (next.type === "error") throw new Error("研究任务暂不可用；未知任务不会重派。");
      if (next.type !== "research-task") throw new Error("研究服务响应不匹配。");
      if (next.task) {
        if (!validateTask(next.task) || next.task.runId !== options.runId || next.task.status !== "queued") {
          throw new Error("研究任务状态未知；不会再次执行。");
        }
        const claimResult = await request({ type: "research-claim", taskId: next.task.taskId, expectedRevision: next.task.revision });
        if (claimResult.type !== "research-claim") throw new Error("研究任务领取失败；不会重派。");
        assertResearchClaim(claimResult.claim);
        if (claimResult.claim.taskId !== next.task.taskId || claimResult.claim.runId !== options.runId) throw new Error("研究领取响应不匹配。");
        // Any error/EOF after claim is an unknown external operation; never retry this search.
        const remaining = Date.parse(claimResult.claim.expiresAt) - now();
        if (remaining <= 0) throw new Error("研究领取已过期；不派发搜索。");
        const deadline = new AbortController();
        const deadlineTimer = setTimeout(() => deadline.abort(), Math.min(remaining, 600_000));
        let material: Awaited<ReturnType<SearchProviderPort["search"]>>;
        try {
          material = await options.provider.search({ query: claimResult.claim.query, maxResults: claimResult.claim.maxResults,
            signal: AbortSignal.any([options.signal, deadline.signal]) });
          if (deadline.signal.aborted || now() >= Date.parse(claimResult.claim.expiresAt)) throw new Error("研究领取已过期；不接收迟到材料。");
        } finally { clearTimeout(deadlineTimer); deadline.abort(); }
        options.signal.throwIfAborted();
        const receipt: ResearchReceipt = {
          version: 1, receiptId: randomUUID(), taskId: claimResult.claim.taskId,
          providerId: material.providerId, retrievedAt: material.retrievedAt,
          results: material.results.map(item => ({ url: item.url, title: item.title, text: item.text, origin: item.origin })),
        };
        assertResearchReceipt(receipt);
        responseStatus(await request({ type: "research-submit", receipt }));
        status = safeStatus(options, responseStatus(await request({ type: "research-status", runId: options.runId })));
        continue;
      }

      status = safeStatus(options, responseStatus(await request({ type: "research-status", runId: options.runId })));
      if (status.status !== "active") break;
      if (status.pendingModel) {
        const stepStart = now();
        do {
          options.signal.throwIfAborted();
          if (now() - stepStart >= timeoutMs) throw new Error("曙光研究阶段超时；费用可能已预占，未提交结果不重派。");
          await wait(1000, options.signal); // at most one poll per second
          status = safeStatus(options, responseStatus(await request({ type: "research-status", runId: options.runId })));
        } while (status.status === "active" && status.pendingModel);
        continue;
      }

      // The accepted receipt remains the task's status after study; phase/stage is not a pending flag.
      const accepted = status.tasks.find(task => task.status === "accepted");
      if (accepted) {
        const beforeReserved = status.modelReserved;
        const result = responseStatus(await request({ type: "research-step", runId: options.runId }));
        status = safeStatus(options, result);
        if (status.pendingModel) {
          const stepStart = now();
          while (status.status === "active" && status.pendingModel) {
            options.signal.throwIfAborted();
            if (now() - stepStart >= timeoutMs) throw new Error("曙光研究阶段超时；费用可能已预占，未提交结果不重派。");
            await wait(1000, options.signal);
            status = safeStatus(options, responseStatus(await request({ type: "research-status", runId: options.runId })));
          }
        } else if (status.status === "active" && status.modelReserved <= beforeReserved) {
          // A fast phase can commit before its ACK. Only absence of a new durable reservation is failure.
          throw new Error("曙光未能预占研究模型阶段；不会重复派发。");
        }
        continue;
      }

      const unknown = status.tasks.some(task => task.status === "claimed" || task.status === "unknown");
      if (unknown) throw new Error("研究任务执行状态未知；不自动重派或续费。");
      if (status.status !== "active" || status.completedGoals >= status.totalGoals ||
          (status.tasks.length > 0 && status.tasks.every(task => task.status === "completed" || task.status === "failed"))) break;
      await wait(1000, options.signal);
    }
    return status;
  } catch (error) {
    await pauseBestEffort();
    throw error;
  }
}

/** UI-safe facts only; never include private answers, notes, queries, receipts or full status internals. */
export function summarizeResearchStatus(status: ResearchStatus): string {
  assertResearchStatus(status);
  return `研究 ${status.runId}：${status.status}；目标 ${status.completedGoals}/${status.totalGoals}；搜索预占 ${status.searchReserved}/${status.maxSearches}；模型调用预占 ${status.modelReserved}/${status.maxModelCalls}；验证 ${status.verification}。`;
}

export const RESEARCH_PLAN_MAX_BYTES = PLAN_MAX_BYTES;
export const RESEARCH_PLAN_FILE_MAX_BYTES = PLAN_FILE_MAX_BYTES;
export const RESEARCH_FIXED_PROVIDER = "tavily" as const;
export function newResearchRequestId(): string { return randomUUID(); }
export function canonicalResearchTime(value: number): string { return new Date(value).toISOString(); }
