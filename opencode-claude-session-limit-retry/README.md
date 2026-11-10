# Claude Session-Limit Native Retry Plugin

This plugin targets only OpenCode's native `claude-agent` provider. The verified
native retry event uses `error.type: provider.unknown` and a message in one of two
exact forms: `Claude Code subscription limit reached (five hour). Resets at
<future UTC ISO instant>.` or, when the native event omits its reset class,
`Claude Code subscription limit reached. Resets at <future UTC ISO instant>.`.
Classification does not depend on `error.type` and does not inspect a response or
proxy payload. Missing, malformed, stale, oversized, or unrepresentable resets are
left to native policy; no reset or fallback deadline is synthesized.

Sources: `src/lib/claude-session-limit-retry.ts` (classification, deadline, cap,
cooldown) and the V2 entrypoint `src/plugins/claude-session-limit-retry.ts`. The
plugin is a separate tool from the Codex quota-retry plugin: it imports nothing from Codex and uses
its own global symbol, `opencode.claude-session-limit-retry.cooldown`.

Behavior:

- Classification: `model.providerID` must be `claude-agent`, and the complete
  `error.message` must match one of the native signatures above. Scanned text is
  bounded to 64 KiB; arbitrary embedded JSON is not decoded.
- Deadline: the matched message's valid future UTC ISO instant plus one 60-second
  grace. No valid reset means no promotion; weekly/beyond-cap resets remain under
  native policy.
- Cap: the graced wait must fit `maxWaitMs` (default six hours), clamped to
  `2_147_483_647` ms. Only positive finite configured values override the default.
- Cooldown: a Claude-only process-global monotonic deadline is shared across
  sessions. The latest deadline wins, expired cooldowns are ignored, remaining
  monotonic time is rounded up, grace is applied once, and each delay adds a
  stagger of 0-250 ms.
- Read-only: only `decision.retry` and `decision.delay` are set. `error`, the
  response, headers, and body are never mutated. There is no fetch wrapper, no
  `http.request` or `http.response` hook, no response rewriting, no retry loop,
  and no `session.abort`; interruption stays native.
- Only the `retry` hook is registered. Cleanup disposes it idempotently.

Options:

| Option | Default | Purpose |
| --- | --- | --- |
| `maxWaitMs` | 6 h (`CLAUDE_SESSION_LIMIT_MAX_WAIT_MS`) | Cap on the graced wait; positive finite, clamped to 2_147_483_647 ms |
| `nowMs` | `Date.now` | Wall clock; test-only |
| `monotonicMs` | monotonic clock | Cooldown clock; test-only |
| `staggerMs` | random 0-250 ms | Per-call stagger; test-only |

Verification (provider-free; run from `opencode-claude-session-limit-retry/`):

```text
bun test ./scripts/claude_session_limit_retry.test.ts ./scripts/claude_agent_native_retry_gate.test.ts
bun ./scripts/claude_agent_native_retry_gate.ts
```

The native gate requires installed OpenCode 2.2.6. It injects synthetic
stream-json SDK events through `OPENCODE_CLAUDE_PATH`, uses no provider endpoint
or inherited provider credentials, and tests seven scenarios: bounded success,
pending-wait interruption, missing reset, overload, authentication, billing, and
weekly reset. It observes built-in `retry: false`, the product override, and the
final consumed decision. The wrong-provider clone is unit-negative coverage, not
an eighth runtime scenario. Bounds are 90 seconds for success, 30 seconds for
interruption, 15 seconds per negative case, and 300 seconds overall. Its localhost
and synthetic-CLI assertions are application-level checks, not OS-level egress
isolation.

The 2026-11-08 native gate passed all seven scenarios. The successful retry
resumed to scripted success after 62,965 ms; the interruption case held a
7,259,783 ms retry pending and ended after one model attempt. Content-free summary:
`openspec/changes/claude-session-limit-native-retry/reports/native-agent-gate-20261108.md`;
generated evidence:
`tmp/claude-session-limit-retry/task-6.3/gate-20261108T082945773Z-9f4dbeba/gate-summary.json`.

Historical only: the OpenCode 2.1.2 `claude-code` OpenAI-compatible gate and its
2026-10-22 reports document the deprecated transport, not current support or native
acceptance. Its legacy self-check intentionally fails against the native-only
classifier. Previously deployed global copies have not been updated; deployment
remains a separate, explicitly authorized rollout and is not implied by this
repository gate. The native gate uses isolated test configuration and requires no
restart of an existing process. Historical global paths were:

- `~/.config/opencode/plugins/claude-session-limit-retry.ts`
- `~/.config/opencode/lib/claude-session-limit-retry.ts`

The entrypoint imports `../lib/claude-session-limit-retry.ts`, so both files are
needed. Backups belong under `tmp/claude-session-limit-retry/deploy-<date>/`.
Rollback is deleting those two files and restarting OpenCode.
