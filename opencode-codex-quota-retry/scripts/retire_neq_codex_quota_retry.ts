import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_ROOT = resolve(PACKAGE_ROOT, "../..");
const NEQ_ROOT = "/Users/user/Projects/NeverEndingQuest";
const MANIFEST = join(PACKAGE_ROOT, "provenance/migration-manifest.json");
const GLOBAL_HASHES = new Map([
  ["/Users/user/.config/opencode/plugins/codex-quota-retry.ts", "86feaa78230efcf2976e87ff8b36385a8d91c8f455e8cff9be6008a61197d822"],
  ["/Users/user/.config/opencode/lib/codex-quota-retry.ts", "4e50dfd87587bd9edd56712760fb7f935d8171f82910c1428dd07795e7c58e72"],
]);
const EXPECTED_SOURCES = [
  ".opencode/plugins/codex-quota-retry.ts",
  ".opencode/lib/codex-quota-retry.ts",
  "scripts/test_codex_quota_retry.ts",
  "docs/operations/codex-quota-retry.md",
  "openspec/changes/codex-subscription-native-retry-adapter/.openspec.yaml",
  "openspec/changes/codex-subscription-native-retry-adapter/proposal.md",
  "openspec/changes/codex-subscription-native-retry-adapter/design.md",
  "openspec/changes/codex-subscription-native-retry-adapter/tasks.md",
  "openspec/changes/codex-subscription-native-retry-adapter/specs/codex-subscription-native-retry-adapter/spec.md",
  "openspec/changes/codex-subscription-native-retry-adapter/reports/cancellation-identity.md",
  "openspec/changes/codex-subscription-native-retry-adapter/reports/native-verification.md",
];
const EXPECTED_OPENSPEC = EXPECTED_SOURCES.filter((path) => path.startsWith("openspec/changes/codex-subscription-native-retry-adapter/")).map((path) => path.slice("openspec/changes/codex-subscription-native-retry-adapter/".length)).sort();

// sha256/bytes and original_snapshot are the frozen NEQ source-retirement
// identity. destination_sha256_at_import and sandbox_current_* describe staged
// and portable Sandbox copies; retirement deliberately does not compare those
// working-copy bytes with the immutable NEQ source.
type Asset = { source: string; original_snapshot: string; sha256: string; bytes: number };
export type Config = { neqRoot: string; sandboxRoot: string; manifestPath: string; globalPaths: string[]; apply: boolean; primaryGate?: string; runId?: string; checkGit?: boolean };

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function under(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertNoSymlinkPath(root: string, path: string): void {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(root, path);
  if (!under(absoluteRoot, absolutePath)) throw new Error(`path escapes root: ${path}`);
  let current = sep;
  const parts = [...absoluteRoot.split(sep).filter(Boolean), ...relative(absoluteRoot, absolutePath).split(sep).filter(Boolean)];
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink refused: ${current}`);
  }
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink refused: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`non-regular entry refused: ${path}`);
    }
  };
  visit(root);
  return found.sort();
}

function gatePass(sandboxRoot: string, gatePath: string | undefined): string[] {
  if (!gatePath) throw new Error("apply requires --primary-gate under Sandbox tmp/codex-quota-retry");
  const absolute = resolve(sandboxRoot, gatePath);
  const allowed = resolve(sandboxRoot, "tmp/codex-quota-retry");
  if (!under(allowed, absolute)) throw new Error("primary gate path must be inside Sandbox tmp/codex-quota-retry");
  const runDir = dirname(absolute);
  const runId = relative(allowed, runDir);
  if (!runId || runId.includes(sep) || /^(archive|archived|historical|imported-neq(?:-|$))/i.test(runId)) {
    throw new Error("primary gate must be in a fresh direct child run directory, not imported or archived evidence");
  }
  assertNoSymlinkPath(sandboxRoot, relative(sandboxRoot, absolute));
  const proof = JSON.parse(readFileSync(absolute, "utf8"));
  if (proof.status !== "PASS" || proof.finalGate !== "orchestrator-task-4.2" || proof.installedLiveProof !== true) {
    throw new Error("primary gate requires native protocol finalGate orchestrator-task-4.2, PASS, and installedLiveProof true");
  }
  if (!Array.isArray(proof.failedAssertions) || proof.failedAssertions.length !== 0) throw new Error("primary gate failedAssertions must be an empty array");
  if (!Array.isArray(proof.missingRequiredEvidence) || proof.missingRequiredEvidence.length !== 0) throw new Error("primary gate missingRequiredEvidence must be an empty array");

  const manifestPath = join(runDir, "manifest.json");
  const processManifestPath = join(runDir, "process-manifest.json");
  assertNoSymlinkPath(sandboxRoot, relative(sandboxRoot, manifestPath));
  assertNoSymlinkPath(sandboxRoot, relative(sandboxRoot, processManifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const processManifest = JSON.parse(readFileSync(processManifestPath, "utf8"));
  if (manifest.schema !== "codex-quota-retry-smoke.v1" || manifest.mode !== "smoke" || manifest.runId !== runId) {
    throw new Error("adjacent primary manifest must identify this fresh smoke run");
  }
  if (manifest.installedLiveProofRequired !== true || manifest.noProvider !== true) {
    throw new Error("adjacent primary manifest must require installed-live proof and no-provider execution");
  }
  if (manifest.runtime?.bun !== "1.3.13" || manifest.runtime?.opencode !== "1.19.0") {
    throw new Error("adjacent primary manifest runtime must be Bun 1.3.13 and OpenCode 1.19.0");
  }
  if (manifest.goalPlugin?.pinnedVersion !== "0.1.60") throw new Error("adjacent primary manifest must pin goal plugin 0.1.60");
  const declaredWorkspace = manifest.paths?.workspace;
  const actualProcesses = processManifest.processes;
  if (typeof declaredWorkspace !== "string" || !Array.isArray(actualProcesses) || actualProcesses.length === 0) {
    throw new Error("primary manifest and process manifest must provide actual workspace evidence");
  }
  const manifestWorkspace = resolve(runDir, declaredWorkspace);
  if (!under(allowed, manifestWorkspace) || !under(runDir, manifestWorkspace)) throw new Error("manifest workspace must be inside this Sandbox run directory");
  assertNoSymlinkPath(sandboxRoot, relative(sandboxRoot, manifestWorkspace));
  if (!existsSync(manifestWorkspace) || !statSync(manifestWorkspace).isDirectory()) throw new Error("manifest workspace must exist as a directory");
  for (const process of actualProcesses) {
    if (typeof process.workspace !== "string" || resolve(process.workspace) !== manifestWorkspace || process.status !== "exited") {
      throw new Error("process manifest actual workspacePath does not match the adjacent manifest under Sandbox");
    }
  }
  return [
    "verdict.status=PASS",
    "verdict.finalGate=orchestrator-task-4.2 (legacy native protocol label; consumed for migration task 2.1)",
    "verdict.installedLiveProof=true",
    "verdict.failedAssertions=[]",
    "verdict.missingRequiredEvidence=[]",
    "manifest.schema/mode/runId=codex-quota-retry-smoke.v1/smoke/adjacent-run-directory",
    "manifest.installedLiveProofRequired=true",
    "manifest.noProvider=true",
    "manifest.runtime.bun=1.3.13",
    "manifest.runtime.opencode=1.19.0",
    "manifest.goalPlugin.pinnedVersion=0.1.60",
    "manifest.paths.workspace matches each exited process-manifest.processes[].workspace under this Sandbox run",
  ];
}

function preflight(config: Config): { assets: Asset[]; destination: string; report: string[] } {
  const manifest = JSON.parse(readFileSync(config.manifestPath, "utf8"));
  const allAssets = manifest.authored_assets as Asset[];
  const bySource = new Map(allAssets.map((asset) => [asset.source, asset]));
  if (allAssets.length !== 11 || EXPECTED_SOURCES.length !== 11 || EXPECTED_SOURCES.some((path) => !bySource.has(path))) throw new Error("migration manifest does not contain the exact 11-path retirement allowlist");
  const assets = EXPECTED_SOURCES.map((path) => bySource.get(path)!);
  if (assets.some((asset) => !asset.sha256 || !asset.original_snapshot)) throw new Error("manifest entry lacks frozen source hash or original snapshot");

  for (const asset of assets) {
    assertNoSymlinkPath(config.neqRoot, asset.source);
    assertNoSymlinkPath(config.sandboxRoot, asset.original_snapshot);
    if (!existsSync(join(config.neqRoot, asset.source))) throw new Error(`source missing: ${asset.source}`);
    if (sha256(join(config.neqRoot, asset.source)) !== asset.sha256) throw new Error(`source hash mismatch: ${asset.source}`);
    if (sha256(join(config.sandboxRoot, asset.original_snapshot)) !== asset.sha256) throw new Error(`original backup hash mismatch: ${asset.source}`);
  }

  const historyRoot = join(config.neqRoot, "openspec/changes/codex-subscription-native-retry-adapter");
  assertNoSymlinkPath(config.neqRoot, "openspec/changes/codex-subscription-native-retry-adapter");
  if (JSON.stringify(listFiles(historyRoot)) !== JSON.stringify(EXPECTED_OPENSPEC)) throw new Error("historical OpenSpec source folder has extra, missing, or non-regular entries");

  if (config.checkGit) {
    const tracked = execFileSync("git", ["ls-files", "--", ...EXPECTED_SOURCES], { cwd: config.neqRoot, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    if (tracked.length) throw new Error(`retirement paths must remain untracked; tracked path found: ${tracked.join(",")}`);
  }

  if (config.globalPaths.length !== 2 || !config.globalPaths[0].endsWith("/plugins/codex-quota-retry.ts") || !config.globalPaths[1].endsWith("/lib/codex-quota-retry.ts")) throw new Error("global path set does not match the two frozen global assets");
  const globalEntries = config.globalPaths.map((path, index) => [path, [...GLOBAL_HASHES.values()][index]] as const);
  for (const [path, expected] of globalEntries) {
    assertNoSymlinkPath("/", path.slice(1));
    if (!existsSync(path) || sha256(path) !== expected) throw new Error(`frozen global hash mismatch: ${path}`);
  }

  const runId = config.runId ?? `retired-source-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("unsafe run id");
  const destination = join(config.sandboxRoot, "tmp/codex-quota-retry", runId);
  assertNoSymlinkPath(config.sandboxRoot, "tmp/codex-quota-retry");
  if (existsSync(destination)) throw new Error(`retirement snapshot collision: ${destination}`);
  return { assets, destination, report: assets.map((asset) => `${asset.source} ${asset.sha256}`) };
}

export function retireSources(config: Config): string[] {
  const gateProof = config.apply ? gatePass(config.sandboxRoot, config.primaryGate) : [];
  const plan = preflight(config);
  if (!config.apply) return [`DRY RUN - no changes`, ...plan.report, `snapshot=${plan.destination}`];

  // Stage and verify every byte-exact backup before deleting any source path.
  mkdirSync(plan.destination, { recursive: false });
  try {
    for (const asset of plan.assets) {
      const backup = join(plan.destination, asset.source);
      assertNoSymlinkPath(config.neqRoot, asset.source);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(join(config.neqRoot, asset.source), backup, constants.COPYFILE_EXCL);
      if (sha256(backup) !== asset.sha256) throw new Error(`backup verification failed: ${asset.source}`);
    }
    for (const asset of plan.assets) {
      const source = join(config.neqRoot, asset.source);
      assertNoSymlinkPath(config.neqRoot, asset.source);
      if (sha256(source) !== asset.sha256) throw new Error(`source changed before retirement: ${asset.source}`);
    }
    for (const [path, expected] of config.globalPaths.map((path, index) => [path, [...GLOBAL_HASHES.values()][index]] as const)) {
      assertNoSymlinkPath("/", path.slice(1));
      if (sha256(path) !== expected) throw new Error(`global changed before retirement: ${path}`);
    }
  } catch (error) {
    // No source has been removed yet. Keep the exact staged snapshot for review.
    throw error;
  }

  const removed: Asset[] = [];
  const removedDirs: string[] = [];
  try {
    for (const asset of plan.assets) {
      const source = join(config.neqRoot, asset.source);
      assertNoSymlinkPath(config.neqRoot, asset.source);
      if (sha256(source) !== asset.sha256) throw new Error(`source changed during retirement: ${asset.source}`);
      unlinkSync(source);
      removed.push(asset);
    }
    for (const relDir of [
      "openspec/changes/codex-subscription-native-retry-adapter/reports",
      "openspec/changes/codex-subscription-native-retry-adapter/specs/codex-subscription-native-retry-adapter",
      "openspec/changes/codex-subscription-native-retry-adapter/specs",
      "openspec/changes/codex-subscription-native-retry-adapter",
      "docs/operations",
      "scripts",
      ".opencode/plugins",
      ".opencode/lib",
      ".opencode",
    ]) {
      const dir = join(config.neqRoot, relDir);
      try { if (readdirSync(dir).length === 0) { rmSync(dir, { recursive: false }); removedDirs.push(relDir); } } catch { /* missing or non-empty: preserve */ }
    }
    const output = [`APPLIED - exact 11-path retirement`, ...plan.report.map((row) => `${row} -> absent; byte-exact backup retained`), `snapshot=${plan.destination}`, `gate_proof_fields=${gateProof.join(";")}`, `empty_owned_directories_removed=${removedDirs.join(",") || "none"}`];
    writeFileSync(join(plan.destination, "retirement-record.txt"), `${output.join("\n")}\n`, { flag: "wx" });
    return output;
  } catch (error) {
    // Roll back only this invocation's removals, never overwrite a concurrent file.
    for (const asset of removed.reverse()) {
      const source = join(config.neqRoot, asset.source);
      if (!existsSync(source)) {
        mkdirSync(dirname(source), { recursive: true });
        copyFileSync(join(plan.destination, asset.source), source, constants.COPYFILE_EXCL);
      }
    }
    for (const relDir of removedDirs.reverse()) mkdirSync(join(config.neqRoot, relDir), { recursive: true });
    throw error;
  }
}

function parseArgs(args: string[]): Config {
  let apply = false;
  let gate: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--primary-gate" || arg === "--run-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--primary-gate") gate = value;
      else runId = value;
      index += 1;
    } else if (arg === "--fixture-root" || arg === "--root") throw new Error("CLI root overrides are not supported");
    else throw new Error(`unknown argument: ${arg}`);
  }
  return {
    neqRoot: NEQ_ROOT,
    sandboxRoot: SANDBOX_ROOT,
    manifestPath: MANIFEST,
    globalPaths: [...GLOBAL_HASHES.keys()],
    apply,
    primaryGate: gate,
    runId,
    checkGit: true,
  };
}

if (import.meta.main) {
  try { console.log(retireSources(parseArgs(process.argv.slice(2))).join("\n")); }
  catch (error) { console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
