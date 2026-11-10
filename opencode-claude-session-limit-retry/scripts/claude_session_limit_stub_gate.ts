// Stub gate for the claude-session-limit-retry plugin (design D9).
//
// Runs one isolated `opencode serve` (installed v2.1.2) whose provider
// `claude-code` points at a localhost stub answering every chat-completions
// request with the upstream session-limit 429. Records whether the native
// `retry` hook delivers the classifiable body and whether the product plugin
// sets decision.retry/delay beyond the 15-minute native cap.
//
//   bun scripts/claude_session_limit_stub_gate.ts [--scenario=default|midstream|fallback] [--self-check]
//
//   default    429 gate with structured `resets_at` / `retry_after` (2 h).
//   midstream  Class B: HTTP 200 SSE stream whose error chunk carries the field-failure
//              body (`code=claude_session_limit`, `type=error`, reset only in message text).
//   fallback   Class A with text: 429 `retry_after: 600` but the message names a real
//              reset ~2 h away, so the expected delay is that instant + 60 s, not ~11 min.
//
// Provider-free `--self-check` never starts OpenCode.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyClaudeSessionLimitRetryHook, resetClaudeSessionLimitCooldown } from "../src/lib/claude-session-limit-retry.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..");
const PRODUCT_PLUGIN = join(PACKAGE_ROOT, "src", "plugins", "claude-session-limit-retry.ts");
const EXPECTED_VERSION = "opencode v2.1.2";
const PROVIDER_ID = "claude-code";
const MODEL_ID = "claude-sonnet-stub";
const RUN_BOUND_MS = 60_000;
const RESET_AFTER_S = 7200;
const GRACE_MS = 60_000;
const STAGGER_MAX_MS = 250;
const TOLERANCE_MS = 5_000;
const MIN_DELAY_MS = RESET_AFTER_S * 1000 + GRACE_MS - TOLERANCE_MS;
const MAX_DELAY_MS = RESET_AFTER_S * 1000 + GRACE_MS + STAGGER_MAX_MS + TOLERANCE_MS;

const NATIVE_CAP_MS = 15 * 60 * 1000;
const MAX_CHAT_REQUESTS = 2;
const MAX_HOOK_ATTEMPTS = 2;
const SCENARIO_ZONE = "Pacific/Auckland";
const MIDSTREAM_AHEAD_MS = 4 * 60 * 60 * 1000;
const FALLBACK_AHEAD_MS = 2 * 60 * 60 * 1000;

export type Scenario = "default" | "midstream" | "fallback";
export const SCENARIOS: readonly Scenario[] = ["default", "midstream", "fallback"];

type JsonRecord = Record<string, unknown>;
export type Verdict = "PASS" | "FAIL" | "BLOCKED";
export type ObservedEvent = {
  kind?: string;
  errorType?: unknown;
  errorStatus?: unknown;
  providerID?: unknown;
  responseBodyKind?: string;
  bodyErrorCode?: unknown;
  bodyErrorType?: unknown;
  decisionRetry?: unknown;
  decisionDelay?: unknown;
};

// ---------------------------------------------------------------- stub

export function sessionLimitBody(nowMs: number): { body: JsonRecord; resetsAt: string } {
  const resetsAt = new Date(nowMs + RESET_AFTER_S * 1000).toISOString();
  return {
    resetsAt,
    body: {
      error: {
        message: "Claude session limit reached (stub)",
        type: "rate_limit_error",
        code: "claude_session_limit",
        resets_at: resetsAt,
        retry_after: RESET_AFTER_S,
      },
    },
  };
}

// Wall-clock text as emitted by the proxy: "7:50am" (no space, lowercase).
export function resetWallText(instantMs: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(instantMs);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase().replaceAll(".", "")}`;
}

export type ScenarioPlan = {
  scenario: Scenario;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  /** Serialized response payload (JSON body, or SSE stream for midstream). */
  payload: string;
  /** Absolute reset instant (epoch ms) the plugin is expected to wait for (before grace). */
  deadlineMs?: number;
  /** The error body object carried by the response (for assertions). */
  errorBody?: JsonRecord;
};

// Minute-aligned instant ahead of now: the wall-time text has minute resolution and
// the plugin resolves it to the next :00 occurrence, so aligning keeps text and ISO equal.
function minuteAligned(nowMs: number, aheadMs: number): number {
  return Math.ceil((nowMs + aheadMs) / 60_000) * 60_000;
}

export function midstreamErrorBody(deadlineMs: number): JsonRecord {
  const text = `You've hit your session limit · resets ${resetWallText(deadlineMs, SCENARIO_ZONE)} (${SCENARIO_ZONE}) · limit resets in 4h 2m (${new Date(deadlineMs).toISOString()})`;
  const inner = JSON.stringify({ type: "error", error: { type: "server_error", code: "server_error", message: text } });
  return { error: { message: inner, type: "error", code: "claude_session_limit" } };
}

export function fallbackErrorBody(deadlineMs: number): JsonRecord {
  return {
    error: {
      message: `You've hit your session limit · resets ${resetWallText(deadlineMs, SCENARIO_ZONE)} (${SCENARIO_ZONE}) · limit resets in 10m`,
      type: "rate_limit_error",
      code: "claude_session_limit",
      retry_after: 600,
    },
  };
}

export function scenarioPlan(scenario: Scenario, nowMs: number): ScenarioPlan {
  if (scenario === "midstream") {
    const deadlineMs = minuteAligned(nowMs, MIDSTREAM_AHEAD_MS);
    const errorBody = midstreamErrorBody(deadlineMs);
    const chunk = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: Math.floor(nowMs / 1000), model: MODEL_ID,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
    return { scenario, status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-cache" }, deadlineMs, errorBody,
      payload: `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(errorBody)}\n\ndata: [DONE]\n\n` };
  }
  if (scenario === "fallback") {
    const deadlineMs = minuteAligned(nowMs, FALLBACK_AHEAD_MS);
    const errorBody = fallbackErrorBody(deadlineMs);
    return { scenario, status: 429, contentType: "application/json", headers: {}, deadlineMs, errorBody, payload: JSON.stringify(errorBody) };
  }
  const { body, resetsAt } = sessionLimitBody(nowMs);
  return { scenario, status: 429, contentType: "application/json", deadlineMs: Date.parse(resetsAt), errorBody: body,
    headers: { "Retry-After": String(RESET_AFTER_S), "x-claude-rate-limit-reset": resetsAt }, payload: JSON.stringify(body) };
}

export type StubRequest = { method: string; path: string; at: string };

export async function startStub(requests: StubRequest[], scenario: Scenario = "default"): Promise<{ server: Server; baseURL: string; port: number; plan: ScenarioPlan; createdAtMs: number }> {
  const createdAtMs = Date.now();
  // Non-default scenarios fix the reset instant once so repeated requests agree.
  const fixedPlan = scenarioPlan(scenario, createdAtMs);
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    requests.push({ method: req.method ?? "", path, at: new Date().toISOString() });
    req.resume(); // body is never read or recorded
    req.on("end", () => {
      if (req.method === "POST" && path.endsWith("/chat/completions")) {
        const plan = scenario === "default" ? scenarioPlan("default", Date.now()) : fixedPlan;
        res.writeHead(plan.status, { "content-type": plan.contentType, ...plan.headers });
        res.end(plan.payload);
      } else if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
      }
    });
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const port = (server.address() as { port: number }).port;
  return { server, port, baseURL: `http://127.0.0.1:${port}/v1`, plan: fixedPlan, createdAtMs };
}

// ------------------------------------------------------ observer plugin

// Gate-only observer. Plain V2 plugin object (no imports). It registers its own
// `retry` hook; shim files load the product first (`10-`) and this one second
// (`20-`), so the observer is intended to run AFTER the product hook. Because
// hook ordering/parallelism in 2.1.2 is not assumed, the observer records the
// decision twice: synchronously at hook entry ("retry.entry") and again after a
// 50 ms timer ("retry.settled"); the verdict uses "retry.settled", which is
// correct whichever order the host runs the hooks in.
export function observerPluginSource(evidencePath: string): string {
  return `import { appendFileSync } from "node:fs";
const EVIDENCE = ${JSON.stringify(evidencePath)};
const safe = (value, max = 64) => (typeof value === "string" ? value.slice(0, max) : typeof value === "number" || typeof value === "boolean" ? value : value === undefined ? undefined : "[" + typeof value + "]");
const write = (kind, data) => {
  try { appendFileSync(EVIDENCE, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\\n", { mode: 0o600 }); } catch {}
};
const headerNames = (headers) => {
  try {
    if (!headers) return undefined;
    if (typeof headers.keys === "function" && !Array.isArray(headers)) return [...headers.keys()].map((k) => String(k).toLowerCase()).sort();
    if (Array.isArray(headers)) return headers.map((entry) => String(entry?.[0]).toLowerCase()).sort();
    if (typeof headers === "object") return Object.keys(headers).map((k) => k.toLowerCase()).sort();
  } catch {}
  return undefined;
};
const bodyShape = (body) => {
  if (body === undefined || body === null) return { responseBodyKind: body === null ? "null" : "absent" };
  let parsed = body;
  let kind = typeof body;
  if (typeof body === "string") {
    kind = "string";
    try { parsed = JSON.parse(body); } catch { return { responseBodyKind: "string-unparseable", responseBodyLength: body.length }; }
  }
  const err = parsed && typeof parsed === "object" ? parsed.error : undefined;
  return {
    responseBodyKind: kind,
    bodyErrorCode: safe(err && typeof err === "object" ? err.code : undefined),
    bodyErrorType: safe(err && typeof err === "object" ? err.type : undefined),
  };
};
const shape = (event) => {
  const value = event && typeof event === "object" ? event : {};
  const error = value.error && typeof value.error === "object" ? value.error : {};
  const response = error.response && typeof error.response === "object" ? error.response : undefined;
  const decision = value.decision && typeof value.decision === "object" ? value.decision : {};
  const model = value.model && typeof value.model === "object" ? value.model : undefined;
  return {
    errorType: safe(error.type),
    errorStatus: safe(error.status),
    errorKeys: Object.keys(error).sort().slice(0, 20),
    responseType: response === undefined ? typeof error.response : "object",
    responseKeys: response ? Object.keys(response).sort().slice(0, 20) : undefined,
    responseStatusCode: safe(response?.status_code),
    ...bodyShape(response?.body),
    headerNames: headerNames(response?.headers),
    attempt: safe(value.attempt),
    providerID: safe(model?.providerID),
    decisionRetry: safe(decision.retry),
    decisionDelay: safe(decision.delay),
  };
};
export default {
  id: "claude-session-limit-stub-gate-observer",
  async setup(ctx) {
    const controller = new AbortController();
    const registrations = [];
    registrations.push(await ctx.session.hook("retry", async (event) => {
      write("retry.entry", shape(event));
      await new Promise((resolve) => setTimeout(resolve, 50));
      write("retry.settled", shape(event));
    }));
    try {
      const events = ctx.event?.subscribe?.({ signal: controller.signal });
      if (events) void (async () => {
        try {
          for await (const event of events) {
            if (event?.type !== "session.retry.scheduled") continue;
            const data = event.data ?? {};
            write("session.retry.scheduled", { attempt: safe(data.attempt), at: safe(data.at) });
          }
        } catch {}
      })();
    } catch {}
    return async () => {
      controller.abort();
      await Promise.all(registrations.map((registration) => registration.dispose?.()));
    };
  },
};
`;
}

export function productShimSource(): string {
  return `export { default } from ${JSON.stringify(PRODUCT_PLUGIN)};\n`;
}

// -------------------------------------------------------------- verdict

export function computeVerdict(events: ObservedEvent[], stubRequestCount: number): { verdict: Verdict; reason: string } {
  const settled = events.filter((event) => event.kind === "retry.settled");
  if (stubRequestCount === 0) return { verdict: "BLOCKED", reason: "stub_received_no_chat_request" };
  if (settled.length === 0) return { verdict: "BLOCKED", reason: "no_retry_hook_event_observed" };
  const bodyClassifiable = (event: ObservedEvent): boolean =>
    event.bodyErrorCode === "claude_session_limit" && event.bodyErrorType === "rate_limit_error";
  const pass = settled.find((event) =>
    (event.errorType === "provider.rate-limit" || event.errorType === "provider.quota")
    && bodyClassifiable(event) && event.decisionRetry === true
    && typeof event.decisionDelay === "number" && event.decisionDelay >= MIN_DELAY_MS && event.decisionDelay <= MAX_DELAY_MS);
  if (pass) return { verdict: "PASS", reason: "classified_and_delay_above_native_cap" };
  const claude = settled.filter((event) => event.providerID === PROVIDER_ID);
  const candidates = claude.length ? claude : settled;
  if (candidates.some((event) => !bodyClassifiable(event))) return { verdict: "FAIL", reason: "hook_reached_without_classifiable_body" };
  if (candidates.some((event) => event.decisionRetry !== true)) return { verdict: "FAIL", reason: "hook_reached_decision_not_set" };
  return { verdict: "FAIL", reason: "hook_reached_unexpected_error_type_or_delay" };
}

export type ScenarioExpectation = {
  scenario: Exclude<Scenario, "default">;
  /** Reset instant (epoch ms) the stub advertised in message text. */
  deadlineMs: number;
  /** Earliest moment the hook could have run (stub creation). */
  windowStartMs: number;
  /** Latest moment the hook could have run (verdict time). */
  windowEndMs: number;
};

// Class A-with-text (fallback) and Class B (midstream): delay must follow the
// text-derived reset + 60 s grace (+0-250 ms stagger), exceed the native cap, and
// the attempt counts must stay small.
export function computeScenarioVerdict(events: ObservedEvent[], stubChatRequestCount: number, expected: ScenarioExpectation): { verdict: Verdict; reason: string } {
  const settled = events.filter((event) => event.kind === "retry.settled");
  if (stubChatRequestCount === 0) return { verdict: "BLOCKED", reason: "stub_received_no_chat_request" };
  if (settled.length === 0) {
    return { verdict: "BLOCKED", reason: expected.scenario === "midstream" ? "midstream_stub_not_surfaced_as_retry_event" : "no_retry_hook_event_observed" };
  }
  const minDelay = expected.deadlineMs + GRACE_MS - expected.windowEndMs - TOLERANCE_MS;
  const maxDelay = expected.deadlineMs + GRACE_MS - expected.windowStartMs + STAGGER_MAX_MS + TOLERANCE_MS;
  const classified = (event: ObservedEvent): boolean => expected.scenario === "midstream"
    ? event.errorType === "provider.internal" && event.bodyErrorCode === "claude_session_limit" && event.bodyErrorType === "error"
    : (event.errorType === "provider.rate-limit" || event.errorType === "provider.quota")
      && event.bodyErrorCode === "claude_session_limit" && event.bodyErrorType === "rate_limit_error";
  const delayOk = (event: ObservedEvent): boolean => typeof event.decisionDelay === "number"
    && event.decisionDelay > NATIVE_CAP_MS && event.decisionDelay >= minDelay && event.decisionDelay <= maxDelay;
  const claude = settled.filter((event) => event.providerID === PROVIDER_ID);
  const candidates = claude.length ? claude : settled;
  if (!candidates.some(classified)) return { verdict: "FAIL", reason: "hook_reached_unexpected_error_type_or_body" };
  if (!candidates.some((event) => classified(event) && event.decisionRetry === true)) return { verdict: "FAIL", reason: "hook_reached_decision_not_set" };
  if (!candidates.some((event) => classified(event) && event.decisionRetry === true && delayOk(event))) {
    return { verdict: "FAIL", reason: "delay_not_text_derived_or_not_above_native_cap" };
  }
  if (stubChatRequestCount > MAX_CHAT_REQUESTS) return { verdict: "FAIL", reason: "too_many_stub_chat_requests" };
  if (settled.length > MAX_HOOK_ATTEMPTS) return { verdict: "FAIL", reason: "too_many_hook_attempts" };
  return { verdict: "PASS", reason: "text_derived_delay_above_native_cap" };
}

// ----------------------------------------------------------- self-check

function scenarioSelfCheck(check: (name: string, ok: boolean) => void): void {
  const now = Date.parse("2026-10-23T03:07:21.000Z");
  const hookEvent = (error: Record<string, unknown>) => ({ sessionID: "ses_selfcheck", agent: "build", attempt: 1,
    model: { providerID: PROVIDER_ID, id: MODEL_ID }, error, decision: { retry: false } as { retry: boolean; delay?: number } });
  const libOptions = { nowMs: now, monotonicMs: 1_000_000, staggerMs: 0 };

  check("wall text format", /^\d{1,2}:\d{2}(am|pm)$/.test(resetWallText(now, SCENARIO_ZONE)));
  check("wall text Auckland value", resetWallText(Date.parse("2026-10-22T18:50:00.000Z"), SCENARIO_ZONE) === "7:50am");

  const mid = scenarioPlan("midstream", now);
  const midError = (mid.errorBody?.error ?? {}) as JsonRecord;
  const midInner = JSON.parse(String(midError.message)) as { type?: string; error?: JsonRecord };
  const midText = String(midInner.error?.message);
  check("midstream HTTP 200 SSE", mid.status === 200 && mid.contentType === "text/event-stream" && mid.payload.endsWith("data: [DONE]\n\n"));
  check("midstream no 429 / retry headers", mid.status !== 429 && !("Retry-After" in mid.headers));
  check("midstream body shape", midError.code === "claude_session_limit" && midError.type === "error"
    && midInner.type === "error" && midInner.error?.type === "server_error");
  check("midstream message text", midText.startsWith("You've hit your session limit · resets ")
    && midText.includes(` (${SCENARIO_ZONE}) · limit resets in 4h 2m (`) && midText.endsWith(`${new Date(mid.deadlineMs!).toISOString()})`));
  check("midstream deadline ~4h minute-aligned", mid.deadlineMs! % 60_000 === 0
    && mid.deadlineMs! - now >= MIDSTREAM_AHEAD_MS && mid.deadlineMs! - now < MIDSTREAM_AHEAD_MS + 60_000);
  check("midstream SSE carries error body", mid.payload.includes(`data: ${JSON.stringify(mid.errorBody)}\n\n`));

  const fb = scenarioPlan("fallback", now);
  const fbError = (fb.errorBody?.error ?? {}) as JsonRecord;
  check("fallback 429 json", fb.status === 429 && fb.contentType === "application/json" && fb.payload === JSON.stringify(fb.errorBody));
  check("fallback body fields", fbError.type === "rate_limit_error" && fbError.code === "claude_session_limit" && fbError.retry_after === 600
    && Object.keys(fbError).sort().join() === "code,message,retry_after,type");
  check("fallback message text", String(fbError.message).startsWith("You've hit your session limit · resets ")
    && String(fbError.message).endsWith(` (${SCENARIO_ZONE}) · limit resets in 10m`));
  check("fallback deadline ~2h, not 11m", fb.deadlineMs! - now >= FALLBACK_AHEAD_MS && fb.deadlineMs! - now < FALLBACK_AHEAD_MS + 60_000);
  check("fallback has no structured reset", !("resets_at" in fbError) && Object.keys(fb.headers).length === 0);

  // Cross-check the builders against the product lib (provider-free).
  resetClaudeSessionLimitCooldown();
  const midHook = hookEvent({ type: "provider.internal", status: 200, message: String(midError.message), response: { body: JSON.stringify(mid.errorBody) } });
  check("lib retries midstream body", applyClaudeSessionLimitRetryHook(midHook, libOptions) === true
    && midHook.decision.delay === mid.deadlineMs! - now + GRACE_MS);
  resetClaudeSessionLimitCooldown();
  const fbHook = hookEvent({ type: "provider.rate-limit", status: 429, message: String(fbError.message), retryAfterMs: 600_000, response: { body: fb.payload } });
  check("lib retries fallback body from text", applyClaudeSessionLimitRetryHook(fbHook, libOptions) === true
    && fbHook.decision.delay === fb.deadlineMs! - now + GRACE_MS && fbHook.decision.delay! > NATIVE_CAP_MS);
  resetClaudeSessionLimitCooldown();

  const window = (plan: ScenarioPlan, scenario: "midstream" | "fallback"): ScenarioExpectation =>
    ({ scenario, deadlineMs: plan.deadlineMs!, windowStartMs: now, windowEndMs: now + 5_000 });
  const midGood: ObservedEvent = { kind: "retry.settled", errorType: "provider.internal", errorStatus: 200, providerID: PROVIDER_ID,
    bodyErrorCode: "claude_session_limit", bodyErrorType: "error", decisionRetry: true, decisionDelay: mid.deadlineMs! - now + GRACE_MS + 100 };
  const fbGood: ObservedEvent = { kind: "retry.settled", errorType: "provider.rate-limit", errorStatus: 429, providerID: PROVIDER_ID,
    bodyErrorCode: "claude_session_limit", bodyErrorType: "rate_limit_error", decisionRetry: true, decisionDelay: fb.deadlineMs! - now + GRACE_MS + 100 };
  const midExp = window(mid, "midstream");
  const fbExp = window(fb, "fallback");
  check("midstream verdict PASS", computeScenarioVerdict([midGood], 1, midExp).verdict === "PASS");
  check("fallback verdict PASS", computeScenarioVerdict([fbGood], 1, fbExp).verdict === "PASS");
  check("fallback verdict FAIL ~11m delay", computeScenarioVerdict([{ ...fbGood, decisionDelay: 660_000 }], 1, fbExp).verdict === "FAIL");
  check("fallback verdict FAIL native cap", computeScenarioVerdict([{ ...fbGood, decisionDelay: NATIVE_CAP_MS }], 1, fbExp).verdict === "FAIL");
  check("midstream verdict FAIL not retried", computeScenarioVerdict([{ ...midGood, decisionRetry: false, decisionDelay: undefined }], 1, midExp).verdict === "FAIL");
  check("midstream verdict FAIL wrong body type", computeScenarioVerdict([{ ...midGood, bodyErrorType: "rate_limit_error" }], 1, midExp).verdict === "FAIL");
  check("midstream verdict FAIL wrong error type", computeScenarioVerdict([{ ...midGood, errorType: "provider.rate-limit" }], 1, midExp).verdict === "FAIL");
  check("midstream verdict FAIL delay out of bounds", computeScenarioVerdict([{ ...midGood, decisionDelay: midGood.decisionDelay as number + 60_000 }], 1, midExp).verdict === "FAIL");
  check("verdict FAIL too many chat requests", computeScenarioVerdict([fbGood], MAX_CHAT_REQUESTS + 1, fbExp).reason === "too_many_stub_chat_requests");
  check("verdict FAIL too many hook attempts", computeScenarioVerdict([fbGood, fbGood, fbGood], 1, fbExp).reason === "too_many_hook_attempts");
  check("midstream BLOCKED when not surfaced", computeScenarioVerdict([], 1, midExp).reason === "midstream_stub_not_surfaced_as_retry_event");
  check("scenario BLOCKED no requests", computeScenarioVerdict([], 0, fbExp).verdict === "BLOCKED");
}

async function selfCheck(): Promise<void> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => { console.log(`${ok ? "ok" : "FAIL"} ${name}`); if (!ok) failures.push(name); };
  const requests: StubRequest[] = [];
  const stub = await startStub(requests);
  try {
    const before = Date.now();
    const response = await fetch(`${stub.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "never recorded" }] }) });
    const body = await response.json() as { error?: JsonRecord };
    const error = body.error ?? {};
    const resetsAt = Date.parse(String(error.resets_at));
    check("stub 429", response.status === 429);
    check("stub body fields", error.type === "rate_limit_error" && error.code === "claude_session_limit"
      && typeof error.message === "string" && error.retry_after === RESET_AFTER_S);
    check("stub body keys exact", Object.keys(error).sort().join() === "code,message,resets_at,retry_after,type");
    check("stub resets_at ~now+2h", Math.abs(resetsAt - (before + RESET_AFTER_S * 1000)) < 5_000);
    check("stub Retry-After header", response.headers.get("retry-after") === String(RESET_AFTER_S));
    check("stub reset header equals body", response.headers.get("x-claude-rate-limit-reset") === error.resets_at);
    const models = await fetch(`${stub.baseURL}/models`);
    check("stub /models", models.status === 200);
    check("stub records request metadata only", requests.length === 2 && requests[0].method === "POST"
      && requests[0].path === "/v1/chat/completions" && Object.keys(requests[0]).sort().join() === "at,method,path");
  } finally {
    await new Promise<void>((done) => stub.server.close(() => done()));
  }

  const evidencePath = "tmp/claude-session-limit-retry/self-check-evidence.jsonl";
  const source = observerPluginSource(evidencePath);
  const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  check("observer source transpiles", transpiled.length > 0 && source.includes('ctx.session.hook("retry"'));
  check("observer has no auth/prompt access", !/\b(prompt|authorization|apiKey|sessionID|message)\b/.test(source.replace(/errorType|bodyErrorType/g, "")));
  check("product shim targets repo source", productShimSource().includes("src/plugins/claude-session-limit-retry.ts"));

  const good: ObservedEvent = { kind: "retry.settled", errorType: "provider.rate-limit", providerID: PROVIDER_ID,
    bodyErrorCode: "claude_session_limit", bodyErrorType: "rate_limit_error", decisionRetry: true, decisionDelay: 7_260_100 };
  check("verdict PASS", computeVerdict([good], 1).verdict === "PASS");
  check("verdict FAIL delay not set", computeVerdict([{ ...good, decisionRetry: false, decisionDelay: undefined }], 1).verdict === "FAIL");
  check("verdict FAIL body absent", computeVerdict([{ ...good, bodyErrorCode: undefined, decisionRetry: false }], 1).verdict === "FAIL");
  check("verdict FAIL capped delay", computeVerdict([{ ...good, decisionDelay: 900_000 }], 1).verdict === "FAIL");
  check("verdict BLOCKED no events", computeVerdict([], 1).verdict === "BLOCKED");
  check("verdict BLOCKED no requests", computeVerdict([], 0).verdict === "BLOCKED");

  scenarioSelfCheck(check);

  if (failures.length) { console.log(`self-check FAIL (${failures.length})`); process.exit(1); }
  console.log("self-check PASS");
}

// ----------------------------------------------------------------- gate

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.name ?? "unknown"})`);
  return result.stdout.trim();
}

class Blocked extends Error {}

function readEvents(path: string): ObservedEvent[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as ObservedEvent & { at?: string }]; } catch { return []; }
    });
  } catch { return []; }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await Promise.race([exited, new Promise((done) => setTimeout(done, 2_000))]); }
}

async function gate(scenario: Scenario): Promise<void> {
  const startedAt = performance.now();
  const stamp = new Date().toISOString().replaceAll(/[^0-9TZ]/g, "");
  const runDir = resolve(REPO_ROOT, "tmp", "claude-session-limit-retry", scenario === "default" ? `stub-gate-${stamp}` : `stub-gate-${scenario}-${stamp}`);
  const rel = relative(REPO_ROOT, runDir);
  const summaryPath = join(runDir, "summary.json");
  const evidencePath = join(runDir, "observer-evidence.jsonl");
  const stubLogPath = join(runDir, "stub-requests.jsonl");
  const requests: StubRequest[] = [];
  let version = "unknown";
  let verdict: Verdict = "BLOCKED";
  let reason = "not_started";
  let child: ChildProcess | undefined;
  let stub: Awaited<ReturnType<typeof startStub>> | undefined;
  let retryScheduledAt: unknown;
  const children: ChildProcess[] = [];
  const killAll = () => { for (const c of children) if (c.exitCode === null) c.kill("SIGKILL"); };
  process.on("exit", killAll);
  process.on("SIGINT", () => { killAll(); process.exit(130); });
  process.on("SIGTERM", () => { killAll(); process.exit(143); });

  try {
    version = runCommand("opencode", ["--version"]);
    if (version !== EXPECTED_VERSION) throw new Blocked(`version_mismatch:expected=${EXPECTED_VERSION}:got=${version}`);

    const configDir = join(runDir, "xdg-config", "opencode");
    const pluginsDir = join(configDir, "plugins");
    const workspace = join(runDir, "workspace");
    for (const dir of [pluginsDir, join(runDir, "xdg-data", "opencode"), join(runDir, "xdg-state", "opencode"),
      join(runDir, "xdg-cache"), join(runDir, "home"), workspace]) await mkdir(dir, { recursive: true, mode: 0o700 });

    stub = await startStub(requests, scenario);
    const config = {
      $schema: "https://opencode.ai/config.json",
      update: "disable",
      model: `${PROVIDER_ID}/${MODEL_ID}`,
      providers: {
        [PROVIDER_ID]: {
          name: "Claude Code (stub)",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: stub.baseURL, apiKey: "stub-gate-dummy-key" },
          models: { [MODEL_ID]: { name: "Claude Sonnet (stub)", limit: { context: 8192, output: 1024 } } },
        },
      },
    };
    await writeFile(join(configDir, "opencode.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
    await writeFile(join(pluginsDir, "10-claude-session-limit-retry.ts"), productShimSource(), { mode: 0o600 });
    await writeFile(join(pluginsDir, "20-stub-gate-observer.ts"), observerPluginSource(evidencePath), { mode: 0o600 });

    const password = randomUUID();
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(PATH|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_ALL|TERM)$/i.test(key) && value) env[key] = value;
    }
    Object.assign(env, {
      HOME: join(runDir, "home"),
      XDG_CONFIG_HOME: join(runDir, "xdg-config"),
      XDG_DATA_HOME: join(runDir, "xdg-data"),
      XDG_STATE_HOME: join(runDir, "xdg-state"),
      XDG_CACHE_HOME: join(runDir, "xdg-cache"),
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_GOAL_STATE_PATH: join(runDir, "goal-state.json"),
      OPENCODE_SERVER_PASSWORD: password,
    });

    const port = await new Promise<number>((ok, fail) => {
      const probe = createServer();
      probe.once("error", fail);
      probe.listen(0, "127.0.0.1", () => { const p = (probe.address() as { port: number }).port; probe.close(() => ok(p)); });
    });
    const base = `http://127.0.0.1:${port}`;
    child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env, stdio: ["ignore", "ignore", "ignore"] });
    children.push(child);

    const api = async (path: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetch(`${base}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000),
        headers: { authorization, "content-type": "application/json", ...(init?.headers ?? {}) } });
      const text = await response.text();
      if (!response.ok) throw new Error(`api_${init?.method ?? "GET"}_${path.replace(/\/session\/[^/?]+/, "/session/[ID]")}_http_${response.status}`);
      if (!text) return undefined;
      try { const decoded = JSON.parse(text) as JsonRecord; return decoded.data && typeof decoded.data === "object" ? decoded.data : decoded; } catch { return undefined; }
    };

    const readyDeadline = Date.now() + 20_000;
    for (let ready = false; !ready;) {
      if (child.exitCode !== null) throw new Blocked(`opencode_server_exited_before_ready:code=${child.exitCode}`);
      if (Date.now() > readyDeadline) throw new Blocked("opencode_server_readiness_timeout");
      try {
        const response = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(2_000), headers: { authorization } });
        ready = response.ok;
      } catch { /* retry */ }
      if (!ready) await new Promise((done) => setTimeout(done, 200));
    }

    const created = await api("/api/session", { method: "POST",
      body: JSON.stringify({ title: "claude session limit stub gate", location: { directory: workspace }, model: { providerID: PROVIDER_ID, id: MODEL_ID } }) }) as JsonRecord | undefined;
    const sessionID = typeof created?.id === "string" ? created.id : typeof created?.sessionID === "string" ? created.sessionID : undefined;
    if (!sessionID) throw new Blocked("session_create_returned_no_id");
    const promptController = new AbortController();
    const prompting = fetch(`${base}/api/session/${encodeURIComponent(sessionID)}/prompt`, { method: "POST", signal: promptController.signal,
      headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ text: "stub gate prompt" }) })
      .then((response) => response.status, () => undefined);

    // Wait for the observer's settled decision, bounded.
    const bound = Math.min(RUN_BOUND_MS, RUN_BOUND_MS - (performance.now() - startedAt) + 20_000);
    const deadline = Date.now() + Math.max(bound, 1_000);
    while (Date.now() < deadline && !readEvents(evidencePath).some((event) => event.kind === "retry.settled")) {
      if (child.exitCode !== null) throw new Blocked(`opencode_server_exited_during_run:code=${child.exitCode}`);
      await new Promise((done) => setTimeout(done, 250));
    }
    await new Promise((done) => setTimeout(done, 500)); // let a scheduled-retry event land
    retryScheduledAt = readEvents(evidencePath).find((event) => event.kind === "session.retry.scheduled") as unknown;

    await api(`/api/session/${encodeURIComponent(sessionID)}/interrupt?resume=false`, { method: "POST" }).catch(() => undefined);
    promptController.abort();
    await prompting;
  } catch (error) {
    reason = error instanceof Error ? error.message : "unknown_error";
    verdict = "BLOCKED";
    console.error(`[gate] infrastructure failure: ${reason}`);
  } finally {
    if (child) await stopChild(child);
    if (stub) await new Promise<void>((done) => { stub!.server.close(() => done()); stub!.server.closeAllConnections?.(); });
    killAll();
  }

  const events = readEvents(evidencePath);
  // An infra failure stays BLOCKED unless the hook already produced a settled event.
  const chatCount = requests.filter((r) => r.method === "POST" && r.path.endsWith("/chat/completions")).length;
  const expectation: ScenarioExpectation | undefined = scenario !== "default" && stub
    ? { scenario, deadlineMs: stub.plan.deadlineMs!, windowStartMs: stub.createdAtMs, windowEndMs: Date.now() }
    : undefined;
  if (reason === "not_started" || events.some((event) => event.kind === "retry.settled")) {
    ({ verdict, reason } = expectation ? computeScenarioVerdict(events, chatCount, expectation) : computeVerdict(events, chatCount));
  }
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writeFile(stubLogPath, requests.map((r) => JSON.stringify(r)).join("\n") + (requests.length ? "\n" : ""), { mode: 0o600 });
  await writeFile(summaryPath, JSON.stringify({
    schema: "claude-session-limit-stub-gate.v1",
    verdict, reason,
    scenario,
    expectedDeadline: expectation ? new Date(expectation.deadlineMs).toISOString() : null,
    hookAttempts: events.filter((event) => event.kind === "retry.settled").length,
    opencodeVersion: version,
    expectedVersion: EXPECTED_VERSION,
    stubRequestCount: requests.length,
    stubChatRequestCount: requests.filter((r) => r.method === "POST" && r.path.endsWith("/chat/completions")).length,
    delayBoundsMs: expectation
      ? { min: expectation.deadlineMs + GRACE_MS - expectation.windowEndMs - TOLERANCE_MS, max: expectation.deadlineMs + GRACE_MS - expectation.windowStartMs + STAGGER_MAX_MS + TOLERANCE_MS }
      : { min: MIN_DELAY_MS, max: MAX_DELAY_MS },
    observedEvents: events,
    retryScheduled: retryScheduledAt ?? null,
    elapsedMs: Math.round(performance.now() - startedAt),
    isolation: "XDG_* + HOME + OPENCODE_CONFIG_DIR inside run dir; project config disabled; no user plugins; localhost stub only",
    observerOrdering: "product shim 10-, observer 20-; verdict uses retry.settled (decision re-read after 50 ms)",
  }, null, 2), { mode: 0o600 });
  appendFileSync(summaryPath, "\n");
  console.log(`[${verdict}] claude session-limit stub gate (${reason}); runDir=${rel}`);
  if (verdict !== "PASS") process.exitCode = 1;
}

if (import.meta.main) {
  if (process.argv.includes("--self-check")) await selfCheck();
  else {
    const flag = process.argv.find((arg) => arg.startsWith("--scenario="));
    const scenario = (flag ? flag.slice("--scenario=".length) : "default") as Scenario;
    if (!SCENARIOS.includes(scenario)) {
      console.error(`unknown scenario "${flag?.slice("--scenario=".length)}"; expected one of ${SCENARIOS.join("|")}`);
      process.exit(2);
    }
    await gate(scenario);
  }
}
