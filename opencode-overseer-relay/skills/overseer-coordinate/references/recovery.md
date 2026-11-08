# Restart, holds, and recovery

## Reconstruct the live binding

After restart or context loss, do not rely on chat cache alone. Re-read the
current campaign config and actual role bindings (campaign, generation,
session, canonical directory, branch, and agent), project artifacts and policy,
current goal through supported tools, relay status, durable snapshots and
acknowledgements, and the Overseer handoff. Confirm campaign and common-dir
identity before acting. State is authoritative in `watcher/state.json`; an
initial `holds.json` placeholder does not override it. If a session, goal, or
binding generation rotated, require owner rebind; do not guess.

For managed-local delivery, each helper call rediscovers the registered healthy
service and checks the pinned loopback URL plus the bound Overseer session (ID,
directory, agent, and not archived). The default URL-only configuration follows
a service restart without a manual PID rebind; `expected_pid` is optional for
legacy configurations and remains an equality check when present. A missing or
mismatched Overseer session still fails closed. Campaign locks and Overseer
bindings remain independent per campaign.

## Supported phase-1 commands

For source checkout, the skill base is `<package>/skills/<id>` and the source
package root is `../..` from that base; use `../../src`. Current 0.2.0
installed Python runtime is at `<target-root>/overseer-relay/runtime/0.2.0/src`
and helper assets are at `<target-root>/overseer-relay/runtime/0.2.0/managed/dist/`;
scripts,
templates, and `README.md` are unversioned under
`<target-root>/overseer-relay/runtime/{scripts,templates,README.md}`. Installed
skills use the base `<target-root>/skills/<id>`, with current runtime at
`../../overseer-relay/runtime/0.2.0` and scripts at
`../../overseer-relay/runtime/scripts`. Check actual paths or the install
manifest before choosing source versus installed layout; do not assume. All
installed module commands use `python3 -B -m overseer_relay` to suppress
bytecode; install verification treats unexpected cache files as a mismatch. No
restart or service start is needed for effective skill discovery.

```sh
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay status --campaign-dir <campaign>
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay once --campaign-dir <campaign> --dry-run
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay hold --campaign-dir <campaign> --reason <reason>
PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay release --campaign-dir <campaign>
```

`status` is read-only. `once --dry-run` previews; applying a cycle and
`--deliver-notices` are separate explicit operational gates. A relay hold stops
relay delivery, not a worker's running goal. Never automatically steal a
stale-looking campaign lock.

## Uncertain delivery

On restart, reuse committed immutable snapshots and deterministic batch IDs;
uncommitted bytes are reobserved because their cursor did not advance. A
send-intent without definitive receipt must be reconciled against the bound
session's inbox/messages for exact campaign and batch metadata. Unavailable,
incomplete, conflicting, or unprovable results remain uncertain and held.
Explicit release permits one reconciliation attempt; it is not permission to
blindly resend or rebaseline. Preserve snapshots, cursors, and evidence. Do not
restart services, obtain credentials, widen global access, or activate global
installation/live sessions as part of recovery.

Resume attempts are recorded in the bounded append-only
`controls/resume.jsonl` ledger. For resume outcomes, `duplicate` means that ruling and role were already
delivered; use a new ruling or deliberately request `--force`. Treat `uncertain`
as unresolved: check the worker's state and do not loop or automatically retry.
