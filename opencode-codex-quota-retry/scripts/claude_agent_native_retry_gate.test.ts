import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  hasPersistedScriptedSuccessText,
  isPositiveOverride,
  isUnchangedNegative,
  safeNativeObservation,
  summarizeNativeMessage,
  type SafeNativeObservation,
} from "./claude_agent_native_retry_gate.ts";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const reset = new Date(NOW + 120_000).toISOString();
const fiveHourMessage = `Claude Code subscription limit reached (five hour). Resets at ${reset}.`;

function observation(phase: SafeNativeObservation["phase"], decisionRetry: boolean, delay?: number): SafeNativeObservation {
  return {
    phase,
    providerID: "claude-agent",
    modelID: "claude-sonnet-4-5",
    errorType: "provider.unknown",
    messageCategory: "session_limit_five_hour_future_reset",
    resetStatus: "future",
    resetHorizonBucket: "under_six_hours",
    decisionRetry,
    ...(delay === undefined ? {} : { decisionDelayMs: delay }),
  };
}

test("safe native observation records only categorical fields, not the native message", () => {
  const event = {
    model: { providerID: "claude-agent", id: "claude-sonnet-4-5" },
    error: { type: "provider.unknown", message: fiveHourMessage },
    attempt: 2,
    decision: { retry: false },
  };
  const safe = safeNativeObservation(event, "before_product", NOW);
  assert.equal(safe.messageCategory, "session_limit_five_hour_future_reset");
  assert.equal(safe.decisionRetry, false);
  assert.equal(JSON.stringify(safe).includes(fiveHourMessage), false);
  assert.equal("message" in safe, false);
});

test("native message categories distinguish missing reset, weekly, overload, auth, and billing", () => {
  assert.equal(summarizeNativeMessage("Claude Code subscription limit reached.", undefined, NOW).messageCategory, "session_limit_no_reset");
  assert.equal(summarizeNativeMessage(`Claude Code subscription limit reached (seven day). Resets at ${new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString()}.`, undefined, NOW).messageCategory,
    "session_limit_weekly_reset");
  assert.equal(summarizeNativeMessage("Anthropic is overloaded (529).", 529, NOW).messageCategory, "overload");
  assert.equal(summarizeNativeMessage("Claude Code could not finish its reply (HTTP 401)", 401, NOW).messageCategory, "authentication");
  assert.equal(summarizeNativeMessage("Check your Claude plan and extra-usage settings.", undefined, NOW).messageCategory, "billing");
});

test("positive override requires native false before product and bounded true delay after", () => {
  assert.equal(isPositiveOverride(observation("before_product", false), observation("after_product", true, 180_000)), true);
  assert.equal(isPositiveOverride(observation("before_product", true), observation("after_product", true, 180_000)), false);
  assert.equal(isPositiveOverride(observation("before_product", false), observation("after_product", false)), false);
  assert.equal(isPositiveOverride(observation("before_product", false), observation("after_product", true, 3_000_000_000)), false);
});

test("negative decision predicate rejects a retry or a changed delay", () => {
  assert.equal(isUnchangedNegative(observation("before_product", false), observation("after_product", false)), true);
  assert.equal(isUnchangedNegative(observation("before_product", false, 5_000), observation("after_product", false, 5_001)), false);
  assert.equal(isUnchangedNegative(observation("before_product", false), observation("after_product", true, 1_000)), false);
});

test("scripted success detection matches persisted text parts without retaining content", () => {
  const output = { data: [{ info: { id: "synthetic", role: "assistant" }, parts: [{ type: "text", text: "GATE_SUCCESS" }] }] };
  assert.equal(hasPersistedScriptedSuccessText(output, "GATE_SUCCESS"), true);
  assert.equal(hasPersistedScriptedSuccessText({ data: [{ type: "text", text: "other" }] }, "GATE_SUCCESS"), false);
  assert.equal(JSON.stringify(hasPersistedScriptedSuccessText(output, "GATE_SUCCESS")).includes("GATE_SUCCESS"), false);
});
