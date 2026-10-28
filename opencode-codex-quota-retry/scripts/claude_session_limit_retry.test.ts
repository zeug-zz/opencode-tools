import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  CLAUDE_PROVIDER_ID,
  CLAUDE_SESSION_LIMIT_BODY_MAX_BYTES,
  CLAUDE_SESSION_LIMIT_GRACE_MS,
  applyClaudeSessionLimitRetryHook,
  classifyClaudeSessionLimitMidStreamResponse,
  classifyClaudeSessionLimitResponse,
  parseClaudeSessionLimitDeadline,
  parseClaudeSessionLimitTextDeadline,
  resetClaudeSessionLimitCooldown,
  type ClaudeSessionLimitRetryOptions,
} from "../src/lib/claude-session-limit-retry.ts";
import ClaudeSessionLimitRetryPlugin from "../src/plugins/claude-session-limit-retry.ts";

// Fixtures follow the upstream opencode-claude 1.5.0 proxy session-limit 429 shape.
const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const MONO = 1_000_000;
const HOUR = 60 * 60 * 1000;
const GRACE = CLAUDE_SESSION_LIMIT_GRACE_MS;
const OPTIONS: ClaudeSessionLimitRetryOptions = { nowMs: NOW, monotonicMs: MONO, staggerMs: 0 };

type RetryEvent = {
  sessionID: string;
  agent: string;
  attempt: number;
  model?: unknown;
  error: Record<string, unknown>;
  decision: { retry: boolean; delay?: number };
};

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function gateBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    error: {
      message: "Claude session/usage limit reached · limit resets in 2h 0m",
      type: "rate_limit_error",
      code: "claude_session_limit",
      resets_at: iso(2 * HOUR),
      retry_after: 7200,
      ...overrides,
    },
  });
}

function gateHeaders(): Record<string, string> {
  return { "Retry-After": "7200", "x-claude-rate-limit-reset": iso(2 * HOUR) };
}

function gateError(response: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "provider.rate-limit",
    message: "Claude session/usage limit reached",
    response: { status_code: 429, headers: gateHeaders(), body: gateBody(), ...response },
  };
}

function gateEvent(error: Record<string, unknown> = gateError()): RetryEvent {
  return {
    sessionID: "ses_test",
    agent: "build",
    attempt: 1,
    model: { providerID: CLAUDE_PROVIDER_ID, id: "claude-sonnet" },
    error,
    decision: { retry: false },
  };
}

function midStreamBody(): string {
  return JSON.stringify({
    error: {
      message: JSON.stringify({ type: "error", error: { type: "server_error", code: "server_error", message: "limit" } }),
      type: "error",
      code: "claude_session_limit",
    },
  });
}

function assertDeclined(event: RetryEvent, options: ClaudeSessionLimitRetryOptions = OPTIONS): void {
  const before = structuredClone(event.decision);
  assert.equal(applyClaudeSessionLimitRetryHook(event, options), false);
  assert.deepEqual(event.decision, before);
}

test("2h session-limit reset sets retry with reset plus grace", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent();
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("5h session-limit reset within the default cap sets retry", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent(gateError({
    body: gateBody({ resets_at: iso(5 * HOUR), retry_after: 18000 }),
    headers: { "Retry-After": "18000", "x-claude-rate-limit-reset": iso(5 * HOUR) },
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 5 * HOUR + GRACE });
});

test("object body with error.status 429 is classified", () => {
  resetClaudeSessionLimitCooldown();
  const error = gateError({ status_code: undefined, body: JSON.parse(gateBody()) });
  error.status = 429;
  const event = gateEvent(error);
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("retry_after alone (no resets_at, no headers) yields retry_after plus grace", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent(gateError({
    headers: undefined,
    body: gateBody({ resets_at: undefined, retry_after: 1800 }),
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 1800 * 1000 + GRACE });
});

test("header-only reset with lowercase key is honored", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent(gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: { "x-claude-rate-limit-reset": iso(2 * HOUR) },
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("header-only reset with uppercase key is honored", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent(gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: { "X-CLAUDE-RATE-LIMIT-RESET": iso(2 * HOUR) },
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("header-only reset from a Headers instance is honored", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent(gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: new Headers({ "x-claude-rate-limit-reset": iso(2 * HOUR) }),
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("latest candidate wins when resets_at is earlier than retry_after", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent(gateError({
    body: gateBody({ resets_at: iso(HOUR), retry_after: 7200 }),
    headers: { "Retry-After": "7200" },
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

const negatives: Array<[string, () => RetryEvent]> = [
  ["wrong provider", () => {
    const event = gateEvent();
    event.model = { providerID: "openai", id: "gpt-5" };
    return event;
  }],
  ["missing model", () => {
    const event = gateEvent();
    delete event.model;
    return event;
  }],
  ["non-429 status", () => gateEvent(gateError({ status_code: 500 }))],
  ["provider.auth error type", () => {
    const error = gateError();
    error.type = "provider.auth";
    return gateEvent(error);
  }],
  ["wrong error code", () => gateEvent(gateError({ body: gateBody({ code: "rate_limit_exceeded" }) }))],
  ["wrong body type", () => gateEvent(gateError({ body: gateBody({ type: "server_error" }) }))],
  ["malformed JSON body", () => gateEvent(gateError({ body: '{"error": {"code": "claude_session_limit"' }))],
  ["oversized body", () => gateEvent(gateError({
    body: JSON.stringify({
      error: {
        type: "rate_limit_error",
        code: "claude_session_limit",
        message: "x".repeat(CLAUDE_SESSION_LIMIT_BODY_MAX_BYTES),
        resets_at: iso(2 * HOUR),
      },
    }),
  }))],
  ["mid-stream server_error on provider.internal with status 200", () => gateEvent({
    type: "provider.internal",
    message: "stream error",
    response: { status_code: 200, headers: gateHeaders(), body: midStreamBody() },
  })],
  ["mid-stream server_error without a 429 status", () => gateEvent({
    type: "provider.rate-limit",
    message: "stream error",
    response: { headers: gateHeaders(), body: midStreamBody() },
  })],
  ["missing response object", () => {
    const error = gateError();
    delete error.response;
    return gateEvent(error);
  }],
];

for (const [name, build] of negatives) {
  test(`declines ${name} and leaves decision untouched`, () => {
    resetClaudeSessionLimitCooldown();
    assertDeclined(build());
  });
}

const staleDeadlines: Array<[string, Record<string, unknown>]> = [
  ["body resets_at not-a-date", gateError({
    headers: undefined,
    body: gateBody({ resets_at: "not-a-date", retry_after: undefined }),
  })],
  ["body resets_at in the past", gateError({
    headers: undefined,
    body: gateBody({ resets_at: iso(-HOUR), retry_after: undefined }),
  })],
  ["body retry_after 0", gateError({
    headers: undefined,
    body: gateBody({ resets_at: undefined, retry_after: 0 }),
  })],
  ["body retry_after -5", gateError({
    headers: undefined,
    body: gateBody({ resets_at: undefined, retry_after: -5 }),
  })],
  ["body retry_after abc", gateError({
    headers: undefined,
    body: gateBody({ resets_at: undefined, retry_after: "abc" }),
  })],
  ["header x-claude reset in the past", gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: { "x-claude-rate-limit-reset": iso(-HOUR) },
  })],
  ["header x-claude reset not-a-date", gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: { "x-claude-rate-limit-reset": "not-a-date" },
  })],
  ["header Retry-After 0", gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: { "Retry-After": "0" },
  })],
  ["header Retry-After -5", gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: { "Retry-After": "-5" },
  })],
  ["header Retry-After abc", gateError({
    body: gateBody({ resets_at: undefined, retry_after: undefined }),
    headers: { "Retry-After": "abc" },
  })],
];

for (const [name, error] of staleDeadlines) {
  test(`declines stale or invalid deadline: ${name}`, () => {
    resetClaudeSessionLimitCooldown();
    assertDeclined(gateEvent(error));
  });
}

test("weekly reset 7 days away is left to native policy", () => {
  resetClaudeSessionLimitCooldown();
  const week = 7 * 24 * HOUR;
  assertDeclined(gateEvent(gateError({
    body: gateBody({ resets_at: iso(week), retry_after: 604800 }),
    headers: { "Retry-After": "604800", "x-claude-rate-limit-reset": iso(week) },
  })));
});

test("2h reset exceeds a custom 30 minute maxWaitMs and is declined", () => {
  resetClaudeSessionLimitCooldown();
  assertDeclined(gateEvent(), { ...OPTIONS, maxWaitMs: 30 * 60 * 1000 });
});

test("2h reset fits a custom 3h maxWaitMs and sets retry", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent();
  assert.equal(applyClaudeSessionLimitRetryHook(event, { ...OPTIONS, maxWaitMs: 3 * HOUR }), true);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });
});

test("payload is not mutated by a positive decision", () => {
  resetClaudeSessionLimitCooldown();
  const event = gateEvent();
  const before = structuredClone(event.error);
  assert.equal(applyClaudeSessionLimitRetryHook(event, OPTIONS), true);
  assert.deepEqual(event.error, before);
});

test("later deadline wins across sessions and grace is applied once", () => {
  resetClaudeSessionLimitCooldown();
  const first = gateEvent(gateError({
    body: gateBody({ resets_at: iso(3 * HOUR), retry_after: 10800 }),
    headers: { "Retry-After": "10800", "x-claude-rate-limit-reset": iso(3 * HOUR) },
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(first, OPTIONS), true);
  assert.deepEqual(first.decision, { retry: true, delay: 3 * HOUR + GRACE });

  const second = gateEvent();
  second.sessionID = "ses_other";
  assert.equal(applyClaudeSessionLimitRetryHook(second, { nowMs: NOW + 1000, monotonicMs: MONO + 1000, staggerMs: 0 }), true);
  assert.deepEqual(second.decision, { retry: true, delay: 3 * HOUR + GRACE - 1000 });
});

test("expired cooldown does not influence a new event", () => {
  resetClaudeSessionLimitCooldown();
  assert.equal(applyClaudeSessionLimitRetryHook(gateEvent(), OPTIONS), true);

  const later = gateEvent(gateError({
    body: gateBody({ resets_at: iso(4 * HOUR), retry_after: 3600 }),
    headers: { "Retry-After": "3600", "x-claude-rate-limit-reset": iso(4 * HOUR) },
  }));
  assert.equal(applyClaudeSessionLimitRetryHook(later, { nowMs: NOW + 3 * HOUR, monotonicMs: MONO + 3 * HOUR, staggerMs: 0 }), true);
  assert.deepEqual(later.decision, { retry: true, delay: HOUR + GRACE });
});

const staggerCases: Array<[number, number]> = [[100, 100], [999, 250], [-5, 0]];

for (const [staggerMs, added] of staggerCases) {
  test(`staggerMs ${staggerMs} adds ${added} ms to the delay`, () => {
    resetClaudeSessionLimitCooldown();
    const event = gateEvent();
    assert.equal(applyClaudeSessionLimitRetryHook(event, { ...OPTIONS, staggerMs }), true);
    assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE + added });
  });
}

test("plugin id is claude-session-limit-retry", () => {
  assert.equal(ClaudeSessionLimitRetryPlugin.id, "claude-session-limit-retry");
});

test("plugin registers exactly one retry hook and cleanup disposes it once", async () => {
  resetClaudeSessionLimitCooldown();
  const names: string[] = [];
  const callbacks: Array<(event: unknown) => void> = [];
  let disposed = 0;
  const cleanup = await ClaudeSessionLimitRetryPlugin.setup({
    options: OPTIONS,
    session: {
      hook: async (name: string, callback: (event: unknown) => void) => {
        names.push(name);
        callbacks.push(callback);
        return { dispose: async () => { disposed += 1; } };
      },
    },
  });
  assert.deepEqual(names, ["retry"]);

  const event = gateEvent();
  callbacks[0](event);
  assert.deepEqual(event.decision, { retry: true, delay: 2 * HOUR + GRACE });

  await cleanup();
  await cleanup();
  assert.equal(disposed, 1);
});

test("plugin setup without session.hook resolves to a no-op cleanup", async () => {
  resetClaudeSessionLimitCooldown();
  const cleanup = await ClaudeSessionLimitRetryPlugin.setup({ options: OPTIONS });
  assert.equal(typeof cleanup, "function");
  await cleanup();
});

test("plugin callback swallows an event whose getter throws", async () => {
  resetClaudeSessionLimitCooldown();
  const callbacks: Array<(event: unknown) => void> = [];
  await ClaudeSessionLimitRetryPlugin.setup({
    options: OPTIONS,
    session: {
      hook: async (_name: string, callback: (event: unknown) => void) => {
        callbacks.push(callback);
        return { dispose: async () => {} };
      },
    },
  });
  const event = {};
  Object.defineProperty(event, "model", { get() { throw new Error("getter failure"); } });
  assert.doesNotThrow(() => callbacks[0](event));
});

test("classify accepts the exact upstream session-limit 429", () => {
  resetClaudeSessionLimitCooldown();
  assert.equal(classifyClaudeSessionLimitResponse({ status: 429, headers: gateHeaders(), body: gateBody() }), true);
});

test("parse returns the latest valid future deadline without grace", () => {
  resetClaudeSessionLimitCooldown();
  assert.equal(parseClaudeSessionLimitDeadline({ headers: gateHeaders(), body: gateBody() }, NOW), NOW + 2 * HOUR);
});

// Field-failure fixtures (2026-10-22)
const FIELD_NOW = Date.parse("2026-10-22T16:19:00.000Z");
const FIELD_OPTIONS: ClaudeSessionLimitRetryOptions = { nowMs: FIELD_NOW, monotonicMs: MONO, staggerMs: 0 };
const RESET = Date.parse("2026-10-22T18:50:00.000Z");
const FIELD_B_TEXT = "You've hit your session limit · resets 7:50am (Pacific/Auckland) · limit resets in 10m";
const INNER = JSON.stringify({
  type: "error",
  error: {
    type: "server_error",
    code: "server_error",
    message: "You've hit your session limit · resets 7:50am (Pacific/Auckland) · limit resets in 4h 2m (2026-10-22T18:50:00.000Z)",
  },
});
const BODY_A = JSON.stringify({ error: { message: INNER, type: "error", code: "claude_session_limit" } });
const BODY_B = JSON.stringify({
  error: { message: FIELD_B_TEXT, type: "rate_limit_error", code: "claude_session_limit", retry_after: 600 },
});

function fixtureA(): Record<string, unknown> {
  return { type: "provider.internal", status: 200, message: INNER, response: { body: BODY_A } };
}

function fixtureB(): Record<string, unknown> {
  return { type: "provider.rate-limit", status: 429, message: FIELD_B_TEXT, retryAfterMs: 600_000, response: { body: BODY_B } };
}

function fieldEvent(error: Record<string, unknown>, providerID: string = CLAUDE_PROVIDER_ID): RetryEvent {
  return {
    sessionID: "ses_test",
    agent: "build",
    attempt: 1,
    model: { providerID, id: "claude-sonnet-5-5" },
    error,
    decision: { retry: false },
  };
}

test("fixture A mid-stream class B sets retry from the text reset", () => {
  resetClaudeSessionLimitCooldown();
  const event = fieldEvent(fixtureA());
  assert.equal(applyClaudeSessionLimitRetryHook(event, FIELD_OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 9_120_000 });
});

test("fixture B 429 fallback uses the text reset, not the 600 s retry_after", () => {
  resetClaudeSessionLimitCooldown();
  const event = fieldEvent(fixtureB());
  assert.equal(applyClaudeSessionLimitRetryHook(event, FIELD_OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 9_120_000 });
});

test("class B without a text reset is declined", () => {
  resetClaudeSessionLimitCooldown();
  assertDeclined(fieldEvent({
    type: "provider.internal",
    status: 200,
    message: "You've hit your session limit",
    response: {
      body: JSON.stringify({ error: { message: "You've hit your session limit", type: "error", code: "claude_session_limit" } }),
    },
  }), FIELD_OPTIONS);
});

test("class B with only relative reset text is declined", () => {
  resetClaudeSessionLimitCooldown();
  const message = "You've hit your session limit · limit resets in 4h 2m";
  assertDeclined(fieldEvent({
    type: "provider.internal",
    status: 200,
    message,
    response: { body: JSON.stringify({ error: { message, type: "error", code: "claude_session_limit" } }) },
  }), FIELD_OPTIONS);
});

test("class B declines a rate_limit_error body at status 200", () => {
  resetClaudeSessionLimitCooldown();
  const error = fixtureA();
  error.response = {
    body: JSON.stringify({ error: { message: INNER, type: "rate_limit_error", code: "claude_session_limit" } }),
  };
  assertDeclined(fieldEvent(error), FIELD_OPTIONS);
});

test("class B declines a status 429 response even with error.type error", () => {
  resetClaudeSessionLimitCooldown();
  assertDeclined(fieldEvent({ ...fixtureA(), status: 429 }), FIELD_OPTIONS);
});

test("classifyClaudeSessionLimitMidStreamResponse accepts class B body only at a non-429 status", () => {
  resetClaudeSessionLimitCooldown();
  assert.equal(classifyClaudeSessionLimitMidStreamResponse({ status: 200, body: BODY_A }), true);
  assert.equal(classifyClaudeSessionLimitMidStreamResponse({ body: BODY_A }), true);
  assert.equal(classifyClaudeSessionLimitMidStreamResponse({ status: 429, body: BODY_A }), false);
});

test("class B declines a wrong provider", () => {
  resetClaudeSessionLimitCooldown();
  assertDeclined(fieldEvent(fixtureA(), "openai"), FIELD_OPTIONS);
});

test("provider.rate-limit at status 200 is declined", () => {
  resetClaudeSessionLimitCooldown();
  assertDeclined(fieldEvent({ ...fixtureA(), type: "provider.rate-limit" }), FIELD_OPTIONS);
});

const textDeadlineCases: Array<[string, string, string | undefined]> = [
  ["resets 7:50am (Pacific/Auckland)", "2026-10-22T16:19:00.000Z", "2026-10-22T18:50:00.000Z"],
  ["limit resets (2026-10-22T20:00:00.000Z)", "2026-10-22T16:19:00.000Z", "2026-10-22T20:00:00.000Z"],
  ["resets 5pm (UTC)", "2026-10-22T16:19:00.000Z", "2026-10-22T17:00:00.000Z"],
  ["resets 5pm (UTC)", "2026-10-22T18:00:00.000Z", "2026-10-23T17:00:00.000Z"],
  ["resets Oct 29, 1pm (UTC)", "2026-10-22T16:19:00.000Z", "2026-10-29T13:00:00.000Z"],
  ["resets Jan 2, 2027, 1pm (UTC)", "2026-10-22T16:19:00.000Z", "2027-01-02T13:00:00.000Z"],
  ["resets at 1am (America/New_York)", "2026-11-01T04:30:00.000Z", "2026-11-01T05:00:00.000Z"],
  ["resets 7:50am (Not/AZone)", "2026-10-22T16:19:00.000Z", undefined],
  ["limit resets in 10m", "2026-10-22T16:19:00.000Z", undefined],
  ["limit resets (2026-10-22T10:00:00.000Z)", "2026-10-22T16:19:00.000Z", undefined],
  ["resets 13pm (UTC)", "2026-10-22T16:19:00.000Z", undefined],
];

for (const [text, nowIso, expectedIso] of textDeadlineCases) {
  test(`text deadline "${text}" at ${nowIso}`, () => {
    resetClaudeSessionLimitCooldown();
    const expected = expectedIso === undefined ? undefined : Date.parse(expectedIso);
    assert.equal(parseClaudeSessionLimitTextDeadline({ texts: [text] }, Date.parse(nowIso)), expected);
  });
}

test("text reset beats the 600 s retry_after fallback", () => {
  resetClaudeSessionLimitCooldown();
  assert.equal(parseClaudeSessionLimitDeadline({ status: 429, body: BODY_B }, FIELD_NOW), RESET);
});

test("class A text reset beyond the 6 h cap is declined", () => {
  resetClaudeSessionLimitCooldown();
  const text = "You've hit your session limit · resets Oct 29, 1pm (UTC)";
  assertDeclined(fieldEvent({
    type: "provider.rate-limit",
    status: 429,
    message: text,
    response: {
      body: JSON.stringify({ error: { message: text, type: "rate_limit_error", code: "claude_session_limit", retry_after: 600 } }),
    },
  }), FIELD_OPTIONS);
});

test("fixture B exceeds a 1 s maxWaitMs and is declined", () => {
  resetClaudeSessionLimitCooldown();
  assertDeclined(fieldEvent(fixtureB()), { ...FIELD_OPTIONS, maxWaitMs: 1000 });
});

test("field fixtures leave the error payload unmutated", () => {
  for (const build of [fixtureA, fixtureB]) {
    resetClaudeSessionLimitCooldown();
    const error = build();
    const before = structuredClone(error);
    assert.equal(applyClaudeSessionLimitRetryHook(fieldEvent(error), FIELD_OPTIONS), true);
    assert.deepEqual(error, before);
  }
});

test("class B ignores an error.message over 64 KiB even with an ISO instant", () => {
  resetClaudeSessionLimitCooldown();
  const message = `${"x".repeat(70 * 1024)} 2026-10-22T18:50:00.000Z`;
  assertDeclined(fieldEvent({
    type: "provider.internal",
    status: 200,
    message,
    response: {
      body: JSON.stringify({ error: { message: "You've hit your session limit", type: "error", code: "claude_session_limit" } }),
    },
  }), FIELD_OPTIONS);
});

test("fixture B after fixture A shares the graced cooldown without a second grace", () => {
  resetClaudeSessionLimitCooldown();
  assert.equal(applyClaudeSessionLimitRetryHook(fieldEvent(fixtureA()), FIELD_OPTIONS), true);
  const event = fieldEvent(fixtureB());
  assert.equal(applyClaudeSessionLimitRetryHook(event, FIELD_OPTIONS), true);
  assert.deepEqual(event.decision, { retry: true, delay: 9_120_000 });
});
