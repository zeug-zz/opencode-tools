# Cancellation Identity Probe

Status: PASS - primary provider-free identity proof completed for OpenCode 1.19.0.

This report belongs to OpenSpec task 2.4. The builder implementation adds a
provider-free `--identity-contract` mode to
`scripts/test_codex_quota_retry.ts`. The mode starts a fresh isolated
OpenCode 1.19.0 workspace, installs the current retry plugin before the
production wrapper, denies non-loopback external traffic, uses synthetic
Codex quota responses, and persists only safe identity evidence.

The probe must observe actual runtime boundaries for one session:

- `session.retry`
- `session.status`
- `session.abort`
- Codex generation fetch metadata from explicit allowlisted IDs only

`session.retry` and `session.status` are extracted from the exact native
`native.sessionStatusEvents` entries for the observed cancellation session.
The status boundary is the matching native `idle` event observed after the
abort request and before the original retry deadline; it need not occur after
the abort response. `session.abort` is recorded only for the successful abort
HTTP 2xx path and uses that same observed native session id; the probe never
injects an id from the abort request alone. There is exactly one record per
boundary. Missing or duplicate boundary events produce `BLOCKED`.

Only an exact single explicit identity value, represented in persisted
evidence by a one-way digest, may produce `PASS`. Missing, ambiguous, or
colliding identity evidence produces `BLOCKED`. Prompt content, request
bodies, raw header values, credentials, tokens, timing, and ordering are not
used as identity evidence. Effective headers use Request plus init overlay
semantics without constructing or cloning a Request, so identity inspection
does not consume its body. Only allowlisted header values are read; dash and
underscore spellings are both recognized case-insensitively. Unreadable header
inputs block proof.

The primary orchestrator ran the following provider-free identity probe:

```text
bun scripts/test_codex_quota_retry.ts --identity-contract --run-id <unique-id>
```

`--run-id` is optional; when omitted, the harness allocates a unique id. The
expected evidence directory is project-local:
`tmp/codex-quota-retry/<run-id>/identity/`.
The target directory is claimed with a non-recursive create. If it already
exists, the probe reports `BLOCKED` and never overwrites or deletes evidence.

The identity probe is bounded to 120 seconds, permits at most four accepted
stubbed Codex attempts, denies external network access, and uses no paid
provider. First server startup and session creation each have a 30-second
allowance, still bounded by the original total deadline. Diagnostics record
stage checkpoints and error names only, plus HTTP status and JSON top-level
keys for health/session creation; they never persist response payloads or raw
error messages.

## Primary run: `primary-identity-20261014-1`

Evidence is preserved under
`tmp/codex-quota-retry/primary-identity-20261014-1/identity/`.
The run ended `BLOCKED` in about 10.7 seconds with the generic blocker
`identity probe execution failed or produced incomplete safe evidence`. The
request budget records `acceptedRequests: 0` and `exceeded: false`; no
identity-bearing fetch/event fixtures were reached. The cancellation server
stdout confirms that the isolated server became healthy on loopback port
53375, and the owned process manifest records PID 36717 exited cleanly. The
OpenCode log contains only 13 INFO-level config/bootstrap lines, ending at
config bootstrap.

This is an execution/incomplete-evidence failure before correlation data, not
evidence that a Codex fetch lacks identity. Consequently it does not change
the identity verdict to `PASS`, nor does it establish missing identity. The
probe now reports privacy-safe stage checkpoints and stage/error-name reasons,
captures health/session-create status and top-level JSON keys, and permits up
to 30 seconds for the first server startup and session creation while every
bounded request remains capped by the 120-second total deadline. A mocked
slow-bootstrap/failure checkpoint regression is included. The primary
orchestrator must run the next probe with a new unique run id and determine
whether the correlation identity is present; the builder did not run the
identity contract, OpenCode CLI/server, or live smoke.

## Approved primary run: `primary-identity-20261014-2`

Evidence is preserved under
`tmp/codex-quota-retry/primary-identity-20261014-2/identity/identity-contract.json`.
This run completed with `status=PASS` and `installedLiveProof=true` on Bun
1.3.13, OpenCode 1.19.0, and goal plugin 0.1.60. It observed one unique
`sessionID` digest, `sha256:6f5a1e90c75638ce65d5a63f382992ef2428eb462bab23d62f956c890831a63c`,
at the native `session.retry`, `session.status`, and `session.abort` boundaries
and at both actual Codex HTTP fetches (quota response and native retry).
Actual HTTP telemetry found both allowlisted aliases, `session-id` and
`x-session-id`, with matching values corresponding to that same digest. The
evidence records header names and digests only; raw identity values, bodies,
credentials, and tokens are not persisted. The harness and product wrapper did
not inject these headers; they were observed on the actual Codex transport.

The probe waited through the native deadline, stayed within its 120-second and
four-request bounds, and used no external provider. The isolated native server
process (PID 44170) exited. This supersedes the earlier incomplete
`primary-identity-20261014-1` probe. The correlation contract is proven only
for a single tracked pending quota retry per verified `sessionID`; if multiple
outstanding generations make that identity ambiguous, guard decisions must
fail closed rather than widen to session-wide or heuristic suppression.
