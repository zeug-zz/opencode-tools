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
}

interface FetchRegistryRecord {
  original: FetchImplementation;
  wrapper: FetchImplementation;
}

interface SharedCooldownRecord {
  deadlineMonotonicMs: number;
  authoritativeDeadlineWallMs: number;
  deadlineWallMs: number;
}

export interface CodexQuotaRetryInstallation {
  installed: boolean;
  wrapper: FetchImplementation;
  restore: () => void;
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

async function adaptCodexQuotaResponse(
  response: Response,
  options: CodexQuotaRetryFetchOptions,
  signal?: AbortSignal,
  sessionID?: string,
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
  return new Response(body.bodyBytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  const existing = getRegistry();
  if (existing) {
    return {
      installed: false,
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

    const signal = getRequestSignal(args[0], args[1]);
    if (signal?.aborted) {
      return Promise.reject(getAbortReason(signal));
    }
    const sessionID = readVerifiedCodexSessionID(args[0], args[1]);
    const cancellationState = getSharedCancellationState(options);
    if (cancellationState.isCancelled(sessionID)) {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    }
    cancellationState.onCodexRetryFetch(sessionID);
    const activeCooldown = getActiveSharedCooldown(options);
    if (activeCooldown) {
      // Check cancellation before constructing a synthetic response so native
      // AbortError semantics win and do not alter the shared route state.
      if (signal?.aborted) {
        return Promise.reject(getAbortReason(signal));
      }
      const synthetic = buildSyntheticCooldownResponse(activeCooldown, options);
      if (synthetic !== undefined) {
        if (signal?.aborted) {
          return Promise.reject(getAbortReason(signal));
        }
        if (sessionID) cancellationState.recordQuotaRetry(sessionID, activeCooldown.deadlineWallMs);
        return Promise.resolve(synthetic);
      }
    }

    const result = Reflect.apply(original, this, args);
    if (result && typeof result.then === "function") {
      return result.then((response: Response) => adaptCodexQuotaResponse(response, options, signal, sessionID));
    }
    return adaptCodexQuotaResponse(result, options, signal, sessionID);
  } as FetchImplementation;

  copyFetchProperties(original, wrapper);

  const record: FetchRegistryRecord = { original, wrapper };
  setFetch(wrapper);
  try {
    setRegistry(record);
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
