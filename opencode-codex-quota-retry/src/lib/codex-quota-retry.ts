import { randomUUID } from "node:crypto";

const CODEX_ORIGIN = "https://chatgpt.com";
const CODEX_GENERATION_PATH = "/backend-api/codex/responses";

export const CODEX_QUOTA_GRACE_MS = 60_000;
export const CODEX_QUOTA_FALLBACK_MS = 5 * 60 * 60 * 1000;
export const CODEX_MAX_EPOCH_MS = 8_640_000_000_000_000;
export const CODEX_ERROR_BODY_MAX_BYTES = 64 * 1024;
export const CODEX_ERROR_BODY_TIMEOUT_MS = 250;
export const CODEX_NATIVE_TIMER_MAX_MS = 2_147_483_647;
export const CODEX_NATIVE_STAGGER_MAX_MS = 250;

export const CODEX_GENERATION_URL = `${CODEX_ORIGIN}${CODEX_GENERATION_PATH}`;

const REGISTRY_SYMBOL = Symbol.for("opencode.codex-quota-retry.fetch-wrapper");
const COOLDOWN_SYMBOL = Symbol.for("opencode.codex-quota-retry.route-cooldown");
const CANCELLATION_SYMBOL = Symbol.for("opencode.codex-quota-retry.cancellation-state");
const V2_CORRELATION_SYMBOL = Symbol.for("opencode.codex-quota-retry.v2-correlation");
const V2_CANCELLATION_SYMBOL = Symbol.for("opencode.codex-quota-retry.v2-cancellation-markers");
const V2_WRAPPER_SYMBOL = Symbol.for("opencode.codex-quota-retry.v2-fetch-wrapper");
const V2_OPTIONS_SYMBOL = Symbol.for("opencode.codex-quota-retry.v2-options");
export const CODEX_V2_CORRELATION_HEADER = "x-opencode-codex-quota-retry-correlation";
export const CODEX_V2_CORRELATION_TTL_MS = 30_000;
const NON_COPYABLE_FETCH_KEYS = new Set(["length", "name", "prototype", "caller", "arguments"]);
const CODEX_SESSION_ID_HEADERS = ["session-id", "x-session-id"] as const;
export const CODEX_CANCELLATION_MARKER_GRACE_MS = 1_000;
export const CODEX_MAX_PENDING_QUOTA_RETRIES = 64;

type FetchImplementation = (...args: any[]) => any;

type HeaderCollection = {
  get?: (name: string) => unknown;
} | Record<string, unknown>;

export interface CodexQuotaResponseInput {
  status: unknown;
  headers?: HeaderCollection;
  body?: unknown;
}

export interface CodexQuotaDeadlineOptions {
  nowMs?: number | (() => number);
  fallbackMs?: number;
  fallbackHours?: number;
}

export interface CodexQuotaDeadline {
  deadlineMs: number;
  source: string;
  usedFallback: boolean;
}

export type CodexErrorBodyReadStatus =
  | "not-eligible"
  | "empty"
  | "parsed"
  | "malformed"
  | "oversized"
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "read-error";

export interface CodexErrorBodyReadResult {
  status: CodexErrorBodyReadStatus;
  bytesRead: number;
  body?: unknown;
  bodyBytes?: Uint8Array;
}

export interface CodexErrorBodyReadOptions {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CodexNativeRetryHeaderOptions {
  nowMs?: number | (() => number);
  maxDelayMs?: number;
  existingHeaders?: HeaderCollection;
}

export interface CodexNativeRetryHeaders {
  retryAfterMs: string;
  retryAfter: string;
  remainingDeadlineMs: number;
  nativeDelayMs: number;
  nativeDelayCapped: boolean;
}

export interface CodexQuotaRetryFetchOptions {
  nowMs?: number | (() => number);
  monotonicMs?: number | (() => number);
  random?: () => number;
  staggerMs?: number;
  fallbackMs?: number;
  fallbackHours?: number;
  maxErrorBodyBytes?: number;
  errorBodyTimeoutMs?: number;
  maxNativeDelayMs?: number;
  cancellationMarkerGraceMs?: number;
  maxPendingQuotaRetries?: number;
  /** Internal V2 boundary; V1 callers leave this unset. */
  v2Correlation?: boolean;
}

interface V2RuntimeOptions {
  options: CodexQuotaRetryFetchOptions;
  configured: boolean;
}

function getV2RuntimeOptions(): V2RuntimeOptions {
  const global = globalThis as Record<PropertyKey, unknown>;
  let state = global[V2_OPTIONS_SYMBOL] as V2RuntimeOptions | undefined;
  if (!state || !state.options || typeof state.options !== "object") {
    state = { options: { v2Correlation: true }, configured: false };
    Object.defineProperty(global, V2_OPTIONS_SYMBOL, { configurable: true, enumerable: false, value: state, writable: true });
  }
  return state;
}

function equivalentV2Options(left: CodexQuotaRetryFetchOptions, right: CodexQuotaRetryFetchOptions): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => key !== "v2Correlation"));
  for (const key of keys) if (!Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false;
  return true;
}

/** First explicit setup configures the early wrapper; conflicting later locations fail visibly. */
export function configureCodexQuotaRetryV2Options(options: CodexQuotaRetryFetchOptions = {}): CodexQuotaRetryFetchOptions {
  const state = getV2RuntimeOptions();
  if (Object.keys(options).length === 0) return state.options;
  const candidate = { ...options, v2Correlation: true };
  if (state.configured && !equivalentV2Options(state.options, candidate)) {
    throw new Error("Conflicting Codex quota retry V2 options across plugin locations; configure one process-wide option set");
  }
  if (!state.configured) {
    state.options = candidate;
    state.configured = true;
  }
  return state.options;
}

export interface CodexQuotaRetryCancellationStateOptions {
  nowMs?: number | (() => number);
  monotonicMs?: number | (() => number);
  markerGraceMs?: number;
  maxPending?: number;
}

interface PendingQuotaRetry {
  deadlineMonotonicMs: number;
  retryObserved: boolean;
  ambiguous: boolean;
}

interface CancellationMarker {
  expiresMonotonicMs: number;
}

export interface CodexQuotaRetryCancellationState {
  recordQuotaRetry(sessionID: string, deadlineWallMs: number): boolean;
  observeSessionStatusEvent(event: unknown): boolean;
  isCancelled(sessionID: string | undefined): boolean;
  onCodexRetryFetch(sessionID: string | undefined): void;
  cleanup(): void;
  pendingCount(): number;
  markerCount(): number;
  hasPending(sessionID: string): boolean;
}

interface FetchRegistryRecord {
  original: FetchImplementation;
  wrapper: FetchImplementation;
}

interface V2CorrelationRecord {
  tokens: Map<string, { sessionID: string; expiresAt: number }>;
  consumedTokens: Map<string, { sessionID: string; expiresAt: number }>;
  scheduled: Map<string, { expiresMonotonicMs: number; attempt: number; assistantMessageID: string }>;
  seenRetries: Map<string, number>;
  retryProofs: Map<string, V2RetryProof>;
  leases: Map<number, V2RequestLease>;
  activeBySession: Map<string, Set<number>>;
  ambiguousSessions: Set<string>;
  nextRequestID: number;
}

interface V2RequestLease {
  id: number;
  sessionID: string;
  expiresMonotonicMs: number;
  qualified: boolean;
  invalid: boolean;
  finalized: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface V2RetryProof {
  requestID: number;
  expiresMonotonicMs: number;
}

function v2State(): V2CorrelationRecord {
  const global = globalThis as Record<PropertyKey, unknown>;
  let state = global[V2_CORRELATION_SYMBOL] as V2CorrelationRecord | undefined;
  if (!state || !(state.tokens instanceof Map) || !(state.scheduled instanceof Map) || !(state.seenRetries instanceof Map)
    || !(state.consumedTokens instanceof Map) || !(state.retryProofs instanceof Map) || !(state.leases instanceof Map) || !(state.activeBySession instanceof Map)
    || !(state.ambiguousSessions instanceof Set)) {
    state = { tokens: new Map(), consumedTokens: new Map(), scheduled: new Map(), seenRetries: new Map(), retryProofs: new Map(), leases: new Map(), activeBySession: new Map(), ambiguousSessions: new Set(), nextRequestID: 1 };
    Object.defineProperty(global, V2_CORRELATION_SYMBOL, { configurable: true, enumerable: false, value: state, writable: true });
  }
  return state;
}

function cleanupV2State(state = v2State(), wallNow = Date.now(), monotonicNow = typeof performance !== "undefined" ? performance.now() : Date.now()): void {
  for (const [token, item] of state.tokens) if (item.expiresAt <= wallNow) state.tokens.delete(token);
  for (const [token, item] of state.consumedTokens) if (item.expiresAt <= wallNow) state.consumedTokens.delete(token);
  for (const [sessionID, item] of state.scheduled) if (item.expiresMonotonicMs <= monotonicNow) state.scheduled.delete(sessionID);
  const markers = (globalThis as Record<PropertyKey, unknown>)[V2_CANCELLATION_SYMBOL] as Map<string, number> | undefined;
  if (markers) for (const [sessionID, expiresAt] of markers) if (expiresAt <= monotonicNow) markers.delete(sessionID);
  for (const [key, expiresAt] of state.seenRetries) if (expiresAt <= monotonicNow) state.seenRetries.delete(key);
  for (const [sessionID, proof] of state.retryProofs) if (proof.expiresMonotonicMs <= monotonicNow) removeV2Proof(state, sessionID);
  for (const lease of [...state.leases.values()]) if (lease.expiresMonotonicMs <= monotonicNow) {
    lease.invalid = true;
    finalizeV2Lease(lease, monotonicNow);
  }
}

function removeV2Proof(state: V2CorrelationRecord, sessionID: string): void {
  const proof = state.retryProofs.get(sessionID);
  if (!proof) return;
  state.retryProofs.delete(sessionID);
}

function invalidateV2Session(state: V2CorrelationRecord, sessionID: string): void {
  removeV2Proof(state, sessionID);
  const active = state.activeBySession.get(sessionID);
  if (active?.size) {
    state.ambiguousSessions.add(sessionID);
    for (const id of active) {
      const lease = state.leases.get(id);
      if (lease) lease.invalid = true;
    }
  }
}

function beginV2PrimaryRequest(sessionID: string, signal?: AbortSignal, options: CodexQuotaRetryFetchOptions = {}): V2RequestLease | undefined {
  const state = v2State();
  removeV2Proof(state, sessionID);
  const existing = state.activeBySession.get(sessionID);
  if (existing?.size) {
    state.ambiguousSessions.add(sessionID);
    for (const id of existing) {
      const lease = state.leases.get(id);
      if (lease) lease.invalid = true;
    }
  }
  if (state.leases.size + state.retryProofs.size >= CODEX_MAX_PENDING_QUOTA_RETRIES) return undefined;
  const id = state.nextRequestID++;
  const now = resolveMonotonicMs(options) ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  const lease: V2RequestLease = { id, sessionID, expiresMonotonicMs: now + CODEX_V2_CORRELATION_TTL_MS,
    qualified: false, invalid: signal?.aborted === true, finalized: false, signal };
  let active = state.activeBySession.get(sessionID);
  if (!active) state.activeBySession.set(sessionID, active = new Set());
  if (active.size > 0) state.ambiguousSessions.add(sessionID);
  active.add(id);
  state.leases.set(id, lease);
  if (signal) {
    lease.abortListener = () => invalidateV2Session(state, sessionID);
    signal.addEventListener("abort", lease.abortListener, { once: true });
  }
  return lease;
}

function finalizeV2Lease(lease: V2RequestLease, now = typeof performance !== "undefined" ? performance.now() : Date.now()): void {
  const state = v2State();
  if (lease.finalized) return;
  lease.finalized = true;
  state.leases.delete(lease.id);
  lease.signal?.removeEventListener("abort", lease.abortListener!);
  const active = state.activeBySession.get(lease.sessionID);
  active?.delete(lease.id);
  if (active?.size === 0) {
    state.activeBySession.delete(lease.sessionID);
    if (lease.qualified && !lease.invalid && !state.ambiguousSessions.has(lease.sessionID) && now < lease.expiresMonotonicMs
      && state.retryProofs.size < CODEX_MAX_PENDING_QUOTA_RETRIES) {
      // The native V2 request signal is per-attempt and may be aborted as soon
      // as the completed response is handed to the scheduler. The lease owns
      // abort observation only while request/body adaptation is in flight.
      const proof: V2RetryProof = { requestID: lease.id, expiresMonotonicMs: Math.min(lease.expiresMonotonicMs, now + CODEX_V2_CORRELATION_TTL_MS) };
      if (!lease.invalid) state.retryProofs.set(lease.sessionID, proof);
    }
    state.ambiguousSessions.delete(lease.sessionID);
  }
  lease.signal = undefined;
  lease.abortListener = undefined;
}

function v2CancellationMarkers(): Map<string, number> {
  const global = globalThis as Record<PropertyKey, unknown>;
  let markers = global[V2_CANCELLATION_SYMBOL] as Map<string, number> | undefined;
  if (!(markers instanceof Map)) {
    markers = new Map();
    Object.defineProperty(global, V2_CANCELLATION_SYMBOL, { configurable: true, enumerable: false, value: markers, writable: true });
  }
  return markers;
}

/** Attach one unpredictable, process-local correlation token to an exact primary request. */
export function issueCodexV2CorrelationToken(sessionID: string, options: { nowMs?: number; monotonicMs?: number; maxPending?: number } = {}): string | undefined {
  if (!sessionID || sessionID.length > 256) return undefined;
  const now = options.nowMs ?? Date.now();
  if (!Number.isFinite(now)) return undefined;
  const state = v2State();
  const monotonicNow = resolveMonotonicMs(options) ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  cleanupV2State(state, now, monotonicNow);
  const requestedCap = options.maxPending;
  const cap = typeof requestedCap === "number" && Number.isFinite(requestedCap)
    ? Math.max(1, Math.min(CODEX_MAX_PENDING_QUOTA_RETRIES, Math.floor(requestedCap)))
    : CODEX_MAX_PENDING_QUOTA_RETRIES;
  if (state.tokens.size >= cap) return undefined;
  let token = randomUUID();
  while (state.tokens.has(token)) token = randomUUID();
  state.tokens.set(token, { sessionID, expiresAt: now + CODEX_V2_CORRELATION_TTL_MS });
  return token;
}

/** Consume once; malformed, expired, and unknown tokens never resolve by headers. */
export function consumeCodexV2CorrelationToken(
  token: unknown,
  now = Date.now(),
  monotonicNow = typeof performance !== "undefined" ? performance.now() : Date.now(),
): string | undefined {
  const state = v2State();
  cleanupV2State(state, now, monotonicNow);
  if (typeof token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return undefined;
  const item = state.tokens.get(token);
  if (!item || item.expiresAt <= now) return undefined;
  state.tokens.delete(token);
  state.consumedTokens.set(token, item);
  while (state.consumedTokens.size > CODEX_MAX_PENDING_QUOTA_RETRIES) state.consumedTokens.delete(state.consumedTokens.keys().next().value!);
  return item.sessionID;
}

function invalidateReusedV2CorrelationToken(token: unknown, now: number, monotonicNow: number): void {
  const state = v2State();
  cleanupV2State(state, now, monotonicNow);
  const item = typeof token === "string" ? state.consumedTokens.get(token) : undefined;
  if (item && item.expiresAt > now) invalidateV2Session(state, item.sessionID);
}

/** Normalize V2 retry/interruption data without changing the native scheduler. */
export function observeCodexQuotaRetryV2Event(
  event: unknown,
  now = Date.now(),
  monotonicNow = typeof performance !== "undefined" ? performance.now() : Date.now(),
): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as { type?: unknown; data?: unknown };
  if (!record.data || typeof record.data !== "object") return false;
  const data = record.data as Record<string, unknown>;
  if (typeof data.sessionID !== "string" || !data.sessionID || !Number.isFinite(now) || !Number.isFinite(monotonicNow)) return false;
  const state = v2State();
  cleanupV2State(state, now, monotonicNow);
  if (record.type === "session.retry.scheduled") {
    if (!Number.isSafeInteger(data.attempt) || (data.attempt as number) < 1
      || typeof data.assistantMessageID !== "string" || !data.assistantMessageID
      || typeof data.at !== "number" || !Number.isFinite(data.at) || data.at <= now) return false;
    const cancellationState = (globalThis as Record<PropertyKey, unknown>)[CANCELLATION_SYMBOL] as CodexQuotaRetryCancellationState | undefined;
    if (!cancellationState?.hasPending(data.sessionID)) return false;
    const retryKey = `${data.sessionID}\u0000${data.assistantMessageID}\u0000${data.attempt}`;
    if (state.seenRetries.has(retryKey)) return false;
    const retryExpiryMonotonicMs = monotonicNow + data.at - now + CODEX_CANCELLATION_MARKER_GRACE_MS;
    state.seenRetries.set(retryKey, retryExpiryMonotonicMs);
    while (state.seenRetries.size > CODEX_MAX_PENDING_QUOTA_RETRIES) state.seenRetries.delete(state.seenRetries.keys().next().value!);
    state.scheduled.set(data.sessionID, {
      expiresMonotonicMs: retryExpiryMonotonicMs,
      attempt: data.attempt as number,
      assistantMessageID: data.assistantMessageID,
    });
    while (state.scheduled.size > CODEX_MAX_PENDING_QUOTA_RETRIES) state.scheduled.delete(state.scheduled.keys().next().value!);
    return true;
  }
  if (record.type === "session.execution.interrupted") {
    invalidateV2Session(state, data.sessionID);
    const retry = state.scheduled.get(data.sessionID);
    if (!retry || retry.expiresMonotonicMs <= monotonicNow || !["user", "shutdown", "superseded", "inactivity"].includes(String(data.reason))) return false;
    state.scheduled.delete(data.sessionID);
    const markers = v2CancellationMarkers();
    markers.set(data.sessionID, retry.expiresMonotonicMs);
    while (markers.size > CODEX_MAX_PENDING_QUOTA_RETRIES) markers.delete(markers.keys().next().value!);
    return true;
  }
  return false;
}

export function clearCodexV2CorrelationState(): void {
  const state = v2State();
  state.tokens.clear();
  state.consumedTokens.clear();
  state.scheduled.clear();
  state.seenRetries.clear();
  for (const proofSession of state.retryProofs.keys()) removeV2Proof(state, proofSession);
  for (const lease of state.leases.values()) {
    lease.invalid = true;
    lease.finalized = true;
    lease.signal?.removeEventListener("abort", lease.abortListener!);
    lease.signal = undefined;
    lease.abortListener = undefined;
  }
  state.leases.clear();
  state.activeBySession.clear();
  state.ambiguousSessions.clear();
  v2CancellationMarkers().clear();
}

interface SharedCooldownRecord {
  deadlineMonotonicMs: number;
  authoritativeDeadlineWallMs: number;
  deadlineWallMs: number;
}

export interface CodexQuotaRetryInstallation {
  installed: boolean;
  compatible?: boolean;
  wrapper: FetchImplementation;
  restore: () => void;
}

/** Native V2 hook callback: correlate only exact primary Codex HTTP requests. */
export function correlateCodexQuotaRetryV2HttpRequest(event: unknown, options: CodexQuotaRetryFetchOptions = {}): boolean {
  if (!event || typeof event !== "object") return false;
  const requestEvent = event as { sessionID?: unknown; kind?: unknown; request?: Request };
  if (requestEvent.kind !== "primary" || typeof requestEvent.sessionID !== "string"
    || !requestEvent.request || !isCodexGenerationRequest(requestEvent.request)) return false;
  const state = v2State();
  const wallNow = readClock(options.nowMs, Date.now) ?? Date.now();
  const monoNow = resolveMonotonicMs(options) ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  cleanupV2State(state, wallNow, monoNow);
  // This native hook is authoritative for this session, even if issuing a
  // correlation token fails because the bounded token table is full.
  invalidateV2Session(state, requestEvent.sessionID);
  try {
    const headers = new Headers(requestEvent.request.headers);
    headers.delete(CODEX_V2_CORRELATION_HEADER);
    const token = issueCodexV2CorrelationToken(requestEvent.sessionID, {
      nowMs: readClock(options.nowMs, Date.now) ?? Date.now(),
      monotonicMs: resolveMonotonicMs(options),
      maxPending: options.maxPendingQuotaRetries,
    });
    if (!token) {
      requestEvent.request = new Request(requestEvent.request, { headers, signal: requestEvent.request.signal });
      return false;
    }
    headers.set(CODEX_V2_CORRELATION_HEADER, token);
    requestEvent.request = new Request(requestEvent.request, { headers, signal: requestEvent.request.signal });
    return true;
  } catch {
    return false;
  }
}

function getRegistry(): FetchRegistryRecord | undefined {
  const candidate = (globalThis as Record<PropertyKey, unknown>)[REGISTRY_SYMBOL];
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Partial<FetchRegistryRecord>;
  if (typeof record.original !== "function" || typeof record.wrapper !== "function") {
    return undefined;
  }
  return record as FetchRegistryRecord;
}

function getFetch(): FetchImplementation {
  const current = (globalThis as { fetch?: unknown }).fetch;
  if (typeof current !== "function") {
    throw new TypeError("global fetch is not available");
  }
  return current as FetchImplementation;
}

function setFetch(next: FetchImplementation): void {
  const changed = Reflect.set(globalThis, "fetch", next, globalThis);
  if (!changed || (globalThis as { fetch?: unknown }).fetch !== next) {
    throw new TypeError("global fetch cannot be wrapped");
  }
}

function setRegistry(record: FetchRegistryRecord): void {
  Object.defineProperty(globalThis, REGISTRY_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: record,
    writable: true,
  });
}

function clearRegistry(record: FetchRegistryRecord): void {
  if (getRegistry() !== record) {
    return;
  }
  delete (globalThis as Record<PropertyKey, unknown>)[REGISTRY_SYMBOL];
}

function getSharedCooldown(): SharedCooldownRecord | undefined {
  const candidate = (globalThis as Record<PropertyKey, unknown>)[COOLDOWN_SYMBOL];
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  const record = candidate as Partial<SharedCooldownRecord>;
  if (!Number.isFinite(record.deadlineMonotonicMs)
    || !Number.isFinite(record.authoritativeDeadlineWallMs)
    || !Number.isFinite(record.deadlineWallMs)) {
    return undefined;
  }
  return record as SharedCooldownRecord;
}

function clearSharedCooldown(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[COOLDOWN_SYMBOL];
}

function readClock(value: number | (() => number) | undefined, fallback: () => number): number | undefined {
  const result = typeof value === "function" ? value() : value ?? fallback();
  return Number.isFinite(result) ? result : undefined;
}

/** Read only the two session identity headers proven by the installed transport. */
export function readVerifiedCodexSessionID(input: unknown, init?: unknown): string | undefined {
  try {
    const initHeaders = init && typeof init === "object"
      ? (init as { headers?: HeadersInit }).headers
      : undefined;
    const headers = initHeaders !== undefined
      ? new Headers(initHeaders)
      : new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    const values = CODEX_SESSION_ID_HEADERS.map((name) => headers.get(name))
      .filter((value): value is string => value !== null);
    if (values.length === 0 || values.some((value) => value.length === 0 || value.length > 256
      || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value))) return undefined;
    return values.every((value) => value === values[0]) ? values[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Create a deterministic, process-local exact pending-quota-retry guard. */
export function createCodexQuotaRetryCancellationState(
  options: CodexQuotaRetryCancellationStateOptions = {},
): CodexQuotaRetryCancellationState {
  const pending = new Map<string, PendingQuotaRetry>();
  const markers = new Map<string, CancellationMarker>();
  const requestedMaxPending = options.maxPending;
  const maxPending = typeof requestedMaxPending === "number" && Number.isFinite(requestedMaxPending)
    ? Math.max(1, Math.min(CODEX_MAX_PENDING_QUOTA_RETRIES, Math.floor(requestedMaxPending)))
    : CODEX_MAX_PENDING_QUOTA_RETRIES;
  const configuredGrace = Number.isFinite(options.markerGraceMs) && (options.markerGraceMs ?? 0) >= 0
    ? Math.min(options.markerGraceMs ?? CODEX_CANCELLATION_MARKER_GRACE_MS, 30_000)
    : CODEX_CANCELLATION_MARKER_GRACE_MS;
  const wallNow = (): number | undefined => readClock(options.nowMs, Date.now);
  const monotonicNow = (): number | undefined => readClock(options.monotonicMs,
    () => typeof performance !== "undefined" ? performance.now() : Date.now());

  const cleanup = (): void => {
    const now = monotonicNow();
    if (now === undefined) return;
    for (const [identity, marker] of markers) {
      if (marker.expiresMonotonicMs <= now) markers.delete(identity);
    }
    for (const [identity, retry] of pending) {
      if (retry.deadlineMonotonicMs + configuredGrace <= now) pending.delete(identity);
    }
  };

  return {
    recordQuotaRetry(sessionID, deadlineWallMs) {
      cleanup();
      const nowWall = wallNow();
      const nowMono = monotonicNow();
      if (!sessionID || nowWall === undefined || nowMono === undefined
        || !isRepresentableDeadlineMs(deadlineWallMs) || deadlineWallMs <= nowWall) return false;
      if (markers.has(sessionID)) return false;
      const previous = pending.get(sessionID);
      if (previous) {
        previous.ambiguous = true;
        previous.retryObserved = false;
        previous.deadlineMonotonicMs = Math.max(previous.deadlineMonotonicMs, nowMono + deadlineWallMs - nowWall);
        return false;
      }
      if (pending.size + markers.size >= maxPending) return false;
      pending.set(sessionID, { deadlineMonotonicMs: nowMono + deadlineWallMs - nowWall,
        retryObserved: false, ambiguous: false });
      return true;
    },
    observeSessionStatusEvent(event) {
      cleanup();
      if (!event || typeof event !== "object") return false;
      const record = event as { type?: unknown; properties?: unknown };
      if (record.type !== "session.status" || !record.properties || typeof record.properties !== "object") return false;
      const properties = record.properties as { sessionID?: unknown; status?: unknown };
      if (typeof properties.sessionID !== "string" || properties.sessionID.length === 0
        || !properties.status || typeof properties.status !== "object") return false;
      const retry = pending.get(properties.sessionID);
      if (!retry || retry.ambiguous) return false;
      const status = properties.status as { type?: unknown; next?: unknown };
      const nowWall = wallNow();
      const nowMono = monotonicNow();
      if (nowWall === undefined || nowMono === undefined) return false;
      if (status.type === "retry") {
        if (retry.retryObserved || typeof status.next !== "number" || !isRepresentableDeadlineMs(status.next)
          || status.next <= nowWall) return false;
        retry.deadlineMonotonicMs = nowMono + status.next - nowWall;
        retry.retryObserved = true;
        return true;
      }
      if (status.type === "idle" && retry.retryObserved) {
        markers.set(properties.sessionID, { expiresMonotonicMs: retry.deadlineMonotonicMs + configuredGrace });
        pending.delete(properties.sessionID);
        return true;
      }
      return false;
    },
    isCancelled(sessionID) {
      cleanup();
      if (!sessionID) return false;
      const marker = markers.get(sessionID);
      const now = monotonicNow();
      return marker !== undefined && now !== undefined && marker.expiresMonotonicMs > now;
    },
    onCodexRetryFetch(sessionID) {
      cleanup();
      if (!sessionID || markers.has(sessionID)) return;
      const retry = pending.get(sessionID);
      if (retry?.retryObserved && !retry.ambiguous) pending.delete(sessionID);
    },
    cleanup,
    pendingCount: () => pending.size,
    markerCount: () => markers.size,
    hasPending: (sessionID) => { cleanup(); const retry = pending.get(sessionID); return retry !== undefined && !retry.ambiguous; },
  };
}

function getSharedCancellationState(options: CodexQuotaRetryFetchOptions): CodexQuotaRetryCancellationState {
  const shared = globalThis as Record<PropertyKey, unknown>;
  const existing = shared[CANCELLATION_SYMBOL] as CodexQuotaRetryCancellationState | undefined;
  if (existing && typeof existing.isCancelled === "function") return existing;
  const state = createCodexQuotaRetryCancellationState({ nowMs: options.nowMs,
    monotonicMs: options.monotonicMs, markerGraceMs: options.cancellationMarkerGraceMs,
    maxPending: options.maxPendingQuotaRetries });
  Object.defineProperty(globalThis, CANCELLATION_SYMBOL, { configurable: true, enumerable: false,
    value: state, writable: true });
  return state;
}

export function observeCodexQuotaRetrySessionStatus(event: unknown): boolean {
  const state = (globalThis as Record<PropertyKey, unknown>)[CANCELLATION_SYMBOL] as
    CodexQuotaRetryCancellationState | undefined;
  return state?.observeSessionStatusEvent(event) ?? false;
}

function clearSharedCancellationState(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[CANCELLATION_SYMBOL];
}

function resolveMonotonicMs(options: { monotonicMs?: number | (() => number) } = {}): number | undefined {
  const clock = options.monotonicMs
    ?? (typeof performance !== "undefined" ? () => performance.now() : () => Date.now());
  const value = typeof clock === "function" ? clock() : clock;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolveStaggerMs(options: CodexQuotaRetryFetchOptions): number {
  if (typeof options.staggerMs === "number" && Number.isFinite(options.staggerMs)) {
    return Math.min(Math.max(0, Math.floor(options.staggerMs)), CODEX_NATIVE_STAGGER_MAX_MS);
  }
  const randomValue = options.random ? options.random() : Math.random();
  if (!Number.isFinite(randomValue)) {
    return 0;
  }
  return Math.floor(Math.min(1, Math.max(0, randomValue)) * CODEX_NATIVE_STAGGER_MAX_MS);
}

function armSharedCooldown(
  deadline: CodexQuotaDeadline,
  options: CodexQuotaRetryFetchOptions,
  wallNowMs: number,
  monotonicNowMs: number,
): SharedCooldownRecord | undefined {
  const remainingMs = deadline.deadlineMs - wallNowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return getSharedCooldown();
  }

  const staggerMs = resolveStaggerMs(options);
  const candidate: SharedCooldownRecord = {
    deadlineMonotonicMs: monotonicNowMs + remainingMs + staggerMs,
    authoritativeDeadlineWallMs: deadline.deadlineMs,
    deadlineWallMs: deadline.deadlineMs + staggerMs,
  };
  const stored = getSharedCooldown();
  // An expired monotonic record must not veto a newly valid response merely
  // because its wall-clock deadline is later than the current wall clock after
  // a clock adjustment.
  const current = stored && stored.deadlineMonotonicMs > monotonicNowMs ? stored : undefined;
  if (current && deadline.deadlineMs <= current.authoritativeDeadlineWallMs) {
    return current;
  }
  if (current && current.deadlineMonotonicMs >= candidate.deadlineMonotonicMs) {
    return current;
  }

  Object.defineProperty(globalThis, COOLDOWN_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: candidate,
    writable: true,
  });
  return candidate;
}

function getActiveSharedCooldown(
  options: CodexQuotaRetryFetchOptions,
): { record: SharedCooldownRecord; nowMs: number; remainingMs: number } | undefined {
  const record = getSharedCooldown();
  const nowMs = resolveMonotonicMs(options);
  if (!record || nowMs === undefined) {
    return undefined;
  }
  const remainingMs = record.deadlineMonotonicMs - nowMs;
  return remainingMs > 0 ? { record, nowMs, remainingMs } : undefined;
}

function getRequestSignal(input: unknown, init: unknown): AbortSignal | undefined {
  if (init && typeof init === "object" && "signal" in init) {
    // An explicit null signal is a Fetch RequestInit override. It must not
    // fall back to input.signal, even when input is a Request with a signal.
    const initSignal = (init as { signal?: unknown }).signal;
    if (initSignal === null || initSignal === undefined) {
      return undefined;
    }
    if (typeof initSignal === "object" && "aborted" in initSignal) {
      return initSignal as AbortSignal;
    }
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.signal;
  }
  return undefined;
}

function getAbortReason(signal: AbortSignal): unknown {
  // Preserve an explicit null or other caller-provided reason. Only the
  // legacy no-reason shape needs the platform AbortError fallback.
  return signal.reason === undefined
    ? new DOMException("The operation was aborted.", "AbortError")
    : signal.reason;
}

function copyFetchProperties(source: FetchImplementation, target: FetchImplementation): void {
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === "string" && NON_COPYABLE_FETCH_KEYS.has(key)) {
      continue;
    }

    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (!descriptor) {
      continue;
    }

    try {
      Object.defineProperty(target, key, descriptor);
    } catch {
      // A host-defined fetch property may be non-redefinable on the wrapper.
      // The original function remains the source of truth for the call path.
    }
  }
}

function makeRestore(record: FetchRegistryRecord): () => void {
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;

    if (getFetch() !== record.wrapper) {
      return;
    }
    setFetch(record.original);
    clearRegistry(record);
    clearSharedCooldown();
    clearSharedCancellationState();
  };
}

function parseRequestUrl(input: unknown): URL | undefined {
  if (input instanceof URL) {
    return input;
  }

  if (typeof input === "string") {
    try {
      return new URL(input);
    } catch {
      return undefined;
    }
  }

  if (!input || typeof input !== "object") {
    return undefined;
  }

  const candidate = input as { url?: unknown; href?: unknown };
  const rawUrl = typeof candidate.url === "string" ? candidate.url : candidate.href;
  if (typeof rawUrl !== "string") {
    return undefined;
  }

  try {
    return new URL(rawUrl);
  } catch {
    return undefined;
  }
}

function readMethod(input: unknown, init: unknown): string {
  const initMethod = init && typeof init === "object" ? (init as { method?: unknown }).method : undefined;
  if (typeof initMethod === "string") {
    return initMethod;
  }

  const requestMethod = input && typeof input === "object" ? (input as { method?: unknown }).method : undefined;
  return typeof requestMethod === "string" ? requestMethod : "GET";
}

function finitePositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  if (typeof value !== "string" || value.trim() === "" || !/^[+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRepresentableEpochMs(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= CODEX_MAX_EPOCH_MS;
}

function isRepresentableDeadlineMs(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= CODEX_MAX_EPOCH_MS;
}

function readHeader(headers: HeaderCollection | undefined, name: string): unknown {
  if (!headers) {
    return undefined;
  }

  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (value !== null && value !== undefined) {
      return value;
    }
  }

  if (typeof headers !== "object") {
    return undefined;
  }

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

function responseParts(input: unknown, bodyOverride?: unknown): CodexQuotaResponseInput | undefined {
  if (typeof input === "number" || typeof input === "string") {
    return { status: input, body: bodyOverride };
  }
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  const response = candidate.response && typeof candidate.response === "object"
    ? candidate.response as Record<string, unknown>
    : candidate;
  return {
    status: response.status,
    headers: response.headers as HeaderCollection | undefined,
    body: bodyOverride === undefined ? response.body : bodyOverride,
  };
}

function readErrorType(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const candidate = body as Record<string, unknown>;
  const error = candidate.error;
  if (error && typeof error === "object") {
    return (error as Record<string, unknown>).type;
  }
  return undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    // A fetch tee can leave cancellation pending. Start cancellation to release
    // the clone, but never await the returned promise.
    const cancellation = reader.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // The original response remains owned by the caller even if the clone
    // cannot be cancelled.
  }
}

type ReadStep =
  | { kind: "value"; value: ReadableStreamReadResult<Uint8Array> }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown };

function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ReadStep> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (step: ReadStep): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(step);
    };

    const onAbort = (): void => finish({ kind: "cancelled" });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    void reader.read().then(
      (value) => finish({ kind: "value", value }),
      (error) => finish({ kind: "error", error }),
    );
  });
}

/**
 * Read only a bounded clone of an eligible HTTP 429 error response.
 *
 * The native response is never consumed: the clone is read through a byte
 * capped reader, and JSON parsing happens only after the cap is satisfied.
 * This helper intentionally does not classify or adapt the response yet; the
 * native retry/header integration owns that later step.
 */
export async function readBoundedCodexQuotaErrorBody(
  response: Response,
  options: CodexErrorBodyReadOptions = {},
): Promise<CodexErrorBodyReadResult> {
  if (!(response instanceof Response) || response.status !== 429) {
    return { status: "not-eligible", bytesRead: 0 };
  }

  const maxBytes = positiveInteger(options.maxBytes, CODEX_ERROR_BODY_MAX_BYTES);
  const timeoutMs = positiveInteger(options.timeoutMs, CODEX_ERROR_BODY_TIMEOUT_MS);
  if (options.signal?.aborted) {
    return { status: "cancelled", bytesRead: 0 };
  }

  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return { status: "unavailable", bytesRead: 0 };
  }

  if (!clone.body) {
    return { status: "empty", bytesRead: 0 };
  }

  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  const readDeadlineMs = Date.now() + timeoutMs;

  while (true) {
    const remainingMs = readDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      cancelReader(reader);
      return { status: "timeout", bytesRead };
    }
    const step = await readWithDeadline(reader, remainingMs, options.signal);
    if (step.kind === "timeout") {
      cancelReader(reader);
      return { status: "timeout", bytesRead };
    }
    if (step.kind === "cancelled") {
      cancelReader(reader);
      return { status: "cancelled", bytesRead };
    }
    if (step.kind === "error") {
      cancelReader(reader);
      return { status: "read-error", bytesRead };
    }
    if (step.value.done) {
      break;
    }

    const chunk = step.value.value;
    if (!(chunk instanceof Uint8Array)) {
      cancelReader(reader);
      return { status: "read-error", bytesRead };
    }
    if (bytesRead + chunk.byteLength > maxBytes) {
      cancelReader(reader);
      return { status: "oversized", bytesRead: bytesRead + chunk.byteLength };
    }
    chunks.push(chunk);
    bytesRead += chunk.byteLength;
  }

  if (bytesRead === 0) {
    return { status: "empty", bytesRead: 0 };
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return { status: "parsed", bytesRead, body, bodyBytes: bytes };
  } catch {
    return { status: "malformed", bytesRead };
  }
}

/** Return true only for a positively classified Codex subscription quota response. */
export function classifyCodexQuotaResponse(input: unknown, bodyOverride?: unknown): boolean {
  const parts = responseParts(input, bodyOverride);
  return parts?.status === 429 && readErrorType(parts.body) === "usage_limit_reached";
}

export const isPositiveCodexQuotaResponse = classifyCodexQuotaResponse;

function normalizeEpochMs(value: unknown): number | undefined {
  const parsed = finitePositiveNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  // Numeric epochs are handled before Date.parse so numeric strings cannot be
  // interpreted as implementation-defined calendar dates.
  const epochMs = parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  return isRepresentableEpochMs(epochMs) ? epochMs : undefined;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validCalendarParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return year >= 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function validTimezone(value: string): boolean {
  if (/^(?:Z|UTC|GMT)$/i.test(value)) {
    return true;
  }
  const match = value.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) {
    return false;
  }
  return Number(match[2]) <= 23 && Number(match[3]) <= 59;
}

function validNamedDate(text: string): boolean {
  const match = text.match(
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?\s+(UTC|GMT|Z|[+-]\d{2}:?\d{2})$/i,
  );
  if (!match) {
    return true;
  }
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = monthNames.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
  const hour = Number(match[4]);
  const meridiem = match[7]?.toUpperCase();
  if (month === 0 || !validTimezone(match[8])) {
    return false;
  }
  if (meridiem && (hour < 1 || hour > 12)) {
    return false;
  }
  return validCalendarParts(
    Number(match[3]),
    month,
    Number(match[2]),
    meridiem ? (hour % 12) + (meridiem === "PM" ? 12 : 0) : hour,
    Number(match[5]),
    Number(match[6] ?? 0),
  );
}

function parseExplicitDate(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text || finitePositiveNumber(text) !== undefined) {
    return undefined;
  }

  // Date.parse is used only after an explicit timezone or numeric offset has
  // been proven. Timezone-free strings are deliberately not accepted.
  if (!/(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return undefined;
  }
  const isoMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i,
  );
  if (isoMatch && (!validTimezone(isoMatch[7]) || !validCalendarParts(
    Number(isoMatch[1]),
    Number(isoMatch[2]),
    Number(isoMatch[3]),
    Number(isoMatch[4]),
    Number(isoMatch[5]),
    Number(isoMatch[6] ?? 0),
  ))) {
    return undefined;
  }
  if (!isoMatch && !validNamedDate(text)) {
    return undefined;
  }
  const parsed = Date.parse(text);
  return isRepresentableEpochMs(parsed) ? parsed : undefined;
}

function parseEpochOrExplicitDate(value: unknown): number | undefined {
  return normalizeEpochMs(value) ?? parseExplicitDate(value);
}

function parseDurationDeadline(value: unknown, nowMs: number, multiplier: number): number | undefined {
  const parsed = finitePositiveNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  const deadlineMs = nowMs + parsed * multiplier;
  return isRepresentableDeadlineMs(deadlineMs) ? deadlineMs : undefined;
}

function parseRetryAfterDelay(value: unknown, nowMs: number): number | undefined {
  const seconds = finitePositiveNumber(value);
  if (seconds !== undefined) {
    const delayMs = seconds * 1000;
    return isRepresentableDeadlineMs(delayMs) ? delayMs : undefined;
  }

  const absoluteMs = parseExplicitDate(value);
  if (absoluteMs === undefined || absoluteMs <= nowMs) {
    return undefined;
  }
  const delayMs = absoluteMs - nowMs;
  return isRepresentableDeadlineMs(delayMs) ? delayMs : undefined;
}

function parseRetryAfterMsDelay(value: unknown): number | undefined {
  const milliseconds = finitePositiveNumber(value);
  return milliseconds !== undefined && isRepresentableDeadlineMs(milliseconds)
    ? milliseconds
    : undefined;
}

function addGrace(deadlineMs: number): number | undefined {
  const withGrace = deadlineMs + CODEX_QUOTA_GRACE_MS;
  return isRepresentableDeadlineMs(withGrace) ? withGrace : undefined;
}

function collectStructuredValues(value: unknown, key: string, output: unknown[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStructuredValues(entry, key, output);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    output.push(record[key]);
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") {
      collectStructuredValues(nested, key, output);
    }
  }
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, output);
    }
    return;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectText(nested, output);
  }
}

function textualDeadlineCandidates(body: unknown): number[] {
  const strings: string[] = [];
  collectText(body, strings);
  const candidates: number[] = [];
  const explicitDatePattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
  const namedDatePattern = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun,?\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\s+(?:UTC|GMT|[+-]\d{2}:?\d{2})\b/gi;
  for (const text of strings) {
    for (const match of text.matchAll(explicitDatePattern)) {
      const parsed = parseExplicitDate(match[0]);
      if (parsed !== undefined) {
        candidates.push(parsed);
      }
    }
    for (const match of text.matchAll(namedDatePattern)) {
      const parsed = parseExplicitDate(match[0]);
      if (parsed !== undefined) {
        candidates.push(parsed);
      }
    }
  }
  return candidates;
}

function resolveNowMs(options: CodexQuotaDeadlineOptions): number | undefined {
  const value = typeof options.nowMs === "function" ? options.nowMs() : options.nowMs ?? Date.now();
  return isRepresentableDeadlineMs(value) ? value : undefined;
}

/**
 * Parse a positively classified quota response without performing I/O.
 * All dates are returned as epoch milliseconds and include the fixed grace.
 */
export function parseCodexQuotaDeadline(
  input: CodexQuotaResponseInput,
  options: CodexQuotaDeadlineOptions = {},
): CodexQuotaDeadline | undefined {
  if (!classifyCodexQuotaResponse(input)) {
    return undefined;
  }

  const nowMs = resolveNowMs(options);
  if (nowMs === undefined) {
    return undefined;
  }

  const candidates: Array<{ deadlineMs: number; source: string }> = [];
  const retryAfter = readHeader(input.headers, "retry-after");
  const retryAfterMs = readHeader(input.headers, "retry-after-ms");
  const retryAfterSeconds = finitePositiveNumber(retryAfter);
  if (retryAfterSeconds !== undefined) {
    candidates.push({ deadlineMs: nowMs + retryAfterSeconds * 1000, source: "retry-after" });
  } else {
    const retryAfterDate = parseExplicitDate(retryAfter);
    if (retryAfterDate !== undefined) {
      candidates.push({ deadlineMs: retryAfterDate, source: "retry-after" });
    }
  }

  const retryAfterMsValue = parseDurationDeadline(retryAfterMs, nowMs, 1);
  if (retryAfterMsValue !== undefined) {
    candidates.push({ deadlineMs: retryAfterMsValue, source: "retry-after-ms" });
  }

  for (const value of ["resets_at"]) {
    const values: unknown[] = [];
    collectStructuredValues(input.body, value, values);
    for (const entry of values) {
      const deadlineMs = parseEpochOrExplicitDate(entry);
      if (deadlineMs !== undefined) {
        candidates.push({ deadlineMs, source: value });
      }
    }
  }

  const resetSeconds: unknown[] = [];
  collectStructuredValues(input.body, "resets_in_seconds", resetSeconds);
  for (const entry of resetSeconds) {
    const deadlineMs = parseDurationDeadline(entry, nowMs, 1000);
    if (deadlineMs !== undefined) {
      candidates.push({ deadlineMs, source: "resets_in_seconds" });
    }
  }

  const latestRepresentableBeforeGrace = CODEX_MAX_EPOCH_MS - CODEX_QUOTA_GRACE_MS;
  const validFuture = candidates.filter((candidate) => candidate.deadlineMs > nowMs
    && candidate.deadlineMs <= latestRepresentableBeforeGrace
    && isRepresentableDeadlineMs(candidate.deadlineMs));
  const textual = validFuture.length === 0 ? textualDeadlineCandidates(input.body)
    .filter((deadlineMs) => deadlineMs > nowMs
      && deadlineMs <= latestRepresentableBeforeGrace
      && isRepresentableDeadlineMs(deadlineMs))
    .map((deadlineMs) => ({ deadlineMs, source: "text" })) : [];
  validFuture.push(...textual);

  if (validFuture.length > 0) {
    const latest = validFuture.reduce((best, candidate) => candidate.deadlineMs > best.deadlineMs ? candidate : best);
    const deadlineMs = addGrace(latest.deadlineMs);
    if (deadlineMs === undefined) {
      return undefined;
    }
    return {
      deadlineMs,
      source: latest.source,
      usedFallback: false,
    };
  }

  const configuredFallback = options.fallbackMs ?? (
    options.fallbackHours === undefined ? CODEX_QUOTA_FALLBACK_MS : options.fallbackHours * 60 * 60 * 1000
  );
  const fallbackMs = finitePositiveNumber(configuredFallback);
  if (fallbackMs === undefined) {
    return undefined;
  }
  const deadlineMs = addGrace(parseDurationDeadline(fallbackMs, nowMs, 1) ?? -1);
  if (deadlineMs === undefined) {
    return undefined;
  }
  return {
    deadlineMs,
    source: "fallback",
    usedFallback: true,
  };
}

/**
 * Translate one already-normalized absolute deadline into OpenCode's native
 * retry headers. The grace period is owned by parseCodexQuotaDeadline and is
 * deliberately not added here a second time.
 */
export function buildCodexNativeRetryHeaders(
  deadline: CodexQuotaDeadline,
  options: CodexNativeRetryHeaderOptions = {},
): CodexNativeRetryHeaders | undefined {
  const nowMs = resolveNowMs(options);
  if (nowMs === undefined || !isRepresentableDeadlineMs(deadline.deadlineMs)) {
    return undefined;
  }

  const remainingDeadlineMs = deadline.deadlineMs - nowMs;
  if (!Number.isFinite(remainingDeadlineMs) || remainingDeadlineMs <= 0) {
    return undefined;
  }

  const existingDelays = [
    parseRetryAfterMsDelay(readHeader(options.existingHeaders, "retry-after-ms")),
    parseRetryAfterDelay(readHeader(options.existingHeaders, "retry-after"), nowMs),
  ].filter((value): value is number => value !== undefined);
  const requestedDelayMs = Math.max(remainingDeadlineMs, ...existingDelays, 0);
  const configuredMax = finitePositiveNumber(options.maxDelayMs);
  const maxDelayMs = configuredMax === undefined
    ? CODEX_NATIVE_TIMER_MAX_MS
    : Math.min(configuredMax, CODEX_NATIVE_TIMER_MAX_MS);
  const nativeDelayCapped = requestedDelayMs > maxDelayMs;
  const nativeDelayMs = Math.min(Math.ceil(requestedDelayMs), maxDelayMs);

  return {
    retryAfterMs: String(nativeDelayMs),
    retryAfter: String(Math.ceil(nativeDelayMs / 1000)),
    remainingDeadlineMs,
    nativeDelayMs,
    nativeDelayCapped,
  };
}

/**
 * Consume an exact, fresh primary-request quota proof in the native retry
 * hook. When no valid proof produces an override, fall back to the native
 * `retry` event's provider response payload, which is authoritative for the
 * quota error path that the response hook never observes.
 */
export function applyCodexQuotaRetryV2Hook(event: unknown, options: CodexQuotaRetryFetchOptions = {}): boolean {
  if (!event || typeof event !== "object") return false;
  const retry = event as { sessionID?: unknown; model?: unknown; error?: unknown; decision?: unknown };
  const state = v2State();
  if (typeof retry.sessionID !== "string" || !retry.sessionID) return false;
  if (!retry.error || typeof retry.error !== "object" || !retry.decision || typeof retry.decision !== "object") {
    removeV2Proof(state, retry.sessionID);
    return false;
  }
  const now = resolveMonotonicMs(options);
  cleanupV2State(state, readClock(options.nowMs, Date.now) ?? Date.now(), now ?? Date.now());
  const error = retry.error as { type?: unknown; message?: unknown; status?: unknown; response?: unknown };
  const model = retry.model;
  // OpenCode 2.0.32's public retry summaries map QuotaExceeded to
  // provider.quota and RateLimit to provider.rate-limit (verified in the
  // installed binary; these are not the AI error class/tag names).
  // Retry events for any other provider are never intercepted.
  if ((error.type !== "provider.quota" && error.type !== "provider.rate-limit")
    || typeof error.message !== "string" || (error.status !== undefined && error.status !== 429)
    || (model !== undefined && model !== null
      && (typeof model !== "object" || (model as { providerID?: unknown }).providerID !== "openai"))) {
    removeV2Proof(state, retry.sessionID);
    return false;
  }

  // First path: a fresh proof minted by the fetch boundary.
  const proof = now === undefined ? undefined : state.retryProofs.get(retry.sessionID);
  if (now !== undefined) removeV2Proof(state, retry.sessionID);
  if (now !== undefined && proof && proof.expiresMonotonicMs > now
    && !state.ambiguousSessions.has(retry.sessionID) && !state.activeBySession.has(retry.sessionID)) {
    const cooldown = getActiveSharedCooldown(options);
    if (cooldown) {
      const decision = retry.decision as { retry?: unknown; delay?: unknown };
      const delay = Math.max(0, Math.ceil(cooldown.remainingMs));
      if (Number.isFinite(delay)) {
        decision.retry = true;
        decision.delay = delay;
        return true;
      }
    }
  }

  // Second path: the exact provider response carried by the native retry
  // event. It is read only; the error payload is never mutated.
  const response = error.response;
  if (!response || typeof response !== "object") return false;
  const payload = response as { body?: unknown; headers?: unknown; status_code?: unknown };
  const rawBody = payload.body;
  let parsedBody: unknown;
  if (typeof rawBody === "string") {
    const maxBodyBytes = typeof options.maxErrorBodyBytes === "number" && Number.isFinite(options.maxErrorBodyBytes)
      ? options.maxErrorBodyBytes
      : CODEX_ERROR_BODY_MAX_BYTES;
    if (rawBody.length > maxBodyBytes) return false;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return false;
    }
  } else if (rawBody && typeof rawBody === "object") {
    parsedBody = rawBody;
  } else {
    return false;
  }

  const status = payload.status_code ?? error.status ?? 429;
  if (status !== 429) return false;
  const parsedHeaders = parsedBody && typeof parsedBody === "object"
    ? (parsedBody as { headers?: HeaderCollection }).headers
    : undefined;
  const input: CodexQuotaResponseInput = {
    status,
    headers: (payload.headers as HeaderCollection | undefined) ?? parsedHeaders,
    body: parsedBody,
  };
  if (!classifyCodexQuotaResponse(input)) return false;

  const wallNow = resolveNowMs({ nowMs: options.nowMs });
  const monoNow = resolveMonotonicMs(options);
  if (wallNow === undefined || monoNow === undefined) return false;

  const normalized = parseCodexQuotaDeadline(input, {
    nowMs: wallNow,
    fallbackMs: options.fallbackMs,
    fallbackHours: options.fallbackHours,
  });
  if (normalized === undefined) return false;

  const sharedDeadline = armSharedCooldown(normalized, options, wallNow, monoNow);
  if (sharedDeadline === undefined) return false;

  const headerDeadline = sharedDeadline.deadlineMonotonicMs > monoNow
    ? {
      ...normalized,
      // Mirror the fetch path: use the shared monotonic remainder so grace and
      // stagger are not applied twice.
      deadlineMs: wallNow + sharedDeadline.deadlineMonotonicMs - monoNow,
    }
    : normalized;

  getSharedCancellationState(options).recordQuotaRetry(retry.sessionID, headerDeadline.deadlineMs);
  removeV2Proof(state, retry.sessionID);

  const activeCooldown = getActiveSharedCooldown(options);
  if (!activeCooldown) return false;
  const delay = Math.max(0, Math.ceil(activeCooldown.remainingMs));
  if (!Number.isFinite(delay)) return false;
  const decision = retry.decision as { retry?: unknown; delay?: unknown };
  decision.retry = true;
  decision.delay = delay;
  return true;
}

async function adaptCodexQuotaResponse(
  response: Response,
  options: CodexQuotaRetryFetchOptions,
  signal?: AbortSignal,
  sessionID?: string,
  lease?: V2RequestLease,
): Promise<Response> {
  if (signal?.aborted) {
    return Promise.reject(getAbortReason(signal));
  }
  if (!(response instanceof Response) || response.status !== 429) {
    return response;
  }

  const body = await readBoundedCodexQuotaErrorBody(response, {
    maxBytes: options.maxErrorBodyBytes,
    timeoutMs: options.errorBodyTimeoutMs,
    signal,
  });
  if (signal?.aborted) {
    return Promise.reject(getAbortReason(signal));
  }
  if (body.status !== "parsed" || body.bodyBytes === undefined) {
    return response;
  }

  const readCompletedAtMs = resolveNowMs({ nowMs: options.nowMs });
  if (readCompletedAtMs === undefined || !classifyCodexQuotaResponse({
    status: response.status,
    headers: response.headers,
    body: body.body,
  })) {
    return response;
  }

  const normalized = parseCodexQuotaDeadline({
    status: response.status,
    headers: response.headers,
    body: body.body,
  }, {
    nowMs: readCompletedAtMs,
    fallbackMs: options.fallbackMs,
    fallbackHours: options.fallbackHours,
  });
  if (normalized === undefined) {
    return response;
  }

  const monotonicNowMs = resolveMonotonicMs(options);
  const sharedDeadline = monotonicNowMs !== undefined
    ? armSharedCooldown(normalized, options, readCompletedAtMs, monotonicNowMs)
    : undefined;
  const headerDeadline = sharedDeadline && monotonicNowMs !== undefined
    && sharedDeadline.deadlineMonotonicMs > monotonicNowMs
    ? {
      ...normalized,
      // Use the shared monotonic remainder so the first native retry and later
      // synthetic retries observe the same grace, stagger, and latest deadline.
      deadlineMs: readCompletedAtMs + sharedDeadline.deadlineMonotonicMs - monotonicNowMs,
    }
    : normalized;

  const nativeHeaders = buildCodexNativeRetryHeaders(headerDeadline, {
    nowMs: readCompletedAtMs,
    maxDelayMs: options.maxNativeDelayMs,
    existingHeaders: response.headers,
  });
  if (nativeHeaders === undefined) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("retry-after-ms", nativeHeaders.retryAfterMs);
  headers.set("retry-after", nativeHeaders.retryAfter);
  if (sessionID) getSharedCancellationState(options).recordQuotaRetry(sessionID, headerDeadline.deadlineMs);
  const adapted = new Response(body.bodyBytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (lease && !lease.invalid) lease.qualified = true;
  return adapted;
}

function buildSyntheticCooldownResponse(
  cooldown: { remainingMs: number },
  options: CodexQuotaRetryFetchOptions,
): Response | undefined {
  const wallNowMs = resolveNowMs(options);
  if (wallNowMs === undefined) {
    return undefined;
  }

  // The shared record already contains grace and stagger. Converting the
  // monotonic remainder back to an absolute wall deadline avoids adding grace
  // a second time and remains stable if wall-clock time moves.
  const nativeHeaders = buildCodexNativeRetryHeaders({
    deadlineMs: wallNowMs + cooldown.remainingMs,
    source: "shared-cooldown",
    usedFallback: false,
  }, {
    nowMs: wallNowMs,
    maxDelayMs: options.maxNativeDelayMs,
  });
  if (nativeHeaders === undefined) {
    return undefined;
  }

  const headers = new Headers({
    "content-type": "application/json",
    "retry-after-ms": nativeHeaders.retryAfterMs,
    "retry-after": nativeHeaders.retryAfter,
  });
  return new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
    status: 429,
    statusText: "Quota Exhausted",
    headers,
  });
}

/**
 * Match only the exact HTTP Codex generation route. WebSocket and other
 * transports intentionally return false and remain outside this adapter.
 */
export function isCodexGenerationRequest(input: unknown, init?: unknown): boolean {
  const url = parseRequestUrl(input);
  if (
    !url ||
    url.origin !== CODEX_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== CODEX_GENERATION_PATH
  ) {
    return false;
  }

  return readMethod(input, init).toUpperCase() === "POST";
}

/** Install one idempotent fetch boundary around the existing transport chain. */
export function installCodexQuotaRetryFetch(
  options: CodexQuotaRetryFetchOptions = {},
): CodexQuotaRetryInstallation {
  if (options.v2Correlation) getV2RuntimeOptions();
  const existing = getRegistry();
  if (existing) {
    const v2Wrapper = (globalThis as Record<PropertyKey, unknown>)[V2_WRAPPER_SYMBOL];
    return {
      installed: false,
      compatible: options.v2Correlation !== true || v2Wrapper === existing.wrapper,
      restore: makeRestore(existing),
      wrapper: existing.wrapper,
    };
  }

  const original = getFetch();
  const wrapper = function (this: unknown, ...args: any[]): any {
    // Nonmatching requests retain the original return identity and arguments.
    if (!isCodexGenerationRequest(args[0], args[1])) {
      return Reflect.apply(original, this, args);
    }
    const runtimeOptions = options.v2Correlation ? getV2RuntimeOptions().options : options;

    let forwardedArgs = args;
    let sessionID: string | undefined;
    let v2HeaderNormalizationFailed = false;
    if (runtimeOptions.v2Correlation) {
      try {
        const init = args[1] && typeof args[1] === "object" ? args[1] as RequestInit : undefined;
        const initHasHeaders = init?.headers !== undefined;
        const headers = new Headers(initHasHeaders
          ? init.headers
          : typeof Request !== "undefined" && args[0] instanceof Request ? args[0].headers : undefined);
        const token = headers.get(CODEX_V2_CORRELATION_HEADER);
        if (token !== null) {
          headers.delete(CODEX_V2_CORRELATION_HEADER);
          const correlationNow = resolveNowMs({ nowMs: runtimeOptions.nowMs }) ?? Date.now();
          sessionID = consumeCodexV2CorrelationToken(token, correlationNow,
            resolveMonotonicMs(runtimeOptions) ?? (typeof performance !== "undefined" ? performance.now() : Date.now()));
          if (!sessionID) invalidateReusedV2CorrelationToken(token, correlationNow,
            resolveMonotonicMs(runtimeOptions) ?? (typeof performance !== "undefined" ? performance.now() : Date.now()));
          if (initHasHeaders && init) {
            forwardedArgs = [args[0], { ...init, headers }, ...args.slice(2)];
          } else if (typeof Request !== "undefined" && args[0] instanceof Request) {
            const sanitized = new Request(args[0], { headers, signal: args[0].signal });
            forwardedArgs = [sanitized, ...args.slice(1)];
          } else if (init) {
            forwardedArgs = [args[0], { ...init, headers }, ...args.slice(2)];
          }
        }
      } catch {
        // If local header normalization fails, fail closed for identity but keep
        // the exact request path available to the native transport.
        sessionID = undefined;
        v2HeaderNormalizationFailed = true;
      }
    } else {
      sessionID = readVerifiedCodexSessionID(args[0], args[1]);
    }

    const signal = getRequestSignal(args[0], args[1]);
    if (v2HeaderNormalizationFailed) return Promise.reject(new TypeError("Could not safely consume the private Codex correlation header"));
    if (signal?.aborted) {
      if (runtimeOptions.v2Correlation && sessionID) invalidateV2Session(v2State(), sessionID);
      return Promise.reject(getAbortReason(signal));
    }
    const cancellationState = getSharedCancellationState(runtimeOptions);
    const lease = runtimeOptions.v2Correlation && sessionID
      ? beginV2PrimaryRequest(sessionID, signal, runtimeOptions)
      : undefined;
    try {
      if (runtimeOptions.v2Correlation && sessionID) {
        const markers = v2CancellationMarkers();
        const wallNow = resolveNowMs({ nowMs: runtimeOptions.nowMs }) ?? Date.now();
        const monoNow = resolveMonotonicMs(runtimeOptions) ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
        cleanupV2State(v2State(), wallNow, monoNow);
        const markerExpiry = markers.get(sessionID);
        if (markerExpiry !== undefined && markerExpiry > monoNow) {
          if (lease) lease.invalid = true;
          return Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
            .finally(() => { if (lease) finalizeV2Lease(lease, monoNow); });
        }
        // The first matching primary fetch after a native retry schedule means
        // that generation is continuing; do not let a replayed interruption mark it.
        v2State().scheduled.delete(sessionID);
      }
      if (cancellationState.isCancelled(sessionID)) {
        if (lease) lease.invalid = true;
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
          .finally(() => { if (lease) finalizeV2Lease(lease, resolveMonotonicMs(runtimeOptions)); });
      }
      cancellationState.onCodexRetryFetch(sessionID);
      const activeCooldown = getActiveSharedCooldown(runtimeOptions);
      if (activeCooldown) {
        // Check cancellation before constructing a synthetic response so native
        // AbortError semantics win and do not alter the shared route state.
        if (signal?.aborted) {
          if (lease) lease.invalid = true;
          return Promise.reject(getAbortReason(signal)).finally(() => { if (lease) finalizeV2Lease(lease); });
        }
        const synthetic = buildSyntheticCooldownResponse(activeCooldown, runtimeOptions);
        if (synthetic !== undefined) {
          if (signal?.aborted) {
            if (lease) lease.invalid = true;
            return Promise.reject(getAbortReason(signal)).finally(() => { if (lease) finalizeV2Lease(lease); });
          }
          if (sessionID) cancellationState.recordQuotaRetry(sessionID, activeCooldown.deadlineWallMs);
          if (lease) lease.qualified = true;
          return Promise.resolve(synthetic).finally(() => { if (lease) finalizeV2Lease(lease, resolveMonotonicMs(runtimeOptions)); });
        }
      }
      const result = Reflect.apply(original, this, forwardedArgs);
      return Promise.resolve(result).then((response: Response) => adaptCodexQuotaResponse(response, runtimeOptions, signal, sessionID, lease))
        .finally(() => { if (lease) finalizeV2Lease(lease, resolveMonotonicMs(runtimeOptions)); });
    } catch (error) {
      if (lease) { lease.invalid = true; finalizeV2Lease(lease, resolveMonotonicMs(runtimeOptions)); }
      throw error;
    }
  } as FetchImplementation;

  copyFetchProperties(original, wrapper);

  const record: FetchRegistryRecord = { original, wrapper };
  setFetch(wrapper);
  try {
  setRegistry(record);
    if (options.v2Correlation) Object.defineProperty(globalThis, V2_WRAPPER_SYMBOL, {
      configurable: true, enumerable: false, value: wrapper, writable: true,
    });
  } catch (error) {
    setFetch(original);
    throw error;
  }

  return {
    installed: true,
    restore: makeRestore(record),
    wrapper,
  };
}

type CodexQuotaRetryV2Context = {
  location?: { directory?: string; workspaceID?: string };
  options?: CodexQuotaRetryFetchOptions;
  session?: {
    hook?: (
      name: "http.request" | "retry",
      callback: (event: unknown) => void | Promise<void>,
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
  event?: {
    subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
};

const V2_SETUP_SYMBOL = Symbol.for("opencode.codex-quota-retry.v2-plugin-setup");
type V2SetupRecord = {
  refs: number;
  controller: AbortController;
  registrations: Array<Promise<{ dispose: () => Promise<void> }>>;
  subscription: Promise<void>;
  ready: Promise<void>;
  hasNativeHook: boolean;
  cleanupPromise?: Promise<void>;
};

const CodexQuotaRetryPlugin = {
  id: "codex-quota-retry",
  setup(ctx: CodexQuotaRetryV2Context): (() => Promise<void>) | Promise<() => Promise<void>> {
    configureCodexQuotaRetryV2Options(ctx.options ?? {});
    const installation = installCodexQuotaRetryFetch({ ...(ctx.options ?? {}), v2Correlation: true });
    if (installation.compatible === false) {
      throw new Error("Codex quota retry V2 requires a fresh service process; an existing fetch wrapper cannot be upgraded safely");
    }

    const shared = globalThis as Record<PropertyKey, unknown>;
    const setups = (shared[V2_SETUP_SYMBOL] as Map<string, V2SetupRecord> | undefined) ?? new Map<string, V2SetupRecord>();
    if (shared[V2_SETUP_SYMBOL] !== setups) Object.defineProperty(shared, V2_SETUP_SYMBOL, {
      configurable: true, enumerable: false, value: setups, writable: true,
    });
    const locationKey = `${ctx.location?.workspaceID ?? ""}\u0000${ctx.location?.directory ?? "default"}`;
    const removeRecord = (record: V2SetupRecord) => {
      if (setups.get(locationKey) !== record) return;
      setups.delete(locationKey);
      if (setups.size === 0) {
        clearCodexV2CorrelationState();
        delete shared[V2_SETUP_SYMBOL];
      }
    };
    const finish = (record: V2SetupRecord): Promise<void> => {
      if (record.cleanupPromise) return record.cleanupPromise;
      record.controller.abort();
      record.cleanupPromise = (async () => {
        const settled = await Promise.allSettled(record.registrations);
        await Promise.all(settled.flatMap((result) => result.status === "fulfilled" ? [result.value.dispose()] : []));
        await record.subscription;
        removeRecord(record);
      })();
      return record.cleanupPromise;
    };
    const cleanupFor = (record: V2SetupRecord): (() => Promise<void>) => {
      let called = false;
      let completion: Promise<void> | undefined;
      return () => {
        if (called) return completion ?? Promise.resolve();
        called = true;
        record.refs--;
        if (record.refs !== 0) return Promise.resolve();
        completion = finish(record);
        return completion;
      };
    };

    let record = setups.get(locationKey);
    if (record) {
      record.refs++;
      const cleanup = cleanupFor(record);
      return record.hasNativeHook ? record.ready.then(() => cleanup, async (error) => { await finish(record!); throw error; }) : cleanup;
    }

    const controller = new AbortController();
    record = {
      refs: 1,
      controller,
      registrations: [],
      subscription: Promise.resolve(),
      ready: Promise.resolve(),
      hasNativeHook: typeof ctx.session?.hook === "function",
    };
    setups.set(locationKey, record);
    const active = record;
    const subscribe = ctx.event?.subscribe;
    if (typeof subscribe === "function") {
      active.subscription = (async () => {
        try {
          for await (const event of subscribe.call(ctx.event, { signal: controller.signal })) {
            const eventClock = ctx.options?.nowMs;
            const eventWall = typeof eventClock === "function" ? eventClock() : eventClock ?? Date.now();
            const monoClock = ctx.options?.monotonicMs;
            const eventMono = typeof monoClock === "function" ? monoClock() : monoClock ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
            observeCodexQuotaRetryV2Event(event, eventWall, eventMono);
            if (event && typeof event === "object" && (event as { type?: unknown }).type === "session.status") observeCodexQuotaRetrySessionStatus(event);
          }
        } catch {
          // Unload aborts the stream; event transport failures are non-fatal.
        }
      })();
    }
    if (active.hasNativeHook) {
      const registration = Promise.resolve().then(() => ctx.session!.hook!("http.request", (event) => {
        correlateCodexQuotaRetryV2HttpRequest(event, ctx.options ?? {});
      }));
      active.registrations.push(registration);
      active.registrations.push(Promise.resolve().then(() => ctx.session!.hook!("retry", (event) => {
        applyCodexQuotaRetryV2Hook(event, getV2RuntimeOptions().options);
      })));
      active.ready = Promise.all(active.registrations).then(() => undefined, async (error) => {
        active.refs = 0;
        await finish(active);
        throw error;
      });
      return active.ready.then(() => cleanupFor(active));
    }

    // Historical provider-free V1 tests provide no native session hook and call
    // setup synchronously. Keep that contract while cleanup remains awaitable.
    return cleanupFor(active);
  },
  async server(_input: unknown, options: CodexQuotaRetryFetchOptions = {}) {
    installCodexQuotaRetryFetch(options);
    return {
      event: async ({ event }: { event: unknown }) => {
        if (event && typeof event === "object"
          && (event as { type?: unknown }).type === "session.status") {
          observeCodexQuotaRetrySessionStatus(event);
        }
      },
    };
  },
};

export default CodexQuotaRetryPlugin;
