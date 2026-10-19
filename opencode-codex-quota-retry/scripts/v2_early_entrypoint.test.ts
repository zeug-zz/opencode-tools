import assert from "node:assert/strict";
import { test } from "bun:test";
import { composeV2CanaryFixture, initializeV2CanaryModule } from "./v2_canary_composition.ts";

const REGISTRY = Symbol.for("opencode.codex-quota-retry.fetch-wrapper");
const V2_WRAPPER = Symbol.for("opencode.codex-quota-retry.v2-fetch-wrapper");
const GLOBAL_KEYS = [
  REGISTRY,
  V2_WRAPPER,
  Symbol.for("opencode.codex-quota-retry.v2-options"),
  Symbol.for("opencode.codex-quota-retry.v2-plugin-setup"),
  Symbol.for("opencode.codex-quota-retry.v2-correlation"),
  Symbol.for("opencode.codex-quota-retry.v2-cancellation-markers"),
  Symbol.for("opencode.codex-quota-retry.route-cooldown"),
  Symbol.for("opencode.codex-quota-retry.cancellation-state"),
];
const MODULE_PROBE = "https://v2-canary.invalid/internal-early-wrapper-probe";
const CODEX_ROUTE = "https://chatgpt.com/backend-api/codex/responses";
const PRIVATE_HEADER = "x-opencode-codex-quota-retry-correlation";

test("module guards precede dynamic V2 entrypoint import and captured wrapper delegates only through the guard", async () => {
  const global = globalThis as Record<PropertyKey, unknown>;
  const previousFetch = globalThis.fetch;
  const previousValues = GLOBAL_KEYS.map((key) => global[key]);
  for (const key of GLOBAL_KEYS) delete global[key];

  let unguardedHostCalls = 0;
  let syntheticProviderDelegateCalls = 0;
  let transportCleanupCalls = 0;
  let setupRecorderComplete = false;
  const hooks: Array<(event: any) => void | Promise<void>> = [];
  let fixtureCleanup: (() => Promise<void>) | undefined;
  globalThis.fetch = (async () => {
    unguardedHostCalls++;
    throw new Error("fake host fetch reached without application guard");
  }) as typeof fetch;

  try {
    const initialized = await initializeV2CanaryModule({
      installTransportInterposer: () => {
        const hostFetch = globalThis.fetch;
        const interposerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url === MODULE_PROBE) return new Response(null, { status: 204, headers: { "x-v2-canary-probe": "guarded" } });
          if (url === CODEX_ROUTE) {
            syntheticProviderDelegateCalls++;
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            assert.equal(headers.has(PRIVATE_HEADER), false, "product wrapper strips the private header before the fixture delegate");
            return new Response("fixture-only", { status: 200 });
          }
          throw new Error(`application-level network deny: ${new URL(url).origin}`);
        }) as typeof fetch;
        globalThis.fetch = interposerFetch;
        return {
          hostFetch,
          interposerFetch,
          cleanup: () => { transportCleanupCalls++; if (globalThis.fetch === interposerFetch) globalThis.fetch = hostFetch; },
        };
      },
      importCanonicalProduct: () => import(`../src/plugins/codex-quota-retry-v2.ts?fixture-module-${Date.now()}`),
      verifyEarlyCapture: async ({ transport, capturedFetch }) => {
        const registry = global[REGISTRY] as { original?: unknown; wrapper?: unknown } | undefined;
        assert.strictEqual(globalThis.fetch, capturedFetch);
        assert.strictEqual(capturedFetch, global[V2_WRAPPER]);
        assert.strictEqual(capturedFetch, registry?.wrapper);
        assert.notStrictEqual(capturedFetch, transport.hostFetch, "the early module replaced the original host fetch pointer");
        assert.strictEqual(registry?.original, transport.interposerFetch,
          "early entrypoint must capture the guarded interposer as its inner delegate");
        const probe = await capturedFetch(MODULE_PROBE);
        assert.equal(probe.status, 204);
        assert.equal(probe.headers.get("x-v2-canary-probe"), "guarded");
      },
    });

    const context = {
      location: { directory: "early-entrypoint-fixture" },
      session: {
        hook: async (_name: string, callback: (event: any) => void | Promise<void>) => {
          hooks.push(callback);
          return { dispose: async () => {} };
        },
      },
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        }),
      },
    };

    fixtureCleanup = await composeV2CanaryFixture({
      context,
      transport: initialized.transport,
      assertCapturedWrapper: () => {
        const registry = global[REGISTRY] as { original?: unknown; wrapper?: unknown } | undefined;
        assert.strictEqual(globalThis.fetch, initialized.capturedFetch,
          "setup aborts before any generation if host-visible fetch differs from early captured wrapper");
        assert.strictEqual(globalThis.fetch, registry?.wrapper);
        assert.strictEqual(registry?.original, initialized.transport.interposerFetch);
      },
      setupFixtureRecorder: async () => {
        setupRecorderComplete = true;
        return async () => {};
      },
      setupCanonicalProduct: async () => {
        assert.equal(setupRecorderComplete, true);
        const setup = initialized.product.default.setup(context as never);
        const cleanup = setup instanceof Promise ? await setup : setup;
        assert.strictEqual(globalThis.fetch, initialized.capturedFetch,
          "canonical setup configures the early wrapper without replacing it");
        return cleanup;
      },
    });

    const hookEvent: any = {
      kind: "primary",
      sessionID: "ses_early_entrypoint_child",
      request: new Request(CODEX_ROUTE, { method: "POST", headers: { "x-session-id": "root-only-header" } }),
    };
    for (const callback of hooks) await callback(hookEvent);
    assert.equal(hookEvent.request.headers.has(PRIVATE_HEADER), true, "native hook issues its internal correlation token");
    const response = await initialized.capturedFetch(CODEX_ROUTE, {
      method: "POST", headers: hookEvent.request.headers,
    });
    assert.equal(response.status, 200);
    assert.equal(syntheticProviderDelegateCalls, 1);
    assert.equal(unguardedHostCalls, 0, "all fake transport calls stayed behind the application interposer");
    await fixtureCleanup();
    fixtureCleanup = undefined;
    assert.equal(transportCleanupCalls, 0, "plugin setup cleanup must not restore or overwrite the module-level transport chain");
    assert.strictEqual(globalThis.fetch, initialized.capturedFetch);
  } finally {
    await fixtureCleanup?.();
    globalThis.fetch = previousFetch;
    GLOBAL_KEYS.forEach((key, index) => {
      const value = previousValues[index];
      if (value === undefined) delete global[key];
      else Object.defineProperty(global, key, { configurable: true, enumerable: false, writable: true, value });
    });
  }
});
