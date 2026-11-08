import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, "..");
const repoRoot = resolve(packageRoot, "../../..");
const scratchRoot = join(repoRoot, "tmp");
const sdkSourceRoot = join(packageRoot, "node_modules", "@opencode", "client");
const inventory = JSON.parse(await readFile(join(packageRoot, "sdk-inventory.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function copyInput(sourceRelativePath, targetRoot) {
  const destination = join(targetRoot, ...sourceRelativePath.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(packageRoot, ...sourceRelativePath.split("/")), destination);
}

async function makeFixture() {
  await mkdir(scratchRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(join(scratchRoot, "overseer-relay-build-"));
  const managedRoot = join(fixtureRoot, "managed");
  await mkdir(managedRoot, { recursive: true });

  for (const path of [
    "package.json",
    "bun.lock",
    "sdk-inventory.json",
    "scripts/build.mjs",
    "src/main.mjs",
    "src/core.mjs",
    "src/contract.mjs",
    "src/sdk-adapter.mjs",
    "licenses/opencode-MIT.txt",
  ]) {
    await copyInput(path, managedRoot);
  }

  const sdkPackagePath = join(managedRoot, "node_modules", "@opencode", "client");
  await mkdir(sdkPackagePath, { recursive: true });
  await copyFile(join(sdkSourceRoot, "package.json"), join(sdkPackagePath, "package.json"));
  for (const entry of inventory.files) {
    const sourcePath = join(sdkSourceRoot, ...entry.path.split("/"));
    const destination = join(sdkPackagePath, ...entry.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
  }

  return { fixtureRoot, managedRoot };
}

function runBuild(managedRoot) {
  return spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: managedRoot,
    encoding: "utf8",
  });
}

async function listFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected output symlink: ${relativePath}`);
    if (entry.isDirectory()) result.push(...await listFiles(root, relativePath));
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`Unexpected output type: ${relativePath}`);
  }
  return result.sort();
}

async function cleanup(fixtureRoot) {
  await rm(fixtureRoot, { recursive: true, force: true });
}

test("package and fixed inventory pin the local SDK and Node-only build", async () => {
  const [manifest, lockBytes, lockInventory] = await Promise.all([
    readFile(join(packageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(packageRoot, "bun.lock")),
    readFile(join(packageRoot, "sdk-inventory.json"), "utf8").then(JSON.parse),
  ]);
  const lock = JSON.parse(lockBytes.toString("utf8").replace(/,\s*([}\]])/g, "$1"));
  const buildSource = await readFile(join(packageRoot, "scripts", "build.mjs"), "utf8");

  assert.equal(manifest.dependencies["@opencode/client"], "2.2.6");
  assert.equal(manifest.scripts.build, "node scripts/build.mjs");
  assert.equal(lock.workspaces[""].dependencies["@opencode/client"], "2.2.6");
  assert.equal(lock.packages["@opencode/client"][0], "@opencode/client@2.2.6");
  assert.equal(lock.packages["@opencode/client"].at(-1), lockInventory.package.lockfile.integrity);
  assert.equal(lockInventory.files.length, 18);
  assert.equal(lockInventory.bounds.totalBytes, 106195);
  assert.doesNotMatch(buildSource, /\bBun\b|spawnSync|Bun\.spawn|Bun\.JSONC|fetch\s*\(/);
});

test("Node stager is inert, deterministic, and import smoke exposes SDK functions without calling them", async () => {
  const { fixtureRoot, managedRoot } = await makeFixture();
  try {
    await writeFile(join(managedRoot, "src", "not-allowlisted.mjs"), 'throw new Error("must never be staged or evaluated");\n');
    const firstBuild = runBuild(managedRoot);
    assert.equal(firstBuild.status, 0, `${firstBuild.stdout}\n${firstBuild.stderr}`);
    assert.match(firstBuild.stdout, /18 locked SDK modules \(106195 bytes\)/);

    const distRoot = join(managedRoot, "dist");
    const manifestBytes = await readFile(join(distRoot, "artifact-manifest.json"));
    const artifactManifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(artifactManifest.hashAlgorithm, "SHA-256");
    assert.deepEqual(
      artifactManifest.files.map((entry) => entry.path),
      [...artifactManifest.files.map((entry) => entry.path)].sort(),
    );
    assert.ok(artifactManifest.files.every(({ path }) => !path.startsWith("/") && !path.includes("..")));

    const manifestPaths = new Set(artifactManifest.files.map(({ path }) => path));
    assert.equal(manifestPaths.has("artifact-manifest.json"), false);
    assert.equal(manifestPaths.has("not-allowlisted.mjs"), false);
    assert.equal(manifestPaths.has("sdk-adapter.mjs"), false);
    assert.equal(manifestPaths.has("vendor/promise/service.js"), true);
    for (const entry of artifactManifest.files) {
      const bytes = await readFile(join(distRoot, ...entry.path.split("/")));
      assert.equal(bytes.length, entry.size, `${entry.path} manifest size`);
      assert.equal(digest(bytes), entry.sha256, `${entry.path} manifest hash`);
    }
    for (const entry of inventory.files) {
      const stagedPath = `vendor/${entry.path.slice("dist/".length)}`;
      const stagedBytes = await readFile(join(distRoot, ...stagedPath.split("/")));
      const manifestEntry = artifactManifest.files.find(({ path }) => path === stagedPath);
      assert.ok(manifestEntry, `${stagedPath} appears in the hash manifest`);
      assert.equal(stagedBytes.length, entry.size, `${stagedPath} byte size`);
      assert.equal(digest(stagedBytes), entry.sha256, `${stagedPath} SHA-256`);
      assert.equal(manifestEntry.sha256, entry.sha256, `${stagedPath} manifest hash`);
    }

    for (const [sourcePath, stagedPath] of [
      ["src/core.mjs", "core.mjs"],
      ["src/contract.mjs", "contract.mjs"],
    ]) {
      assert.deepEqual(
        await readFile(join(distRoot, stagedPath)),
        await readFile(join(managedRoot, sourcePath)),
        `${sourcePath} is staged only at its fixed destination`,
      );
    }

    const sourceMain = await readFile(join(managedRoot, "src", "main.mjs"), "utf8");
    const stagedMain = await readFile(join(distRoot, "relay-managed.mjs"), "utf8");
    assert.equal(
      stagedMain,
      sourceMain.replace(
        'import { sdkAdapter } from "./sdk-adapter.mjs";',
        'import * as sdkAdapter from "./vendor/promise/service.js";',
      ),
    );
    assert.ok(stagedMain.includes('from "./vendor/promise/service.js";'));
    assert.equal(stagedMain.includes("@opencode/client/service"), false);

    const stagedSdkPackage = JSON.parse(await readFile(
      join(distRoot, "vendor", "package.json"),
      "utf8",
    ));
    assert.deepEqual(stagedSdkPackage, { type: "module" });
    assert.deepEqual(
      await readFile(join(distRoot, "licenses", "opencode-MIT.txt")),
      await readFile(join(packageRoot, "licenses", "opencode-MIT.txt")),
    );

    const provenance = JSON.parse(await readFile(join(distRoot, "provenance.json"), "utf8"));
    assert.equal(provenance.lockfile.path, "bun.lock");
    assert.equal(provenance.lockfile.normalizedPackageRecord.name, "@opencode/client");
    assert.equal(provenance.lockfile.normalizedPackageRecord.version, "2.2.6");
    assert.equal(provenance.lockfile.normalizedPackageRecord.integrity, inventory.package.lockfile.integrity);
    assert.deepEqual(
      provenance.helperSources.map(({ path }) => path),
      [
        "src/main.mjs",
        "src/core.mjs",
        "src/contract.mjs",
        "src/sdk-adapter.mjs",
      ],
    );
    assert.equal(provenance.helperSources[0].stagedPath, "relay-managed.mjs");
    assert.equal(provenance.helperSources[0].stagedSha256, digest(await readFile(join(distRoot, "relay-managed.mjs"))));
    assert.equal(provenance.helperSources[3].buildInput, true);
    assert.equal(provenance.sdk.modules[0].stagedPath, "vendor/promise/service.js");
    assert.ok(!JSON.stringify(provenance).includes(packageRoot));

    const secondBuild = runBuild(managedRoot);
    assert.equal(secondBuild.status, 0, `${secondBuild.stdout}\n${secondBuild.stderr}`);
    assert.deepEqual(
      await readFile(join(distRoot, "artifact-manifest.json")),
      manifestBytes,
      "file-hash manifest is byte-identical across builds",
    );

    const imported = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      'let fetchCalls = 0; globalThis.fetch = () => { fetchCalls += 1; throw new Error("unexpected fetch"); }; const { runManagedOperation, parseStrictJson } = await import("./dist/relay-managed.mjs"); const Service = await import("./dist/vendor/promise/service.js"); console.log(JSON.stringify({ runManagedOperation: typeof runManagedOperation, parseStrictJson: typeof parseStrictJson, discover: typeof Service.discover, headers: typeof Service.headers, fetchCalls }));',
    ], { cwd: managedRoot, encoding: "utf8" });
    assert.equal(imported.status, 0, `${imported.stdout}\n${imported.stderr}`);
    assert.deepEqual(JSON.parse(imported.stdout.trim()), {
      runManagedOperation: "function",
      parseStrictJson: "function",
      discover: "function",
      headers: "function",
      fetchCalls: 0,
    });

    const expectedFiles = [...manifestPaths, "artifact-manifest.json"].sort();
    assert.deepEqual(await listFiles(distRoot), expectedFiles);
  } finally {
    await cleanup(fixtureRoot);
  }
});

test("tampered SDK content is rejected before SDK module evaluation", async () => {
  const { fixtureRoot, managedRoot } = await makeFixture();
  try {
    const sourcePath = join(managedRoot, "node_modules", "@opencode", "client", "dist", "promise", "service.js");
    const original = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      `import { writeFileSync } from "node:fs"; writeFileSync("sdk-runtime-executed.marker", "unexpected");\n${original}`,
    );
    const result = runBuild(managedRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match its pinned hash/);
    await assert.rejects(lstat(join(managedRoot, "sdk-runtime-executed.marker")), { code: "ENOENT" });
    await assert.rejects(lstat(join(managedRoot, "dist")), { code: "ENOENT" });
  } finally {
    await cleanup(fixtureRoot);
  }
});

test("SDK source symlinks and modified lock inputs fail closed", async () => {
  const symlinkFixture = await makeFixture();
  try {
    const sourcePath = join(symlinkFixture.managedRoot, "node_modules", "@opencode", "client", "dist", "promise", "service.js");
    const externalSource = join(symlinkFixture.fixtureRoot, "outside-sdk-module.js");
    await writeFile(externalSource, "export const outside = true;\n");
    await rm(sourcePath);
    await symlink(externalSource, sourcePath);
    const result = runBuild(symlinkFixture.managedRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Symbolic link input is not allowed/);
  } finally {
    await cleanup(symlinkFixture.fixtureRoot);
  }

  const lockFixture = await makeFixture();
  try {
    const lockPath = join(lockFixture.managedRoot, "bun.lock");
    await writeFile(lockPath, `${await readFile(lockPath, "utf8")}\n`);
    const result = runBuild(lockFixture.managedRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bun\.lock changed/);
  } finally {
    await cleanup(lockFixture.fixtureRoot);
  }
});

test("all scratch fixtures stay under repository-relative tmp", () => {
  assert.equal(relative(repoRoot, scratchRoot), "tmp");
});
