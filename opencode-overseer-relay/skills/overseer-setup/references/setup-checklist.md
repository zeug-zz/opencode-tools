# Overseer setup checklist

Use this procedure for an owner-requested campaign of exactly two worker slots,
A and B. Keep setup inspectable and owner-directed; do not infer identities or
authority from names, reports, or prior campaign artifacts.

## Inspect and propose

1. Read the target project's `AGENTS.md`, accepted ADRs, relevant OpenSpec
   requirements/design/tasks, and existing coordination policy. Inspect local
   skill overrides before treating this global skill as effective. Report an
   override or ambiguity; do not assume the global skill is loaded.
2. Use supported Git/OpenCode interfaces read-only to inspect Git common-dir,
   status, registered worktrees, branches, and session/goal identities. Do not
   scrape databases. Confirm existing work and goals with their owners.
3. Propose exactly two useful, non-conflicting ownership tracks, A and B. Show
   shared-file ownership, dependencies, base/head choices, verification gates,
   model choices, per-worker budgets and context, and integration order. Do not
   invent parallel work where B has no independent eligible task.
4. Before any worktree, session, or goal creation or adoption, present one
   precise confirmation naming the objective, paths, branches, ownership,
   dependencies, contexts, models, budgets, and approved actions. Wait for
   confirmation of those exact actions. A skill installation is not approval
   to create or resume goals.

## Prepare safely after confirmation

5. Use only distinct A/B worktrees on distinct branches, not `main`, in the same
   Git common-dir as the main checkout. Inspect existing worktrees read-only;
   never reset, rebase, stash, force-switch, move ongoing work, or discard dirty
   work. The relay's `inspect` reports common-dir, worktrees, branches, dirty
   status, existing campaigns and inbox backlog without adopting them.
6. Preserve the single-approved-root `opencode-local` sandbox boundary for
   each process. Verify each checkout and required shared campaign path under
   its intended boundary. On a denial, run
   `nono why --self --path <path> --op <read|write|readwrite>` and present only:
   (A) the user launches with the needed approved root, or (B) draft a profile
   for its owner to promote. Never silently broaden access, edit global
   profiles, or use an unsandboxed fallback.
7. Ask the owner to confirm exact session IDs, directories, agents/modes, and
   server contexts for Overseer, A, and B from their actual conversations.
   Titles are not routing identities. Do not substitute a session or infer a
   binding. Keep the Overseer event-driven; do not create an Overseer goal just
   to poll. For resume eligibility, require owner-confirmed A/B session IDs,
    directories, and exact agent IDs confirmed from each worker session; do not
    infer or accept incomplete bindings.
8. Once separately authorized, provide a manually mediated setup prompt to
   each selected worker orchestrator. Explicitly ask that orchestrator to
   create its own goal and plan with its own limits and acknowledge its goal
   ID. The relay sends no prompts to workers in phase 1. Existing goals require
   explicit adoption; never replace or silently resume one. An unbound role
   may remain unbound; do not invent its identity.

## Baseline and phase-1 gates

9. Use the package with an explicit source path during development:

   ```sh
    PYTHONPATH=packages/opencode-overseer-relay/src python3 -B -m overseer_relay --help
   ```

    After approved 0.2.0 installation, Python runtime is at
    `<target-root>/overseer-relay/runtime/0.2.0/src`; managed helper assets are at
    `<target-root>/overseer-relay/runtime/0.2.0/managed/dist/`. Python
    `PYTHONPATH` is the runtime `src` directory. Retained 0.1.0 installs use
    `<target-root>/overseer-relay/runtime/0.1.0/src`; scripts, templates, and
   `README.md` are unversioned at
   `<target-root>/overseer-relay/runtime/{scripts,templates,README.md}`.
   Installed skills live at `<target-root>/skills/<skill-id>/`; relative to
    that base, current runtime is `../../overseer-relay/runtime/0.2.0` and scripts are
   `../../overseer-relay/runtime/scripts`. A source skill lives at
   `<package>/skills/<id>` and its source package root is `../..` from the skill
   base. Check the actual paths or install manifest to identify the layout;
   do not assume it. For source use, set `PYTHONPATH` to `../../src` from the
   skill base; for installed use, use
    `../../overseer-relay/runtime/0.2.0/src`. Run `python3 -B -m overseer_relay`
   to suppress bytecode. Discovery checks are effective without a restart or
   service start.
10. Preview with the real CLI. `inspect --repo <main>` is read-only. `init`
    defaults to dry-run; show its proposed layout and configuration first. Its
    `--apply` option persists only the campaign layout and refuses an existing
    campaign; it does not create/adopt worktrees, sessions, or goals. Explain
    the observed A/B backlog byte ranges and get a visible choice per source:
    baseline now (ignore prior bytes) or an exact half-open byte range to
    include. Do not silently replay backlog.
11. Run `once --campaign-dir <campaign>` in its default dry-run mode; it makes
    no state or transport writes. A persisted `--apply` scan is a separate
    action. `watch --campaign-dir <campaign>` scans in the foreground and does
    not deliver notices unless explicitly opted in. Keep notice activation
    separate from setup and require reviewed configuration with explicit owner
    approval, pinned connection, and qualified identity/capabilities; runtime
    delivery additionally requires `--deliver-notices`. `once`/`--dry-run` and
     status remain unauthenticated/offline; dry-run does not qualify actual
     authentication. Never auto-enable a capability or start/restart a service.
     For managed mode, use the schema-v2 connection object from
     `templates/managed-campaign-config.json`, pinning the owner-confirmed URL;
     `expected_pid` is optional for legacy configurations and omitted by the
     template. Each helper call uses SDK discovery of the registered healthy
     service, then checks the URL and the bound Overseer session ID, directory,
     agent, and active (not archived) status. A changed service PID after
     restart does not require rebind when the URL and session binding still
     match; a configured legacy PID must match. A changed URL or session binding
     requires deliberate owner rebind, and a missing session fails closed.
     Source `init` remains schema-v1 and no CLI flag auto-enrolls a service.
     Host version is informational; actual bounded API-contract qualification
     decides compatibility. Campaign locks and Overseer bindings are independent
     per campaign. Live qualification is separately approved and was not done.
 12. `goal_resume` remains false unless the owner explicitly enables it in
     schema-v2 managed-local config; it is managed-local only. Never auto-enable
     it or treat setup approval as resume approval. Pause, steer, and worker
     prompt delivery remain forbidden. Do not poll models. Do not edit the main checkout
    automatically, commit, push, merge, or remove worktrees without explicit
    permission.
