import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retireSources, type Config } from "./retire_neq_codex_quota_retry.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = resolve(PACKAGE_ROOT, "../..");
const MANIFEST = join(PACKAGE_ROOT, "provenance/migration-manifest.json");
const GLOBAL_PATHS = [
  "/Users/user/.config/opencode/plugins/codex-quota-retry.ts",
  "/Users/user/.config/opencode/lib/codex-quota-retry.ts",
];
const FROZEN_GLOBAL_SNAPSHOTS = [
  join(PACKAGE_ROOT, "provenance/original/implementation/.opencode/plugins/codex-quota-retry.ts"),
  join(PACKAGE_ROOT, "provenance/original/implementation/.opencode/lib/codex-quota-retry.ts"),
];
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
let scratch: string;
let config: Config;

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createPrimaryRun(runDir: string, workspace = join(runDir, "workspace"), finalGate = "orchestrator-task-4.2"): void {
  mkdirSync(workspace, { recursive: true });
  put(join(runDir, "manifest.json"), JSON.stringify({
    schema: "codex-quota-retry-smoke.v1",
    mode: "smoke",
    runId: runDir.split("/").at(-1),
    startedAt: "2026-10-15T00:00:00.000Z",
    installedLiveProofRequired: true,
    noProvider: true,
    sourceHashes: { fixture: "fixture-sha256", helper: "helper-sha256", plugin: "plugin-sha256" },
    runtime: { bun: "1.3.13", opencode: "1.19.0" },
    goalPlugin: { package: "@prevalentware/opencode-goal-plugin", pinnedVersion: "0.1.60" },
    expected: {
      schema: "codex-quota-retry-smoke.v1",
      installedLiveProofRequired: true,
      cancellation: { session: "A", exactIdentityRequired: true, nativeAbortBeforeDeadline: true, noLaterOutbound: true },
      parallel: { session: "B", differentNativeIdentity: true, submitAfterSharedCooldownExpiry: true },
      requestBudget: { maxRequests: 12 },
      maxRuntimeMs: 220000,
    },
    paths: { workspace: "workspace", config: "workspace/opencode.json", evidence: "evidence", mutation: "workspace/smoke-child-mutation.txt" },
  }));
  put(join(runDir, "process-manifest.json"), JSON.stringify({
    schema: "codex-quota-retry-process-manifest.v1",
    processes: [
      { pid: 10001, role: "parent", workspace, status: "exited", timedOut: false, signal: null },
      { pid: 10002, role: "cancellation-server", workspace, status: "exited", timedOut: false, signal: "SIGTERM" },
    ],
  }));
  put(join(runDir, "verdict.json"), JSON.stringify({
    schema: "codex-quota-retry-smoke.v1",
    status: "PASS",
    finalGate,
    installedLiveProof: true,
    assertions: {
      pinnedRuntimeVersions: true,
      offlinePreflightAndNoExternalNetwork: true,
      nativeRetryStatusAndTimestamp: true,
      noLaterCancellationRequest: true,
      everyOutboundRequestHasSafeObservedIdentity: true,
      cancellationRequestsMatchNativeSessionA: true,
      parallelSessionBHasDifferentObservedNativeIdentity: true,
      stableParentChildRelationship: true,
      persistedMutationExactlyOnce: true,
      finalParentGoalComplete: true,
    },
    failedAssertions: [],
    missingRequiredEvidence: [],
  }));
}

function cleanApplyError(): void {
  expect(() => retireSources({ ...config, apply: true, primaryGate: "tmp/codex-quota-retry/fixture-primary-run/verdict.json" })).toThrow();
  expect(existsSync(join(scratch, "sandbox/tmp/codex-quota-retry/fixture-run"))).toBe(false);
}

beforeEach(() => {
  scratch = mkdtempSync(join(SANDBOX, "tmp/codex-quota-retry/retirement-tests-"));
  const neqRoot = join(scratch, "neq");
  const sandboxRoot = join(scratch, "sandbox");
  mkdirSync(join(sandboxRoot, "tmp/codex-quota-retry"), { recursive: true });
  for (const asset of manifest.authored_assets) {
    const backup = join(SANDBOX, asset.original_snapshot);
    const source = join(neqRoot, asset.source);
    mkdirSync(dirname(source), { recursive: true });
    copyFileSync(backup, source);
    const fixtureBackup = join(sandboxRoot, asset.original_snapshot);
    mkdirSync(dirname(fixtureBackup), { recursive: true });
    copyFileSync(backup, fixtureBackup);
  }
  for (const [index, globalPath] of GLOBAL_PATHS.entries()) {
    const fixturePath = join(scratch, "globals", globalPath.split("/").slice(-2).join("/"));
    mkdirSync(dirname(fixturePath), { recursive: true });
    // Test the historical retirement guard against its frozen inputs, not the
    // user's current global installation, which has since been deployed with V2.
    copyFileSync(FROZEN_GLOBAL_SNAPSHOTS[index], fixturePath);
  }
  const fixtureManifest = join(sandboxRoot, "manifest.json");
  copyFileSync(MANIFEST, fixtureManifest);
  createPrimaryRun(join(sandboxRoot, "tmp/codex-quota-retry/fixture-primary-run"));
  config = {
    neqRoot,
    sandboxRoot,
    manifestPath: fixtureManifest,
    globalPaths: GLOBAL_PATHS.map((path) => join(scratch, "globals", path.split("/").slice(-2).join("/"))),
    apply: false,
    runId: "fixture-run",
  };
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("NEQ Codex quota retry source retirement", () => {
  test("default dry run is exact and leaves source and snapshot unchanged", () => {
    const before = manifest.authored_assets.map((asset: { source: string }) => readFileSync(join(config.neqRoot, asset.source)));
    const output = retireSources(config);
    expect(output[0]).toContain("DRY RUN");
    expect(output).toHaveLength(13);
    expect(existsSync(join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-run"))).toBe(false);
    const portableDeltas: string[] = [];
    manifest.authored_assets.forEach((asset: { source: string; destination: string; original_snapshot: string; bytes: number; sha256: string; destination_sha256_at_import: string; sandbox_current_sha256: string; sandbox_current_bytes: number }, index: number) => {
      const frozenSource = readFileSync(join(config.neqRoot, asset.source));
      const snapshot = readFileSync(join(config.sandboxRoot, asset.original_snapshot));
      const currentDestination = readFileSync(join(SANDBOX, asset.destination));
      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      expect(frozenSource).toEqual(before[index]);
      expect(digest(snapshot)).toBe(asset.sha256);
      expect(snapshot.length).toBe(asset.bytes);
      expect(digest(frozenSource)).toBe(asset.sha256);
      expect(asset.destination_sha256_at_import).toBe(asset.sha256);
      expect(digest(currentDestination)).toBe(asset.sandbox_current_sha256);
      expect(currentDestination.length).toBe(asset.sandbox_current_bytes);
      if (digest(currentDestination) !== asset.sha256) portableDeltas.push(asset.source);
    });
    expect(portableDeltas.sort()).toEqual([
      ".opencode/lib/codex-quota-retry.ts",
      ".opencode/plugins/codex-quota-retry.ts",
      "docs/operations/codex-quota-retry.md",
      "openspec/changes/codex-subscription-native-retry-adapter/design.md",
      "openspec/changes/codex-subscription-native-retry-adapter/proposal.md",
      "openspec/changes/codex-subscription-native-retry-adapter/specs/codex-subscription-native-retry-adapter/spec.md",
      "openspec/changes/codex-subscription-native-retry-adapter/tasks.md",
      "scripts/test_codex_quota_retry.ts",
    ]);
  });

  test("explicit PASS apply backs up and retires exactly 11 files", () => {
    const output = retireSources({ ...config, apply: true, primaryGate: "tmp/codex-quota-retry/fixture-primary-run/verdict.json" });
    expect(output[0]).toContain("APPLIED");
    expect(output.find((line) => line.startsWith("gate_proof_fields="))).toContain("verdict.finalGate=orchestrator-task-4.2");
    expect(output.find((line) => line.startsWith("gate_proof_fields="))).toContain("manifest.paths.workspace matches each exited process-manifest.processes[].workspace under this Sandbox run");
    for (const asset of manifest.authored_assets) {
      expect(existsSync(join(config.neqRoot, asset.source))).toBe(false);
      expect(readFileSync(join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-run", asset.source))).toEqual(readFileSync(join(config.sandboxRoot, asset.original_snapshot)));
    }
  });

  test("source hash drift refuses before writing", () => {
    put(join(config.neqRoot, manifest.authored_assets[0].source), "drift");
    cleanApplyError();
  });

  test("frozen global hash drift refuses before writing", () => {
    put(config.globalPaths[0], "changed global");
    cleanApplyError();
  });

  test("extra historical OpenSpec file refuses before writing", () => {
    put(join(config.neqRoot, "openspec/changes/codex-subscription-native-retry-adapter/unlisted.md"), "extra");
    cleanApplyError();
  });

  test("symlink source refuses before writing", () => {
    const source = join(config.neqRoot, manifest.authored_assets[0].source);
    rmSync(source);
    symlinkSync(join(config.sandboxRoot, manifest.authored_assets[0].original_snapshot), source);
    cleanApplyError();
  });

  test("snapshot collision refuses before writing", () => {
    mkdirSync(join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-run"));
    expect(() => retireSources({ ...config, apply: true, primaryGate: "tmp/codex-quota-retry/fixture-primary-run/verdict.json" })).toThrow(/collision/);
  });

  test("missing, failed, or traversal gate refuses before writing", () => {
    for (const primaryGate of [undefined, "tmp/codex-quota-retry/fixture-primary-run/fail.json", "../../outside.json"]) {
      expect(() => retireSources({ ...config, apply: true, primaryGate })).toThrow();
      expect(existsSync(join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-run"))).toBe(false);
    }
  });

  test("historical imported-NEQ PASS refuses before writing", () => {
    const historicalDir = join(config.sandboxRoot, "tmp/codex-quota-retry/imported-neq-20261015/primary-guard-final-20261015-5");
    createPrimaryRun(historicalDir);
    expect(() => retireSources({ ...config, apply: true, primaryGate: "tmp/codex-quota-retry/imported-neq-20261015/primary-guard-final-20261015-5/verdict.json" })).toThrow(/fresh direct child/);
    expect(existsSync(join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-run"))).toBe(false);
  });

  test("wrong task-2.1 finalGate label refuses even in a fresh-looking directory", () => {
    const runDir = join(config.sandboxRoot, "tmp/codex-quota-retry/copied-old-pass");
    createPrimaryRun(runDir, join(runDir, "workspace"), "orchestrator-task-2.1");
    expect(() => retireSources({ ...config, apply: true, primaryGate: "tmp/codex-quota-retry/copied-old-pass/verdict.json" })).toThrow(/orchestrator-task-4.2/);
    expect(existsSync(join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-run"))).toBe(false);
  });

  test("missing installed-live proof refuses before writing", () => {
    const verdict = join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-primary-run/verdict.json");
    const data = JSON.parse(readFileSync(verdict, "utf8"));
    delete data.installedLiveProof;
    put(verdict, JSON.stringify(data));
    cleanApplyError();
  });

  test("failed assertion refuses before writing", () => {
    const verdict = join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-primary-run/verdict.json");
    const data = JSON.parse(readFileSync(verdict, "utf8"));
    data.failedAssertions = ["noLaterCancellationRequest"];
    put(verdict, JSON.stringify(data));
    cleanApplyError();
  });

  test("missing required-evidence array refuses before writing", () => {
    const verdict = join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-primary-run/verdict.json");
    const data = JSON.parse(readFileSync(verdict, "utf8"));
    delete data.missingRequiredEvidence;
    put(verdict, JSON.stringify(data));
    cleanApplyError();
  });

  test("actual workspace outside this Sandbox run refuses before writing", () => {
    const runDir = join(config.sandboxRoot, "tmp/codex-quota-retry/fixture-primary-run");
    const outsideWorkspace = join(config.neqRoot, "not-sandbox-workspace");
    mkdirSync(outsideWorkspace, { recursive: true });
    const processManifest = join(runDir, "process-manifest.json");
    const data = JSON.parse(readFileSync(processManifest, "utf8"));
    data.processes[0].workspace = outsideWorkspace;
    put(processManifest, JSON.stringify(data));
    cleanApplyError();
  });
});
