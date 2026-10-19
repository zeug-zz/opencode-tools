# Proposal

## Why

Codex subscription quota responses must remain inside OpenCode 1.19.0's native retry scheduler, but the latest no-provider installed-runtime gate failed: after a successful native session abort and transition to `idle`, a second synthetic Codex request occurred at the retry deadline. The adapter therefore needs a bounded, exact-generation cancellation guard, but implementation and activation remain blocked until OpenCode 1.19.0 exposes a stable identity correlating the cancelled session retry with the later Codex HTTP fetch.

## What Changes

- Keep one repository-owned, HTTP-only OpenCode plugin capability for positively classified Codex `429` responses with `error.type=usage_limit_reached` and trustworthy reset handling.
- Preserve native retry scheduling, retry-after handling, native retry status, finite timers, the native five-attempt budget, built-in OAuth/auth refresh, headers, nono routing, wrapper chaining, helper properties, and calling semantics; never sleep for hours inside `fetch`.
- Require a provider-free OpenCode 1.19.0 transport/event proof of a stable correlation identity before implementing or activating cancellation protection. Allow only an allowlisted identifier, one-way digest, or safe metadata; never log or persist prompts, raw bodies, headers, credentials, or tokens.
- When identity is proven, add only a bounded process-local per-generation cancellation marker. It MUST suppress the exact cancelled pending retry before the provider delegate, preserve native `AbortSignal` and abort behavior, expire at the native retry deadline plus a small grace, and remain bounded by outstanding quota retries. It is not a per-session quota cooldown and not a second retry engine.
- Preserve one monotonic in-process subscription route cooldown shared by Sol and Luna, local synthetic `429` responses during a known cooldown, valid deadline extension, and a small post-deadline stagger without holding requests or queueing work. Cancellation markers MUST NOT block an unrelated session once the normal shared cooldown expires.
- If no stable identity is available, or if correlation requires only timing, prompt hashes, or another heuristic, emit an explicit `BLOCKED` verification result, leave the guard unimplemented and unactivated, and leave task 4.2 incomplete. Do not guess.
- Extend provider-free tests and the isolated smoke plan for identity proof, parallel unaffected sessions, no outbound request after exact cancellation, marker expiry, cancellation, and uncorrelated fail-closed behavior. The final smoke remains no-provider and external-network denied.
- Keep goal safety unchanged: do not call `session.abort` from the adapter, inject continuation or resume prompts, alter model or agent selection, raise goal limits, duplicate parent delegation, or change native five-retry exhaustion. Approved settings remain `auto_continue=true`, `defer_while_tasks_active=true`, `max_task_block_seconds=3600`, `max_prompt_failures=3`, and `max_goal_duration_seconds=360000`; no Mte90 plugin is used.
- Keep project plugin ownership and the manual global copy/restart procedure as the deployment boundary. Do not edit global configuration, add dependencies, change package files, or change NeverEndingQuest gameplay/runtime files.

## Capabilities

### New Capabilities

- `codex-subscription-native-retry-adapter`: HTTP Codex subscription-quota normalization, shared native cooldown behavior, and exact-generation cancellation safety within one cohesive adapter capability.

### Modified Capabilities

- None.

## Impact

- Planned implementation remains `.opencode/plugins/codex-quota-retry.ts`, `.opencode/lib/codex-quota-retry.ts`, and `scripts/test_codex_quota_retry.ts`, with existing operational guidance under `docs/operations/codex-quota-retry.md`; this planning revision does not edit those files.
- The adapter targets OpenCode 1.19.0 and Bun 1.3.13 over the exact `https://chatgpt.com/backend-api/codex/responses` HTTP route. The primary execution is `openai/gpt-6.1-sol`; the child `general/explore` execution is `openai/gpt-6-luna`. The built-in OAuth/auth-refresh fetch path remains authoritative.
- The project `.opencode/package.json` remains pinned at plugin dependency version 1.4.6. No dependency, package, lockfile, NeverEndingQuest gameplay/runtime, or global configuration changes are in scope.
- HTTP-only and process-alive-only behavior remain mandatory. WebSocket interception, restart recovery, persisted scheduler state, a daemon, alternate provider fallback, model switching, and generic stall recovery remain non-goals.
- Current evidence is historical and unchanged: provider-free tests passed 7/7 and strict validation passed, but the installed cancellation gate failed with 10 requests and 2 quota responses; the report remains under `reports/native-verification.md` and is not edited by this planning revision. Acceptance requires a later isolated no-provider run with per-request identity evidence, cancellation safety, native retry status/timestamp, request counts, goal/child safety, child ceiling behavior, and no duplicate side effects. Exit code or mock-only output is insufficient.
