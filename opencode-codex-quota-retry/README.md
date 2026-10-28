# Codex Subscription Native Retry Adapter

## Scope and status

This document describes the repository-owned OpenCode plugin and its operator
deployment boundary. The adapter is HTTP-only and process-alive only. It does
not provide restart recovery, a daemon, a provider fallback, model switching,
or a manual pause/resume mechanism.

On OpenCode V2 the adapter registers exactly two native hooks: `http.request` for
correlation identity and `retry` for the native override. No `http.response`
observer is registered. V2 retry evidence can come from the existing
fetch-wrapper proof path, and, when that path yields no override, from the exact
`error.response` payload carried by the native `retry` event for a positively
classified `openai` quota `429`. The payload is read only; it is never mutated,
and no response or header is rewritten.

The canonical development package is `packages/opencode-codex-quota-retry/` in
the Sandbox repository. Its source files are:

- `src/plugins/codex-quota-retry.ts` - plugin entrypoint.
- `src/lib/codex-quota-retry.ts` - shared helper, parser, cooldown, and
  native-header adapter.
- `scripts/test_codex_quota_retry.ts` - provider-free contract tests.
- `scripts/v2_retry_canary.ts` - exploratory installed-OpenCode-V2 provider-free canary.

The original NeverEndingQuest source and completed OpenSpec history are
preserved as migration provenance under `provenance/` and
`openspec/changes/archive/2026-10-20-codex-subscription-native-retry-adapter/`.
Historical report claims remain unchanged; they are not evidence of the fresh
Sandbox-native acceptance gate.

### Provenance hashes and intentional portable copies

`provenance/migration-manifest.json` separates three byte identities for each
asset. The original `sha256` and `bytes` identify the immutable NeverEndingQuest
source; `original_snapshot` is the byte-exact archived copy of that source.
`destination_sha256_at_import` records the Sandbox destination as first staged,
before the harness path changes. `sandbox_current_sha256` and
`sandbox_current_bytes` identify the exact current portable package artifact.
The retirement preview/apply checks only the original NEQ source against the
original `sha256` and `original_snapshot`; it intentionally does not require
the current Sandbox harness or README to match the frozen NEQ bytes.

The original source snapshots remain byte-exact under `provenance/original/`.
The current V1 entrypoint is a small shim, the V2 entrypoint installs early
during module evaluation, and the shared helper contains the V2 implementation.
The V2 compatibility addendum updates the copied OpenSpec proposal, design,
tasks, and spec; the other three copied OpenSpec files remain byte-exact. The
harness is adapted for package-root and Sandbox-local scratch resolution, and
this README is the package-cwd/path-adapted copy of the operations guide. These
intentional differences do not alter the preserved source snapshots or NEQ
retirement proof. The migration manifest records current hashes and byte counts
for all eleven destinations; it does not rewrite historical source hashes or
snapshots.

Migration ownership, exact source paths and hashes, evidence-tree mapping,
license attribution, and the completed source-retirement record are documented
in `../../migration/codex-quota-retry-development.md`; the notice-only memory
handoff is `../../migration/codex-quota-retry-memory-handoff.md`. Canonical
development sources are `src/plugins/codex-quota-retry.ts` and
`src/lib/codex-quota-retry.ts`, with the portable harness in
`scripts/test_codex_quota_retry.ts`. The exact task 2.2 source retirement is
complete; do not rerun its preview/apply procedure. Its fixture tests use the
preserved pre-deployment global snapshots, not the current user-global V2 files.

Verify the retirement guard's fixture suite with
`bun test ./scripts/neq_codex_quota_retry_retirement.test.ts`.
The combined V2/retirement regression gate from this package directory is:

```text
bun test ./scripts/v2_retry_canary.test.ts ./scripts/v2_native_retry_adapter.test.ts ./scripts/v2_early_entrypoint.test.ts ./scripts/neq_codex_quota_retry_retirement.test.ts
bun scripts/test_codex_quota_retry.ts --all
```

The combined V2/retirement regression gate currently reports 56/56 passing tests
across the four files. The earlier `55 pass / 1 fail` state was the retirement
fixture's destination-hash expectation, which now passes after the migration
manifest was refreshed; it was not a runtime-path failure. `--all` currently
passes 9/9 provider-free modes. Historical counts of 51/51 and 14/14 in the
archived precision report remain historical evidence for the earlier task state
and are not rewritten.

The primary Sandbox-native acceptance gate recorded `PASS` at
`tmp/codex-quota-retry/sandbox-native-20261015-1/verdict.json`; task 2.1 is
complete from this Sandbox-root run. It used Bun `1.3.13`, OpenCode `1.19.0`,
and goal plugin `0.1.60`; the legacy `finalGate: orchestrator-task-4.2` label is
preserved. The verdict reports `installedLiveProof=true`, 144079 ms elapsed,
11 exact Codex requests, 2 quota responses, 1 cancellation, a native A abort
with no late request, a distinct B session returning plaintext HTTP 200 in the
same server process, one persisted mutation/goal, both owned processes exited,
no external network, and empty failed-assertion and missing-required-evidence
lists. The accepted command protocol is rooted at Sandbox, not package cwd.

A separate, non-required exploratory package-cwd native smoke at
`tmp/codex-quota-retry/sandbox-native-20261015-2/verdict.json` recorded `FAIL`;
it exceeded the 12-request budget (22 exact Codex requests), started two
parent-child goals, and failed cancellation/identity/parallel-session and
side-effect assertions. It is not the approved task 2.1 gate and is not a
passing result; do not rerun or conceal it. The owner's reported four-hour
global trial and exact 60-second reset resumption are separate user-reported
evidence, not either Sandbox smoke verdict.

That separate user-reported trial was performed in a pinned OpenCode process
which has exited. It
does not mean this current interactive process has been restarted or that the
plugin has been globally installed. After the final summary, an operator must
restart the intended OpenCode process to activate the current project plugin;
the process-alive-only boundary means pending retries are not recovered across
that restart. No mock-only test or exit code alone proves installed-chain
acceptance.

## Prerequisites

The supported tool versions are:

- Bun `1.3.13` for the provider-free test command.
- OpenCode `1.19.0` for the native retry scheduler and plugin runtime.
- The project OpenCode plugin package remains pinned at
  `@opencode-ai/plugin` `1.4.6`.
- The operational goal plugin is pinned at `0.1.60`.

Run these checks from the Sandbox root or this package directory:

```text
bun --version
opencode --version
```

The expected outputs are exactly `1.3.13` and `1.19.0`. If either version is
different, stop and do not infer compatibility or silently change a limit.
Do not install dependencies as part of this procedure.

The supported goal routing is:

- Sol primary: `openai/gpt-6.1-sol`.
- Luna child: agent `general/explore`, model `openai/gpt-6-luna`.

The adapter is model-agnostic at the transport boundary. These labels describe
the approved parent and child routing; the adapter does not select or replace a
model or agent. Sol and Luna share one process-local route cooldown, including
when their generations are concurrent.

No Mte90 plugin is used. This adapter is not a global installation setting and
is not a stealth WebSocket-disable flag.

## Runtime fixture layout

This package is the development source and is not itself an OpenCode project
plugin installation. The test harness copies its source into isolated native
fixtures at `.opencode/plugins/` and `.opencode/lib/`, preserving the installed
runtime's expected layout and the entrypoint's relative
`../lib/codex-quota-retry.ts` import. The production source remains under `src/`;
fixture layout does not relocate or rewrite the package source.

The plugin installs one idempotent process-local wrapper around the existing
`fetch` chain. A second project/global copy in the same process is safe: the
`Symbol.for` registry returns the existing singleton instead of installing a
second wrapper. This also makes concurrent Sol and Luna models share the same
wrapper and cooldown. It does not authorize two independent OpenCode
processes or an overwrite of an existing operator destination.

The wrapper preserves the built-in Codex OAuth loader, token refresh, request
headers, nono routing, helper properties, wrapper chaining, `this` behavior,
request identity, and native `Response` behavior. It does not replace
`provider.openai.options.fetch` and does not read or expose credentials.

## Exact transport boundary

Only this exact request is eligible:

```text
POST https://chatgpt.com/backend-api/codex/responses
```

The origin, HTTPS scheme, path, and POST method must match. Other hosts,
ports, credentials in the URL, paths, methods, providers, and non-generation
requests pass through unchanged. WebSocket and non-provable transports are
unsupported and are never claimed as supported.

Only HTTP `429` responses whose parsed body contains
`error.type=usage_limit_reached` are adapted. Authentication, invalid request,
network, server, unknown-429, cancellation, non-Codex, and successful SSE
responses pass through their existing OpenCode path. Successful SSE bodies are
not cloned or buffered.

## Actual helper options and defaults

The plugin module exports exactly one runtime value: its `default` OpenCode
`Plugin` initializer. OpenCode v1.19.0 calls the initializer as
`server(input, load.options)`, so the optional second argument is the raw
`CodexQuotaRetryFetchOptions` tuple, not an object containing `options`. The
initializer forwards that raw argument to `installCodexQuotaRetryFetch(options)`.
There is no named runtime factory export, so OpenCode legacy auto-discovery
cannot mistake a helper function for an additional plugin initializer. With no
loader options, the entrypoint uses `{}`. The helper's actual
`CodexQuotaRetryFetchOptions` are:

| Option | Default and behavior |
| --- | --- |
| `nowMs` | `Date.now`; accepts a number or clock function. |
| `monotonicMs` | `performance.now` when available, otherwise `Date.now`; accepts a number or clock function. |
| `random` | `Math.random`; used only to choose the default stagger. |
| `staggerMs` | Optional value clamped to `0..250` ms. When omitted, a random bounded value is used. |
| `fallbackMs` | Optional positive fallback duration in milliseconds. It takes precedence over `fallbackHours`. |
| `fallbackHours` | Optional positive fallback duration in hours. If both fallback options are absent, the default is 5 hours. |
| `maxErrorBodyBytes` | `64 * 1024` bytes (64 KiB). |
| `errorBodyTimeoutMs` | `250` ms for reading the bounded matching error-body clone. |
| `maxNativeDelayMs` | OpenCode timer cap `2,147,483,647` ms unless a lower positive value is supplied. |

The deadline parser also accepts `fallbackMs` and `fallbackHours` through its
deadline options. A supplied `fallbackMs` wins over `fallbackHours`. The
five-hour fallback is used only after positive quota classification and only
when no valid reset remains. It is not a global configuration default and it
is not applied to malformed or unrelated responses.

For an explicitly configured runtime loader, the API shape is:

```ts
import plugin from "./.opencode/plugins/codex-quota-retry.ts";

await plugin(input, { fallbackHours: 5, staggerMs: 0 });
```

The plugin and helper never inspect credentials, environment variables, raw
request bodies, prompts, or authorization headers.

The 60-second grace period is mandatory and is not an option:

```text
CODEX_QUOTA_GRACE_MS = 60000
```

The bounded post-deadline stagger is at most 250 ms. The 64 KiB body limit and
250 ms read deadline are also fixed helper defaults. No diagnostic includes
credentials, request bodies, prompts, raw provider bodies, or request headers.

## Native retry behavior

The helper translates a normalized absolute deadline into the native
`retry-after-ms` and `retry-after` headers consumed by OpenCode 1.19.0. It does
not sleep inside `fetch`, hold a request, create a request queue, add a retry
counter, or replace the native retry loop. OpenCode remains authoritative for
native retry status, the next retry timestamp, timer handling, finite
five-attempt exhaustion, and final error visibility.

The V2 adapter has two evidence sources for the same bounded one-use override.
The existing fetch-wrapper path correlates through a private adapter-owned header
and lease and mints a one-use proof keyed by the authoritative
`event.sessionID`. When that proof-first path produces no override, the native
`retry` event is the second source: for provider `openai` it fires with
`error.type=provider.quota` and carries the exact upstream HTTP `429` payload in
`error.response.body`. The adapter reads that payload only, requires
`openai`/`429`/`error.type=usage_limit_reached`, bounds string bodies by
`maxErrorBodyBytes` before parsing, classifies with the existing positive
classifier, normalizes the deadline with the same 60-second grace and bounded
stagger, arms the shared cooldown, records the retry for `event.sessionID`, and
sets `decision.retry`/`decision.delay` to the finite shared monotonic remainder.
Both sources derive the same deadline and remain idempotent when they observe the
same response. The payload path never mutates the `error` object, its
`error.response`, the body, or headers, and adds no `retry-after`,
`x-should-retry`, or other header; the native `retry` hook remains the only
scheduler override.

The adapter does not silently raise the native timer, retry, goal, or task
limits. If an installed guard cannot safely retain the approved limits, block
activation and investigate; do not patch a third-party package or bypass the
guard.

## Shared cooldown and cancellation

The helper keeps one account-wide, process-local monotonic cooldown for the
exact Codex generation route. A matching quota response updates the latest
valid deadline. A later valid deadline extends it; an earlier stale response
cannot shorten it. During the known cooldown, a matching generation request
gets an immediate local synthetic `429` with the native retry headers and no
outbound provider request.

Requests are never held, queued, or represented by an in-flight coordination
promise. After the deadline plus the bounded stagger, native retry forwarding
may resume. Cancellation remains native `AbortSignal` cancellation: the
adapter does not call `session.abort`, does not clear the shared cooldown, does
not convert cancellation to quota retry, and does not hold the cancelled
request.

## Goal safety and bounded child ceiling

The approved goal settings are unchanged:

```text
auto_continue=true
defer_while_tasks_active=true
max_task_block_seconds=3600
max_prompt_failures=3
max_goal_duration_seconds=360000
```

The adapter does not edit goal state, reactivate a paused goal, inject a
continuation or resume prompt, duplicate parent delegation, duplicate a child,
or duplicate side effects. A native quota retry is not a manual pause/resume
operation, and it does not automatically reactivate a paused goal.

The bounded child-ceiling rule is explicit:

1. `max_task_block_seconds=3600` remains the approved task-block ceiling and
   is not changed by this adapter.
2. The native child-wait evidence observes the child in bounded intervals of
   no more than one hour while preserving native retry status, the same Sol
   parent, the same Luna child, and one side-effect identity.
3. A four-and-a-half-hour fake-clock wait is a regression scenario, not an
   unbounded child permission. If the installed goal guard fails it while the
   approved settings remain unchanged, activation is blocked.
4. Any later operator adjustment must be explicit, bounded, and documented at
   a value no lower than the configured cooldown plus expected task runtime.
   This change does not make that adjustment or silently raise any limit.

Long native waits count against the remaining goal budget. They do not pause
the budget, reset it, or create a new goal. Installing or replacing the
plugin while a live goal is running risks cancelling its request; coordinate a
restart only when the operator accepts that risk. The plugin never auto-restarts
OpenCode.

## Global installation boundary

The V2 global deployment copies the canonical V2 entrypoint source
`src/plugins/codex-quota-retry-v2.ts` to the existing
`~/.config/opencode/plugins/codex-quota-retry.ts` destination, preserving its
basename so auto-discovery does not load a duplicate plugin descriptor. The
canonical helper `src/lib/codex-quota-retry.ts` is copied to
`~/.config/opencode/lib/codex-quota-retry.ts`; the entrypoint's relative helper
import remains valid. Do not install the V2 entrypoint under an additional
`codex-quota-retry-v2.ts` plugin filename and do not deploy the legacy shim
alongside it.

The deployed V2 entrypoint registers exactly two native hooks: `http.request` for
correlation identity and `retry` for the native override. No `http.response`
observer is registered. Deployment means replacing the two canonical copies
(`~/.config/opencode/plugins/codex-quota-retry.ts` and
`~/.config/opencode/lib/codex-quota-retry.ts`) and restarting the intended
OpenCode service. Writing the installed files may trigger the plugin watcher and
a reload, but a stale process that has not reloaded still requires an explicit
operator restart; activation is only observable in a process started after
deployment.

The deployment changes only these two global plugin/helper files. It does not
edit plugin configuration, select or force HTTP transport, or modify operator
transport settings. The adapter is HTTP-only: only the exact Codex HTTP
generation route above is eligible; WebSocket and other transports pass through
unchanged. The fresh private native V2 loader inventory is verified PASS at
`tmp/codex-quota-retry/v2-deploy-20261019T064626Z-49110/evidence/loader-inventory-20261019T065930Z-64552.json`;
see the deployment report for the preserved initial empty-inventory failure
and exact source/hash evidence. This verifies fresh loader discovery only; it
does not mean the existing shared process or its current generation loaded the
new copies. Existing live processes still require an operator-controlled
reload/restart, and pending native retries/sessions are not recovered across
restart.

Task 5.4 deployment backups are local to the repository under
`tmp/codex-quota-retry/v2-deploy-<run-id>/backups/`. Preserve the backups and
deployment report at
`openspec/changes/archive/2026-10-20-codex-subscription-native-retry-adapter/reports/v2-deployment.md`;
they do not alter source provenance or immutable snapshots. The fresh private
V2 loader verification is complete; activation in an existing live process
remains an explicit operator reload/restart action.

## Rollback

Rollback is operator-controlled and process-local:

- Stop before changing a live goal or accept the documented cancellation risk.
- For a project deployment, disable or remove only the project plugin
  entrypoint using a verified, non-destructive backup procedure, leaving the
  helper source available if it is still needed by the repository.
- For the V2 global deployment, restore only
  `~/.config/opencode/plugins/codex-quota-retry.ts` and
  `~/.config/opencode/lib/codex-quota-retry.ts` from the matching local backups
  under `tmp/codex-quota-retry/v2-deploy-<run-id>/backups/`. Verify each
  destination against its backup before restarting. Do not remove repository
  sources or change any other global file.
- Restart OpenCode after rollback.

No scheduler state is persisted by this adapter. Rollback does not require
state migration or cleanup, and it does not recreate a pending native session.

## Provider-free checks and installed-runtime result

Run the nine provider-free modes from either the Sandbox root or package cwd.
They exercise transport, parser, pass-through, native-policy, cooldown, and
fake-clock contracts. New run artifacts belong under Sandbox
`tmp/codex-quota-retry/` regardless of the caller's cwd. The native
`--identity-contract` and `--smoke` acceptance commands are different: run them
only from the Sandbox root, as required by the migration tasks. Do not run
native acceptance commands from package cwd.

```text
# From Sandbox root
bun packages/opencode-codex-quota-retry/scripts/test_codex_quota_retry.ts --all
bun packages/opencode-codex-quota-retry/scripts/test_codex_quota_retry.ts --identity-unit
bun packages/opencode-codex-quota-retry/scripts/test_codex_quota_retry.ts --cancellation-guard
bun packages/opencode-codex-quota-retry/scripts/test_codex_quota_retry.ts --smoke-contract --run-id contract-check-root

# From package directory
bun scripts/test_codex_quota_retry.ts --all
bun scripts/test_codex_quota_retry.ts --identity-unit
bun scripts/test_codex_quota_retry.ts --cancellation-guard
bun scripts/test_codex_quota_retry.ts --smoke-contract --run-id contract-check-package
```

`--all` currently passes 9/9 provider-free modes from both supported working
directories: transport-contract, parser,
pass-through, native-policy, cooldown, fake-clock, identity-unit,
cancellation-guard, and smoke-contract fixture/source-contract checks. It does
not run `--identity-contract` or `--smoke`, and does not independently claim
installed-live proof. The exact generation identity uses the verified
`session-id` and `x-session-id` HTTP headers; only allowlisted header names and
one-way identity digests belong in persisted evidence. Cancellation markers
are process-local, capped at 64 pending quota retries, and expire at the native
retry deadline plus a 1-second marker grace. The separate 60-second quota
deadline grace remains unchanged.

The smoke-contract evidence defaults to a new run directory under Sandbox
`tmp/codex-quota-retry/`; an existing run is preserved and receives a numeric
suffix. Historical NeverEndingQuest evidence was physically moved intact to
`tmp/codex-quota-retry/imported-neq-20261015/`; its internal historical path
references are deliberately not rewritten.

The fake-clock output explicitly identifies its source-contract fixture as not
installed-live proof. `--smoke-contract` is provider-free and may run from
either supported working directory. Tasks 3.2 and 3.3 provide tooling; run
native acceptance only from the Sandbox root:

```text
# From Sandbox root only
bun packages/opencode-codex-quota-retry/scripts/test_codex_quota_retry.ts --identity-contract
bun packages/opencode-codex-quota-retry/scripts/test_codex_quota_retry.ts --smoke --run-id operator-run-001

# Provider-free tooling contract; either Sandbox root or package cwd
bun scripts/test_codex_quota_retry.ts --smoke-contract --run-id contract-check
```

`--smoke-contract` verifies only the tooling configuration, isolation, source
contracts, expected evidence names, and no-external-call fixture. It must not
report installed-live success. `--smoke` launches the installed OpenCode
1.19.0 runtime with the cached pinned goal plugin 0.1.60, an isolated synthetic
auth fixture, and a same-runtime fake transport that denies unexpected network
calls. The cancellation server creates session A, observes its quota retry,
successfully aborts it, and records native idle before the retry deadline. While
that server is still running, it creates a distinct session B; the harness (not
the adapter) waits past the shared route cooldown before submitting B's
non-mutating plaintext generation. B must complete successfully in the same
server process while A produces no later outbound Codex request. This parallel
scenario does not create another goal, task, or persisted side effect.

Per-request identity evidence is written to
`evidence/parent/identity-fetch-telemetry.jsonl` and
`evidence/cancellation/identity-fetch-telemetry.jsonl`. It contains only
allowlisted identity field names, SHA-256 digests of values observed in the
actual outgoing Codex HTTP headers, safe request metadata, and response status;
raw header values, prompts, request bodies, authorization data, and tokens are
not persisted in those telemetry records. A private fixture control file under
the run directory lets the fake transport select B's plaintext response using
the native session ID returned when B is created; the fixture removes the
control file as soon as it classifies B's request. That control value is not
identity proof or persisted identity evidence; proof requires a matching
identity digest from B's actual outgoing native headers and the native session
event. Missing or ambiguous identity, an identical A/B identity, missing B
response, a different server process, premature B submission, or a later A
outbound request fails or blocks the gate.

The tooling records native retry status and next timestamp, request counts, Sol
parent and Luna child identities, cancellation, goal/child state, and the
single side-effect identity under `tmp/codex-quota-retry/<run-id>/`. The primary
root-run Sandbox verdict above is the accepted task 2.1 PASS using the legacy
native-harness protocol label. The separate package-cwd exploratory FAIL remains
visible and is not an acceptance run. The older NeverEndingQuest failure and
pass are historical evidence; neither supersedes these Sandbox results. The
driver status is evidence only. Never claim the smoke passed from a mock-only
run or an exit code alone.

## Safety boundaries

This deployment is intentionally narrow:

- No credential reads or credential logging.
- No dependency installation or package changes.
- No global configuration mutation.
- No goal-state edits, automatic goal reactivation, or silent limit changes.
- No third-party package patching.
- No provider request is needed for the provider-free checks.
- No absolute `/tmp/` path; generated evidence belongs under Sandbox
  `tmp/codex-quota-retry/<run-id>/` only.
- No WebSocket support claim and no stealth WebSocket disable mechanism.

## Exploratory V2 installed-runtime canary

The separate exploratory canary targets the installed OpenCode V2 runtime; it
does not change the adapter or establish an acceptance verdict. From the
Sandbox repository root, run:

```text
bun test packages/opencode-codex-quota-retry/scripts/v2_retry_canary.test.ts
bun packages/opencode-codex-quota-retry/scripts/v2_retry_canary.ts
```

The source-contract test is provider-free and starts no server. The canary
captures the installed binary's `--version`, verifies the installed
`@opencode/client` generated route and request-shape sources, and starts an
isolated `opencode serve` process. It sets isolated HOME/XDG/config/goal-state
paths and disables project config discovery and model fetching before plugin
load. The synthetic OAuth fixture is written before database creation. The
fixture plugin is auto-discovered only from the isolated global `plugins/`
directory and synthesizes Codex quota and success responses. Its monkeypatches
are application-level network guards, not OS-level egress isolation.

The canary registers V2 hooks through `ctx.session.hook`, observes event
identities from `event.data.sessionID`, and disposes hooks plus its abortable
event subscription during cleanup. It uses `/api/session` and the generated
`/api/session/{sessionID}/prompt` route. Root and child session identities are
observed independently; event session digests are recorded alongside outgoing
allowlisted session-header digests for review, without assuming parent/child
correlation. The canary waits on the generated V2 session-wait endpoint before
starting the child and shutting down the server.
Request-object identity is recorded where hook and fetch surfaces share an
object. Prompts, request bodies, credentials, tokens, and non-allowlisted header
values are not persisted. Bounded server stdout/stderr logs are redacted before
being written.

Each run writes inspectable artifacts under
`tmp/codex-quota-retry/v2-<run-id>/`, including labelled JSONL evidence,
redacted server logs, synthetic auth/config, fixture plugin, source snapshots,
and SHA-256 metadata. Runtime/config/hook contract mismatches are recorded as
`scenario.blocked`; they are exploratory diagnostics, not a PASS/FAIL decision
about retry acceptance. The process is bounded to 90 seconds and at most 12
synthetic Codex requests. Preserve failed run directories; do not overwrite or
delete them. A preliminary attempt from the earlier builder was BLOCKED before
API scenarios because its `/openapi.json` request lacked server authentication;
that evidence directory was inadvertently removed and is unavailable. It was
not a PASS. Do not use the synthetic fixture outside this isolated canary.

### V2 compatibility correction (2026-10-19)

The archived OpenSpec change records a V2-only implementation and acceptance addendum; completed V1 gate evidence remains immutable historical evidence, and V1 runtime is retired. The two installed V2 canaries confirmed native retry/interruption event shapes and that `http.request` exposes the authoritative session ID, while child and root outgoing `x-session-id` values both carried the root ID. Fetch reconstructs URL, headers, and signal, so WeakMap identity is not a valid correlation mechanism. The repair uses a unique random private token in a bounded expiring process-local map, temporarily carried in an adapter-owned header and stripped before the provider delegate; no extra wire header, native-header overwrite, raw token persistence, or payload/timing heuristic is allowed. Native scheduling and the shared cooldown remain separate and authoritative. See `openspec/changes/archive/2026-10-20-codex-subscription-native-retry-adapter/` for the completed implementation, gates, audit, and deployment record; do not treat either exploratory canary as acceptance PASS.

### V2 native retry-hook precision verification (2026-10-20)

The primary completed the native precision gate using bounded fixture-composed OpenCode `2.0.32` runs; details and redacted run references are in `openspec/changes/archive/2026-10-20-codex-subscription-native-retry-adapter/reports/v2-precision-verification.md`. The evidence covers the structured quota classifier with real/variant/missing messages, exact matching `provider.quota` and `provider.rate-limit` hook evidence, a short real-body same-operation resume, 91-minute and five-hour-plus-grace native scheduled delays followed by interruption, and proof survival when the completed transport attempt's signal is disposed before the hook. In-flight fetch/clone abort still invalidates its proof lease; native session interruption still cancels the completed proof. No exact-message eligibility restriction, response rewrite, polling, or adapter-owned retry was introduced.

Long resets are intentionally handled by the native retry scheduler: the adapter does not hold or rewrite the response body, wait in `fetch`, or poll every 15 minutes. A deployment or activation in another process remains a separate operator authorization; manual copies require the documented controlled reload/restart, which can cancel live work. This evidence does not claim a five-hour wall-clock wait, provider exhaustion, OS-level network isolation, or fresh global-loader proof.

After operator restart, the primary confirmed byte identity between the installed
helper and canonical helper (SHA-256
`27fd25d3a5504f3943acf3538a42f41279413e3c887300e0b992e03988939be6`) and an
active `codex-quota-retry` plugin in OpenCode `2.0.32` PID `13164` via
`GET /api/plugin`, loaded from `~/.config/opencode/plugins/codex-quota-retry.ts`.
This is disk identity and active-plugin inventory, not a live-provider quota
test; native behavior evidence remains scoped to the three bounded fixtures.
No restart or deployment is performed by this documentation update.

### V2 native retry-payload proof (2026-10-20)

On 2026-10-20 the globally installed V2 plugin was active and OpenCode `2.0.32`
was serving requests, yet Codex generations failed immediately with
`AI.Error.QuotaExceeded` and no native retry was scheduled. The recorded
provider payload was the full upstream HTTP `429` with
`error.type=usage_limit_reached` and a primary reset roughly 11553 seconds out.
Plugin load was observed roughly 460 ms after service start, so the provider
transport had already captured `fetch` before the plugin module installed its
wrapper; the fetch-wrapper-only path had no lease to finalize and no proof to
mint.

The actual mechanism is the native `retry` event. It fires with
`error.type=provider.quota` and carries the exact upstream `429` payload in
`error.response.body`. When the proof-first path produces no override, the
adapter classifies that payload directly: it requires provider `openai`, HTTP
`429` (from `status_code`, then `error.status`, then the native `429` default),
and `error.type=usage_limit_reached`; it bounds string bodies by
`maxErrorBodyBytes` before parsing; then it normalizes the authoritative reset
with `parseCodexQuotaDeadline`, applies the existing 60-second grace and bounded
stagger, arms the shared cooldown, records the retry for `event.sessionID`, and
sets `decision.retry`/`decision.delay` to the finite shared monotonic remainder.
The payload is read only and never mutated. No `http.response` hook is
registered, and the registered hooks are exactly `http.request` and `retry`.

Four retained attempts from that day are FAIL evidence, not acceptance, and no
raw session identifiers are recorded here:

- **Gate A — standard deploy + watcher hot reload: FAIL.** The quota request
  failed immediately with `provider.quota`. Confounded: the service most likely
  re-imported the cached old `lib` module, so Gate A proves nothing about the new
  code.
- **Gate B — forced fresh `lib` import + provider-scoped `http.response` hook:
  FAIL.** The quota request failed immediately and the hook never fired for the
  `429`.
- **Gate C — forced fresh `lib` import + unscoped `http.response` hook: FAIL.**
  The hook fired for a `200` response but never for the `429`. The native `retry`
  hook did fire with `error.type=provider.quota`, `attempt: 2`, and
  `decision: {retry:false}`.
- **Probe D — mechanism evidence, not acceptance.** A temporary entrypoint probe
  set `decision.retry=true` and `decision.delay=(resets_in_seconds+60)*1000`.
  The session held a scheduled retry (`10,187,000` ms) instead of failing and
  was then interrupted. This shows the decision override is the effective lever,
  but it is a probe, not a live gate pass.

Gates B and C disprove the `http.response` approach for the Codex quota `429`;
that hook does not fire for it. The historical precision report
(`openspec/changes/archive/2026-10-20-codex-subscription-native-retry-adapter/reports/v2-precision-verification.md`)
remains unchanged historical evidence for the earlier fetch-wrapper path; it is
not rewritten or reinterpreted by this section. Current provider-free counts are
reported in the verification section above.

**Final live gate (2026-10-20, `03:24:10Z`): PASS.** Runtime code only; the
temporary Probe D diagnostic had been removed. The native `retry` event carried
`error.type=provider.quota` with `attempt: 2`, and the adapter set
`decision.retry=true` with delay `9,669,095` ms (the payload reset plus the
60-second grace and bounded stagger). The session stayed scheduled
(`null`, not failed) and became `interrupted` after an explicit interrupt.
Exactly one bounded Codex request was made, and no raw provider body,
credentials, or session identifiers are recorded. Evidence is under
`tmp/codex-quota-retry/live-20261020/`; see
`openspec/changes/codex-native-retry-payload-proof/reports/live-gate-20261020.md`.
The standard global files were restored after the gate, but the running process
still holds the pre-fix cached module and requires an operator restart to load
them. Gates A/B/C and Probe D above remain retained FAIL/mechanism evidence and
are not rewritten by this PASS.

## Claude session-limit native retry plugin

`@openchamber/opencode-claude` (provider `claude-code`) returns HTTP 429 with
`rate_limit_error` / `claude_session_limit` and a published reset (`resets_at`,
`retry_after`) when the Claude subscription session limit is reached. OpenCode
2.1.2 caps provider retry-after at 15 minutes and 10 attempts (about 2.5 hours),
so this plugin uses the native `retry` hook to hold the retry until the published
reset.

Sources: `src/lib/claude-session-limit-retry.ts` (classification, deadline, cap,
cooldown) and the V2 entrypoint `src/plugins/claude-session-limit-retry.ts`. The
plugin is independent of the Codex sources: it imports nothing from Codex and uses
its own global symbol, `opencode.claude-session-limit-retry.cooldown`.

Behavior:

- Classification (all required, shared): model `providerID` is `claude-code`; the
  body (from `error.response.body`, a JSON string of at most 64 KiB, or an object)
  has `error.code` `claude_session_limit`. Then one class applies:
  - Class A (429 gate): `error.type` is `provider.rate-limit` or `provider.quota`;
    status is 429 from `error.response.status_code`, falling back to
    `error.status`; body `error.type` is `rate_limit_error`.
  - Class B (mid-stream): `error.type` is `provider.internal`; status is not 429
    (HTTP 200 SSE error chunk); body `error.type` is `error`. Intercepted only when
    a reset time can be parsed from the message text. Otherwise native backoff
    applies.
- Deadline: the latest valid future candidate among body `resets_at`, header
  `x-claude-rate-limit-reset`, body `retry_after`, header `retry-after` (headers
  are matched case-insensitively), and reset times in the message text (body
  `error.message` and the event-level message), plus one 60 s grace. Text forms:
  an ISO instant; `resets H[:MM]am|pm (IANA zone)`, taken as the next occurrence
  and DST-aware; and a dated form, `resets Mon D[, YYYY] H[:MM]am|pm (zone)`. Text
  beats a bare `retry_after`: a 429 with `retry_after: 600` whose text names a
  reset about 2 h away waits for that reset. Malformed, stale, invalid-zone,
  non-finite, or unrepresentable candidates are ignored. With no valid candidate
  the plugin does not intercept; there is no synthetic fallback.
- Cap: a graced wait longer than `maxWaitMs` (default 6 h) is not intercepted.
  A weekly reset is left to native policy, so the error surfaces after native
  retries are exhausted.
- Cooldown: a process-global monotonic deadline is shared across sessions. The
  later deadline wins, the grace is applied once, and each delay adds a stagger
  of 0-250 ms.
- Read-only: only `decision.retry` and `decision.delay` are set. `error`, the
  response, headers, and body are never mutated. There is no fetch wrapper, no
  `http.request` or `http.response` hook, no response rewriting, no retry loop,
  and no `session.abort`; interruption stays native.
- Mid-stream (Class B) events are intercepted only when the message text yields a
  reset time. This is the 2026-10-22 field failure
  (`openspec/changes/claude-session-limit-native-retry/reports/field-failure-20261022.md`):
  the v1 plugin skipped that event, so native backoff ran. A Class B event without a
  parseable text reset is left to native backoff, and its next retry reaches the
  proxy's 429 gate.
- Only the `retry` hook is registered. Cleanup disposes it idempotently.

Options:

| Option | Default | Purpose |
| --- | --- | --- |
| `maxWaitMs` | 6 h (`CLAUDE_SESSION_LIMIT_MAX_WAIT_MS`) | Cap on the graced wait; positive finite, clamped to 2_147_483_647 ms |
| `nowMs` | `Date.now` | Wall clock; test-only |
| `monotonicMs` | monotonic clock | Cooldown clock; test-only |
| `staggerMs` | random 0-250 ms | Per-call stagger; test-only |

Verification (provider-free; run from `packages/opencode-codex-quota-retry/`):

```text
bun test ./scripts/claude_session_limit_retry.test.ts      # 70 tests
bun scripts/claude_session_limit_stub_gate.ts --self-check
```

The isolated stub gate needs the installed OpenCode 2.1.2 and talks only to a
localhost 429 stub. It does not contact a provider. It has three scenarios:

```text
bun scripts/claude_session_limit_stub_gate.ts                      # default: 429, resets_at 2 h out
bun scripts/claude_session_limit_stub_gate.ts --scenario=fallback  # 429, retry_after 600, text reset ~2 h out
bun scripts/claude_session_limit_stub_gate.ts --scenario=midstream # HTTP 200 SSE error chunk, text reset ~4 h out
```

The 2026-10-22 v2 gate passed all three on 2.1.2, with one stub chat request and
one hook attempt each. Default set `decision.delay` to 7,260,083 ms (2 h reset,
60 s grace, stagger), above the native 15-minute cap. Fallback set 7,296,314 ms,
from the text reset rather than the ~11 min that `retry_after: 600` alone would
give. Midstream set 14,489,922 ms, from the text reset. The midstream stub framing
is modelled on field-failure fixture A; the real proxy's exact stream framing is
unverified. On 2.1.2, `error.response` carried only `body`, with no headers and no
`status_code`, so the deadline came from the body and text and the status from
`error.status`. This does not prove a genuinely exhausted subscription; that live
gate (task 3.4) is optional and separately authorized. See
`openspec/changes/claude-session-limit-native-retry/reports/stub-gate-20261022-v2.md`
and, for the v1 default run, `reports/stub-gate-20261022.md`.

Installation: v1 is deployed (task 3.2) and was restarted (task 3.3). The v2
redeploy (task 5.6) is pending and requires explicit authorization plus an
OpenCode restart. The global copies are:

- `~/.config/opencode/plugins/claude-session-limit-retry.ts`
- `~/.config/opencode/lib/claude-session-limit-retry.ts`

The entrypoint imports `../lib/claude-session-limit-retry.ts`, so both files are
needed. Backups belong under `tmp/claude-session-limit-retry/deploy-<date>/`.
Rollback is deleting those two files and restarting OpenCode.
