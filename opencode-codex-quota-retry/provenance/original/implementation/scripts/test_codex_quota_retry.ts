import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";

import CodexQuotaRetryPlugin from "../.opencode/plugins/codex-quota-retry.ts";
import {
  CODEX_GENERATION_URL,
  CODEX_ERROR_BODY_MAX_BYTES,
  CODEX_ERROR_BODY_TIMEOUT_MS,
  CODEX_NATIVE_TIMER_MAX_MS,
  CODEX_NATIVE_STAGGER_MAX_MS,
  CODEX_QUOTA_FALLBACK_MS,
  CODEX_QUOTA_GRACE_MS,
  CODEX_CANCELLATION_MARKER_GRACE_MS,
  CODEX_MAX_PENDING_QUOTA_RETRIES,
  buildCodexNativeRetryHeaders,
  classifyCodexQuotaResponse,
  createCodexQuotaRetryCancellationState,
  installCodexQuotaRetryFetch,
  isCodexGenerationRequest,
  observeCodexQuotaRetrySessionStatus,
  parseCodexQuotaDeadline,
  readVerifiedCodexSessionID,
  readBoundedCodexQuotaErrorBody,
} from "../.opencode/lib/codex-quota-retry.ts";

const REGISTRY_SYMBOL = Symbol.for("opencode.codex-quota-retry.fetch-wrapper");
const COOLDOWN_SYMBOL = Symbol.for("opencode.codex-quota-retry.route-cooldown");
const CANCELLATION_SYMBOL = Symbol.for("opencode.codex-quota-retry.cancellation-state");
type AnyFetch = (...args: any[]) => any;

function snapshotRegistry(): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[REGISTRY_SYMBOL];
}

function restoreRegistry(value: unknown): void {
  if (value === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[REGISTRY_SYMBOL];
    return;
  }
  Object.defineProperty(globalThis, REGISTRY_SYMBOL, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
}

function snapshotCooldown(): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[COOLDOWN_SYMBOL];
}

function restoreCooldown(value: unknown): void {
  if (value === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[COOLDOWN_SYMBOL];
    return;
  }
  Object.defineProperty(globalThis, COOLDOWN_SYMBOL, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
}

function snapshotCancellationState(): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[CANCELLATION_SYMBOL];
}

function restoreCancellationState(value: unknown): void {
  if (value === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[CANCELLATION_SYMBOL];
    return;
  }
  Object.defineProperty(globalThis, CANCELLATION_SYMBOL, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
}

async function withMockFetch<T>(mock: AnyFetch, callback: () => Promise<T> | T): Promise<T> {
  const previousFetch = (globalThis as { fetch?: unknown }).fetch;
  const previousRegistry = snapshotRegistry();
  const previousCooldown = snapshotCooldown();
  const previousCancellationState = snapshotCancellationState();
  delete (globalThis as Record<PropertyKey, unknown>)[REGISTRY_SYMBOL];
  (globalThis as { fetch?: unknown }).fetch = mock;

  try {
    return await callback();
  } finally {
    const active = snapshotRegistry() as { wrapper?: unknown; original?: unknown } | undefined;
    if (active && (globalThis as { fetch?: unknown }).fetch === active.wrapper) {
      (globalThis as { fetch?: unknown }).fetch = active.original;
    }
    restoreRegistry(previousRegistry);
    restoreCooldown(previousCooldown);
    restoreCancellationState(previousCancellationState);
    (globalThis as { fetch?: unknown }).fetch = previousFetch;
  }
}

function testExactRouteMatching(): void {
  const exactRequest = new Request(CODEX_GENERATION_URL, { method: "POST" });
  assert.equal(isCodexGenerationRequest(CODEX_GENERATION_URL, { method: "POST" }), true);
  assert.equal(isCodexGenerationRequest(new URL(CODEX_GENERATION_URL), { method: "POST" }), true);
  assert.equal(isCodexGenerationRequest(exactRequest), true);
  assert.equal(isCodexGenerationRequest(exactRequest, { method: "POST" }), true);

  assert.equal(isCodexGenerationRequest(CODEX_GENERATION_URL, { method: "GET" }), false);
  assert.equal(isCodexGenerationRequest("http://chatgpt.com/backend-api/codex/responses", { method: "POST" }), false);
  assert.equal(isCodexGenerationRequest("https://api.chatgpt.com/backend-api/codex/responses", { method: "POST" }), false);
  assert.equal(isCodexGenerationRequest("https://chatgpt.com:444/backend-api/codex/responses", { method: "POST" }), false);
  assert.equal(isCodexGenerationRequest("https://user:pass@chatgpt.com/backend-api/codex/responses", { method: "POST" }), false);
  assert.equal(isCodexGenerationRequest("https://chatgpt.com/backend-api/codex/responses/extra", { method: "POST" }), false);
  assert.equal(isCodexGenerationRequest("ws://chatgpt.com/backend-api/codex/responses", { method: "POST" }), false);
  assert.equal(isCodexGenerationRequest("https://chatgpt.com/backend-api/codex/responses", { method: "PUT" }), false);
}

async function testRequestAndResponseIdentity(): Promise<void> {
  const calls: Array<{ receiver: unknown; input: unknown; init: unknown }> = [];
  const response = { kind: "response" };
  const receiver = { kind: "receiver" };
  const mock = function (this: unknown, input: unknown, init: unknown): unknown {
    calls.push({ init, input, receiver: this });
    return response;
  } as AnyFetch;

  await withMockFetch(mock, async () => {
    const installation = installCodexQuotaRetryFetch();
    const request = new Request(CODEX_GENERATION_URL, { method: "POST" });
    const init = { method: "POST", headers: { "x-test": "untouched" } };
    const result = await (globalThis.fetch as AnyFetch).call(receiver, request, init);

    assert.equal(installation.installed, true);
    assert.equal(result, response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.receiver, receiver);
    assert.equal(calls[0]?.input, request);
    assert.equal(calls[0]?.init, init);
  });
}

async function testFetchHelperPropertiesAndChain(): Promise<void> {
  const helper = function helper(): string {
    return "helper";
  };
  const chainMarker = { name: "existing-wrapper" };
  const mock = function (): string {
    return "ok";
  } as AnyFetch;
  Object.defineProperty(mock, "helper", {
    configurable: false,
    enumerable: false,
    value: helper,
    writable: false,
  });
  Object.defineProperty(mock, "chainMarker", {
    configurable: true,
    enumerable: true,
    value: chainMarker,
    writable: true,
  });

  await withMockFetch(mock, async () => {
    const installation = installCodexQuotaRetryFetch();
    const wrapper = installation.wrapper;
    const helperDescriptor = Object.getOwnPropertyDescriptor(wrapper, "helper");
    const markerDescriptor = Object.getOwnPropertyDescriptor(wrapper, "chainMarker");

    assert.equal(wrapper.helper, helper);
    assert.deepEqual(helperDescriptor, Object.getOwnPropertyDescriptor(mock, "helper"));
    assert.deepEqual(markerDescriptor, Object.getOwnPropertyDescriptor(mock, "chainMarker"));
    assert.equal((wrapper as AnyFetch)(), "ok");
  });
}

async function testIdempotentCrossCopyInstall(): Promise<void> {
  const mock = (() => "ok") as AnyFetch;
  await withMockFetch(mock, async () => {
    const first = installCodexQuotaRetryFetch();
    const secondCopy = await import("../.opencode/lib/codex-quota-retry.ts?transport-contract-copy");
    const second = secondCopy.installCodexQuotaRetryFetch();

    assert.equal(first.installed, true);
    assert.equal(second.installed, false);
    assert.equal(second.wrapper, first.wrapper);
    assert.equal(globalThis.fetch, first.wrapper);

    const pluginHooks = await CodexQuotaRetryPlugin({} as never, {
      fallbackHours: 5,
      fallbackMs: 123,
      nowMs: 1_700_000_000_000,
      monotonicMs: 10_000,
      staggerMs: 0,
    });
    assert.equal(typeof pluginHooks.event, "function");
    await pluginHooks.event?.({ event: { type: "session.status", properties: {
      sessionID: "ses_no_pending", status: { type: "idle" },
    } } } as never);
    assert.equal(globalThis.fetch, first.wrapper);
  });
}

async function testPluginEntrypointExportContract(): Promise<void> {
  const pluginSource = readFileSync(
    new URL("../.opencode/plugins/codex-quota-retry.ts", import.meta.url),
    "utf8",
  );
  const pluginModule = await import("../.opencode/plugins/codex-quota-retry.ts?entrypoint-export-contract");

  assert.deepEqual(Object.keys(pluginModule), ["default"]);
  assert.equal(typeof pluginModule.default, "function");
  assert.doesNotMatch(pluginSource, /export\s+(?:async\s+)?function/);
  assert.doesNotMatch(pluginSource, /OPENAI_API_KEY|process\.env|authorization/i);
}

async function runTransportContract(): Promise<void> {
  testExactRouteMatching();
  await testRequestAndResponseIdentity();
  await testFetchHelperPropertiesAndChain();
  await testIdempotentCrossCopyInstall();
  await testPluginEntrypointExportContract();
  console.log("[PASS] Codex quota retry transport contract");
}

function quotaResponse(body: unknown, headers: Record<string, string> = {}): {
  status: number;
  headers: Record<string, string>;
  body: unknown;
} {
  return { status: 429, headers, body };
}

function testPositiveQuotaClassifier(): void {
  assert.equal(classifyCodexQuotaResponse(quotaResponse({ error: { type: "usage_limit_reached" } })), true);
  assert.equal(classifyCodexQuotaResponse(quotaResponse({ error: { type: "rate_limit" } })), false);
  assert.equal(classifyCodexQuotaResponse({ status: 401, body: { error: { type: "usage_limit_reached" } } }), false);
  assert.equal(classifyCodexQuotaResponse(429, { error: { type: "usage_limit_reached" } }), true);
}

function testDeadlinePriorityAndNormalization(): void {
  const nowMs = 1_700_000_000_000;
  const result = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_at: Math.floor((nowMs + 90_000) / 1000),
    resets_in_seconds: 120,
  }, {
    "retry-after": "60",
    "retry-after-ms": "180000",
  }), { nowMs });

  assert.ok(result);
  assert.equal(result.source, "retry-after-ms");
  assert.equal(result.deadlineMs, nowMs + 180_000 + CODEX_QUOTA_GRACE_MS);

  const millis = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_at: nowMs + 240_000,
  }), { nowMs });
  assert.ok(millis);
  assert.equal(millis.deadlineMs, nowMs + 240_000 + CODEX_QUOTA_GRACE_MS);

  const seconds = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_at: Math.floor((nowMs + 300_000) / 1000),
  }), { nowMs });
  assert.ok(seconds);
  assert.equal(seconds.source, "resets_at");
  assert.equal(seconds.deadlineMs, nowMs + 300_000 + CODEX_QUOTA_GRACE_MS);

  const offset = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_at: "2023-11-14T22:18:20+00:00",
  }), { nowMs });
  assert.ok(offset);
  assert.equal(offset.source, "resets_at");
  assert.equal(offset.deadlineMs, nowMs + 300_000 + CODEX_QUOTA_GRACE_MS);
}

function testDateAndTextDeadlineRules(): void {
  const nowMs = Date.parse("2030-01-01T00:00:00Z");
  const httpDate = "Tue, 01 Jan 2030 00:10:00 GMT";
  const parsed = parseCodexQuotaDeadline(quotaResponse({ error: { type: "usage_limit_reached" } }, {
    "retry-after": httpDate,
  }), { nowMs });
  assert.ok(parsed);
  assert.equal(parsed.source, "retry-after");

  const explicitText = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    message: "quota resets at 2030-01-01T00:20:00+00:00",
  }), { nowMs });
  assert.ok(explicitText);
  assert.equal(explicitText.source, "text");

  const timezoneFreeText = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    message: "quota resets at 2030-01-01T00:20:00",
  }), { nowMs });
  assert.ok(timezoneFreeText);
  assert.equal(timezoneFreeText.source, "fallback");
}

function testStaleInvalidAndPositiveFallbackRules(): void {
  const nowMs = 1_700_000_000_000;
  const stale = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_at: nowMs - 1,
    resets_in_seconds: 0,
  }), { nowMs, fallbackMs: 30_000 });
  assert.ok(stale);
  assert.equal(stale.source, "fallback");
  assert.equal(stale.deadlineMs, nowMs + 30_000 + CODEX_QUOTA_GRACE_MS);

  const defaultFallback = parseCodexQuotaDeadline(quotaResponse({ error: { type: "usage_limit_reached" } }), { nowMs });
  assert.ok(defaultFallback);
  assert.equal(defaultFallback.deadlineMs, nowMs + CODEX_QUOTA_FALLBACK_MS + CODEX_QUOTA_GRACE_MS);
  assert.equal(parseCodexQuotaDeadline(quotaResponse({ error: { type: "other" } }), { nowMs }), undefined);

  const injectedClock = parseCodexQuotaDeadline(
    quotaResponse({ error: { type: "usage_limit_reached" }, resets_in_seconds: 10 }),
    { nowMs: () => nowMs },
  );
  assert.ok(injectedClock);
  assert.equal(injectedClock.deadlineMs, nowMs + 10_000 + CODEX_QUOTA_GRACE_MS);

  const hugeEpoch = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_at: 1e100,
  }), { nowMs, fallbackMs: 30_000 });
  assert.ok(hugeEpoch);
  assert.equal(hugeEpoch.source, "fallback");

  const impossibleIso = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_at: "2027-02-30T00:00:00Z",
  }), { nowMs, fallbackMs: 30_000 });
  assert.ok(impossibleIso);
  assert.equal(impossibleIso.source, "fallback");

  const overflowingDuration = parseCodexQuotaDeadline(quotaResponse({
    error: { type: "usage_limit_reached" },
    resets_in_seconds: 1e100,
  }), { nowMs, fallbackMs: 30_000 });
  assert.ok(overflowingDuration);
  assert.equal(overflowingDuration.source, "fallback");
}

function runParser(): void {
  testPositiveQuotaClassifier();
  testDeadlinePriorityAndNormalization();
  testDateAndTextDeadlineRules();
  testStaleInvalidAndPositiveFallbackRules();
  console.log("[PASS] Codex quota retry parser");
}

function jsonResponse(body: unknown, status = 429): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function testBoundedNativeErrorBodyReader(): Promise<void> {
  const quotaResponse = jsonResponse({ error: { type: "rate_limit" } });
  const parsed = await readBoundedCodexQuotaErrorBody(quotaResponse);
  assert.equal(parsed.status, "parsed");
  assert.deepEqual(parsed.body, { error: { type: "rate_limit" } });
  assert.equal(await quotaResponse.text(), JSON.stringify({ error: { type: "rate_limit" } }));

  const malformedResponse = new Response("{not-json", { status: 429 });
  const malformed = await readBoundedCodexQuotaErrorBody(malformedResponse);
  assert.equal(malformed.status, "malformed");
  assert.equal(await malformedResponse.text(), "{not-json");

  const oversizedBody = JSON.stringify({ message: "x".repeat(CODEX_ERROR_BODY_MAX_BYTES) });
  const oversizedResponse = new Response(oversizedBody, { status: 429 });
  const oversized = await readBoundedCodexQuotaErrorBody(oversizedResponse);
  assert.equal(oversized.status, "oversized");
  assert.equal(oversized.body, undefined);
  assert.ok(oversized.bytesRead > CODEX_ERROR_BODY_MAX_BYTES);
  assert.equal(await oversizedResponse.text(), oversizedBody);

  const stalledResponse = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    pull() {
      return new Promise<void>(() => undefined);
    },
  }), { status: 429 });
  const stalled = await readBoundedCodexQuotaErrorBody(stalledResponse, {
    timeoutMs: Math.min(25, CODEX_ERROR_BODY_TIMEOUT_MS),
  });
  assert.equal(stalled.status, "timeout");
  assert.equal(stalled.body, undefined);

  const abortController = new AbortController();
  const abortedResponse = new Response(new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
  }), { status: 429 });
  const abortedRead = readBoundedCodexQuotaErrorBody(abortedResponse, {
    timeoutMs: CODEX_ERROR_BODY_TIMEOUT_MS,
    signal: abortController.signal,
  });
  abortController.abort(new DOMException("cancelled", "AbortError"));
  const aborted = await abortedRead;
  assert.equal(aborted.status, "cancelled");
}

async function testNonEligibleNativeResponsesAreNotReadOrAdapted(): Promise<void> {
  for (const status of [401, 400, 500]) {
    const response = jsonResponse({ error: { type: "usage_limit_reached" } }, status);
    const result = await readBoundedCodexQuotaErrorBody(response);
    assert.equal(result.status, "not-eligible");
    assert.equal(await response.text(), JSON.stringify({ error: { type: "usage_limit_reached" } }));
  }

  const nonQuota429 = jsonResponse({ error: { type: "unknown_429" } }, 429);
  const nonQuotaResult = await readBoundedCodexQuotaErrorBody(nonQuota429);
  assert.equal(nonQuotaResult.status, "parsed");
  assert.equal(classifyCodexQuotaResponse({ status: 429, body: nonQuotaResult.body }), false);
  assert.equal(await nonQuota429.text(), JSON.stringify({ error: { type: "unknown_429" } }));
}

async function testPassThroughResponseIdentityAndRejections(): Promise<void> {
  const responseCases: Array<{ label: string; input: unknown; init?: unknown; response: Response }> = [
    {
      label: "authentication",
      input: CODEX_GENERATION_URL,
      init: { method: "POST" },
      response: jsonResponse({ error: { type: "authentication_error" } }, 401),
    },
    {
      label: "invalid request",
      input: CODEX_GENERATION_URL,
      init: { method: "POST" },
      response: jsonResponse({ error: { type: "invalid_request_error" } }, 400),
    },
    {
      label: "server",
      input: CODEX_GENERATION_URL,
      init: { method: "POST" },
      response: jsonResponse({ error: { type: "server_error" } }, 500),
    },
    {
      label: "unknown 429",
      input: CODEX_GENERATION_URL,
      init: { method: "POST" },
      response: jsonResponse({ error: { type: "rate_limit" } }, 429),
    },
    {
      label: "non-Codex provider",
      input: "https://api.openai.com/v1/responses",
      init: { method: "POST" },
      response: jsonResponse({ error: { type: "usage_limit_reached" } }, 429),
    },
    {
      label: "non-generation request",
      input: "https://chatgpt.com/backend-api/codex/metadata",
      init: { method: "POST" },
      response: jsonResponse({ error: { type: "usage_limit_reached" } }, 429),
    },
    {
      label: "WebSocket transport",
      input: "ws://chatgpt.com/backend-api/codex/responses",
      init: { method: "POST" },
      response: jsonResponse({ error: { type: "usage_limit_reached" } }, 429),
    },
  ];

  for (const testCase of responseCases) {
    await withMockFetch(() => testCase.response, async () => {
      installCodexQuotaRetryFetch();
      const result = await (globalThis.fetch as AnyFetch)(testCase.input, testCase.init);
      assert.equal(result, testCase.response, `${testCase.label} response identity`);
    });
  }

  const nonProvableInput = { method: "POST", kind: "websocket" };
  assert.equal(isCodexGenerationRequest(nonProvableInput, { method: "POST" }), false);

  const networkError = new Error("network failure");
  await withMockFetch(() => Promise.reject(networkError), async () => {
    installCodexQuotaRetryFetch();
    await assert.rejects(
      (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" }),
      (error: unknown) => error === networkError,
    );
  });

  const cancellation = new DOMException("cancelled", "AbortError");
  const controller = new AbortController();
  controller.abort(cancellation);
  let preabortedCalls = 0;
  await withMockFetch((input: unknown, init: unknown) => {
    preabortedCalls += 1;
    assert.equal((init as RequestInit).signal, controller.signal);
    return Promise.resolve(new Response("unexpected", { status: 200 }));
  }, async () => {
    installCodexQuotaRetryFetch();
    await assert.rejects(
      (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST", signal: controller.signal }),
      (error: unknown) => error === cancellation,
    );
  });
  assert.equal(preabortedCalls, 0, "cold pre-aborted request must not be delegated");
}

async function testNativeSignalPrecedenceAndCloneCancellation(): Promise<void> {
  const requestController = new AbortController();
  const initController = new AbortController();
  const request = new Request(CODEX_GENERATION_URL, {
    method: "POST",
    signal: requestController.signal,
  });
  const response = new Response("ok", { status: 200 });
  let calls = 0;

  await withMockFetch((input: unknown, init: unknown) => {
    calls += 1;
    assert.equal(input, request);
    assert.equal((init as RequestInit).signal, initController.signal);
    return response;
  }, async () => {
    installCodexQuotaRetryFetch();
    assert.equal(
      await (globalThis.fetch as AnyFetch)(request, {
        method: "POST",
        signal: initController.signal,
      }),
      response,
    );
    assert.equal(calls, 1);
  });

  const overriddenController = new AbortController();
  const overriddenReason = new Error("request signal must be overridden by null");
  overriddenController.abort(overriddenReason);
  const overriddenRequest = new Request(CODEX_GENERATION_URL, {
    method: "POST",
    signal: overriddenController.signal,
  });
  let nullOverrideCalls = 0;
  await withMockFetch((input: unknown, init: unknown) => {
    nullOverrideCalls += 1;
    assert.equal(input, overriddenRequest);
    assert.equal((init as RequestInit).signal, null);
    return response;
  }, async () => {
    installCodexQuotaRetryFetch();
    assert.equal(
      await (globalThis.fetch as AnyFetch)(overriddenRequest, {
        method: "POST",
        signal: null,
      }),
      response,
    );
    assert.equal(nullOverrideCalls, 1);
  });

  const cloneController = new AbortController();
  const cloneReason = new Error("cancelled while cloning quota response");
  const quota = jsonResponse({ error: { type: "usage_limit_reached" } });
  const originalClone = quota.clone.bind(quota);
  Object.defineProperty(quota, "clone", {
    configurable: true,
    value: (): Response => {
      cloneController.abort(cloneReason);
      return originalClone();
    },
  });

  await withMockFetch(() => quota, async () => {
    installCodexQuotaRetryFetch({ nowMs: 1_700_000_000_000, monotonicMs: 1_000 });
    await assert.rejects(
      (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, {
        method: "POST",
        signal: cloneController.signal,
      }),
      (error: unknown) => error === cloneReason,
    );
  });
}

async function testSuccessfulSseRemainsConsumable(): Promise<void> {
  const sseBody = "data: {\"id\":\"generation-1\"}\n\n";
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseBody));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  await withMockFetch(() => response, async () => {
    installCodexQuotaRetryFetch();
    const result = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(result, response);
    assert.equal(await result.text(), sseBody);
  });
}

async function runPassthrough(): Promise<void> {
  await testBoundedNativeErrorBodyReader();
  await testNonEligibleNativeResponsesAreNotReadOrAdapted();
  await testPassThroughResponseIdentityAndRejections();
  await testNativeSignalPrecedenceAndCloneCancellation();
  await testSuccessfulSseRemainsConsumable();
  console.log("[PASS] Codex quota retry pass-through and bounded error body");
}

async function testNativeResponseHeadersAndBodyPreservation(): Promise<void> {
  const nowMs = Date.parse("2030-01-01T00:00:00Z");
  const resetMs = nowMs + (4.5 * 60 * 60 * 1000);
  const responseBody = JSON.stringify({
    error: { type: "usage_limit_reached" },
    resets_at: resetMs,
  });
  let originalResponse: Response | undefined;
  let sourceBodyFinished = false;
  let clockReads = 0;

  await withMockFetch(() => {
    originalResponse = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(responseBody));
        controller.close();
        sourceBodyFinished = true;
      },
    }), {
      status: 429,
      statusText: "Quota Exhausted",
      headers: {
        "content-type": "application/json",
        "retry-after-ms": "1",
        "retry-after": "1",
      },
    });
    return Promise.resolve(originalResponse);
  }, async () => {
    installCodexQuotaRetryFetch({
      nowMs: () => {
        clockReads += 1;
        assert.equal(sourceBodyFinished, true, "remaining deadline must be sampled after body read");
        return nowMs;
      },
      monotonicMs: () => 0,
      staggerMs: 0,
    });
    const result = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.ok(originalResponse);
    assert.ok(clockReads > 0);
    assert.notEqual(result, originalResponse);
    assert.equal(result.status, 429);
    assert.equal(result.statusText, "Quota Exhausted");
    assert.equal(result.headers.get("retry-after-ms"), "16260000");
    assert.equal(result.headers.get("retry-after"), "16260");
    assert.equal(await result.text(), responseBody);

    // Reading the bounded clone must not consume the native response stream.
    assert.equal(await originalResponse.text(), responseBody);
  });
}

function testNativeHeaderConflictAndTimerCap(): void {
  const nowMs = 1_700_000_000_000;
  const normalized = {
    deadlineMs: nowMs + 60 * 60 * 1000,
    source: "resets_at",
    usedFallback: false,
  };
  const laterExistingHint = buildCodexNativeRetryHeaders(normalized, {
    nowMs,
    existingHeaders: {
      "retry-after-ms": String(2 * 60 * 60 * 1000),
      "retry-after": "1",
    },
  });
  assert.ok(laterExistingHint);
  assert.equal(laterExistingHint.nativeDelayMs, 2 * 60 * 60 * 1000);
  assert.equal(laterExistingHint.retryAfterMs, "7200000");
  assert.equal(laterExistingHint.retryAfter, "7200");
  assert.equal(laterExistingHint.nativeDelayCapped, false);

  const capped = buildCodexNativeRetryHeaders({
    ...normalized,
    deadlineMs: nowMs + CODEX_NATIVE_TIMER_MAX_MS + 1000,
  }, { nowMs });
  assert.ok(capped);
  assert.equal(capped.nativeDelayMs, CODEX_NATIVE_TIMER_MAX_MS);
  assert.equal(capped.retryAfterMs, String(CODEX_NATIVE_TIMER_MAX_MS));
  assert.equal(capped.retryAfter, "2147484");
  assert.equal(capped.nativeDelayCapped, true);
  assert.equal(capped.remainingDeadlineMs, CODEX_NATIVE_TIMER_MAX_MS + 1000);
}

function testNativePolicySourceContractNotInstalledLiveProof(): void {
  const helperSource = readFileSync(new URL("../.opencode/lib/codex-quota-retry.ts", import.meta.url), "utf8");
  const nativePolicyFixture = {
    label: "OpenCode 1.19.0 native policy fixture; not installed-live proof",
    maxRetries: 5,
    statusField: "nextRetryAt",
  };

  assert.equal(nativePolicyFixture.maxRetries, 5);
  assert.equal(nativePolicyFixture.statusField, "nextRetryAt");
  assert.match(helperSource, /retry-after-ms/);
  assert.match(helperSource, /retry-after/);
  assert.match(helperSource, /CODEX_NATIVE_TIMER_MAX_MS/);
  assert.doesNotMatch(helperSource, /EMPTY_RESPONSE_RETRY_LIMIT/);
  assert.doesNotMatch(helperSource, /retryAttempt|retryCounter|replacementRetry/);
  assert.doesNotMatch(helperSource, /await\s+new\s+Promise/);
  assert.doesNotMatch(helperSource, /setTimeout\([^\n]*(?:CODEX_QUOTA|CODEX_NATIVE)/);
}

async function runNativePolicy(): Promise<void> {
  await testNativeResponseHeadersAndBodyPreservation();
  testNativeHeaderConflictAndTimerCap();
  testNativePolicySourceContractNotInstalledLiveProof();
  console.log("[PASS] Codex native retry header policy (fixture/source contract; no installed-live proof)");
}

function quotaHttpResponse(resetsInSeconds: number): Response {
  return jsonResponse({
    error: { type: "usage_limit_reached" },
    resets_in_seconds: resetsInSeconds,
  });
}

async function testSharedCooldownSkipsProviderUntilBoundary(): Promise<void> {
  let wallMs = 1_700_000_000_000;
  let monotonicMs = 10_000;
  let originalCalls = 0;

  await withMockFetch(() => {
    originalCalls += 1;
    return originalCalls === 1 ? quotaHttpResponse(10) : new Response("ok", { status: 200 });
  }, async () => {
    const firstInstallation = installCodexQuotaRetryFetch({
      nowMs: () => wallMs,
      monotonicMs: () => monotonicMs,
      random: () => 0.1,
    });
    const secondCopy = await import("../.opencode/lib/codex-quota-retry.ts?cooldown-copy");
    const secondInstallation = secondCopy.installCodexQuotaRetryFetch();
    assert.equal(secondInstallation.installed, false, "duplicate project copy must reuse the process wrapper");
    assert.equal(secondInstallation.wrapper, firstInstallation.wrapper);

    const first = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(first.status, 429);
    const initialRetryAfterMs = first.headers.get("retry-after-ms");
    const immediateSynthetic = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(immediateSynthetic.status, 429);
    assert.equal(
      immediateSynthetic.headers.get("retry-after-ms"),
      initialRetryAfterMs,
      "initial native retry must match the shared monotonic cooldown",
    );

    monotonicMs += 70_000;
    const duringCooldown = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(duringCooldown.status, 429);
    assert.equal(originalCalls, 1, "known cooldown must not delegate to the provider");
    assert.deepEqual(await duringCooldown.json(), { error: { type: "usage_limit_reached" } });
    assert.equal(duringCooldown.headers.get("retry-after-ms"), "25");
    assert.equal(duringCooldown.headers.get("retry-after"), "1");

    monotonicMs += 25;
    const atBoundary = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(atBoundary.status, 200);
    assert.equal(originalCalls, 2);
    assert.ok(CODEX_NATIVE_STAGGER_MAX_MS >= 25);
    void wallMs;
  });
}

async function testRenewedQuotaWinsEarlierConcurrentResponse(): Promise<void> {
  let wallMs = 1_700_000_000_000;
  let monotonicMs = 20_000;
  let originalCalls = 0;
  const pending: Array<(response: Response) => void> = [];

  await withMockFetch(() => {
    originalCalls += 1;
    return new Promise<Response>((resolve) => pending.push(resolve));
  }, async () => {
    installCodexQuotaRetryFetch({
      nowMs: () => wallMs,
      monotonicMs: () => monotonicMs,
      staggerMs: 0,
    });

    const later = (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    const earlier = (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(originalCalls, 2);
    assert.equal(pending.length, 2);

    pending[0]?.(quotaHttpResponse(30));
    await later;
    pending[1]?.(quotaHttpResponse(10));
    await earlier;

    monotonicMs += 70_000;
    const stillCooling = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(stillCooling.status, 429);
    assert.equal(originalCalls, 2, "an earlier concurrent response must not shorten cooldown");
    void wallMs;
  });
}

async function testCooldownRouteIsolationAndCancellation(): Promise<void> {
  let monotonicMs = 30_000;
  let originalCalls = 0;

  await withMockFetch(() => {
    originalCalls += 1;
    return originalCalls === 1
      ? quotaHttpResponse(60 * 60 * 5)
      : new Response("ok", { status: 200 });
  }, async () => {
    installCodexQuotaRetryFetch({ monotonicMs: () => monotonicMs, staggerMs: 0 });
    await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });

    const metadata = await (globalThis.fetch as AnyFetch)(
      "https://chatgpt.com/backend-api/codex/metadata",
      { method: "POST" },
    );
    assert.equal(metadata.status, 200);
    assert.equal(originalCalls, 2, "cooldown is isolated to the exact generation route");

    const controller = new AbortController();
    const cancellation = new DOMException("cancelled", "AbortError");
    controller.abort(cancellation);
    await assert.rejects(
      (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, {
        method: "POST",
        signal: controller.signal,
      }),
      (error: unknown) => error === cancellation,
    );
    assert.equal(originalCalls, 2, "cancelled synthetic attempt must not reach the provider");

    const stillCooling = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(stillCooling.status, 429, "cancellation must not clear shared cooldown");
    const retryAfterMs = Number(stillCooling.headers.get("retry-after-ms"));
    assert.ok(Number.isFinite(retryAfterMs));
    assert.ok(retryAfterMs <= CODEX_NATIVE_TIMER_MAX_MS);
    void monotonicMs;
  });
}

async function testWallClockJumpsDoNotMoveMonotonicBoundary(): Promise<void> {
  let wallMs = 1_700_000_000_000;
  let monotonicMs = 40_000;
  let originalCalls = 0;

  await withMockFetch(() => {
    originalCalls += 1;
    return originalCalls === 1 ? quotaHttpResponse(10) : new Response("ok", { status: 200 });
  }, async () => {
    installCodexQuotaRetryFetch({
      nowMs: () => wallMs,
      monotonicMs: () => monotonicMs,
      staggerMs: 0,
    });
    await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });

    wallMs -= 5 * 60 * 60 * 1000;
    monotonicMs += 1_000;
    assert.equal(
      (await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" })).status,
      429,
    );
    wallMs += 10 * 60 * 60 * 1000;
    monotonicMs += 1_000;
    assert.equal(
      (await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" })).status,
      429,
    );
    assert.equal(originalCalls, 1);

    monotonicMs += 69_000;
    assert.equal(
      (await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" })).status,
      200,
    );
    assert.equal(originalCalls, 2);
  });
}

async function testExpiredCooldownCanRearmAfterBackwardWallClockJump(): Promise<void> {
  let wallMs = 1_700_000_000_000;
  let monotonicMs = 50_000;
  let originalCalls = 0;

  await withMockFetch(() => {
    originalCalls += 1;
    return quotaHttpResponse(originalCalls === 1 ? 1 : 10);
  }, async () => {
    installCodexQuotaRetryFetch({
      nowMs: () => wallMs,
      monotonicMs: () => monotonicMs,
      staggerMs: 0,
    });
    await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });

    monotonicMs += 61_001;
    wallMs -= 2 * 60 * 60 * 1000;
    const renewed = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(renewed.status, 429);
    assert.equal(originalCalls, 2, "expired cooldown must permit one renewed provider response");

    const duringRenewedCooldown = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(duringRenewedCooldown.status, 429);
    assert.equal(originalCalls, 2, "renewed cooldown must suppress repeated provider calls");
  });
}

async function runCooldown(): Promise<void> {
  await testSharedCooldownSkipsProviderUntilBoundary();
  await testRenewedQuotaWinsEarlierConcurrentResponse();
  await testCooldownRouteIsolationAndCancellation();
  await testWallClockJumpsDoNotMoveMonotonicBoundary();
  await testExpiredCooldownCanRearmAfterBackwardWallClockJump();
  console.log("[PASS] Codex shared route cooldown");
}

class FakeClock {
  wallMs: number;
  monotonicMs: number;

  constructor(wallMs: number, monotonicMs: number) {
    this.wallMs = wallMs;
    this.monotonicMs = monotonicMs;
  }

  advance(milliseconds: number): void {
    assert.ok(Number.isFinite(milliseconds) && milliseconds >= 0);
    this.wallMs += milliseconds;
    this.monotonicMs += milliseconds;
  }
}

interface NativeWaitFixtureState {
  parent: {
    generationId: string;
    model: string;
    agent: string;
    status: "waitingTask" | "completed";
    continuationPrompts: number;
    childDelegations: number;
  };
  child: {
    generationId: string;
    model: string;
    agent: string;
    status: "retry_wait" | "idle" | "completed";
  };
  assignedChildGenerationId: string;
  taskToolResultId: string;
  appliedToolResultIds: Set<string>;
  sideEffects: number;
}

function createNativeWaitFixture(): NativeWaitFixtureState {
  return {
    parent: {
      generationId: "sol-parent-generation-1",
      model: "openai/gpt-6.1-sol",
      agent: "primary",
      status: "waitingTask",
      continuationPrompts: 0,
      childDelegations: 1,
    },
    child: {
      generationId: "luna-child-generation-1",
      model: "openai/gpt-6-luna",
       agent: "general",
      status: "retry_wait",
    },
    assignedChildGenerationId: "luna-child-generation-1",
    taskToolResultId: "task-tool-result-1",
    appliedToolResultIds: new Set<string>(),
    sideEffects: 0,
  };
}

function reconcileNativeChildAssignment(state: NativeWaitFixtureState): void {
  // Source-contract fixture only: retry_wait and idle both retain the same
  // native child identity and therefore do not create a new delegation.
  if (state.child.generationId !== state.assignedChildGenerationId) {
    state.parent.childDelegations += 1;
    state.assignedChildGenerationId = state.child.generationId;
  }
}

function applyTaskToolResultOnce(state: NativeWaitFixtureState, resultId: string): void {
  if (state.appliedToolResultIds.has(resultId)) {
    return;
  }
  state.appliedToolResultIds.add(resultId);
  state.sideEffects += 1;
}

async function testFakeClockNativeChildWait(): Promise<void> {
  const fixture = {
    label: "OpenCode native scheduler and goal lifecycle source-contract fixture; not installed-live proof",
    sourceContracts: ["design.md:69-75", "spec.md:138-155"],
    installedLiveProof: false,
  };
  assert.equal(fixture.installedLiveProof, false);
  assert.deepEqual(fixture.sourceContracts, ["design.md:69-75", "spec.md:138-155"]);

  const fourAndHalfHoursMs = 4.5 * 60 * 60 * 1000;
  const oneHourChildCeilingMs = 60 * 60 * 1000;
  const clock = new FakeClock(1_700_000_000_000, 100_000);
  const state = createNativeWaitFixture();
  let providerCalls = 0;

  await withMockFetch(() => {
    providerCalls += 1;
    return providerCalls === 1
      ? quotaHttpResponse(4.5 * 60 * 60)
      : new Response("resumed", { status: 200 });
  }, async () => {
    installCodexQuotaRetryFetch({
      nowMs: () => clock.wallMs,
      monotonicMs: () => clock.monotonicMs,
      staggerMs: 0,
    });

    const initial = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(initial.status, 429);
    assert.equal(providerCalls, 1);

    const cancelledController = new AbortController();
    const cancellationReason = new Error("cancelled native child wait");
    cancelledController.abort(cancellationReason);
    await assert.rejects(
      (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, {
        method: "POST",
        signal: cancelledController.signal,
      }),
      (error: unknown) => error === cancellationReason,
    );
    const cooldownAfterCancellation = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(cooldownAfterCancellation.status, 429, "native cancellation must not clear the shared cooldown");
    assert.equal(providerCalls, 1, "cancelled cooldown request must not reach the provider");

    let elapsedMs = 0;
    while (elapsedMs < fourAndHalfHoursMs) {
      const stepMs = Math.min(oneHourChildCeilingMs, fourAndHalfHoursMs - elapsedMs);
      clock.advance(stepMs);
      elapsedMs += stepMs;
      assert.equal(state.parent.status, "waitingTask");
      assert.equal(state.child.status, "retry_wait");
      assert.equal(state.parent.continuationPrompts, 0);
      reconcileNativeChildAssignment(state);
      const retry = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
      assert.equal(retry.status, 429);
      assert.equal(providerCalls, 1, "native child wait must not duplicate provider work");
    }

    assert.equal(elapsedMs, fourAndHalfHoursMs);
    assert.equal(state.parent.childDelegations, 1);
    assert.equal(state.assignedChildGenerationId, state.child.generationId);
    assert.equal(state.parent.generationId, "sol-parent-generation-1");
    assert.equal(state.parent.model, "openai/gpt-6.1-sol");
    assert.equal(state.parent.agent, "primary");
    assert.equal(state.child.generationId, "luna-child-generation-1");
    assert.equal(state.child.model, "openai/gpt-6-luna");
     assert.equal(state.child.agent, "general");
    assert.equal(state.sideEffects, 0);

    // An idle observation of the same child is also not a duplicate assignment.
    state.child.status = "idle";
    reconcileNativeChildAssignment(state);
    assert.equal(state.parent.childDelegations, 1);
    state.child.status = "completed";

    clock.advance(CODEX_QUOTA_GRACE_MS);
    const resumed = await (globalThis.fetch as AnyFetch)(CODEX_GENERATION_URL, { method: "POST" });
    assert.equal(resumed.status, 200);
    assert.equal(providerCalls, 2);
    applyTaskToolResultOnce(state, state.taskToolResultId);
    applyTaskToolResultOnce(state, state.taskToolResultId);
    assert.equal(state.appliedToolResultIds.size, 1);
    assert.equal(state.sideEffects, 1);
    assert.equal(state.parent.continuationPrompts, 0);
  });
}

async function runFakeClock(): Promise<void> {
  await testNativeSignalPrecedenceAndCloneCancellation();
  await testFakeClockNativeChildWait();
  console.log("[PASS] Codex fake-clock native child wait and cancellation (fixture/source contract; no installed-live proof)");
}

type IdentityBoundary = "session.retry" | "session.status" | "session.abort" | "codex.fetch";
type IdentityField = "sessionID" | "generationID" | "requestID" | "traceID";

interface IdentityObservation {
  boundary: IdentityBoundary;
  identityField?: IdentityField;
  identityValue?: string;
  identityDigest?: string;
}

interface IdentityProofResult {
  status: "PASS" | "BLOCKED";
  reasonCodes: string[];
  identityField?: IdentityField;
  boundaryCount: number;
  uniqueIdentityCount: number;
  rejectedFieldNames: string[];
}

const IDENTITY_BOUNDARIES: IdentityBoundary[] = ["session.retry", "session.status", "session.abort", "codex.fetch"];
const IDENTITY_ALLOWED_KEYS = new Set(["boundary", "identityField", "identityValue", "identityDigest"]);
const SAFE_ID_PATTERNS: Record<IdentityField, RegExp> = {
  sessionID: /^ses_[A-Za-z0-9_-]+$/,
  generationID: /^gen_[A-Za-z0-9_-]+$/,
  requestID: /^req_[A-Za-z0-9_-]+$/,
  traceID: /^trace_[A-Za-z0-9_-]+$/,
};
const SAFE_ID_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IDENTITY_FORBIDDEN_FIELD_PATTERN = /prompt|body|header|authorization|credential|token|timing|ordering|timestamp|capturedAt|atMs/i;

function evaluateGenerationCorrelation(observations: IdentityObservation[]): IdentityProofResult {
  const reasonCodes: string[] = [];
  const rejectedFieldNames = new Set<string>();
  const seenBoundaries = new Set<IdentityBoundary>();
  const identityValues = new Set<string>();
  let identityField: IdentityField | undefined;

  if (!Array.isArray(observations)) {
    return {
      status: "BLOCKED",
      reasonCodes: ["observations_not_array"],
      boundaryCount: 0,
      uniqueIdentityCount: 0,
      rejectedFieldNames: [],
    };
  }

  for (const observation of observations) {
    if (!observation || typeof observation !== "object") {
      reasonCodes.push("observation_not_object");
      continue;
    }
    for (const key of Object.keys(observation)) {
      if (!IDENTITY_ALLOWED_KEYS.has(key)) {
        rejectedFieldNames.add(key);
        if (IDENTITY_FORBIDDEN_FIELD_PATTERN.test(key)) {
          reasonCodes.push(`forbidden_field:${key}`);
        } else {
          reasonCodes.push(`unsupported_field:${key}`);
        }
      }
    }

    if (!IDENTITY_BOUNDARIES.includes(observation.boundary)) {
      reasonCodes.push("unknown_boundary");
      continue;
    }
    if (seenBoundaries.has(observation.boundary)) {
      reasonCodes.push(`duplicate_boundary:${observation.boundary}`);
    }
    seenBoundaries.add(observation.boundary);

    if (!observation.identityField || (!observation.identityValue && !observation.identityDigest)) {
      reasonCodes.push(`missing_identity:${observation.boundary}`);
      continue;
    }
    if (observation.identityValue && !SAFE_ID_PATTERNS[observation.identityField].test(observation.identityValue)) {
      reasonCodes.push(`unsafe_identity:${observation.boundary}`);
      continue;
    }
    if (observation.identityDigest && !SAFE_ID_DIGEST_PATTERN.test(observation.identityDigest)) {
      reasonCodes.push(`unsafe_identity_digest:${observation.boundary}`);
      continue;
    }
    if (identityField && identityField !== observation.identityField) {
      reasonCodes.push("identity_field_collision");
    }
    identityField ??= observation.identityField;
    identityValues.add(observation.identityDigest ?? observation.identityValue as string);
  }

  for (const boundary of IDENTITY_BOUNDARIES) {
    if (!seenBoundaries.has(boundary)) reasonCodes.push(`missing_boundary:${boundary}`);
  }
  if (identityValues.size !== 1) reasonCodes.push("identity_not_single_valued");

  const uniqueReasons = [...new Set(reasonCodes)];
  return {
    status: uniqueReasons.length === 0 ? "PASS" : "BLOCKED",
    reasonCodes: uniqueReasons,
    identityField,
    boundaryCount: seenBoundaries.size,
    uniqueIdentityCount: identityValues.size,
    rejectedFieldNames: [...rejectedFieldNames].sort(),
  };
}

function testIdentityCorrelationEvaluatorContract(): void {
  const provenFixture: IdentityObservation[] = IDENTITY_BOUNDARIES.map((boundary) => ({
    boundary,
    identityField: "generationID",
    identityValue: "gen_fixture_1",
  }));
  const proven = evaluateGenerationCorrelation(provenFixture);
  assert.equal(proven.status, "PASS", "one explicit generation identity across all boundaries is provable");
  assert.equal(proven.identityField, "generationID");
  assert.equal(proven.boundaryCount, IDENTITY_BOUNDARIES.length);
  assert.equal(proven.uniqueIdentityCount, 1);
  assert.deepEqual(proven.rejectedFieldNames, []);

  const missingFetch = provenFixture.map((observation) => ({ ...observation }));
  missingFetch[3] = { boundary: "codex.fetch" };
  assert.equal(evaluateGenerationCorrelation(missingFetch).status, "BLOCKED", "missing fetch identity must block");

  const duplicateBoundary = [...provenFixture, { ...provenFixture[0] }];
  assert.equal(evaluateGenerationCorrelation(duplicateBoundary).status, "BLOCKED", "duplicate boundary must block");

  const duplicateStatusBoundary = [...provenFixture, { ...provenFixture[1] }];
  assert.equal(evaluateGenerationCorrelation(duplicateStatusBoundary).status, "BLOCKED", "duplicate session status boundary must block");

  const collidingIdentity = provenFixture.map((observation, index) => ({
    ...observation,
    identityValue: index === 3 ? "gen_fixture_2" : observation.identityValue,
  }));
  assert.equal(evaluateGenerationCorrelation(collidingIdentity).status, "BLOCKED", "colliding identity must block");

  const timingHeuristic = provenFixture.map((observation) => ({
    ...observation,
    capturedAtMs: 1234,
  })) as unknown as IdentityObservation[];
  const timingResult = evaluateGenerationCorrelation(timingHeuristic);
  assert.equal(timingResult.status, "BLOCKED", "timing metadata cannot prove identity");
  assert.ok(timingResult.rejectedFieldNames.includes("capturedAtMs"));

  const promptHashHeuristic = provenFixture.map((observation) => ({
    ...observation,
    promptDigest: "a".repeat(64),
  })) as unknown as IdentityObservation[];
  const promptResult = evaluateGenerationCorrelation(promptHashHeuristic);
  assert.equal(promptResult.status, "BLOCKED", "prompt digest cannot prove identity");
  assert.ok(promptResult.rejectedFieldNames.includes("promptDigest"));
}

type ObservedSessionStatusEvent = {
  sessionId: string;
  status: string;
  capturedAtMs?: number;
  key?: string;
};

function buildObservedIdentityBoundaries(
  cancellationSessionId: string,
  sessionStatusEvents: ObservedSessionStatusEvent[],
  abortSucceeded: boolean,
  abortResponseStatus: number,
  abortRequestAtMs: number,
  originalDeadlineMs?: number,
): { observations: IdentityObservation[]; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  const observations: IdentityObservation[] = [];
  const observedEvents = sessionStatusEvents.filter((event) => event.sessionId === cancellationSessionId);
  const retryEvents = observedEvents.filter((event) => event.status === "retry");
  // The status boundary is specifically the native idle event observed after
  // the abort request, not an abort response or another cancellation label.
  const terminalEvents = observedEvents.filter((event) =>
    event.status.toLowerCase() === "idle"
    && typeof event.capturedAtMs === "number"
    && event.capturedAtMs >= abortRequestAtMs
    && typeof originalDeadlineMs === "number"
    && event.capturedAtMs < originalDeadlineMs);

  const appendBoundary = (boundary: IdentityBoundary, event: ObservedSessionStatusEvent): void => {
    observations.push({
      boundary,
      identityField: "sessionID",
      identityDigest: identityDigestForValue(event.sessionId),
    });
  };

  if (retryEvents.length === 0) reasonCodes.push("missing_boundary:session.retry");
  if (retryEvents.length > 1) reasonCodes.push("duplicate_boundary:session.retry");
  retryEvents.forEach((event) => appendBoundary("session.retry", event));

  if (terminalEvents.length === 0) reasonCodes.push("missing_boundary:session.status");
  if (terminalEvents.length > 1) reasonCodes.push("duplicate_boundary:session.status");
  terminalEvents.forEach((event) => appendBoundary("session.status", event));

  const abortSucceeded2xx = abortSucceeded && abortResponseStatus >= 200 && abortResponseStatus < 300;
  if (!abortSucceeded2xx) {
    reasonCodes.push("missing_boundary:session.abort");
  } else if (terminalEvents.length === 0) {
    reasonCodes.push("missing_boundary:session.abort");
  } else {
    terminalEvents.forEach((event) => appendBoundary("session.abort", event));
    if (terminalEvents.length > 1) reasonCodes.push("duplicate_boundary:session.abort");
  }

  return { observations, reasonCodes: [...new Set(reasonCodes)] };
}

function isNativeCancellationObserved(
  sessionStatusEvents: ObservedSessionStatusEvent[],
  cancellationSessionId: string,
  abortRequestAtMs: number,
  originalDeadlineMs?: number,
): boolean {
  return sessionStatusEvents.some((event) =>
    event.sessionId === cancellationSessionId
    && event.status.toLowerCase() === "idle"
    && typeof event.capturedAtMs === "number"
    && event.capturedAtMs >= abortRequestAtMs
    && (originalDeadlineMs === undefined || event.capturedAtMs < originalDeadlineMs));
}

async function waitForNativeCancellationObserved(options: {
  readEvents: () => Promise<ObservedSessionStatusEvent[]>;
  sessionId: string;
  abortRequestAtMs: number;
  originalDeadlineMs?: number;
  totalDeadlineAtMs?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  nowMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  }));
  const startedAtMs = nowMs();
  const waitUntilMs = Math.min(
    startedAtMs + (options.maxWaitMs ?? 5_000),
    options.originalDeadlineMs ?? Number.POSITIVE_INFINITY,
    options.totalDeadlineAtMs ?? Number.POSITIVE_INFINITY,
  );

  while (nowMs() <= waitUntilMs) {
    const events = await options.readEvents();
    if (nowMs() > waitUntilMs) return false;
    const observed = options.originalDeadlineMs !== undefined
      && events.some((event) => event.sessionId === options.sessionId
        && event.status.toLowerCase() === "idle"
        && typeof event.capturedAtMs === "number"
        && event.capturedAtMs >= options.abortRequestAtMs
        && event.capturedAtMs < options.originalDeadlineMs!);
    if (observed) return true;

    const remainingMs = waitUntilMs - nowMs();
    if (remainingMs <= 0) break;
    await sleep(Math.min(options.pollIntervalMs ?? 100, remainingMs));
  }
  return false;
}

function testIdentityBoundaryObservationContract(): void {
  const nativeSessionId = "ses_native_observed";
  const observed = buildObservedIdentityBoundaries(nativeSessionId, [
    { sessionId: nativeSessionId, status: "retry", key: "retry-1" },
    { sessionId: nativeSessionId, status: "idle", key: "idle-1", capturedAtMs: 1_500 },
  ], true, 200, 1_341, 2_000);
  assert.equal(observed.reasonCodes.length, 0, "native retry/status plus successful abort should provide one boundary each");
  assert.deepEqual(observed.observations.map((entry) => entry.boundary), [
    "session.retry", "session.status", "session.abort",
  ]);
  assert.ok(observed.observations.every((entry) => entry.identityDigest === identityDigestForValue(nativeSessionId)),
    "all session boundary identities must be derived from the observed native session id");

  const duplicate = buildObservedIdentityBoundaries(nativeSessionId, [
    { sessionId: nativeSessionId, status: "retry", key: "retry-1" },
    { sessionId: nativeSessionId, status: "idle", key: "idle-1", capturedAtMs: 1_500 },
    { sessionId: nativeSessionId, status: "idle", key: "idle-2", capturedAtMs: 1_600 },
  ], true, 200, 1_341, 2_000);
  assert.ok(duplicate.reasonCodes.includes("duplicate_boundary:session.status"));
  assert.equal(evaluateGenerationCorrelation(duplicate.observations).status, "BLOCKED",
    "duplicate native status events must block correlation");

  const wrongSession = buildObservedIdentityBoundaries("ses_injected_only", [
    { sessionId: nativeSessionId, status: "retry", key: "retry-1" },
    { sessionId: nativeSessionId, status: "idle", key: "idle-1", capturedAtMs: 1_500 },
  ], true, 200, 1_341, 2_000);
  assert.ok(wrongSession.reasonCodes.includes("missing_boundary:session.retry"),
    "an injected cancellation session id without a matching native event must block");

  const idleBeforeAbort = buildObservedIdentityBoundaries(nativeSessionId, [
    { sessionId: nativeSessionId, status: "retry", key: "retry-1" },
    { sessionId: nativeSessionId, status: "idle", capturedAtMs: 1_376 },
  ], true, 200, 1_341, 1_500);
  assert.deepEqual(idleBeforeAbort.observations.map((entry) => entry.boundary), [
    "session.retry", "session.status", "session.abort",
  ], "idle after abort request and before the deadline proves cancellation without response-order requirements");
  const idleAfterDeadline = buildObservedIdentityBoundaries(nativeSessionId, [
    { sessionId: nativeSessionId, status: "retry", key: "retry-1" },
    { sessionId: nativeSessionId, status: "idle", capturedAtMs: 1_501 },
  ], true, 200, 1_341, 1_500);
  assert.ok(idleAfterDeadline.reasonCodes.includes("missing_boundary:session.status"),
    "idle after the native deadline cannot prove the status boundary");
}

const IDENTITY_HEADER_TEST_FIELDS: Array<[string, IdentityField]> = [
  ["x-session-id", "sessionID"], ["x_session_id", "sessionID"],
  ["session-id", "sessionID"], ["session_id", "sessionID"],
  ["x-generation-id", "generationID"], ["x_generation_id", "generationID"],
  ["generation-id", "generationID"], ["generation_id", "generationID"],
  ["x-request-id", "requestID"], ["x_request_id", "requestID"],
  ["request-id", "requestID"], ["request_id", "requestID"],
  ["x-trace-id", "traceID"], ["x_trace_id", "traceID"],
  ["trace-id", "traceID"], ["trace_id", "traceID"],
];

function inspectEffectiveIdentityHeaders(input: unknown, init?: RequestInit): {
  names: string[];
  identities: Array<{ identityField: IdentityField; identityDigest: string }>;
  readable: boolean;
} {
  const names: string[] = [];
  const identities: Array<{ identityField: IdentityField; identityDigest: string }> = [];
  try {
    let sourceHeaders: HeadersInit | undefined;
    if (init?.headers !== undefined) sourceHeaders = init.headers;
    else if (input instanceof Request) sourceHeaders = input.headers;
    else if (typeof input !== "string" && !(input instanceof URL)) throw new TypeError("unsupported fetch input");
    const headers = new Headers(sourceHeaders);
    for (const [name, identityField] of IDENTITY_HEADER_TEST_FIELDS) {
      const value = headers.get(name);
      if (!value) continue;
      names.push(name);
      identities.push({ identityField, identityDigest: identityDigestForValue(value) });
    }
    return { names: [...new Set(names)].sort(), identities, readable: true };
  } catch {
    return { names: [], identities: [], readable: false };
  }
}

async function testIdentityRequestOverlayContract(): Promise<void> {
  const request = new Request("https://api.example.test", {
    method: "POST",
    headers: { "x-session-id": "input-session", "x-request-id": "input-request" },
    body: "fixture body",
  });
  const beforeBodyUsed = request.bodyUsed;
  const overridden = inspectEffectiveIdentityHeaders(request, {
    headers: { "x_session_id": "override-session", "x_request_id": "override-request" },
  });
  assert.deepEqual(overridden.identities.map((entry) => entry.identityDigest), [
    identityDigestForValue("override-session"), identityDigestForValue("override-request"),
  ], "init.headers must override Request headers and include underscore aliases");
  assert.equal(request.bodyUsed, beforeBodyUsed, "identity inspection must not consume the Request body");

  const inherited = inspectEffectiveIdentityHeaders(request, undefined);
  assert.deepEqual(inherited.identities.map((entry) => entry.identityDigest), [
    identityDigestForValue("input-session"), identityDigestForValue("input-request"),
  ], "input Request headers supply effective headers when init.headers is absent");
  assert.equal(inherited.readable, true);
  assert.equal(inspectEffectiveIdentityHeaders({ headers: Symbol("unreadable") }, undefined).readable, false,
    "unreadable header input must block identity proof");
  const fixtureSource = smokeTransportPluginSource("tmp/codex-quota-retry/identity/overlay.txt");
  assert.match(fixtureSource, /if \(init\?\.headers !== undefined\)[\s\S]*else if \(input instanceof Request\)/,
    "installed fixture must inspect effective init-over-input header source");
  assert.doesNotMatch(fixtureSource, /new Request\(input, init\)/,
    "identity inspection must not construct a Request and risk affecting its body");
}

async function testIdentityEvidenceDirectoryClaimContract(): Promise<void> {
  const evidenceRoot = join(smokeProjectRoot(), "tmp", "codex-quota-retry");
  await mkdir(evidenceRoot, { recursive: true });
  const parent = await mkdtemp(join(evidenceRoot, "identity-claim-test-"));
  const runDir = join(parent, "identity");
  await mkdir(runDir, { recursive: false });
  const sentinelPath = join(runDir, "prior-evidence.txt");
  await writeFile(sentinelPath, "preserve-existing-evidence");
  await assert.rejects(claimIdentityEvidenceDirectory(runDir), /already exists; refusing to overwrite or delete it/);
  assert.equal(await readFile(sentinelPath, "utf8"), "preserve-existing-evidence",
    "a colliding run directory must refuse without changing prior evidence");
  await rm(parent, { recursive: true, force: true });
}

async function testNativeEventEvidenceSessionIdsUseSetContract(): Promise<void> {
  const evidenceRoot = join(smokeProjectRoot(), "tmp", "codex-quota-retry");
  await mkdir(evidenceRoot, { recursive: true });
  const runDir = await mkdtemp(join(evidenceRoot, "native-event-set-contract-"));
  const observedSessionId = "ses_parallel_native_fixture";
  try {
    await writeFile(join(runDir, "native-events.jsonl"), JSON.stringify({
      type: "session.created",
      properties: { info: { id: observedSessionId } },
    }) + "\n");

    const evidence = await readNativeEventEvidence(runDir);
    assert.ok(evidence.sessionIds instanceof Set, "native session identity evidence is a Set");
    assert.equal(evidence.sessionIds.has(observedSessionId), true,
      "actual native event evidence must expose observed session IDs through Set.has");
    assert.equal(evidence.sessionIds.has("ses_unobserved_fixture"), false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

function testIdentityAbortTimingContract(): void {
  const sessionId = "ses_cancel_timing";
  assert.equal(isNativeCancellationObserved([
    { sessionId, status: "idle", capturedAtMs: 1_376 },
  ], sessionId, 1_341, 2_000), true,
  "idle after abort request and before retry deadline is sufficient");
  assert.equal(isNativeCancellationObserved([
    { sessionId, status: "idle", capturedAtMs: 1_376 },
  ], sessionId, 1_341, 1_350), false,
  "idle after the deadline does not prove cancellation timing");
}

async function testNativeCancellationIdleBarrierContract(): Promise<void> {
  const sessionId = "ses_delayed_idle";
  let now = 1_000;
  let reads = 0;
  const delayedIdle = await waitForNativeCancellationObserved({
    readEvents: async () => {
      reads += 1;
      return reads < 3 ? [
        { sessionId, status: "retry", capturedAtMs: 900 },
        { sessionId, status: "busy", capturedAtMs: 950 },
      ] : [
        { sessionId, status: "retry", capturedAtMs: 900 },
        { sessionId, status: "busy", capturedAtMs: 950 },
        { sessionId, status: "idle", capturedAtMs: 1_200 },
      ];
    },
    sessionId,
    abortRequestAtMs: 1_100,
    originalDeadlineMs: 2_000,
    totalDeadlineAtMs: 2_500,
    nowMs: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  assert.equal(delayedIdle, true, "later-flushed native idle is observed before launching parallel B");
  assert.equal(reads, 3, "busy/retry-only snapshots are polled rather than treated as terminal");

  now = 1_000;
  reads = 0;
  const noIdle = await waitForNativeCancellationObserved({
    readEvents: async () => {
      reads += 1;
      // Simulate a JSONL append still in progress: only complete parsed events
      // are returned, so an incomplete idle record cannot satisfy the gate.
      return [{ sessionId, status: "retry", capturedAtMs: 900 }];
    },
    sessionId,
    abortRequestAtMs: 1_100,
    originalDeadlineMs: 1_250,
    totalDeadlineAtMs: 1_500,
    maxWaitMs: 5_000,
    pollIntervalMs: 100,
    nowMs: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  assert.equal(noIdle, false, "missing native idle remains a bounded cancellation-gate failure");
  assert.equal(now, 1_250, "polling stops at the original native retry deadline");
  assert.ok(reads > 1, "no-idle case polls multiple appended-event snapshots before failing");
}

function providerFreeIdentityRuntimeFixture(): IdentityObservation[] {
  // The native lifecycle exposes sessionID, while the fetch boundary exposes
  // only route metadata. Deliberately omit a fetch identity: this fixture must
  // remain BLOCKED and must not infer correlation from timing or ordering.
  return [
    { boundary: "session.retry", identityField: "sessionID", identityValue: "ses_fixture_native" },
    { boundary: "session.status", identityField: "sessionID", identityValue: "ses_fixture_native" },
    { boundary: "session.abort", identityField: "sessionID", identityValue: "ses_fixture_native" },
    { boundary: "codex.fetch" },
  ];
}

async function runIdentityUnit(): Promise<void> {
  testIdentityCorrelationEvaluatorContract();
  testIdentityBoundaryObservationContract();
  await testIdentityRequestOverlayContract();
  await testIdentityEvidenceDirectoryClaimContract();
  await testNativeEventEvidenceSessionIdsUseSetContract();
  testIdentityAbortTimingContract();
  await testIdentityStageDiagnosticsContract();
  const blocked = evaluateGenerationCorrelation(providerFreeIdentityRuntimeFixture());
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.reasonCodes.includes("missing_identity:codex.fetch"));
  console.log("[PASS] identity-unit evaluator rejects missing, duplicate, colliding, timing, and prompt-hash identity claims");
}

function testCancellationStateAmbiguityAndExpiry(): void {
  let wall = 10_000;
  let mono = 500;
  const state = createCodexQuotaRetryCancellationState({ nowMs: () => wall, monotonicMs: () => mono,
    markerGraceMs: 100, maxPending: 2 });
  assert.equal(state.recordQuotaRetry("ses_one", wall + 2_000), true);
  assert.equal(state.observeSessionStatusEvent({ type: "session.status", properties: {
    sessionID: "ses_one", status: { type: "retry", attempt: 1, next: wall + 3_000 },
  } }), true, "native retry status supplies the actual pending deadline");
  assert.equal(state.observeSessionStatusEvent({ type: "session.status", properties: {
    sessionID: "ses_one", status: { type: "idle" },
  } }), true, "terminal idle only marks a tracked native retry");
  assert.equal(state.isCancelled("ses_one"), true);
  assert.equal(state.observeSessionStatusEvent({ type: "session.status", properties: {
    sessionID: "ses_one", status: { type: "retry", attempt: 1, next: wall + 3_000 },
  } }), false, "a duplicate historical retry event cannot rearm a marker");
  assert.equal(state.isCancelled(undefined), false, "an uncorrelated identity fails closed without broad suppression");
  mono += 3_000 + 100;
  wall += 3_000 + 100;
  assert.equal(state.isCancelled("ses_one"), false, "marker expires at native deadline plus explicit grace");
  state.cleanup();
  assert.equal(state.markerCount(), 0);
  assert.equal(state.pendingCount(), 0);
  assert.equal(state.recordQuotaRetry("ses_one", wall + 1_000), true,
    "a later generation is not blocked after the old marker expires");

  const ambiguous = createCodexQuotaRetryCancellationState({ nowMs: () => wall, monotonicMs: () => mono });
  assert.equal(ambiguous.recordQuotaRetry("ses_shared", wall + 1_000), true);
  assert.equal(ambiguous.recordQuotaRetry("ses_shared", wall + 2_000), false,
    "multiple pending quota generations sharing a session identity are ambiguous");
  assert.equal(ambiguous.observeSessionStatusEvent({ type: "session.status", properties: {
    sessionID: "ses_shared", status: { type: "retry", attempt: 1, next: wall + 2_000 },
  } }), false);
  assert.equal(ambiguous.observeSessionStatusEvent({ type: "session.status", properties: {
    sessionID: "ses_shared", status: { type: "idle" },
  } }), false);
  assert.equal(ambiguous.isCancelled("ses_shared"), false, "ambiguous identity never creates a broad marker");

  const tiny = createCodexQuotaRetryCancellationState({ nowMs: () => wall, monotonicMs: () => mono,
    maxPending: 1 });
  assert.equal(tiny.recordQuotaRetry("ses_capacity_1", wall + 5_000), true);
  assert.equal(tiny.recordQuotaRetry("ses_capacity_2", wall + 5_000), false,
    "a valid tiny capacity remains enforced");
  for (const invalidMax of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const bounded = createCodexQuotaRetryCancellationState({ nowMs: () => wall, monotonicMs: () => mono,
      maxPending: invalidMax });
    for (let index = 0; index < CODEX_MAX_PENDING_QUOTA_RETRIES; index += 1) {
      assert.equal(bounded.recordQuotaRetry(`ses_invalid_capacity_${index}`, wall + 5_000), true);
    }
    assert.equal(bounded.pendingCount(), CODEX_MAX_PENDING_QUOTA_RETRIES);
    assert.equal(bounded.recordQuotaRetry("ses_over_capacity", wall + 5_000), false,
      "invalid and infinite capacities fall back to the finite hard cap");
  }
}

async function runCancellationGuard(): Promise<void> {
  await testNativeCancellationIdleBarrierContract();
  let wall = 1_700_000_000_000;
  let mono = 1_000;
  let providerCalls = 0;
  const delegated: string[] = [];
  const mock = async (input: unknown, init?: RequestInit): Promise<Response> => {
    providerCalls += 1;
    const identity = readVerifiedCodexSessionID(input, init);
    if (identity) delegated.push(identity);
    if (providerCalls === 1) {
      return new Response(JSON.stringify({ error: { type: "usage_limit_reached" }, resets_in_seconds: 2 }), {
        status: 429, headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };

  assert.equal(readVerifiedCodexSessionID(CODEX_GENERATION_URL, { method: "POST", headers: {
    "session-id": "ses_same", "x-session-id": "ses_same",
  } }), "ses_same");
  assert.equal(readVerifiedCodexSessionID(CODEX_GENERATION_URL, { method: "POST", headers: {
    "session-id": "ses_same", "x-session-id": "ses_other",
  } }), undefined, "conflicting aliases are uncorrelated");
  const requestWithIdentity = new Request(CODEX_GENERATION_URL, { method: "POST", body: "fixture-body",
    headers: { "session-id": "ses_original", "x-session-id": "ses_original" } });
  assert.equal(requestWithIdentity.bodyUsed, false);
  assert.equal(readVerifiedCodexSessionID(requestWithIdentity, { headers: { "x-unrelated": "override" } }),
    undefined, "init.headers replaces Request.headers for effective identity");
  assert.equal(requestWithIdentity.bodyUsed, false, "identity inspection does not consume or clone the body");
  assert.equal(readVerifiedCodexSessionID(requestWithIdentity, { headers: { "session-id": "ses_new" } }),
    "ses_new", "init.headers identity cleanly replaces both original aliases");
  assert.equal(requestWithIdentity.bodyUsed, false);

  await withMockFetch(mock, async () => {
    installCodexQuotaRetryFetch({ nowMs: () => wall, monotonicMs: () => mono,
      staggerMs: 0, cancellationMarkerGraceMs: 100 });
    const request = (sessionID: string, second = sessionID): Request => new Request(CODEX_GENERATION_URL, {
      method: "POST", headers: { "session-id": sessionID, "x-session-id": second },
    });
    const quota = await (globalThis.fetch as AnyFetch)(request("ses_cancel"));
    assert.equal(quota.status, 429);
    assert.equal(providerCalls, 1);
    const cancellationState = (globalThis as Record<PropertyKey, any>)[Symbol.for("opencode.codex-quota-retry.cancellation-state")];
    assert.equal(cancellationState?.pendingCount(), 1, "eligible actual quota response tracks one exact session identity");
    const nativeNext = wall + 120_000;
    assert.equal(observeCodexQuotaRetrySessionStatus({ type: "session.status", properties: {
      sessionID: "ses_cancel", status: { type: "retry", attempt: 1, next: nativeNext },
    } }), true);
    assert.equal(observeCodexQuotaRetrySessionStatus({ type: "session.status", properties: {
      sessionID: "ses_cancel", status: { type: "idle" },
    } }), true);
    await assert.rejects((globalThis.fetch as AnyFetch)(request("ses_cancel")),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    assert.equal(providerCalls, 1, "exact cancelled retry is stopped before provider delegate");

    // The route cooldown is independent. Once it expires, a parallel identity
    // reaches the provider even while the first identity's marker remains live.
    wall += 63_000;
    mono += 63_000;
    assert.equal((await (globalThis.fetch as AnyFetch)(request("ses_parallel"))).status, 200);
    assert.equal(providerCalls, 2);
    assert.equal((await (globalThis.fetch as AnyFetch)(request("ses_cancel"), {
      headers: { "x-unrelated": "effective-header-override" },
    })).status, 200, "unrelated init.headers removes stale Request identity and passes through");
    assert.equal(providerCalls, 3);
    assert.equal((await (globalThis.fetch as AnyFetch)(request("ses_cancel", "ses_conflict"))).status, 200);
    assert.equal(providerCalls, 4, "conflicting identity aliases fail open without suppressing a request");

    const controller = new AbortController();
    const reason = new DOMException("native stop", "AbortError");
    controller.abort(reason);
    await assert.rejects((globalThis.fetch as AnyFetch)(request("ses_signal"), { signal: controller.signal }),
      (error: unknown) => error === reason, "native signal reason is preserved unchanged");
    assert.equal(providerCalls, 4, "native aborted signal does not call the provider");

    wall += 58_100;
    mono += 58_100;
    assert.equal((await (globalThis.fetch as AnyFetch)(request("ses_cancel"))).status, 200,
      "a later generation can proceed after the marker deadline and grace");
    assert.equal(providerCalls, 5);
    assert.ok(CODEX_CANCELLATION_MARKER_GRACE_MS > 0);
  });

  const helperSource = readFileSync(resolve(".opencode/lib/codex-quota-retry.ts"), "utf8");
  const pluginSource = readFileSync(resolve(".opencode/plugins/codex-quota-retry.ts"), "utf8");
  const cancellationStateSource = helperSource.slice(
    helperSource.indexOf("export function createCodexQuotaRetryCancellationState"),
    helperSource.indexOf("function resolveMonotonicMs"),
  );
  assert.match(pluginSource, /event:\s*async\s*\(\{\s*event\s*\}\)/);
  assert.match(pluginSource, /event\.type\s*===\s*"session\.status"/);
  assert.doesNotMatch(helperSource, /session\.abort|localStorage|writeFile|appendFile/);
  assert.doesNotMatch(cancellationStateSource, /setTimeout\s*\(|setInterval\s*\(|await\s+new\s+Promise/);
  assert.match(helperSource, /CANCELLATION_SYMBOL\s*=\s*Symbol\.for/,
    "duplicate global/project module loads share process-local state");
  assert.match(helperSource, /CODEX_MAX_PENDING_QUOTA_RETRIES/);
  console.log("[PASS] cancellation-guard: exact pending retry abort, parallel identity, bounded expiry, native signal, and fail-closed ambiguity");
}

const IDENTITY_MAX_RUNTIME_MS = 120_000;
const IDENTITY_DEADLINE_SAFETY_MS = 2_000;
const IDENTITY_MAX_REQUESTS = 4;
const IDENTITY_STARTUP_TIMEOUT_MS = 30_000;

type IdentityCheckpoint = {
  stage: string;
  status: "started" | "completed" | "failed";
  elapsedMs: number;
  errorName?: string;
};

class IdentityStageError extends Error {
  readonly stage: string;
  readonly errorName: string;

  constructor(stage: string, errorName: string) {
    super(`${stage}:${errorName}`);
    this.name = "IdentityStageError";
    this.stage = stage;
    this.errorName = errorName;
  }
}

function safeErrorName(error: unknown): string {
  const name = error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "Error";
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "Error";
}

async function runIdentityStage<T>(
  checkpoints: IdentityCheckpoint[],
  stage: string,
  operation: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const startedAt = now();
  checkpoints.push({ stage, status: "started", elapsedMs: 0 });
  try {
    const result = await operation();
    checkpoints.push({ stage, status: "completed", elapsedMs: Math.max(0, now() - startedAt) });
    return result;
  } catch (error) {
    if (error instanceof IdentityStageError) throw error;
    const errorName = safeErrorName(error);
    checkpoints.push({ stage, status: "failed", elapsedMs: Math.max(0, now() - startedAt), errorName });
    throw new IdentityStageError(stage, errorName);
  }
}

function identityResponseMetadata(status: number, payload: unknown): { status: number; jsonTopLevelKeys: string[] } {
  return {
    status,
    jsonTopLevelKeys: payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [],
  };
}

function remainingIdentityDeadlineMs(deadlineAtMs: number, requestedMs: number): number {
  return Math.max(1, Math.min(requestedMs, deadlineAtMs - Date.now()));
}

async function testIdentityStageDiagnosticsContract(): Promise<void> {
  const checkpoints: IdentityCheckpoint[] = [];
  let now = 100;
  const value = await runIdentityStage(checkpoints, "session_create", async () => {
    now += IDENTITY_STARTUP_TIMEOUT_MS;
    return { id: "fixture-session" };
  }, () => now);
  assert.equal(value.id, "fixture-session");
  assert.equal(checkpoints.at(-1)?.status, "completed");
  assert.equal(checkpoints.at(-1)?.elapsedMs, IDENTITY_STARTUP_TIMEOUT_MS);

  const failureCheckpoints: IdentityCheckpoint[] = [];
  await assert.rejects(runIdentityStage(failureCheckpoints, "health", async () => {
    throw new TypeError("private response body and secret must not escape");
  }), (error: unknown) => {
    assert.equal(error instanceof IdentityStageError, true);
    assert.equal((error as IdentityStageError).message, "health:TypeError");
    assert.equal(failureCheckpoints.at(-1)?.errorName, "TypeError");
    assert.equal(JSON.stringify(failureCheckpoints).includes("private"), false);
    return true;
  });
  assert.deepEqual(identityResponseMetadata(503, { error: "redacted", secret: "never persist" }), {
    status: 503,
    jsonTopLevelKeys: ["error", "secret"],
  });
  assert.equal(remainingIdentityDeadlineMs(Date.now() + IDENTITY_MAX_RUNTIME_MS, IDENTITY_STARTUP_TIMEOUT_MS),
    IDENTITY_STARTUP_TIMEOUT_MS);
  assert.equal(remainingIdentityDeadlineMs(Date.now() + 12_000, IDENTITY_STARTUP_TIMEOUT_MS) <= 12_000, true);
}

function identityDigestForValue(value: string): string {
  return `sha256:${sha256(value)}`;
}

interface IdentityContractArgs {
  runId?: string;
}

function parseIdentityContractArgs(argv: string[]): IdentityContractArgs {
  const index = argv.indexOf("--run-id");
  if (index < 0) return {};
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--identity-contract --run-id requires a non-empty id");
  return { runId: value };
}

function validateIdentityRunId(runId: string): string {
  assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/, "--run-id must be one safe path segment");
  assert.notEqual(runId, ".");
  assert.notEqual(runId, "..");
  return runId;
}

async function identityEvidencePathExists(pathValue: string): Promise<boolean> {
  try {
    await readdir(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function nextIdentityContractRunId(prefix: string): Promise<string> {
  const evidenceRoot = join(smokeProjectRoot(), "tmp", "codex-quota-retry");
  await mkdir(evidenceRoot, { recursive: true });
  let candidate = prefix;
  let suffix = 2;
  while (await identityEvidencePathExists(join(evidenceRoot, candidate, "identity"))) {
    candidate = `${prefix}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function claimIdentityEvidenceDirectory(runDir: string): Promise<void> {
  await mkdir(dirname(runDir), { recursive: true });
  try {
    await mkdir(runDir, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("identity evidence directory already exists; refusing to overwrite or delete it");
    }
    throw error;
  }
}

async function runIdentityContract(): Promise<void> {
  const root = smokeProjectRoot();
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + IDENTITY_MAX_RUNTIME_MS - IDENTITY_DEADLINE_SAFETY_MS;
  const checkpoints: IdentityCheckpoint[] = [];
  let healthResponse = { status: 0, jsonTopLevelKeys: [] as string[] };
  let sessionCreateResponse = { status: 0, jsonTopLevelKeys: [] as string[] };
  let activeStage = "identity_setup";
  let runId: string;
  let runDir: string;
  try {
    const args = parseIdentityContractArgs(Bun.argv.slice(2));
    runId = validateIdentityRunId(args.runId ?? await nextIdentityContractRunId("identity-contract"));
    runDir = join(root, "tmp", "codex-quota-retry", runId, "identity");
    await claimIdentityEvidenceDirectory(runDir);
  } catch (error) {
    console.log(`[BLOCKED] identity evidence directory was not claimed: identity_setup:${safeErrorName(error)}`);
    return;
  }

  const correlationPolicy = {
    allowedIdentityFields: ["sessionID", "generationID", "requestID", "traceID"],
    rejectedSignals: ["promptHash", "timing", "ordering", "requestBody", "headers", "credentials", "tokens"],
    singleValuedAcrossBoundaries: true,
    singleRecordPerBoundary: true,
    nativeStatusSource: "native.sessionStatusEvents",
    abortIdentitySource: "observed native session id on successful abort HTTP path",
    rawValuesPersisted: false,
  };
  let report: Record<string, unknown> = {
    schema: "codex-quota-retry-identity-contract.v3",
    status: "BLOCKED",
    installedLiveProof: false,
    probeExecuted: false,
    runId,
    runDirectory: relative(root, runDir).replaceAll("\\", "/"),
    maxRuntimeMs: IDENTITY_MAX_RUNTIME_MS,
    correlationPolicy,
    blocker: "identity probe did not complete",
    diagnostics: { checkpoints, healthResponse, sessionCreateResponse },
  };

  try {
    activeStage = "workspace_prepare";
    const workspace = await runIdentityStage(checkpoints, activeStage, () => writeSmokeWorkspace(runDir));
    activeStage = "runtime_preflight";
    const opencodeBin = Bun.which("opencode");
    const bunVersion = Bun.version;
    const opencodeVersion = opencodeBin ? commandOutput(opencodeBin, ["--version"]) : "missing";
    const evidenceDir = join(runDir, "evidence", "identity");
    const requestBudgetPath = join(evidenceDir, "request-budget.json");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(requestBudgetPath, JSON.stringify({
      acceptedRequests: 0,
      maxRequests: IDENTITY_MAX_REQUESTS,
      exceeded: false,
    }, null, 2));
    const isolatedEnv = buildIsolatedEnvironment({
      HOME: join(runDir, "home"),
      XDG_CONFIG_HOME: workspace.configRoot,
      XDG_CACHE_HOME: workspace.cacheRoot,
      XDG_DATA_HOME: workspace.dataRoot,
      XDG_STATE_HOME: workspace.stateRoot,
      CODEX_SMOKE_NO_PROVIDER: "1",
      CODEX_SMOKE_EXTERNAL_NETWORK_DENIED: "1",
      CODEX_SMOKE_RUNTIME_BUN: bunVersion,
      CODEX_SMOKE_RUNTIME_OPENCODE: opencodeVersion,
      CODEX_SMOKE_GOAL_PLUGIN_VERSION: workspace.goalPlugin.version,
      CODEX_SMOKE_EVIDENCE_DIR: evidenceDir,
      CODEX_SMOKE_REQUEST_BUDGET_PATH: requestBudgetPath,
      CODEX_SMOKE_REQUEST_BUDGET_MAX: String(IDENTITY_MAX_REQUESTS),
      CODEX_IDENTITY_PROBE: "1",
      CODEX_SMOKE_SCENARIO: "cancel",
      OPENCODE_GOAL_STATE_PATH: join(workspace.stateRoot, "goals.json"),
    });
    await mkdir(isolatedEnv.HOME, { recursive: true });

    if (!opencodeBin || opencodeVersion !== "1.19.0") {
      report = {
        ...report,
        probeExecuted: false,
        runtime: { bun: bunVersion, opencode: opencodeVersion, goalPluginVersion: workspace.goalPlugin.version },
        blocker: `required OpenCode 1.19.0 unavailable (observed ${opencodeVersion || "missing"})`,
      };
    } else {
      activeStage = "native_cancellation";
      const cancellation = await runIdentityStage(checkpoints, activeStage, async () => {
        const result = await runNativeCancellation(opencodeBin, workspace.workspace, isolatedEnv, runDir,
          deadlineAtMs, checkpoints);
        healthResponse = result.healthResponse;
        sessionCreateResponse = result.sessionCreateResponse;
        return result;
      });
      const fixtureInstalled = await readEvidenceJson(join(evidenceDir, "fixture-installed.json"));
      const requestBudget = await readEvidenceJson(requestBudgetPath);
      const acceptedRequests = typeof requestBudget?.acceptedRequests === "number" ? requestBudget.acceptedRequests : -1;
      const budgetExceeded = requestBudget?.exceeded === true;
      const safeEvidence = await readSafeIdentityEvidence(evidenceDir);
      const native = await readNativeEventEvidence(evidenceDir);
      const observedBoundaries = buildObservedIdentityBoundaries(
        cancellation.sessionId,
        native.sessionStatusEvents,
        cancellation.abortSucceeded,
        cancellation.abortResponseStatus,
        cancellation.abortRequestAtMs,
        cancellation.originalDeadlineMs,
      );
      for (const observation of observedBoundaries.observations) {
        await appendFile(join(evidenceDir, "identity-boundaries.jsonl"), JSON.stringify(observation) + "\n");
      }
      const identityObservations = [...observedBoundaries.observations, ...safeEvidence.observations];
      const proof = evaluateGenerationCorrelation(identityObservations);
      const proofReasonCodes = [...new Set([...observedBoundaries.reasonCodes, ...proof.reasonCodes])];
      const proofStatus = proofReasonCodes.length === 0 ? proof.status : "BLOCKED";
      const runtimeProbeComplete = opencodeVersion === "1.19.0"
        && fixtureInstalled?.preflight && asObject(fixtureInstalled.preflight)?.noProvider === true
        && asObject(fixtureInstalled.preflight)?.externalNetworkDenied === true
        && asObject(fixtureInstalled.preflight)?.pinnedRuntimeVerified === true
        && safeEvidence.fetchTelemetry.length > 0
        && cancellation.nativeRetryObserved
        && cancellation.nativeCancelObserved
        && cancellation.abortSucceeded
        && cancellation.abortResponseStatus >= 200
        && cancellation.abortResponseStatus < 300
        && typeof cancellation.originalDeadlineMs === "number"
        && cancellation.abortRequestAtMs < cancellation.originalDeadlineMs
        && cancellation.monitoredUntilMs >= cancellation.originalDeadlineMs
        && !budgetExceeded
        && acceptedRequests >= 0
        && acceptedRequests <= IDENTITY_MAX_REQUESTS;
      const status = runtimeProbeComplete && proofStatus === "PASS" ? "PASS" : "BLOCKED";
      report = {
        ...report,
        status,
        installedLiveProof: status === "PASS",
        probeExecuted: true,
        runtime: { bun: bunVersion, opencode: opencodeVersion, goalPluginVersion: workspace.goalPlugin.version },
        runtimeAssertions: {
          exactSyntheticQuotaRetry: cancellation.nativeRetryObserved,
          actualSessionStatus: cancellation.nativeCancelObserved,
          actualSessionAbort: cancellation.abortSucceeded && cancellation.abortResponseStatus >= 200 && cancellation.abortResponseStatus < 300,
          abortBeforeNativeDeadline: typeof cancellation.originalDeadlineMs === "number"
            && cancellation.abortRequestAtMs < cancellation.originalDeadlineMs,
          waitedThroughNativeDeadline: typeof cancellation.originalDeadlineMs === "number"
            && cancellation.monitoredUntilMs >= cancellation.originalDeadlineMs,
          actualCodexFetchTelemetry: safeEvidence.fetchTelemetry.length > 0,
          requestBudgetWithinLimit: !budgetExceeded && acceptedRequests >= 0 && acceptedRequests <= IDENTITY_MAX_REQUESTS,
          noProviderAndExternalNetworkDenied: asObject(fixtureInstalled?.preflight)?.noProvider === true
            && asObject(fixtureInstalled?.preflight)?.externalNetworkDenied === true,
        },
         observedBoundaryIdentityDigests: observedBoundaries.observations.map((observation) => ({
           boundary: observation.boundary,
           identityField: observation.identityField,
           identityDigest: observation.identityDigest,
         })),
        fetchTelemetry: safeEvidence.fetchTelemetry,
        evaluation: {
          status: proofStatus,
          reasonCodes: proofReasonCodes,
          boundaryCount: proof.boundaryCount,
          uniqueIdentityCount: proof.uniqueIdentityCount,
          rejectedFieldNames: proof.rejectedFieldNames,
        },
          blocker: status === "PASS" ? undefined : "actual native sessionStatusEvents and Codex fetch evidence did not prove one stable unique explicit identity",
        diagnostics: { checkpoints, healthResponse, sessionCreateResponse },
      };
    }
  } catch (error) {
    const stageError = error instanceof IdentityStageError ? error : new IdentityStageError(activeStage, safeErrorName(error));
    report = {
      ...report,
      probeExecuted: true,
      blocker: `${stageError.stage}:${stageError.errorName}`,
      diagnostics: { checkpoints, healthResponse, sessionCreateResponse, failureReason: `${stageError.stage}:${stageError.errorName}` },
    };
  }

  if (Date.now() - startedAt > IDENTITY_MAX_RUNTIME_MS) {
    report.status = "BLOCKED";
    report.installedLiveProof = false;
    report.blocker = "identity probe exceeded the 120 second bound";
  }
  await writeFile(join(runDir, "identity-contract.json"), JSON.stringify(report, null, 2));
  const status = report.status === "PASS" ? "PASS" : "BLOCKED";
  console.log(`[${status}] Codex session retry/status/abort to fetch identity probe; evidence=${relative(root, runDir).replaceAll("\\", "/")}`);
}

const SMOKE_SCHEMA = "codex-quota-retry-smoke.v1";
const SMOKE_PARENT_MODEL = "openai/gpt-6.1-sol";
const SMOKE_CHILD_MODEL = "openai/gpt-6-luna";
const SMOKE_CHILD_MODEL_ID = SMOKE_CHILD_MODEL.replace(/^openai\//, "");
const SMOKE_CHILD_AGENT = "general";
const SMOKE_SHORT_RESET_SECONDS = 1;
const SMOKE_GRACE_MS = CODEX_QUOTA_GRACE_MS;
const SMOKE_MAX_RUNTIME_MS = 220_000;
const SMOKE_MAX_REQUESTS = 12;
const SMOKE_NATIVE_WAIT_MS = (SMOKE_SHORT_RESET_SECONDS * 1000) + SMOKE_GRACE_MS;
const SMOKE_GOAL_OBJECTIVE = "Verify one bounded Codex quota retry with one general child delegation and one persisted mutation.";
const SMOKE_CHILD_TASK_DESCRIPTION = "Run child smoke mutation";
const SMOKE_MUTATION_CONTENT = "CODEX_SMOKE_CHILD_MUTATION\n";
const SMOKE_CANCELLATION_MESSAGE_TEXT = "Run one pending native retry and do not continue after cancellation.";
const OWNED_PROCESS_TERM_GRACE_MS = 2_000;
const OWNED_PROCESS_KILL_SETTLE_MS = 500;
const OWNED_PROCESS_STREAM_CLOSE_GRACE_MS = 250;
const SMOKE_DEADLINE_SAFETY_MS = 1_000;

type NativeCancellationMessagePayload = {
  model: { providerID: "openai"; modelID: string };
  parts: [{ type: "text"; text: string }];
};

function buildNativeCancellationMessagePayload(): NativeCancellationMessagePayload {
  return {
    model: { providerID: "openai", modelID: SMOKE_CHILD_MODEL_ID },
    parts: [{ type: "text", text: SMOKE_CANCELLATION_MESSAGE_TEXT }],
  };
}

function testNativeCancellationMessagePayloadContract(): void {
  const payload = buildNativeCancellationMessagePayload();
  const expected = {
    model: { providerID: "openai", modelID: "gpt-6-luna" },
    parts: [{ type: "text", text: SMOKE_CANCELLATION_MESSAGE_TEXT }],
  };
  assert.equal(JSON.stringify(payload), JSON.stringify(expected), "cancellation message must use the exact nested native model shape");
  assert.equal(payload.model.modelID, SMOKE_CHILD_MODEL.replace(/^openai\//, ""), "API modelID must strip the provider prefix");
  assert.equal(payload.model.modelID.includes("/"), false, "API modelID must not contain the CLI provider/model separator");
  assert.equal(Object.hasOwn(payload, "modelID"), false, "modelID must not be sent at the JSON top level");
  assert.equal(Object.hasOwn(payload, "providerID"), false, "providerID must not be sent at the JSON top level");
}

const SMOKE_EVIDENCE_PATHS = {
  parent: [
    "evidence/parent/request-timeline.jsonl",
    "evidence/parent/identity-fetch-telemetry.jsonl",
    "evidence/parent/quota-responses.jsonl",
    "evidence/parent/native-events.jsonl",
    "evidence/parent/side-effects.jsonl",
    "evidence/parent/loaded-goal-plugin.json",
  ],
  cancellation: [
    "evidence/cancellation/request-timeline.jsonl",
    "evidence/cancellation/identity-fetch-telemetry.jsonl",
    "evidence/cancellation/quota-responses.jsonl",
    "evidence/cancellation/aborted-fetch-attempts.jsonl",
    "evidence/cancellation/native-events.jsonl",
  ],
  shared: [
    "expected-scenarios.json",
    "plugin-load-order.json",
    "process-manifest.json",
    "evidence/request-budget.json",
    "manifest.json",
    "goal-state-summary.json",
    "verdict.json",
  ],
} as const;

interface SmokeArgs {
  mode: "smoke" | "smoke-contract";
  runId?: string;
  outputDir?: string;
}

interface SmokeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: string;
}

class SmokeDeadlineError extends Error {
  constructor() {
    super("smoke global deadline exceeded");
    this.name = "SmokeDeadlineError";
  }
}

type SmokeDeadlineState = {
  startedAt: number;
  deadlineAtMs: number;
  expired: boolean;
};

function assertSmokeDeadline(state: SmokeDeadlineState): void {
  if (state.expired || Date.now() >= state.deadlineAtMs) {
    state.expired = true;
    throw new SmokeDeadlineError();
  }
}

function smokeProjectRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

function parseSmokeArgs(argv: string[]): SmokeArgs | undefined {
  const mode = argv.includes("--smoke") ? "smoke" : argv.includes("--smoke-contract") ? "smoke-contract" : undefined;
  if (!mode) {
    return undefined;
  }

  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value && !value.startsWith("--") ? value : undefined;
  };

  return {
    mode,
    runId: valueAfter("--run-id"),
    outputDir: valueAfter("--output-dir"),
  };
}

function assertSafeSmokeRelativePath(pathValue: string, label: string): string {
  assert.equal(isAbsolute(pathValue), false, `${label} must be relative`);
  assert.equal(pathValue.includes("/tmp/") || pathValue.includes("\\tmp\\"), false,
    `${label} must not use an absolute /tmp path`);
  const normalized = pathValue.replaceAll("\\", "/");
  assert.equal(normalized.startsWith("../") || normalized === "..", false,
    `${label} must remain inside the repository`);
  return normalized;
}

function smokeRunDirectory(args: SmokeArgs): string {
  const root = smokeProjectRoot();
  const relativePath = args.outputDir
    ? assertSafeSmokeRelativePath(args.outputDir, "--output-dir")
    : join("tmp", "codex-quota-retry", args.runId ?? "");
  if (!args.outputDir && !args.runId) {
    throw new Error("--smoke and --smoke-contract require --run-id <id> or --output-dir <relative-path>");
  }
  const resolved = resolve(root, relativePath);
  assert.equal(relative(root, resolved).startsWith(".."), false, "smoke output must stay in repository");
  if (args.outputDir) {
    assert.match(relative(root, resolved).replaceAll("\\", "/"), /^tmp\/codex-quota-retry\//,
      "--output-dir must be under tmp/codex-quota-retry/");
  }
  return resolved;
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

function commandOutput(command: string, args: string[]): string {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(result.stdout).trim();
}

function initSmokeGitRoot(workspace: string): void {
  const result = Bun.spawnSync(["git", "init", "-q"], {
    cwd: workspace,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(result.exitCode, 0, "isolated smoke workspace git root must initialize");
}

function smokeTransportPluginSource(mutationPath: string): string {
  const encodedMutationPath = JSON.stringify(mutationPath);
  return `import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

const CODEX_GENERATION_URL = "https://chatgpt.com/backend-api/codex/responses";
const REGISTRY_SYMBOL = Symbol.for("opencode.codex-quota-retry.fetch-wrapper");
const STATE_SYMBOL = Symbol.for("opencode.codex-quota-retry.smoke-transport");
const FIXTURE_SYMBOL = Symbol.for("opencode.codex-quota-retry.smoke-fixture");
const MUTATION_PATH = ${encodedMutationPath};
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
let fixtureReady = false;
let fixtureRequestHandler;
let smokeGuardInstalled = false;

function isStrictLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

function state() {
  const existing = globalThis[STATE_SYMBOL];
  if (existing) return existing;
    const created = {
      parentRequests: 0,
      childRequests: 0,
      cancellationRequests: 0,
      parallelRequests: 0,
      totalRequests: 0,
      quotaSent: false,
      blockedExternalRequests: 0,
      completedWriteEvidenceKeys: new Set(),
      installed: false,
   };
  Object.defineProperty(globalThis, STATE_SYMBOL, { configurable: true, value: created });
  return created;
}

async function record(path, value) {
  await mkdir(process.env.CODEX_SMOKE_EVIDENCE_DIR ?? "evidence", { recursive: true });
  await appendFile(path, JSON.stringify(value) + "\\n");
}

function evidencePath(name) {
  return (process.env.CODEX_SMOKE_EVIDENCE_DIR ?? "evidence") + "/" + name;
}

function completedApplyPatchPart(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = completedApplyPatchPart(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value;
  if (record.type === "tool" && record.tool === "apply_patch") {
    const state = record.state;
    const stateStatus = typeof state === "string" ? state : state?.status;
    if (stateStatus === "completed") return record;
  }
  for (const entry of Object.values(record)) {
    const found = completedApplyPatchPart(entry);
    if (found) return found;
  }
  return undefined;
}

async function recordCompletedWriteEvidence(event) {
  const part = completedApplyPatchPart(event);
  if (!part) return;
  const current = state();
  const partState = part.state && typeof part.state === "object" ? part.state : {};
  const executionTime = typeof partState.executionTime === "number"
    ? partState.executionTime
    : typeof event.executionTime === "number" ? event.executionTime : undefined;
  const evidenceKey = typeof part.id === "string" && executionTime !== undefined
    ? part.id + ":" + executionTime
    : undefined;
  if (evidenceKey && current.completedWriteEvidenceKeys.has(evidenceKey)) return;
  if (evidenceKey) current.completedWriteEvidenceKeys.add(evidenceKey);
  const metadata = partState.metadata && typeof partState.metadata === "object" ? partState.metadata : {};
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const mutationFile = files.find((file) => file && typeof file === "object" && file.filePath === MUTATION_PATH);
  await record(evidencePath("completed-write-parts.jsonl"), {
    id: part.id,
    tool: part.tool,
    sessionID: part.sessionID ?? event.sessionID ?? event.sessionId,
    executionTime,
    state: {
      status: partState.status,
      input: partState.input,
      metadata: partState.metadata,
      output: partState.output,
    },
  });
  try {
    const persisted = await readFile(MUTATION_PATH, "utf8");
    if (persisted === "CODEX_SMOKE_CHILD_MUTATION\\n" && mutationFile?.filePath === MUTATION_PATH) {
      await record(evidencePath("side-effects.jsonl"), {
        identity: mutationFile.filePath,
        tool: "apply_patch",
        toolPartId: part.id,
        executionTime,
        persisted: true,
      });
    }
  } catch {
    // The validation gate reports missing persisted mutation evidence.
  }
}

async function consumeRequestBudget() {
  const budgetPath = process.env.CODEX_SMOKE_REQUEST_BUDGET_PATH;
  const configuredMaxRequests = Number(process.env.CODEX_SMOKE_REQUEST_BUDGET_MAX ?? ${SMOKE_MAX_REQUESTS});
  const maxRequests = Number.isFinite(configuredMaxRequests) && configuredMaxRequests > 0
    ? Math.floor(configuredMaxRequests) : ${SMOKE_MAX_REQUESTS};
  if (!budgetPath) {
    if (state().totalRequests >= maxRequests) throw new Error("SMOKE_REQUEST_BUDGET_EXCEEDED");
    state().totalRequests += 1;
    return state().totalRequests;
  }
  let budget = { acceptedRequests: 0, maxRequests, exceeded: false };
  try { budget = JSON.parse(await readFile(budgetPath, "utf8")); } catch { /* initialize below */ }
  if (budget.exceeded || budget.acceptedRequests >= budget.maxRequests) {
    budget.exceeded = true;
    await writeFile(budgetPath, JSON.stringify(budget, null, 2));
    await record(evidencePath("budget-violations.jsonl"), { atMs: Date.now(), acceptedRequests: budget.acceptedRequests, maxRequests: budget.maxRequests });
    throw new Error("SMOKE_REQUEST_BUDGET_EXCEEDED");
  }
  budget.acceptedRequests += 1;
  await writeFile(budgetPath, JSON.stringify(budget, null, 2));
  state().totalRequests = budget.acceptedRequests;
  return budget.acceptedRequests;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return typeof input?.url === "string" ? input.url : "";
}

function requestMethod(input, init) {
  return String(init?.method ?? input?.method ?? "GET").toUpperCase();
}

async function requestBody(input, init) {
  try {
    const body = typeof init?.body === "string"
      ? init.body
      : input instanceof Request ? await input.clone().text() : "";
    return body ? JSON.parse(body) : {};
  } catch {
    return {};
  }
}

function safeInitBody(init) {
  if (typeof init?.body !== "string") return {};
  try {
    const parsed = JSON.parse(init.body);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function abortReasonName(signal) {
  const reason = signal?.reason;
  if (typeof reason?.name === "string" && reason.name) return reason.name;
  if (typeof reason?.constructor?.name === "string" && reason.constructor.name) return reason.constructor.name;
  return "AbortError";
}

function identityFieldForKey(key) {
  const normalized = String(key).toLowerCase().replace(/[-_]/g, "");
  if (normalized === "sessionid") return "sessionID";
  if (normalized === "generationid") return "generationID";
  if (normalized === "requestid") return "requestID";
  if (normalized === "traceid") return "traceID";
  return undefined;
}

function identityDigest(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function identityEntries(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.entries(record).flatMap(([key, value]) => {
    const field = identityFieldForKey(key);
    return field && typeof value === "string" && value
      ? [{ identityField: field, identityDigest: identityDigest(value) }]
      : [];
  });
}

const IDENTITY_HEADER_FIELDS: Array<[string, IdentityField]> = [
  ["x-session-id", "sessionID"],
  ["x_session_id", "sessionID"],
  ["session-id", "sessionID"],
  ["session_id", "sessionID"],
  ["x-generation-id", "generationID"],
  ["x_generation_id", "generationID"],
  ["generation-id", "generationID"],
  ["generation_id", "generationID"],
  ["x-request-id", "requestID"],
  ["x_request_id", "requestID"],
  ["request-id", "requestID"],
  ["request_id", "requestID"],
  ["x-trace-id", "traceID"],
  ["x_trace_id", "traceID"],
  ["trace-id", "traceID"],
  ["trace_id", "traceID"],
];

function headerNamesAndIdentities(input, init) {
  const names: string[] = [];
  const identities: Array<{ identityField: IdentityField; identityDigest: string }> = [];
  try {
    // Apply fetch's header override semantics without constructing/cloning a
    // Request: request construction can disturb body/stream state. Only the
    // allowlisted identifiers are read; other header names are not persisted.
    let sourceHeaders;
    if (init?.headers !== undefined) {
      sourceHeaders = init.headers;
    } else if (input instanceof Request) {
      sourceHeaders = input.headers;
    } else if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("unsupported fetch input for identity header inspection");
    }
    const effectiveHeaders = new Headers(sourceHeaders);
    for (const [headerName, field] of IDENTITY_HEADER_FIELDS) {
      const value = effectiveHeaders.get(headerName);
      if (!value) continue;
      names.push(headerName);
      identities.push({ identityField: field, identityDigest: identityDigest(value) });
    }
  } catch {
    return { names: [], identities: [], readable: false };
  }
  return { names: [...new Set(names)].sort(), identities, readable: true };
}

async function recordIdentityFetchTelemetry(input, init, body, responseStatus, evidenceRun, requestNumber, acceptedRequestNumber) {
  if (process.env.CODEX_IDENTITY_PROBE !== "1" && process.env.CODEX_SMOKE_RECORD_IDENTITY !== "1") return;
  const headerEvidence = headerNamesAndIdentities(input, init);
  const metadata = body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata : undefined;
  const observedIdentityValues = process.env.CODEX_SMOKE_RECORD_IDENTITY === "1"
    ? headerEvidence.identities
    : [...identityEntries(body), ...identityEntries(metadata), ...headerEvidence.identities];
  await record(evidencePath("identity-fetch-telemetry.jsonl"), {
    evidenceRun: evidenceRun ?? (process.env.CODEX_SMOKE_SCENARIO === "cancel" ? "cancellation" : "identity-probe"),
    atMs: Date.now(),
    requestNumber,
    acceptedRequestNumber,
    normalizedModel: normalizedModel(modelFor(body)),
    requestObjectType: input instanceof Request ? "Request" : input instanceof URL ? "URL" : typeof input,
    initObjectType: init === null ? "null" : typeof init,
    headerNames: headerEvidence.names,
    headerEvidenceReadable: headerEvidence.readable,
    jsonTopLevelKeys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : [],
    jsonMetadataKeys: metadata ? Object.keys(metadata).sort() : [],
    identitySource: process.env.CODEX_SMOKE_RECORD_IDENTITY === "1" ? "actual_outgoing_allowlisted_headers" : "allowlisted_fields_and_headers",
    identities: observedIdentityValues.filter((identity, index, all) => all.findIndex((candidate) =>
      candidate.identityField === identity.identityField && candidate.identityDigest === identity.identityDigest) === index),
    responseStatus: typeof responseStatus === "number" ? responseStatus : undefined,
  });
}

async function recordIdentityAbortTelemetry(input, init, signal) {
  if (process.env.CODEX_IDENTITY_PROBE !== "1") return;
  const body = await requestBody(input, init);
  const headerEvidence = headerNamesAndIdentities(input, init);
  const metadata = body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata : undefined;
  await record(evidencePath("aborted-fetch-telemetry.jsonl"), {
    requestObjectType: input instanceof Request ? "Request" : input instanceof URL ? "URL" : typeof input,
    initObjectType: init === null ? "null" : typeof init,
    headerNames: headerEvidence.names,
    headerEvidenceReadable: headerEvidence.readable,
    jsonTopLevelKeys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : [],
    jsonMetadataKeys: metadata ? Object.keys(metadata).sort() : [],
    identities: [...identityEntries(body), ...identityEntries(metadata), ...headerEvidence.identities],
    abortReason: abortReasonName(signal),
  });
}

function modelFor(body) {
  return typeof body?.model === "string" ? body.model : "unknown";
}

function normalizedModel(model) {
  if (model.includes("gpt-6.1-sol")) return "gpt-6.1-sol";
  if (model.includes("gpt-6-luna")) return "gpt-6-luna";
  return model;
}

function hasToolOutput(body, name) {
  function visit(value) {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== "object") return false;
    if ((value.type === "function_call" || value.type === "tool_call") && (value.name === name || value.tool === name)) return true;
    return Object.values(value).some(visit);
  }
  return visit(body?.input) || visit(body?.messages);
}

function sse(data) {
  return new Response(data.map((entry) => "event: " + entry.type + "\\n" + "data: " + JSON.stringify(entry) + "\\n\\n").join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function responseText(text, id) {
  const item = { type: "message", id, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
  const inProgress = { id, object: "response", status: "in_progress", model: "gpt-6-luna", output: [], usage: null };
  const completed = { ...inProgress, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return sse([
    { type: "response.created", response: inProgress },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id, status: "in_progress", role: "assistant", content: [] } },
    { type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ]);
}

function responseToolCall(name, args, id) {
  const item = { type: "function_call", id, call_id: id + "-call", name, arguments: JSON.stringify(args), status: "completed" };
  const inProgress = { id: id + "-response", object: "response", status: "in_progress", model: "gpt-6-luna", output: [], usage: null };
  const completed = { ...inProgress, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return sse([
    { type: "response.created", response: inProgress },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ]);
}

function quotaResponse() {
  return new Response(JSON.stringify({ error: { type: "usage_limit_reached" }, resets_in_seconds: ${SMOKE_SHORT_RESET_SECONDS} }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
}

const SmokeTransportPlugin = async () => {
   const installedBeforeProductionWrapper = Boolean(globalThis[REGISTRY_SYMBOL]);
   installFixtureNetworkGuard();
   const current = state();
   if (current.installed) return {};
   current.installed = true;
   await new Promise((resolve) => setTimeout(resolve, 0));
  await mkdir(process.env.CODEX_SMOKE_EVIDENCE_DIR ?? "evidence", { recursive: true });
  try {
    const packageJson = JSON.parse(await readFile(process.cwd() + "/node_modules/@prevalentware/opencode-goal-plugin/package.json", "utf8"));
    await writeFile(evidencePath("loaded-goal-plugin.json"), JSON.stringify({ package: "@prevalentware/opencode-goal-plugin", version: packageJson.version }, null, 2));
  } catch (error) {
    await record(evidencePath("fixture-errors.jsonl"), { kind: "goal-plugin-version-read", message: String(error) });
  }
   fixtureRequestHandler = async function smokeFetch(input, init) {
     const url = requestUrl(input);
     const method = requestMethod(input, init);
     if (url === CODEX_GENERATION_URL && method === "POST") {
       const signal = init && typeof init === "object" && "signal" in init
         ? init.signal
         : input instanceof Request ? input.signal : undefined;
        if (signal?.aborted) {
          const initBody = safeInitBody(init);
          if (process.env.CODEX_IDENTITY_PROBE === "1") {
            await recordIdentityAbortTelemetry(input, init, signal);
          } else {
            await record(evidencePath("aborted-fetch-attempts.jsonl"), {
              atMs: Date.now(),
              model: typeof initBody.model === "string" ? initBody.model : undefined,
              requestIdentity: { route: url, method },
              abortReason: abortReasonName(signal),
            });
          }
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const acceptedRequestNumber = await consumeRequestBudget();
        const body = await requestBody(input, init);
      const model = modelFor(body);
       const normalized = normalizedModel(model);
        let scenario = process.env.CODEX_SMOKE_SCENARIO === "cancel" ? "cancellation" : "parent";
        if (scenario === "cancellation") {
          try {
            const control = JSON.parse(await readFile(process.env.CODEX_SMOKE_PARALLEL_SESSION_CONTROL_PATH, "utf8"));
            const expectedSessionId = typeof control.sessionId === "string" ? control.sessionId : "";
            const effectiveHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
            const headers = new Headers(effectiveHeaders);
            const aliases = ["session-id", "x-session-id", "session_id", "x_session_id"];
            if (expectedSessionId && aliases.some((name) => headers.get(name) === expectedSessionId)) {
              scenario = "parallel";
            }
          } catch { /* Until B is created, all requests remain scoped to A. */ }
        }
        const isChild = normalized === "gpt-6-luna";
        const requestNumber = isChild ? ++current.childRequests : ++current.parentRequests;
        if (scenario === "cancellation") current.cancellationRequests += 1;
        if (scenario === "parallel") current.parallelRequests += 1;
        let response;
        let responseKind = "plain-text-sse";
        const parallelRequestSafe = !["create_goal", "task", "update_goal", "apply_patch", "write", "edit"]
          .some((toolName) => hasToolOutput(body, toolName));
        const patchText = "*** Begin Patch\\n*** Add File: " + MUTATION_PATH + "\\n+CODEX_SMOKE_CHILD_MUTATION\\n*** End Patch";
        if (scenario === "parallel") {
          response = responseText("Parallel session B completed without mutation.", "parallel-session-b-final");
        } else if (isChild && scenario === "cancellation" && !current.quotaSent) {
          current.quotaSent = true;
          await record(evidencePath("quota-responses.jsonl"), { type: "usage_limit_reached", status: 429, resetsInSeconds: ${SMOKE_SHORT_RESET_SECONDS}, requestNumber, atMs: Date.now() });
          response = quotaResponse();
          responseKind = "json-quota";
        } else if (isChild && scenario === "cancellation") {
          response = responseToolCall("apply_patch", { patchText }, "cancel-patch");
          responseKind = "tool-call-sse";
        } else if (isChild && !hasToolOutput(body, "apply_patch")) {
          if (!current.quotaSent) {
            current.quotaSent = true;
            await record(evidencePath("quota-responses.jsonl"), { type: "usage_limit_reached", status: 429, resetsInSeconds: ${SMOKE_SHORT_RESET_SECONDS}, requestNumber, atMs: Date.now() });
            response = quotaResponse();
            responseKind = "json-quota";
          } else {
            response = responseToolCall("apply_patch", { patchText }, "child-patch");
            responseKind = "tool-call-sse";
          }
        } else if (isChild && hasToolOutput(body, "apply_patch")) {
          response = responseText("Child mutation completed once.", "child-final");
        } else if (hasToolOutput(body, "update_goal")) {
          response = responseText("Parent received the child result and completed the goal.", "parent-final");
        } else if (hasToolOutput(body, "apply_patch")) {
          response = responseText("Child mutation completed once.", "child-final");
        } else if (hasToolOutput(body, "task")) {
          response = responseToolCall("update_goal", {
            status: "complete",
            evidence: "The general child completed the isolated marker-file patch; the parent verified the child task and persisted mutation evidence.",
          }, "parent-complete");
          responseKind = "tool-call-sse";
        } else if (hasToolOutput(body, "create_goal")) {
          response = responseToolCall("task", {
            description: "${SMOKE_CHILD_TASK_DESCRIPTION}",
            prompt: "Use exactly one child task. Apply one marker-file patch in the isolated workspace with the native apply_patch tool, then report completion.",
            subagent_type: "general",
          }, "parent-task");
          responseKind = "tool-call-sse";
        } else {
          response = responseToolCall("create_goal", { objective: "${SMOKE_GOAL_OBJECTIVE}" }, "parent-goal");
          responseKind = "tool-call-sse";
        }
        const responseStatus = response.status;
        await record(evidencePath("request-timeline.jsonl"), {
          at: new Date().toISOString(), atMs: Date.now(), evidenceRun: scenario,
          requestNumber, acceptedRequestNumber, route: url, method, rawModel: model, normalizedModel: normalized,
          callKind: hasToolOutput(body, "update_goal") ? "after-update" : hasToolOutput(body, "apply_patch") ? "after-patch" : hasToolOutput(body, "task") ? "after-task" : hasToolOutput(body, "create_goal") ? "after-goal" : "initial",
          productionWrapperObserved: Boolean(globalThis[REGISTRY_SYMBOL]),
          fixtureRegistryObserved: Boolean(globalThis[FIXTURE_SYMBOL]),
          responseStatus, responseKind, parallelRequestSafe,
        });
        await recordIdentityFetchTelemetry(input, init, body, responseStatus, scenario, requestNumber, acceptedRequestNumber);
        return response;
    }
     throw new Error("SMOKE_EXTERNAL_NETWORK_DENIED");
  };
   fixtureReady = true;
   Object.defineProperty(globalThis.fetch, "smokeFixtureInstalled", { value: true });
   Object.defineProperty(globalThis, FIXTURE_SYMBOL, { configurable: true, value: { handler: fixtureRequestHandler, state: current } });
  await mkdir(process.env.CODEX_SMOKE_EVIDENCE_DIR ?? "evidence", { recursive: true });
  let workspaceGitRoot = false;
  try {
    await readFile(process.cwd() + "/.git/HEAD", "utf8");
    workspaceGitRoot = true;
  } catch { /* the isolated root evidence remains false and blocks the gate */ }
  await writeFile(evidencePath("fixture-installed.json"), JSON.stringify({
    exactRoute: CODEX_GENERATION_URL,
     installedBeforeProductionWrapper,
    workspaceGitRoot,
    loadOrder: ["00-codex-smoke-transport.ts", "10-codex-quota-retry.ts", "@prevalentware/opencode-goal-plugin@0.1.60"],
    externalNetwork: "denied",
    blockedExternalRequests: current.blockedExternalRequests,
    preflight: {
      noProvider: process.env.CODEX_SMOKE_NO_PROVIDER === "1",
      externalNetworkDenied: process.env.CODEX_SMOKE_EXTERNAL_NETWORK_DENIED === "1",
      pinnedRuntimeVerified: process.env.CODEX_SMOKE_RUNTIME_BUN === "1.3.13"
        && process.env.CODEX_SMOKE_RUNTIME_OPENCODE === "1.19.0"
        && process.env.CODEX_SMOKE_GOAL_PLUGIN_VERSION === "0.1.60",
    },
    }, null, 2));
    async function recordNativeEventCallback(event) {
      if (process.env.CODEX_IDENTITY_PROBE === "1") {
        const properties = event?.properties && typeof event.properties === "object" ? event.properties : {};
        const status = properties.status && typeof properties.status === "object" ? properties.status : {};
        const sessionId = typeof event?.sessionID === "string" ? event.sessionID
          : typeof event?.sessionId === "string" ? event.sessionId
            : typeof properties.sessionID === "string" ? properties.sessionID : undefined;
        const type = typeof event?.type === "string" ? event.type : "";
        if (sessionId && type === "session.status" && typeof status.type === "string") {
          // Keep only the minimal native shape needed by the existing cancellation
          // runner. Identity boundaries are derived later from this exact native
          // sessionStatusEvents stream, never injected from the abort request.
          await record(evidencePath("native-events.jsonl"), {
            capturedAtMs: Date.now(),
            eventId: typeof event?.id === "string" ? event.id : undefined,
            event: {
              type,
              properties: {
                sessionID: sessionId,
                status: {
                  type: status.type,
                  next: typeof status.next === "number" ? status.next : undefined,
                },
                },
              },
            });
          }
        return { safe: true };
      }
      const capturedAtMs = Date.now();
      const callbackFrame = { capturedAtMs, event };
      await record(evidencePath("native-events.jsonl"), callbackFrame);
      return callbackFrame;
   }
   return { event: async ({ event }) => {
      const callbackFrame = await recordNativeEventCallback(event);
      if (process.env.CODEX_IDENTITY_PROBE !== "1") await recordCompletedWriteEvidence(callbackFrame.event);
    } };
};

function installFixtureNetworkGuard() {
  if (smokeGuardInstalled) return;
  const original = globalThis.fetch;
  const smokeFetch = async function fixtureNetworkGuard(input, init) {
    const url = requestUrl(input);
    if (url === CODEX_GENERATION_URL) {
      if (!fixtureReady || !fixtureRequestHandler) throw new Error("SMOKE_FIXTURE_NOT_READY");
      return fixtureRequestHandler.call(this, input, init);
    }
    if (isStrictLoopbackUrl(url)) return original.call(this, input, init);
    throw new Error("SMOKE_EXTERNAL_NETWORK_DENIED");
  };
  globalThis.fetch = smokeFetch;
  smokeGuardInstalled = true;
}

installFixtureNetworkGuard();

export default SmokeTransportPlugin;
`;
}

function smokeConfig(): Record<string, unknown> {
  return {
    "$schema": "https://opencode.ai/config.json",
    "model": SMOKE_PARENT_MODEL,
    "default_agent": "build",
    "agent": {
      "general": { "mode": "subagent", "model": SMOKE_CHILD_MODEL },
    },
     "plugin": [
       "./.opencode/plugins/00-codex-smoke-transport.ts",
       "./.opencode/plugins/10-codex-quota-retry.ts",
       ["@prevalentware/opencode-goal-plugin", {
       "auto_continue": true,
       "defer_while_tasks_active": true,
       "max_task_block_seconds": 3600,
       "max_prompt_failures": 3,
       "max_goal_duration_seconds": 360000,
       "restricted_agents": ["plan"],
       "allow_goal_execution_from_plan": false,
       }]
     ],
  };
}

async function writeSyntheticAuth(dataRoot: string): Promise<void> {
  await mkdir(join(dataRoot, "opencode"), { recursive: true });
  await writeFile(join(dataRoot, "opencode", "auth.json"), JSON.stringify({
    openai: {
      type: "oauth",
      access: "SMOKE_SYNTHETIC_ACCESS_TOKEN",
      refresh: "SMOKE_SYNTHETIC_REFRESH_TOKEN",
      expires: Date.now() + 86_400_000,
    },
  }, null, 2));
}

async function copyPinnedGoalPlugin(workspace: string): Promise<{ source: string; version: string }> {
  const home = Bun.env.HOME ?? "";
  const source = join(home, ".cache", "opencode", "packages", "@prevalentware",
    "opencode-goal-plugin@0.1.60", "node_modules", "@prevalentware", "opencode-goal-plugin");
  const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { version?: string };
  assert.equal(packageJson.version, "0.1.60", "pinned goal plugin version must be 0.1.60");
  const destination = join(workspace, "node_modules", "@prevalentware", "opencode-goal-plugin");
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  return { source, version: packageJson.version };
}

async function writeSmokeWorkspace(runDir: string): Promise<{
  workspace: string;
  dataRoot: string;
  configRoot: string;
  cacheRoot: string;
  stateRoot: string;
  mutationPath: string;
  fixturePath: string;
  configPath: string;
  goalPlugin: { source: string; version: string };
}> {
  const workspace = join(runDir, "workspace");
  const dataRoot = join(runDir, "data");
  const configRoot = join(runDir, "config");
  const cacheRoot = join(runDir, "cache");
  const stateRoot = join(runDir, "state");
  const mutationPath = join(workspace, "smoke-child-mutation.txt");
  await mkdir(join(workspace, ".opencode", "plugins"), { recursive: true });
  await mkdir(join(workspace, ".opencode", "lib"), { recursive: true });
  await mkdir(join(runDir, "evidence"), { recursive: true });
  initSmokeGitRoot(workspace);

  const root = smokeProjectRoot();
  await cp(join(root, ".opencode", "lib", "codex-quota-retry.ts"),
    join(workspace, ".opencode", "lib", "codex-quota-retry.ts"));
  await cp(join(root, ".opencode", "plugins", "codex-quota-retry.ts"),
    join(workspace, ".opencode", "plugins", "10-codex-quota-retry.ts"));
  const fixturePath = join(workspace, ".opencode", "plugins", "00-codex-smoke-transport.ts");
  await writeFile(fixturePath, smokeTransportPluginSource(mutationPath));
  const configPath = join(workspace, "opencode.json");
  await writeFile(configPath, JSON.stringify(smokeConfig(), null, 2));
  const goalPlugin = await copyPinnedGoalPlugin(workspace);
  await writeSyntheticAuth(dataRoot);
  await writeFile(join(runDir, "plugin-load-order.json"), JSON.stringify({
    expected: ["00-codex-smoke-transport.ts", "10-codex-quota-retry.ts", "@prevalentware/opencode-goal-plugin@0.1.60"],
    projectRoot: ".git",
    provider: "none",
  }, null, 2));
  await writeFile(join(runDir, "process-manifest.json"), JSON.stringify({
    schema: "codex-quota-retry-process-manifest.v1",
    processes: [],
  }, null, 2));
  await writeFile(join(runDir, "expected-scenarios.json"), JSON.stringify({
    schema: SMOKE_SCHEMA,
    installedLiveProofRequired: true,
    shortDeadline: {
      resetSeconds: SMOKE_SHORT_RESET_SECONDS,
      mandatoryGraceMs: SMOKE_GRACE_MS,
      expectedMinimumWaitMs: SMOKE_GRACE_MS + SMOKE_SHORT_RESET_SECONDS * 1000,
    },
    parent: { model: SMOKE_PARENT_MODEL, agent: "primary" },
    child: { model: SMOKE_CHILD_MODEL, agent: SMOKE_CHILD_AGENT },
    goal: { objective: SMOKE_GOAL_OBJECTIVE, terminalStatus: "complete" },
    childTask: { description: SMOKE_CHILD_TASK_DESCRIPTION, subagentType: SMOKE_CHILD_AGENT },
    cancellation: { session: "A", exactIdentityRequired: true, nativeAbortBeforeDeadline: true, noLaterOutbound: true },
    parallel: {
      session: "B",
      sameServerProcess: true,
      createWhileAIsPendingOrCancelled: true,
      differentNativeIdentity: true,
      submitAfterSharedCooldownExpiry: true,
      response: "non-mutating plaintext",
    },
    identityEvidence: {
      file: "evidence/cancellation/identity-fetch-telemetry.jsonl",
      allowedValues: "identity field names and SHA-256 digests only",
      rawHeadersOrIdsPersisted: false,
    },
    requestBudget: { maxRequests: SMOKE_MAX_REQUESTS, scope: "combined-parent-and-cancellation" },
    pluginLoadOrder: ["00-codex-smoke-transport.ts", "10-codex-quota-retry.ts", "@prevalentware/opencode-goal-plugin@0.1.60"],
    sharedCooldown: true,
    noProvider: true,
    maxRuntimeMs: SMOKE_MAX_RUNTIME_MS,
    evidence: SMOKE_EVIDENCE_PATHS,
  }, null, 2));
  return { workspace, dataRoot, configRoot, cacheRoot, stateRoot, mutationPath, fixturePath, configPath, goalPlugin };
}

function readJsonLines(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed)];
    } catch {
      return [];
    }
  });
}

function collectSessionEvidence(value: unknown, output: { ids: Set<string>; parentIds: Set<string>; retry: boolean; nextRetry: unknown[] }): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSessionEvidence(entry, output));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /retry|quota|waiting/i.test(value)) output.retry = true;
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && /session.?id|generation.?id/i.test(key)) output.ids.add(child);
    if (typeof child === "string" && /parent.?id/i.test(key)) output.parentIds.add(child);
    if (/retry|quota|waiting/i.test(key)) output.retry = true;
    if (/next.?retry|retry.?at|retry.?timestamp/i.test(key)) output.nextRetry.push(child);
    collectSessionEvidence(child, output);
  }
}

type OwnedChild = {
  pid?: number;
  stdout?: { on: (event: string, listener: (chunk: Buffer) => void) => unknown };
  stderr?: { on: (event: string, listener: (chunk: Buffer) => void) => unknown };
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  once: (event: string, listener: (...args: any[]) => void) => unknown;
  kill: (signal?: string) => boolean;
};

type OwnedProcessManifestEntry = {
  pid: number | null;
  role: string;
  workspace: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "exited" | "spawnerror" | "cleanup_timeout";
  timedOut?: boolean;
  termSent?: boolean;
  killSent?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  spawnError?: string;
};

type OwnedProcessOptions = {
  runDir?: string;
  role?: string;
  deadlineAtMs?: number;
  spawnImpl?: (file: string, args: string[], options: Record<string, unknown>) => OwnedChild;
  termGraceMs?: number;
  killSettleMs?: number;
  streamCloseGraceMs?: number;
};

type OwnedChildObservation = {
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  closeSeen: boolean;
  spawnError?: string;
  exitPromise: Promise<void>;
  closePromise: Promise<void>;
};

async function updateOwnedProcessManifest(
  runDir: string | undefined,
  entry: OwnedProcessManifestEntry,
): Promise<void> {
  if (!runDir) return;
  const path = join(runDir, "process-manifest.json");
  let processes: OwnedProcessManifestEntry[] = [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { processes?: unknown };
    if (Array.isArray(parsed.processes)) {
      processes = parsed.processes.filter((value): value is OwnedProcessManifestEntry => Boolean(value && typeof value === "object"));
    }
  } catch {
    // The first owned process creates the manifest.
  }
  const index = processes.findIndex((value) => value.pid === entry.pid && value.role === entry.role);
  if (index >= 0) processes[index] = entry;
  else processes.push(entry);
  await writeFile(path, JSON.stringify({ schema: "codex-quota-retry-process-manifest.v1", processes }, null, 2));
}

function observeOwnedChild(child: OwnedChild): OwnedChildObservation {
  let resolveExit!: () => void;
  let resolveClose!: () => void;
  let exitSettled = false;
  let closeSettled = false;
  const observation: OwnedChildObservation = {
    exitCode: undefined,
    signal: undefined,
    closeSeen: false,
    exitPromise: new Promise<void>((resolvePromise) => { resolveExit = resolvePromise; }),
    closePromise: new Promise<void>((resolvePromise) => { resolveClose = resolvePromise; }),
  };
  child.once("exit", (code: number | null, signal: string | null) => {
    observation.exitCode = code;
    observation.signal = signal;
    if (!exitSettled) {
      exitSettled = true;
      resolveExit();
    }
  });
  child.once("close", (code: number | null, signal: string | null) => {
    observation.closeSeen = true;
    if (observation.exitCode === undefined) observation.exitCode = code;
    if (observation.signal === undefined) observation.signal = signal;
    if (!closeSettled) {
      closeSettled = true;
      resolveClose();
    }
  });
  child.once("error", (error: Error) => {
    observation.spawnError = error.message;
    if (!exitSettled) {
      exitSettled = true;
      resolveExit();
    }
  });
  return observation;
}

async function waitForOwnedExit(observation: OwnedChildObservation, timeoutMs: number): Promise<boolean> {
  if (observation.exitCode !== undefined || observation.spawnError) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observation.exitPromise.then(() => true),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForOwnedStreams(observation: OwnedChildObservation, timeoutMs: number): Promise<boolean> {
  if (observation.closeSeen) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observation.closePromise.then(() => true),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalOwnedChild(child: OwnedChild, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    // This is deliberately the direct child handle returned by spawn; no PID lookup or group kill is allowed.
    return child.kill(signal);
  } catch {
    return false;
  }
}

async function cleanupOwnedChild(
  child: OwnedChild,
  observation: OwnedChildObservation,
  options: OwnedProcessOptions,
): Promise<{ termSent: boolean; killSent: boolean; cleanupTimedOut: boolean }> {
  const termGraceMs = Math.min(OWNED_PROCESS_TERM_GRACE_MS, Math.max(0, options.termGraceMs ?? OWNED_PROCESS_TERM_GRACE_MS));
  const killSettleMs = Math.max(0, options.killSettleMs ?? OWNED_PROCESS_KILL_SETTLE_MS);
  const streamCloseGraceMs = Math.max(0, options.streamCloseGraceMs ?? OWNED_PROCESS_STREAM_CLOSE_GRACE_MS);
  let termSent = false;
  let killSent = false;
  let cleanupTimedOut = false;
  if (!observation.spawnError && observation.exitCode === undefined) {
    termSent = signalOwnedChild(child, "SIGTERM");
    const exitedAfterTerm = await waitForOwnedExit(observation, termGraceMs);
    if (!exitedAfterTerm && observation.exitCode === undefined && !observation.spawnError) {
      killSent = signalOwnedChild(child, "SIGKILL");
      const exitedAfterKill = await waitForOwnedExit(observation, killSettleMs);
      if (!exitedAfterKill && observation.exitCode === undefined) cleanupTimedOut = true;
    }
  }
  const streamsClosed = await waitForOwnedStreams(observation, streamCloseGraceMs);
  if (!streamsClosed) cleanupTimedOut = true;
  return { termSent, killSent, cleanupTimedOut };
}

async function runOpenCodeProcess(
  opencodeBin: string,
  workspace: string,
  env: Record<string, string>,
  prompt: string,
  timeoutMs: number,
  command?: string,
  options: OwnedProcessOptions = {},
): Promise<SmokeProcessResult> {
  const commandArgs = command ? ["--command", command] : [];
  const spawnProcess = options.spawnImpl ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions as never) as unknown as OwnedChild);
  const child = spawnProcess(opencodeBin, ["run", "--format", "json", "--dir", workspace,
    "--model", SMOKE_PARENT_MODEL, ...commandArgs, prompt], {
    cwd: workspace,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
  const observation = observeOwnedChild(child);
  const role = options.role ?? "opencode";
  const startedAt = new Date().toISOString();
  const manifestEntry: OwnedProcessManifestEntry = {
    pid: typeof child.pid === "number" ? child.pid : null,
    role,
    workspace,
    startedAt,
    status: "running",
  };
  // Persist ownership before awaiting process completion so an interrupted harness leaves recovery evidence.
  await updateOwnedProcessManifest(options.runDir, manifestEntry);
  const remainingMs = options.deadlineAtMs === undefined
    ? timeoutMs
    : Math.min(timeoutMs, Math.max(0, options.deadlineAtMs - Date.now()));
  let timedOut = false;
  let cleanup: { termSent: boolean; killSent: boolean; cleanupTimedOut: boolean } = {
    termSent: false,
    killSent: false,
    cleanupTimedOut: false,
  };
  try {
    const exited = await waitForOwnedExit(observation, remainingMs);
    if (!exited) {
      timedOut = true;
      cleanup = await cleanupOwnedChild(child, observation, options);
    } else {
      const streamsClosed = await waitForOwnedStreams(observation, options.streamCloseGraceMs ?? OWNED_PROCESS_STREAM_CLOSE_GRACE_MS);
      if (!streamsClosed) cleanup.cleanupTimedOut = true;
    }
    const result: SmokeProcessResult = {
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode: observation.exitCode ?? null,
      signal: observation.signal ?? null,
      timedOut,
      spawnError: observation.spawnError,
    };
    await updateOwnedProcessManifest(options.runDir, {
      ...manifestEntry,
      endedAt: new Date().toISOString(),
      status: observation.spawnError ? "spawnerror" : cleanup.cleanupTimedOut ? "cleanup_timeout" : "exited",
      timedOut,
      termSent: cleanup.termSent,
      killSent: cleanup.killSent,
      exitCode: result.exitCode,
      signal: result.signal,
      spawnError: result.spawnError,
    });
    return result;
  } finally {
    if (options.runDir) {
      await writeFile(join(options.runDir, `${role}-partial-stdout.log`), Buffer.concat(stdoutChunks));
      await writeFile(join(options.runDir, `${role}-partial-stderr.log`), Buffer.concat(stderrChunks));
    }
  }
}

class MockOwnedChild extends EventEmitter implements OwnedChild {
  readonly pid = 61_001;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  readonly emitExitOnKill: boolean;

  constructor(emitExitOnKill: boolean) {
    super();
    this.emitExitOnKill = emitExitOnKill;
  }

  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    if (signal === "SIGKILL" && this.emitExitOnKill) {
      this.emit("exit", 137, "SIGKILL");
    }
    return true;
  }
}

async function testOwnedProcessCleanupContract(runDir: string): Promise<void> {
  const cleanupDir = join(runDir, "owned-process-tests");
  await mkdir(cleanupDir, { recursive: true });
  const stubborn = new MockOwnedChild(true);
  stubborn.stdout.write("partial stdout before deadline\n");
  stubborn.stderr.write("partial stderr before deadline\n");
  const deadlineResult = await runOpenCodeProcess(
    "mock-opencode",
    join(cleanupDir, "workspace"),
    {},
    "deadline cleanup fixture",
    5,
    undefined,
    {
      runDir: cleanupDir,
      role: "deadline-fixture",
      spawnImpl: () => stubborn,
      termGraceMs: 10,
      killSettleMs: 10,
      streamCloseGraceMs: 10,
    },
  );
  assert.equal(deadlineResult.timedOut, true, "owned child timeout must be recorded");
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"], "SIGKILL follows bounded SIGTERM grace on the direct child handle");
  assert.match(deadlineResult.stdout, /partial stdout/);
  assert.match(deadlineResult.stderr, /partial stderr/);
  assert.equal(deadlineResult.exitCode, 137, "partial exit state must survive missing close event");
  assert.equal(deadlineResult.signal, "SIGKILL");

  const spawnFailure = new MockOwnedChild(false);
  queueMicrotask(() => spawnFailure.emit("error", new Error("mock spawn failure")));
  const spawnErrorResult = await runOpenCodeProcess(
    "mock-opencode",
    join(cleanupDir, "workspace"),
    {},
    "spawn error fixture",
    100,
    undefined,
    { runDir: cleanupDir, role: "spawn-error-fixture", spawnImpl: () => spawnFailure, streamCloseGraceMs: 10 },
  );
  assert.equal(spawnErrorResult.spawnError, "mock spawn failure");
  assert.deepEqual(spawnFailure.signals, [], "spawn errors must not signal an unstarted child");

  const manifest = JSON.parse(await readFile(join(cleanupDir, "process-manifest.json"), "utf8")) as {
    processes?: Array<Record<string, unknown>>;
  };
  const deadlineEntry = manifest.processes?.find((entry) => entry.role === "deadline-fixture");
  const spawnErrorEntry = manifest.processes?.find((entry) => entry.role === "spawn-error-fixture");
  assert.equal(deadlineEntry?.pid, stubborn.pid);
  assert.equal(deadlineEntry?.workspace, join(cleanupDir, "workspace"));
  assert.equal(deadlineEntry?.timedOut, true);
  assert.equal(deadlineEntry?.termSent, true);
  assert.equal(deadlineEntry?.killSent, true);
  assert.equal(spawnErrorEntry?.status, "spawnerror");
  assert.equal(await readFile(join(cleanupDir, "deadline-fixture-partial-stdout.log"), "utf8"), deadlineResult.stdout);
  assert.equal(await readFile(join(cleanupDir, "deadline-fixture-partial-stderr.log"), "utf8"), deadlineResult.stderr);
}

async function listJsonStateFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) output.push(path);
    }
  }
  await visit(root);
  return output.sort();
}

async function writeGoalStateSummary(stateRoot: string, runDir: string): Promise<void> {
  const files = await listJsonStateFiles(stateRoot);
  const summaries: Array<Record<string, unknown>> = [];
  const goalRecords: Array<Record<string, unknown>> = [];
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const summary: Record<string, unknown> = {
        path: relative(runDir, file).replaceAll("\\", "/"),
        keys: Object.keys(data).sort(),
      };
      if (data.goals && typeof data.goals === "object") {
        const goals = Object.entries(data.goals as Record<string, unknown>);
        summary.goals = goals.map(([goalId, goal]) => ({
          goalId,
          objective: goal && typeof goal === "object" && typeof (goal as Record<string, unknown>).objective === "string"
            ? (goal as Record<string, unknown>).objective : undefined,
          status: goal && typeof goal === "object" && typeof (goal as Record<string, unknown>).status === "string"
            ? (goal as Record<string, unknown>).status : "unknown",
        }));
        for (const [goalId, goal] of goals) {
          if (!goal || typeof goal !== "object") continue;
          const goalRecord = goal as Record<string, unknown>;
          goalRecords.push({
            sourcePath: relative(runDir, file).replaceAll("\\", "/"),
            goalId,
            objective: typeof goalRecord.objective === "string" ? goalRecord.objective : undefined,
            status: typeof goalRecord.status === "string" ? goalRecord.status : undefined,
            sessionId: typeof goalRecord.session_id === "string" ? goalRecord.session_id : undefined,
            parentSessionId: typeof goalRecord.parent_session_id === "string" ? goalRecord.parent_session_id : undefined,
          });
        }
      }
      for (const key of ["status", "goal_id", "session_id", "parent_session_id", "child_session_id", "model", "agent"]) {
        if (typeof data[key] === "string") summary[key] = data[key];
      }
      summaries.push(summary);
    } catch {
      // Keep state evidence metadata-only and fail closed in the verdict.
    }
  }
  await writeFile(join(runDir, "goal-state-summary.json"), JSON.stringify({ files: summaries, goalRecords }, null, 2));
}

type NativeEventEvidence = {
  sessionIds: Set<string>;
  parentSessionIds: Set<string>;
  childSessionIds: Set<string>;
  taskResultChildSessionIds: Set<string>;
  sessionParentRelations: Array<{ childSessionId: string; parentSessionId: string; source: string }>;
  completedToolParts: Array<{ id: string; name: string; status?: string; executionTime?: number; executionStartMs?: number; executionEndMs?: number; executionKey?: string }>;
  completedWriteParts: Array<{ id: string; sessionId?: string; executionTime?: number; executionStartMs?: number; executionEndMs?: number; executionKey?: string; filePaths: string[] }>;
  toolCalls: Array<{ id: string; name: string; input: unknown; status: string; sessionId?: string; executionTime?: number; executionStartMs?: number; executionEndMs?: number; executionKey?: string }>;
  retryEvents: Array<{ type: "retry"; next: number; atMs?: number; key?: string; sessionId?: string }>;
  sessionStatusEvents: Array<{ sessionId: string; status: string; capturedAtMs?: number; key?: string }>;
  cancellationEvents: Array<{ atMs?: number }>;
  continuationPromptCount: number;
};

function emptyNativeEventEvidence(): NativeEventEvidence {
  return {
    sessionIds: new Set(),
    parentSessionIds: new Set(),
    childSessionIds: new Set(),
    taskResultChildSessionIds: new Set(),
    sessionParentRelations: [],
    completedToolParts: [],
    completedWriteParts: [],
    toolCalls: [],
    retryEvents: [],
    sessionStatusEvents: [],
    cancellationEvents: [],
    continuationPromptCount: 0,
  };
}

function testNativeSessionAndWriteEvidenceCollectorContract(): void {
  const evidence = emptyNativeEventEvidence();
  const sessionCreated = {
    type: "session.created",
    properties: { info: { id: "native-child-session", parentID: "native-parent-session" } },
  };
  const completedPart = (executionTime: number) => ({
    type: "message.part.updated",
    sessionID: "native-child-session",
    properties: {
      part: {
        type: "tool",
        id: "native-patch-1",
        sessionID: "native-child-session",
        tool: "apply_patch",
        state: {
          status: "completed",
          time: { start: executionTime, end: executionTime + 10 },
          metadata: { files: [{ filePath: "smoke-child-mutation.txt" }] },
        },
      },
    },
  });
  collectNativeEventEvidence(sessionCreated, evidence);
  const nativeDto = completedPart(4242);
  collectNativeEventEvidence({ capturedAtMs: 5000, event: nativeDto }, evidence);
  collectNativeEventEvidence(nativeDto, evidence);
  assert.deepEqual([...evidence.sessionIds].sort(), ["native-child-session", "native-parent-session"]);
  assert.deepEqual(evidence.sessionParentRelations, [{
    childSessionId: "native-child-session",
    parentSessionId: "native-parent-session",
    source: "session.created.properties.info.parentID",
  }]);
  assert.equal(evidence.completedWriteParts.length, 1, "recursive native DTO views dedupe by id and state.time.start");
  assert.equal(evidence.completedWriteParts[0].id, "native-patch-1");
  assert.equal(evidence.completedWriteParts[0].sessionId, "native-child-session");
  assert.deepEqual(evidence.completedWriteParts[0].filePaths, ["smoke-child-mutation.txt"]);
  collectNativeEventEvidence(completedPart(4243), evidence);
  assert.equal(evidence.completedWriteParts.length, 2, "a repeated execution with a new executionTime remains visible");
  assert.equal(evidence.toolCalls.length, 2);
  assert.equal(evidence.toolCalls[0].status, "completed", "completed tool status comes from the native DTO");

  const retryDto = {
    id: "native-retry-event",
    type: "session.status",
    properties: {
      sessionID: "native-child-session",
      status: { type: "retry", attempt: 1, next: 9000 },
    },
  };
  collectNativeEventEvidence({ capturedAtMs: 6000, event: retryDto }, evidence);
  collectNativeEventEvidence(retryDto, evidence);
  assert.deepEqual(evidence.retryEvents, [{ type: "retry", next: 9000, atMs: 6000, key: "native-retry-event:9000", sessionId: "native-child-session" }]);

  const idleDto = {
    id: "native-idle-event",
    type: "session.status",
    properties: {
      sessionID: "native-child-session",
      status: { type: "idle" },
    },
  };
  collectNativeEventEvidence({ capturedAtMs: 7000, event: idleDto }, evidence);
  collectNativeEventEvidence(idleDto, evidence);
  assert.deepEqual(evidence.sessionStatusEvents, [
    {
      sessionId: "native-child-session",
      status: "retry",
      capturedAtMs: 6000,
      key: "native-retry-event:retry",
    },
    {
      sessionId: "native-child-session",
      status: "idle",
      capturedAtMs: 7000,
      key: "native-idle-event:idle",
    },
  ], "native status observations must retain callback capturedAtMs and session identity");
}

function collectNativeEventEvidence(value: unknown, output: NativeEventEvidence, inheritedAtMs?: number, inheritedSessionId?: string, inheritedEventId?: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectNativeEventEvidence(entry, output, inheritedAtMs, inheritedSessionId, inheritedEventId));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "capturedAtMs")
    && Object.prototype.hasOwnProperty.call(record, "event")
    && typeof record.capturedAtMs === "number") {
    collectNativeEventEvidence(record.event, output, record.capturedAtMs);
    return;
  }
  const atMs = typeof record.atMs === "number" ? record.atMs
    : typeof record.timestamp === "number" ? record.timestamp
      : typeof record.time === "number" ? record.time : inheritedAtMs;
  const eventId = typeof record.id === "string" ? record.id
    : typeof record.eventId === "string" ? record.eventId : inheritedEventId;
  const marker = [record.type, record.event, record.name, record.status]
    .filter((entry): entry is string => typeof entry === "string").join(" ");
  if (/cancel|abort/i.test(marker) || record.cancelled === true || record.aborted === true) {
    output.cancellationEvents.push({ atMs });
  }
  if (/continuation|resume/i.test(marker)) output.continuationPromptCount += 1;
  const properties = asObject(record.properties);
  const nestedStatus = asObject(properties?.status);
  const sessionId = typeof record.sessionID === "string" ? record.sessionID
    : typeof record.sessionId === "string" ? record.sessionId
      : typeof properties?.sessionID === "string" ? properties.sessionID : inheritedSessionId;
  if (sessionId) output.sessionIds.add(sessionId);
  const retryStatus = nestedStatus?.type === "retry"
    ? nestedStatus
    : record.type === "retry" ? record : undefined;
  if (retryStatus && typeof retryStatus.next === "number") {
    const retryIdentity = typeof record.id === "string" ? record.id : inheritedEventId ?? sessionId ?? "retry";
    const retryKey = `${retryIdentity}:${retryStatus.next}`;
    if (!output.retryEvents.some((event) => event.key === retryKey)) {
      output.retryEvents.push({ type: "retry", next: retryStatus.next, atMs, key: retryKey, sessionId });
    }
  }
  const statusType = typeof nestedStatus?.type === "string" ? nestedStatus.type
    : record.type === "session.idle" ? "idle"
      : /session\.(?:cancel|abort)/i.test(typeof record.type === "string" ? record.type : "")
        ? "cancelled" : undefined;
  if (sessionId && statusType) {
    const capturedAtMs = inheritedAtMs ?? atMs;
    const statusKey = `${eventId ?? sessionId}:${statusType}`;
    if (!output.sessionStatusEvents.some((event) => event.key === statusKey)) {
      output.sessionStatusEvents.push({ sessionId, status: statusType, capturedAtMs, key: statusKey });
    }
  }
  if (record.type === "session.created") {
    const properties = asObject(record.properties);
    const info = asObject(properties?.info);
    const createdSessionId = typeof info?.id === "string" ? info.id : undefined;
    const createdParentId = typeof info?.parentID === "string" ? info.parentID : undefined;
    if (createdSessionId) output.sessionIds.add(createdSessionId);
    if (createdParentId && createdSessionId) {
      output.sessionIds.add(createdParentId);
      output.parentSessionIds.add(createdParentId);
      output.childSessionIds.add(createdSessionId);
      output.sessionParentRelations.push({
        childSessionId: createdSessionId,
        parentSessionId: createdParentId,
        source: "session.created.properties.info.parentID",
      });
    }
  }
  const part = record.part ?? properties?.part;
  if (part && typeof part === "object") {
    const partRecord = part as Record<string, unknown>;
    const state = partRecord.state;
    const stateRecord = state && typeof state === "object" ? state as Record<string, unknown> : undefined;
    const stateStatus = typeof stateRecord?.status === "string" ? stateRecord.status : undefined;
    const isCompleted = stateStatus === "completed" || state === "completed";
    if (isCompleted && partRecord.type === "tool" && typeof partRecord.id === "string" && typeof partRecord.tool === "string") {
      const executionTime = typeof partRecord.executionTime === "number" ? partRecord.executionTime
        : typeof stateRecord?.executionTime === "number" ? stateRecord.executionTime : undefined;
      const executionStartMs = typeof stateRecord?.time === "object" && stateRecord.time
        && typeof (stateRecord.time as Record<string, unknown>).start === "number"
        ? (stateRecord.time as Record<string, number>).start : executionTime;
      const executionEndMs = typeof stateRecord?.time === "object" && stateRecord.time
        && typeof (stateRecord.time as Record<string, unknown>).end === "number"
        ? (stateRecord.time as Record<string, number>).end : undefined;
      const partSessionId = typeof partRecord.sessionID === "string" ? partRecord.sessionID : sessionId;
      const executionKey = `${partSessionId ?? "unknown"}:${partRecord.id}:${executionStartMs ?? executionEndMs ?? "unknown"}`;
      const sameExecution = <T extends { id: string; executionKey?: string }>(entry: T): boolean =>
        entry.id === partRecord.id && entry.executionKey === executionKey;
      if (!output.completedToolParts.some(sameExecution)) {
        output.completedToolParts.push({ id: partRecord.id, name: partRecord.tool, status: stateStatus, executionTime, executionStartMs, executionEndMs, executionKey });
      }
      if (!output.toolCalls.some(sameExecution)) {
        output.toolCalls.push({
          id: partRecord.id,
          name: partRecord.tool,
          status: stateStatus ?? "completed",
          input: partRecord.input ?? partRecord.arguments ?? partRecord.parameters ?? partRecord.args
            ?? stateRecord?.input ?? stateRecord?.arguments ?? stateRecord?.parameters,
          sessionId: partSessionId,
          executionTime,
          executionStartMs,
          executionEndMs,
          executionKey,
        });
      }
      const metadata = asObject(stateRecord?.metadata);
      const childSessionId = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined;
      if (partRecord.tool === "task" && childSessionId) output.taskResultChildSessionIds.add(childSessionId);
      if (partRecord.tool === "apply_patch") {
        const filePaths = Array.isArray(metadata?.files)
          ? metadata.files.flatMap((file) => {
            if (typeof file === "string") return [file];
            if (file && typeof file === "object" && typeof (file as Record<string, unknown>).filePath === "string") {
              return [(file as Record<string, string>).filePath];
            }
            return [];
          })
          : [];
        if (!output.completedWriteParts.some(sameExecution)) {
          output.completedWriteParts.push({ id: partRecord.id, sessionId: partSessionId, executionTime, executionStartMs, executionEndMs, executionKey, filePaths });
        }
      }
    }
  }
  Object.values(record).forEach((entry) => collectNativeEventEvidence(entry, output, atMs, sessionId, eventId));
}

async function readNativeEventEvidence(directory: string): Promise<NativeEventEvidence> {
  const output = emptyNativeEventEvidence();
  try {
    const lines = (await readFile(join(directory, "native-events.jsonl"), "utf8")).split("\n").filter(Boolean);
    lines.forEach((line) => {
      try { collectNativeEventEvidence(JSON.parse(line), output); } catch { /* evidence parser is fail-closed below */ }
    });
  } catch {
    // The final gate reports missing native evidence as BLOCKED.
  }
  return output;
}

async function readEvidenceJsonLines(path: string): Promise<Record<string, unknown>[]> {
  try {
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    return lines.flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

type SafeIdentityBoundaryRecord = {
  boundary?: string;
  identityField?: string;
  identityDigest?: string;
};

type SafeIdentityFetchRecord = {
  requestObjectType?: string;
  initObjectType?: string;
  headerNames?: string[];
  headerEvidenceReadable?: boolean;
  jsonTopLevelKeys?: string[];
  jsonMetadataKeys?: string[];
  identities?: Array<{ identityField?: string; identityDigest?: string }>;
  responseStatus?: number;
};

async function readSafeIdentityEvidence(directory: string): Promise<{
  observations: IdentityObservation[];
  fetchTelemetry: SafeIdentityFetchRecord[];
}> {
  const observations: IdentityObservation[] = [];
  const boundaryRecords = await readEvidenceJsonLines(join(directory, "identity-boundaries.jsonl"));
  for (const record of boundaryRecords as SafeIdentityBoundaryRecord[]) {
    if (!IDENTITY_BOUNDARIES.includes(record.boundary as IdentityBoundary)) continue;
    observations.push({
      boundary: record.boundary as IdentityBoundary,
      identityField: record.identityField as IdentityField | undefined,
      identityDigest: record.identityDigest,
    });
  }
  const fetchTelemetry = await readEvidenceJsonLines(join(directory, "identity-fetch-telemetry.jsonl")) as SafeIdentityFetchRecord[];
  const fetchIdentities = new Map<string, { identityField?: IdentityField; identityDigest?: string }>();
  let fetchRecordWithoutIdentity = false;
  for (const record of fetchTelemetry) {
    if (record.headerEvidenceReadable === false) fetchRecordWithoutIdentity = true;
    const identities = Array.isArray(record.identities) ? record.identities : [];
    if (identities.length === 0) {
      fetchRecordWithoutIdentity = true;
      continue;
    }
    for (const identity of identities) {
      const identityField = identity.identityField as IdentityField | undefined;
      const identityDigest = identity.identityDigest;
      fetchIdentities.set(`${identityField ?? ""}:${identityDigest ?? ""}`, { identityField, identityDigest });
    }
  }
  if (fetchRecordWithoutIdentity || fetchIdentities.size === 0) {
    observations.push({ boundary: "codex.fetch" });
  } else {
    for (const identity of fetchIdentities.values()) {
      observations.push({ boundary: "codex.fetch", ...identity });
    }
  }
  return { observations, fetchTelemetry };
}

async function readEvidenceJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function findFreePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => listener.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function fetchWithBoundedTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  deadlineAtMs?: number,
): Promise<Response> {
  const controller = new AbortController();
  const boundedMs = Math.min(timeoutMs, deadlineAtMs === undefined
    ? timeoutMs
    : Math.max(1, deadlineAtMs - Date.now()));
  const timer = setTimeout(() => controller.abort(), Math.max(1, boundedMs));
  const externalSignal = init?.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function awaitMessageResponse(
  request: Promise<Response>,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then(async (response) => ({ status: response.status, body: await response.text() })),
      new Promise<{ status: number; body: string }>((_, reject) => {
        timer = setTimeout(() => reject(new Error("aborted message did not settle")), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function responseJsonTopLevelKeys(response: Response): Promise<string[]> {
  try {
    const value = await response.clone().json() as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  } catch {
    return [];
  }
}

async function waitForOpenCodeServer(
  baseUrl: string,
  timeoutMs: number,
  deadlineAtMs?: number,
  onResponse?: (metadata: { status: number; jsonTopLevelKeys: string[] }) => void,
): Promise<{ status: number; jsonTopLevelKeys: string[] }> {
  const deadline = Math.min(Date.now() + timeoutMs, deadlineAtMs ?? Number.POSITIVE_INFINITY);
  let lastMetadata = { status: 0, jsonTopLevelKeys: [] as string[] };
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithBoundedTimeout(baseUrl + "/global/health", undefined,
        Math.min(1_000, Math.max(1, deadline - Date.now())), deadlineAtMs);
      lastMetadata = { status: response.status, jsonTopLevelKeys: await responseJsonTopLevelKeys(response) };
      onResponse?.(lastMetadata);
      if (response.ok) return lastMetadata;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const error = new Error("OpenCode server did not become healthy");
  Object.assign(error, { responseMetadata: lastMetadata });
  throw error;
}

async function runNativeCancellation(
  opencodeBin: string,
  workspace: string,
  env: Record<string, string>,
  runDir?: string,
  deadlineAtMs?: number,
  checkpoints: IdentityCheckpoint[] = [],
  ): Promise<{
    abortResponse: unknown;
  abortResponseStatus: number;
  abortSucceeded: boolean;
  abortRequestAtMs: number;
  abortResponseAtMs: number;
    messageResponse: unknown;
    serverExitCode: number | null;
    nativeRetryObserved: boolean;
    nativeCancelObserved: boolean;
    sessionId: string;
    parallelSessionId: string;
    serverPid?: number;
    parallelResponseStatus: number;
    parallelSubmittedAtMs: number;
    parallelRequestObservedAtMs?: number;
    parallelNativeSessionObserved: boolean;
    originalDeadlineMs?: number;
  monitoredUntilMs: number;
  cancellationRequestsAtAbort: number;
    cancellationRequestsAtDeadline: number;
    healthResponse: { status: number; jsonTopLevelKeys: string[] };
    sessionCreateResponse: { status: number; jsonTopLevelKeys: string[] };
}> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverChild = server as unknown as OwnedChild;
  const serverObservation = observeOwnedChild(serverChild);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  server.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  server.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const serverManifestEntry: OwnedProcessManifestEntry = {
    pid: typeof server.pid === "number" ? server.pid : null,
    role: "cancellation-server",
    workspace,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  await updateOwnedProcessManifest(runDir, serverManifestEntry);
  let messageDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let healthResponse = { status: 0, jsonTopLevelKeys: [] as string[] };
  let sessionCreateResponse = { status: 0, jsonTopLevelKeys: [] as string[] };
  try {
    healthResponse = await runIdentityStage(checkpoints, "server_startup", () =>
      waitForOpenCodeServer(baseUrl, IDENTITY_STARTUP_TIMEOUT_MS, deadlineAtMs, (metadata) => {
        healthResponse = metadata;
      }));
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) throw new SmokeDeadlineError();
    const session = await runIdentityStage(checkpoints, "session_create", async () => {
      const createTimeoutMs = deadlineAtMs === undefined
        ? IDENTITY_STARTUP_TIMEOUT_MS
        : remainingIdentityDeadlineMs(deadlineAtMs, IDENTITY_STARTUP_TIMEOUT_MS);
      const created = await fetchWithBoundedTimeout(baseUrl + "/session", { method: "POST" }, createTimeoutMs, deadlineAtMs);
      let payload: unknown;
      try { payload = await created.clone().json(); } catch { payload = undefined; }
      sessionCreateResponse = identityResponseMetadata(created.status, payload);
      if (!created.ok) throw new Error("session create response was not successful");
      const parsed = payload as { id?: string } | undefined;
      assert.equal(typeof parsed?.id, "string");
      return parsed as { id: string };
    });
    const messagePayload = buildNativeCancellationMessagePayload();
    testNativeCancellationMessagePayloadContract();
    const messageAbortController = new AbortController();
    messageDeadlineTimer = deadlineAtMs === undefined ? undefined : setTimeout(() => messageAbortController.abort(), Math.max(1, deadlineAtMs - Date.now()));
    const messageRequest = fetch(baseUrl + `/session/${session.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messagePayload),
      signal: messageAbortController.signal,
    });
    const timelinePath = join(env.CODEX_SMOKE_EVIDENCE_DIR, "request-timeline.jsonl");
    const timelineDeadline = Math.min(Date.now() + 20_000, deadlineAtMs ?? Number.POSITIVE_INFINITY);
    while (Date.now() < timelineDeadline) {
      try {
        const lines = (await readFile(timelinePath, "utf8")).split("\n").filter(Boolean);
        if (lines.some((line) => line.includes('"evidenceRun":"cancellation"'))) break;
      } catch { /* fixture is starting */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    const retryDeadline = Math.min(Date.now() + 5_000, deadlineAtMs ?? Number.POSITIVE_INFINITY);
    let nativeRetryObserved = false;
    while (Date.now() < retryDeadline) {
      const native = await readNativeEventEvidence(env.CODEX_SMOKE_EVIDENCE_DIR);
       nativeRetryObserved = native.retryEvents.some((event) => event.sessionId === session.id);
      if (nativeRetryObserved) break;
      try {
        const budget = JSON.parse(await readFile(env.CODEX_SMOKE_REQUEST_BUDGET_PATH, "utf8")) as { exceeded?: boolean };
        if (budget.exceeded) break;
      } catch { /* budget file is created by the fixture */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    const abortRequestAtMs = Date.now();
    const abort = await fetchWithBoundedTimeout(baseUrl + `/session/${session.id}/abort`, { method: "POST", signal: messageAbortController.signal }, 10_000, deadlineAtMs);
    const abortResponseText = await abort.text();
    let abortResponse: unknown = abortResponseText;
    try {
      abortResponse = JSON.parse(abortResponseText);
    } catch {
      // Preserve the bounded response text as evidence when the native endpoint returns non-JSON.
    }
    const abortResponseStatus = abort.status;
    const abortSucceeded = abort.ok;
    const abortResponseAtMs = Date.now();
    const messageResponse = await awaitMessageResponse(messageRequest, Math.min(10_000,
      Math.max(1, (deadlineAtMs ?? (Date.now() + 10_000)) - Date.now())));
    const nativeAfterMessage = await readNativeEventEvidence(env.CODEX_SMOKE_EVIDENCE_DIR);
    const cancellationRetry = nativeAfterMessage.retryEvents
      .filter((event) => event.sessionId === session.id && typeof event.next === "number")
      .sort((left, right) => left.next - right.next)[0];
    const originalDeadlineMs = cancellationRetry?.next;
    const nativeCancelObserved = await waitForNativeCancellationObserved({
      readEvents: async () => (await readNativeEventEvidence(env.CODEX_SMOKE_EVIDENCE_DIR)).sessionStatusEvents,
      sessionId: session.id,
      abortRequestAtMs,
      originalDeadlineMs,
      totalDeadlineAtMs: deadlineAtMs,
      maxWaitMs: 5_000,
      pollIntervalMs: 100,
    });
    if (!nativeCancelObserved) throw new Error("SMOKE_A_NATIVE_IDLE_NOT_OBSERVED_BEFORE_PARALLEL_SESSION");

    // Create B in this same server process while A is already natively idle but
    // still has a pending quota deadline. This raw control value stays private
    // to the fixture router and is not emitted into identity evidence.
    const controlPath = env.CODEX_SMOKE_PARALLEL_SESSION_CONTROL_PATH;
    if (!controlPath) throw new Error("SMOKE_PARALLEL_SESSION_CONTROL_PATH_MISSING");
    const parallelSession = await fetchWithBoundedTimeout(baseUrl + "/session", { method: "POST" }, 10_000, deadlineAtMs);
    const parallelPayload = await parallelSession.json() as { id?: unknown };
    if (!parallelSession.ok || typeof parallelPayload.id !== "string" || parallelPayload.id === session.id) {
      throw new Error("SMOKE_PARALLEL_SESSION_ID_INVALID");
    }
    await mkdir(dirname(controlPath), { recursive: true });
    await writeFile(controlPath, JSON.stringify({ sessionId: parallelPayload.id }));
    if (originalDeadlineMs !== undefined) {
      const routeResumeAtMs = originalDeadlineMs + 350;
      while (Date.now() < routeResumeAtMs && (deadlineAtMs === undefined || Date.now() < deadlineAtMs)) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) throw new SmokeDeadlineError();
    const parallelSubmittedAtMs = Date.now();
    const parallelMessage = await fetchWithBoundedTimeout(baseUrl + `/session/${parallelPayload.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildNativeCancellationMessagePayload()),
    }, 30_000, deadlineAtMs);
    const parallelResponseStatus = parallelMessage.status;
    await parallelMessage.text();
    const parallelNativeDeadline = Math.min(Date.now() + 5_000, deadlineAtMs ?? Number.POSITIVE_INFINITY);
    let parallelNativeSessionObserved = false;
    while (Date.now() < parallelNativeDeadline) {
      parallelNativeSessionObserved = (await readNativeEventEvidence(env.CODEX_SMOKE_EVIDENCE_DIR))
        .sessionIds.has(parallelPayload.id);
      if (parallelNativeSessionObserved) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    const finalTimeline = await readEvidenceJsonLines(join(env.CODEX_SMOKE_EVIDENCE_DIR, "request-timeline.jsonl"));
    const cancellationRequestsAtAbort = finalTimeline.filter((entry) => entry.responseStatus !== undefined && entry.evidenceRun === "cancellation" && typeof entry.atMs === "number" && entry.atMs <= abortRequestAtMs).length;
    const cancellationRequestsAtDeadline = finalTimeline.filter((entry) => entry.responseStatus !== undefined && entry.evidenceRun === "cancellation" && typeof entry.atMs === "number" && (originalDeadlineMs === undefined || entry.atMs <= originalDeadlineMs)).length;
    const native = await readNativeEventEvidence(env.CODEX_SMOKE_EVIDENCE_DIR);
    const parallelRequest = finalTimeline.find((entry) => entry.evidenceRun === "parallel");
    return {
      abortResponse,
      abortResponseStatus,
      abortSucceeded,
      abortRequestAtMs,
      abortResponseAtMs,
      messageResponse,
      serverExitCode: null,
      nativeRetryObserved,
      nativeCancelObserved,
      sessionId: session.id,
      parallelSessionId: parallelPayload.id,
      serverPid: typeof server.pid === "number" ? server.pid : undefined,
      parallelResponseStatus,
      parallelSubmittedAtMs,
      parallelRequestObservedAtMs: typeof parallelRequest?.atMs === "number" ? parallelRequest.atMs : undefined,
      parallelNativeSessionObserved,
      originalDeadlineMs,
      monitoredUntilMs: Date.now(),
      cancellationRequestsAtAbort,
      cancellationRequestsAtDeadline,
      healthResponse,
      sessionCreateResponse,
    };
  } finally {
    // The request timer is local to the cancellation session and must never survive server cleanup.
    // The variable is initialized only after the session request succeeds.
    if (messageDeadlineTimer) clearTimeout(messageDeadlineTimer);
    const cleanup = await cleanupOwnedChild(serverChild, serverObservation, {
      runDir,
      role: "cancellation-server",
      termGraceMs: OWNED_PROCESS_TERM_GRACE_MS,
      killSettleMs: OWNED_PROCESS_KILL_SETTLE_MS,
      streamCloseGraceMs: OWNED_PROCESS_STREAM_CLOSE_GRACE_MS,
    });
    await updateOwnedProcessManifest(runDir, {
      ...serverManifestEntry,
      endedAt: new Date().toISOString(),
      status: serverObservation.spawnError ? "spawnerror" : cleanup.cleanupTimedOut ? "cleanup_timeout" : "exited",
      termSent: cleanup.termSent,
      killSent: cleanup.killSent,
      exitCode: serverObservation.exitCode ?? null,
      signal: serverObservation.signal ?? null,
      spawnError: serverObservation.spawnError,
    });
    if (runDir) {
      await writeFile(join(runDir, "cancellation-server-stdout.log"), Buffer.concat(stdout));
      await writeFile(join(runDir, "server-stderr.log"), Buffer.concat(stderr));
    }
    if (!runDir) await writeFile(join(env.CODEX_SMOKE_EVIDENCE_DIR, "server-stderr.log"), Buffer.concat(stderr).toString("utf8"));
  }
}

function buildIsolatedEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (/API_KEY|AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) continue;
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overrides };
}

type SmokeToolCall = {
  id: string;
  name: string;
  input?: unknown;
  status?: string;
  sessionId?: string;
  executionTime?: number;
  executionStartMs?: number;
  executionEndMs?: number;
};

type SmokeEvidenceSnapshot = {
  totalElapsedMs?: number;
  maxRuntimeMs?: number;
  runtime?: { bun?: string; opencode?: string; goalPluginVersion?: string };
  preflight?: {
    noProvider?: boolean;
    externalNetworkDenied?: boolean;
    pinnedRuntimeVerified?: boolean;
    blockedExternalRequests?: number;
    workspaceGitRoot?: boolean;
    fixtureBeforeProduction?: boolean;
    observedLoadOrder?: string[];
  };
  requestBudget?: { acceptedRequests?: number; maxRequests?: number; exceeded?: boolean };
  requestTimeline?: Array<Record<string, unknown>>;
  quotaResponses?: Array<Record<string, unknown>>;
  native?: {
    sessionIds?: string[];
    parentSessionIds?: string[];
    childSessionIds?: string[];
    taskResultChildSessionIds?: string[];
    sessionParentRelations?: Array<{ childSessionId?: string; parentSessionId?: string; source?: string }>;
    completedToolParts?: Array<{ id?: string; name?: string }>;
    completedWriteParts?: Array<{ id?: string; sessionId?: string; filePaths?: string[] }>;
    retryEvents?: Array<{ next?: number; atMs?: number; sessionId?: string }>;
    sessionStatusEvents?: Array<{ sessionId?: string; status?: string; capturedAtMs?: number }>;
    cancellationEvents?: Array<{ atMs?: number }>;
    continuationPromptCount?: number;
    toolCalls?: SmokeToolCall[];
  };
  goalRecords?: Array<Record<string, unknown>>;
  sideEffects?: Array<Record<string, unknown>>;
  mutationFileText?: string;
  cancellation?: {
    nativeRetryObserved?: boolean;
    nativeCancelObserved?: boolean;
    sessionId?: string;
    abortRequestAtMs?: number;
    abortResponseAtMs?: number;
    abortResponseStatus?: number;
    abortSucceeded?: boolean;
    originalDeadlineMs?: number;
    monitoredUntilMs?: number;
    cancellationRequestsAtAbort?: number;
    cancellationRequestsAtDeadline?: number;
  };
  parallel?: {
    sessionId?: string;
    responseStatus?: number;
    submittedAtMs?: number;
    requestObservedAtMs?: number;
    nativeSessionObserved?: boolean;
    cancellationServerPid?: number;
    parallelServerPid?: number;
  };
  requestIdentityEvidence?: Array<{
    evidenceRun?: string;
    atMs?: number;
    requestNumber?: number;
    acceptedRequestNumber?: number;
    normalizedModel?: string;
    responseStatus?: number;
    headerEvidenceReadable?: boolean;
    headerNames?: string[];
    identities?: Array<{ identityField?: string; identityDigest?: string }>;
  }>;
};

type SmokeEvidenceValidation = {
  status: "PASS" | "FAIL" | "BLOCKED";
  missingRequiredEvidence: string[];
  failedAssertions: string[];
  assertions: Record<string, boolean>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolInputRecord(call: SmokeToolCall | undefined): Record<string, unknown> | undefined {
  return asObject(call?.input);
}

function mapFixturePreflight(
  fixtureInstalled: Record<string, unknown> | undefined,
  fixturePreflight: Record<string, unknown> | undefined,
  blockedExternalRequests: number,
): SmokeEvidenceSnapshot["preflight"] {
  return {
    noProvider: fixturePreflight?.noProvider === true,
    externalNetworkDenied: fixturePreflight?.externalNetworkDenied === true,
    pinnedRuntimeVerified: fixturePreflight?.pinnedRuntimeVerified === true,
    blockedExternalRequests,
    workspaceGitRoot: fixtureInstalled?.workspaceGitRoot === true,
    fixtureBeforeProduction: fixtureInstalled?.installedBeforeProductionWrapper === true,
    observedLoadOrder: Array.isArray(fixtureInstalled?.loadOrder)
      ? fixtureInstalled.loadOrder.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
}

function testActualFixturePreflightMappingContract(): void {
  const mapped = mapFixturePreflight({
    installedBeforeProductionWrapper: true,
    workspaceGitRoot: true,
    loadOrder: ["00-codex-smoke-transport.ts", "10-codex-quota-retry.ts", "@prevalentware/opencode-goal-plugin@0.1.60"],
  }, {
    noProvider: true,
    externalNetworkDenied: true,
    pinnedRuntimeVerified: true,
  }, 0);
  assert.equal(mapped?.fixtureBeforeProduction, true, "actual installed-before marker must map to true fixture-before evidence");
  assert.equal(mapped?.workspaceGitRoot, true);
  assert.equal(mapped?.blockedExternalRequests, 0);
  assert.deepEqual(mapped?.observedLoadOrder, [
    "00-codex-smoke-transport.ts",
    "10-codex-quota-retry.ts",
    "@prevalentware/opencode-goal-plugin@0.1.60",
  ]);

  assert.equal(mapFixturePreflight({ installedBeforeProductionWrapper: false }, undefined, 0)?.fixtureBeforeProduction, false,
    "false installed-before marker must fail closed");
  assert.equal(mapFixturePreflight({}, undefined, 0)?.fixtureBeforeProduction, false,
    "missing installed-before marker must fail closed");
}

function validateSmokeEvidence(evidence: SmokeEvidenceSnapshot): SmokeEvidenceValidation {
  const missingRequiredEvidence: string[] = [];
  const failedAssertions: string[] = [];
  const assertions: Record<string, boolean> = {};
  const requireEvidence = (condition: boolean, label: string): void => {
    if (!condition) missingRequiredEvidence.push(label);
  };
  const assertEvidence = (condition: boolean, label: string): void => {
    assertions[label] = condition;
    if (!condition) failedAssertions.push(label);
  };

  const runtime = evidence.runtime;
  const preflight = evidence.preflight;
  const requestTimeline = evidence.requestTimeline;
  const quotaResponses = evidence.quotaResponses;
  const requestBudget = evidence.requestBudget;
  const native = evidence.native;
  const goalRecords = evidence.goalRecords;
  const sideEffects = evidence.sideEffects;
  const cancellation = evidence.cancellation;
  const parallel = evidence.parallel;
  const requestIdentityEvidence = evidence.requestIdentityEvidence;
  requireEvidence(Boolean(runtime), "runtime");
  requireEvidence(typeof evidence.totalElapsedMs === "number" && typeof evidence.maxRuntimeMs === "number", "totalDeadline");
  requireEvidence(Boolean(preflight), "preflight");
  requireEvidence(Boolean(requestBudget), "requestBudget");
  requireEvidence(typeof requestBudget?.acceptedRequests === "number" && typeof requestBudget.maxRequests === "number", "requestBudget.values");
  requireEvidence(Array.isArray(requestTimeline) && requestTimeline.length > 0, "requestTimeline");
  requireEvidence(Array.isArray(quotaResponses) && quotaResponses.length > 0, "quotaResponses");
  requireEvidence(Boolean(native), "nativeEvents");
  requireEvidence(Array.isArray(native?.sessionIds), "nativeEvents.sessionIds");
  requireEvidence(Array.isArray(native?.parentSessionIds), "nativeEvents.parentSessionIds");
  requireEvidence(Array.isArray(native?.childSessionIds), "nativeEvents.childSessionIds");
  requireEvidence(Array.isArray(native?.taskResultChildSessionIds), "nativeEvents.taskResultChildSessionIds");
  requireEvidence(Array.isArray(native?.sessionParentRelations), "nativeEvents.sessionParentRelations");
  requireEvidence(Array.isArray(native?.completedToolParts), "nativeEvents.completedToolParts");
  requireEvidence(Array.isArray(native?.completedWriteParts), "nativeEvents.completedWriteParts");
  requireEvidence(Array.isArray(native?.retryEvents), "nativeEvents.retryEvents");
  requireEvidence(Array.isArray(native?.sessionStatusEvents), "nativeEvents.sessionStatusEvents");
  requireEvidence(Array.isArray(native?.cancellationEvents), "nativeEvents.cancellationEvents");
  requireEvidence(Array.isArray(native?.toolCalls), "nativeEvents.toolCalls");
  requireEvidence(typeof native?.continuationPromptCount === "number", "nativeEvents.continuationPromptCount");
  requireEvidence(Array.isArray(goalRecords) && goalRecords.length > 0, "goalRecords");
  requireEvidence(Array.isArray(sideEffects) && sideEffects.length > 0, "sideEffects");
  requireEvidence(typeof evidence.mutationFileText === "string", "mutationFile");
  requireEvidence(Boolean(cancellation), "cancellation");
  requireEvidence(Boolean(parallel), "parallelSession");
  requireEvidence(Array.isArray(requestIdentityEvidence) && requestIdentityEvidence.length > 0, "requestIdentityEvidence");
  if (missingRequiredEvidence.length > 0) {
    return { status: "BLOCKED", missingRequiredEvidence, failedAssertions, assertions };
  }

  const exactRequests = requestTimeline!.filter((entry) => entry.route === CODEX_GENERATION_URL);
  const parentRequests = exactRequests.filter((entry) => entry.evidenceRun === "parent");
  const cancellationRequests = exactRequests.filter((entry) => entry.evidenceRun === "cancellation");
  const actualQuotaResponses = quotaResponses!.filter((entry) => entry.status === 429 && entry.type === "usage_limit_reached");
  const actualQuotaRequests = exactRequests.filter((entry) => entry.responseStatus === 429);
  const toolCalls = native!.toolCalls!;
  const goalCalls = toolCalls.filter((call) => call.name === "create_goal");
  const taskCalls = toolCalls.filter((call) => call.name === "task");
  const patchCalls = toolCalls.filter((call) => call.name === "apply_patch");
  const childSessionIds = new Set(native!.childSessionIds!);
  const taskResultChildSessionIds = new Set(native!.taskResultChildSessionIds!);
  const childGoalTools = toolCalls.filter((call) => childSessionIds.has(call.sessionId ?? "")
    && (call.name === "create_goal" || call.name === "update_goal"));
  const goalRecordMatches = goalRecords!.filter((record) => record.objective === SMOKE_GOAL_OBJECTIVE);
  const finalGoalRecord = goalRecordMatches.find((record) => record.status === "complete");
  const hasFailedGoal = goalRecordMatches.some((record) => record.status === "failed" || record.status === "cancelled");
  const childModels = parentRequests
    .filter((entry) => entry.normalizedModel === "gpt-6-luna")
    .map((entry) => entry.normalizedModel);
  const taskInput = toolInputRecord(taskCalls[0]);
  const sideEffectIdentities = sideEffects!.map((entry) => entry.identity).filter((value): value is string => typeof value === "string");
  const uniqueSideEffectIdentities = new Set(sideEffectIdentities);
  const completedWriteParts = native!.completedWriteParts!;
  const cancellationSessionId = cancellation?.sessionId;
  const cancellationRetryEvents = native!.retryEvents!.filter((event) => event.sessionId === cancellationSessionId);
  const cancellationRetry = cancellationRetryEvents
    .filter((event) => typeof event.atMs === "number" && typeof event.next === "number")
    .sort((left, right) => (left.atMs as number) - (right.atMs as number))[0];
  const abortRequestAtMs = cancellation?.abortRequestAtMs;
  const abortResponseAtMs = cancellation?.abortResponseAtMs;
  const originalRetryDeadlineMs = cancellation?.originalDeadlineMs;
  const nativeCancelAfterRetry = cancellationRetry !== undefined
    && typeof abortRequestAtMs === "number"
    && typeof abortResponseAtMs === "number"
    && typeof originalRetryDeadlineMs === "number"
    && native!.sessionStatusEvents!.some((event) =>
      event.sessionId === cancellationSessionId
      && /^idle$/i.test(event.status ?? "")
      && typeof event.capturedAtMs === "number"
      && event.capturedAtMs >= (abortRequestAtMs as number)
      && event.capturedAtMs >= (cancellationRetry.atMs as number)
      && event.capturedAtMs < (originalRetryDeadlineMs as number));
  const cancellationQuotaRequests = cancellationRequests.filter((entry) => entry.responseStatus === 429);
  const parallelRequests = exactRequests.filter((entry) => entry.evidenceRun === "parallel");
  const parallelSessionDigest = parallel?.sessionId ? identityDigestForValue(parallel.sessionId) : undefined;
  const cancellationSessionDigest = cancellationSessionId ? identityDigestForValue(cancellationSessionId) : undefined;
  const safeIdentityEvidence = requestIdentityEvidence ?? [];
  const exactIdentityEvidence = exactRequests.map((request) => {
    const record = safeIdentityEvidence.find((entry) => entry.acceptedRequestNumber === request.acceptedRequestNumber
      && typeof request.acceptedRequestNumber === "number");
    const actualDigests = (record?.identities ?? []).filter((identity) => identity.identityField === "sessionID")
      .map((identity) => identity.identityDigest);
    return { request, record, actualDigests: [...new Set(actualDigests)] };
  });
  const everyRequestHasIdentity = exactIdentityEvidence.length === exactRequests.length
    && safeIdentityEvidence.length === exactRequests.length
    && new Set(safeIdentityEvidence.map((entry) => entry.acceptedRequestNumber)).size === safeIdentityEvidence.length
    && exactIdentityEvidence.every(({ request, record, actualDigests }) => record?.headerEvidenceReadable === true
      && record?.identitySource === "actual_outgoing_allowlisted_headers"
      && record?.responseStatus === request.responseStatus
      && actualDigests.length === 1 && typeof actualDigests[0] === "string");
  const cancellationRequestIdentityMatchesA = exactIdentityEvidence
    .filter(({ request }) => request.evidenceRun === "cancellation")
    .every(({ actualDigests }) => actualDigests.length === 1 && actualDigests[0] === cancellationSessionDigest);
  const parallelRequestIdentityMatchesB = exactIdentityEvidence
    .filter(({ request }) => request.evidenceRun === "parallel")
    .every(({ actualDigests }) => actualDigests.length === 1 && actualDigests[0] === parallelSessionDigest);
  const noSharedIdentity = typeof cancellationSessionDigest === "string"
    && typeof parallelSessionDigest === "string" && cancellationSessionDigest !== parallelSessionDigest;
  const parallelTimelineEntry = parallelRequests[0];
  const allParallelRequestsValid = parallelRequests.length >= 1 && parallelRequests.every((request) => {
    const matching = exactIdentityEvidence.find(({ request: observed }) =>
      observed.acceptedRequestNumber === request.acceptedRequestNumber);
    return request.responseStatus === 200
      && request.responseKind === "plain-text-sse"
      && request.parallelRequestSafe === true
      && matching?.actualDigests.length === 1
      && matching.actualDigests[0] === parallelSessionDigest;
  });
  const laterCancellationRequests = cancellationRequests.filter((entry) =>
    typeof entry.atMs === "number" && typeof abortRequestAtMs === "number" && entry.atMs > abortRequestAtMs);

  assertEvidence(runtime!.bun === "1.3.13" && runtime!.opencode === "1.19.0" && runtime!.goalPluginVersion === "0.1.60", "pinnedRuntimeVersions");
  assertEvidence(evidence.maxRuntimeMs! <= 240_000 && evidence.totalElapsedMs! <= evidence.maxRuntimeMs!, "totalDeadlineWithin240Seconds");
  assertEvidence(preflight!.noProvider === true && preflight!.externalNetworkDenied === true
    && preflight!.pinnedRuntimeVerified === true && preflight!.blockedExternalRequests === 0
    && preflight!.workspaceGitRoot === true && preflight!.fixtureBeforeProduction === true
    && JSON.stringify(preflight!.observedLoadOrder) === JSON.stringify(["00-codex-smoke-transport.ts", "10-codex-quota-retry.ts", "@prevalentware/opencode-goal-plugin@0.1.60"]), "offlinePreflightAndNoExternalNetwork");
  assertEvidence(requestBudget!.exceeded === false && requestBudget!.acceptedRequests! <= SMOKE_MAX_REQUESTS
    && requestBudget!.acceptedRequests === exactRequests.length
    && new Set(exactRequests.map((entry) => entry.acceptedRequestNumber)).size === exactRequests.length
    && requestBudget!.maxRequests === SMOKE_MAX_REQUESTS, "hardRequestBudget");
  assertEvidence(exactRequests.length > 0 && parentRequests.length > 0 && cancellationRequests.length > 0, "exactTransportRequests");
  assertEvidence(exactRequests.every((entry) => entry.productionWrapperObserved === true && entry.fixtureRegistryObserved === true), "productionRunsAfterFixture");
  assertEvidence(actualQuotaResponses.length >= 2 && actualQuotaRequests.length === actualQuotaResponses.length, "actualQuota429Responses");
  assertEvidence(native!.retryEvents!.length > 0 && native!.retryEvents!.every((event) => Number.isFinite(event.next) && Number.isFinite(event.atMs)), "nativeRetryStatusAndTimestamp");
  assertEvidence(cancellation!.nativeRetryObserved === true
    && cancellation!.nativeCancelObserved === true
    && cancellation!.abortSucceeded === true
    && cancellation!.abortResponseStatus !== undefined
    && cancellation!.abortResponseStatus >= 200
    && cancellation!.abortResponseStatus < 300
    && nativeCancelAfterRetry, "nativeCancellationAfterPendingRetry");
  assertEvidence(cancellation!.originalDeadlineMs !== undefined && cancellation!.monitoredUntilMs !== undefined
    && cancellation!.monitoredUntilMs >= cancellation!.originalDeadlineMs, "cancellationMonitoredThroughOriginalDeadline");
  assertEvidence(cancellationRequests.length === 1
    && cancellationQuotaRequests.length === 1
    && cancellation!.cancellationRequestsAtAbort === 1
    && cancellation!.cancellationRequestsAtDeadline === 1
     && laterCancellationRequests.length === 0, "noLaterCancellationRequest");
  assertEvidence(everyRequestHasIdentity, "everyOutboundRequestHasSafeObservedIdentity");
  assertEvidence(cancellationRequestIdentityMatchesA, "cancellationRequestsMatchNativeSessionA");
  assertEvidence(allParallelRequestsValid && parallel?.responseStatus === 200
    && typeof parallel?.submittedAtMs === "number" && typeof cancellation!.originalDeadlineMs === "number"
    && parallel.submittedAtMs > cancellation!.originalDeadlineMs + 250
    && parallelTimelineEntry?.responseStatus === 200
    && typeof parallelTimelineEntry.atMs === "number" && parallelTimelineEntry.atMs >= parallel.submittedAtMs,
    "sessionBPlaintextResponseAfterSharedCooldownExpiry");
  assertEvidence(noSharedIdentity && parallelRequestIdentityMatchesB && allParallelRequestsValid, "parallelSessionBHasDifferentObservedNativeIdentity");
  assertEvidence(parallel?.nativeSessionObserved === true, "parallelSessionBNativeSessionObserved");
  assertEvidence(typeof parallel?.cancellationServerPid === "number"
    && parallel.cancellationServerPid === parallel.parallelServerPid,
    "parallelSessionUsesSameServerProcess");
  assertEvidence(goalCalls.length === 1 && taskCalls.length === 1 && taskInput?.subagent_type === SMOKE_CHILD_AGENT
    && taskInput.description === SMOKE_CHILD_TASK_DESCRIPTION, "goalPluginActualToolsLoaded");
  assertEvidence(childGoalTools.length === 0, "childHasNoGoalLifecycleTools");
  assertEvidence(goalRecordMatches.length === 1 && finalGoalRecord !== undefined && !hasFailedGoal, "finalParentGoalComplete");
    assertEvidence(native!.sessionIds!.length === 2 && native!.parentSessionIds!.length === 1 && native!.childSessionIds!.length === 1
      && native!.sessionParentRelations!.length === 1
      && taskResultChildSessionIds.size === 1
      && native!.sessionParentRelations![0].source === "session.created.properties.info.parentID"
      && native!.sessionParentRelations![0].parentSessionId === native!.parentSessionIds![0]
      && native!.sessionParentRelations![0].childSessionId === native!.childSessionIds![0]
      && taskResultChildSessionIds.has(native!.childSessionIds![0]), "stableParentChildRelationship");
  assertEvidence(childModels.length > 0 && childModels.every((model) => model === SMOKE_CHILD_MODEL.replace("openai/", "")), "stableChildModel");
    assertEvidence(patchCalls.length === 1 && new Set(patchCalls.map((call) => call.id)).size === 1
      && native!.completedToolParts!.filter((part) => part.name === "apply_patch").length === 1
      && native!.completedToolParts!.filter((part) => part.name === "apply_patch")[0].id === patchCalls[0].id
      && completedWriteParts.length === 1 && completedWriteParts[0].id === patchCalls[0].id
      && completedWriteParts[0].filePaths?.some((path) => path.endsWith("smoke-child-mutation.txt")), "nativeMutationExactlyOnce");
    assertEvidence(sideEffects!.length === 1 && sideEffectIdentities.length === 1 && uniqueSideEffectIdentities.size === 1
      && sideEffects![0].tool === "apply_patch" && sideEffects![0].persisted === true
      && sideEffects![0].toolPartId === completedWriteParts[0].id, "sideEffectIdentityExactlyOnce");
  assertEvidence(evidence.mutationFileText === SMOKE_MUTATION_CONTENT, "persistedMutationExactlyOnce");
  assertEvidence(native!.continuationPromptCount === 0, "noContinuationPrompt");

  const status = failedAssertions.length > 0 ? "FAIL" : "PASS";
  return { status, missingRequiredEvidence, failedAssertions, assertions };
}

function smokeContractEvidenceFixture(): SmokeEvidenceSnapshot {
  return {
    totalElapsedMs: 1500,
    maxRuntimeMs: 220_000,
    runtime: { bun: "1.3.13", opencode: "1.19.0", goalPluginVersion: "0.1.60" },
    preflight: {
      noProvider: true,
      externalNetworkDenied: true,
      pinnedRuntimeVerified: true,
      blockedExternalRequests: 0,
      workspaceGitRoot: true,
      fixtureBeforeProduction: true,
      observedLoadOrder: ["00-codex-smoke-transport.ts", "10-codex-quota-retry.ts", "@prevalentware/opencode-goal-plugin@0.1.60"],
    },
    requestBudget: { acceptedRequests: 4, maxRequests: SMOKE_MAX_REQUESTS, exceeded: false },
    requestTimeline: [
      { route: CODEX_GENERATION_URL, evidenceRun: "parent", requestNumber: 1, acceptedRequestNumber: 1, normalizedModel: "gpt-6.1-sol", responseStatus: 200, atMs: 100, productionWrapperObserved: true, fixtureRegistryObserved: true },
      { route: CODEX_GENERATION_URL, evidenceRun: "parent", requestNumber: 1, acceptedRequestNumber: 2, normalizedModel: "gpt-6-luna", responseStatus: 429, atMs: 110, productionWrapperObserved: true, fixtureRegistryObserved: true },
      { route: CODEX_GENERATION_URL, evidenceRun: "cancellation", requestNumber: 1, acceptedRequestNumber: 3, normalizedModel: "gpt-6-luna", responseStatus: 429, atMs: 120, productionWrapperObserved: true, fixtureRegistryObserved: true },
      { route: CODEX_GENERATION_URL, evidenceRun: "parallel", requestNumber: 2, acceptedRequestNumber: 4, normalizedModel: "gpt-6-luna", responseStatus: 200, responseKind: "plain-text-sse", parallelRequestSafe: true, atMs: 1500, productionWrapperObserved: true, fixtureRegistryObserved: true },
    ],
    quotaResponses: [
      { status: 429, type: "usage_limit_reached", atMs: 110 },
      { status: 429, type: "usage_limit_reached", atMs: 120 },
    ],
    native: {
      sessionIds: ["parent-session", "child-session"],
      parentSessionIds: ["parent-session"],
      childSessionIds: ["child-session"],
      taskResultChildSessionIds: ["child-session"],
      sessionParentRelations: [{
        childSessionId: "child-session",
        parentSessionId: "parent-session",
        source: "session.created.properties.info.parentID",
      }],
      completedToolParts: [{ id: "patch-1", name: "apply_patch" }],
      completedWriteParts: [{ id: "patch-1", sessionId: "child-session", filePaths: ["smoke-child-mutation.txt"] }],
      retryEvents: [{ next: 1000, atMs: 130, sessionId: "cancellation-session" }],
      sessionStatusEvents: [{ sessionId: "cancellation-session", status: "idle", capturedAtMs: 140 }],
      cancellationEvents: [],
      continuationPromptCount: 0,
      toolCalls: [
        { id: "goal-1", name: "create_goal", input: { objective: SMOKE_GOAL_OBJECTIVE } },
        { id: "task-1", name: "task", input: { description: SMOKE_CHILD_TASK_DESCRIPTION, subagent_type: SMOKE_CHILD_AGENT } },
        { id: "patch-1", name: "apply_patch", input: { patchText: "*** Begin Patch" } },
      ],
    },
    goalRecords: [{ goalId: "goal-1", objective: SMOKE_GOAL_OBJECTIVE, status: "complete" }],
    sideEffects: [{ identity: "smoke-child-mutation.txt", tool: "apply_patch", toolPartId: "patch-1", persisted: true }],
    mutationFileText: SMOKE_MUTATION_CONTENT,
    cancellation: {
      nativeRetryObserved: true,
      nativeCancelObserved: true,
      sessionId: "cancellation-session",
      abortRequestAtMs: 135,
      abortResponseAtMs: 136,
      abortResponseStatus: 200,
      abortSucceeded: true,
      originalDeadlineMs: 1000,
      monitoredUntilMs: 1001,
      cancellationRequestsAtAbort: 1,
      cancellationRequestsAtDeadline: 1,
    },
    parallel: {
      sessionId: "parallel-session-B",
      responseStatus: 200,
      submittedAtMs: 1400,
      requestObservedAtMs: 1500,
      nativeSessionObserved: true,
      cancellationServerPid: 7000,
      parallelServerPid: 7000,
    },
    requestIdentityEvidence: [
      { evidenceRun: "parent", requestNumber: 1, acceptedRequestNumber: 1, normalizedModel: "gpt-6.1-sol", responseStatus: 200, headerEvidenceReadable: true, identitySource: "actual_outgoing_allowlisted_headers",
        identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("parent-session") }] },
      { evidenceRun: "parent", requestNumber: 1, acceptedRequestNumber: 2, normalizedModel: "gpt-6-luna", responseStatus: 429, headerEvidenceReadable: true, identitySource: "actual_outgoing_allowlisted_headers",
        identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("child-session") }] },
      { evidenceRun: "cancellation", requestNumber: 1, acceptedRequestNumber: 3, normalizedModel: "gpt-6-luna", responseStatus: 429, headerEvidenceReadable: true, identitySource: "actual_outgoing_allowlisted_headers",
        identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("cancellation-session") }] },
      { evidenceRun: "parallel", requestNumber: 2, acceptedRequestNumber: 4, normalizedModel: "gpt-6-luna", responseStatus: 200, headerEvidenceReadable: true, identitySource: "actual_outgoing_allowlisted_headers",
        identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("parallel-session-B") }] },
    ],
  };
}

function testSmokeEvidenceValidationContract(): void {
  const valid = smokeContractEvidenceFixture();
  const validResult = validateSmokeEvidence(valid);
  assert.equal(validResult.status, "PASS");
  assert.equal(validateSmokeEvidence({}).status, "BLOCKED", "empty evidence must remain blocked");

  const constantGrace = structuredClone(valid);
  constantGrace.requestTimeline = constantGrace.requestTimeline?.map((entry) => ({ ...entry, responseStatus: 200 }));
  assert.equal(validateSmokeEvidence(constantGrace).status, "FAIL", "constant grace cannot prove actual quota responses");

  const overBudget = structuredClone(valid);
  overBudget.requestBudget = { acceptedRequests: SMOKE_MAX_REQUESTS + 1, maxRequests: SMOKE_MAX_REQUESTS, exceeded: true };
  assert.equal(validateSmokeEvidence(overBudget).status, "FAIL", "request budget overflow must fail");

  const emptyGoals = structuredClone(valid);
  emptyGoals.goalRecords = [];
  assert.equal(validateSmokeEvidence(emptyGoals).status, "BLOCKED", "empty goals must remain blocked");

  const noChild = structuredClone(valid);
  noChild.native = { ...noChild.native, childSessionIds: [], toolCalls: noChild.native?.toolCalls?.filter((call) => call.name !== "task") };
  assert.equal(validateSmokeEvidence(noChild).status, "FAIL", "missing child identity must fail complete evidence");

  const dedupedFakeEffects = structuredClone(valid);
  dedupedFakeEffects.native = { ...dedupedFakeEffects.native, toolCalls: dedupedFakeEffects.native?.toolCalls?.filter((call) => call.name !== "apply_patch") };
  dedupedFakeEffects.sideEffects = [{ identity: "gpt-6-luna:smoke-generation-1" }, { identity: "gpt-6-luna:smoke-generation-1" }];
  assert.equal(validateSmokeEvidence(dedupedFakeEffects).status, "FAIL", "deduplicated fake effects must fail");

  const abortWithoutPostAbortIdle = structuredClone(valid);
  abortWithoutPostAbortIdle.native = { ...abortWithoutPostAbortIdle.native, sessionStatusEvents: [] };
  assert.equal(validateSmokeEvidence(abortWithoutPostAbortIdle).status, "FAIL",
    "abort success without a post-abort native idle/cancel observation must fail");

  const idleBeforeAbort = structuredClone(valid);
  idleBeforeAbort.native = {
    ...idleBeforeAbort.native,
    sessionStatusEvents: [{ sessionId: "cancellation-session", status: "idle", capturedAtMs: 134 }],
  };
  assert.equal(validateSmokeEvidence(idleBeforeAbort).status, "FAIL",
    "native idle before abort invocation must not satisfy cancellation evidence");

  const idleBetweenAbortRequestAndResponse = structuredClone(valid);
  idleBetweenAbortRequestAndResponse.native = {
    ...idleBetweenAbortRequestAndResponse.native,
    sessionStatusEvents: [{ sessionId: "cancellation-session", status: "idle", capturedAtMs: 135.5 }],
  };
  assert.equal(validateSmokeEvidence(idleBetweenAbortRequestAndResponse).status, "PASS",
    "native idle after the abort request but before the HTTP response is valid cancellation evidence");

  const laterCancellationRequest = structuredClone(valid);
  laterCancellationRequest.requestTimeline = [
    ...(laterCancellationRequest.requestTimeline ?? []),
    { route: CODEX_GENERATION_URL, evidenceRun: "cancellation", normalizedModel: "gpt-6-luna", responseStatus: 200, atMs: 150, productionWrapperObserved: true, fixtureRegistryObserved: true },
  ];
  assert.equal(validateSmokeEvidence(laterCancellationRequest).status, "FAIL",
    "a later cancellation request must fail the exact-one-quota-call gate");

  const sameSessionIdentity = structuredClone(valid);
  sameSessionIdentity.parallel!.sessionId = sameSessionIdentity.cancellation?.sessionId;
  sameSessionIdentity.requestIdentityEvidence = sameSessionIdentity.requestIdentityEvidence?.map((entry) => entry.evidenceRun === "parallel"
    ? { ...entry, identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("cancellation-session") }] }
    : entry);
  assert.equal(validateSmokeEvidence(sameSessionIdentity).status, "FAIL", "parallel B with the same native identity must fail");

  const missingParallelResponse = structuredClone(valid);
  missingParallelResponse.parallel!.responseStatus = undefined;
  missingParallelResponse.requestTimeline = missingParallelResponse.requestTimeline?.filter((entry) => entry.evidenceRun !== "parallel");
  missingParallelResponse.requestIdentityEvidence = missingParallelResponse.requestIdentityEvidence?.filter((entry) => entry.evidenceRun !== "parallel");
  assert.equal(validateSmokeEvidence(missingParallelResponse).status, "FAIL", "missing B plaintext response must fail");

  const missingIdentity = structuredClone(valid);
  missingIdentity.requestIdentityEvidence = missingIdentity.requestIdentityEvidence?.filter((entry) => entry.evidenceRun !== "parallel");
  assert.equal(validateSmokeEvidence(missingIdentity).status, "FAIL", "missing per-request identity evidence must fail");

  const conflictingParallelIdentity = structuredClone(valid);
  conflictingParallelIdentity.requestIdentityEvidence = conflictingParallelIdentity.requestIdentityEvidence?.map((entry) =>
    entry.acceptedRequestNumber === 4 ? { ...entry, identities: [
      { identityField: "sessionID", identityDigest: identityDigestForValue("parallel-session-B") },
      { identityField: "sessionID", identityDigest: identityDigestForValue("wrong-B") },
    ] } : entry);
  assert.equal(validateSmokeEvidence(conflictingParallelIdentity).status, "FAIL",
    "conflicting B identity aliases must fail rather than be hidden by the scenario label");

  const realLateCancellationRequest = structuredClone(valid);
  realLateCancellationRequest.requestTimeline = [
    ...(realLateCancellationRequest.requestTimeline ?? []),
    { route: CODEX_GENERATION_URL, evidenceRun: "cancellation", requestNumber: 2, acceptedRequestNumber: 5,
      normalizedModel: "gpt-6-luna", responseStatus: 200, atMs: 1600,
      productionWrapperObserved: true, fixtureRegistryObserved: true },
  ];
  realLateCancellationRequest.requestIdentityEvidence = [
    ...(realLateCancellationRequest.requestIdentityEvidence ?? []),
    { evidenceRun: "cancellation", requestNumber: 2, acceptedRequestNumber: 5,
      normalizedModel: "gpt-6-luna", responseStatus: 200, headerEvidenceReadable: true,
      identitySource: "actual_outgoing_allowlisted_headers",
      identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("cancellation-session") }] },
  ];
  assert.equal(validateSmokeEvidence(realLateCancellationRequest).status, "FAIL",
    "a real late A request fails even if other requests are labeled parallel");

  const missingBIdentity = structuredClone(valid);
  missingBIdentity.requestIdentityEvidence = missingBIdentity.requestIdentityEvidence?.filter((entry) => entry.acceptedRequestNumber !== 4);
  assert.equal(validateSmokeEvidence(missingBIdentity).status, "FAIL", "every B HTTP request needs its own identity row");

  const wrongBIdentity = structuredClone(valid);
  wrongBIdentity.requestIdentityEvidence = wrongBIdentity.requestIdentityEvidence?.map((entry) => entry.acceptedRequestNumber === 4
    ? { ...entry, identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("other-session") }] }
    : entry);
  assert.equal(validateSmokeEvidence(wrongBIdentity).status, "FAIL", "B identity must match the observed native B session ID");

  const repeatedBCalls = structuredClone(valid);
  repeatedBCalls.requestBudget = { acceptedRequests: 5, maxRequests: SMOKE_MAX_REQUESTS, exceeded: false };
  repeatedBCalls.requestTimeline = [
    ...(repeatedBCalls.requestTimeline ?? []),
    { route: CODEX_GENERATION_URL, evidenceRun: "parallel", requestNumber: 3, acceptedRequestNumber: 5,
      normalizedModel: "gpt-6-luna", responseStatus: 200, responseKind: "plain-text-sse", parallelRequestSafe: true,
      atMs: 1510, productionWrapperObserved: true, fixtureRegistryObserved: true },
  ];
  repeatedBCalls.requestIdentityEvidence = [
    ...(repeatedBCalls.requestIdentityEvidence ?? []),
    { evidenceRun: "parallel", requestNumber: 3, acceptedRequestNumber: 5,
      normalizedModel: "gpt-6-luna", responseStatus: 200, headerEvidenceReadable: true,
      identitySource: "actual_outgoing_allowlisted_headers",
      identities: [{ identityField: "sessionID", identityDigest: identityDigestForValue("parallel-session-B") }] },
  ];
  assert.equal(validateSmokeEvidence(repeatedBCalls).status, "PASS",
    "multiple non-mutating B auxiliary requests with exact identity and 200 remain within the global cap");
  const mutatingBCall = structuredClone(repeatedBCalls);
  mutatingBCall.requestTimeline = mutatingBCall.requestTimeline?.map((entry) => entry.acceptedRequestNumber === 5
    ? { ...entry, parallelRequestSafe: false } : entry);
  assert.equal(validateSmokeEvidence(mutatingBCall).status, "FAIL",
    "B auxiliary requests carrying goal/task/mutation tools must fail");

  const wrongServer = structuredClone(valid);
  wrongServer.parallel!.parallelServerPid = 7001;
  assert.equal(validateSmokeEvidence(wrongServer).status, "FAIL", "parallel B on a different server process must fail");

  const parallelDuringCooldown = structuredClone(valid);
  parallelDuringCooldown.parallel!.submittedAtMs = 1200;
  assert.equal(validateSmokeEvidence(parallelDuringCooldown).status, "FAIL", "B submitted before shared cooldown expiry must fail");
}

async function runGeneratedFixtureInitialization(runDir: string, fixtureSource: string, mutationPath: string): Promise<{
  initialized: boolean;
  nativeEventRecorded: boolean;
  fixtureNativeLedgerContract: boolean;
  externalNetworkBlocked: boolean;
  referenceError: boolean;
  productionWrapperObserved: boolean;
  productionWrapperIsGlobalFetch: boolean;
  installedBeforeProductionWrapper: boolean;
  scripted429Status: number;
  retryAfterMs: number;
  abortedFetchTransportContract: boolean;
}> {
  const fixtureRoot = join(runDir, "fixture-contract");
  const workspace = join(fixtureRoot, "workspace");
  const evidenceDir = join(fixtureRoot, "evidence");
  const fixturePath = join(workspace, ".opencode", "plugins", "00-codex-smoke-transport.ts");
  const productionPluginPath = join(workspace, ".opencode", "plugins", "10-codex-quota-retry.ts");
  const productionHelperPath = join(workspace, ".opencode", "lib", "codex-quota-retry.ts");
  const driverPath = join(workspace, "fixture-client.ts");
  await mkdir(dirname(fixturePath), { recursive: true });
  await mkdir(dirname(productionHelperPath), { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const root = smokeProjectRoot();
  await cp(join(root, ".opencode", "plugins", "codex-quota-retry.ts"), productionPluginPath);
  await cp(join(root, ".opencode", "lib", "codex-quota-retry.ts"), productionHelperPath);
  await writeFile(fixturePath, fixtureSource);
  await writeFile(driverPath, `import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import fixture from "./.opencode/plugins/00-codex-smoke-transport.ts";
import production from "./.opencode/plugins/10-codex-quota-retry.ts";

const fixturePromise = fixture();
const productionPromise = production({}, { nowMs: () => Date.now(), monotonicMs: () => performance.now(), staggerMs: 0 });
const [hooks] = await Promise.all([fixturePromise, productionPromise]);
if (!hooks || typeof hooks.event !== "function") throw new Error("SMOKE_FIXTURE_EVENT_HOOK_MISSING");
 await hooks.event({ event: {
   id: "fixture-retry-event",
   type: "session.status",
   properties: {
     sessionID: "fixture-contract-session",
     status: { type: "retry", attempt: 1, next: 1234 },
   },
 } });
const fixtureMutationPath = ${JSON.stringify(mutationPath)};
await mkdir(fixtureMutationPath.split("/").slice(0, -1).join("/"), { recursive: true });
await writeFile(fixtureMutationPath, ${JSON.stringify(SMOKE_MUTATION_CONTENT)});
await hooks.event({ event: {
  type: "session.created",
  properties: { info: { id: "fixture-child-session", parentID: "fixture-parent-session" } },
} });
const completedWriteEvent = {
  type: "message.part.updated",
  sessionID: "fixture-child-session",
  executionTime: 4242,
  properties: {
    part: {
      type: "tool",
      id: "fixture-patch-1",
      sessionID: "fixture-child-session",
      tool: "apply_patch",
       state: {
         status: "completed",
         executionTime: 4242,
         time: { start: 4242, end: 4252 },
         metadata: { files: [{ filePath: fixtureMutationPath }] },
      },
    },
  },
};
await hooks.event({ event: completedWriteEvent });
await hooks.event({ event: completedWriteEvent });
const completedWriteLedger = (await readFile(process.env.CODEX_SMOKE_EVIDENCE_DIR + "/completed-write-parts.jsonl", "utf8"))
  .split("\\n").filter(Boolean).map((line) => JSON.parse(line));
const sideEffectLedger = (await readFile(process.env.CODEX_SMOKE_EVIDENCE_DIR + "/side-effects.jsonl", "utf8"))
  .split("\\n").filter(Boolean).map((line) => JSON.parse(line));
const fixtureNativeLedgerContract = completedWriteLedger.length === 1
  && sideEffectLedger.length === 1
  && completedWriteLedger[0].id === "fixture-patch-1"
  && completedWriteLedger[0].sessionID === "fixture-child-session"
  && completedWriteLedger[0].executionTime === 4242
  && completedWriteLedger[0].state.metadata.files[0].filePath === fixtureMutationPath
  && sideEffectLedger[0].identity === fixtureMutationPath
  && sideEffectLedger[0].toolPartId === "fixture-patch-1";
if (!fixtureNativeLedgerContract) throw new Error("SMOKE_NATIVE_WRITE_LEDGER_CONTRACT_FAILED");
 const registry = globalThis[Symbol.for("opencode.codex-quota-retry.fetch-wrapper")];
 const productionWrapperObserved = Boolean(registry && typeof registry === "object"
   && globalThis.fetch === registry.wrapper);
  const fixtureTransport = globalThis[Symbol.for("opencode.codex-quota-retry.smoke-fixture")];
  if (!fixtureTransport || typeof fixtureTransport.handler !== "function") throw new Error("SMOKE_FIXTURE_HANDLER_MISSING");
  const fixtureEvidencePath = process.env.CODEX_SMOKE_EVIDENCE_DIR + "/";
  const readFixtureJsonLines = async (name) => (await readFile(fixtureEvidencePath + name, "utf8").catch(() => ""))
    .split("\\n").filter(Boolean).map((line) => JSON.parse(line));
  const parallelSessionId = "ses_fixture_parallel_B";
  await writeFile(process.env.CODEX_SMOKE_PARALLEL_SESSION_CONTROL_PATH, JSON.stringify({ sessionId: parallelSessionId }));
  const parallelRequest = () => fixtureTransport.handler("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "session-id": parallelSessionId, "x-session-id": parallelSessionId },
    body: JSON.stringify({ model: "openai/gpt-6-luna", input: [] }),
  });
  const parallelResponses = [await parallelRequest(), await parallelRequest()];
  const parallelResponseBodies = await Promise.all(parallelResponses.map((response) => response.text()));
  const parallelTimeline = await readFixtureJsonLines("request-timeline.jsonl");
  const parallelIdentityRows = await readFixtureJsonLines("identity-fetch-telemetry.jsonl");
  const expectedParallelDigest = "sha256:" + createHash("sha256").update(parallelSessionId).digest("hex");
  const repeatedParallelFixtureContract = parallelResponses.every((response) => response.status === 200)
    && parallelResponseBodies.every((body) => body.includes("Parallel session B completed without mutation.")
      && !body.includes("apply_patch") && !body.includes("CODEX_SMOKE_CHILD_MUTATION"))
    && parallelTimeline.filter((entry) => entry.evidenceRun === "parallel").length === 2
    && parallelIdentityRows.filter((entry) => entry.evidenceRun === "parallel").length === 2
    && parallelIdentityRows.filter((entry) => entry.evidenceRun === "parallel").every((entry) =>
      entry.headerEvidenceReadable === true && entry.identitySource === "actual_outgoing_allowlisted_headers"
      && entry.responseStatus === 200 && entry.identities.length === 1
      && entry.identities[0].identityDigest === expectedParallelDigest
      && typeof entry.acceptedRequestNumber === "number");
  if (!repeatedParallelFixtureContract) throw new Error("SMOKE_REPEATED_PARALLEL_FIXTURE_CONTRACT_FAILED");
  const abortedBefore = await readFixtureJsonLines("aborted-fetch-attempts.jsonl");
 const timelineBefore = await readFixtureJsonLines("request-timeline.jsonl");
 const requestsBefore = fixtureTransport.state.totalRequests;
 let mockResponses = 0;
 const mockFetch = async (input, init) => {
   const response = await fixtureTransport.handler(input, init);
   mockResponses += 1;
   return response;
 };
 const expectAbortError = async (pending, label) => {
   try {
     await pending;
   } catch (error) {
     if (error instanceof DOMException && error.name === "AbortError") return;
     throw new Error(label + " rejected with the wrong error: " + String(error));
   }
   throw new Error(label + " unexpectedly returned a response");
 };
 const preAbortedController = new AbortController();
 preAbortedController.abort(new DOMException("pre-aborted", "AbortError"));
 const preAbortedRequest = new Request("https://chatgpt.com/backend-api/codex/responses", {
   method: "POST",
   body: JSON.stringify({ model: "openai/gpt-6-luna", input: [] }),
   signal: preAbortedController.signal,
 });
 await expectAbortError(mockFetch(preAbortedRequest), "pre-aborted request");
 const afterPreAborted = await readFixtureJsonLines("aborted-fetch-attempts.jsonl");
 if (afterPreAborted.length !== abortedBefore.length + 1) throw new Error("SMOKE_PRE_ABORT_ATTEMPT_COUNT_INVALID");
 const asyncAbortController = new AbortController();
 const asyncAbortRequest = new Request("https://chatgpt.com/backend-api/codex/responses", {
   method: "POST",
   body: JSON.stringify({ model: "openai/gpt-6-luna", input: [] }),
   signal: asyncAbortController.signal,
 });
 const asyncAbortPending = Promise.resolve().then(() => mockFetch(asyncAbortRequest));
 asyncAbortController.abort(new DOMException("async-aborted", "AbortError"));
 await expectAbortError(asyncAbortPending, "asynchronously aborted request");
 const afterAsyncAborted = await readFixtureJsonLines("aborted-fetch-attempts.jsonl");
 const timelineAfterAborts = await readFixtureJsonLines("request-timeline.jsonl");
 const abortEvidence = afterAsyncAborted.slice(abortedBefore.length);
 if (afterAsyncAborted.length !== abortedBefore.length + 2
   || abortEvidence.some((entry) => entry.abortReason !== "AbortError")
   || fixtureTransport.state.totalRequests !== requestsBefore
   || timelineAfterAborts.length !== timelineBefore.length
   || mockResponses !== 0) {
   throw new Error("SMOKE_ABORT_SIGNAL_TRANSPORT_CONTRACT_FAILED");
 }
 const normalRequest = new Request("https://chatgpt.com/backend-api/codex/responses", {
   method: "POST",
   body: JSON.stringify({ model: "openai/gpt-6.1-sol", input: [] }),
 });
 const normalResponse = await mockFetch(normalRequest);
 const timelineAfterNormal = await readFixtureJsonLines("request-timeline.jsonl");
 if (normalResponse.status !== 200
   || fixtureTransport.state.totalRequests !== requestsBefore + 1
   || timelineAfterNormal.length !== timelineBefore.length + 1
   || mockResponses !== 1) {
   throw new Error("SMOKE_NON_ABORTED_TRANSPORT_CONTRACT_FAILED");
 }
 const abortedFetchTransportContract = true;
 const fixtureMetadata = JSON.parse(await readFile(process.env.CODEX_SMOKE_EVIDENCE_DIR + "/fixture-installed.json", "utf8"));
const installedBeforeProductionWrapper = fixtureMetadata.installedBeforeProductionWrapper === false;
const scriptedQuota = await fetch("https://chatgpt.com/backend-api/codex/responses", {
  method: "POST",
  body: JSON.stringify({ model: "openai/gpt-6-luna", input: [] }),
});
const retryAfterMs = Number(scriptedQuota.headers.get("retry-after-ms") ?? "0");
if (!productionWrapperObserved || !installedBeforeProductionWrapper) throw new Error("SMOKE_PRODUCTION_WRAPPER_ORDER_INVALID");
if (scriptedQuota.status !== 429 || retryAfterMs < 61_000) throw new Error("SMOKE_NATIVE_RETRY_HEADER_INVALID");
const blockedTargets = [
  "https://example.com/not-a-loopback-request",
  "http://localhost.evil/not-a-loopback-request",
  "http://127.0.0.1.evil/not-a-loopback-request",
];
let externalNetworkBlocked = true;
for (const target of blockedTargets) {
  try {
    await fetch(target);
    externalNetworkBlocked = false;
  } catch {
    // The first fixture initializer must reject every non-exact loopback hostname.
  }
}
const nativeEvents = await readFile(process.env.CODEX_SMOKE_EVIDENCE_DIR + "/native-events.jsonl", "utf8").catch(() => "");
 await writeFile(process.env.CODEX_SMOKE_RESULT_PATH, JSON.stringify({
   initialized: true,
   abortedFetchTransportContract,
    nativeEventRecorded: nativeEvents.includes("session.status") && nativeEvents.includes('"type":"retry"'),
  fixtureNativeLedgerContract,
  externalNetworkBlocked,
  productionWrapperObserved,
  productionWrapperIsGlobalFetch: productionWrapperObserved,
  installedBeforeProductionWrapper,
  scripted429Status: scriptedQuota.status,
  retryAfterMs,
}, null, 2));
`);
  const resultPath = join(fixtureRoot, "fixture-result.json");
  const bunBin = Bun.which("bun") ?? process.execPath;
  const child = Bun.spawnSync([bunBin, driverPath], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_SMOKE_NO_PROVIDER: "1",
      CODEX_SMOKE_EXTERNAL_NETWORK_DENIED: "1",
      CODEX_SMOKE_EVIDENCE_DIR: evidenceDir,
      CODEX_SMOKE_RESULT_PATH: resultPath,
      CODEX_SMOKE_SCENARIO: "cancel",
      CODEX_SMOKE_RECORD_IDENTITY: "1",
      CODEX_SMOKE_PARALLEL_SESSION_CONTROL_PATH: join(evidenceDir, "parallel-session-control.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  const output = `${stdout}\n${stderr}`;
  const referenceError = /ReferenceError|FIXTURE_SYMBOL is not defined|SMOKE_FIXTURE_NOT_READY/.test(output);
  assert.equal(referenceError, false, `generated fixture initialization must not fail with an unbound symbol: ${output}`);
  assert.equal(child.exitCode, 0, `generated fixture initializer exited ${child.exitCode}: ${output}`);
  const result = JSON.parse(await readFile(resultPath, "utf8")) as {
    initialized?: boolean;
    nativeEventRecorded?: boolean;
     fixtureNativeLedgerContract?: boolean;
     externalNetworkBlocked?: boolean;
     productionWrapperObserved?: boolean;
     productionWrapperIsGlobalFetch?: boolean;
     installedBeforeProductionWrapper?: boolean;
      scripted429Status?: number;
      retryAfterMs?: number;
      abortedFetchTransportContract?: boolean;
   };
  return {
    initialized: result.initialized === true,
    nativeEventRecorded: result.nativeEventRecorded === true,
    fixtureNativeLedgerContract: result.fixtureNativeLedgerContract === true,
    externalNetworkBlocked: result.externalNetworkBlocked === true,
    referenceError,
    productionWrapperObserved: result.productionWrapperObserved === true,
    productionWrapperIsGlobalFetch: result.productionWrapperIsGlobalFetch === true,
    installedBeforeProductionWrapper: result.installedBeforeProductionWrapper === true,
    scripted429Status: Number(result.scripted429Status ?? 0),
    retryAfterMs: Number(result.retryAfterMs ?? 0),
    abortedFetchTransportContract: result.abortedFetchTransportContract === true,
  };
}

async function runSmokeContract(argsOverride?: SmokeArgs): Promise<void> {
  const args = argsOverride ?? parseSmokeArgs(Bun.argv.slice(2)) ?? { mode: "smoke-contract" as const, runId: "smoke-contract" };
  const runDir = smokeRunDirectory(args);
  await mkdir(runDir, { recursive: true });
  await testOwnedProcessCleanupContract(runDir);
  testNativeCancellationMessagePayloadContract();
  await testNativeCancellationIdleBarrierContract();
  testNativeSessionAndWriteEvidenceCollectorContract();
  testActualFixturePreflightMappingContract();
  testSmokeEvidenceValidationContract();
  const root = smokeProjectRoot();
  const helperSource = await readFile(join(root, ".opencode", "lib", "codex-quota-retry.ts"), "utf8");
  const pluginSource = await readFile(join(root, ".opencode", "plugins", "codex-quota-retry.ts"), "utf8");
  const harnessSource = await readFile(join(root, "scripts", "test_codex_quota_retry.ts"), "utf8");
   const fixtureSource = smokeTransportPluginSource("tmp/codex-quota-retry/contract/smoke-child-mutation.txt");
  const fixtureInitialization = await runGeneratedFixtureInitialization(runDir, fixtureSource, "tmp/codex-quota-retry/contract/smoke-child-mutation.txt");
   const fixtureFetchInstall = fixtureSource.indexOf("globalThis.fetch = smokeFetch;");
   const fixtureInitializerIndex = fixtureSource.indexOf("const SmokeTransportPlugin = async");
   const fixtureGuardCallIndex = fixtureSource.indexOf("installFixtureNetworkGuard();", fixtureInitializerIndex);
   const fixtureFirstAwaitIndex = fixtureSource.indexOf("await ", fixtureInitializerIndex);
   const fixtureInstalledCaptureIndex = fixtureSource.indexOf("const installedBeforeProductionWrapper = Boolean(globalThis[REGISTRY_SYMBOL]);", fixtureInitializerIndex);
   const fixtureInitializerEnd = fixtureSource.indexOf("\n};\n\nfunction installFixtureNetworkGuard", fixtureInitializerIndex);
   const fixtureInitializerSource = fixtureInitializerEnd >= 0
     ? fixtureSource.slice(fixtureInitializerIndex, fixtureInitializerEnd)
     : "";
  const checks = {
    explicitSmokeMode: /--smoke/.test(harnessSource) && /--run-id/.test(harnessSource),
    explicitContractMode: /--smoke-contract/.test(harnessSource),
    exactCodexRoute: helperSource.includes("https://chatgpt.com") && helperSource.includes("/backend-api/codex/responses"),
    productionEntrypointDefaultOnly: /export default/.test(pluginSource) && !/export\s+(?:async\s+)?function/.test(pluginSource),
    nativePluginVersion: harnessSource.includes("0.1.60"),
    approvedModels: harnessSource.includes(SMOKE_PARENT_MODEL) && harnessSource.includes(SMOKE_CHILD_MODEL),
     fakeTransportBeforeProduction: fixtureSource.includes("globalThis.fetch")
       && fixtureSource.includes("installedBeforeProductionWrapper")
       && fixtureSource.includes("REGISTRY_SYMBOL"),
    noExternalNetwork: fixtureSource.includes("SMOKE_EXTERNAL_NETWORK_DENIED")
      && fixtureSource.includes("isStrictLoopbackUrl")
      && fixtureSource.includes("LOOPBACK_HOSTNAMES"),
    nativeDeadlineFixture: fixtureSource.includes("resets_in_seconds") && harnessSource.includes(String(SMOKE_GRACE_MS)),
       evidenceOutputs: ["expected-scenarios.json", "plugin-load-order.json", "request-budget.json", "request-timeline.jsonl", "identity-fetch-telemetry.jsonl", "native-events.jsonl", "goal-state-summary.json", "verdict.json"]
      .every((name) => harnessSource.includes(name)),
    noCredentialLogging: !/authorization|OPENAI_API_KEY|process\.env\.(?:OPENAI|CODEX)/i.test(pluginSource),
    noAdapterLongWait: !/await\s+new\s+Promise/.test(helperSource),
    evidenceValidationGate: harnessSource.includes("validateSmokeEvidence")
      && harnessSource.includes('status: "BLOCKED"')
      && harnessSource.includes('status: "FAIL"'),
    actualQuotaStatusGate: harnessSource.includes("actualQuotaResponses") && harnessSource.includes("responseStatus === 429"),
      nativeCancellationEvidenceGate: harnessSource.includes("nativeCancelAfterRetry")
        && harnessSource.includes("sessionStatusEvents")
        && harnessSource.includes("abortRequestAtMs")
        && harnessSource.includes("abortResponseAtMs")
        && harnessSource.includes("abortSucceeded")
          && harnessSource.includes("cancellationRequestsAtDeadline"),
      nativeIdleBarrierPolling: harnessSource.includes("waitForNativeCancellationObserved")
        && harnessSource.includes("totalDeadlineAtMs: deadlineAtMs")
        && harnessSource.includes("nativeCancelObserved = await waitForNativeCancellationObserved")
        && harnessSource.includes("testNativeCancellationIdleBarrierContract"),
      perRequestIdentityDigestEvidence: harnessSource.includes("identity-fetch-telemetry.jsonl")
        && harnessSource.includes("CODEX_SMOKE_RECORD_IDENTITY")
        && harnessSource.includes("headerEvidenceReadable")
        && harnessSource.includes("identityDigest"),
      parallelSessionAfterCooldown: harnessSource.includes("SMOKE_PARALLEL_SESSION_CONTROL_PATH")
        && harnessSource.includes("parallelSessionBNativeSessionObserved")
        && harnessSource.includes("sessionBPlaintextResponseAfterSharedCooldownExpiry")
        && harnessSource.includes("parallelSessionBHasDifferentObservedNativeIdentity"),
      sameServerProcessParallelScenario: harnessSource.includes("parallel.cancellationServerPid === parallel.parallelServerPid")
        && harnessSource.includes("sameServerProcess: true"),
      cancellationParallelNegativeContracts: harnessSource.includes("parallel B with the same native identity must fail")
        && harnessSource.includes("missing B plaintext response must fail")
        && harnessSource.includes("missing per-request identity evidence must fail")
        && harnessSource.includes("parallel B on a different server process must fail")
        && harnessSource.includes("B submitted before shared cooldown expiry must fail"),
      harnessOnlyNativeAbortBoundary: harnessSource.includes("/session/${session.id}/abort")
        && !pluginSource.includes("session.abort"),
     nativeCancellationMessagePayloadContract: harnessSource.includes("model: { providerID: \"openai\", modelID: SMOKE_CHILD_MODEL_ID }")
       && harnessSource.includes("modelID must strip the provider prefix")
       && harnessSource.includes("modelID must not be sent at the JSON top level"),
     nativeCallbackTimestampContract: fixtureSource.includes("recordNativeEventCallback")
      && fixtureSource.includes("capturedAtMs")
      && fixtureSource.includes("callbackFrame.event"),
    nativeDtoMappingContract: harnessSource.includes("properties?.status")
      && harnessSource.includes("stateRecord?.time")
      && harnessSource.includes("status: stateStatus ?? \"completed\""),
    exactGoalEvidenceGate: harnessSource.includes("SMOKE_GOAL_OBJECTIVE") && harnessSource.includes("finalParentGoalComplete"),
    nestedEvidencePaths: harnessSource.includes("evidence/parent/native-events.jsonl")
      && harnessSource.includes("evidence/cancellation/native-events.jsonl"),
    noConstantExternalNetworkPass: !/noUnexpectedExternalNetwork\s*:\s*true/.test(harnessSource),
    noEmptyGoalTextPass: !/goalStateEvidenceFile[\s\S]{0,180}includes\("files"\)/.test(harnessSource),
    isolatedGitRootContract: harnessSource.includes("git init -q") && fixtureSource.includes("workspaceGitRoot"),
     explicitPluginLoadOrder: fixtureSource.includes("installedBeforeProductionWrapper")
       && fixtureSource.includes("loadOrder")
       && harnessSource.includes('"./.opencode/plugins/00-codex-smoke-transport.ts"')
       && harnessSource.includes('"./.opencode/plugins/10-codex-quota-retry.ts"'),
     hardRequestBudgetGuard: fixtureSource.includes("consumeRequestBudget")
       && fixtureSource.includes("SMOKE_REQUEST_BUDGET_EXCEEDED") && harnessSource.includes("SMOKE_MAX_REQUESTS"),
     persistentParallelIdentityEvidence: fixtureSource.includes("scenario = \"parallel\"")
       && fixtureSource.includes("Parallel session B completed without mutation.")
       && fixtureSource.includes("await recordIdentityFetchTelemetry(input, init, body, responseStatus, scenario, requestNumber, acceptedRequestNumber)")
       && !fixtureSource.includes("unlink(process.env.CODEX_SMOKE_PARALLEL_SESSION_CONTROL_PATH")
       && harnessSource.includes("repeatedParallelFixtureContract"),
    noLegacyFixtureGenerator: !harnessSource.includes(["legacySmoke", "TransportPluginSource"].join("")),
     generatedFixtureInitialization: fixtureInitialization.initialized
       && fixtureInitialization.nativeEventRecorded
       && fixtureInitialization.fixtureNativeLedgerContract
       && fixtureInitialization.externalNetworkBlocked
      && !fixtureInitialization.referenceError,
     concurrentProductionInitialization: fixtureInitialization.productionWrapperObserved
       && fixtureInitialization.productionWrapperIsGlobalFetch
       && fixtureInitialization.installedBeforeProductionWrapper
       && fixtureInitialization.scripted429Status === 429
       && fixtureInitialization.retryAfterMs >= 61_000,
     fixtureGuardFirst: fixtureInitializerIndex >= 0
       && fixtureGuardCallIndex > fixtureInstalledCaptureIndex
       && fixtureFirstAwaitIndex > fixtureGuardCallIndex
       && fixtureFetchInstall >= 0,
     asyncFixtureMetadataDoesNotReassignFetch: fixtureInitializerSource.length > 0
       && !fixtureInitializerSource.includes("globalThis.fetch ="),
     fixtureNativeWriteLedgerContract: harnessSource.includes("message.part.updated")
       && harnessSource.includes("completed-write-parts.jsonl")
       && harnessSource.includes("side-effects.jsonl")
       && fixtureInitialization.fixtureNativeLedgerContract,
     completedWriteMetadataFilePathContract: fixtureSource.includes("mutationFile?.filePath === MUTATION_PATH")
       && !fixtureSource.includes("file === MUTATION_PATH"),
     generatedWriteEvidenceNoTdzShadow: fixtureSource.includes("const partState = part.state")
       && !fixtureSource.includes("const state = part.state"),
     strictLoopbackHostnameValidation: fixtureSource.includes("LOOPBACK_HOSTNAMES.has(parsed.hostname)")
       && !fixtureSource.includes("startsWith(\"http://localhost\")"),
     ownedProcessDeadlineCleanup: harnessSource.includes("OWNED_PROCESS_TERM_GRACE_MS")
       && harnessSource.includes("SIGKILL")
       && harnessSource.includes("process-manifest.json")
       && harnessSource.includes("testOwnedProcessCleanupContract"),
     globalSmokeDeadlineAndVerdictArtifacts: SMOKE_MAX_RUNTIME_MS <= 220_000
       && harnessSource.includes("SMOKE_DEADLINE_SAFETY_MS")
       && harnessSource.includes("harness-deadline")
       && harnessSource.includes("status,\n      installedLiveProof: false"),
   };
  assert.deepEqual(Object.values(checks).filter((value) => value === false), [], "smoke tooling contract checks");
  const report = {
    schema: SMOKE_SCHEMA,
    toolingStatus: "pass",
    installedLiveProof: false,
    finalGate: "not-run",
    runDirectory: relative(root, runDir).replaceAll("\\", "/"),
    checks,
    sourceHashes: {
      helper: sha256(helperSource),
      plugin: sha256(pluginSource),
      harness: sha256(harnessSource),
      fixture: sha256(fixtureSource),
    },
    generatedFixtureInitialization: fixtureInitialization,
    note: "Tooling contract only; this does not claim installed OpenCode live PASS.",
  };
  await writeFile(join(runDir, "smoke-contract.json"), JSON.stringify(report, null, 2));
  console.log(`[PASS] smoke-contract tooling checks (installed-live-proof=false; evidence=${relative(root, runDir)})`);
}

async function nextProviderFreeEvidenceRunId(prefix: string): Promise<string> {
  const evidenceRoot = join(smokeProjectRoot(), "tmp", "codex-quota-retry");
  let existing: string[] = [];
  try {
    existing = await readdir(evidenceRoot);
  } catch {
    existing = [];
  }

  const used = new Set(existing);
  if (!used.has(prefix)) {
    return prefix;
  }

  let suffix = 2;
  while (used.has(`${prefix}-${suffix}`)) {
    suffix += 1;
  }
  return `${prefix}-${suffix}`;
}

async function runAllProviderFreeModes(): Promise<void> {
  await runTransportContract();
  runParser();
  await runPassthrough();
  await runNativePolicy();
  await runCooldown();
  await runFakeClock();
  await runIdentityUnit();
  await runCancellationGuard();

  const runId = await nextProviderFreeEvidenceRunId("primary-contract-20261014");
  await runSmokeContract({ mode: "smoke-contract", runId });
  console.log(`[PASS] Codex quota retry provider-free suite (9/9 modes; smoke-contract fixture only; evidence=tmp/codex-quota-retry/${runId})`);
}

async function runSmokeBody(args: SmokeArgs, deadlineState: SmokeDeadlineState): Promise<void> {
  if (args.mode !== "smoke") throw new Error("--smoke is required");
  const root = smokeProjectRoot();
  const runDir = smokeRunDirectory(args);
  await mkdir(runDir, { recursive: true });
  const startedAt = deadlineState.startedAt;
  assertSmokeDeadline(deadlineState);
  const workspace = await writeSmokeWorkspace(runDir);
  const opencodeBin = Bun.which("opencode");
  const bunVersion = Bun.version;
  const opencodeVersion = opencodeBin ? commandOutput(opencodeBin, ["--version"]) : "missing";
  const sourceFixture = await readFile(workspace.fixturePath, "utf8");
  const currentHead = commandOutput("git", ["rev-parse", "HEAD"]);
  const worktreeStatus = commandOutput("git", ["status", "--short", "--untracked-files=all"]);
  const evidenceDir = join(runDir, "evidence");
  const parentEvidenceDir = join(evidenceDir, "parent");
  const cancellationEvidenceDir = join(evidenceDir, "cancellation");
  const requestBudgetPath = join(evidenceDir, "request-budget.json");
  await writeFile(requestBudgetPath, JSON.stringify({ acceptedRequests: 0, maxRequests: SMOKE_MAX_REQUESTS, exceeded: false }, null, 2));
   const isolatedEnv = buildIsolatedEnvironment({
     HOME: join(runDir, "home"),
    XDG_CONFIG_HOME: workspace.configRoot,
    XDG_CACHE_HOME: workspace.cacheRoot,
    XDG_DATA_HOME: workspace.dataRoot,
    XDG_STATE_HOME: workspace.stateRoot,
      CODEX_SMOKE_NO_PROVIDER: "1",
      CODEX_SMOKE_EXTERNAL_NETWORK_DENIED: "1",
      CODEX_SMOKE_RUNTIME_BUN: bunVersion,
      CODEX_SMOKE_RUNTIME_OPENCODE: opencodeVersion,
      CODEX_SMOKE_GOAL_PLUGIN_VERSION: workspace.goalPlugin.version,
      CODEX_SMOKE_REQUEST_BUDGET_PATH: requestBudgetPath,
      CODEX_SMOKE_EVIDENCE_DIR: parentEvidenceDir,
      CODEX_SMOKE_RECORD_IDENTITY: "1",
      CODEX_SMOKE_PARALLEL_SESSION_CONTROL_PATH: join(runDir, "control", "parallel-session.json"),
      OPENCODE_GOAL_STATE_PATH: join(workspace.stateRoot, "goals.json"),
   });
  await mkdir(isolatedEnv.HOME, { recursive: true });
  const expected = JSON.parse(await readFile(join(runDir, "expected-scenarios.json"), "utf8"));
  const manifest = {
    schema: SMOKE_SCHEMA,
    mode: "smoke",
    runId: args.runId ?? relative(root, runDir).replaceAll("\\", "/"),
    startedAt: new Date(startedAt).toISOString(),
    installedLiveProofRequired: true,
    noProvider: true,
    sourceHashes: {
      fixture: sha256(sourceFixture),
      helper: sha256(await readFile(join(workspace.workspace, ".opencode", "lib", "codex-quota-retry.ts"), "utf8")),
       plugin: sha256(await readFile(join(workspace.workspace, ".opencode", "plugins", "10-codex-quota-retry.ts"), "utf8")),
      currentHead,
      worktree: sha256(worktreeStatus),
    },
     runtime: { bun: bunVersion, opencode: opencodeVersion },
     goalPlugin: { package: "@prevalentware/opencode-goal-plugin", pinnedVersion: workspace.goalPlugin.version },
    expected,
    paths: {
      workspace: relative(runDir, workspace.workspace).replaceAll("\\", "/"),
      config: relative(runDir, workspace.configPath).replaceAll("\\", "/"),
       evidence: relative(runDir, evidenceDir).replaceAll("\\", "/"),
       mutation: relative(runDir, workspace.mutationPath).replaceAll("\\", "/"),
    },
  };
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (!opencodeBin || opencodeVersion !== "1.19.0") {
    const verdict = { schema: SMOKE_SCHEMA, status: "BLOCKED", installedLiveProof: false,
      blocker: `required OpenCode 1.19.0 unavailable (observed ${opencodeVersion || "missing"})` };
    await writeFile(join(runDir, "verdict.json"), JSON.stringify(verdict, null, 2));
    console.log(`[BLOCKED] smoke: ${verdict.blocker}`);
    return;
  }

   const prompt = "Run one bounded smoke task. Create the goal through the goal command, delegate exactly one general child, then report the child result once. Do not create another parent or child and do not edit files outside the isolated workspace.";
    assertSmokeDeadline(deadlineState);
    const parent = await runOpenCodeProcess(opencodeBin, workspace.workspace, isolatedEnv, prompt, 100_000, undefined, {
      runDir,
      role: "parent",
      deadlineAtMs: deadlineState.deadlineAtMs,
    });
  await writeFile(join(runDir, "parent-events.jsonl"), parent.stdout);
  await writeFile(join(runDir, "parent-stderr.log"), parent.stderr);
    assertSmokeDeadline(deadlineState);
   const cancellationEnv = buildIsolatedEnvironment({
     ...isolatedEnv,
      CODEX_SMOKE_SCENARIO: "cancel",
      CODEX_SMOKE_EVIDENCE_DIR: cancellationEvidenceDir,
      CODEX_SMOKE_REQUEST_BUDGET_PATH: requestBudgetPath,
   });
    const cancellation = await runNativeCancellation(opencodeBin, workspace.workspace, cancellationEnv, runDir, deadlineState.deadlineAtMs);
   assertSmokeDeadline(deadlineState);
  await writeGoalStateSummary(workspace.stateRoot, runDir);

    const requestTimeline = [
      ...(await readEvidenceJsonLines(join(parentEvidenceDir, "request-timeline.jsonl"))),
      ...(await readEvidenceJsonLines(join(cancellationEvidenceDir, "request-timeline.jsonl"))),
    ];
    const quotaResponses = [
      ...(await readEvidenceJsonLines(join(parentEvidenceDir, "quota-responses.jsonl"))),
      ...(await readEvidenceJsonLines(join(cancellationEvidenceDir, "quota-responses.jsonl"))),
    ];
    const requestIdentityEvidence = [
      ...(await readEvidenceJsonLines(join(parentEvidenceDir, "identity-fetch-telemetry.jsonl"))),
      ...(await readEvidenceJsonLines(join(cancellationEvidenceDir, "identity-fetch-telemetry.jsonl"))),
    ];
    const parentNative = await readNativeEventEvidence(parentEvidenceDir);
    const cancellationNative = await readNativeEventEvidence(cancellationEvidenceDir);
    const allNative = {
      sessionIds: new Set([...parentNative.sessionIds, ...cancellationNative.sessionIds]),
      parentSessionIds: new Set([...parentNative.parentSessionIds, ...cancellationNative.parentSessionIds]),
      childSessionIds: new Set([...parentNative.childSessionIds, ...cancellationNative.childSessionIds]),
      taskResultChildSessionIds: new Set([...parentNative.taskResultChildSessionIds, ...cancellationNative.taskResultChildSessionIds]),
      sessionParentRelations: [...parentNative.sessionParentRelations, ...cancellationNative.sessionParentRelations],
      completedToolParts: [...parentNative.completedToolParts, ...cancellationNative.completedToolParts],
      completedWriteParts: [...parentNative.completedWriteParts, ...cancellationNative.completedWriteParts],
      toolCalls: [...parentNative.toolCalls, ...cancellationNative.toolCalls],
      retryEvents: [...parentNative.retryEvents, ...cancellationNative.retryEvents],
      sessionStatusEvents: [...parentNative.sessionStatusEvents, ...cancellationNative.sessionStatusEvents],
      cancellationEvents: [...parentNative.cancellationEvents, ...cancellationNative.cancellationEvents],
      continuationPromptCount: parentNative.continuationPromptCount + cancellationNative.continuationPromptCount,
    };
    const loadedPlugin = await readFile(join(parentEvidenceDir, "loaded-goal-plugin.json"), "utf8").then((text) => JSON.parse(text) as { version?: string }).catch(() => ({}));
    const fixtureInstalled = await readEvidenceJson(join(parentEvidenceDir, "fixture-installed.json"));
    const blockedExternalRequests = (await readEvidenceJsonLines(join(parentEvidenceDir, "external-network-blocked.jsonl"))).length
      + (await readEvidenceJsonLines(join(cancellationEvidenceDir, "external-network-blocked.jsonl"))).length;
    const goalState = await readEvidenceJson(join(runDir, "goal-state-summary.json"));
    const fixturePreflight = asObject(fixtureInstalled?.preflight);
    const mutationFileText = await readFile(workspace.mutationPath, "utf8").catch(() => "");
    const recordedSideEffects = await readEvidenceJsonLines(join(parentEvidenceDir, "side-effects.jsonl"));
    const observedMutationWrites = parentNative.completedWriteParts.filter((part) =>
      part.filePaths.includes(workspace.mutationPath) && mutationFileText === SMOKE_MUTATION_CONTENT);
    const sideEffects = recordedSideEffects.length > 0 ? recordedSideEffects : observedMutationWrites.map((part) => ({
      identity: workspace.mutationPath,
      tool: "apply_patch",
      toolPartId: part.id,
      persisted: true,
    }));
    const models = requestTimeline.map((entry) => entry.normalizedModel).filter((value): value is string => typeof value === "string");
    const exactRequests = requestTimeline.filter((entry) => entry.route === CODEX_GENERATION_URL);
     const validation = validateSmokeEvidence({
      totalElapsedMs: Date.now() - startedAt,
      maxRuntimeMs: SMOKE_MAX_RUNTIME_MS,
      runtime: { bun: bunVersion, opencode: opencodeVersion, goalPluginVersion: loadedPlugin.version },
      preflight: mapFixturePreflight(fixtureInstalled, fixturePreflight, blockedExternalRequests),
      requestBudget: await readEvidenceJson(requestBudgetPath) as SmokeEvidenceSnapshot["requestBudget"],
      requestTimeline,
      quotaResponses,
       native: {
         // Workflow identity and completed writes come from the parent run;
         // cancellation is a separate native session and contributes only
         // retry/abort evidence below.
         sessionIds: [...parentNative.sessionIds],
          parentSessionIds: [...parentNative.parentSessionIds],
          childSessionIds: [...parentNative.childSessionIds],
          taskResultChildSessionIds: [...parentNative.taskResultChildSessionIds],
          sessionParentRelations: parentNative.sessionParentRelations,
          completedToolParts: parentNative.completedToolParts,
          completedWriteParts: parentNative.completedWriteParts,
          retryEvents: allNative.retryEvents,
          sessionStatusEvents: allNative.sessionStatusEvents,
          cancellationEvents: allNative.cancellationEvents,
         continuationPromptCount: allNative.continuationPromptCount,
         toolCalls: parentNative.toolCalls,
       },
      goalRecords: asObject(goalState)?.goalRecords as Array<Record<string, unknown>> | undefined,
      sideEffects,
      mutationFileText,
        cancellation: {
        nativeRetryObserved: cancellation.nativeRetryObserved,
        nativeCancelObserved: cancellation.nativeCancelObserved,
        sessionId: cancellation.sessionId,
        abortRequestAtMs: cancellation.abortRequestAtMs,
        abortResponseAtMs: cancellation.abortResponseAtMs,
        abortResponseStatus: cancellation.abortResponseStatus,
        abortSucceeded: cancellation.abortSucceeded,
        originalDeadlineMs: cancellation.originalDeadlineMs,
        monitoredUntilMs: cancellation.monitoredUntilMs,
        cancellationRequestsAtAbort: cancellation.cancellationRequestsAtAbort,
          cancellationRequestsAtDeadline: cancellation.cancellationRequestsAtDeadline,
        },
        parallel: {
          sessionId: cancellation.parallelSessionId,
          responseStatus: cancellation.parallelResponseStatus,
          submittedAtMs: cancellation.parallelSubmittedAtMs,
          requestObservedAtMs: cancellation.parallelRequestObservedAtMs,
          nativeSessionObserved: cancellation.parallelNativeSessionObserved,
          cancellationServerPid: cancellation.serverPid,
          parallelServerPid: cancellation.serverPid,
        },
        requestIdentityEvidence,
      });
    assertSmokeDeadline(deadlineState);
    const assertions = {
     ...validation.assertions,
     productionWrapperObserved: exactRequests.some((entry) => entry.productionWrapperObserved === true),
     installedFixtureRecorded: fixtureInstalled?.installedBeforeProductionWrapper === false,
     goalPluginVersionObserved: loadedPlugin.version === "0.1.60",
     cancellationViaNativeAbort: cancellation.abortResponse === true || (cancellation.abortResponse && typeof cancellation.abortResponse === "object" && (cancellation.abortResponse as { result?: unknown }).result === true),
   };
   const status = validation.status;
   const verdict = {
    schema: SMOKE_SCHEMA,
    status,
    installedLiveProof: status === "PASS",
    finalGate: "orchestrator-task-4.2",
    driverExitCodeNotGate: true,
    elapsedMs: Date.now() - startedAt,
      requestCounts: { exactCodex: exactRequests.length, quota: quotaResponses.length, cancellation: exactRequests.filter((entry) => entry.evidenceRun === "cancellation").length },
     models: [...new Set(models)],
     sessionIds: [...allNative.sessionIds],
     parentSessionIds: [...allNative.parentSessionIds],
     childSessionIds: [...allNative.childSessionIds],
      nativeCompletedToolParts: allNative.completedToolParts,
      nativeToolCalls: allNative.toolCalls,
      cancellationApi: {
        requestAtMs: cancellation.abortRequestAtMs,
        responseStatus: cancellation.abortResponseStatus,
        succeeded: cancellation.abortSucceeded,
        response: cancellation.abortResponse,
      },
      parallelSession: {
        responseStatus: cancellation.parallelResponseStatus,
        submittedAfterOriginalRetryDeadline: typeof cancellation.originalDeadlineMs === "number"
          && cancellation.parallelSubmittedAtMs > cancellation.originalDeadlineMs + 250,
        nativeSessionObserved: cancellation.parallelNativeSessionObserved,
        sameServerProcess: typeof cancellation.serverPid === "number",
      },
      requestIdentityEvidence: {
        file: "evidence/cancellation/identity-fetch-telemetry.jsonl",
        records: requestIdentityEvidence.length,
        values: "allowlisted identity field names and SHA-256 digests only",
        rawHeadersOrIdsPersisted: false,
      },
      cancellationMessage: cancellation.messageResponse,
      assertions,
      missingRequiredEvidence: validation.missingRequiredEvidence,
      failedAssertions: validation.failedAssertions,
       evidence: ["manifest.json", "expected-scenarios.json", "plugin-load-order.json", "process-manifest.json", "parent-events.jsonl",
        "evidence/parent/native-events.jsonl", "evidence/parent/identity-fetch-telemetry.jsonl",
        "evidence/cancellation/aborted-fetch-attempts.jsonl", "evidence/cancellation/native-events.jsonl",
        "evidence/cancellation/identity-fetch-telemetry.jsonl",
        "evidence/request-budget.json", "evidence/request-timeline.jsonl", "goal-state-summary.json", "verdict.json"],
  };
   await writeFile(join(runDir, "verdict.json"), JSON.stringify(verdict, null, 2));
   console.log(`[${status}] smoke driver completed; installed-live-proof=${verdict.installedLiveProof}; final-verdict-owned-by=task-4.2`);
}

async function runSmoke(): Promise<void> {
  const args = parseSmokeArgs(Bun.argv.slice(2));
  if (!args || args.mode !== "smoke") throw new Error("--smoke is required");
  const startedAt = Date.now();
  const runDir = smokeRunDirectory(args);
  const deadlineState: SmokeDeadlineState = {
    startedAt,
    deadlineAtMs: startedAt + Math.max(1, SMOKE_MAX_RUNTIME_MS - SMOKE_DEADLINE_SAFETY_MS),
    expired: false,
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = runSmokeBody(args, deadlineState);
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        deadlineState.expired = true;
        reject(new SmokeDeadlineError());
      }, Math.max(1, deadlineState.deadlineAtMs - Date.now()));
    });
    await Promise.race([body, deadline]);
  } catch (error) {
    const deadlineExceeded = error instanceof SmokeDeadlineError || deadlineState.expired || Date.now() >= deadlineState.deadlineAtMs;
    const status = deadlineExceeded ? "BLOCKED" : "FAIL";
    await mkdir(runDir, { recursive: true });
    try {
      await readFile(join(runDir, "process-manifest.json"), "utf8");
    } catch {
      await writeFile(join(runDir, "process-manifest.json"), JSON.stringify({
        schema: "codex-quota-retry-process-manifest.v1",
        processes: [],
      }, null, 2));
    }
    const verdict = {
      schema: SMOKE_SCHEMA,
      status,
      installedLiveProof: false,
      finalGate: "harness-deadline",
      driverExitCodeNotGate: true,
      elapsedMs: Date.now() - startedAt,
      maxRuntimeMs: SMOKE_MAX_RUNTIME_MS,
      blocker: deadlineExceeded ? "smoke global deadline exceeded; evidence is incomplete" : String(error),
      evidence: ["manifest.json", "process-manifest.json", "expected-scenarios.json", "parent-events.jsonl", "parent-stderr.log", "cancellation-server-stdout.log", "server-stderr.log", "verdict.json"],
    };
    await writeFile(join(runDir, "verdict.json"), JSON.stringify(verdict, null, 2));
    console.log(`[${status}] smoke harness terminated with bounded cleanup; evidence=${relative(smokeProjectRoot(), runDir)}`);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

const requestedMode = Bun.argv[2];
if (requestedMode === "--all") {
  await runAllProviderFreeModes();
} else if (requestedMode === "--transport-contract") {
  await runTransportContract();
} else if (requestedMode === "--parser") {
  runParser();
} else if (requestedMode === "--passthrough") {
  await runPassthrough();
} else if (requestedMode === "--native-policy") {
  await runNativePolicy();
} else if (requestedMode === "--cooldown") {
  await runCooldown();
} else if (requestedMode === "--fake-clock") {
  await runFakeClock();
} else if (requestedMode === "--identity-unit") {
  await runIdentityUnit();
} else if (requestedMode === "--cancellation-guard") {
  await runCancellationGuard();
} else if (requestedMode === "--identity-contract") {
  await runIdentityContract();
} else if (requestedMode === "--smoke-contract") {
  await runSmokeContract();
} else if (requestedMode === "--smoke") {
  await runSmoke();
} else {
  console.log("Usage: bun scripts/test_codex_quota_retry.ts --all|--parser|--transport-contract|--passthrough|--native-policy|--cooldown|--fake-clock|--identity-unit|--cancellation-guard|--identity-contract [--run-id <id>]|--smoke-contract --run-id <id>|--smoke --run-id <id>");
  console.log("Identity evidence is claimed once under tmp/codex-quota-retry/<run-id>/identity/; omit --run-id to allocate a unique id. Existing evidence is never overwritten or deleted.");
}
