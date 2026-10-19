import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { buildSyntheticResponsesSSE, composeV2CanaryFixture } from "./v2_canary_composition.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const RUN_ID = `v2-${new Date().toISOString().replaceAll(/[^0-9TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
const RUN_DIR = resolve(REPO_ROOT, "tmp", "codex-quota-retry", RUN_ID);
const EVIDENCE_DIR = join(RUN_DIR, "evidence");
const WORKSPACE = join(RUN_DIR, "workspace");
const SYNTHETIC_AUTH = join(RUN_DIR, "xdg-data", "opencode", "auth.json");
const EVIDENCE = join(EVIDENCE_DIR, "v2-canary.jsonl");
const LIMIT_MS = 180_000;
const MAX_PROVIDER_REQUESTS = 12;
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const PRODUCT_PLUGIN = join(PACKAGE_ROOT, "src", "plugins", "codex-quota-retry-v2.ts");
const PRODUCT_HELPER = join(PACKAGE_ROOT, "src", "lib", "codex-quota-retry.ts");
const SAFE_HEADERS = new Set(["session-id", "x-session-id", "x-generation-id", "generation-id", "x-request-id", "request-id", "x-trace-id", "trace-id"]);
const CLIENT_CHUNK = resolve(homedir(), ".config/opencode/local/context-mode-v2/node_modules/@opencode/client/dist/chunks/shared-events-hqeq47hr.js");
const CLIENT_TYPES = resolve(homedir(), ".config/opencode/local/context-mode-v2/node_modules/@opencode/client/dist/promise/generated/types.d.ts");
let serverAuthorization = "";
const START_MONOTONIC_MS = performance.now();

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.name ?? "unknown"})`);
  return result.stdout.trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assertContract(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`installed_client_contract_mismatch:${code}`);
}

export async function verifyInstalledClientContract(): Promise<{ clientSource: string; typeSource: string }> {
  const [clientSource, typeSource] = await Promise.all([readFile(CLIENT_CHUNK, "utf8"), readFile(CLIENT_TYPES, "utf8")]);
  const createSection = clientSource.split("create: (input, requestOptions) =>", 2)[1]?.split("import: (input, requestOptions) =>", 1)[0] ?? "";
  const promptSection = clientSource.split("prompt: (input, requestOptions) =>", 2)[1]?.split("command: (input, requestOptions) =>", 1)[0] ?? "";
  const waitSection = clientSource.split("wait: (input, requestOptions) =>", 2)[1]?.split("revert:", 1)[0] ?? "";
  const messagePath = "path: `/api/session/${encodeURIComponent(input.sessionID)}/message`";
  const interruptSection = clientSource.split("interrupt: (input, requestOptions) =>", 2)[1]?.split("background:", 1)[0] ?? "";
  assertContract(createSection.includes("path: `/api/session`"), "create_path");
  assertContract(createSection.includes('parentID: input?.["parentID"]') || createSection.includes('parentID: input["parentID"]'), "create_parent_id_mapping");
  assertContract(createSection.includes('location: input?.["location"]') || createSection.includes('location: input["location"]'), "create_location_mapping");
  assertContract(promptSection.includes("/prompt`") && promptSection.includes('text: input["text"]'), "prompt_path_and_body");
  assertContract(waitSection.includes("/wait`"), "wait_path");
  assertContract(clientSource.includes(messagePath), "message_list_path");
  assertContract(interruptSection.includes('method: "POST"')
    && interruptSection.includes("/interrupt`")
    && interruptSection.includes('query: { resume: input["resume"] }')
    && !interruptSection.includes("body:"), "interrupt_route_query_contract");
  assertContract(/export type SessionCreateInput[\s\S]{0,4000}parentID\?/.test(typeSource), "create_parent_id_schema");
  assertContract(/export type SessionPromptInput[\s\S]{0,1000}readonly text:/.test(typeSource), "prompt_text_schema");
  assertContract(typeSource.includes("export type SessionWaitInput"), "wait_schema");
  assertContract(/export type SessionInterruptInput[\s\S]{0,500}readonly resume\?/.test(typeSource), "interrupt_resume_schema");
  return { clientSource, typeSource };
}

/** Installed V2 client schema sends POST /interrupt with resume=false in the query, not a JSON body. */
export function buildSessionInterruptRequest(sessionID: string): { endpoint: string; init: RequestInit } {
  return { endpoint: `/api/session/${encodeURIComponent(sessionID)}/interrupt?resume=false`, init: { method: "POST" } };
}

type JsonRecord = Record<string, unknown>;

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function record(label: string, data: JsonRecord): Promise<void> {
  await appendFile(EVIDENCE, `${JSON.stringify({ label, observedAtMs: Math.round(performance.now() - START_MONOTONIC_MS), observedAtEpochMs: Date.now(), ...data })}\n`, { mode: 0o600 });
}

const EXPECTED_SCENARIOS = {
  schema: "codex-quota-retry-v2-installed-scenarios.v1",
  isolation: "synthetic-auth; application-level outbound network deny; no user goals; no live provider",
  limits: { maxProviderCalls: MAX_PROVIDER_REQUESTS, maxDurationMs: LIMIT_MS },
  scenarios: [
    { id: "root-quota-retry-success", expected: "root exact native identity receives delegated quota with a 5s reset plus unchanged 60s grace (~65s native retry), then synthetic text success", resetMs: 5_000, helperGraceMs: 60_000, targetNativeDelayMs: 65_000, identitySource: "native-http.request-hook + native-event.data.sessionID" },
    { id: "child-quota-interruption", expected: "child exact native identity receives delegated quota with a 5s reset plus unchanged 60s grace (~65s native retry), then native interruption", resetMs: 5_000, helperGraceMs: 60_000, targetNativeDelayMs: 65_000, identitySource: "native-http.request-hook + native-event.data.sessionID" },
    { id: "child-no-late-provider-call", expected: "no native provider delegate call through scheduled retry deadline plus marker grace", identitySource: "native-event.data.sessionID + bounded provider delegate count" },
    { id: "controlled-exact-child-probes", expected: "two controlled late-fetch probes use fresh authoritative native-hook correlation only for the exact canceled child; distinct from native retry evidence", identitySource: "native-http.request-hook-via-exported-correlator" },
    { id: "sibling-after-cooldown", expected: "sibling under the same root succeeds after shared cooldown expiration with synthetic text persisted", identitySource: "native-http.request-hook + native-event.data.sessionID" },
  ],
} as const;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

export function fixturePluginSource(): string {
  const evidenceFile = JSON.stringify(EVIDENCE);
  const codexURL = JSON.stringify(CODEX_URL);
  const moduleProbeURL = JSON.stringify("https://v2-canary.invalid/internal-early-wrapper-probe");
  const maxRequests = MAX_PROVIDER_REQUESTS;
  return `
import { appendFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { buildSyntheticResponsesSSE, composeV2CanaryFixture, initializeV2CanaryModule } from "../canonical/composition.ts";
import { correlateCodexQuotaRetryV2HttpRequest } from "../canonical/lib/codex-quota-retry.ts";

const OUT = ${evidenceFile};
const ROUTE = ${codexURL};
const MODULE_PROBE = ${moduleProbeURL};
const LIMIT = ${maxRequests};
const SAFE = new Set(${JSON.stringify([...SAFE_HEADERS])});
const stateKey = Symbol.for("codex-quota-retry.v2-canary");
const state = globalThis[stateKey] ?? { count: 0, blocked: 0, pendingGuardWrites: [],
  hookSessions: new Map(), probeFinished: false, budgetHit: false };
globalThis[stateKey] = state;
const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const startedAt = performance.now();
const write = async (label, data) => appendFile(OUT, JSON.stringify({ label, observedAtMs: Math.round(performance.now() - startedAt), observedAtEpochMs: Date.now(), ...data }) + "\\n", { mode: 0o600 });
const noteBlocked = (mechanism, destination = "unknown") => {
  state.blocked++;
  const pending = write("network.blocked", { mechanism, destination });
  state.pendingGuardWrites.push(pending);
  return pending;
};
const loopback = (url) => {
  try { const parsed = new URL(url); return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname); }
  catch { return false; }
};
const safeHeaderDigests = (headers) => {
  const found = [];
  try {
    const values = new Headers(headers);
    for (const name of SAFE) { const value = values.get(name); if (value) found.push({ name, digest: digest(value) }); }
  } catch {}
  return found;
};
const deny = async (url, mechanism) => {
  await noteBlocked(mechanism, (() => { try { return new URL(url).origin; } catch { return "unparseable"; } })());
  throw new Error("V2_CANARY_EXTERNAL_NETWORK_BLOCKED");
};

function installTransportInterposer() {
const originalFetch = globalThis.fetch;
const interposerFetch = async function(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (url === MODULE_PROBE) return new Response(null, { status: 204, headers: { "x-v2-canary-probe": "guarded-delegate" } });
  if (url === ROUTE && String(init?.method ?? input?.method ?? "GET").toUpperCase() === "POST") {
    if (state.count >= LIMIT) { state.budgetHit = true; return deny(url, "fetch-budget"); }
    state.count++;
    const outgoingHeaders = new Headers(init?.headers ?? input?.headers);
    const privateCorrelationHeaderAbsent = !outgoingHeaders.has("x-opencode-codex-quota-retry-correlation");
    await write("codex.fetch", { ordinal: state.count,
      privateCorrelationHeaderAbsent,
      allowedHeaderDigests: safeHeaderDigests(init?.headers ?? input?.headers) });
    if (!privateCorrelationHeaderAbsent) throw new Error("V2_CANARY_PRIVATE_CORRELATION_HEADER_LEAK");
    if (state.count === 1 || state.count === 3) {
      const retryAt = Date.now() + 5_000;
      return new Response(JSON.stringify({ error: { type: "usage_limit_reached" }, resets_at: retryAt }), {
        status: 429, headers: { "content-type": "application/json", "retry-after-ms": "5000" },
      });
    }
    return buildSyntheticResponsesSSE("synthetic canary success", state.count);
  }
  if (loopback(url)) return originalFetch.call(this, input, init);
  return deny(url, "fetch");
};

// Deny non-loopback native Node networking too; the Codex route is synthesized
// above and is never passed to any socket implementation.
for (const [module, name] of [[http, "http"], [https, "https"]]) {
  const original = module.request;
  module.request = function(input, ...args) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.hostname ? (module === https ? "https://" : "http://") + input.hostname : "";
    if (!loopback(url)) { void noteBlocked(name); throw new Error("V2_CANARY_EXTERNAL_NETWORK_BLOCKED:" + name); }
    return original.call(this, input, ...args);
  };
}
const loopbackHost = (host) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(host));
const originalConnect = net.connect;
net.connect = function(options, ...args) {
  const host = typeof options === "object" ? options.host ?? options.hostname
    : typeof options === "number" ? (typeof args[0] === "string" ? args[0] : "localhost") : options;
  if (!loopbackHost(host)) { void noteBlocked("node-net-connect"); throw new Error("V2_CANARY_EXTERNAL_SOCKET_BLOCKED"); }
  return originalConnect.call(this, options, ...args);
};
const originalTlsConnect = tls.connect;
tls.connect = function(options, ...args) {
  const host = typeof options === "object" ? options.host ?? options.hostname ?? options.servername
    : typeof options === "number" ? (typeof args[0] === "string" ? args[0] : args.find((entry) => entry && typeof entry === "object")?.host ?? "localhost") : options;
  if (!loopbackHost(host)) { void noteBlocked("node-tls-connect"); throw new Error("V2_CANARY_EXTERNAL_TLS_BLOCKED"); }
  return originalTlsConnect.call(this, options, ...args);
};
if (globalThis.Bun?.connect) {
  const originalBunConnect = globalThis.Bun.connect.bind(globalThis.Bun);
  globalThis.Bun.connect = function(options) {
    if (!loopbackHost(options?.hostname ?? options?.host)) { void noteBlocked("bun-connect"); throw new Error("V2_CANARY_EXTERNAL_BUN_CONNECT_BLOCKED"); }
    return originalBunConnect(options);
  };
  }
  globalThis.WebSocket = class DeniedWebSocket { constructor() { void noteBlocked("websocket"); throw new Error("V2_CANARY_WEBSOCKET_BLOCKED"); } };
globalThis.fetch = interposerFetch;
return { hostFetch: originalFetch, interposerFetch, cleanup: () => { if (globalThis.fetch === interposerFetch) globalThis.fetch = originalFetch; } };
}

import { Plugin } from "@opencode/plugin";
const moduleComposition = await initializeV2CanaryModule({
  installTransportInterposer,
  importCanonicalProduct: () => import("../canonical/plugins/codex-quota-retry-v2.ts"),
  verifyEarlyCapture: async ({ transport, capturedFetch }) => {
    const registry = (globalThis as any)[Symbol.for("opencode.codex-quota-retry.fetch-wrapper")];
    const registeredWrapper = (globalThis as any)[Symbol.for("opencode.codex-quota-retry.v2-fetch-wrapper")];
    if (capturedFetch === transport.hostFetch || capturedFetch !== registeredWrapper || capturedFetch !== registry?.wrapper
      || registry?.original !== transport.interposerFetch) {
      throw new Error("early_v2_wrapper_not_outer_captured_pointer");
    }
    const response = await capturedFetch(MODULE_PROBE);
    if (response.status !== 204 || response.headers.get("x-v2-canary-probe") !== "guarded-delegate") {
      throw new Error("early_v2_guarded_delegate_probe_failed");
    }
    await write("fixture-composition.module-capture", {
      mode: "fixture-composed-setup-not-loader-proof",
      guardsInstalledBeforeDynamicEarlyEntrypointImport: true,
      fetchReplacedBeforeEarlyEntrypointImport: true,
      hostCapturePointerMatchesRegisteredV2Wrapper: true,
      productOriginalEqualsGuardedInterposer: true,
      guardedDelegateProbe: "synthetic-non-network-non-provider",
      providerCallCounterContaminated: false,
    });
  },
});
export default Plugin.define({
  id: "codex-quota-retry-v2-canary",
  async setup(ctx) {
    const cleanup = await composeV2CanaryFixture({
      context: ctx,
      transport: moduleComposition.transport,
      assertCapturedWrapper: async () => {
        const registry = (globalThis as any)[Symbol.for("opencode.codex-quota-retry.fetch-wrapper")];
        const registeredWrapper = (globalThis as any)[Symbol.for("opencode.codex-quota-retry.v2-fetch-wrapper")];
        const compatible = globalThis.fetch === moduleComposition.capturedFetch
          && globalThis.fetch === registeredWrapper && globalThis.fetch === registry?.wrapper
          && registry?.original === moduleComposition.transport.interposerFetch;
        await write("fixture-composition.host-capture-check", {
          mode: "fixture-composed-setup-not-loader-proof", hostCaptureMatchesEarlyWrapper: compatible,
          outerCapturedFetchIsRegisteredV2Wrapper: globalThis.fetch === registeredWrapper,
          productOriginalIsGuardedInterposer: registry?.original === moduleComposition.transport.interposerFetch,
        });
        if (!compatible) throw new Error("early_v2_wrapper_not_outer_captured_pointer");
      },
      setupFixtureRecorder: async (ctx) => {
    const controller = new AbortController();
    const registrations = [];
    registrations.push(await ctx.session.hook("model.request", async (event) => {
      await write("model.request", { eventSessionDigest: typeof event.sessionID === "string" ? digest(event.sessionID) : undefined,
        identitySource: "native-model.request-hook", eventKind: event.kind });
    }));
    registrations.push(await ctx.session.hook("http.request", async (event) => {
      const sessionDigest = typeof event.sessionID === "string" ? digest(event.sessionID) : undefined;
      if (sessionDigest && !state.hookSessions.has(sessionDigest)) state.hookSessions.set(sessionDigest, state.hookSessions.size === 0 ? "root" : state.hookSessions.size === 1 ? "child" : "sibling");
      await write("http.request", { eventSessionDigest: sessionDigest, identitySource: "native-http.request-hook",
        sessionRole: sessionDigest ? state.hookSessions.get(sessionDigest) : undefined,
        eventKind: event.kind,
        allowedHeaderDigests: safeHeaderDigests(event.request?.headers) });
    }));
    registrations.push(await ctx.session.hook("http.response", async (event) => {
      await write("http.response", { eventSessionDigest: typeof event.sessionID === "string" ? digest(event.sessionID) : undefined,
        identitySource: "native-http.response-hook", sessionRole: typeof event.sessionID === "string" ? state.hookSessions.get(digest(event.sessionID)) : undefined,
        eventKind: event.kind,
        status: event.response?.status });
    }));
    const eventSubscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event?.data ?? {};
          if (event.type === "session.retry.scheduled") await write("session.retry.scheduled", {
            eventSessionDigest: typeof data.sessionID === "string" ? digest(data.sessionID) : undefined,
            identitySource: "native-event.data.sessionID",
            sessionRole: typeof data.sessionID === "string" ? state.hookSessions.get(digest(data.sessionID)) : undefined,
            at: typeof data.at === "number" || typeof data.at === "string" ? data.at : undefined,
          });
          else if (event.type === "session.execution.interrupted") {
            const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
            const sessionDigest = sessionID ? digest(sessionID) : undefined;
            await write("session.execution.interrupted", { eventSessionDigest: sessionDigest,
              identitySource: "native-event.data.sessionID", sessionRole: sessionDigest ? state.hookSessions.get(sessionDigest) : undefined,
              reason: typeof data.reason === "string" ? data.reason : undefined,
              providerCallsAtInterruption: state.count });
            if (sessionID && sessionDigest && state.hookSessions.get(sessionDigest) === "child" && !state.probeFinished) {
              const runControlledProbe = async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
                const callsBefore = state.count;
                for (let probe = 1; probe <= 2; probe++) {
                  const request = new Request(ROUTE, { method: "POST", headers: { "x-session-id": "root-native-header-is-not-used-for-correlation" } });
                  const correlated = { kind: "primary", sessionID, request };
                  if (!correlateCodexQuotaRetryV2HttpRequest(correlated)) throw new Error("late_probe_native_correlation_failed");
                  try {
                    await globalThis.fetch(correlated.request);
                    await write("controlled-late-fetch-probe", { probe, result: "unexpected_delegate_success", exactSessionDigest: sessionDigest });
                  } catch (error) {
                    await write("controlled-late-fetch-probe", { probe, result: error?.name === "AbortError" ? "AbortError" : "unexpected_error",
                      exactSessionDigest: sessionDigest, identitySource: "native-http.request-hook-via-exported-correlator",
                      providerCallsBefore: callsBefore, providerCallsAfter: state.count });
                  }
                }
                state.probeFinished = true;
              };
              await runControlledProbe();
            }
          }
          else if (event.type === "session.execution.succeeded") {
            const sessionDigest = typeof data.sessionID === "string" ? digest(data.sessionID) : undefined;
            await write("session.execution.succeeded", { eventSessionDigest: sessionDigest, identitySource: "native-event.data.sessionID",
              sessionRole: sessionDigest ? state.hookSessions.get(sessionDigest) : undefined });
            if (sessionDigest && state.hookSessions.get(sessionDigest) === "sibling") {
              await write("fixture.network-guard.summary", { blockedAttempts: state.blocked, providerCalls: state.count,
                providerCallLimit: LIMIT, budgetHit: state.budgetHit, externalNetworkPolicy: "application-level-deny",
                final: false, summarySource: "session.execution.succeeded" });
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) await write("event.subscribe.error", { errorName: error?.name ?? "Error" });
      }
    })();
    return async () => {
      controller.abort();
      await Promise.all(registrations.map((registration) => registration.dispose()));
      await eventSubscription;
      await Promise.all(state.pendingGuardWrites);
      await write("fixture.network-guard.summary", { blockedAttempts: state.blocked, providerCalls: state.count,
        providerCallLimit: LIMIT, budgetHit: state.budgetHit, externalNetworkPolicy: "application-level-deny",
        final: true, summarySource: "fixture-teardown-after-subscription-cleanup" });
    };
      },
      setupCanonicalProduct: async (ctx) => {
        const fetchBeforeCanonicalSetup = globalThis.fetch;
        const productCleanup = await moduleComposition.product.default.setup(ctx);
        const fetchAfterCanonicalSetup = globalThis.fetch;
        const wrapperRegistered = (globalThis as any)[Symbol.for("opencode.codex-quota-retry.v2-fetch-wrapper")] === fetchAfterCanonicalSetup;
        const compatible = fetchBeforeCanonicalSetup === fetchAfterCanonicalSetup
          && fetchAfterCanonicalSetup === moduleComposition.capturedFetch && wrapperRegistered;
        await write("fixture-composition.canonical-setup", {
          mode: "fixture-composed-setup-not-loader-proof",
          earlyEntrypointInstalledBeforeCanonicalSetup: true,
          fetchBeforeCanonicalSetupMatchesEarlyCapture: fetchBeforeCanonicalSetup === moduleComposition.capturedFetch,
          fetchAfterCanonicalSetupMatchesEarlyCapture: fetchAfterCanonicalSetup === moduleComposition.capturedFetch,
          fetchChangedDuringCanonicalSetup: fetchBeforeCanonicalSetup !== fetchAfterCanonicalSetup,
          v2WrapperRegistrationCompatible: wrapperRegistered,
          compatible,
        });
        if (!compatible) throw new Error("canonical_product_wrapper_registration_incompatible");
        return productCleanup;
      },
    });
    return cleanup;
  },
});
`;
}

async function apiJson(base: string, endpoint: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await fetch(`${base}${endpoint}`, { ...init, signal: AbortSignal.timeout(80_000), headers: { authorization: serverAuthorization, "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  const safeEndpoint = endpoint.replace(/\/session\/[^/]+/g, "/session/[SESSION_ID]");
  await record("api.response", { endpoint: safeEndpoint, status: response.status, contentType: response.headers.get("content-type") ?? "" });
  if (!response.ok) throw new Error(`API ${safeEndpoint} returned HTTP ${response.status}`);
  try {
    const decoded = JSON.parse(text) as JsonRecord;
    return decoded.data && typeof decoded.data === "object" ? decoded.data as JsonRecord : decoded;
  } catch { throw new Error(`API ${safeEndpoint} returned non-JSON`); }
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  return message.replace(/ses_[A-Za-z0-9_-]+/g, "[SESSION_ID_REDACTED]")
    .replace(/(authorization\s*[:=]\s*['"]?(?:Bearer|Basic)\s+)[^\s'";,]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s'"<>]+/gi, "[URL_REDACTED]")
    .replace(/\s+/g, " ").slice(0, 300);
}

async function apiEmpty(base: string, endpoint: string, init: RequestInit = { method: "POST" }): Promise<void> {
  const response = await fetch(`${base}${endpoint}`, { ...init, signal: AbortSignal.timeout(80_000), headers: { authorization: serverAuthorization } });
  const safeEndpoint = endpoint.replace(/\/session\/[^/]+/g, "/session/[SESSION_ID]");
  await record("api.response", { endpoint: safeEndpoint, status: response.status });
  if (!response.ok) throw new Error(`API ${safeEndpoint} returned HTTP ${response.status}`);
  await response.arrayBuffer();
}

async function waitForEvidence(predicate: (entry: JsonRecord) => boolean, timeoutMs: number, label: string): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await readFile(EVIDENCE, "utf8").catch(() => "");
    for (const line of lines.split("\n")) {
      if (!line) continue;
      try { const entry = JSON.parse(line) as JsonRecord; if (predicate(entry)) return entry; } catch {}
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`native_evidence_timeout:${label}`);
}

export function assistantTranscript(value: unknown): { messageCount: number; textParts: string[]; errorReasons: string[] } {
  const root = value && typeof value === "object" ? value as JsonRecord : {};
  const list = Array.isArray(value) ? value : Array.isArray(root.data) ? root.data as unknown[] : [];
  const assistants = list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const message = item as JsonRecord;
    if (message.type === "assistant") return [message];
    const info = message.info && typeof message.info === "object" ? message.info as JsonRecord : undefined;
    return info?.type === "assistant" ? [{ ...message, ...info, content: message.parts }] : [];
  });
  const textParts = assistants.flatMap((message) => Array.isArray(message.content)
    ? (message.content as unknown[]).flatMap((part) => part && typeof part === "object"
      && (part as JsonRecord).type === "text" && typeof (part as JsonRecord).text === "string"
      ? [(part as JsonRecord).text as string] : [])
    : []);
  const errorReasons = assistants.flatMap((message) => {
    const error = message.error;
    if (!error || typeof error !== "object") return [];
    const record = error as JsonRecord;
    const errorType = typeof record.type === "string" ? record.type : "assistant_error";
    const detail = typeof record.message === "string" ? record.message : "";
    const code = detail.match(/\bprovider\.[a-z0-9_.-]+/i)?.[0];
    return [code ?? errorType.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)];
  });
  return { messageCount: assistants.length, textParts, errorReasons };
}

async function assertAssistantTranscript(role: string, sessionID: string, transcript: unknown): Promise<void> {
  const assistant = assistantTranscript(transcript);
  const persistedSyntheticText = assistant.textParts.some((text) => text === "synthetic canary success");
  const assistantErrorReason = persistedSyntheticText ? undefined : assistant.errorReasons[0] ?? "assistant_text_part_missing";
  await record("transcript.assertion", { role, sessionDigest: digest(sessionID), persistedSyntheticText,
    assistantMessageCount: assistant.messageCount, assistantTextPartCount: assistant.textParts.length,
    assistantErrorReason, text: persistedSyntheticText ? "synthetic canary success" : undefined,
    evidenceSource: "installed-v2-session-message-assistant-content" });
  if (!persistedSyntheticText) {
    throw new Error(`${role}_assistant_text_missing:${assistantErrorReason}|messages=${assistant.messageCount}|textParts=${assistant.textParts.length}`);
  }
}

async function waitForServer(base: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastHTTPStatus: number | null = null;
  let lastErrorName: string | null = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    if (child.exitCode !== null) {
      await record("server.readiness", { ready: false, lastHTTPStatus, lastErrorName, attempts, serverExitCode: child.exitCode });
      throw new Error(`opencode_server_exited_before_ready:last_http_status=${lastHTTPStatus ?? "none"}`);
    }
    try {
      const response = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(2_000), headers: { authorization: serverAuthorization } });
      lastHTTPStatus = response.status;
      lastErrorName = null;
      if (response.ok) {
        const spec = await response.json() as JsonRecord;
        const paths = spec.paths && typeof spec.paths === "object" ? Object.keys(spec.paths as JsonRecord) : [];
        await record("openapi.discovered", { paths: paths.sort() });
        await record("server.readiness", { ready: true, lastHTTPStatus, attempts });
        return;
      }
    } catch (error) {
      lastErrorName = error instanceof Error ? error.name : "Error";
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  await record("server.readiness", { ready: false, lastHTTPStatus, lastErrorName, attempts });
  throw new Error(`opencode_server_readiness_timeout:last_http_status=${lastHTTPStatus ?? "none"}`);
}

async function run(): Promise<void> {
  const installedVersion = runCommand("opencode", ["--version"]);
  const installedClient = await verifyInstalledClientContract();
  await mkdir(join(RUN_DIR, "xdg-config", "opencode"), { recursive: true, mode: 0o700 });
  await mkdir(join(RUN_DIR, "xdg-data", "opencode"), { recursive: true, mode: 0o700 });
  await mkdir(join(RUN_DIR, "xdg-state", "opencode"), { recursive: true, mode: 0o700 });
  await mkdir(join(RUN_DIR, "xdg-cache"), { recursive: true, mode: 0o700 });
  await mkdir(join(RUN_DIR, "xdg-config", "opencode", "plugins"), { recursive: true, mode: 0o700 });
  await mkdir(WORKSPACE, { recursive: true, mode: 0o700 });
  await mkdir(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const snapshotsDir = join(EVIDENCE_DIR, "source-snapshots");
  await mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  await writeFile(join(EVIDENCE_DIR, "expected-scenarios.json"), JSON.stringify(EXPECTED_SCENARIOS, null, 2), { mode: 0o600 });
  await record("canary.start", { runID: RUN_ID, installedVersion, timeLimitMs: LIMIT_MS,
    maxProviderRequests: MAX_PROVIDER_REQUESTS, isolation: "application-level-network-guards; not OS-level egress isolation",
    projectConfigDisabled: true, evidenceRelativePath: relative(REPO_ROOT, EVIDENCE_DIR) });

  // Deliberately write the only auth fixture before creating the isolated DB.
  await writeFile(SYNTHETIC_AUTH, JSON.stringify({ openai: {
    type: "oauth", access: "synthetic", refresh: "synthetic", expires: Date.now() + 86_400_000,
  } }, null, 2), { mode: 0o600 });
  const fixtureSource = fixturePluginSource();
  const canonicalEntrypoint = await readFile(PRODUCT_PLUGIN);
  const canonicalHelper = await readFile(PRODUCT_HELPER);
  const fixturePath = join(RUN_DIR, "xdg-config", "opencode", "plugins", "00-v2-fixture.ts");
  const canonicalRoot = join(RUN_DIR, "xdg-config", "opencode", "canonical");
  const productPath = join(canonicalRoot, "plugins", "codex-quota-retry-v2.ts");
  const helperPath = join(canonicalRoot, "lib", "codex-quota-retry.ts");
  const compositionPath = join(canonicalRoot, "composition.ts");
  await mkdir(join(canonicalRoot, "plugins"), { recursive: true, mode: 0o700 });
  await mkdir(join(canonicalRoot, "lib"), { recursive: true, mode: 0o700 });
  const compositionSource = await readFile(fileURLToPath(new URL("./v2_canary_composition.ts", import.meta.url)));
  await writeFile(fixturePath, fixtureSource, { mode: 0o600 });
  await writeFile(productPath, canonicalEntrypoint, { mode: 0o600 });
  await writeFile(helperPath, canonicalHelper, { mode: 0o600 });
  await writeFile(compositionPath, compositionSource, { mode: 0o600 });
  const copiedPlugin = await readFile(productPath);
  const copiedHelper = await readFile(helperPath);
  if (!copiedPlugin.equals(canonicalEntrypoint) || !copiedHelper.equals(canonicalHelper)) {
    throw new Error("canonical_fixture_source_copy_mismatch");
  }
  await record("fixture-composition.source-identity", {
    canonicalEarlyEntrypointSha256: sha256(canonicalEntrypoint.toString("utf8")),
    copiedPluginSha256: sha256(copiedPlugin.toString("utf8")),
    canonicalHelperSha256: sha256(canonicalHelper.toString("utf8")),
    copiedHelperSha256: sha256(copiedHelper.toString("utf8")),
    byteIdentical: true, canonicalDirectoryAutoDiscovered: false,
  });
  await record("plugin.load-order.expected", { source: "fixture-module-guards-before-dynamic-early-v2-import",
    autoLoadedFiles: ["00-v2-fixture.ts"], canonicalEarlyEntrypointPath: "canonical/plugins/codex-quota-retry-v2.ts",
    canonicalHelperPath: "canonical/lib/codex-quota-retry.ts", dynamicImportAfterModuleGuardInstall: true,
    canonicalSetupRunsInFixtureSetup: true, loaderOrderingProofClaimed: false });
  const config = {
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    model: "openai/gpt-6.1-sol",
    providers: { openai: {
      settings: { baseURL: "https://chatgpt.com/backend-api/codex", transport: "http", encoding: "none" },
      models: { "gpt-6.1-sol": { name: "GPT-6.1 Sol V2 retry canary", limit: { context: 8192, output: 1024 } } },
    } },
  };
  const configText = JSON.stringify(config, null, 2);
  await writeFile(join(RUN_DIR, "xdg-config", "opencode", "opencode.json"), configText, { mode: 0o600 });
  const scriptSource = await readFile(fileURLToPath(import.meta.url), "utf8");
  await writeFile(join(snapshotsDir, "v2_retry_canary.ts"), scriptSource, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "00-v2-fixture.ts"), fixtureSource, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "canonical-early-entrypoint.ts"), canonicalEntrypoint, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "codex-quota-retry.ts"), canonicalHelper, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "v2_canary_composition.ts"), compositionSource, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "opencode.json"), configText, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "opencode-client-generated.js"), installedClient.clientSource, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "opencode-client-types.d.ts"), installedClient.typeSource, { mode: 0o600 });
  await writeFile(join(snapshotsDir, "source-hashes.json"), JSON.stringify({
    schema: "codex-quota-retry-v2-canary-sources.v1",
    binaryVersion: installedVersion,
    sources: {
      harness: sha256(scriptSource), fixturePlugin: sha256(fixtureSource),
      canonicalEarlyEntrypoint: sha256(canonicalEntrypoint.toString("utf8")), canonicalHelper: sha256(canonicalHelper.toString("utf8")),
      compositionHelper: sha256(compositionSource.toString("utf8")),
      config: sha256(configText),
      installedClientGeneratedRoutes: sha256(installedClient.clientSource), installedClientSchemas: sha256(installedClient.typeSource),
    },
    installedClientPaths: { generatedRoutes: CLIENT_CHUNK, schemas: CLIENT_TYPES },
  }, null, 2), { mode: 0o600 });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const serverUsername = "opencode";
  const serverPassword = randomUUID();
  serverAuthorization = `Basic ${Buffer.from(`${serverUsername}:${serverPassword}`).toString("base64")}`;
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_ALL|TERM|SYSTEMROOT|WINDIR|PATHEXT)$/i.test(key) && value) cleanEnv[key] = value;
    if (/^(CODEX|OPENAI|OPENCODE|ANTHROPIC|AZURE|AWS|GOOGLE|GITHUB|HUGGINGFACE|HF)_/i.test(key)) delete cleanEnv[key];
  }
  const env = {
    ...cleanEnv, HOME: join(RUN_DIR, "home"), XDG_CONFIG_HOME: join(RUN_DIR, "xdg-config"),
    XDG_DATA_HOME: join(RUN_DIR, "xdg-data"), XDG_STATE_HOME: join(RUN_DIR, "xdg-state"), XDG_CACHE_HOME: join(RUN_DIR, "xdg-cache"),
    OPENCODE_CONFIG_DIR: join(RUN_DIR, "xdg-config", "opencode"), OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_GOAL_STATE_PATH: join(RUN_DIR, "goal-state.json"),
    OPENCODE_SERVER_PASSWORD: serverPassword,
  };
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  const remainingRunMs = LIMIT_MS - (performance.now() - START_MONOTONIC_MS);
  if (remainingRunMs <= 0) throw new Error("installed_gate_setup_exceeded_180_seconds");
  const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: WORKSPACE, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const maxLogBytes = 128 * 1024;
  const captureTail = (chunks: Buffer[], chunk: Buffer): void => {
    const combined = Buffer.concat([...chunks, Buffer.from(chunk)]);
    chunks.splice(0, chunks.length, Buffer.from(combined.subarray(-maxLogBytes)));
  };
  server.stdout?.on("data", (chunk: Buffer) => captureTail(stdout, chunk));
  server.stderr?.on("data", (chunk: Buffer) => captureTail(stderr, chunk));
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; server.kill("SIGTERM"); }, remainingRunMs);
  try {
    await waitForServer(base, server);
    await record("api.contract", { createPath: "/api/session", promptPath: "/api/session/{sessionID}/prompt",
      parentIDConfirmedByInstalledClientSchema: true, shapeSource: "installed-@opencode/client-generated-source" });
    await record("scenario.started", { source: "installed-v2-api-ready" });

    const location = { directory: WORKSPACE };
    const root = await apiJson(base, "/api/session", { method: "POST", body: JSON.stringify({
      title: "Synthetic V2 quota retry canary", location, model: { providerID: "openai", id: "gpt-6.1-sol" },
    }) });
    const rootID = typeof root.id === "string" ? root.id : typeof root.sessionID === "string" ? root.sessionID : undefined;
    if (!rootID) throw new Error("Session create response did not expose a session ID");
    await record("session.created", { role: "root", sessionDigest: digest(rootID) });
    const promptPath = `/api/session/${encodeURIComponent(rootID)}/prompt`;
    const prompt = await fetch(`${base}${promptPath}`, { method: "POST", signal: AbortSignal.timeout(80_000), headers: { authorization: serverAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Reply with the exact words synthetic canary success." }) });
    await record("session.prompt", { role: "root", status: prompt.status });
    if (!prompt.ok) throw new Error(`Root prompt returned HTTP ${prompt.status}`);
    await prompt.arrayBuffer();
    await apiEmpty(base, `/api/experimental/session/${encodeURIComponent(rootID)}/wait`);
    const rootTranscript = await apiJson(base, `/api/session/${encodeURIComponent(rootID)}/message`);
    await assertAssistantTranscript("root", rootID, rootTranscript);

    const child = await apiJson(base, "/api/session", { method: "POST", body: JSON.stringify({
      title: "Synthetic V2 quota retry child", parentID: rootID, location,
      model: { providerID: "openai", id: "gpt-6.1-sol" },
    }) });
    const childID = typeof child.id === "string" ? child.id : typeof child.sessionID === "string" ? child.sessionID : undefined;
    if (!childID) throw new Error("Child session response did not expose a session ID");
    await record("session.created", { role: "child", sessionDigest: digest(childID), rootSessionDigest: digest(rootID) });
    const childDigest = digest(childID);
    const childPrompt = await fetch(`${base}/api/session/${encodeURIComponent(childID)}/prompt`, { method: "POST", signal: AbortSignal.timeout(80_000), headers: { authorization: serverAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Reply with the exact words synthetic canary success." }) });
    await record("session.prompt", { role: "child", status: childPrompt.status });
    if (!childPrompt.ok) throw new Error(`Child prompt returned HTTP ${childPrompt.status}`);
    await childPrompt.arrayBuffer();
    const childRetry = await waitForEvidence((entry) => entry.label === "session.retry.scheduled" && entry.eventSessionDigest === childDigest, 15_000, "child_retry_schedule");
    const retryAt = Number(childRetry.at);
    if (!Number.isFinite(retryAt) || retryAt <= Date.now()) throw new Error("child_retry_deadline_invalid");
    await record("child.retry.expected", { sessionDigest: childDigest, retryAt, evidenceSource: "native-event.data.at" });
    const interruptRequest = buildSessionInterruptRequest(childID);
    await apiEmpty(base, interruptRequest.endpoint, interruptRequest.init);
    const interruption = await waitForEvidence((entry) => entry.label === "session.execution.interrupted"
      && entry.eventSessionDigest === childDigest, 10_000, "child_interruption");
    if (interruption.reason !== "user") throw new Error("child_native_interruption_reason_mismatch");
    await record("session.state.assertion", { role: "child", sessionDigest: childDigest,
      nativeExecutionInterrupted: true, reason: "user", identitySource: "native-event.data.sessionID",
      sourceEvent: "session.execution.interrupted" });
    await waitForEvidence((entry) => entry.label === "controlled-late-fetch-probe" && entry.probe === 2, 5_000, "controlled_probe_completion");
    const probeEntries = (await readFile(EVIDENCE, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
      try { const item = JSON.parse(line) as JsonRecord; return item.label === "controlled-late-fetch-probe" ? [item] : []; } catch { return []; }
    });
    if (probeEntries.length !== 2 || probeEntries.some((entry) => entry.result !== "AbortError"
      || entry.exactSessionDigest !== childDigest || entry.providerCallsBefore !== entry.providerCallsAfter)) {
      throw new Error("controlled_late_probe_assertion_failed");
    }
    const noLateCallDeadline = retryAt + 1_500;
    const remaining = noLateCallDeadline - Date.now();
    if (remaining > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining));
    if (timedOut) throw new Error("installed_gate_timed_out_before_child_deadline");
    const beforeSiblingLines = (await readFile(EVIDENCE, "utf8")).split("\n").filter(Boolean);
    const providerCallsBeforeSibling = beforeSiblingLines.filter((line) => line.includes('"label":"codex.fetch"')).length;
    const noLateProviderCall = providerCallsBeforeSibling === 3;
    await record("child.no-late-provider-call", { sessionDigest: childDigest, identitySource: "native-event.data.sessionID",
      scheduledRetryAt: retryAt, checkedAt: Date.now(), deadlineAndMarkerGraceElapsed: Date.now() >= noLateCallDeadline,
      providerCallsAtInterruption: interruption.providerCallsAtInterruption, providerCallsBeforeSibling, noLateProviderCall });
    if (!noLateProviderCall) throw new Error("child_provider_call_observed_after_native_interruption");

    const sibling = await apiJson(base, "/api/session", { method: "POST", body: JSON.stringify({
      title: "Synthetic V2 quota retry sibling", parentID: rootID, location,
      model: { providerID: "openai", id: "gpt-6.1-sol" },
    }) });
    const siblingID = typeof sibling.id === "string" ? sibling.id : typeof sibling.sessionID === "string" ? sibling.sessionID : undefined;
    if (!siblingID) throw new Error("Sibling session create response did not expose a session ID");
    await record("session.created", { role: "sibling", sessionDigest: digest(siblingID), rootSessionDigest: digest(rootID) });
    const siblingPrompt = await fetch(`${base}/api/session/${encodeURIComponent(siblingID)}/prompt`, { method: "POST", signal: AbortSignal.timeout(80_000), headers: { authorization: serverAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Reply with the exact words synthetic canary success." }) });
    await record("session.prompt", { role: "sibling", status: siblingPrompt.status });
    if (!siblingPrompt.ok) throw new Error(`Sibling prompt returned HTTP ${siblingPrompt.status}`);
    await siblingPrompt.arrayBuffer();
    await apiEmpty(base, `/api/experimental/session/${encodeURIComponent(siblingID)}/wait`);
    const siblingTranscript = await apiJson(base, `/api/session/${encodeURIComponent(siblingID)}/message`);
    await assertAssistantTranscript("sibling", siblingID, siblingTranscript);
    await record("scenario.completed", { rootSessionDigest: digest(rootID), childSessionDigest: childDigest,
      siblingSessionDigest: digest(siblingID), providerCalls: providerCallsBeforeSibling + 1 });
  } catch (error) {
    const reason = safeFailureReason(error);
    const failureClass = isAssertionOrLeakFailure(error) ? "FAIL" : "BLOCKED";
    await record(failureClass === "FAIL" ? "scenario.failed" : "scenario.blocked", { reason, failureClass });
    console.error(`[${failureClass}] V2 installed-runtime exploratory canary; evidence=${relative(REPO_ROOT, EVIDENCE_DIR)}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    if (server.exitCode === null) server.kill("SIGTERM");
    const waitForExit = async (ms: number): Promise<void> => new Promise((resolvePromise) => {
      if (server.exitCode !== null || server.signalCode !== null) return resolvePromise();
      const timer = setTimeout(resolvePromise, ms);
      server.once("exit", () => { clearTimeout(timer); resolvePromise(); });
    });
    await waitForExit(3_000);
    if (server.exitCode === null && server.signalCode === null) {
      await record("server.teardown", { pid: server.pid, action: "SIGKILL-owned-child-after-SIGTERM-timeout" });
      server.kill("SIGKILL");
      await waitForExit(1_000);
    }
    const preSummary = (await readFile(EVIDENCE, "utf8").catch(() => "")).split("\n").filter(Boolean)
      .flatMap((line) => { try { return [JSON.parse(line) as JsonRecord]; } catch { return []; } });
    const blockedCountAtExit = preSummary.filter((entry) => entry.label === "network.blocked").length;
    await record("fixture.network-guard.summary", {
      blockedAttempts: blockedCountAtExit, blockedEventCount: blockedCountAtExit,
      providerCalls: preSummary.filter((entry) => entry.label === "codex.fetch").length,
      providerCallLimit: MAX_PROVIDER_REQUESTS,
      budgetHit: preSummary.some((entry) => entry.label === "network.blocked" && entry.mechanism === "fetch-budget"),
      externalNetworkPolicy: "application-level-deny", final: true,
      summarySource: "parent-after-owned-server-exit",
    });
    const lines = await readFile(EVIDENCE, "utf8").catch(() => "");
    const providerRequestCount = lines.split("\n").filter((line) => line.includes('"label":"codex.fetch"')).length;
    const entries = lines.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as JsonRecord]; } catch { return []; } });
    const createdDigest = (role: string) => entries.find((entry) => entry.label === "session.created" && entry.role === role)?.sessionDigest;
    const rootDigest = createdDigest("root");
    const childDigest = createdDigest("child");
    const siblingDigest = createdDigest("sibling");
    const responsesFor = (sessionDigest: unknown) => entries.filter((entry) => entry.label === "http.response" && entry.eventSessionDigest === sessionDigest).map((entry) => entry.status);
    const noLateEvidence = entries.find((entry) => entry.label === "child.no-late-provider-call");
    const siblingSuccessResponse = entries.find((entry) => entry.label === "http.response" && entry.eventSessionDigest === siblingDigest && entry.status === 200);
    const siblingCreation = entries.find((entry) => entry.label === "session.created" && entry.role === "sibling");
    const probes = entries.filter((entry) => entry.label === "controlled-late-fetch-probe");
    const networkSummaries = entries.filter((entry) => entry.label === "fixture.network-guard.summary");
    const network = networkSummaries.at(-1);
    const scenarioCompleted = entries.find((entry) => entry.label === "scenario.completed");
    const networkBlockedEvents = entries.filter((entry) => entry.label === "network.blocked").length;
    const assertions = {
      rootDelegatedQuota: responsesFor(rootDigest).includes(429),
      rootNativeRetry: entries.some((entry) => entry.label === "session.retry.scheduled" && entry.eventSessionDigest === rootDigest),
      rootSyntheticSuccess: responsesFor(rootDigest).includes(200) && entries.some((entry) => entry.label === "transcript.assertion" && entry.role === "root" && entry.persistedSyntheticText === true),
      childDelegatedQuota: responsesFor(childDigest).includes(429),
      childNativeInterruption: entries.some((entry) => entry.label === "session.execution.interrupted" && entry.eventSessionDigest === childDigest && entry.reason === "user")
        && entries.some((entry) => entry.label === "session.state.assertion" && entry.role === "child" && entry.sessionDigest === childDigest && entry.nativeExecutionInterrupted === true),
      childNoLateProviderCall: entries.some((entry) => entry.label === "child.no-late-provider-call" && entry.noLateProviderCall === true),
      controlledExactLateProbes: probes.length === 2 && probes.every((entry) => entry.result === "AbortError" && entry.exactSessionDigest === childDigest && entry.providerCallsBefore === entry.providerCallsAfter),
      siblingAfterCooldown: responsesFor(siblingDigest).includes(200) && entries.some((entry) => entry.label === "transcript.assertion" && entry.role === "sibling" && entry.persistedSyntheticText === true)
        && siblingCreation?.rootSessionDigest === rootDigest && noLateEvidence?.deadlineAndMarkerGraceElapsed === true
        && typeof siblingSuccessResponse?.observedAtEpochMs === "number" && siblingSuccessResponse.observedAtEpochMs >= Number(noLateEvidence?.checkedAt),
      providerCallBound: providerRequestCount === 4 && providerRequestCount <= MAX_PROVIDER_REQUESTS && network?.budgetHit === false,
      privateCorrelationHeaderNotSent: entries.filter((entry) => entry.label === "codex.fetch").length === providerRequestCount
        && entries.filter((entry) => entry.label === "codex.fetch").every((entry) => entry.privateCorrelationHeaderAbsent === true),
      fixtureComposedCanonicalSetup: entries.some((entry) => entry.label === "fixture-composition.canonical-setup"
        && entry.mode === "fixture-composed-setup-not-loader-proof" && entry.earlyEntrypointInstalledBeforeCanonicalSetup === true
        && entry.fetchBeforeCanonicalSetupMatchesEarlyCapture === true && entry.fetchAfterCanonicalSetupMatchesEarlyCapture === true
        && entry.fetchChangedDuringCanonicalSetup === false && entry.v2WrapperRegistrationCompatible === true && entry.compatible === true),
      earlyModuleCaptureAndGuardedDelegate: entries.some((entry) => entry.label === "fixture-composition.module-capture"
        && entry.guardsInstalledBeforeDynamicEarlyEntrypointImport === true
        && entry.fetchReplacedBeforeEarlyEntrypointImport === true
        && entry.hostCapturePointerMatchesRegisteredV2Wrapper === true && entry.productOriginalEqualsGuardedInterposer === true
        && entry.guardedDelegateProbe === "synthetic-non-network-non-provider" && entry.providerCallCounterContaminated === false)
        && entries.some((entry) => entry.label === "fixture-composition.host-capture-check" && entry.hostCaptureMatchesEarlyWrapper === true),
      canonicalSourcesByteIdentical: entries.some((entry) => entry.label === "fixture-composition.source-identity"
        && entry.byteIdentical === true && entry.canonicalEarlyEntrypointSha256 === entry.copiedPluginSha256
        && entry.canonicalHelperSha256 === entry.copiedHelperSha256 && entry.canonicalDirectoryAutoDiscovered === false),
      applicationNetworkDenied: network?.blockedAttempts === 0 && network?.externalNetworkPolicy === "application-level-deny",
      finalGuardSummaryAfterScenario: network?.final === true && network?.summarySource === "parent-after-owned-server-exit"
        && typeof scenarioCompleted?.observedAtEpochMs === "number" && typeof network.observedAtEpochMs === "number"
        && network.observedAtEpochMs > scenarioCompleted.observedAtEpochMs,
      allGuardDenialsCounted: network?.blockedAttempts === networkBlockedEvents && network?.blockedEventCount === networkBlockedEvents,
      elapsedBound: performance.now() - START_MONOTONIC_MS <= LIMIT_MS && !timedOut,
      ownedServerTerminated: server.exitCode !== null || server.signalCode !== null,
    };
    const hardFailure = entries.some((entry) => entry.label === "scenario.failed")
      || entries.some((entry) => entry.label === "codex.fetch" && entry.privateCorrelationHeaderAbsent !== true) || timedOut
      || providerRequestCount > MAX_PROVIDER_REQUESTS || network?.budgetHit === true
      || networkBlockedEvents > 0 || performance.now() - START_MONOTONIC_MS > LIMIT_MS;
    const status = Object.values(assertions).every(Boolean) ? "PASS"
      : hardFailure || entries.some((entry) => entry.label === "scenario.started") ? "FAIL" : "BLOCKED";
    await record("canary.end", { timedOut, serverPID: server.pid, serverExitCode: server.exitCode,
      serverSignalCode: server.signalCode, providerRequestCount, elapsedMs: Math.round(performance.now() - START_MONOTONIC_MS),
      evidenceRelativePath: relative(REPO_ROOT, EVIDENCE_DIR) });
    const sanitize = (text: string): string => text
      .replaceAll(serverPassword, "[SYNTHETIC_SERVER_PASSWORD_REDACTED]")
      .replaceAll("synthetic", "[SYNTHETIC_FIXTURE_VALUE_REDACTED]")
      .replaceAll("Reply with the exact words [SYNTHETIC_FIXTURE_VALUE_REDACTED] canary success.", "[PROMPT_REDACTED]")
      .replace(/ses_[A-Za-z0-9_-]+/g, "[SESSION_ID_REDACTED]")
      .replace(/((?:authorization|api[-_]?key|cookie|set-cookie|session-id|x-session-id)\s*[:=]\s*)[^\s,;]+/gi, "$1[HEADER_VALUE_REDACTED]")
      .replace(/(authorization\s*[:=]\s*['"]?(?:Bearer|Basic)\s+)[^\s'";,]+/gi, "$1[REDACTED]");
    const tail = (chunks: Buffer[]): string => Buffer.concat(chunks).subarray(-maxLogBytes).toString("utf8");
    await writeFile(join(EVIDENCE_DIR, "server.stdout.log"), sanitize(tail(stdout)), { mode: 0o600 });
    await writeFile(join(EVIDENCE_DIR, "server.stderr.log"), sanitize(tail(stderr)), { mode: 0o600 });
    await writeFile(join(EVIDENCE_DIR, "verdict.json"), JSON.stringify({ schema: "codex-quota-retry-v2-verdict.v1",
      status, installedLiveProof: status === "PASS", installedVersion, assertions,
      providerRequestCount, maxProviderCalls: MAX_PROVIDER_REQUESTS, elapsedMs: Math.round(performance.now() - START_MONOTONIC_MS),
      maxDurationMs: LIMIT_MS, serverPID: server.pid, serverExitCode: server.exitCode, serverSignalCode: server.signalCode,
      evidenceRelativePath: relative(REPO_ROOT, EVIDENCE_DIR) }, null, 2), { mode: 0o600 });
    if (status !== "PASS") process.exitCode = 1;
  }
}

if (import.meta.main) {
  await run().catch(async (error: unknown) => {
    await mkdir(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
    const reason = safeFailureReason(error);
    const status = isAssertionOrLeakFailure(error) ? "FAIL" : "BLOCKED";
    await record(status === "FAIL" ? "scenario.failed" : "scenario.blocked", { reason, failureClass: status });
    await writeFile(join(EVIDENCE_DIR, "verdict.json"), JSON.stringify({ schema: "codex-quota-retry-v2-verdict.v1",
      status, installedLiveProof: false, reason, evidenceRelativePath: relative(REPO_ROOT, EVIDENCE_DIR) }, null, 2), { mode: 0o600 });
    console.error(`[${status}] V2 installed-runtime exploratory canary setup; evidence=${relative(REPO_ROOT, EVIDENCE_DIR)}`);
    process.exitCode = 1;
  });
}

function isAssertionOrLeakFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AssertionError" || /(?:ASSERTION|_assertion_failed|PRIVATE_CORRELATION_HEADER_LEAK|private correlation header|unexpected_delegate_success|provider_call_observed|native_interruption_reason_mismatch)/i.test(message);
}
