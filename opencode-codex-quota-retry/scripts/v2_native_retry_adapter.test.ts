import assert from "node:assert/strict";
import { test } from "bun:test";
import Plugin from "../src/plugins/codex-quota-retry.ts";
import {
  CODEX_GENERATION_URL,
  CODEX_V2_CORRELATION_HEADER,
  consumeCodexV2CorrelationToken,
  issueCodexV2CorrelationToken,
  observeCodexQuotaRetryV2Event,
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

async function isolated<T>(run: (calls: Array<{ input: unknown; init: unknown; receiver: unknown; extra: unknown[] }>) => Promise<T>, respond?: (ordinal: number) => Response): Promise<T> {
  const global = globalThis as AnyGlobal;
  const keys = [REGISTRY, COOLDOWN, CANCELLATION, CORRELATION, V2_CANCELLATION, V2_WRAPPER, V2_OPTIONS, SETUP];
  const previous = keys.map((key) => global[key]);
  const fetch = globalThis.fetch;
  const calls: Array<{ input: unknown; init: unknown; receiver: unknown; extra: unknown[] }> = [];
  globalThis.fetch = (async function (input: unknown, init?: unknown, ...extra: unknown[]) {
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

async function setupContext(counters: { hooks: number; disposed: number; aborted: boolean }, options: Record<string, unknown> = {}, location?: { directory: string; workspaceID?: string }, plugin = Plugin) {
  let hookCallback: ((event: unknown) => void) | undefined;
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
      async hook(_name, callback) {
        counters.hooks++;
        hookCallback = callback;
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
  return { cleanup, callback: (event: unknown) => hookCallback?.(event), emit };
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
    assert.equal(counts.hooks, 1, "only one native hook is installed");
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
    assert.equal(counts.disposed, 1);
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
    assert.equal(firstCounts.hooks, 1);
    assert.equal(secondCounts.hooks, 1);
    first.cleanup();
    duplicate.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(firstCounts.disposed, 1);
    assert.equal(secondCounts.disposed, 0, "another location retains its own registration");
    secondLocation.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondCounts.disposed, 1);
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
        hook() {
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
