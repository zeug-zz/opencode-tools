import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantTranscript, buildSessionInterruptRequest, fixturePluginSource, verifyInstalledClientContract } from "./v2_retry_canary.ts";
import { buildSyntheticResponsesSSE } from "./v2_canary_composition.ts";

const SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "v2_retry_canary.ts"), "utf8");

function testV2HookRegistrationAndEventPayload(): void {
  assert.match(SOURCE, /ctx\.session\.hook\("model\.request"/);
  assert.match(SOURCE, /ctx\.session\.hook\("http\.request"/);
  assert.match(SOURCE, /ctx\.session\.hook\("http\.response"/);
  assert.match(SOURCE, /event\?\.data\s*\?\?\s*\{\}/);
  assert.match(SOURCE, /data\.sessionID/);
  assert.match(SOURCE, /data\.at/);
  assert.match(SOURCE, /data\.reason/);
  assert.match(SOURCE, /ctx\.event\.subscribe\(\{ signal: controller\.signal \}\)/);
  assert.match(SOURCE, /controller\.abort\(\)/);
  assert.match(SOURCE, /registration\.dispose\(\)/);
  assert.doesNotMatch(SOURCE, /return\s*\{\s*["'](?:model\.request|http\.request|http\.response)/);
}

function testCanaryCarriesCanonicalCorrelationEvidenceRatherThanUsingObjectIdentity(): void {
  assert.match(SOURCE, /identitySource:\s*"native-http\.request-hook"/);
  assert.match(SOURCE, /canonicalEarlyEntrypoint:\s*sha256\(canonicalEntrypoint\.toString\("utf8"\)\)/);
  assert.match(SOURCE, /copy byte-for-byte|canonicalEntrypoint/);
  assert.match(SOURCE, /autoLoadedFiles: \["00-v2-fixture\.ts"\]/);
  assert.match(SOURCE, /fixture-module-guards-before-dynamic-early-v2-import/);
  assert.match(SOURCE, /fixture-composed-setup-not-loader-proof/);
  assert.match(SOURCE, /canonical\/plugins\/codex-quota-retry-v2\.ts/);
  assert.match(SOURCE, /guardsInstalledBeforeDynamicEarlyEntrypointImport/);
  assert.match(SOURCE, /outerCapturedFetchIsRegisteredV2Wrapper/);
  assert.match(SOURCE, /productOriginalIsGuardedInterposer/);
  assert.match(SOURCE, /fetchChangedDuringCanonicalSetup: fetchBeforeCanonicalSetup !== fetchAfterCanonicalSetup/);
  assert.match(SOURCE, /fetchReplacedBeforeEarlyEntrypointImport: true/);
  assert.doesNotMatch(SOURCE, /requestIdentityObject|headersIdentityObject|signalIdentityObject|WeakMap/);
}

function testInstalledV2ApiAndNativeConfig(): void {
  assert.match(SOURCE, /\/api\/session/);
  assert.match(SOURCE, /\/api\/session\/\$\{encodeURIComponent\(rootID\)\}\/prompt/);
  assert.match(SOURCE, /\/api\/session\/\$\{encodeURIComponent\(childID\)\}\/prompt/);
  assert.match(SOURCE, /\/api\/experimental\/session\/\$\{encodeURIComponent\((?:rootID|childID)\)\}\/wait/);
  assert.match(SOURCE, /export async function verifyInstalledClientContract/);
  assert.match(SOURCE, /installed_client_contract_mismatch:\$\{code\}/);
  assert.match(SOURCE, /messagePath.*api\/session\/\$\{encodeURIComponent\(input\.sessionID\)\}\/message/);
  assert.match(SOURCE, /interruptSection\.includes\('query: \{ resume: input\["resume"\] \}'\)/);
  assert.match(SOURCE, /SessionPromptInput/);
  assert.match(SOURCE, /providers:\s*\{\s*openai:\s*\{/);
  assert.match(SOURCE, /settings:\s*\{ baseURL:[^}]+transport:\s*"http"/);
  assert.match(SOURCE, /encoding:\s*"none"/);
  assert.match(SOURCE, /models:\s*\{\s*"gpt-6\.1-sol"/);
  assert.match(SOURCE, /model:\s*"openai\/gpt-6\.1-sol"/);
  assert.match(SOURCE, /plugins", "00-v2-fixture\.ts"/);
  assert.match(SOURCE, /api\/session\/\$\{encodeURIComponent\(rootID\)\}\/message/);
  assert.doesNotMatch(SOURCE, /plugins:\s*\[/);
}

async function testInstalledClientPreflightExecutesWithoutStartingServer(): Promise<void> {
  const contract = await verifyInstalledClientContract();
  assert.ok(contract.clientSource.length > 0);
  assert.ok(contract.typeSource.length > 0);
}

function testGeneratedFixturePluginTranspiles(): void {
  const generated = fixturePluginSource();
  new Bun.Transpiler({ loader: "ts" }).transformSync(generated);
  assert.match(generated, /correlateCodexQuotaRetryV2HttpRequest/);
  assert.match(generated, /application-level-deny/);
  assert.match(generated, /moduleComposition\.product\.default\.setup\(ctx\)/);
  assert.match(generated, /buildSyntheticResponsesSSE\("synthetic canary success", state\.count\)/);
  assert.match(generated, /initializeV2CanaryModule/);
  assert.match(generated, /installTransportInterposer/);
  assert.match(generated, /composeV2CanaryFixture/);
  const interposerDefinition = generated.indexOf("function installTransportInterposer()");
  assert.ok(interposerDefinition >= 0);
  const moduleInit = generated.indexOf("const moduleComposition = await initializeV2CanaryModule");
  const dynamicProductImport = generated.indexOf('import("../canonical/plugins/codex-quota-retry-v2.ts")', moduleInit);
  const pluginDefinition = generated.indexOf("export default Plugin.define", dynamicProductImport);
  assert.ok(interposerDefinition < moduleInit && moduleInit < dynamicProductImport && dynamicProductImport < pluginDefinition,
    "module-level network guards install before the dynamic early V2 entrypoint import resolves");
  assert.doesNotMatch(generated, /import\s+CanonicalProduct\s+from\s+["']\.\.\/canonical\/plugins/,
    "the early V2 entrypoint must never be a static fixture import");
  assert.match(generated, /early_v2_wrapper_not_outer_captured_pointer/);
  assert.match(generated, /MODULE_PROBE/);
  const interruption = generated.indexOf('event.type === "session.execution.interrupted"');
  const delay = generated.indexOf("setTimeout(resolve, 25)", interruption);
  const probe = generated.indexOf("correlateCodexQuotaRetryV2HttpRequest(correlated)", delay);
  assert.ok(interruption >= 0 && interruption < delay && delay < probe,
    "fixture waits one bounded next turn after the exact native interruption before probing");
  assert.match(generated, /sessionID, request/);
  assert.doesNotMatch(generated, /observeCodexQuotaRetryV2Event|v2CancellationMarkers/,
    "probe does not manually invoke product observers or populate cancellation markers");
}

function testIsolationEvidenceAndBounds(): void {
  assert.match(SOURCE, /OPENCODE_CONFIG_PROJECT_DISABLE:\s*"1"/);
  assert.match(SOURCE, /OPENCODE_DISABLE_MODELS_FETCH:\s*"1"/);
  assert.match(SOURCE, /OPENCODE_GOAL_STATE_PATH:/);
  assert.match(SOURCE, /const LIMIT_MS = 180_000/);
  assert.match(SOURCE, /const MAX_PROVIDER_REQUESTS = 12/);
  assert.match(SOURCE, /resetMs: 5_000, helperGraceMs: 60_000, targetNativeDelayMs: 65_000/);
  assert.match(SOURCE, /Date\.now\(\) \+ 5_000/);
  assert.match(SOURCE, /"retry-after-ms": "5000"/);
  assert.match(SOURCE, /const serverUsername = "opencode"/);
  assert.doesNotMatch(SOURCE, /OPENCODE_SERVER_USERNAME/);
  assert.match(SOURCE, /record\("server\.readiness"/);
  assert.match(SOURCE, /lastHTTPStatus/);
  assert.match(SOURCE, /server\.stdout\.log/);
  assert.match(SOURCE, /server\.stderr\.log/);
  assert.match(SOURCE, /source-hashes\.json/);
  assert.match(SOURCE, /source-snapshots/);
  assert.match(SOURCE, /application-level-network-guards; not OS-level egress isolation/);
  assert.match(SOURCE, /typeof options === "number" \? \(typeof args\[0\] === "string" \? args\[0\]/);
  assert.match(SOURCE, /globalThis\.Bun\.connect/);
  assert.match(SOURCE, /expected-scenarios\.json/);
  assert.match(SOURCE, /verdict\.json/);
  assert.match(SOURCE, /session\.execution\.interrupted/);
  assert.match(SOURCE, /controlled-late-fetch-probe/);
  assert.match(SOURCE, /child\.no-late-provider-call/);
  assert.match(SOURCE, /synthetic canary success/);
  assert.match(SOURCE, /assistantTranscript\(transcript\)/);
  assert.match(SOURCE, /assistantErrorReason/);
  assert.match(SOURCE, /installed-v2-session-message-assistant-content/);
  assert.doesNotMatch(SOURCE, /\/abort/);
  assert.match(SOURCE, /session\.execution\.succeeded/);
  assert.match(SOURCE, /finalGuardSummaryAfterScenario/);
  assert.match(SOURCE, /networkSummaries\.at\(-1\)/);
  assert.match(SOURCE, /setTimeout\(resolve, 25\)/);
  assert.match(SOURCE, /scenario\.started/);
  assert.match(SOURCE, /scenario\.failed/);
  assert.match(SOURCE, /isAssertionOrLeakFailure/);
  assert.doesNotMatch(SOURCE, /observeCodexQuotaRetryV2Event\s*\(/);
  assert.match(SOURCE, /providerCallsAtInterruption/);
  assert.match(SOURCE, /SIGKILL-owned-child-after-SIGTERM-timeout/);
}

function testV2InterruptEndpointAndQueryBodyContract(): void {
  const request = buildSessionInterruptRequest("ses_fixture-child");
  assert.equal(request.endpoint, "/api/session/ses_fixture-child/interrupt?resume=false");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, undefined, "installed V2 schema defines resume=false as query, not JSON body");
  assert.doesNotMatch(request.endpoint, /\/abort/);
}

test("V2 hook registrations and event payloads use V2 contracts", testV2HookRegistrationAndEventPayload);
test("canary records authoritative identity and canonical product source hashes", testCanaryCarriesCanonicalCorrelationEvidenceRatherThanUsingObjectIdentity);
test("installed V2 API routes and native Codex configuration are pinned", testInstalledV2ApiAndNativeConfig);
test("child interruption follows installed V2 client endpoint/query contract", testV2InterruptEndpointAndQueryBodyContract);
test("canary isolation, evidence, logs, and request bounds are present", testIsolationEvidenceAndBounds);
test("actual installed client preflight passes without starting the server", testInstalledClientPreflightExecutesWithoutStartingServer);
test("generated fixture plugin source transpiles without starting the installed server", testGeneratedFixturePluginTranspiles);

test("synthetic Responses SSE follows the V2 output lifecycle with stable response and item IDs", async () => {
  const response = buildSyntheticResponsesSSE("synthetic canary success", 7);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n\n").map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data, `SSE frame has a data line: ${frame}`);
    return JSON.parse(data.slice("data: ".length)) as Record<string, any>;
  });
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const responseID = events[0]!.response.id;
  const itemID = events[1]!.item.id;
  assert.equal(events[0]!.response.status, "in_progress");
  assert.equal(events[1]!.item.status, "in_progress");
  assert.equal(events[1]!.item.role, "assistant");
  assert.equal(events[2]!.item_id, itemID);
  assert.equal(events[3]!.item_id, itemID, "output_text.delta includes the required item_id");
  assert.equal(events[4]!.item_id, itemID);
  assert.equal(events[5]!.item_id, itemID);
  assert.equal(events[6]!.item.id, itemID);
  assert.equal(events[6]!.item.status, "completed");
  assert.equal(events[7]!.response.id, responseID);
  assert.equal(events[7]!.response.status, "completed");
  assert.equal(events[7]!.response.output[0].id, itemID);
  assert.equal(events[7]!.response.output[0].content[0].text, "synthetic canary success");
});

test("transcript assertion accepts only exact assistant text and retains a safe assistant error code", () => {
  const promptOnly = assistantTranscript({ data: [
    { type: "user", content: [{ type: "text", text: "Reply with the exact words synthetic canary success." }] },
  ] });
  assert.equal(promptOnly.messageCount, 0);
  assert.deepEqual(promptOnly.textParts, []);
  const assistantError = assistantTranscript({ data: [
    { type: "assistant", content: [], error: { type: "ProviderError", message: "provider.invalid-output: response.output_text.delta is missing item_id" } },
  ] });
  assert.deepEqual(assistantError.errorReasons, ["provider.invalid-output"]);
  const success = assistantTranscript({ data: [
    { type: "user", content: [{ type: "text", text: "Reply with the exact words synthetic canary success." }] },
    { type: "assistant", content: [{ type: "text", text: "synthetic canary success" }] },
  ] });
  assert.equal(success.messageCount, 1);
  assert.deepEqual(success.textParts, ["synthetic canary success"]);
});
