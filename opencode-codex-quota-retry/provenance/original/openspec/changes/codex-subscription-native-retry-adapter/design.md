# Design

## Context

See `proposal.md` for motivation and scope. OpenCode 1.19.0 is the installed runtime and Bun 1.3.13 is the test runtime. Its native retry scheduler honors retry-after information, exposes native retry status, and stops after five attempts. The installed Codex transport performs OAuth handling and delegates generation to `https://chatgpt.com/backend-api/codex/responses`.

The latest no-provider installed run is not accepted: after POST `/abort` returned HTTP 200 with `succeeded: true`, native status became `idle`, but a second synthetic Codex request occurred at the retry deadline. Provider-free tests passed 7/7 and strict validation passed. This design revision addresses that failure without weakening the gate. The project plugin remains repository-owned and process-alive only; the project package dependency is `@opencode-ai/plugin@1.4.6`, while the separate goal plugin is pinned at `0.1.60`; the approved settings and Sol/Luna model assignments remain unchanged.

## Goals / Non-Goals

**Goals:**

**Contract Layer (MUST):**

- Normalize only positively classified Codex subscription quota responses into inputs understood by the native scheduler.
- Preserve OAuth loading, token refresh, headers, nono routing, wrapper chaining, helper properties, SSE streaming, model/agent selection, request identity, native cancellation, and credentials; the adapter MUST NOT read or expose credentials.
- Prove an exact stable identity in OpenCode 1.19.0 before enabling cancellation protection. If the installed transport/event surface cannot correlate a session retry/status/abort with the later Codex fetch, the result MUST be `BLOCKED` and the guard MUST remain unimplemented and unactivated.
- When identity is proven, use only bounded process-local per-generation cancellation markers. A marker MUST match the exact generation identity, expire at the native retry deadline plus small grace, be bounded by outstanding quota retries, and never participate in shared quota cooldown accounting.
- Suppress the exact cancelled pending retry before the provider delegate while preserving native `AbortSignal` and abort behavior. The guard MUST NOT be a sleep, queue, replacement retry engine, or extra retry attempt.
- Maintain one process-local monotonic Sol/Luna route cooldown without holding requests or adding request-queue coordination. An unrelated session MUST be able to resume after the normal shared cooldown expires.
- Keep the first release HTTP-only and process-alive only, with no global configuration mutation.

**Guidance Layer (SHOULD):**

- Use an allowlisted opaque identity, one-way digest, or safe metadata only in evidence; never emit raw prompts, request bodies, headers, credentials, or tokens.
- Use injected wall and monotonic clocks, deterministic cleanup, and provider-free fixtures for parser, identity, guard, cooldown, and native-policy tests.
- Keep the local project extension boundary and manual global-copy procedure so deployment remains observable and reversible.

**Non-Goals:**

- No provider option replacement that bypasses the built-in Codex OAuth transport.
- No adapter-owned long wait, replacement retry loop, extra retry attempt, model switch, provider fallback, WebSocket support, restart recovery, persisted scheduler, daemon, Mte90 plugin, or generic stall recovery.
- No timing-only, prompt-hash-only, payload-guessing, or other heuristic correlation; no session abort from the adapter, continuation prompt, resume prompt, goal-state JSON edit, silent goal-limit increase, dependency installation, or global configuration mutation.
- No changes to NeverEndingQuest gameplay or runtime files.

## Decisions

### 1. Use a once-installed process fetch wrapper at the project plugin boundary

The plugin entrypoint at `.opencode/plugins/codex-quota-retry.ts` installs one wrapper around the fetch function used by the installed OpenCode runtime. Shared classification, cooldown, identity, and guard logic belongs in `.opencode/lib/codex-quota-retry.ts`. Installation is idempotent and preserves an existing wrapper chain.

The wrapper matches the exact HTTPS host, exact `/backend-api/codex/responses` path, generation request shape, and HTTP transport. It does not intercept arbitrary OpenAI-compatible endpoints, successful non-generation requests, WebSocket traffic, or other providers. This is preferred over replacing `provider.openai.options.fetch`, which could bypass built-in OAuth handling. The wrapper forwards original request arguments, preserves `this` behavior and helper properties, and returns native `Response` objects. It clones only bounded matching error bodies and never clones successful SSE bodies.

### 2. Make correlation identity a hard prerequisite

Before guard implementation or activation, a provider-free source/runtime fixture MUST inspect the installed OpenCode 1.19.0 session retry/status/abort lifecycle and exact Codex fetch retry lifecycle. It must prove one stable identity that is present or deterministically derivable at each required boundary. Evidence may contain only allowlisted identifiers, one-way digests, or safe metadata.

If no unique identity is exposed, or if only timing, prompt hashes, request ordering, or another heuristic is available, verification emits `BLOCKED`. No cancellation marker or guessed suppression is implemented, task 4.2 remains incomplete, and activation is prohibited. This is preferred over a heuristic because a false match could suppress an unrelated session.

### 3. Separate classification, deadline normalization, and response adaptation

The helper uses three explicit stages: match the exact Codex HTTP generation request; classify the completed response as eligible quota or pass-through; then normalize a deadline and return a bounded native-compatible 429 only for eligible quota cases.

Valid `retry-after` delta-seconds or HTTP-date, `retry-after-ms`, and structured `resets_at` or `resets_in_seconds` values are checked after epoch validation. When valid authoritative resets conflict, the latest future deadline wins. Text is used only for one unambiguous deadline with an explicit timezone or offset. A 60-second grace and small bounded stagger are preserved. The five-hour fallback is allowed only after positive quota classification and only without a valid reset. Authentication, invalid-request, network, server, unknown-429, and cancellation errors pass through unchanged.

### 4. Delegate waiting to native retry status, not adapter timers

The adapter returns native retry inputs consumed by OpenCode 1.19.0. The native scheduler remains authoritative for retry status, next timestamp, timer handling, five attempts, exhaustion, and final error visibility. The adapter never waits for hours inside fetch and never creates a competing retry counter. Renewed valid quota responses extend the shared deadline and the native status.

### 5. Use separate shared cooldown and per-generation cancellation state

The helper stores one account-wide monotonic cooldown keyed to the Codex subscription route, not to Sol or Luna. Requests during it receive a local synthetic 429 immediately; no request is held, queued, or represented by an in-flight coordination marker. Native `AbortSignal` cancellation does not erase this cooldown.

Only after identity proof, cancellation observation creates a process-local marker keyed by the exact pending generation identity. The marker records safe identity metadata, cancellation state, and a monotonic expiry no later than the native retry deadline plus small grace. Cleanup runs on lookup and expiry, cardinality is capped at outstanding quota retries, and no state is persisted. A later retry with the exact cancelled identity is suppressed before the provider delegate without creating a quota retry. A different identity is not suppressed by that marker after the normal shared cooldown expires. An uncorrelated cancellation fails closed for guard decisions and never triggers heuristic suppression.

### 6. Preserve generation identity and goal lifecycle boundaries

The adapter does not create a new session, enqueue a new parent task, change `openai/gpt-6.1-sol` or `openai/gpt-6-luna`, or issue a continuation message. The goal plugin's `session.status` retry behavior remains authoritative, and the adapter never calls `session.abort`. The approved `max_task_block_seconds=3600` setting is unchanged. The four-and-a-half-hour fake-clock regression and exact cancellation tests must pass before activation; otherwise the change remains blocked.

### 7. Keep deployment local and dependency-free

Implementation-owned files remain:

- `.opencode/plugins/codex-quota-retry.ts` - auto-loaded project entrypoint.
- `.opencode/lib/codex-quota-retry.ts` - parser, classifier, identity, guard, cooldown, wrapper, and native-header helpers.
- `scripts/test_codex_quota_retry.ts` - provider-free unit, source/runtime fixture, fake-clock, and identity tests.
- `docs/operations/codex-quota-retry.md` - operator deployment, evidence, rollback, HTTP-only precondition, and global-copy instructions.

The project path is the default. An operator may manually copy both project files to `~/.config/opencode/plugins/codex-quota-retry.ts` and `~/.config/opencode/lib/codex-quota-retry.ts`, preserving relative imports, then restart OpenCode. The implementation does not write external paths, read credentials, install packages, or modify global defaults.

### 8. Treat the live smoke as an installation-chain gate

Provider-free source tests do not establish final acceptance. The primary orchestrator owns an isolated run under `tmp/codex-quota-retry/<run-id>/` using installed OpenCode 1.19.0, the pinned goal plugin, a local no-provider Codex HTTP response, and a short synthetic reset. External network remains denied.

The gate must declare scenarios before execution: identity proof, four-and-a-half-hour fake-clock scheduling, short deadline wait and resume, one Sol parent plus one Luna child, exact cancellation, no outbound request after abort, unrelated parallel session, native retry status and next timestamp, request counts, unchanged identities, goal/child state, and no duplicate side effects. Per-request identity evidence is required only after correlation is proven. If identity proof fails, the run reports `BLOCKED` rather than fabricating correlation or accepting task 4.2.

## Risks / Trade-offs

- [Risk] The installed runtime may expose no stable correlation identity. -> [Mitigation] Make identity proof the first pending task; report `BLOCKED`, do not implement a heuristic, and do not activate.
- [Risk] A wrong identity could suppress an unrelated session. -> [Mitigation] Require exact-generation matching, bounded markers, parallel-session tests, and no timing or prompt-hash fallback.
- [Risk] Wrapping the wrong fetch layer could bypass OAuth or nono routing. -> [Mitigation] Match the installed Codex runtime path exactly, preserve the wrapper chain, and require auth/pass-through and installed-runtime evidence.
- [Risk] Error-body parsing could leak provider content or consume streaming bodies. -> [Mitigation] Clone only bounded matching error bodies, never successful SSE, and emit no raw bodies, prompts, credentials, or headers.
- [Risk] A shared cooldown can delay an otherwise valid request. -> [Mitigation] Scope it to the exact route, use only a valid deadline, extend only from newer valid quota data, and resume after deadline plus bounded stagger.
- [Risk] Process restart loses pending native retry and marker state. -> [Mitigation] Keep process-alive-only behavior explicit and claim no restart recovery.

## Migration Plan

1. Prove the OpenCode 1.19.0 correlation identity with provider-free source/runtime fixtures and emit `PASS` or `BLOCKED` without exposing secrets.
2. If and only if identity is proven, implement and test the bounded per-generation guard alongside existing parser, transport, cooldown, cancellation, and native-budget coverage.
3. Extend the isolated no-provider smoke with per-request identity evidence and a concurrent unaffected-session scenario; preserve all artifacts under `tmp/codex-quota-retry/`.
4. Repeat the installed-runtime gate. A later request after successful cancellation, missing exact identity, unsafe execution, or failed assertion leaves task 4.2 incomplete and activation blocked.
5. Repeat the final scope audit and strict validation after the new evidence is reviewed. For global operation only, manually copy both files and restart OpenCode after acceptance.
6. Roll back by removing the project plugin and any manually copied global files, then restarting OpenCode. No state migration or cleanup is required because markers are process-local and non-persistent.

## Open Questions

None. Identity availability is a verification gate with an explicit `BLOCKED` outcome, not an unresolved design choice.
