# Native Verification Report

## Primary audit status

**PASS - task 4.2 complete from the primary installed-runtime verdict. Task 4.3
remains unchecked pending its next audit.** The prior failed run below remains
historical evidence; this report records the new primary run without rewriting
that history or substituting a builder judgment for its verdict.

Primary evidence:

`tmp/codex-quota-retry/primary-guard-final-20261015-5/verdict.json`

The primary verdict records `status: PASS`, `finalGate: orchestrator-task-4.2`,
`installedLiveProof: true`, and `elapsedMs: 143632` (143.632 seconds, within the
220000 ms run bound). It records 11 exact Codex requests, 2 quota responses,
and 1 cancellation-session request. The verdict records zero failed
assertions and an empty `missingRequiredEvidence` list. The primary raw fixture
marker at `tmp/codex-quota-retry/primary-guard-final-20261015-5/evidence/cancellation/fixture-installed.json`
records `installedBeforeProductionWrapper: true`.

The legacy auxiliary `installedFixtureRecorded: false` diagnostic in the
verdict is a report-projection discrepancy, not a required gate criterion; it
is not represented here as true. The required validator assertions are all
true. The verdict also lists
`evidence/cancellation/aborted-fetch-attempts.jsonl`, but that file is absent
from the captured run directory; this artifact-list discrepancy is retained
as a diagnostic and does not change the recorded primary verdict.

The historical failure remains preserved below, including the observed
post-abort Codex request.

## Provider-free and OpenSpec verification

- `bun scripts/test_codex_quota_retry.ts --all` passed 7/7.
- `bun scripts/test_codex_quota_retry.ts --smoke-contract` passed.
- `openspec validate codex-subscription-native-retry-adapter --strict` passed.
- `git diff --check` passed.

## Primary installed-runtime evidence - expected and observed

- **Expected:** Installed-runtime/no-provider run on Bun `1.3.13`, OpenCode
  `1.19.0`, goal plugin `0.1.60`; external network denied; one Sol primary,
  one general/Luna child, short synthetic quota reset, exact cancellation,
  no post-abort outbound request, and a parallel unaffected session after
  shared cooldown expiry.
- **Observed:** Manifest confirms Bun `1.3.13`, OpenCode `1.19.0`, and
  `@prevalentware/opencode-goal-plugin@0.1.60`; fixture marker confirms
  installation before the production wrapper; preflight and manifest record
  no provider and external network denied. The exact transport route was
  observed:
  `https://chatgpt.com/backend-api/codex/responses`.
- Expected and observed load order match: smoke transport, production quota
  wrapper, then the pinned goal plugin. The parent used `openai/gpt-6.1-sol`
  with agent `primary`; exactly one child task used `openai/gpt-6-luna` with
  agent `general`.
- The one-second synthetic reset plus 60-second grace produced an actual
  `429` quota response. Native retry status and next timestamp were recorded.
- **Cancellation session A:** expected one quota response, native abort before
  deadline, and no later request. Observed one cancellation-session HTTP
  request (429), successful HTTP 200 cancellation, native transition to idle,
  and the primary verdict's cancellation assertions true, including no later
  cancellation request. No raw session/request identifiers are reproduced;
  per-request evidence is allowlisted field names plus SHA-256 digests.
- **Parallel session B:** expected a distinct native identity and a
  non-mutating plaintext response after the shared cooldown expired. Observed
  two HTTP 200 responses on the same server process, with different observed
  native identity and no mutation.
- The parent/child relationship remained stable: exactly one persisted
  `apply_patch` side effect and one completed parent goal. No continuation
  prompt or duplicate parent delegation was recorded.
- Process manifest: parent exited normally; cancellation server exited via
  `SIGTERM`; no owned smoke runtime remained running.

Evidence paths (all under
`tmp/codex-quota-retry/primary-guard-final-20261015-5/`):

- `manifest.json`, `expected-scenarios.json`, `plugin-load-order.json`,
  `process-manifest.json`, `goal-state-summary.json`, `verdict.json`
- `evidence/cancellation/fixture-installed.json`,
  `evidence/cancellation/loaded-goal-plugin.json`,
  `evidence/cancellation/request-timeline.jsonl`,
  `evidence/cancellation/identity-fetch-telemetry.jsonl`,
  `evidence/cancellation/native-events.jsonl`,
  `evidence/cancellation/quota-responses.jsonl`
- `evidence/parent/native-events.jsonl`,
  `evidence/parent/identity-fetch-telemetry.jsonl`,
  `evidence/parent/side-effects.jsonl`,
  `evidence/request-budget.json`
- The verdict's evidence list includes
  `evidence/cancellation/aborted-fetch-attempts.jsonl`, which was not present
  in the captured cancellation directory; see the projection/artifact note
  above.

## Historical failed cancellation gate outcome - preserved

The earlier primary run genuinely failed its cancellation assertions. This
record is retained as history and is superseded for the current 4.2 status by
the new primary verdict above; its observations are not erased:

- The cancellation session received its first quota response at
  `1791972468417`.
- Native status changed to `retry` at `1791972469248` with
  `next=1791972529464`.
- The POST abort request was sent at `1791972469341`, returned HTTP 200, and
  reported `succeeded: true`.
- Native status changed to `idle` at `1791972469376`.
- Despite the successful abort, the fixture recorded a second HTTP/Codex
  request at `1791972529468`, 4 ms after the scheduled retry timestamp.
- `evidence/cancellation/aborted-fetch-attempts.jsonl` was absent/none. This
  does not establish that the later request was an already-aborted signal
  caught by the faithful fixture.

The historical verdict records failed assertions
`nativeCancellationAfterPendingRetry` and `noLaterCancellationRequest`.
The later-request condition was a genuine FAIL for that run.

## Final scope audit for task 4.3

- The only authorized OpenSpec metadata is
  `openspec/changes/codex-subscription-native-retry-adapter/.openspec.yaml`.
- The repository-root `.openspec.yaml` is absent.
- Scoped status shows only the planned untracked change artifacts, plugin,
  helper, test, and operations document. The scoped tracked diff is empty
  because these artifacts are untracked.
- No application/product source, plugin, helper, test, global configuration,
  dependency, or goal-state file was edited by this audit task. Existing
  unrelated worktree changes were left untouched.
- The isolated evidence mutation is under the recorded `tmp/` run workspace;
  it is not a repository product-source mutation.

Task 4.3 was completed in the prior audit and remains unchecked for this
revision until the requested next audit. Task 4.2 is checked complete solely
because the new primary verdict records PASS and all required validator
assertions true; the historical failure and auxiliary diagnostics remain
visible above.

## Final scope audit - task 4.3

Reviewed the primary `primary-guard-final-20261015-5` verdict and the full
change artifacts before repeating the final audit. The primary run records
143632 ms elapsed, 11 exact Codex HTTP requests, 2 quota responses, and 1
cancellation-session request. The cancellation session had 61047 ms of child
wait; session A produced zero post-abort outbound requests. Distinct-identity
session B completed two non-mutating HTTP 200 requests in the same server PID.
The run retained one parent task, one side-effect mutation, and one completed
goal. The primary assertion set had zero failures and no missing required
evidence. Both owned smoke processes exited; the parent exited normally and the
cancellation server exited via SIGTERM.

The auxiliary `installedFixtureRecorded=false` projection remains distinct
from the raw fixture marker (`installedBeforeProductionWrapper=true`) and the
true core-validator assertion. The optional
`aborted-fetch-attempts.jsonl` artifact remains absent as expected: the
cancellation guard blocks the aborted attempt before the fixture can record an
outbound fetch. Neither diagnostic is represented as a required assertion or
rewritten as present evidence.

Final audit commands and results:

- `openspec validate codex-subscription-native-retry-adapter --strict` -> PASS.
- Provider-free `bun scripts/test_codex_quota_retry.ts --all` -> PASS, 9/9
  modes. This is not a rerun of the native smoke.
- Scoped status was inspected for the exact task paths, including the run
  workspace: only the change-local OpenSpec artifacts, project plugin/helper,
  provider-free test, and operator document were present; `tmp/` evidence is
  ignored by Git. The scoped tracked diff is empty because the planned files
  are untracked artifacts.
- The change-local `.openspec.yaml` is the sole authorized metadata file;
  repository-root `.openspec.yaml` and `.opencode/opencode.json` are absent.
  `.opencode/package.json` remains unchanged, with
  `@opencode-ai/plugin@1.4.6` and no old project dependency name.
- The 70-file unrelated worktree baseline hash, computed from sorted paths
  followed by their current bytes and excluding this change plus the four
  implementation paths, remains
  `53baa4d7cacffcf9d7173104899b67211edb65fc41c636d955dbe9d30c312ccf`.
  No unrelated worktree changes were reverted or rewritten.
- Scoped ASCII scan -> PASS. No native CLI, smoke, server, package, global
  configuration, goal-state, or application-runtime changes were made by this
  audit.

The separate pinned OpenCode process used for the primary gate has exited.
This audit did not restart the current interactive process and did not perform
global installation. Operator activation therefore still requires an explicit
restart after this final summary; no claim is made that this process is already
running the new plugin.
