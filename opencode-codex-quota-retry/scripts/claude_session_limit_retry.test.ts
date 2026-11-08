import { beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  CLAUDE_PROVIDER_ID,
  CLAUDE_SESSION_LIMIT_GRACE_MS,
  CLAUDE_SESSION_LIMIT_MAX_WAIT_MS,
  CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES,
  CLAUDE_SESSION_LIMIT_TIMER_MAX_MS,
  applyClaudeSessionLimitRetryHook,
  parseClaudeSessionLimitNativeDeadline,
  resetClaudeSessionLimitCooldown,
  type ClaudeSessionLimitRetryOptions,
} from "../src/lib/claude-session-limit-retry.ts";
import ClaudeSessionLimitRetryPlugin from "../src/plugins/claude-session-limit-retry.ts";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const MONO = 1_000_000;
const HOUR = 60 * 60 * 1000;
const GRACE = CLAUDE_SESSION_LIMIT_GRACE_MS;
const OPTIONS: ClaudeSessionLimitRetryOptions = { nowMs: NOW, monotonicMs: MONO, staggerMs: 0 };
const NATIVE_PREFIX = "Claude Code subscription limit reached";

type RetryEvent = {
  model: { providerID: string; id: string };
  error: Record<string, unknown>;
  decision: { retry: boolean; delay?: number };
};

function resetIso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function nativeMessage(offsetMs = 2 * HOUR): string {
  return `${NATIVE_PREFIX} (five hour). Resets at ${resetIso(offsetMs)}.`;
}

function nativeMessageWithoutRateLimitType(offsetMs = 2 * HOUR): string {
  return `${NATIVE_PREFIX}. Resets at ${resetIso(offsetMs)}.`;
}

function nativeEvent(
  message: unknown,
  options: {
    providerID?: string;
    type?: unknown;
    includeType?: boolean;
    response?: unknown;
    includeResponse?: boolean;
  } = {},
): RetryEvent {
  const error: Record<string, unknown> = { message };
  if (options.includeType) error.type = options.type;
  if (options.includeResponse) error.response = options.response;
  return {
    model: { providerID: options.providerID ?? CLAUDE_PROVIDER_ID, id: "claude-sonnet-4-5" },
    error,
    decision: { retry: false },
  };
}

function assertDeclined(event: RetryEvent, options: ClaudeSessionLimitRetryOptions = OPTIONS): void {
  const before = structuredClone(event.decision);
  assert.equal(applyClaudeSessionLimitRetryHook(event, options), false);
  assert.deepEqual(event.decision, before);
}

beforeEach(() => resetClaudeSessionLimitCooldown());

test("native rate_limit_event normalization promotes the verified five-hour reset", () => {
  const event = nativeEvent(nativeMessage(), { includeType: true, type: "provider.unknown" });
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("native rejected reset without rateLimitType uses the verified no-parenthetical signature", () => {
  const normalizedUnknownType = nativeEvent(nativeMessageWithoutRateLimitType(), {
    includeType: true,
    type: "provider.unknown",
  });
  assert.equal(applyClaudeSessionLimitRetryHook(normalizedUnknownType, OPTIONS), true);
  assert.deepEqual(normalizedUnknownType.decision, { retry: true, delay: 2 * HOUR + GRACE });

  resetClaudeSessionLimitCooldown();
  const missingNormalizedType = nativeEvent(nativeMessageWithoutRateLimitType());
  assert.equal(Object.hasOwn(missingNormalizedType.error, "type"), false);
  assert.equal(applyClaudeSessionLimitRetryHook(missingNormalizedType, OPTIONS), true);
  assert.deepEqual(missingNormalizedType.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("native assistant.error normalization without a reset is not assigned a fallback", () => {
  const event = nativeEvent(`${NATIVE_PREFIX}.`, { includeType: true, type: "provider.unknown" });
  assertDeclined(event);
});

test("combined native events retain the verified rate-limit reset message", () => {
  const event = nativeEvent(nativeMessage());
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("missing error.type does not disqualify the unique native signature", () => {
  const event = nativeEvent(nativeMessage());
  assert.equal(Object.hasOwn(event.error, "type"), false);
  assert.equal(Object.hasOwn(event.error, "response"), false);
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("classification ignores optional type and response accessors", () => {
  const error: Record<string, unknown> = { message: nativeMessage() };
  Object.defineProperties(error, {
    type: { configurable: true, get() { throw new Error("type must not be read"); } },
    response: { configurable: true, get() { throw new Error("response must not be read"); } },
  });
  const event: RetryEvent = {
    model: { providerID: CLAUDE_PROVIDER_ID, id: "claude-sonnet-4-5" },
    error,
    decision: { retry: false },
  };
  assert.doesNotThrow(() => assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true));
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("native reset parser accepts only a complete anchored message", () => {
  assert.equal(parseClaudeSessionLimitNativeDeadline(nativeMessage(), NOW), NOW + 2 * HOUR);
  assert.equal(parseClaudeSessionLimitNativeDeadline(`${nativeMessage()}\n`, NOW), undefined);
  assert.equal(parseClaudeSessionLimitNativeDeadline(`prefix ${nativeMessage()}`, NOW), undefined);
  assert.equal(parseClaudeSessionLimitNativeDeadline(`${NATIVE_PREFIX} (five hour) Resets at ${resetIso(2 * HOUR)}.`, NOW), undefined);
});

const ambiguousMessages: Array<[string, string]> = [
  ["overload", `Claude Code overloaded. Resets at ${resetIso(2 * HOUR)}.`],
  ["authentication", `Claude Code authentication failed. Resets at ${resetIso(2 * HOUR)}.`],
  ["billing", `Claude Code billing limit reached. Resets at ${resetIso(2 * HOUR)}.`],
  ["other reset class", `${NATIVE_PREFIX} (weekly). Resets at ${resetIso(2 * HOUR)}.`],
  ["unknown reset label", `${NATIVE_PREFIX} (unknown). Resets at ${resetIso(2 * HOUR)}.`],
  ["missing reset", `${NATIVE_PREFIX}.`],
  ["timestamp without native structure", `Rate limit exceeded; reset at ${resetIso(2 * HOUR)}.`],
  ["extra trailing text", `${nativeMessage()} authentication failed`],
  ["nested JSON text", JSON.stringify({ error: { message: nativeMessage() } })],
];

for (const [name, message] of ambiguousMessages) {
  test(`does not promote ambiguous native message: ${name}`, () => {
    assertDeclined(nativeEvent(message, { includeType: true, type: "provider.unknown" }));
  });
}

test("old claude-code provider is not a compatibility path", () => {
  assertDeclined(nativeEvent(nativeMessage(), { providerID: "claude-code" }));
});

test("wrong provider does not promote an otherwise matching native message", () => {
  assertDeclined(nativeEvent(nativeMessage(), { providerID: "openai" }));
});

test("missing model, error, or decision is declined", () => {
  const missingModel = nativeEvent(nativeMessage()) as unknown as Record<string, unknown>;
  delete missingModel.model;
  assert.equal(applyClaudeSessionLimitRetryHook(missingModel, OPTIONS), false);

  const missingError = nativeEvent(nativeMessage()) as unknown as Record<string, unknown>;
  delete missingError.error;
  assert.equal(applyClaudeSessionLimitRetryHook(missingError, OPTIONS), false);

  const missingDecision = nativeEvent(nativeMessage()) as unknown as Record<string, unknown>;
  delete missingDecision.decision;
  assert.equal(applyClaudeSessionLimitRetryHook(missingDecision, OPTIONS), false);
});

test("legacy proxy body fields are ignored and cannot make an old event eligible", () => {
  const event = nativeEvent(`${NATIVE_PREFIX}.`, {
    providerID: "claude-code",
    includeType: true,
    type: "provider.rate-limit",
    includeResponse: true,
    response: {
      status_code: 429,
      body: JSON.stringify({ error: { code: "claude_session_limit", type: "rate_limit_error", resets_at: resetIso(2 * HOUR) } }),
    },
  });
  assertDeclined(event);
});

test("an unrelated payload is not decoded as nested JSON message text", () => {
  const event = nativeEvent("provider error", {
    includeResponse: true,
    response: { body: JSON.stringify({ message: nativeMessage() }) },
  });
  assertDeclined(event);
});

test("successful native classification leaves the full error payload unchanged", () => {
  const event = nativeEvent(nativeMessage(), {
    includeType: true,
    type: "provider.unknown",
    includeResponse: true,
    response: { body: { untouched: true }, status_code: 429 },
  });
  const before = structuredClone(event.error);
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.error, before);
});

test("64 KiB text limit rejects oversized content", () => {
  const nested = JSON.stringify({ message: nativeMessage() });
  const message = `${"x".repeat(CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES + 1)}${nested}`;
  assertDeclined(nativeEvent(message));
});

test("64 KiB limit counts UTF-8 bytes for multibyte text", () => {
  const message = `${"é".repeat(CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES / 2 + 1)}${nativeMessageWithoutRateLimitType()}`;
  assert.equal(message.length < CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES, true);
  assert.equal(new TextEncoder().encode(message).byteLength > CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES, true);
  assert.equal(parseClaudeSessionLimitNativeDeadline(message, NOW), undefined);
  assertDeclined(nativeEvent(message));
});

test("oversized payload is never parsed when the native message is authoritative", () => {
  const event = nativeEvent(nativeMessage(), {
    includeResponse: true,
    response: { body: "x".repeat(CLAUDE_SESSION_LIMIT_TEXT_MAX_BYTES + 1) },
  });
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

const malformedResets: Array<[string, string]> = [
  // Date.parse normalizes this rollover into March; the parser must reject it.
  ["calendar rollover", "2026-02-30T12:00:00.000Z"],
  ["invalid month / non-finite parse", "2026-99-99T12:00:00.000Z"],
  ["invalid hour", "2026-11-08T25:00:00.000Z"],
  ["unrepresentable instant", "+275761-01-01T00:00:00.000Z"],
];

for (const [name, reset] of malformedResets) {
  test(`rejects malformed native reset: ${name}`, () => {
    const message = `${NATIVE_PREFIX} (five hour). Resets at ${reset}.`;
    assert.equal(parseClaudeSessionLimitNativeDeadline(message, NOW), undefined);
    assertDeclined(nativeEvent(message));
  });
}

test("stale native reset is rejected", () => {
  const message = nativeMessage(-HOUR);
  assert.equal(parseClaudeSessionLimitNativeDeadline(message, NOW), undefined);
  assertDeclined(nativeEvent(message));
});

test("non-finite clock input declines without changing the decision", () => {
  assertDeclined(nativeEvent(nativeMessage()), { ...OPTIONS, nowMs: Number.NaN });
  assertDeclined(nativeEvent(nativeMessage()), { ...OPTIONS, monotonicMs: Number.POSITIVE_INFINITY });
});

test("five-hour reset fits the six-hour default while a reset over six hours does not", () => {
  const accepted = nativeEvent(nativeMessage(5 * HOUR));
  assert.equal(applyClaudeSessionLimitRetryHook(accepted, OPTIONS), true);
  assert.deepEqual(accepted.decision, { retry: true, delay: 5 * HOUR + GRACE });

  assertDeclined(nativeEvent(nativeMessage(6 * HOUR)));
  assert.equal(CLAUDE_SESSION_LIMIT_MAX_WAIT_MS, 6 * HOUR);
});

test("positive finite maxWaitMs overrides the default and non-positive/non-finite values do not", () => {
  const sevenHours = nativeMessage(6 * HOUR);
  const accepted = nativeEvent(sevenHours);
  assert.equal(applyClaudeSessionLimitRetryHook(accepted, { ...OPTIONS, maxWaitMs: 7 * HOUR }), true);
  assert.deepEqual(accepted.decision, { retry: true, delay: 6 * HOUR + GRACE });

  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, "60000"]) {
    resetClaudeSessionLimitCooldown();
    assertDeclined(nativeEvent(nativeMessage(6 * HOUR)), { ...OPTIONS, maxWaitMs: invalid as number });
  }
});

test("custom maxWaitMs can decline or admit a native reset", () => {
  assertDeclined(nativeEvent(nativeMessage(2 * HOUR)), { ...OPTIONS, maxWaitMs: 30 * 60 * 1000 });
  const accepted = nativeEvent(nativeMessage(2 * HOUR));
  assert.equal(applyClaudeSessionLimitRetryHook(accepted, { ...OPTIONS, maxWaitMs: 3 * HOUR }), true);
  assert.deepEqual(accepted.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("maxWaitMs clamps at the native timer limit", () => {
  const underLimit = nativeEvent(nativeMessage(2_147_000_000));
  assert.equal(applyClaudeSessionLimitRetryHook(underLimit, { ...OPTIONS, maxWaitMs: 3_000_000_000 }), true);
  assert.deepEqual(underLimit.decision, { retry: true, delay: 2_147_060_000 });

  resetClaudeSessionLimitCooldown();
  assertDeclined(nativeEvent(nativeMessage(2_147_450_000)), { ...OPTIONS, maxWaitMs: 3_000_000_000 });
  assert.equal(CLAUDE_SESSION_LIMIT_TIMER_MAX_MS, 2_147_483_647);
});

test("weekly reset remains under native policy", () => {
  assertDeclined(nativeEvent(nativeMessage(7 * 24 * HOUR)));
});

test("grace is applied once and a later valid native reset extends shared cooldown", () => {
  const first = nativeEvent(nativeMessage(2 * HOUR));
  assert.equal(applyClaudeSessionLimitRetryHook(first, OPTIONS), true);
  assert.deepEqual(first.decision, { retry: true, delay: 2 * HOUR + GRACE });

  const sameReset = nativeEvent(nativeMessage(2 * HOUR));
  assert.equal(applyClaudeSessionLimitRetryHook(sameReset, OPTIONS), true);
  assert.deepEqual(sameReset.decision, { retry: true, delay: 2 * HOUR + GRACE });

  const later = nativeEvent(nativeMessage(3 * HOUR));
  assert.equal(applyClaudeSessionLimitRetryHook(later, OPTIONS), true);
  assert.deepEqual(later.decision, { retry: true, delay: 3 * HOUR + GRACE });
});

test("expired cooldown is ignored when a later event arrives", () => {
  assert.equal(applyClaudeSessionLimitRetryHook(nativeEvent(nativeMessage(2 * HOUR)), OPTIONS), true);
  const later = nativeEvent(nativeMessage(4 * HOUR));
  assert.equal(applyClaudeSessionLimitRetryHook(later, {
    nowMs: NOW + 3 * HOUR,
    monotonicMs: MONO + 3 * HOUR,
    staggerMs: 0,
  }), true);
  assert.deepEqual(later.decision, { retry: true, delay: HOUR + GRACE });
});

test("positive fractional monotonic remainder is rounded up", () => {
  assert.equal(applyClaudeSessionLimitRetryHook(nativeEvent(nativeMessage(3 * HOUR)), OPTIONS), true);
  const earlier = nativeEvent(nativeMessage(2 * HOUR));
  assert.equal(applyClaudeSessionLimitRetryHook(earlier, {
    nowMs: NOW,
    monotonicMs: MONO + 0.25,
    staggerMs: 0,
  }), true);
  assert.deepEqual(earlier.decision, { retry: true, delay: 3 * HOUR + GRACE });
});

test("injected clocks and stagger are used and stagger is bounded", () => {
  const event = nativeEvent(nativeMessage());
  assert.equal(applyClaudeSessionLimitRetryHook(event, {
    nowMs: () => NOW,
    monotonicMs: () => MONO,
    staggerMs: () => 999,
  }), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE + 250 });
});

test("Claude cooldown state uses a symbol distinct from Codex and does not mutate Codex state", () => {
  const claudeSymbol = Symbol.for("opencode.claude-session-limit-retry.cooldown");
  const codexSymbol = Symbol.for("opencode.codex-quota-retry.route-cooldown");
  assert.notEqual(claudeSymbol, codexSymbol);

  const globals = globalThis as Record<PropertyKey, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globalThis, codexSymbol);
  const codexSentinel = { untouched: true };
  Object.defineProperty(globalThis, codexSymbol, { configurable: true, value: codexSentinel });
  try {
    const event = nativeEvent(nativeMessage());
    assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
    assert.equal(globals[codexSymbol], codexSentinel);
    assert.equal(typeof globals[claudeSymbol], "object");
  } finally {
    resetClaudeSessionLimitCooldown();
    if (previous) Object.defineProperty(globalThis, codexSymbol, previous);
    else delete globals[codexSymbol];
  }
});

test("plugin id is claude-session-limit-retry", () => {
  assert.equal(ClaudeSessionLimitRetryPlugin.id, "claude-session-limit-retry");
});

test("plugin awaits retry-hook registration and cleanup disposes once", async () => {
  const names: string[] = [];
  const callbacks: Array<(event: unknown) => void> = [];
  let finishRegistration!: (registration: { dispose(): Promise<void> }) => void;
  const registration = new Promise<{ dispose(): Promise<void> }>((resolve) => { finishRegistration = resolve; });
  let disposed = 0;
  const setupPromise = ClaudeSessionLimitRetryPlugin.setup({
    options: OPTIONS,
    session: {
      hook: async (name, callback) => {
        names.push(name);
        callbacks.push(callback);
        return registration;
      },
    },
  });
  let setupResolved = false;
  void setupPromise.then(() => { setupResolved = true; });
  await Promise.resolve();
  assert.equal(setupResolved, false);
  assert.deepEqual(names, ["retry"]);

  finishRegistration({ dispose: async () => { disposed += 1; } });
  const cleanup = await setupPromise;
  const event = nativeEvent(nativeMessage());
  callbacks[0](event);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
  await Promise.all([cleanup(), cleanup()]);
  assert.equal(disposed, 1);
});

test("missing retry-hook API returns a no-op cleanup", async () => {
  const cleanup = await ClaudeSessionLimitRetryPlugin.setup({ session: {} });
  assert.equal(typeof cleanup, "function");
  await cleanup();
});

test("module evaluation does not register hooks or create cooldown state", async () => {
  const cooldownSymbol = Symbol.for("opencode.claude-session-limit-retry.cooldown");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "session");
  let sessionGetterCalls = 0;
  Object.defineProperty(globalThis, "session", {
    configurable: true,
    get() {
      sessionGetterCalls += 1;
      throw new Error("plugin setup context is unavailable during module evaluation");
    },
  });
  try {
    const suffix = `?task62=${Math.random()}`;
    const loaded = await import(`../src/plugins/claude-session-limit-retry.ts${suffix}`);
    assert.equal(loaded.default.id, "claude-session-limit-retry");
    assert.equal(Object.hasOwn(globalThis, cooldownSymbol), false);
    assert.equal(sessionGetterCalls, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "session", previous);
    else delete (globalThis as Record<string, unknown>).session;
  }
});

test("plugin callback contains malformed event access failures", async () => {
  let callback: ((event: unknown) => void) | undefined;
  await ClaudeSessionLimitRetryPlugin.setup({
    session: {
      hook: async (_name, registered) => {
        callback = registered;
        return { dispose: async () => {} };
      },
    },
  });
  const event = {};
  Object.defineProperty(event, "model", { get() { throw new Error("getter failure"); } });
  assert.doesNotThrow(() => callback?.(event));
});
