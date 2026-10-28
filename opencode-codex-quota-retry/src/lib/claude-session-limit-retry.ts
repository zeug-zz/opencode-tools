/**
 * Claude (`claude-code` provider) session-limit native retry adapter for
 * OpenCode V2. Independent of the Codex quota-retry sources: it only
 * registers the native `retry` hook and sets `decision.retry`/`decision.delay`
 * for two classes: the upstream session-limit 429 gate (A) and the mid-stream
 * `provider.internal` session-limit error (B, only when message text yields a
 * reset deadline). Deadlines come from structured fields and from reset times
 * in message text (ISO instants, `resets 7:50am (Zone)`, dated form); the
 * latest valid future candidate wins. It never mutates the error payload,
 * rewrites responses, runs a retry loop, or aborts sessions.
 */

export const CLAUDE_PROVIDER_ID = "claude-code";
export const CLAUDE_SESSION_LIMIT_GRACE_MS = 60_000;
export const CLAUDE_SESSION_LIMIT_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
export const CLAUDE_SESSION_LIMIT_TIMER_MAX_MS = 2_147_483_647;
export const CLAUDE_SESSION_LIMIT_STAGGER_MAX_MS = 250;
export const CLAUDE_SESSION_LIMIT_BODY_MAX_BYTES = 64 * 1024;

const CLAUDE_COOLDOWN_SYMBOL = Symbol.for("opencode.claude-session-limit-retry.cooldown");
const MAX_DATE_MS = 8.64e15;

type NumberSource = number | (() => number);
type HeaderCollection = Headers | Record<string, unknown> | ReadonlyArray<readonly [string, unknown]> | null | undefined;

export type ClaudeSessionLimitRetryOptions = {
  /** Wall clock in epoch milliseconds (number or provider). */
  nowMs?: NumberSource;
  /** Monotonic clock in milliseconds (number or provider). */
  monotonicMs?: NumberSource;
  /** Per-call stagger in ms, clamped to [0, 250]. Defaults to random. */
  staggerMs?: NumberSource;
  /** Maximum graced wait; positive finite, clamped to the timer maximum. */
  maxWaitMs?: number;
};

export type ClaudeSessionLimitInput = {
  status?: unknown;
  headers?: HeaderCollection;
  body?: unknown;
  /** Extra message texts (for example event-level `error.message`) scanned for reset times. */
  texts?: ReadonlyArray<unknown>;
};

type Cooldown = { deadlineMonotonicMs: number };

function readNumber(source: NumberSource | undefined, fallback: () => number): number | undefined {
  try {
    const value = source === undefined ? fallback() : typeof source === "function" ? source() : source;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function defaultMonotonic(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function lookupHeader(headers: HeaderCollection, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const wanted = name.toLowerCase();
  let value: unknown;
  if (typeof (headers as Headers).get === "function") {
    try {
      value = (headers as Headers).get(name);
    } catch {
      return undefined;
    }
  } else if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].toLowerCase() === wanted) {
        value = entry[1];
        break;
      }
    }
  } else {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) {
        value = (headers as Record<string, unknown>)[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** Parse the body of a payload into an object, or undefined when unusable. */
function parseBody(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") {
    if (raw.length > CLAUDE_SESSION_LIMIT_BODY_MAX_BYTES) return undefined;
    if (new TextEncoder().encode(raw).length > CLAUDE_SESSION_LIMIT_BODY_MAX_BYTES) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(raw) ? raw : undefined;
}

/**
 * Pure classifier: true only for the exact upstream session-limit 429
 * (status 429, `error.code=claude_session_limit`, `error.type=rate_limit_error`).
 * The body may be a JSON string (<= 64 KiB) or an object.
 */
export function classifyClaudeSessionLimitResponse(input: ClaudeSessionLimitInput): boolean {
  if (!input || input.status !== 429) return false;
  const body = parseBody(input.body);
  const error = body?.error;
  return isRecord(error) && error.code === "claude_session_limit" && error.type === "rate_limit_error";
}

/**
 * Mid-stream class B body check: status is not 429 (200 or absent) and the body
 * is `error.code=claude_session_limit`, `error.type=error`. Does not check the
 * deadline; the hook additionally requires a text-derived reset.
 */
export function classifyClaudeSessionLimitMidStreamResponse(input: ClaudeSessionLimitInput): boolean {
  if (!input || input.status === 429) return false;
  const error = parseBody(input.body)?.error;
  return isRecord(error) && error.code === "claude_session_limit" && error.type === "error";
}

function parseDeltaSeconds(value: unknown): number | undefined {
  let seconds: number | undefined;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value)) seconds = Number(value);
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function parseIso(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})/g;
const RESETS_WALL = /resets\s{1,4}(?:at\s{1,4})?(?:([A-Za-z]{3,9})\.?\s{1,4}(\d{1,2})(?:,?\s{1,4}(\d{4}))?,?\s{1,4})?(\d{1,2})(?::(\d{2}))?[\s  ]{0,2}([ap]m)\s{0,4}\(([A-Za-z0-9_+\-/]{1,64})\)/gi;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.length > CLAUDE_SESSION_LIMIT_BODY_MAX_BYTES) return undefined;
  return new TextEncoder().encode(value).length > CLAUDE_SESSION_LIMIT_BODY_MAX_BYTES ? undefined : value;
}

type ZoneParts = { y: number; mo: number; d: number; h: number; mi: number; s: number };

function zoneParts(formatter: Intl.DateTimeFormat, ms: number): ZoneParts | undefined {
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  const { year: y, month: mo, day: d, hour, minute: mi, second: s } = out;
  if (![y, mo, d, hour, mi, s].every(Number.isFinite)) return undefined;
  return { y, mo, d, h: hour % 24, mi, s };
}

/**
 * Instant of a zone wall time: the next occurrence strictly after now when
 * `date` is absent, else the nearest future one (year given or inferred).
 * Undefined for an invalid zone or date. DST-aware via a second offset check.
 */
function zoneWallInstant(
  zone: string, nowMs: number, date: { mo?: number; d?: number; y?: number }, hour24: number, minute: number,
): number | undefined {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    const offsetAt = (ms: number): number | undefined => {
      const p = zoneParts(formatter, ms);
      return p ? Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000 : undefined;
    };
    const resolve = (y: number, mo: number, d: number): number | undefined => {
      const wall = Date.UTC(y, mo, d, hour24, minute, 0);
      const first = offsetAt(wall);
      if (first === undefined) return undefined;
      let result = wall - first;
      const second = offsetAt(result);
      if (second !== undefined && second !== first) result = wall - second;
      return Number.isFinite(result) ? result : undefined;
    };
    const local = zoneParts(formatter, nowMs);
    if (!local) return undefined;
    if (date.mo === undefined || date.d === undefined) {
      const today = resolve(local.y, local.mo - 1, local.d);
      if (today !== undefined && today > nowMs) return today;
      return resolve(local.y, local.mo - 1, local.d + 1);
    }
    for (const y of date.y !== undefined ? [date.y] : [local.y, local.y + 1]) {
      if (new Date(Date.UTC(y, date.mo, date.d)).getUTCDate() !== date.d) continue;
      const at = resolve(y, date.mo, date.d);
      if (at !== undefined && at > nowMs) return at;
    }
  } catch {
    // Invalid zone (RangeError) or unrepresentable date: ignore the candidate.
  }
  return undefined;
}

/** Reset-time candidates (epoch ms) found in one message text. */
function textResetCandidates(text: string, nowMs: number): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(ISO_INSTANT)) {
    const ms = Date.parse(match[0]);
    if (Number.isFinite(ms)) found.push(ms);
  }
  for (const m of text.matchAll(RESETS_WALL)) {
    const hour12 = Number(m[4]);
    const minute = m[5] === undefined ? 0 : Number(m[5]);
    if (hour12 < 1 || hour12 > 12 || minute > 59) continue;
    const hour24 = (hour12 % 12) + (m[6].toLowerCase() === "pm" ? 12 : 0);
    let mo: number | undefined;
    if (m[1] !== undefined) {
      mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (mo < 0) continue;
    }
    const day = m[2] === undefined ? undefined : Number(m[2]);
    const year = m[3] === undefined ? undefined : Number(m[3]);
    const at = zoneWallInstant(m[7], nowMs, { mo, d: day, y: year }, hour24, minute);
    if (at !== undefined) found.push(at);
  }
  return found;
}

function textCandidates(input: ClaudeSessionLimitInput, nowMs: number): number[] {
  const error = parseBody(input.body)?.error;
  const sources = [...(Array.isArray(input.texts) ? input.texts : []), isRecord(error) ? error.message : undefined];
  const out: number[] = [];
  for (const source of sources) {
    const text = boundedText(source);
    if (text) out.push(...textResetCandidates(text, nowMs));
  }
  return out;
}

function latestFuture(candidates: ReadonlyArray<number | undefined>, nowMs: number): number | undefined {
  let latest: number | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined || !Number.isFinite(candidate) || candidate <= nowMs || candidate > MAX_DATE_MS) continue;
    if (latest === undefined || candidate > latest) latest = candidate;
  }
  return latest;
}

/**
 * Pure text-only deadline parser: latest valid future reset time found in
 * `input.texts` and `body.error.message`. Relative phrases are not parsed.
 */
export function parseClaudeSessionLimitTextDeadline(input: ClaudeSessionLimitInput, nowMs: number): number | undefined {
  if (!Number.isFinite(nowMs)) return undefined;
  return latestFuture(textCandidates(input, nowMs), nowMs);
}

/**
 * Pure deadline parser. Returns the latest valid future candidate (epoch ms,
 * without grace) among body `resets_at`, header `x-claude-rate-limit-reset`,
 * body `retry_after` (delta seconds), header `retry-after` (delta seconds or
 * HTTP-date), and reset times in `input.texts` / `body.error.message`.
 * Invalid, non-finite, non-future, or unrepresentable values are ignored.
 * There is no fallback deadline.
 */
export function parseClaudeSessionLimitDeadline(input: ClaudeSessionLimitInput, nowMs: number): number | undefined {
  if (!Number.isFinite(nowMs)) return undefined;
  const body = parseBody(input.body);
  const error = isRecord(body?.error) ? body.error : {};
  const candidates: Array<number | undefined> = [];

  candidates.push(parseIso(error.resets_at));
  candidates.push(parseIso(lookupHeader(input.headers, "x-claude-rate-limit-reset")));

  const bodyDelta = parseDeltaSeconds(error.retry_after);
  candidates.push(bodyDelta === undefined ? undefined : nowMs + bodyDelta * 1000);

  const retryAfter = lookupHeader(input.headers, "retry-after");
  if (retryAfter !== undefined) {
    const delta = parseDeltaSeconds(retryAfter);
    candidates.push(delta !== undefined ? nowMs + delta * 1000 : parseIso(retryAfter));
  }

  candidates.push(...textCandidates(input, nowMs));
  return latestFuture(candidates, nowMs);
}

function resolveMaxWaitMs(options: ClaudeSessionLimitRetryOptions): number {
  const configured = options.maxWaitMs;
  const base = typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : CLAUDE_SESSION_LIMIT_MAX_WAIT_MS;
  return Math.min(base, CLAUDE_SESSION_LIMIT_TIMER_MAX_MS);
}

function resolveStaggerMs(options: ClaudeSessionLimitRetryOptions): number {
  const value = readNumber(options.staggerMs, () => Math.random() * CLAUDE_SESSION_LIMIT_STAGGER_MAX_MS) ?? 0;
  return Math.floor(Math.min(Math.max(value, 0), CLAUDE_SESSION_LIMIT_STAGGER_MAX_MS));
}

function cooldownHolder(): { cooldown?: Cooldown } {
  const shared = globalThis as Record<PropertyKey, unknown>;
  let holder = shared[CLAUDE_COOLDOWN_SYMBOL] as { cooldown?: Cooldown } | undefined;
  if (!holder) {
    holder = {};
    Object.defineProperty(shared, CLAUDE_COOLDOWN_SYMBOL, {
      configurable: true, enumerable: false, value: holder, writable: true,
    });
  }
  return holder;
}

/** Clear the process-global Claude cooldown (test helper). */
export function resetClaudeSessionLimitCooldown(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[CLAUDE_COOLDOWN_SYMBOL];
}

/**
 * Handle a native `retry` event. Returns true only when `decision` was set.
 * The error payload is read, never mutated.
 */
export function applyClaudeSessionLimitRetryHook(event: unknown, options: ClaudeSessionLimitRetryOptions = {}): boolean {
  if (!isRecord(event)) return false;
  const { model, error, decision } = event as { model?: unknown; error?: unknown; decision?: unknown };
  if (!isRecord(model) || model.providerID !== CLAUDE_PROVIDER_ID) return false;
  if (!isRecord(error) || !isRecord(decision)) return false;
  const classA = error.type === "provider.rate-limit" || error.type === "provider.quota";
  const classB = error.type === "provider.internal";
  if (!classA && !classB) return false;

  const response = error.response;
  if (!isRecord(response)) return false;
  const status = response.status_code ?? error.status;
  const input: ClaudeSessionLimitInput = {
    status, headers: response.headers as HeaderCollection, body: response.body, texts: [error.message],
  };
  if (!(classA ? classifyClaudeSessionLimitResponse(input) : classifyClaudeSessionLimitMidStreamResponse(input))) return false;

  const wallNow = readNumber(options.nowMs, Date.now);
  const monoNow = readNumber(options.monotonicMs, defaultMonotonic);
  if (wallNow === undefined || monoNow === undefined) return false;
  // Class B is intercepted only with a text-derived reset; otherwise native backoff applies.
  if (classB && parseClaudeSessionLimitTextDeadline(input, wallNow) === undefined) return false;

  const deadline = parseClaudeSessionLimitDeadline(input, wallNow);
  if (deadline === undefined) return false;

  // Grace is applied exactly once, here; the cooldown stores the graced deadline.
  const gracedRemaining = deadline + CLAUDE_SESSION_LIMIT_GRACE_MS - wallNow;
  if (!Number.isFinite(gracedRemaining) || gracedRemaining > resolveMaxWaitMs(options)) return false;

  const holder = cooldownHolder();
  const existing = holder.cooldown;
  const active = existing && existing.deadlineMonotonicMs > monoNow ? existing : undefined;
  const armed = monoNow + gracedRemaining;
  const deadlineMonotonicMs = active ? Math.max(active.deadlineMonotonicMs, armed) : armed;

  const delay = Math.ceil(deadlineMonotonicMs - monoNow) + resolveStaggerMs(options);
  if (!Number.isFinite(delay) || delay < 0 || delay > CLAUDE_SESSION_LIMIT_TIMER_MAX_MS) return false;

  holder.cooldown = { deadlineMonotonicMs };
  decision.retry = true;
  decision.delay = delay;
  return true;
}

type ClaudeSessionLimitV2Context = {
  options?: ClaudeSessionLimitRetryOptions;
  session?: {
    hook?: (name: "retry", callback: (event: unknown) => void) => Promise<{ dispose(): Promise<void> }> | { dispose(): Promise<void> };
  };
};

const ClaudeSessionLimitRetryPlugin = {
  id: "claude-session-limit-retry",
  async setup(ctx: ClaudeSessionLimitV2Context): Promise<() => Promise<void>> {
    const hook = ctx?.session?.hook;
    if (typeof hook !== "function") return async () => {};
    const options = ctx.options ?? {};
    const registration = await hook.call(ctx.session, "retry", (event: unknown) => {
      try {
        applyClaudeSessionLimitRetryHook(event, options);
      } catch {
        // Never let adapter failures break the native retry path.
      }
    });
    let disposal: Promise<void> | undefined;
    return () => (disposal ??= Promise.resolve(registration.dispose()));
  },
};

export default ClaudeSessionLimitRetryPlugin;
