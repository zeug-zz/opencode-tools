#!/usr/bin/env bun
/**
 * Native Claude retry acceptance gate for the installed OpenCode 2.2.6 host.
 * Uses OPENCODE_CLAUDE_PATH to inject a local stream-json CLI; never contacts a
 * provider. All persisted evidence is categorical and content-free.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("project_root_not_found");
    current = parent;
  }
}

const ROOT = findRepoRoot(SCRIPT_DIR);
const OPENCODE = "/opt/homebrew/Cellar/opencode-v2/2.2.6/bin/opencode";
const EXPECTED_VERSION = "opencode v2.2.6";
const PROVIDER = "claude-agent";
const MODEL = "claude-sonnet-4-5";
const GRACE_MS = 60_000;
const TIMER_MAX_MS = 2_147_483_647;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SUCCESS_CASE_BOUND_MS = 90_000;
const INTERRUPT_CASE_BOUND_MS = 30_000;
const NEGATIVE_CASE_BOUND_MS = 15_000;
const OVERALL_BOUND_MS = 300_000;
const SUCCESS_SENTINEL = "SYNTHETIC_GATE_SUCCESS_6_3";

type Verdict = "PASS" | "FAIL" | "BLOCKED";
type SafeRecord = Record<string, unknown>;
type ScenarioID =
  | "combined_success"
  | "rate_limit_no_type_interrupt"
  | "assistant_error_no_reset"
  | "overload"
  | "authentication"
  | "billing"
  | "weekly_reset";
type EventForm = "combined" | "rate_limit_event" | "assistant.error";

type Scenario = {
  id: ScenarioID;
  form: EventForm;
  rateLimitType?: "five_hour" | "seven_day";
  resetOffsetMs?: number;
  statusCode?: 401 | 429 | 529;
  succeedsAfterRetry?: boolean;
  interruptsPendingWait?: boolean;
  expectedCategory: string;
  boundMs: number;
};

const SCENARIOS: readonly Scenario[] = [
  {
    id: "combined_success",
    form: "combined",
    rateLimitType: "five_hour",
    resetOffsetMs: 3_000,
    succeedsAfterRetry: true,
    expectedCategory: "session_limit_five_hour_future_reset",
    boundMs: SUCCESS_CASE_BOUND_MS,
  },
  {
    id: "rate_limit_no_type_interrupt",
    form: "rate_limit_event",
    resetOffsetMs: TWO_HOURS_MS,
    interruptsPendingWait: true,
    expectedCategory: "session_limit_no_type_future_reset",
    boundMs: INTERRUPT_CASE_BOUND_MS,
  },
  {
    id: "assistant_error_no_reset",
    form: "assistant.error",
    expectedCategory: "session_limit_no_reset",
    boundMs: NEGATIVE_CASE_BOUND_MS,
  },
  {
    id: "overload",
    form: "assistant.error",
    statusCode: 529,
    expectedCategory: "overload",
    boundMs: NEGATIVE_CASE_BOUND_MS,
  },
  {
    id: "authentication",
    form: "assistant.error",
    statusCode: 401,
    expectedCategory: "authentication",
    boundMs: NEGATIVE_CASE_BOUND_MS,
  },
  {
    id: "billing",
    form: "assistant.error",
    expectedCategory: "billing",
    boundMs: NEGATIVE_CASE_BOUND_MS,
  },
  {
    id: "weekly_reset",
    form: "combined",
    rateLimitType: "seven_day",
    resetOffsetMs: WEEK_MS,
    expectedCategory: "session_limit_weekly_reset",
    boundMs: NEGATIVE_CASE_BOUND_MS,
  },
];

export type SafeNativeObservation = {
  phase: "before_product" | "after_product";
  providerID: "claude-agent" | "other";
  modelID: typeof MODEL | "other";
  attempt?: number;
  errorType: "provider.unknown" | "provider.rate-limit" | "provider.quota" | "provider.authentication" | "other" | "absent";
  statusCode?: number;
  messageCategory: string;
  resetStatus: "absent" | "future" | "stale" | "invalid";
  resetHorizonBucket: "under_one_minute" | "under_six_hours" | "over_six_hours" | "absent_or_invalid";
  decisionRetry?: boolean;
  decisionDelayMs?: number;
  graceAndStaggerMs?: number;
};

function isRecord(value: unknown): value is SafeRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resetTimestampFromMessage(message: unknown): number | undefined {
  if (typeof message !== "string" || message.length > 64 * 1024) return undefined;
  const match = /\bResets at ((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\./.exec(message);
  if (!match) return undefined;
  const value = Date.parse(match[1]);
  if (!Number.isFinite(value) || new Date(value).toISOString() !== match[1]) return undefined;
  return value;
}

/** Return only approved categorical and timing fields; never return raw text. */
export function summarizeNativeMessage(message: unknown, statusCode: unknown, nowMs: number): Pick<SafeNativeObservation,
  "messageCategory" | "resetStatus" | "resetHorizonBucket"> {
  if (typeof message !== "string") {
    return { messageCategory: "other", resetStatus: "absent", resetHorizonBucket: "absent_or_invalid" };
  }
  const prefix = message.startsWith("Claude Code subscription limit reached");
  const resetMatch = /\bResets at ((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\./.exec(message);
  const reset = resetTimestampFromMessage(message);
  const resetStatus: SafeNativeObservation["resetStatus"] = !resetMatch
    ? "absent"
    : reset === undefined ? "invalid" : reset > nowMs ? "future" : "stale";
  const horizon = reset !== undefined && reset > nowMs ? reset - nowMs : undefined;
  const resetHorizonBucket: SafeNativeObservation["resetHorizonBucket"] = horizon === undefined
    ? "absent_or_invalid"
    : horizon < 60_000 ? "under_one_minute"
      : horizon <= SIX_HOURS_MS ? "under_six_hours" : "over_six_hours";
  const typeMatch = /^Claude Code subscription limit reached \(([^)]+)\)/.exec(message);
  const resetType = typeMatch?.[1]?.toLowerCase();
  let messageCategory = "other";
  if (prefix) {
    if (resetStatus === "absent") messageCategory = "session_limit_no_reset";
    else if (resetStatus !== "future") messageCategory = "session_limit_invalid_or_stale_reset";
    else if (resetType === "five hour") messageCategory = "session_limit_five_hour_future_reset";
    else if (!resetType) messageCategory = "session_limit_no_type_future_reset";
    else if (resetType === "seven day" || resetType === "seven day opus") messageCategory = "session_limit_weekly_reset";
    else messageCategory = "session_limit_other_class_future_reset";
  } else if (statusCode === 529 || /Anthropic is overloaded|overloaded \(529\)/i.test(message)) {
    messageCategory = "overload";
  } else if (statusCode === 401 || /HTTP 401|authentication failed|unauthorized/i.test(message)) {
    messageCategory = "authentication";
  } else if (/billing|extra-usage settings|Claude plan/i.test(message)) {
    messageCategory = "billing";
  }
  return { messageCategory, resetStatus, resetHorizonBucket };
}

/**
 * Safe hook snapshot used by both installed-host observers and provider-free
 * tests. The raw native message is inspected transiently and is never returned.
 */
export function safeNativeObservation(event: unknown, phase: SafeNativeObservation["phase"], nowMs = Date.now()): SafeNativeObservation {
  const value = isRecord(event) ? event : {};
  const model = isRecord(value.model) ? value.model : {};
  const error = isRecord(value.error) ? value.error : {};
  const decision = isRecord(value.decision) ? value.decision : {};
  const response = isRecord(error.response) ? error.response : {};
  const statusCandidate = error.status ?? response.status_code;
  const statusCode = Number.isInteger(statusCandidate) && Number(statusCandidate) >= 100 && Number(statusCandidate) <= 599
    ? Number(statusCandidate) : undefined;
  const summary = summarizeNativeMessage(error.message, statusCode, nowMs);
  const decisionDelayMs = typeof decision.delay === "number" && Number.isFinite(decision.delay)
    && decision.delay >= 0 && decision.delay <= TIMER_MAX_MS ? decision.delay : undefined;
  const reset = resetTimestampFromMessage(error.message);
  const graceAndStaggerMs = reset !== undefined && decisionDelayMs !== undefined
    ? decisionDelayMs - (reset - nowMs) : undefined;
  const safeType = error.type === "provider.unknown" || error.type === "provider.rate-limit"
    || error.type === "provider.quota" || error.type === "provider.authentication"
    ? error.type : error.type === undefined ? "absent" : "other";
  return {
    phase,
    providerID: model.providerID === PROVIDER ? PROVIDER : "other",
    modelID: model.id === MODEL ? MODEL : "other",
    ...(Number.isInteger(value.attempt) && Number(value.attempt) >= 0 && Number(value.attempt) <= 100
      ? { attempt: Number(value.attempt) } : {}),
    errorType: safeType,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...summary,
    ...(typeof decision.retry === "boolean" ? { decisionRetry: decision.retry } : {}),
    ...(decisionDelayMs === undefined ? {} : { decisionDelayMs }),
    ...(graceAndStaggerMs === undefined || !Number.isFinite(graceAndStaggerMs) ? {} : { graceAndStaggerMs }),
  };
}

export function isPositiveOverride(before: SafeNativeObservation | undefined, after: SafeNativeObservation | undefined): boolean {
  return before?.phase === "before_product" && before.decisionRetry === false
    && after?.phase === "after_product" && after.decisionRetry === true
    && typeof after.decisionDelayMs === "number" && Number.isFinite(after.decisionDelayMs)
    && after.decisionDelayMs <= TIMER_MAX_MS;
}

export function isUnchangedNegative(before: SafeNativeObservation | undefined, after: SafeNativeObservation | undefined): boolean {
  return before?.phase === "before_product" && after?.phase === "after_product"
    && before.decisionRetry === false && after.decisionRetry === false
    && before.decisionDelayMs === after.decisionDelayMs;
}

class GateError extends Error {
  constructor(readonly verdict: Exclude<Verdict, "PASS">, readonly code: string) {
    super(code);
  }
}

function blocked(code: string): never {
  throw new GateError("BLOCKED", code);
}

function failed(code: string): never {
  throw new GateError("FAIL", code);
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function safeRelative(path: string): string {
  const rel = relative(ROOT, path);
  if (rel.startsWith("..") || resolve(ROOT, rel) !== resolve(path)) blocked("evidence_path_outside_project");
  return toPosixPath(rel);
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileHashIfAvailable(path: string): Promise<string | undefined> {
  try { return await sha256File(path); } catch { return undefined; }
}

async function versionOfInstalledOpenCode(): Promise<{ code: number | null; text: string }> {
  return await new Promise((resolveResult) => {
    let child: ChildProcess;
    try {
      child = spawn(OPENCODE, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolveResult({ code: null, text: "unavailable" });
      return;
    }
    let text = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolveResult({ code: null, text: "timeout" });
    }, 5_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { text += chunk.slice(0, 128); });
    child.once("error", () => {
      clearTimeout(timer);
      resolveResult({ code: null, text: "unavailable" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code, text: text.trim() });
    });
  });
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") blocked("loopback_port_unavailable");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
  }
}

function providerPackage(value: unknown, depth = 0): string {
  if (depth > 5 || !value || typeof value !== "object") return "unknown";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = providerPackage(item, depth + 1);
      if (found !== "unknown") return found;
    }
    return "unknown";
  }
  const record = value as SafeRecord;
  if (record.id === PROVIDER) {
    return record.package === "@opencode/claude-agent" || record.package === "aisdk:@opencode/claude-agent"
      ? "native_sdk" : typeof record.package === "string" ? "other_package" : "missing_package";
  }
  for (const child of Object.values(record)) {
    const found = providerPackage(child, depth + 1);
    if (found !== "unknown") return found;
  }
  return "unknown";
}

function hasConfiguredModel(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasConfiguredModel(item, depth + 1));
  const record = value as SafeRecord;
  if (record.providerID === PROVIDER && record.id === MODEL) return true;
  return Object.values(record).some((item) => hasConfiguredModel(item, depth + 1));
}

function observerPluginSource(phase: "before_product" | "after_product", scenario: Scenario, evidencePath: string): string {
  const id = phase === "before_product" ? "task-6-3-before-product" : "task-6-3-after-product";
  const maybeImport = phase === "after_product"
    ? `import { applyClaudeSessionLimitRetryHook } from "../lib/claude-session-limit-retry.ts";`
    : "";
  const wrongProvider = phase === "after_product" ? `
      if (CASE === "combined_success" && safe.messageCategory === "session_limit_five_hour_future_reset" && !wrongProviderRecorded) {
        wrongProviderRecorded = true;
        const nativeError = value.error && typeof value.error === "object" ? value.error : {};
        const clone = {
          model: { providerID: "openai", id: "synthetic-other-provider" },
          error: { message: typeof nativeError.message === "string" ? nativeError.message : "" },
          decision: { retry: false },
        };
        const changed = applyClaudeSessionLimitRetryHook(clone);
        append({ kind: "wrong-provider-clone", case: CASE, coverage: "native_event_clone_unit_negative_only",
          promoted: changed, decisionUnchanged: clone.decision.retry === false });
      }` : "";
  return `${maybeImport}
import { appendFileSync } from "node:fs";
const CASE = ${JSON.stringify(scenario.id)};
const PHASE = ${JSON.stringify(phase)};
const OUTPUT = ${JSON.stringify(evidencePath)};
let wrongProviderRecorded = false;
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const append = (value) => {
  try { appendFileSync(OUTPUT, JSON.stringify(value) + "\\n", { mode: 0o600 }); } catch {}
};
const summarize = (event) => {
  const value = isRecord(event) ? event : {};
  const model = isRecord(value.model) ? value.model : {};
  const error = isRecord(value.error) ? value.error : {};
  const decision = isRecord(value.decision) ? value.decision : {};
  const response = isRecord(error.response) ? error.response : {};
  const message = error.message;
  const statusCandidate = error.status ?? response.status_code;
  const statusCode = Number.isInteger(statusCandidate) && statusCandidate >= 100 && statusCandidate <= 599 ? statusCandidate : undefined;
  const prefix = typeof message === "string" && message.startsWith("Claude Code subscription limit reached");
  const resetMatch = typeof message === "string" ? /\\bResets at ((?:\\d{4}|[+-]\\d{6})-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\./.exec(message) : null;
  const reset = resetMatch ? Date.parse(resetMatch[1]) : undefined;
  const resetStatus = !resetMatch ? "absent" : !Number.isFinite(reset) ? "invalid" : reset > Date.now() ? "future" : "stale";
  const typeMatch = typeof message === "string" ? /^Claude Code subscription limit reached \\(([^)]+)\\)/.exec(message) : null;
  const resetType = typeMatch?.[1]?.toLowerCase();
  let messageCategory = "other";
  if (prefix) {
    if (resetStatus === "absent") messageCategory = "session_limit_no_reset";
    else if (resetStatus !== "future") messageCategory = "session_limit_invalid_or_stale_reset";
    else if (resetType === "five hour") messageCategory = "session_limit_five_hour_future_reset";
    else if (!resetType) messageCategory = "session_limit_no_type_future_reset";
    else if (resetType === "seven day" || resetType === "seven day opus") messageCategory = "session_limit_weekly_reset";
    else messageCategory = "session_limit_other_class_future_reset";
  } else if (statusCode === 529 || (typeof message === "string" && /Anthropic is overloaded|overloaded \\(529\\)/i.test(message))) messageCategory = "overload";
  else if (statusCode === 401 || (typeof message === "string" && /HTTP 401|authentication failed|unauthorized/i.test(message))) messageCategory = "authentication";
  else if (typeof message === "string" && /billing|extra-usage settings|Claude plan/i.test(message)) messageCategory = "billing";
  const decisionDelayMs = typeof decision.delay === "number" && Number.isFinite(decision.delay) && decision.delay >= 0 && decision.delay <= ${TIMER_MAX_MS}
    ? decision.delay : undefined;
  const errorType = error.type === undefined ? "absent"
    : ["provider.unknown", "provider.rate-limit", "provider.quota", "provider.authentication"].includes(error.type) ? error.type : "other";
  const horizon = Number.isFinite(reset) && reset > Date.now() ? reset - Date.now() : undefined;
  const resetHorizonBucket = horizon === undefined ? "absent_or_invalid"
    : horizon < 60000 ? "under_one_minute" : horizon <= ${SIX_HOURS_MS} ? "under_six_hours" : "over_six_hours";
  const graceAndStaggerMs = Number.isFinite(reset) && decisionDelayMs !== undefined ? decisionDelayMs - (reset - Date.now()) : undefined;
  return {
    kind: "retry-hook", case: CASE, phase: PHASE,
    providerID: model.providerID === "claude-agent" ? "claude-agent" : "other",
    modelID: model.id === ${JSON.stringify(MODEL)} ? ${JSON.stringify(MODEL)} : "other",
    attempt: Number.isInteger(value.attempt) && value.attempt >= 0 && value.attempt <= 100 ? value.attempt : undefined,
    errorType,
    statusCode,
    messageCategory,
    resetStatus,
    resetHorizonBucket,
    decisionRetry: typeof decision.retry === "boolean" ? decision.retry : undefined,
    decisionDelayMs,
    graceAndStaggerMs: Number.isFinite(graceAndStaggerMs) ? graceAndStaggerMs : undefined,
  };
};
export default {
  id: ${JSON.stringify(id)},
  async setup(ctx) {
    const registration = await ctx.session.hook("retry", (event) => {
      const value = isRecord(event) ? event : {};
      const safe = summarize(value);
      append(safe);
      ${wrongProvider}
    });
    return async () => { await registration.dispose?.(); };
  },
};
`;
}

function syntheticCliSource(scenario: Scenario, statePath: string, evidencePath: string): string {
  return `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const CASE = ${JSON.stringify(scenario.id)};
const FORM = ${JSON.stringify(scenario.form)};
const RATE_LIMIT_TYPE = ${JSON.stringify(scenario.rateLimitType ?? null)};
const RESET_OFFSET_MS = ${JSON.stringify(scenario.resetOffsetMs ?? null)};
const STATUS_CODE = ${JSON.stringify(scenario.statusCode ?? null)};
const SUCCEEDS_AFTER_RETRY = ${JSON.stringify(scenario.succeedsAfterRetry === true)};
const STATE = ${JSON.stringify(statePath)};
const EVIDENCE = ${JSON.stringify(evidencePath)};
const MODEL = ${JSON.stringify(MODEL)};
const SUCCESS_SENTINEL = ${JSON.stringify(SUCCESS_SENTINEL)};
const session = "synthetic-cli-session";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const note = (value) => { try { appendFileSync(EVIDENCE, JSON.stringify(value) + "\\n", { mode: 0o600 }); } catch {} };
let state = { modelRequests: 0, errorResponses: 0, successResponses: 0 };
try { if (existsSync(STATE)) state = { ...state, ...JSON.parse(readFileSync(STATE, "utf8")) }; } catch {}
note({ kind: "synthetic-cli-started", case: CASE });
emit({
  type: "system", subtype: "init", cwd: process.cwd(), session_id: session,
  tools: [], mcp_servers: [], model: MODEL, permissionMode: "dontAsk",
  slash_commands: [], apiKeySource: "ANTHROPIC_API_KEY", tokenSource: "none",
  account: { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY", tokenSource: "none" },
  claude_code_version: "2.1.257", output_style: "default", agents: [], skills: [], plugins: [], uuid: "synthetic-init",
  models: [
    { value: "default", displayName: "Default", supportedEffortLevels: [] },
    { value: MODEL, displayName: "Synthetic Claude Sonnet", supportedEffortLevels: ["high"], contextWindow: 200000, resolvedModel: MODEL },
  ],
});
let input = "";
function emitSuccess(ordinal) {
  state.successResponses += 1;
  writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
  const messageID = "synthetic-success-message-" + ordinal;
  const eventBase = { type: "stream_event", parent_tool_use_id: null, session_id: session,
    uuid: "synthetic-success-stream-" + ordinal };
  emit({ ...eventBase, event: { type: "message_start", message: { id: messageID, type: "message", role: "assistant", model: MODEL,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } });
  emit({ ...eventBase, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  emit({ ...eventBase, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SUCCESS_SENTINEL } } });
  emit({ ...eventBase, event: { type: "content_block_stop", index: 0 } });
  emit({ ...eventBase, event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ ...eventBase, event: { type: "message_stop" } });
  emit({
    type: "assistant", uuid: "synthetic-success-assistant-" + ordinal, session_id: session, parent_tool_use_id: null,
    message: { id: messageID, type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: SUCCESS_SENTINEL }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } },
  });
  emit({ type: "result", subtype: "success", is_error: false, result: SUCCESS_SENTINEL, errors: [], num_turns: 1,
    session_id: session, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: "synthetic-success-result-" + ordinal });
  note({ kind: "synthetic-cli-response", case: CASE, ordinal, outcome: "scripted_success" });
}
function emitFailure(ordinal) {
  const eventTypes = [];
  if (FORM === "rate_limit_event" || FORM === "combined") {
    const resetSeconds = RESET_OFFSET_MS === null ? undefined : Math.floor(Date.now() / 1000) + Math.ceil(RESET_OFFSET_MS / 1000);
    const rateLimitInfo = { status: "rejected", ...(RATE_LIMIT_TYPE === null ? {} : { rateLimitType: RATE_LIMIT_TYPE }), ...(resetSeconds === undefined ? {} : { resetsAt: resetSeconds }) };
    emit({ type: "rate_limit_event", rate_limit_info: rateLimitInfo, uuid: "synthetic-rate-limit-event-" + ordinal, session_id: session });
    eventTypes.push("rate_limit_event");
  }
  if (FORM === "assistant.error" || FORM === "combined") {
    const assistantError = CASE === "overload" ? "overloaded" : CASE === "billing" ? "billing_error"
      : CASE === "authentication" ? "authentication_failed" : "rate_limit";
    emit({ type: "assistant", error: assistantError, parent_tool_use_id: null, session_id: session,
      uuid: "synthetic-assistant-error-" + ordinal,
      message: { id: "synthetic-assistant-message-" + ordinal, type: "message", role: "assistant", model: MODEL,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    eventTypes.push("assistant.error");
  }
  const hasRateLimitEvent = FORM === "rate_limit_event" || FORM === "combined";
  const hasAssistantError = FORM === "assistant.error" || FORM === "combined";
  const hasHttpStatus = STATUS_CODE === 401 || STATUS_CODE === 529 || hasRateLimitEvent;
  const subtype = STATUS_CODE === 401 || STATUS_CODE === 529 ? "success"
    : hasAssistantError ? "error_during_execution" : "success";
  emit({ type: "result", subtype, is_error: true,
    ...(hasHttpStatus ? { api_error_status: STATUS_CODE ?? 429 } : {}), result: "", errors: [], num_turns: 1,
    session_id: session, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: "synthetic-error-result-" + ordinal });
  eventTypes.push("result");
  state.errorResponses += 1;
  writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
  note({ kind: "synthetic-sdk-events", case: CASE, ordinal, eventTypes,
    rateLimitType: RATE_LIMIT_TYPE === null ? "absent" : RATE_LIMIT_TYPE });
}
function processUser() {
  state.modelRequests += 1;
  const ordinal = state.modelRequests;
  writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
  note({ kind: "synthetic-model-request", case: CASE, ordinal });
  if (SUCCEEDS_AFTER_RETRY && ordinal >= 2) emitSuccess(ordinal);
  else emitFailure(ordinal);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\\n");
    if (end < 0) break;
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { note({ kind: "synthetic-cli-input", case: CASE, inputType: "non_json" }); continue; }
    const inputType = message?.type === "user" ? "user" : message?.type === "control_request" ? "control_request"
      : message?.type === "control_response" ? "control_response" : message?.type === "control_cancel_request" ? "control_cancel_request" : "other";
    if (inputType === "control_request" && typeof message.request_id === "string") {
      const subtype = typeof message.request?.subtype === "string" ? message.request.subtype : "none";
      if (subtype === "initialize") {
        emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
          response: { commands: [], agents: [], output_style: "default", available_output_styles: ["default"],
            models: [{ value: "default", displayName: "Default", supportedEffortLevels: [] },
              { value: MODEL, displayName: "Synthetic Claude Sonnet", supportedEffortLevels: ["high"], contextWindow: 200000 }],
            account: { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY", tokenSource: "none" }, claude_code_version: "2.1.257" } } });
        note({ kind: "synthetic-cli-control", case: CASE, control: "initialize_success" });
      } else {
        emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
        note({ kind: "synthetic-cli-control", case: CASE, control: "success" });
      }
      continue;
    }
    note({ kind: "synthetic-cli-input", case: CASE, inputType });
    if (inputType === "user") processUser();
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

type RuntimeStatus = {
  type: "retry" | "busy" | "idle" | "other";
  observedAtMs: number;
  attempt?: number;
  nextEpochMs?: number;
  retryRemainingMs?: number;
};

type EventMonitor = {
  ready: Promise<boolean>;
  statuses: RuntimeStatus[];
  streamEventShapes: SafeRecord[];
  stop: () => Promise<void>;
};

function epochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function startEventMonitor(base: string, auth: string, sessionID: string): EventMonitor {
  const controller = new AbortController();
  const statuses: RuntimeStatus[] = [];
  const streamEventShapes: SafeRecord[] = [];
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolveReadyPromise) => { resolveReady = resolveReadyPromise; });
  const worker = (async () => {
    try {
      const response = await fetch(`${base}/api/event`, { headers: { authorization: auth }, signal: controller.signal });
      resolveReady(response.ok);
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeData = (data: string) => {
        if (!data) return;
        try {
          const envelope: unknown = JSON.parse(data);
          if (!isRecord(envelope)) return;
          const event = isRecord(envelope.event) ? envelope.event : envelope;
          const eventData = isRecord(event.data) ? event.data : {};
          const properties = isRecord(event.properties) ? event.properties : eventData;
          const safeKeys = (value: SafeRecord) => Object.keys(value).filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key)).sort().slice(0, 24);
          const eventType = typeof event.type === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(event.type) ? event.type : "other";
          const statusValue = isRecord(properties.status) ? properties.status : {};
          const statusType = ["retry", "busy", "idle"].includes(String(statusValue.type)) ? String(statusValue.type) : "other";
          const eventSessionID = typeof properties.sessionID === "string" ? properties.sessionID
            : typeof eventData.sessionID === "string" ? eventData.sessionID : undefined;
          const nestedRetry = isRecord(eventData.retry) ? eventData.retry : {};
          const delayCandidate = eventData.delayMs ?? eventData.delay ?? nestedRetry.delayMs ?? nestedRetry.delay;
          const safeDelayMs = typeof delayCandidate === "number" && Number.isFinite(delayCandidate)
            && delayCandidate >= 0 && delayCandidate <= TIMER_MAX_MS ? Math.round(delayCandidate) : undefined;
          streamEventShapes.push({
            outerKeys: safeKeys(envelope),
            eventType,
            eventKeys: safeKeys(event),
            dataKeys: safeKeys(eventData),
            propertiesKeys: safeKeys(properties),
            sessionIDPresent: eventSessionID !== undefined,
            sessionIDMatches: eventSessionID === sessionID,
            statusType,
            ...(safeDelayMs === undefined ? {} : { scheduledDelayMs: safeDelayMs }),
          });
          if (streamEventShapes.length > 64) streamEventShapes.splice(0, streamEventShapes.length - 64);
          if (eventSessionID !== sessionID) return;
          const rawStatus = isRecord(properties.status) ? properties.status : undefined;
          const now = Date.now();
          if (eventType === "session.retry.scheduled") {
            const nextEpochMs = epochMs(eventData.at ?? eventData.next ?? nestedRetry.next);
            const attempt = Number.isInteger(eventData.attempt) && Number(eventData.attempt) >= 0 && Number(eventData.attempt) <= 100
              ? Number(eventData.attempt) : undefined;
            const retryRemainingMs = safeDelayMs ?? (nextEpochMs === undefined ? undefined : nextEpochMs - now);
            statuses.push({ type: "retry", observedAtMs: now, ...(attempt === undefined ? {} : { attempt }),
              ...(nextEpochMs === undefined && retryRemainingMs === undefined ? {} : {
                nextEpochMs: nextEpochMs ?? now + retryRemainingMs!, retryRemainingMs,
              }) });
          } else if (["session.execution.started", "session.step.started"].includes(eventType)) {
            statuses.push({ type: "busy", observedAtMs: now });
          } else if (["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(eventType)) {
            statuses.push({ type: "idle", observedAtMs: now });
          } else if (eventType === "session.status" && rawStatus) {
            const type = rawStatus.type === "retry" || rawStatus.type === "busy" || rawStatus.type === "idle" ? rawStatus.type : "other";
            const nextEpochMs = type === "retry" ? epochMs(rawStatus.next) : undefined;
            const attempt = Number.isInteger(rawStatus.attempt) && Number(rawStatus.attempt) >= 0 && Number(rawStatus.attempt) <= 100
              ? Number(rawStatus.attempt) : undefined;
            statuses.push({ type, observedAtMs: now, ...(attempt === undefined ? {} : { attempt }),
              ...(nextEpochMs === undefined ? {} : { nextEpochMs, retryRemainingMs: nextEpochMs - now }) });
          }
          if (statuses.length > 64) statuses.splice(0, statuses.length - 64);
        } catch {
          // No raw event data is retained.
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) consumeData(line.slice(5).trim());
        }
        if (buffer.length > 128 * 1024) buffer = "";
      }
    } catch {
      resolveReady(false);
    }
  })();
  return {
    ready,
    statuses,
    streamEventShapes,
    async stop() {
      controller.abort();
      await Promise.race([worker, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
    },
  };
}

function safeJsonLines(path: string): SafeRecord[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const decoded: unknown = JSON.parse(line);
        return isRecord(decoded) ? [decoded] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function runtimeStatusesForCase(statuses: RuntimeStatus[]): Array<SafeRecord> {
  return statuses.map((status) => ({
    type: status.type,
    ...(status.attempt === undefined ? {} : { attempt: status.attempt }),
    ...(status.retryRemainingMs === undefined ? {} : { retryRemainingMs: Math.round(status.retryRemainingMs) }),
  }));
}

function lastStatus(statuses: RuntimeStatus[], type?: RuntimeStatus["type"]): RuntimeStatus | undefined {
  return [...statuses].reverse().find((status) => type === undefined || status.type === type);
}

async function waitUntil(deadline: number, predicate: () => boolean): Promise<boolean> {
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return predicate();
}

export function hasPersistedScriptedSuccessText(value: unknown, expected: string): boolean {
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 12 || node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((item) => visit(item, depth + 1));
    const record = node as SafeRecord;
    if (record.type === "text" && record.text === expected) return true;
    return Object.values(record).some((item) => visit(item, depth + 1));
  };
  return visit(value, 0);
}

function persistedMessageSummary(value: unknown, expected: string): SafeRecord {
  let records = 0;
  let assistantRecords = 0;
  let textParts = 0;
  let assistantTextParts = 0;
  let matchingText = false;
  let matchingAssistantText = false;
  const visit = (node: unknown, assistantContext: boolean, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, assistantContext, depth + 1));
      return;
    }
    records += 1;
    const record = node as SafeRecord;
    const info = isRecord(record.info) ? record.info : {};
    const assistant = assistantContext || record.role === "assistant" || info.role === "assistant";
    if (record.role === "assistant" || info.role === "assistant") assistantRecords += 1;
    if (record.type === "text" && typeof record.text === "string") {
      textParts += 1;
      if (record.text === expected) matchingText = true;
      if (assistant) {
        assistantTextParts += 1;
        if (record.text === expected) matchingAssistantText = true;
      }
    }
    for (const child of Object.values(record)) visit(child, assistant, depth + 1);
  };
  visit(value, false, 0);
  const rootKeys = isRecord(value)
    ? Object.keys(value).filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key)).sort().slice(0, 32)
    : [];
  const arrayLength = Array.isArray(value) ? value.length
    : isRecord(value) && Array.isArray(value.data) ? value.data.length
      : isRecord(value) && Array.isArray(value.messages) ? value.messages.length : undefined;
  return {
    rootKind: Array.isArray(value) ? "array" : isRecord(value) ? "object" : typeof value,
    rootKeys,
    ...(arrayLength === undefined ? {} : { arrayLength }),
    records,
    assistantRecords,
    textParts,
    assistantTextParts,
    matchingText,
    matchingAssistantText,
  };
}

async function readJsonResponse(response: Response, maxBytes = 2_000_000): Promise<unknown> {
  const text = await response.text();
  if (text.length > maxBytes) blocked("local_api_response_oversized");
  try { return JSON.parse(text) as unknown; } catch { blocked("local_api_response_not_json"); }
}

async function apiRequest(base: string, auth: string, path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(5_000),
      headers: { authorization: auth, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    blocked("localhost_api_unavailable");
  }
  if (!response.ok) blocked(`localhost_api_http_${response.status}`);
  if (response.status === 204) return undefined;
  const decoded = await readJsonResponse(response);
  if (isRecord(decoded) && isRecord(decoded.data)) return decoded.data;
  return decoded;
}

function messageObservation(events: SafeRecord[], phase: SafeNativeObservation["phase"]): SafeNativeObservation | undefined {
  const event = events.find((entry) => entry.kind === "retry-hook" && entry.phase === phase);
  if (!event) return undefined;
  return event as unknown as SafeNativeObservation;
}

function parseState(path: string): { modelRequests: number; errorResponses: number; successResponses: number } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed)) return {
      modelRequests: Number.isInteger(parsed.modelRequests) ? Number(parsed.modelRequests) : 0,
      errorResponses: Number.isInteger(parsed.errorResponses) ? Number(parsed.errorResponses) : 0,
      successResponses: Number.isInteger(parsed.successResponses) ? Number(parsed.successResponses) : 0,
    };
  } catch {}
  return { modelRequests: 0, errorResponses: 0, successResponses: 0 };
}

function errorResult(error: unknown): { verdict: Exclude<Verdict, "PASS">; reason: string } {
  if (error instanceof GateError) return { verdict: error.verdict, reason: error.code };
  return { verdict: "BLOCKED", reason: "unexpected_gate_runtime_error" };
}

async function runScenario(scenario: Scenario, runDir: string, overallDeadline: number, hashes: SafeRecord): Promise<SafeRecord> {
  const caseDir = join(runDir, scenario.id);
  const runtimeDir = join(caseDir, "runtime");
  const configDir = join(runtimeDir, "xdg-config", "opencode");
  const workspace = join(runtimeDir, "workspace");
  const evidencePath = join(caseDir, "safe-events.jsonl");
  const cliEvidencePath = join(caseDir, "safe-cli-events.jsonl");
  const statePath = join(runtimeDir, "synthetic-state.json");
  const fakeCliPath = join(runtimeDir, "synthetic-claude-cli.ts");
  const pluginDir = join(configDir, "plugins");
  const libDir = join(configDir, "lib");
  const caseStarted = Date.now();
  const caseDeadline = Math.min(caseStarted + scenario.boundMs, overallDeadline);
  let child: ChildProcess | undefined;
  let sessionID: string | undefined;
  let promptController: AbortController | undefined;
  let monitor: EventMonitor | undefined;
  let apiBase: string | undefined;
  let apiAuth: string | undefined;
  let promptHttpStatus: number | undefined;
  let failure: { verdict: Exclude<Verdict, "PASS">; reason: string } | undefined;
  let nativeModelListed = false;
  let nativeProviderPackage = "unknown";
  let syntheticCliSourceHash: string | undefined;
  let persistedScriptedSuccess = false;
  let persistedSessionReadback = false;
  let interruptIssued = false;
  let caseFinished = false;
  let persistedOutputSummary: SafeRecord | undefined;

  try {
    if (Date.now() >= overallDeadline) blocked("overall_gate_deadline_exhausted");
    await Promise.all([configDir, workspace, pluginDir, libDir,
      join(runtimeDir, "xdg-data", "opencode"), join(runtimeDir, "xdg-state", "opencode"),
      join(runtimeDir, "xdg-cache"), join(runtimeDir, "home"), join(runtimeDir, "tmp")]
      .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));

    const productPlugin = await readFile(join(PACKAGE_DIR, "src/plugins/claude-session-limit-retry.ts"), "utf8");
    const productLibrary = await readFile(join(PACKAGE_DIR, "src/lib/claude-session-limit-retry.ts"), "utf8");
    await writeFile(join(pluginDir, "claude-session-limit-retry.ts"), productPlugin, { mode: 0o600 });
    await writeFile(join(libDir, "claude-session-limit-retry.ts"), productLibrary, { mode: 0o600 });
    await writeFile(join(pluginDir, "00-task-6-3-before.ts"), observerPluginSource("before_product", scenario, evidencePath), { mode: 0o600 });
    await writeFile(join(pluginDir, "zz-task-6-3-after.ts"), observerPluginSource("after_product", scenario, evidencePath), { mode: 0o600 });
    const fakeSource = syntheticCliSource(scenario, statePath, cliEvidencePath);
    syntheticCliSourceHash = createHash("sha256").update(fakeSource).digest("hex");
    await writeFile(fakeCliPath, fakeSource, { mode: 0o700 });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      update: "disable",
      model: `${PROVIDER}/${MODEL}`,
      provider: {
        [PROVIDER]: {
          name: "Synthetic Claude Agent",
          models: { [MODEL]: { name: "Synthetic Claude Sonnet", limit: { context: 200000, output: 8192 } } },
        },
      },
    }, null, 2), { mode: 0o600 });

    const password = randomUUID();
    const port = await freeLoopbackPort();
    const base = `http://127.0.0.1:${port}`;
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    apiBase = base;
    apiAuth = auth;
    const childEnv: Record<string, string> = {};
    for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME"]) {
      const value = process.env[key];
      if (value) childEnv[key] = value;
    }
    Object.assign(childEnv, {
      HOME: join(runtimeDir, "home"),
      XDG_CONFIG_HOME: join(runtimeDir, "xdg-config"),
      XDG_DATA_HOME: join(runtimeDir, "xdg-data"),
      XDG_STATE_HOME: join(runtimeDir, "xdg-state"),
      XDG_CACHE_HOME: join(runtimeDir, "xdg-cache"),
      TMPDIR: join(runtimeDir, "tmp"),
      TMP: join(runtimeDir, "tmp"),
      TEMP: join(runtimeDir, "tmp"),
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CLAUDE_PATH: fakeCliPath,
      NO_COLOR: "1",
    });
    child = spawn(OPENCODE, ["--log-level", "none", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace, env: childEnv, stdio: "ignore",
    });

    const readyBy = Math.min(Date.now() + 12_000, caseDeadline);
    let ready = false;
    while (!ready && Date.now() < readyBy) {
      if (child.exitCode !== null) blocked("opencode_server_exited_before_ready");
      try {
        const response = await fetch(`${base}/openapi.json`, { headers: { authorization: auth }, signal: AbortSignal.timeout(500) });
        ready = response.ok;
      } catch {}
      if (!ready) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!ready) blocked("opencode_server_readiness_timeout");

    const modelDeadline = Math.min(Date.now() + 8_000, caseDeadline);
    while (!nativeModelListed && Date.now() < modelDeadline) {
      try { nativeModelListed = hasConfiguredModel(await apiRequest(base, auth, "/api/model")); } catch (error) {
        if (error instanceof GateError && error.verdict === "FAIL") throw error;
      }
      if (!nativeModelListed) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    nativeProviderPackage = providerPackage(await apiRequest(base, auth, `/api/provider/${PROVIDER}`));
    if (!nativeModelListed || nativeProviderPackage !== "native_sdk") blocked("native_sdk_provider_or_configured_model_not_confirmed");

    const created = await apiRequest(base, auth, "/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "task-6.3 synthetic case", location: { directory: workspace }, model: { providerID: PROVIDER, id: MODEL } }),
    });
    if (!isRecord(created)) blocked("session_create_response_unusable");
    sessionID = typeof created.id === "string" ? created.id
      : typeof created.sessionID === "string" ? created.sessionID : undefined;
    if (!sessionID) blocked("session_create_missing_id");

    monitor = startEventMonitor(base, auth, sessionID);
    if (!await monitor.ready) blocked("runtime_status_stream_unavailable");
    promptController = new AbortController();
    void fetch(`${base}/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST", signal: promptController.signal,
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ text: `Synthetic native retry gate scenario ${scenario.id}; do not contact any provider.` }),
    }).then(async (response) => {
      promptHttpStatus = response.status;
      await response.body?.cancel();
    }).catch(() => undefined);

    const injectedExpected = scenario.form === "combined" ? ["rate_limit_event", "assistant.error", "result"]
      : scenario.form === "rate_limit_event" ? ["rate_limit_event", "result"]
        : ["assistant.error", "result"];
    const caseEvidence = () => safeJsonLines(evidencePath);
    const cliEvidence = () => safeJsonLines(cliEvidencePath);
    const nativeInjected = () => cliEvidence().find((entry) => entry.kind === "synthetic-sdk-events");
    const hookSeen = await waitUntil(caseDeadline, () => !!messageObservation(caseEvidence(), "after_product"));
    if (!hookSeen) {
      const cliStarted = cliEvidence().some((entry) => entry.kind === "synthetic-cli-started");
      const injected = nativeInjected();
      if (!cliStarted || !injected) blocked("synthetic_sdk_injection_seam_not_observed");
      blocked("native_retry_hook_not_observed");
    }

    const cliEvents = cliEvidence();
    const injected = nativeInjected();
    const actualTypes = Array.isArray(injected?.eventTypes) ? injected.eventTypes : [];
    if (!injected || JSON.stringify(actualTypes) !== JSON.stringify(injectedExpected)) blocked("synthetic_sdk_event_sequence_not_confirmed");
    const expectedRateLimitType = scenario.rateLimitType ?? "absent";
    if (injected.rateLimitType !== expectedRateLimitType) blocked("synthetic_rate_limit_type_fixture_mismatch");

    const observations = caseEvidence();
    const before = messageObservation(observations, "before_product");
    const after = messageObservation(observations, "after_product");
    if (!before || !after) blocked("native_hook_order_or_observation_unavailable");
    if (before.providerID !== PROVIDER || before.modelID !== MODEL || after.providerID !== PROVIDER || after.modelID !== MODEL) {
      blocked("native_provider_identity_not_confirmed_at_retry_hook");
    }
    if (before.messageCategory !== scenario.expectedCategory || after.messageCategory !== scenario.expectedCategory) {
      failed("native_normalized_category_mismatch");
    }

    let runtimeRetryStatus: RuntimeStatus | undefined;
    let finalIdle = false;
    if (scenario.succeedsAfterRetry) {
      if (!isPositiveOverride(before, after)) failed("built_in_false_to_product_true_transition_missing");
      if (before.decisionRetry !== false) blocked("built_in_false_decision_not_observed_before_product");
      if (typeof after.graceAndStaggerMs !== "number" || after.graceAndStaggerMs < GRACE_MS - 20
        || after.graceAndStaggerMs > GRACE_MS + 270) failed("full_60_second_grace_not_observed");
      if (typeof after.decisionDelayMs !== "number" || after.decisionDelayMs < GRACE_MS
        || after.decisionDelayMs > SIX_HOURS_MS || after.decisionDelayMs > TIMER_MAX_MS) failed("positive_decision_delay_out_of_bounds");
      const retryStatusSeen = await waitUntil(Math.min(Date.now() + 5_000, caseDeadline), () => !!lastStatus(monitor!.statuses, "retry"));
      if (!retryStatusSeen) blocked("runtime_retry_status_not_observed");
      runtimeRetryStatus = lastStatus(monitor.statuses, "retry");
      if (!runtimeRetryStatus?.nextEpochMs || typeof runtimeRetryStatus.retryRemainingMs !== "number") blocked("runtime_retry_schedule_unobservable");
      if (Math.abs(runtimeRetryStatus.retryRemainingMs - after.decisionDelayMs) > 2_000) failed("runtime_retry_delay_mismatch");

      const resumed = await waitUntil(caseDeadline, () => parseState(statePath).modelRequests >= 2
        && parseState(statePath).successResponses >= 1 && lastStatus(monitor!.statuses)?.type === "idle");
      if (!resumed) failed("bounded_retry_did_not_resume_to_scripted_success");
      const state = parseState(statePath);
      if (state.modelRequests !== 2 || state.successResponses !== 1 || state.errorResponses !== 1) failed("success_attempt_count_mismatch");
      const messages = await apiRequest(base, auth, `/api/session/${encodeURIComponent(sessionID)}/message`);
      persistedSessionReadback = true;
      persistedOutputSummary = persistedMessageSummary(messages, SUCCESS_SENTINEL);
      persistedScriptedSuccess = hasPersistedScriptedSuccessText(messages, SUCCESS_SENTINEL);
      if (!persistedScriptedSuccess) failed("scripted_success_not_found_in_persisted_session_output");
      finalIdle = lastStatus(monitor.statuses)?.type === "idle";
      if (!finalIdle) failed("successful_session_not_idle_after_resumption");
    } else if (scenario.interruptsPendingWait) {
      if (!isPositiveOverride(before, after)) failed("no_type_reset_was_not_promoted");
      if (before.decisionRetry !== false) blocked("built_in_false_decision_not_observed_before_product");
      if (typeof after.graceAndStaggerMs !== "number" || after.graceAndStaggerMs < GRACE_MS - 20
        || after.graceAndStaggerMs > GRACE_MS + 270) failed("interrupted_wait_did_not_include_full_grace");
      if (typeof after.decisionDelayMs !== "number" || after.decisionDelayMs < TWO_HOURS_MS + GRACE_MS - 1_000
        || after.decisionDelayMs > TWO_HOURS_MS + GRACE_MS + 1_000) failed("pending_wait_was_not_long_reset_plus_grace");
      const retryStatusSeen = await waitUntil(Math.min(Date.now() + 5_000, caseDeadline), () => !!lastStatus(monitor!.statuses, "retry"));
      if (!retryStatusSeen) blocked("long_wait_runtime_retry_status_not_observed");
      runtimeRetryStatus = lastStatus(monitor.statuses, "retry");
      if (!runtimeRetryStatus?.nextEpochMs || typeof runtimeRetryStatus.retryRemainingMs !== "number") blocked("long_wait_runtime_schedule_unobservable");
      if (Math.abs(runtimeRetryStatus.retryRemainingMs - after.decisionDelayMs) > 2_000) failed("long_wait_runtime_delay_mismatch");

      await apiRequest(base, auth, `/api/session/${encodeURIComponent(sessionID)}/interrupt`, { method: "POST" });
      interruptIssued = true;
      const interruptedIdle = await waitUntil(Math.min(Date.now() + 5_000, caseDeadline), () => lastStatus(monitor!.statuses)?.type === "idle");
      if (!interruptedIdle) blocked("native_interrupt_idle_status_not_observed");
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(1_000, Math.max(0, caseDeadline - Date.now()))));
      const state = parseState(statePath);
      if (state.modelRequests !== 1 || state.successResponses !== 0) failed("interrupted_wait_caused_an_extra_model_attempt");
      const messages = await apiRequest(base, auth, `/api/session/${encodeURIComponent(sessionID)}/message`);
      persistedSessionReadback = true;
       persistedScriptedSuccess = hasPersistedScriptedSuccessText(messages, SUCCESS_SENTINEL);
       if (persistedScriptedSuccess) failed("interrupted_session_persisted_retry_success_output");
      finalIdle = lastStatus(monitor.statuses)?.type === "idle";
      if (!finalIdle) failed("interrupted_session_not_idle");
    } else {
      if (!isUnchangedNegative(before, after)) failed("negative_classification_changed_native_decision");
      if (before.decisionRetry !== false) blocked("native_false_decision_not_observed_for_negative");
      const idleSeen = await waitUntil(caseDeadline, () => lastStatus(monitor!.statuses)?.type === "idle");
      if (!idleSeen) blocked("negative_case_persisted_idle_status_not_observed");
      const retryStatus = lastStatus(monitor.statuses, "retry");
      if (retryStatus) failed("negative_case_entered_native_retry_schedule");
      const state = parseState(statePath);
      if (state.modelRequests !== 1 || state.successResponses !== 0) failed("negative_case_attempt_count_mismatch");
      const messages = await apiRequest(base, auth, `/api/session/${encodeURIComponent(sessionID)}/message`);
      persistedSessionReadback = true;
       persistedScriptedSuccess = hasPersistedScriptedSuccessText(messages, SUCCESS_SENTINEL);
       if (persistedScriptedSuccess) failed("negative_case_persisted_success_output");
      finalIdle = lastStatus(monitor.statuses)?.type === "idle";
    }

    if (scenario.id === "combined_success") {
      const wrongProvider = observations.find((entry) => entry.kind === "wrong-provider-clone");
      if (!wrongProvider || wrongProvider.coverage !== "native_event_clone_unit_negative_only"
        || wrongProvider.promoted !== false || wrongProvider.decisionUnchanged !== true) {
        failed("wrong_provider_negative_clone_not_proven");
      }
    }

    const state = parseState(statePath);
    caseFinished = true;
    return {
      case: scenario.id,
      status: "PASS",
      reason: "native_path_decision_and_runtime_outcome_verified",
      expectedCategory: scenario.expectedCategory,
      eventForm: scenario.form,
      injectedEventTypes: actualTypes,
      rateLimitType: typeof injected.rateLimitType === "string" ? injected.rateLimitType : "absent",
      beforeProduct: before,
      afterProduct: after,
      runtimeRetryStatus: runtimeRetryStatus ? {
        type: runtimeRetryStatus.type,
        attempt: runtimeRetryStatus.attempt,
        scheduledRemainingMs: Math.round(runtimeRetryStatus.retryRemainingMs ?? 0),
      } : "not_scheduled",
      interruptIssued,
      finalSessionStatus: finalIdle ? "idle" : "other",
      modelRequests: state.modelRequests,
      errorResponses: state.errorResponses,
      scriptedSuccessResponses: state.successResponses,
      persistedSessionReadback,
      persistedScriptedSuccess,
      persistedOutputSummary,
      promptHttpStatus: typeof promptHttpStatus === "number" && promptHttpStatus >= 100 && promptHttpStatus <= 599 ? promptHttpStatus : "not_observed",
      elapsedMs: Date.now() - caseStarted,
      syntheticCliSourceSha256: syntheticCliSourceHash,
      nativeProviderPackage,
      ...hashes,
      providerContact: false,
      providerCredentialsInherited: false,
      providerEndpointConfigured: false,
      networkAssertion: "loopback_api_and_synthetic_cli_only_application_assertion_not_os_egress_proof",
    };
  } catch (error) {
    failure = errorResult(error);
    const safe = safeJsonLines(evidencePath);
    const cli = safeJsonLines(cliEvidencePath);
    return {
      case: scenario.id,
      status: failure.verdict,
      reason: failure.reason,
      expectedCategory: scenario.expectedCategory,
      eventForm: scenario.form,
      beforeProduct: messageObservation(safe, "before_product") ?? "not_observed",
      afterProduct: messageObservation(safe, "after_product") ?? "not_observed",
      injectedEventTypes: cli.find((entry) => entry.kind === "synthetic-sdk-events")?.eventTypes ?? [],
      syntheticCliStarted: cli.some((entry) => entry.kind === "synthetic-cli-started"),
      nativeModelListed,
      nativeProviderPackage,
      interruptIssued,
      runtimeStatuses: monitor ? runtimeStatusesForCase(monitor.statuses) : [],
      runtimeEventShapes: monitor?.streamEventShapes ?? [],
      persistedSessionReadback,
      persistedScriptedSuccess,
      persistedOutputSummary,
      modelRequests: parseState(statePath).modelRequests,
      elapsedMs: Date.now() - caseStarted,
      syntheticCliSourceSha256: syntheticCliSourceHash,
      ...hashes,
      providerContact: false,
      providerCredentialsInherited: false,
      providerEndpointConfigured: false,
      networkAssertion: "loopback_api_and_synthetic_cli_only_application_assertion_not_os_egress_proof",
    };
  } finally {
    if (child && sessionID && apiBase && apiAuth && !caseFinished && !interruptIssued) {
      try {
        await fetch(`${apiBase}/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
          method: "POST", headers: { authorization: apiAuth, "content-type": "application/json" },
          signal: AbortSignal.timeout(1_000),
        });
      } catch {}
    }
    promptController?.abort();
    if (monitor) await monitor.stop();
    if (child) {
      await stop(child);
    }
    // OpenCode's isolated database/config/logs contain the synthetic prompt and
    // session. Keep only the content-free observers and derived summary.
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function caseOutcome(result: SafeRecord): Verdict {
  return result.status === "PASS" || result.status === "FAIL" || result.status === "BLOCKED" ? result.status : "BLOCKED";
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replaceAll(/[^0-9TZ]/g, "");
  const taskDir = join(ROOT, "tmp", "claude-session-limit-retry", "task-6.3");
  const runDir = join(taskDir, `gate-${stamp}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const overallDeadline = started + OVERALL_BOUND_MS;
  const requestedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length) as ScenarioID | undefined;
  const scenarios = requestedCase ? SCENARIOS.filter((scenario) => scenario.id === requestedCase) : SCENARIOS;
  const selectedValid = !requestedCase || scenarios.length === 1;
  const version = await versionOfInstalledOpenCode();
  const binaryHash = await fileHashIfAvailable(OPENCODE);
  const productPluginHash = await fileHashIfAvailable(join(PACKAGE_DIR, "src/plugins/claude-session-limit-retry.ts"));
  const productLibraryHash = await fileHashIfAvailable(join(PACKAGE_DIR, "src/lib/claude-session-limit-retry.ts"));
  const hashes: SafeRecord = {
    opencodeBinarySha256: binaryHash ?? "unavailable",
    productPluginSha256: productPluginHash ?? "unavailable",
    productLibrarySha256: productLibraryHash ?? "unavailable",
  };
  const results: SafeRecord[] = [];
  let overallStatus: Verdict = "PASS";
  let overallReason = "all_scenarios_verified";

  if (!selectedValid) {
    overallStatus = "BLOCKED";
    overallReason = "unknown_case_selection";
  } else if (version.code !== 0 || version.text !== EXPECTED_VERSION || !binaryHash) {
    overallStatus = "BLOCKED";
    overallReason = "installed_opencode_2_2_6_not_confirmed";
  } else {
    for (const scenario of scenarios) {
      if (Date.now() >= overallDeadline) {
        results.push({ case: scenario.id, status: "BLOCKED", reason: "overall_gate_deadline_exhausted" });
        overallStatus = "BLOCKED";
        overallReason = "overall_gate_deadline_exhausted";
        break;
      }
      const result = await runScenario(scenario, runDir, overallDeadline, hashes);
      results.push(result);
      const outcome = caseOutcome(result);
      if (outcome === "FAIL") {
        overallStatus = "FAIL";
        overallReason = "one_or_more_exercised_scenarios_mismatched";
        break;
      }
      if (outcome === "BLOCKED") {
        overallStatus = "BLOCKED";
        overallReason = "one_or_more_required_observations_unavailable";
        break;
      }
    }
  }

  if (results.length !== scenarios.length && overallStatus === "PASS") {
    overallStatus = "BLOCKED";
    overallReason = "not_all_selected_scenarios_completed";
  }
  const summary = {
    schema: "claude-agent-native-retry-gate.v1",
    status: overallStatus,
    reason: overallReason,
    opencodeVersion: version.text === EXPECTED_VERSION ? version.text : "mismatch_or_unavailable",
    installedBinary: OPENCODE,
    injectionSeam: "OPENCODE_CLAUDE_PATH_to_native_claude_agent_stream_json_cli",
    pluginOrdering: ["00-task-6-3-before.ts", "claude-session-limit-retry.ts", "zz-task-6-3-after.ts"],
    scenarios: results,
    bounds: {
      successCaseMs: SUCCESS_CASE_BOUND_MS,
      interruptionCaseMs: INTERRUPT_CASE_BOUND_MS,
      negativeCaseMs: NEGATIVE_CASE_BOUND_MS,
      overallMs: OVERALL_BOUND_MS,
      expectedSuccessRetryDelayMs: "synthetic reset horizon plus full 60000ms grace and native 0-250ms stagger",
      pendingInterruptResetHorizonMs: TWO_HOURS_MS,
    },
    isolation: {
      perCaseHomeAndXdg: "isolated_under_project_tmp",
      projectConfigDiscovery: false,
      modelFetch: false,
      providerEndpointConfigured: false,
      providerCredentialsInherited: false,
      syntheticCliNetworkCalls: false,
      localApi: "127.0.0.1_only_with_ephemeral_local_basic_auth",
      network: "application_level_assertion_not_os_egress_proof",
      rawRuntimeData: "removed_after_each_scenario",
      evidence: "categorical_content_free_only",
    },
    sourceHashes: hashes,
    elapsedMs: Date.now() - started,
    evidencePath: safeRelative(join(runDir, "gate-summary.json")),
  };
  await writeFile(join(runDir, "gate-summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({
    status: summary.status,
    reason: summary.reason,
    opencodeVersion: summary.opencodeVersion,
    evidencePath: summary.evidencePath,
    elapsedMs: summary.elapsedMs,
    scenarios: results.map((result) => ({ case: result.case, status: result.status, reason: result.reason })),
  }, null, 2));
  if (overallStatus !== "PASS") process.exitCode = 1;
}

if (import.meta.main) await main();
