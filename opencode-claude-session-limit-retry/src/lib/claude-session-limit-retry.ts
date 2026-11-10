/**
 * Claude (`claude-agent`) native session-limit retry adapter for OpenCode V2.
 * It recognizes only the verified native retry-message signature, requires its
 * published reset, and delegates waiting/interruption to OpenCode's retry hook.
 * It never reads proxy payloads, mutates errors, rewrites responses, runs a
 * retry loop, or aborts sessions.
 */

export const CLAUDE_PROVIDER_ID = "claude-agent";
export const CLAUDE_SESSION_LIMIT_GRACE_MS = 60_000;
export const CLAUDE_SESSION_LIMIT_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
export const CLAUDE_SESSION_LIMIT_TIMER_MAX_MS = 2_147_483_647;
export const CLAUDE_SESSION_LIMIT_STAGGER_MAX_MS = 250;
export const CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES = 64 * 1024;

const MAX_DATE_MS = 8.64e15;
const NATIVE_FIVE_HOUR_RESET_MESSAGE = /^Claude Code subscription limit reached \(five hour\)\. Resets at ((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.$/;
const NATIVE_UNTYPED_RESET_MESSAGE = /^Claude Code subscription limit reached\. Resets at ((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.$/;
const NATIVE_SESSION_RESET_MESSAGE = /^You've hit your session limit · resets [^\r\n]+ Resets at ((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.$/;
const NATIVE_ISO_INSTANT = /^((?:\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z)$/;

type NumberSource = number | (() => number);

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

type Cooldown = { deadlineMonotonicMs: number };

function claudeCooldownSymbol(): symbol {
  return Symbol.for("opencode.claude-session-limit-retry.cooldown");
}

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

function boundedNativeText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES) return undefined;
  return new TextEncoder().encode(value).byteLength <= CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES ? value : undefined;
}

/**
 * Parse the exact UTC ISO representation emitted by the verified native
 * message. Round-tripping rejects dates that Date.parse would normalize (for
 * example February 30) as well as non-finite or unrepresentable instants.
 */
function parseNativeIsoInstant(value: string): number | undefined {
  const match = NATIVE_ISO_INSTANT.exec(value);
  if (!match || match[0] !== value) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MS) return undefined;
  try {
    if (new Date(milliseconds).toISOString() !== value) return undefined;
  } catch {
    return undefined;
  }
  return milliseconds;
}

/**
 * Parse one exact, verified native session-limit message. The native event may
 * omit its rate-limit type, producing the equally specific prefix + reset
 * form; arbitrary parenthetical labels remain ineligible. No response/body,
 * embedded JSON, arbitrary timestamp, or legacy wall-time form is inspected.
 */
export function parseClaudeSessionLimitNativeDeadline(message: unknown, nowMs: number): number | undefined {
  if (!Number.isFinite(nowMs)) return undefined;
  const text = boundedNativeText(message);
  if (!text) return undefined;
  const match = NATIVE_FIVE_HOUR_RESET_MESSAGE.exec(text) ?? NATIVE_UNTYPED_RESET_MESSAGE.exec(text)
    ?? NATIVE_SESSION_RESET_MESSAGE.exec(text);
  if (!match || match[0] !== text) return undefined;

  const deadline = parseNativeIsoInstant(match[1]);
  return deadline !== undefined && deadline > nowMs ? deadline : undefined;
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
  const symbol = claudeCooldownSymbol();
  let holder = shared[symbol] as { cooldown?: Cooldown } | undefined;
  if (!holder) {
    holder = {};
    Object.defineProperty(shared, symbol, {
      configurable: true, enumerable: false, value: holder, writable: true,
    });
  }
  return holder;
}

/** Clear the process-global Claude cooldown (test helper). */
export function resetClaudeSessionLimitCooldown(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[claudeCooldownSymbol()];
}

/**
 * Handle a native `retry` event. Returns true only when `decision` was set.
 * The provider and exact normalized message are the only classification inputs;
 * optional error type and any response payload are intentionally ignored.
 */
export function applyClaudeSessionLimitRetryHook(event: unknown, options: ClaudeSessionLimitRetryOptions = {}): boolean {
  if (!isRecord(event)) return false;
  const { model, error, decision } = event as { model?: unknown; error?: unknown; decision?: unknown };
  if (!isRecord(model) || model.providerID !== CLAUDE_PROVIDER_ID) return false;
  if (!isRecord(error) || !isRecord(decision)) return false;

  const wallNow = readNumber(options.nowMs, Date.now);
  const monoNow = readNumber(options.monotonicMs, defaultMonotonic);
  if (wallNow === undefined || monoNow === undefined) return false;

  const deadline = parseClaudeSessionLimitNativeDeadline(error.message, wallNow);
  if (deadline === undefined) return false;

  // Grace is applied exactly once; the shared cooldown stores the graced deadline.
  const gracedRemaining = deadline + CLAUDE_SESSION_LIMIT_GRACE_MS - wallNow;
  if (!Number.isFinite(gracedRemaining) || gracedRemaining <= 0 || gracedRemaining > resolveMaxWaitMs(options)) return false;

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
    return () => (disposal ??= Promise.resolve().then(() => registration.dispose()));
  },
};

export default ClaudeSessionLimitRetryPlugin;
