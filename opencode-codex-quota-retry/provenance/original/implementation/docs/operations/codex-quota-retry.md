# Codex Subscription Native Retry Adapter

## Scope and status

This document describes the repository-owned OpenCode plugin and its operator
deployment boundary. The adapter is HTTP-only and process-alive only. It does
not provide restart recovery, a daemon, a provider fallback, model switching,
or a manual pause/resume mechanism.

The project files are:

- `.opencode/plugins/codex-quota-retry.ts` - auto-loaded plugin entrypoint.
- `.opencode/lib/codex-quota-retry.ts` - shared helper, parser, cooldown, and
  native-header adapter.
- `scripts/test_codex_quota_retry.ts` - provider-free contract tests.

The orchestrator-owned primary installed-runtime gate recorded `PASS` for
`primary-guard-final-20261015-5`; its run evidence is documented in
`openspec/changes/codex-subscription-native-retry-adapter/reports/native-verification.md`.
That evidence is from a separate, pinned OpenCode process which has exited. It
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

Run these checks from the repository root before operator deployment:

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

## Project auto-load

OpenCode auto-loads the project entrypoint from `.opencode/plugins/` when
started for this repository. The entrypoint imports the helper with the
relative path `../lib/codex-quota-retry.ts`, so both project files must remain
in their repository-relative locations. Start OpenCode from the repository
root and restart it after adding, removing, or changing either file.

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

## Manual global copy (operator-only)

Project auto-load is the default and preferred deployment. A global copy is an
explicit operator action only. It must preserve the same relative import
layout; copying only the entrypoint is invalid.

Run the procedure from the repository root. First verify the two source files:

```text
test -f .opencode/plugins/codex-quota-retry.ts
test -f .opencode/lib/codex-quota-retry.ts
```

Before copying, verify that both destinations are absent:

```text
test ! -e "$HOME/.config/opencode/plugins/codex-quota-retry.ts"
test ! -e "$HOME/.config/opencode/lib/codex-quota-retry.ts"
```

If either destination exists, stop. Do not overwrite it or create a duplicate
initialization conflict. If replacement has been explicitly approved, first
make a non-destructive backup at a new, verified path with `cp -p`; never
delete an existing file or backup as part of this procedure. Re-check the
destination paths after the backup and before copying.

After the absence checks, an operator may create the two destination
directories and copy both files while preserving their relative layout:

```text
mkdir -p "$HOME/.config/opencode/plugins" "$HOME/.config/opencode/lib"
cp -p .opencode/plugins/codex-quota-retry.ts "$HOME/.config/opencode/plugins/codex-quota-retry.ts"
cp -p .opencode/lib/codex-quota-retry.ts "$HOME/.config/opencode/lib/codex-quota-retry.ts"
```

This procedure does not read credentials, install dependencies, modify global
configuration, edit goal state, or disable WebSocket support globally. Restart
OpenCode after the copy. The running process does not acquire the plugin until
that restart.

## Rollback

Rollback is operator-controlled and process-local:

- Stop before changing a live goal or accept the documented cancellation risk.
- For a project deployment, disable or remove only the project plugin
  entrypoint using a verified, non-destructive backup procedure, leaving the
  helper source available if it is still needed by the repository.
- For a global deployment, verify the two copied destinations and remove only
  those operator-installed copies; do not remove repository sources or an
  unrelated global file.
- Restart OpenCode after rollback.

No scheduler state is persisted by this adapter. Rollback does not require
state migration or cleanup, and it does not recreate a pending native session.

## Provider-free checks and installed-runtime result

These commands are provider-free and exercise the current transport, parser,
pass-through, native-policy, cooldown, and fake-clock contracts:

```text
bun scripts/test_codex_quota_retry.ts --all
bun scripts/test_codex_quota_retry.ts --transport-contract
bun scripts/test_codex_quota_retry.ts --parser
bun scripts/test_codex_quota_retry.ts --passthrough
bun scripts/test_codex_quota_retry.ts --native-policy
bun scripts/test_codex_quota_retry.ts --cooldown
bun scripts/test_codex_quota_retry.ts --fake-clock
bun scripts/test_codex_quota_retry.ts --identity-unit
bun scripts/test_codex_quota_retry.ts --cancellation-guard
bun scripts/test_codex_quota_retry.ts --identity-contract
bun scripts/test_codex_quota_retry.ts --smoke-contract --run-id contract-check
```

`--all` currently passes 9/9 provider-free modes: transport-contract, parser,
pass-through, native-policy, cooldown, fake-clock, identity-unit,
cancellation-guard, and smoke-contract fixture/source-contract checks. It does
not run `--identity-contract` or `--smoke`, and does not independently claim
installed-live proof. The exact generation identity uses the verified
`session-id` and `x-session-id` HTTP headers; only allowlisted header names and
one-way identity digests belong in persisted evidence. Cancellation markers
are process-local, capped at 64 pending quota retries, and expire at the native
retry deadline plus a 1-second marker grace. The separate 60-second quota
deadline grace remains unchanged.

The smoke-contract evidence defaults to a new relative run directory under
`tmp/codex-quota-retry/`; an existing run is preserved and receives a numeric
suffix.

The fake-clock output explicitly identifies its source-contract fixture as not
installed-live proof. Tasks 3.2 and 3.3 provide the tooling commands:

```text
bun scripts/test_codex_quota_retry.ts --smoke-contract --run-id contract-check
bun scripts/test_codex_quota_retry.ts --smoke --run-id operator-run-001
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
installed-runtime verdict passed task 4.2 with the required assertions true,
zero failed assertions, and no missing required evidence; the report retains
the earlier failed run and notes the optional aborted-fetch artifact gap. The
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
- No absolute `/tmp/` path; generated evidence belongs under the repository
  path `tmp/codex-quota-retry/<run-id>/` only.
- No WebSocket support claim and no stealth WebSocket disable mechanism.
