import type { Plugin } from "@opencode-ai/plugin";

import {
  installCodexQuotaRetryFetch,
  observeCodexQuotaRetrySessionStatus,
  type CodexQuotaRetryFetchOptions,
} from "../lib/codex-quota-retry.ts";

const CodexQuotaRetryPlugin: Plugin = async (
  _input,
  options: CodexQuotaRetryFetchOptions = {},
) => {
  installCodexQuotaRetryFetch(options);
  return {
    event: async ({ event }) => {
      if (event.type === "session.status") observeCodexQuotaRetrySessionStatus(event);
    },
  };
};

export default CodexQuotaRetryPlugin;
