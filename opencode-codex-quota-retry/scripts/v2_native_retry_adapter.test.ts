import assert from "node:assert/strict";
import { test } from "bun:test";
import Plugin from "../src/plugins/codex-quota-retry.ts";
import {
  CODEX_GENERATION_URL,
  CODEX_V2_CORRELATION_HEADER,
  consumeCodexV2CorrelationToken,
  issueCodexV2CorrelationToken,
  observeCodexQuotaRetryV2Event,
  applyCodexQuotaRetryV2Hook,
} from "../src/lib/codex-quota-retry.ts";

const REGISTRY = Symbol.for("opencode.codex-quota-retry.fetch-wrapper");
const COOLDOWN = Symbol.for("opencode.codex-quota-retry.route-cooldown");
const CANCELLATION = Symbol.for("opencode.codex-quota-retry.cancellation-state");
const CORRELATION = Symbol.for("opencode.codex-quota-retry.v2-correlation");
const V2_CANCELLATION = Symbol.for("opencode.codex-quota-retry.v2-cancellation-markers");
const V2_WRAPPER = Symbol.for("opencode.codex-quota-retry.v2-fetch-wrapper");
const V2_OPTIONS = Symbol.for("opencode.codex-quota-retry.v2-options");
const SETUP = Symbol.for("opencode.codex-quota-retry.v2-plugin-setup");
type AnyGlobal = Record<PropertyKey, unknown>;

async function isolated<T>(run: (calls: Array<{ input: unknown; init: unknown; receiver: unknown; extra: unknown[] }>) => Promise<T>, respond?: (ordinal: number) => Response | Promise<Response>): Promise<T> {
  const global = globalThis as AnyGlobal;
  const keys = [REGISTRY, COOLDOWN, CANCELLATION, CORRELATION, V2_CANCELLATION, V2_WRAPPER, V2_OPTIONS, SETUP];
  const previous = keys.map((key) => global[key]);
  const fetch = globalThis.fetch;
  const calls: Array<{ input: unknown; init: unknown; receiver: unknown; extra: unknown[] }> = [];
  globalThis.fetch = (function (input: unknown, init?: unknown, ...extra: unknown[]) {
    calls.push({ input, init, receiver: this, extra });
    return respond?.(calls.length) ?? new Response("ok", { status: 200 });
  }) as typeof fetch;
  for (const key of keys) delete global[key];
  try {
    return await run(calls);
  } finally {
    const active = global[REGISTRY] as { original?: unknown; wrapper?: unknown } | undefined;
    if (active && globalThis.fetch === active.wrapper) globalThis.fetch = active.original as typeof fetch;
    globalThis.fetch = fetch;
    keys.forEach((key, index) => previous[index] === undefined ? delete global[key] : Object.defineProperty(global, key, {
      configurable: true, enumerable: false, writable: true, value: previous[index],
    }));
  }
}

function hook(sessionID: string, kind = "primary", request = new Request(CODEX_GENERATION_URL, {
  method: "POST", headers: { "x-session-id": "root-native-id", "session-id": "root-native-id" },
})): { sessionID: string; kind: string; request: Request } {
  return { sessionID, kind, request };
}

function quotaResponse(resetSeconds = 10, message?: string): Response {
  return new Response(JSON.stringify({ error: { type: "usage_limit_reached", ...(message === undefined ? {} : { message }), plan_type: "plus", resets_in_seconds: resetSeconds } }), { status: 429 });
}

function retryEvent(sessionID: string, type = "provider.quota") {
  return { sessionID, error: { type, message: "native retry summary", status: 429 }, attempt: 1, decision: { retry: false as boolean } };
}

async function setupContext(counters: { hooks: number; disposed: number; aborted: boolean }, options: Record<string, unknown> = {}, location?: { directory: string; workspaceID?: string }, plugin = Plugin) {
  const hookCallbacks = new Map<string, (event: unknown) => void>();
  const queue: unknown[] = [];
  let waiter: ((result: IteratorResult<unknown>) => void) | undefined;
  const emit = (event: unknown) => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve({ value: event, done: false });
    } else queue.push(event);
  };
  const setupResult = plugin.setup({
    options,
    location,
    session: {
      async hook(name, callback) {
        counters.hooks++;
        hookCallbacks.set(name, callback);
        return { async dispose() { counters.disposed++; } };
      },
    },
    event: {
      subscribe({ signal } = {}) {
        signal?.addEventListener("abort", () => {
          counters.aborted = true;
          if (waiter) {
            const resolve = waiter;
            waiter = undefined;
            resolve({ value: undefined, done: true });
          }
        }, { once: true });
        return { async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            const next = queue.length ? Promise.resolve({ value: queue.shift(), done: false } as IteratorResult<unknown>)
              : new Promise<IteratorResult<unknown>>((resolve) => { waiter = resolve; });
            const result = await next;
            if (result.done) return;
            yield result.value;
          }
        } };
      },
    },
  } as never);
  const cleanup = setupResult instanceof Promise ? await setupResult : setupResult;
  return { cleanup, callback: (event: unknown) => hookCallbacks.get("http.request")?.(event), retry: (event: unknown) => hookCallbacks.get("retry")?.(event), emit };
}

test("V2 entrypoint wraps before native fetch capture and setup options update that same early wrapper", async () => {
  await isolated(async (calls) => {
    const early = (await import(`../src/plugins/codex-quota-retry-v2.ts?early-load-${Date.now()}`)).default;
    const capturedFetch = globalThis.fetch;
    const registry = (globalThis as AnyGlobal)[REGISTRY] as { original?: unknown; wrapper?: unknown };
    assert.strictEqual(capturedFetch, registry.wrapper, "module evaluation installs the V2 wrapper before setup");
    assert.notEqual(capturedFetch, registry.original);
    assert.equal(globalThis.fetch, capturedFetch);
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, {
      nowMs: 1_700_000_000_000, monotonicMs: 100, fallbackMs: 123, staggerMs: 0,
    }, undefined, early);
    assert.equal(globalThis.fetch, capturedFetch, "setup configures rather than replaces the captured wrapper");
    const reimport = (await import(`../src/plugins/codex-quota-retry-v2.ts?early-reload-${Date.now()}`)).default;
    assert.strictEqual(reimport, early);
    const duplicate = await setupContext({ hooks: 0, disposed: 0, aborted: false }, {
      nowMs: 1_700_000_000_000, monotonicMs: 100, fallbackMs: 123, staggerMs: 0,
    }, undefined, reimport);
    assert.equal(globalThis.fetch, capturedFetch, "re-import and duplicate setup retain the configured early wrapper");
    const child = hook("early-child");
    api.callback(child);
    const adapted = await (capturedFetch as typeof fetch)(child.request);
    assert.equal(adapted.status, 429);
    assert.equal(adapted.headers.get("retry-after-ms"), "60123", "setup-time non-default fallback config applies to the early wrapper");
    assert.equal(calls.length, 1);
    const forwarded = calls[0]!.input as Request;
    assert.equal(forwarded.headers.has(CODEX_V2_CORRELATION_HEADER), false);
    assert.equal(forwarded.headers.get("x-session-id"), "root-native-id");
    await api.cleanup();
    await duplicate.cleanup();
  }, () => new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
    status: 429, headers: { "content-type": "application/json" },
  }));
});

test("V2 hook maps root, child, and sibling to exact session IDs, strips token, preserves native headers", async () => {
  await isolated(async (calls) => {
    const clocks = { wall: 1_800_000_000_000, mono: 10 };
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, {
      nowMs: () => clocks.wall, monotonicMs: () => clocks.mono, fallbackMs: 1_000, staggerMs: 0,
    });
    const root = hook("root-exact");
    const child = hook("child-exact");
    const sibling = hook("sibling-exact");
    api.callback(root);
    api.callback(child);
    api.callback(sibling);
    assert.ok(root.request.headers.has(CODEX_V2_CORRELATION_HEADER));
    assert.notEqual(root.request.headers.get(CODEX_V2_CORRELATION_HEADER), child.request.headers.get(CODEX_V2_CORRELATION_HEADER));
    assert.equal(child.request.headers.get("x-session-id"), "root-native-id");
    const wrapped = globalThis.fetch;
    const response = await wrapped(root.request);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    const forwarded = calls[0]!.input as Request;
    assert.equal(forwarded.headers.has(CODEX_V2_CORRELATION_HEADER), false);
    assert.equal(forwarded.headers.get("x-session-id"), "root-native-id");

    // A matching event pair must only mark the exact hook identity, not the
    // shared native root header used by child/sibling requests.
    assert.equal(observeCodexQuotaRetryV2Event({ type: "session.retry.scheduled", data: {
      sessionID: "root-exact", assistantMessageID: "msg-root", attempt: 1, at: clocks.wall + 10_000,
    } }, clocks.wall), false, "no quota retry exists for a successful root response");
    const childRetry = hook("child-exact");
    api.callback(childRetry);
    await (globalThis.fetch as typeof fetch)(childRetry.request);
    assert.equal(calls.length, 2);
    api.cleanup();
  });
});

test("V2 token map is unique, expiring, bounded, and consumes only valid issued tokens", () => {
  const a = issueCodexV2CorrelationToken("root", { nowMs: 1_000, maxPending: 2 })!;
  const b = issueCodexV2CorrelationToken("child", { nowMs: 1_000, maxPending: 2 })!;
  assert.notEqual(a, b);
  assert.equal(issueCodexV2CorrelationToken("sibling", { nowMs: 1_000, maxPending: 2 }), undefined);
  assert.equal(consumeCodexV2CorrelationToken("malformed", 1_001), undefined);
  assert.equal(consumeCodexV2CorrelationToken("00000000-0000-4000-8000-000000000000", 1_001), undefined);
  assert.equal(consumeCodexV2CorrelationToken(a, 1_002), "root");
  assert.equal(consumeCodexV2CorrelationToken(a, 1_003), undefined, "tokens are single-use");
  assert.equal(consumeCodexV2CorrelationToken(b, 31_001), undefined, "expired tokens are cleaned before lookup");
  assert.equal(consumeCodexV2CorrelationToken(a, 31_001), undefined);
});

test("V2 retry/interruption events suppress only the exact pending session and markers expire", async () => {
  await isolated(async (calls) => {
    let wall = 1_800_000_000_000;
    let mono = 10;
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { nowMs: () => wall, monotonicMs: () => mono, fallbackMs: 1_000, staggerMs: 0 });
    const request = hook("child-exact");
    api.callback(request);
    const quota = await (globalThis.fetch as typeof fetch)(request.request);
    assert.equal(quota.status, 429);
    api.emit({ type: "session.retry.scheduled", data: {
      sessionID: "child-exact", assistantMessageID: "msg", attempt: 1, at: wall + 62_000,
    } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(observeCodexQuotaRetryV2Event({ type: "session.retry.scheduled", data: {
      sessionID: "child-exact", assistantMessageID: "msg", attempt: 1, at: wall + 62_000,
    } }, wall), false, "plugin subscription consumed and deduplicated the native callback");
    api.emit({ type: "session.execution.interrupted", data: { sessionID: "child-exact", reason: "user" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(observeCodexQuotaRetryV2Event({ type: "session.retry.scheduled", data: {
      sessionID: "child-exact", assistantMessageID: "msg", attempt: 1, at: wall + 62_000,
    } }, wall), false, "replayed native schedule events are ignored");
    const canceled = hook("child-exact");
    api.callback(canceled);
    await assert.rejects((globalThis.fetch as typeof fetch)(canceled.request), { name: "AbortError" });
    assert.equal(calls.length, 1, "the exact canceled generation does not reach provider delegate");
    for (let attempt = 0; attempt < 2; attempt++) {
      const repeatedLateFetch = hook("child-exact");
      api.callback(repeatedLateFetch);
      await assert.rejects((globalThis.fetch as typeof fetch)(repeatedLateFetch.request), { name: "AbortError" });
      assert.equal(calls.length, 1, "cancellation marker remains active across repeated late fetches");
    }

    wall -= 500_000; // Deliberately move wall time backward while monotonic time advances.
    mono += 62_500; // Still before the scheduled retry deadline plus one-second grace.
    const beforeDeadline = hook("child-exact");
    api.callback(beforeDeadline);
    await assert.rejects((globalThis.fetch as typeof fetch)(beforeDeadline.request), { name: "AbortError" });
    assert.equal(calls.length, 1, "wall-clock rollback cannot extend or prematurely expire the marker");

    const sibling = hook("sibling-exact");
    api.callback(sibling);
    await (globalThis.fetch as typeof fetch)(sibling.request);
    assert.equal(calls.length, 2, "sibling with shared root headers remains eligible after shared cooldown");
    const root = hook("root-exact");
    api.callback(root);
    await (globalThis.fetch as typeof fetch)(root.request);
    assert.equal(calls.length, 3, "root session sharing the native header is not mistaken for the canceled child");
    mono += 1_000;
    const expiredChild = hook("child-exact");
    api.callback(expiredChild);
    await (globalThis.fetch as typeof fetch)(expiredChild.request);
    assert.equal(calls.length, 4, "marker expires at the native deadline plus grace by monotonic time");
    assert.equal(observeCodexQuotaRetryV2Event({ type: "session.execution.interrupted", data: {
      sessionID: "child-exact", reason: "user",
    } }, wall), false, "expired marker metadata is cleaned up");
    api.cleanup();
  }, (ordinal) => ordinal === 1
    ? new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), { status: 429, headers: { "content-type": "application/json" } })
    : new Response("ok", { status: 200 }));
});

test("V2 malformed tokens are stripped and never correlate from root session headers; auxiliary and other routes pass through", async () => {
  await isolated(async (calls) => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false });
    const aux = hook("child", "generate");
    api.callback(aux);
    assert.equal(aux.request.headers.has(CODEX_V2_CORRELATION_HEADER), false);
    await (globalThis.fetch as typeof fetch)(aux.request);
    assert.equal(calls[0]!.input, aux.request, "requests without a private header are not cloned");
    const malformed = new Request(CODEX_GENERATION_URL, { method: "POST", headers: {
      "x-session-id": "root-native-id", [CODEX_V2_CORRELATION_HEADER]: "not-a-token",
    } });
    await (globalThis.fetch as typeof fetch)(malformed);
    assert.equal(calls.length, 2);
    assert.equal((calls[1]!.input as Request).headers.has(CODEX_V2_CORRELATION_HEADER), false);
    const unknown = new Request(CODEX_GENERATION_URL, { method: "POST", headers: {
      "x-session-id": "root-native-id", [CODEX_V2_CORRELATION_HEADER]: "00000000-0000-4000-8000-000000000000",
    } });
    await (globalThis.fetch as typeof fetch)(unknown);
    assert.equal(calls.length, 3, "unknown token does not resolve the root native session ID");
    assert.equal((calls[2]!.input as Request).headers.has(CODEX_V2_CORRELATION_HEADER), false);
    const initToken = issueCodexV2CorrelationToken("init-session")!;
    const controller = new AbortController();
    const receiver = { label: "fetch receiver" };
    const requestInput = new Request(CODEX_GENERATION_URL, { method: "POST", headers: { "x-session-id": "original-root" }, body: "original payload" });
    const extra = { transportMetadata: true };
    const init = { method: "POST", headers: new Headers({
      "x-session-id": "root-native-id", [CODEX_V2_CORRELATION_HEADER]: initToken,
    }), body: "override payload", signal: controller.signal, cache: "no-store" as RequestCache };
    await (globalThis.fetch as typeof fetch).call(receiver, requestInput, init, extra);
    assert.equal(calls[3]!.input, requestInput, "Request input identity is retained when init headers carry the token");
    assert.equal(calls[3]!.receiver, receiver, "this binding is preserved");
    assert.deepEqual(calls[3]!.extra, [extra], "additional fetch arguments are preserved");
    const forwardedInit = calls[3]!.init as RequestInit;
    assert.equal(forwardedInit.body, "override payload");
    assert.equal(forwardedInit.signal, controller.signal);
    assert.equal(forwardedInit.cache, "no-store");
    assert.equal(new Headers(forwardedInit.headers).has(CODEX_V2_CORRELATION_HEADER), false);
    assert.equal(new Headers(forwardedInit.headers).get("x-session-id"), "root-native-id");
    const otherCodex = hook("child", "primary", new Request("https://chatgpt.com/other", { method: "POST" }));
    api.callback(otherCodex);
    assert.equal(otherCodex.request.headers.has(CODEX_V2_CORRELATION_HEADER), false);
    const other = "https://example.com/other";
    await (globalThis.fetch as typeof fetch)(other);
    assert.equal(calls.at(-1)!.input, other, "non-Codex arguments pass through untouched");
    api.cleanup();
  });
});

test("V2 preserves AbortSignal and duplicate setup cleanup disposes one hook/subscription", async () => {
  await isolated(async (calls) => {
    const counts = { hooks: 0, disposed: 0, aborted: false };
    const first = await setupContext(counts);
    const second = await setupContext(counts);
    assert.equal(counts.hooks, 2, "one HTTP correlation hook and one retry hook are installed");
    const controller = new AbortController();
    const req = hook("abort-session", "primary", new Request(CODEX_GENERATION_URL, {
      method: "POST", signal: controller.signal,
    }));
    first.callback(req);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects((globalThis.fetch as typeof fetch)(req.request), { name: "AbortError" });
    assert.equal(calls.length, 0, "aborted native signal prevents provider delegation");
    first.cleanup();
    assert.equal(counts.disposed, 0, "second installation retains shared hook");
    second.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(counts.disposed, 2);
    assert.equal(counts.aborted, true);
  });
});

test("V2 cleanup is isolated per plugin location", async () => {
  await isolated(async () => {
    const firstCounts = { hooks: 0, disposed: 0, aborted: false };
    const secondCounts = { hooks: 0, disposed: 0, aborted: false };
    const options = { fallbackMs: 555, nowMs: 1_700_000_000_000 };
    const first = await setupContext(firstCounts, options, { directory: "workspace-a" });
    const duplicate = await setupContext(firstCounts, options, { directory: "workspace-a" });
    const secondLocation = await setupContext(secondCounts, options, { directory: "workspace-b" });
    await assert.rejects(setupContext(secondCounts, { ...options, fallbackMs: 556 }, { directory: "workspace-c" }), /Conflicting Codex quota retry V2 options/);
    assert.equal(((globalThis as AnyGlobal)[V2_OPTIONS] as { options: { fallbackMs?: number } }).options.fallbackMs, 555,
      "a conflicting location cannot silently reset process-wide options");
    assert.equal(firstCounts.hooks, 2);
    assert.equal(secondCounts.hooks, 2);
    first.cleanup();
    duplicate.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(firstCounts.disposed, 2);
    assert.equal(secondCounts.disposed, 0, "another location retains its own registration");
    secondLocation.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondCounts.disposed, 2);
  });
});

test("V2 setup awaits delayed hook registration and cleanup awaits idempotent disposal/subscription finish", async () => {
  await isolated(async () => {
    let resolveRegistration!: (registration: { dispose: () => Promise<void> }) => void;
    let resolveDisposal!: () => void;
    let signal: AbortSignal | undefined;
    let subscriptionFinished = false;
    let setupFinished = false;
    const result = Plugin.setup({
      session: {
        hook(name: string) {
          if (name === "retry") return Promise.resolve({ dispose: async () => {} });
          return new Promise<{ dispose: () => Promise<void> }>((resolve) => { resolveRegistration = resolve; });
        },
      },
      event: {
        subscribe({ signal: inputSignal } = {}) {
          signal = inputSignal;
          return { async *[Symbol.asyncIterator]() {
            try {
              await new Promise<void>((resolve) => inputSignal?.addEventListener("abort", () => resolve(), { once: true }));
            } finally { subscriptionFinished = true; }
          } };
        },
      },
    } as never);
    assert.ok(result instanceof Promise, "real native hook setup is asynchronous");
    void result.then(() => { setupFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(setupFinished, false, "setup waits for native hook registration");
    resolveRegistration({ dispose: () => new Promise<void>((resolve) => { resolveDisposal = resolve; }) });
    const cleanup = await result;
    const firstCleanup = cleanup();
    const duplicateCleanup = cleanup();
    assert.strictEqual(firstCleanup, duplicateCleanup, "cleanup calls are idempotent and share completion");
    assert.equal(signal?.aborted, true, "abort is synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(subscriptionFinished, true);
    let cleanupFinished = false;
    void firstCleanup.then(() => { cleanupFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cleanupFinished, false, "cleanup waits for asynchronous hook disposal");
    resolveDisposal();
    await firstCleanup;
    assert.equal(cleanupFinished, true);
  });
});

test("V2 hook registration rejection aborts and removes its location setup record", async () => {
  await isolated(async () => {
    let signal: AbortSignal | undefined;
    const result = Plugin.setup({
      location: { directory: "rejecting-location" },
      session: { async hook() { throw new Error("registration failed"); } },
      event: {
        subscribe({ signal: inputSignal } = {}) {
          signal = inputSignal;
          return { async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => inputSignal?.addEventListener("abort", () => resolve(), { once: true }));
          } };
        },
      },
    } as never);
    assert.ok(result instanceof Promise);
    await assert.rejects(result, /registration failed/);
    assert.equal(signal?.aborted, true, "rejected registration aborts its event subscription");
    assert.equal((globalThis as AnyGlobal)[SETUP], undefined, "failed location is removed from shared setup registry");
  });
});

test("V2 retry hook overrides only exact quota proof and uses the remaining shared monotonic deadline", async () => {
  for (const [resetSeconds, expected] of [[18_000, 18_060_000], [5_460, 5_520_000]] as const) {
    await isolated(async (calls) => {
      const clock = { wall: 1_800_000_000_000, mono: 50 };
      const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, {
        nowMs: () => clock.wall, monotonicMs: () => clock.mono, staggerMs: 0,
      });
      const request = hook(`primary-${resetSeconds}`);
      api.callback(request);
      const before = JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_in_seconds: resetSeconds } });
      const response = await (globalThis.fetch as typeof fetch)(request.request);
      assert.equal(response.status, 429);
      assert.equal(await response.text(), before, "adaptation preserves the original response bytes");
      const event = { sessionID: `primary-${resetSeconds}`, error: { type: "provider.quota", message: "quota", status: 429 }, attempt: 1, decision: { retry: false as const } };
      api.retry(event);
      assert.deepEqual(event.decision, { retry: true, delay: expected });
      const secondUse = { ...event, decision: { retry: false as const } };
      api.retry(secondUse);
      assert.deepEqual(secondUse.decision, { retry: false }, "proof is consumed once");
      const unrelated = { sessionID: `primary-${resetSeconds}`, error: { type: "provider.rate-limit", message: "rate limited", status: 429 }, decision: { retry: false as const } };
      api.retry(unrelated);
      assert.deepEqual(unrelated.decision, { retry: false }, "native summary alone cannot establish proof");
      assert.equal(calls.length, 1);
      clock.mono += expected;
      clock.wall += expected;
      const resumed = hook(`primary-${resetSeconds}`);
      api.callback(resumed);
      assert.equal((await (globalThis.fetch as typeof fetch)(resumed.request)).status, 200,
        "fake-clock expiry allows exactly the original primary session to resume through fetch");
      assert.equal(calls.length, 2, "one provider call is made on resume, without an adapter retry loop");
      await api.cleanup();
    }, (ordinal) => ordinal === 1
      ? new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_in_seconds: resetSeconds } }), { status: 429, headers: { "content-type": "application/json" } })
      : new Response("ok", { status: 200 }));
  }
});

test("V2 real quota classification accepts message variants and missing messages; RateLimit summary needs exact proof", async () => {
  for (const message of ["A changed quota message", undefined]) {
    await isolated(async () => {
      const clock = { wall: 1_800_000_000_000, mono: 10 };
      const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, {
        nowMs: () => clock.wall, monotonicMs: () => clock.mono, staggerMs: 0,
      });
      const request = hook(`variant-${message ?? "missing"}`);
      api.callback(request);
      const response = await (globalThis.fetch as typeof fetch)(request.request);
      assert.equal(response.status, 429);
      const event = { sessionID: `variant-${message ?? "missing"}`, error: { type: "provider.rate-limit", message: "summary", status: 429 }, decision: { retry: false as const } };
      api.retry(event);
      assert.deepEqual(event.decision, { retry: true, delay: 61_000 });
      await api.cleanup();
    }, () => new Response(JSON.stringify({ error: { type: "usage_limit_reached", ...(message === undefined ? {} : { message }), plan_type: "plus", resets_in_seconds: 1 } }), { status: 429 }));
  }
});

test("V2 per-request leases fail closed for overlapping same-session fetches in either completion order", async () => {
  for (const reverse of [false, true]) {
    const deferred: Array<(response: Response) => void> = [];
    await isolated(async (calls) => {
      const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { staggerMs: 0 });
      const a = hook("overlap-session");
      const b = hook("overlap-session");
      api.callback(a); api.callback(b);
      const fetch = globalThis.fetch as typeof globalThis.fetch;
      const pa = fetch(a.request);
      const pb = fetch(b.request);
      assert.equal(calls.length, 2);
      deferred[reverse ? 1 : 0]!(quotaResponse());
      await Promise.resolve();
      deferred[reverse ? 0 : 1]!(quotaResponse());
      await Promise.all([pa, pb]);
      const summary = retryEvent("overlap-session");
      api.retry(summary);
      assert.deepEqual(summary.decision, { retry: false }, "ambiguous same-session generations never receive quota proof");
      await api.cleanup();
    }, () => new Promise<Response>((resolve) => deferred.push(resolve)));
  }
});

test("V2 leases finalize on synchronous throw, rejected delegate, and cleanup during pending fetch", async () => {
  let resolvePending!: (response: Response) => void;
  await isolated(async (calls) => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false });
    const sync = hook("sync-throw"); api.callback(sync);
    assert.equal(sync.request.headers.has(CODEX_V2_CORRELATION_HEADER), true);
    const state = (globalThis as AnyGlobal)[CORRELATION] as { leases: Map<number, unknown> };
    assert.ok(state);
    assert.throws(() => (globalThis.fetch as typeof fetch)(sync.request), /sync delegate failure/);
    assert.equal(state.leases.size, 0);
    const rejected = hook("async-reject"); api.callback(rejected);
    await assert.rejects((globalThis.fetch as typeof fetch)(rejected.request), /async delegate failure/);
    assert.equal(state.leases.size, 0);

    const pending = hook("cleanup-pending"); api.callback(pending);
    const pendingFetch = (globalThis.fetch as typeof fetch)(pending.request);
    assert.equal(state.leases.size, 1);
    await api.cleanup();
    resolvePending(quotaResponse());
    await pendingFetch;
    const summary = retryEvent("cleanup-pending");
    api.retry(summary);
    assert.deepEqual(summary.decision, { retry: false }, "cleanup invalidates pending leases before a late quota result");
    assert.equal(calls.length, 3);
  }, (ordinal) => {
    if (ordinal === 1) throw new Error("sync delegate failure");
    if (ordinal === 2) return Promise.reject(new Error("async delegate failure"));
    return new Promise<Response>((accept) => { resolvePending = accept; });
  });
});

test("V2 post-response attempt abort retains proof; interruption and TTL still invalidate it", async () => {
  let resolvePending!: (response: Response) => void;
  await isolated(async () => {
    const clock = { wall: 1_800_000_000_000, mono: 10 };
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { nowMs: () => clock.wall, monotonicMs: () => clock.mono, staggerMs: 0 });
    const controller = new AbortController();
    const aborted = hook("abort-proof", "primary", new Request(CODEX_GENERATION_URL, { method: "POST", signal: controller.signal }));
    api.callback(aborted);
    await (globalThis.fetch as typeof fetch)(aborted.request);
    controller.abort();
    const abortRetry = retryEvent("abort-proof"); api.retry(abortRetry);
    assert.deepEqual(abortRetry.decision, { retry: true, delay: 18_060_000 }, "completed quota proof survives native per-attempt signal disposal");

    const interruptedAfterResponse = hook("interrupted-after-response"); api.callback(interruptedAfterResponse);
    delete (globalThis as AnyGlobal)[COOLDOWN];
    await (globalThis.fetch as typeof fetch)(interruptedAfterResponse.request);
    api.emit({ type: "session.execution.interrupted", data: { sessionID: "interrupted-after-response", reason: "user" } });
    await new Promise((done) => setTimeout(done, 0));
    const interruptedAfterResponseRetry = retryEvent("interrupted-after-response"); api.retry(interruptedAfterResponseRetry);
    assert.deepEqual(interruptedAfterResponseRetry.decision, { retry: false }, "native interruption after response explicitly clears the proof");

    const interrupted = hook("interrupted-pending"); api.callback(interrupted);
    delete (globalThis as AnyGlobal)[COOLDOWN];
    const pending = (globalThis.fetch as typeof fetch)(interrupted.request);
    api.emit({ type: "session.execution.interrupted", data: { sessionID: "interrupted-pending", reason: "user" } });
    await new Promise((done) => setTimeout(done, 0));
    resolvePending(quotaResponse());
    await pending;
    delete (globalThis as AnyGlobal)[COOLDOWN];
    const interruptedRetry = retryEvent("interrupted-pending"); api.retry(interruptedRetry);
    assert.deepEqual(interruptedRetry.decision, { retry: false }, "interruption before body completion cannot resurrect proof");

    const stale = hook("stale-proof"); api.callback(stale);
    await (globalThis.fetch as typeof fetch)(stale.request);
    clock.mono += 30_001;
    const staleRetry = retryEvent("stale-proof"); api.retry(staleRetry);
    assert.deepEqual(staleRetry.decision, { retry: false }, "proof expires on monotonic time");
    await api.cleanup();
  }, (ordinal) => ordinal === 1 || ordinal === 2 || ordinal === 4 ? quotaResponse(18_000) : new Promise<Response>((accept) => { resolvePending = accept; }));
});

test("V2 signal abort during cloned body read releases lease and creates no proof", async () => {
  await isolated(async () => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false });
    const controller = new AbortController();
    const request = hook("abort-read", "primary", new Request(CODEX_GENERATION_URL, { method: "POST", signal: controller.signal }));
    api.callback(request);
    const pending = (globalThis.fetch as typeof fetch)(request.request);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(pending, { name: "AbortError" });
    const summary = retryEvent("abort-read"); api.retry(summary);
    assert.deepEqual(summary.decision, { retry: false });
    await api.cleanup();
  }, () => new Response(new ReadableStream({ pull() {} }), { status: 429 }));
});

test("V2 reused native correlation token invalidates prior proof; bounded lease capacity fails closed", async () => {
  await isolated(async (calls) => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { staggerMs: 0 });
    const first = hook("token-share-session"); api.callback(first);
    const sharedToken = first.request.headers.get(CODEX_V2_CORRELATION_HEADER)!;
    await (globalThis.fetch as typeof fetch)(first.request);
    const duplicate = new Request(CODEX_GENERATION_URL, { method: "POST", headers: { [CODEX_V2_CORRELATION_HEADER]: sharedToken } });
    await (globalThis.fetch as typeof fetch)(duplicate);
    const retry = retryEvent("token-share-session"); api.retry(retry);
    assert.deepEqual(retry.decision, { retry: false }, "reused native token cannot consume old session proof");
    await api.cleanup();
    assert.equal(calls.length, 1, "duplicate token request is answered locally during shared cooldown");
  }, (ordinal) => ordinal === 1 ? quotaResponse() : new Response("ok", { status: 200 }));

  const deferred: Array<(response: Response) => void> = [];
  await isolated(async (calls) => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false });
    const pending: Array<Promise<Response>> = [];
    for (let index = 0; index < 64; index++) {
      const request = hook(`capacity-${index}`); api.callback(request);
      pending.push((globalThis.fetch as typeof fetch)(request.request));
    }
    const state = (globalThis as AnyGlobal)[CORRELATION] as { leases: Map<number, unknown> };
    assert.equal(state.leases.size, 64, "active primary leases are bounded");
    const overflow = hook("capacity-overflow"); api.callback(overflow);
    assert.equal(overflow.request.headers.has(CODEX_V2_CORRELATION_HEADER), true, "bounded lease capacity is checked after token correlation");
    assert.equal((await (globalThis.fetch as typeof fetch)(overflow.request)).status, 200);
    assert.equal(state.leases.size, 64, "overflow request cannot add a lease or proof");
    for (const resolve of deferred) resolve(new Response("ok", { status: 200 }));
    await Promise.all(pending);
    await api.cleanup();
    assert.equal(calls.length, 65);
  }, (ordinal) => ordinal <= 64 ? new Promise<Response>((resolve) => deferred.push(resolve)) : new Response("ok", { status: 200 }));
});

test("V2 false or missing retry summary cannot override, and native attempt remains untouched", async () => {
  await isolated(async () => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { staggerMs: 0 });
    const request = hook("summary-shapes"); api.callback(request);
    await (globalThis.fetch as typeof fetch)(request.request);
    const staleTag = retryEvent("summary-shapes", "provider.quota-exceeded"); api.retry(staleTag);
    assert.deepEqual(staleTag.decision, { retry: false }, "public retry type is provider.quota, not the guessed provider.quota-exceeded alias");
    const missing = { sessionID: "summary-shapes", decision: { retry: false as boolean } };
    api.retry(missing);
    assert.deepEqual(missing.decision, { retry: false });
    const invalid = { sessionID: "summary-shapes", error: { type: "provider.authentication", message: "not quota", status: 401 }, decision: { retry: false as boolean } };
    api.retry(invalid);
    assert.deepEqual(invalid.decision, { retry: false });
    const quota = { ...retryEvent("summary-shapes"), attempt: 3 };
    api.retry(quota);
    assert.deepEqual(quota.decision, { retry: false }, "non-quota summary invalidates the proof");
    assert.equal(quota.attempt, 3, "the native finite attempt counter is unchanged (fixture-only contract)");
    await api.cleanup();
  }, () => quotaResponse());
});

test("V2 subscription-sharing rejection is unchanged and cannot create or reuse quota proof", async () => {
  const sharingBody = JSON.stringify({ error: {
    code: "subscription_sharing_usage_limit_exceeded",
    type: "subscription_sharing_usage_limit_exceeded",
    message: "Subscription sharing usage limit exceeded",
  } });
  await isolated(async (calls) => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { staggerMs: 0 });

    const sharingWithoutProof = hook("sharing-no-proof"); api.callback(sharingWithoutProof);
    const firstRejected = await (globalThis.fetch as typeof fetch)(sharingWithoutProof.request);
    assert.equal(firstRejected.status, 429);
    assert.equal(await firstRejected.text(), sharingBody, "classifier passes through the exact subscription-sharing body");
    assert.equal((globalThis as AnyGlobal)[COOLDOWN], undefined, "sharing rejection does not establish quota cooldown");
    const summaryWithoutProof = retryEvent("sharing-no-proof");
    summaryWithoutProof.error.message = "subscription_sharing_usage_limit_exceeded";
    api.retry(summaryWithoutProof);
    assert.deepEqual(summaryWithoutProof.decision, { retry: false }, "provider.quota summary cannot override without exact positively-classified proof");

    const positive = hook("sharing-next-primary"); api.callback(positive);
    const positiveResponse = await (globalThis.fetch as typeof fetch)(positive.request);
    assert.equal(positiveResponse.status, 429);
    const state = (globalThis as AnyGlobal)[CORRELATION] as { retryProofs: Map<string, unknown> };
    assert.equal(state.retryProofs.has("sharing-next-primary"), true, "positive quota response establishes exact proof");

    // Force the next matching primary request through to the delegate rather
    // than receiving a synthetic cooldown response; the native hook itself
    // must retire the prior proof before the sharing rejection is observed.
    delete (globalThis as AnyGlobal)[COOLDOWN];
    const nextPrimary = hook("sharing-next-primary"); api.callback(nextPrimary);
    const nextRejected = await (globalThis.fetch as typeof fetch)(nextPrimary.request);
    assert.equal(nextRejected.status, 429);
    assert.equal(await nextRejected.text(), sharingBody, "same-session sharing rejection body remains unchanged");
    assert.equal((globalThis as AnyGlobal)[COOLDOWN], undefined, "same-session sharing rejection creates no new cooldown");
    const staleSummary = retryEvent("sharing-next-primary");
    staleSummary.error.message = "subscription_sharing_usage_limit_exceeded";
    api.retry(staleSummary);
    assert.deepEqual(staleSummary.decision, { retry: false }, "next exact primary hook prevents reuse of the earlier quota proof");
    assert.equal(calls.length, 3, "both sharing rejections reach the ordinary fetch delegate");
    await api.cleanup();
  }, (ordinal) => ordinal === 2 ? quotaResponse() : new Response(sharingBody, { status: 429, headers: { "content-type": "application/json" } }));
});

test("V2 auxiliary and unknown-token fetches do not invalidate unrelated primary proof", async () => {
  await isolated(async () => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { staggerMs: 0 });
    const request = hook("primary-proof"); api.callback(request);
    await (globalThis.fetch as typeof fetch)(request.request);
    const auxiliary = hook("primary-proof", "generate"); api.callback(auxiliary);
    await (globalThis.fetch as typeof fetch)(auxiliary.request);
    const unknown = new Request(CODEX_GENERATION_URL, { method: "POST", headers: { [CODEX_V2_CORRELATION_HEADER]: "malformed" } });
    await (globalThis.fetch as typeof fetch)(unknown);
    const retry = retryEvent("primary-proof", "provider.rate-limit"); api.retry(retry);
    assert.deepEqual(retry.decision, { retry: true, delay: 70_000 }, "uncorrelated fetches do not guess or erase another session's evidence");
    await api.cleanup();
  }, (ordinal) => ordinal === 1 ? quotaResponse() : new Response("ok", { status: 200 }));
});

test("V2 exact primary hook invalidates its old proof even when new token issuance hits capacity", async () => {
  await isolated(async () => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { maxPendingQuotaRetries: 1, staggerMs: 0 });
    const primary = hook("primary-capacity-proof"); api.callback(primary);
    await (globalThis.fetch as typeof fetch)(primary.request);
    const occupying = hook("pending-token-owner"); api.callback(occupying);
    assert.equal(occupying.request.headers.has(CODEX_V2_CORRELATION_HEADER), true);
    const next = hook("primary-capacity-proof"); api.callback(next);
    assert.equal(next.request.headers.has(CODEX_V2_CORRELATION_HEADER), false, "pending token capacity fails closed");
    await (globalThis.fetch as typeof fetch)(next.request);
    const retry = retryEvent("primary-capacity-proof"); api.retry(retry);
    assert.deepEqual(retry.decision, { retry: false }, "authoritative primary hook cleared its proof before token allocation failed");
    await api.cleanup();
  }, () => quotaResponse());
});

test("V2 matching nonquota fetch invalidates only its proof; sibling proof survives", async () => {
  await isolated(async () => {
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { staggerMs: 0 });
    const primary = hook("proof-primary"); api.callback(primary);
    await (globalThis.fetch as typeof fetch)(primary.request);
    const primaryRetry = retryEvent("proof-primary"); api.retry(primaryRetry);
    assert.equal(primaryRetry.decision.retry, true, "consume initial primary proof before sibling synthetic quota");
    const sibling = hook("proof-sibling"); api.callback(sibling);
    await (globalThis.fetch as typeof fetch)(sibling.request);
    const primaryAgain = hook("proof-primary"); api.callback(primaryAgain);
    const siblingRetry = retryEvent("proof-sibling", "provider.rate-limit"); api.retry(siblingRetry);
    assert.deepEqual(siblingRetry.decision, { retry: true, delay: 120_000 }, "unrelated sibling fetch leaves its proof intact");
    delete (globalThis as AnyGlobal)[COOLDOWN];
    await (globalThis.fetch as typeof fetch)(primaryAgain.request);
    const stale = retryEvent("proof-primary"); api.retry(stale);
    assert.deepEqual(stale.decision, { retry: false }, "same-session next fetch invalidates the previous proof");
    await api.cleanup();
  }, (ordinal) => ordinal === 1 ? quotaResponse(60) : new Response("ok", { status: 200 }));
});

test("V2 synthetic cooldown proof, renewed quota extension, and monotonic remainder survive wall-clock jumps", async () => {
  await isolated(async () => {
    const clock = { wall: 1_800_000_000_000, mono: 100 };
    const api = await setupContext({ hooks: 0, disposed: 0, aborted: false }, { nowMs: () => clock.wall, monotonicMs: () => clock.mono, staggerMs: 0 });
    const first = hook("renew-primary"); api.callback(first);
    await (globalThis.fetch as typeof fetch)(first.request);
    const firstRetry = retryEvent("renew-primary"); api.retry(firstRetry);
    assert.equal(firstRetry.decision.delay, 120_000, "reset plus exactly one 60-second grace");

    clock.mono += 30_000;
    clock.wall += 5 * 24 * 60 * 60 * 1000;
    const sibling = hook("renew-sibling"); api.callback(sibling);
    const synthetic = await (globalThis.fetch as typeof fetch)(sibling.request);
    assert.equal(synthetic.status, 429);
    const syntheticRetry = retryEvent("renew-sibling", "provider.rate-limit"); api.retry(syntheticRetry);
    assert.equal(syntheticRetry.decision.delay, 90_000, "remaining cooldown follows monotonic time, not wall clock");
    assert.equal(synthetic.headers.has("x-should-retry"), false);

    clock.mono += 90_001;
    clock.wall += 90_001;
    const renewed = hook("renew-primary"); api.callback(renewed);
    const response = await (globalThis.fetch as typeof fetch)(renewed.request);
    assert.equal(response.status, 429);
    const renewedRetry = retryEvent("renew-primary"); api.retry(renewedRetry);
    assert.equal(renewedRetry.decision.delay, 180_000, "later positively classified quota renews the shared cooldown");
    assert.equal(renewedRetry.attempt, 1, "adapter preserves native attempt budget state");
    await api.cleanup();
  }, (ordinal) => ordinal === 1 ? quotaResponse(60) : quotaResponse(120));
});
