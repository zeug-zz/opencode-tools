# OpenCode Overseer Relay

The relay prepares a two-source A/B campaign and notifies its explicitly bound
Overseer. Its only worker-directed operation is the separately gated,
resume-only capability described below; it does not steer or pause workers.
Global packaging is not installed or activated by this change.

## Runtime and offline tests

Python 3.15 is the tested runtime. Schema-v1 remains standard-library-only and
does not require Node or the helper. Managed-local optionally requires Node.js
>=18; its staged self-contained helper needs no runtime Bun/npm or dependency
installation. From the repository root, run source commands as:

```sh
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay --help
python3 -m unittest discover -s packages/opencode-overseer-relay/tests -t packages/opencode-overseer-relay
```

`-B` suppresses bytecode writes. The tests use local fakes and temporary
repository fixtures under ignored repository `tmp/`; they make no provider or
live-session calls.

## Setup and operation

Use `inspect --repo <main-checkout>` for read-only discovery. Preview `init`
first; its `--apply` persists campaign files only. For example, after making
two distinct A/B worktrees and branches through the approved skill/manual
workflow (not this CLI), inspect or initialize them with:

```sh
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay inspect --repo <main-checkout>
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay init --repo <main-checkout> --campaign <id> --base-ref <ref> --worktree-a <A-path> --worktree-b <B-path> --baseline-a now --baseline-b now
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay init --repo <main-checkout> --campaign <id> --base-ref <ref> --worktree-a <A-path> --worktree-b <B-path> --baseline-a now --baseline-b now --apply
```

The first `init` is a no-write preview; use `--apply` only after reviewing it.
Each baseline may instead be an exact `START:END` byte range. The CLI does not
create/adopt worktrees, sessions, or goals and does not import an existing
campaign's non-empty backlog. The fresh baseline-range campaign in this
implementation has empty inboxes; non-empty backlog import is not implemented.
Setup skills/manual operations require explicit owner approval for actual
worktree/session/goal preparation. `goal_id` is carried by the phase-1 setup
handoff, not by runtime config.

`once` defaults to a read-only preview; `--apply` persists one watcher cycle
without sending notices. Sending requires a separate apply plus delivery opt-in
and approved, bound, enabled configuration:

```sh
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay once --campaign-dir <campaign> --dry-run
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay once --campaign-dir <campaign> --apply
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay once --campaign-dir <campaign> --apply --deliver-notices
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay watch --campaign-dir <campaign>
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay watch --campaign-dir <campaign> --deliver-notices
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay status --campaign-dir <campaign>
```

`watch` stays in the foreground; without `--deliver-notices` it makes no
outbound transport calls. `status` is read-only. `once` and `--dry-run` do not
authenticate or make network requests; dry-run does not prove authentication.
Delivery requires a separately qualified service and public API/session
identity; fixture evidence does not qualify a live installation. Managed-local
operations discover the registered healthy service afresh and never start or
restart it.

Holds are explicit and visible. Resolve the underlying condition before
releasing a selected source or batch:

```sh
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay hold --campaign-dir <campaign> --source A --reason <reason>
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay release --campaign-dir <campaign> --source A
```

For uncertain sends, release performs at most the explicit reconciliation
attempt; it does not authorize a blind resend. Preserve snapshots and evidence.
The watcher requires two matching observations before settling bytes.

## Goal resume (resume-only)

The Overseer may issue a resume only after independently verifying a resolved
dependency/coordination wait and an eligible worker goal state. Owner-stopped,
complete/unmet, Plan-mode, and unknown-state goals must be escalated, not resumed.
The owner must explicitly enable `capabilities.goal_resume`; it defaults false
and is supported only with schema-v2 managed-local transport. Setup requires
owner-confirmed A/B session IDs, directories, and exact agent identities before
activation.

After appending the evidence-bound ruling to `rulings/<role>.md`, run:

```sh
PYTHONPATH=<runtime>/src python3 -B -m overseer_relay resume --campaign-dir <campaign> --role A [--role B] --ruling <ruling-id>
```

`--dry-run` is a read-only eligibility preview. The helper sends only the fixed
`resume_goal` command through the qualified `/api/session/{sessionID}/command`
route. HTTP 204 means admitted/delivered, not that the goal resumed; the native
worker goal plugin remains authoritative. Attempts are recorded in bounded,
append-only `controls/resume.jsonl`, deduplicated by ruling and role, with at
most one crash-safe ambiguous retry. `duplicate` means already delivered for
that ruling and role; use a new ruling or deliberately use `--force`. On
`uncertain`, check worker state and do not loop. No pause, steer, or worker-prompt
delivery is permitted.

## State and recovery

Campaign data is rooted at `<git-common-dir>/overseer-relay/campaigns/<id>/`.
`config.json` records schema-v1 or schema-v2 roles, explicit bindings,
baselines, bounded limits, a non-secret pinned connection, and capability
flags. The state also contains `inbox/A.md`, `inbox/B.md`, `rulings/A.md`, `rulings/B.md`,
`watcher/state.json`, `watcher/batches/`, `holds.json`, and
`overseer-handoff.md`. Each batch may have its own
`watcher/batches/<batch-id>/overseer-ack.md`. `watcher/state.json` is
authoritative; `holds.json` is a placeholder. The watcher lock is acquired only
at runtime, never created by `init`.

State tracks source cursors and consumed-prefix hashes plus durable batches.
Snapshots precede cursor advancement; a send intent precedes POST. On restart,
reuse snapshots and reconcile exact campaign/batch metadata. A missing proof of
admission remains uncertain/held; do not retry blindly. Never steal a
stale-looking lock. For partially bound roles, explicitly confirm the relevant
capability flags and `config.json` `connection` array of validated `--server`
arguments, or its schema-v2 managed-local URL object (with an optional legacy
PID pin), against the exact schema and target API before any live activation.

## Packaging and rollback

All script invocations require an explicit target root. The installer previews
by default; its manifest records artifact versions and hashes, prior-file state
and hashes, and backup paths. Existing files require `--replace-existing` to
replace after backup. Do not upgrade an installed version in place without
reviewing its manifest and policy. Version 0.2.0 refuses an active 0.1.0
manifest: preview and apply a matching rollback using old 0.1.0 scripts/runtime
first, after the owner resolves intervening edits; stop only the watcher, not
the service or goals. Then separately review/install 0.2.0 from source with an
explicit target root and required authorization. Preserve shared Git-dir
campaign data and rollback receipts; there is no automatic upgrade. The global target requires both `--apply`
and the additional `--authorize-global-install` owner gate; neither is run as
part of offline verification. Use only temporary targets for tests:

```sh
python3 -B packages/opencode-overseer-relay/scripts/install.py --target-root tmp/overseer-relay-target
python3 -B packages/opencode-overseer-relay/scripts/install.py --target-root tmp/overseer-relay-target --apply
python3 -B packages/opencode-overseer-relay/scripts/verify.py --target-root tmp/overseer-relay-target
python3 -B packages/opencode-overseer-relay/scripts/rollback.py --target-root tmp/overseer-relay-target
python3 -B packages/opencode-overseer-relay/scripts/rollback.py --target-root tmp/overseer-relay-target --apply
```

For managed-helper development, the already-resolved project-local SDK inputs
are checked/staged with Node's standard library; these commands do not install
dependencies or contact a provider:

```sh
node packages/opencode-overseer-relay/managed/scripts/build.mjs
node --test packages/opencode-overseer-relay/managed/tests/*.test.mjs
```

The fixed 18-file SDK input inventory and hashes in `managed/sdk-inventory.json`
plus `managed/bun.lock` make staging reproducible. The lock's 2.2.6 version is
not a host-version requirement. The historical Bun 1.3.13 single-file build
failed while traversing `/Users/user`; it was replaced by the bounded Node
source stager, not by a wider HOME permission or another Bun attempt. The
stager reads only explicit project-local SDK source files.

Verify is read-only. Rollback preview writes nothing; apply preflights all
restores, preserves intervening edits, and refuses missing or corrupt backups.
Record the tool receipt: partial I/O failure can leave residual files despite
preflight guarantees. Installed Python runtime is at
`<target-root>/overseer-relay/runtime/0.2.0/src`; managed assets are at
`<target-root>/overseer-relay/runtime/0.2.0/managed/dist/`. Retained 0.1.0
installs keep `<target-root>/overseer-relay/runtime/0.1.0/src`. Scripts, templates, and
`README.md` are unversioned at
`<target-root>/overseer-relay/runtime/{scripts,templates,README.md}`. Installed
skills live at `<target-root>/skills/<skill-id>/`; from that base, current runtime is
`../../overseer-relay/runtime/0.2.0` and scripts are
`../../overseer-relay/runtime/scripts`. A source skill lives at
`<package>/skills/<id>` and its source package root is `../..` from the skill
base. Check actual paths or the install manifest to distinguish source from
installed layout; do not assume either. Source commands use `../../src`
relative to the skill base and installed commands use
`../../overseer-relay/runtime/0.2.0/src`, with `python3 -B -m overseer_relay`.
Discovery checks are effective immediately; no restart or service start is
required.

## Security and operational gates

The relay is a local cooperative filesystem protocol, not hostile-process
isolation. Keep the approved shared root and sandbox boundary; path checks,
symlink refusal, bounded inputs, hashes, and locks do not protect against a
same-user adversarial process. Never put credentials in configuration,
reports, manifests, or diagnostics. Only the confirmed Overseer is a transport
destination; API admission is not report review or goal resumption.

Offline tests, installed fixtures, or public V2 fixtures are not evidence that
the pinned `--server` contract or qualified public API/session fields are
installed. Live API qualification, actual global installation, notice
activation, idle wake behavior, and disposable-session checks remain separate
owner-authorized operational gates and were not performed here. No provider
calls are part of this package's verification.

## Schema-v2 managed-local configuration

Keep schema-v1's `connection` list of `--server` arguments as the default
unless managed-local mode is explicitly approved; it remains standard-library-
only and Node-free. Managed schema-v2 starts from
`templates/managed-campaign-config.json`. `init` remains schema-v1 by default;
managed configuration requires a deliberately reviewed manual template edit,
not an undocumented CLI flag. Use the exact connection object below with
owner-confirmed URL; discovery/status/observed ports do not auto-enroll or
populate pins. URLs must be canonical HTTP(S) IP loopback addresses with an
explicit port and no path; only `127.0.0.1` and `[::1]` are accepted. An
`expected_pid` may be retained as a positive bounded legacy pin, but is omitted
by the template. The example URL is a placeholder, not a real service binding.
No credentials or `expected_version` belong in the object. With no PID pin, a
service restart and changed PID do not require rebind: each helper call uses
SDK `Service.discover()` for the registered healthy service, then checks the
pinned URL and the existing Overseer session binding (ID, directory, agent, and
not archived). A missing or mismatched session still fails closed. A changed
URL or session binding requires owner rebind; a configured legacy PID must also
match. Campaign locks and Overseer bindings remain independent per campaign.

```json
{
  "mode": "managed-local",
  "expected_url": "http://127.0.0.1:17777"
}
```

The locked project-local `@opencode/client` 2.2.6 input supports reproducible
builds only; host compatibility is established by bounded qualification of the
actual required public API contract. Compatible additive fields are accepted;
unknown required request fields, malformed/unbounded contracts, and malformed
required responses fail closed. Bounds include 2 MiB OpenAPI, 1 MiB responses
and output, 16 KiB prompt text, and 50–30,000 ms operation timeouts. Only fixed
operations are allowed; redirects are rejected. There is no `Service.ensure`/
`stop`, bare CLI fallback, or blind POST retry.

`Service.discover()` itself may probe the endpoint in the cooperative local
registry before checking the owner pin; this is a trusted-local-registry
boundary, not endpoint attestation. The helper keeps auth headers private and
returns only bounded whitelisted projections, dropping raw message text,
headers, and raw error text. No password is copied. Live authentication/API
qualification has not been performed and needs separate owner approval. A
read-only Python `load_config`/`preflight_session` review is not authentication
qualification.
