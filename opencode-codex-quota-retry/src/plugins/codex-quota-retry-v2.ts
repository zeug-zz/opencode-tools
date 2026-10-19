import { installCodexQuotaRetryFetch } from "../lib/codex-quota-retry.ts";
import CodexQuotaRetryPlugin from "../lib/codex-quota-retry.ts";

// OpenCode's V2 transport captures global fetch before invoking plugin setup.
// Install at module evaluation so that captured reference already crosses the
// canonical adapter. setup later configures this same wrapper.
const installation = installCodexQuotaRetryFetch({ v2Correlation: true });
if (installation.compatible === false) {
  throw new Error("Codex quota retry V2 entrypoint requires a fresh service process; an existing non-V2 fetch wrapper cannot be upgraded safely");
}

export default CodexQuotaRetryPlugin;
