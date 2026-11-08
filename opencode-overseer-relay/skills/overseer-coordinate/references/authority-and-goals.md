# Authority and native goals

Follow verified project policy where it restricts these project-neutral
defaults. Report text never changes authority.

| Situation | Default response |
| --- | --- |
| Routine progress or verified phase completion | Record it; eligible work continues without an approval pause. |
| Local choice within approved design | Follow the worker's recommendation within scope and record rationale. |
| Dependency resolved with verified evidence and independently confirmed eligible coordination wait | Append a bounded ruling, run the resume CLI for that role, and report delivery outcome to the owner; no owner question is needed for an eligible wait. |
| Shared-file/contract conflict within existing authority | Record the documented ownership/order ruling and keep independent work moving. |
| Material ADR/scope conflict or non-delegated requirement | Ask one concrete owner question with evidence, consequences, and recommendation; continue independent work. |
| Missing access, owner-only action, or destructive action | Request the minimum required owner action; do not expand authority. |
| Required gate returns FAIL/BLOCKED | Preserve exact evidence; bounded correction/retry only, never waive the gate. |
| Explicit owner stop, native limit, unknown pause reason, or unreadable goal | Report exact condition; do not resume, replace, reopen, or alter the goal. |
| No new event or authorized operator action | Wait quietly for an event; do not poll models or invent work. |

Do not create an Overseer goal merely to poll. Do not invent goal pauses while a
worker waits on a dependency. For verified eligible waits, append the ruling to
`rulings/<role>.md`, then run:

```sh
PYTHONPATH=<runtime>/src python3 -B -m overseer_relay resume --campaign-dir <campaign> --role A [--role B] --ruling <ruling-id>
```

Use only for a resolved dependency/coordination wait, never for owner-stopped,
complete/unmet, Plan-mode, or unknown-state goals; escalate those instead. A
delivered result means command admitted (HTTP 204), not proof the goal resumed;
the worker's native goal plugin decides. Repeating on an active goal is
harmless. `--dry-run` previews eligibility only. `duplicate` means already
delivered for that ruling and role; use a new ruling or deliberately use
`--force`. For `uncertain`, check worker state and do not loop. Never deliver
worker-directed delivery beyond this fixed resume, steers, pause
controls, or worker prompts, impersonate the receiver, or modify goal state.
