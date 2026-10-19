export type V2CanaryCleanup = () => void | Promise<void>;

/** Provider-free fixture stream matching the installed Open Responses lifecycle. */
export function buildSyntheticResponsesSSE(text: string, ordinal: number): Response {
  const responseID = `resp_canary_${ordinal}`;
  const itemID = `msg_canary_${ordinal}`;
  const inProgress = { id: responseID, object: "response", status: "in_progress", model: "gpt-6.1-sol", output: [], usage: null };
  const contentPart = (value: string) => ({ type: "output_text", text: value, annotations: [] });
  const inProgressItem = { type: "message", id: itemID, status: "in_progress", role: "assistant", content: [] };
  const completedItem = { type: "message", id: itemID, status: "completed", role: "assistant",
    content: [contentPart(text)] };
  const completedResponse = { ...inProgress, status: "completed", output: [completedItem],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [
    { type: "response.created", response: inProgress },
    { type: "response.output_item.added", output_index: 0, item: inProgressItem },
    { type: "response.content_part.added", item_id: itemID, output_index: 0, content_index: 0, part: contentPart("") },
    { type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: itemID, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: itemID, output_index: 0, content_index: 0, part: contentPart(text) },
    { type: "response.output_item.done", output_index: 0, item: completedItem },
    { type: "response.completed", response: completedResponse },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "content-encoding": "identity" } });
}

export interface V2CanaryTransportHandle {
  hostFetch: typeof fetch;
  interposerFetch: typeof fetch;
  cleanup: V2CanaryCleanup;
}

export interface V2CanaryModuleInitialization<Product> {
  installTransportInterposer: () => V2CanaryTransportHandle;
  importCanonicalProduct: () => Promise<Product>;
  verifyEarlyCapture: (input: { product: Product; transport: V2CanaryTransportHandle; capturedFetch: typeof fetch }) => void | Promise<void>;
}

/** Install all guards before dynamically importing the early-fetch product entrypoint. */
export async function initializeV2CanaryModule<Product>(
  initialization: V2CanaryModuleInitialization<Product>,
): Promise<{ product: Product; transport: V2CanaryTransportHandle; capturedFetch: typeof fetch }> {
  const transport = initialization.installTransportInterposer();
  try {
    const product = await initialization.importCanonicalProduct();
    const capturedFetch = globalThis.fetch;
    await initialization.verifyEarlyCapture({ product, transport, capturedFetch });
    return { product, transport, capturedFetch };
  } catch (error) {
    // Keep the application-level deny layer installed on failure: restoring a
    // raw host fetch could let a startup/setup failure escape containment.
    throw error;
  }
}

export interface V2CanaryComposition<Context> {
  context: Context;
  transport: V2CanaryTransportHandle;
  assertCapturedWrapper: () => void | Promise<void>;
  setupFixtureRecorder: (context: Context) => V2CanaryCleanup | Promise<V2CanaryCleanup>;
  setupCanonicalProduct: (context: Context) => V2CanaryCleanup | Promise<V2CanaryCleanup>;
}

/**
 * Confirm the host-visible early wrapper first, then register fixture observers
 * and configure that same canonical plugin instance. The module-evaluation
 * transport is intentionally not restored during plugin setup cleanup.
 */
export async function composeV2CanaryFixture<Context>(
  composition: V2CanaryComposition<Context>,
): Promise<() => Promise<void>> {
  let recorderCleanup: V2CanaryCleanup | undefined;
  let productCleanup: V2CanaryCleanup | undefined;

  const cleanup = async (): Promise<void> => {
    let firstError: unknown;
    for (const action of [productCleanup, recorderCleanup]) {
      try { await action?.(); } catch (error) { firstError ??= error; }
    }
    if (firstError !== undefined) throw firstError;
  };

  try {
    await composition.assertCapturedWrapper();
    recorderCleanup = await composition.setupFixtureRecorder(composition.context);
    productCleanup = await composition.setupCanonicalProduct(composition.context);
  } catch (error) {
    try { await cleanup(); } catch {}
    throw error;
  }

  let cleanupPromise: Promise<void> | undefined;
  return () => cleanupPromise ??= cleanup();
}
