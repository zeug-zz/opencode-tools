import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(packageRoot, "dist");
const sdkRootPath = "node_modules/@opencode/client";
const stagedSdkRoot = "vendor";
const inventoryPath = "sdk-inventory.json";
const inventorySha256 = "6d5f4ce70a4d8319a93901a432fde8e822b60de174370997c49ea2169ad3fd4c";
const helperSources = [
  { source: "src/main.mjs", staged: "relay-managed.mjs", maxBytes: 16000 },
  { source: "src/core.mjs", staged: "core.mjs", maxBytes: 50000 },
  { source: "src/contract.mjs", staged: "contract.mjs", maxBytes: 50000 },
];
const expectedHelperImports = {
  "src/main.mjs": ["node:path", "node:url", "./contract.mjs", "./core.mjs", "./sdk-adapter.mjs"],
  "src/core.mjs": ["./contract.mjs"],
  "src/contract.mjs": [],
};
const expectedSdkPaths = [
  "dist/promise/service.js",
  "dist/promise/index.js",
  "dist/chunks/contract-1r8wv9wh.js",
  "dist/chunks/contract-6r38tsk5.js",
  "dist/chunks/contract-8ye1ye6f.js",
  "dist/chunks/contract-9rqn6x4v.js",
  "dist/chunks/contract-gecjxyvt.js",
  "dist/chunks/contract-mwrzahmf.js",
  "dist/chunks/contract-nwcpakzx.js",
  "dist/chunks/contract-qav6mfdz.js",
  "dist/chunks/contract-sdjh9vmn.js",
  "dist/chunks/contract-sxt88q69.js",
  "dist/chunks/contract-ve4aws36.js",
  "dist/chunks/contract-vxrn9xjg.js",
  "dist/chunks/contract-vyas3vgt.js",
  "dist/chunks/contract-xby11z3y.js",
  "dist/chunks/contract-xgnj2w4v.js",
  "dist/chunks/contract-xqwq6bgr.js",
];
const expectedImports = {
  "dist/promise/service.js": [
    "../chunks/contract-ve4aws36.js",
    "../chunks/contract-xgnj2w4v.js",
    "../chunks/contract-sxt88q69.js",
    "../chunks/contract-8ye1ye6f.js",
    "../chunks/contract-1r8wv9wh.js",
    "../chunks/contract-qav6mfdz.js",
    "node:fs/promises",
  ],
  "dist/promise/index.js": [
    "../chunks/contract-6r38tsk5.js",
    "../chunks/contract-mwrzahmf.js",
    "../chunks/contract-xby11z3y.js",
    "../chunks/contract-vyas3vgt.js",
    "../chunks/contract-xqwq6bgr.js",
    "../chunks/contract-sdjh9vmn.js",
    "../chunks/contract-vxrn9xjg.js",
    "../chunks/contract-nwcpakzx.js",
    "../chunks/contract-gecjxyvt.js",
  ],
  "dist/chunks/contract-1r8wv9wh.js": [
    "./contract-8ye1ye6f.js",
    "./contract-9rqn6x4v.js",
    "node:fs/promises",
    "../promise/index.js",
  ],
  "dist/chunks/contract-6r38tsk5.js": [],
  "dist/chunks/contract-8ye1ye6f.js": [
    "./contract-xgnj2w4v.js",
    "./contract-sxt88q69.js",
    "node:os",
    "node:path",
  ],
  "dist/chunks/contract-9rqn6x4v.js": [],
  "dist/chunks/contract-gecjxyvt.js": ["./contract-9rqn6x4v.js"],
  "dist/chunks/contract-mwrzahmf.js": [],
  "dist/chunks/contract-nwcpakzx.js": [],
  "dist/chunks/contract-qav6mfdz.js": [],
  "dist/chunks/contract-sdjh9vmn.js": [],
  "dist/chunks/contract-sxt88q69.js": [],
  "dist/chunks/contract-ve4aws36.js": ["node:child_process"],
  "dist/chunks/contract-vxrn9xjg.js": [
    "./contract-nwcpakzx.js",
    "./contract-9rqn6x4v.js",
  ],
  "dist/chunks/contract-vyas3vgt.js": [],
  "dist/chunks/contract-xby11z3y.js": [
    "./contract-gecjxyvt.js",
    "./contract-vxrn9xjg.js",
    "./contract-xqwq6bgr.js",
    "./contract-9rqn6x4v.js",
  ],
  "dist/chunks/contract-xgnj2w4v.js": [],
  "dist/chunks/contract-xqwq6bgr.js": ["./contract-sdjh9vmn.js"],
};
const serviceModuleImport = `./${stagedSdkRoot}/promise/service.js`;
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function validateRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("An input path is not a normalized package-relative path");
  }
}

async function readBounded(root, relativePath, maxBytes, confinementRoot = root) {
  validateRelativePath(relativePath);
  const rootReal = await realpath(root);
  const confinementReal = await realpath(confinementRoot);
  let current = root;
  const parts = relativePath.split("/");
  let finalStat;

  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      fail(`Required input is missing or unreadable: ${relativePath} (${error?.code ?? "I/O error"})`);
    }
    if (info.isSymbolicLink()) fail(`Symbolic link input is not allowed: ${relativePath}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      fail(`Input parent is not a directory: ${relativePath}`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      fail(`Input is not a regular file: ${relativePath}`);
    }
    finalStat = info;
  }

  if (finalStat.size > maxBytes) fail(`Input exceeds its size limit: ${relativePath}`);
  const resolvedPath = await realpath(current);
  if (!isWithin(rootReal, resolvedPath) || !isWithin(confinementReal, resolvedPath)) {
    fail(`Input resolves outside its approved package root: ${relativePath}`);
  }

  let handle;
  try {
    handle = await open(current, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.size > maxBytes ||
      openedStat.dev !== finalStat.dev ||
      openedStat.ino !== finalStat.ino
    ) {
      fail(`Input changed while it was being checked: ${relativePath}`);
    }

    const bounded = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterStat = await handle.stat();
    if (offset > maxBytes) fail(`Input exceeds its size limit: ${relativePath}`);
    if (offset !== openedStat.size || afterStat.size !== openedStat.size) {
      fail(`Input changed while it was being read: ${relativePath}`);
    }
    return Buffer.from(bounded.subarray(0, offset));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Input ")) throw error;
    fail(`Unable to safely read input: ${relativePath} (${error?.code ?? "I/O error"})`);
  } finally {
    await handle?.close();
  }
}

async function assertDirectoryPath(root, relativePath) {
  validateRelativePath(relativePath);
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      fail(`Required SDK directory is missing: ${relativePath} (${error?.code ?? "I/O error"})`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`SDK directory is not a regular confined directory: ${relativePath}`);
    }
  }
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      if (index < source.length) output += source[index];
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 1;
          closed = true;
          break;
        }
        if (source[index] === "\n" || source[index] === "\r") output += source[index];
        index += 1;
      }
      if (!closed) fail("Lock input contains an unterminated comment");
      continue;
    }
    output += char;
  }
  if (inString) fail("Lock input contains an unterminated string");
  return output;
}

function stripTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    output += char;
  }
  return output;
}

function parseJsonc(bytes) {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(bytes.toString("utf8"))));
  } catch {
    fail("Lock input is not valid bounded JSONC");
  }
}

function importSpecifiers(source) {
  const found = [];
  const declarations = source.match(/^import\b[^;]*;/gm) ?? [];
  for (const declaration of declarations) {
    const fromClause = /\bfrom\s*(["'])([^"']+)\1/.exec(declaration);
    if (fromClause) {
      found.push(fromClause[2]);
      continue;
    }
    const sideEffect = /^\s*import\s*(["'])([^"']+)\1/.exec(declaration);
    if (!sideEffect) fail("SDK contains an unsupported static import form");
    found.push(sideEffect[2]);
  }

  const dynamicImports = [...source.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g)];
  const allDynamicCalls = [...source.matchAll(/\bimport\s*\(/g)];
  if (dynamicImports.length !== allDynamicCalls.length) {
    fail("SDK contains a non-literal dynamic import");
  }
  for (const match of dynamicImports) found.push(match[2]);
  return found;
}

function checkSdkImports(path, source, inventoryPaths) {
  const specifiers = importSpecifiers(source);
  const expected = expectedImports[path];
  if (!expected || JSON.stringify(specifiers) !== JSON.stringify(expected)) {
    fail(`SDK import graph differs from the fixed inventory: ${path}`);
  }

  const builtinNames = new Set(builtinModules.flatMap((name) => [
    name,
    name.startsWith("node:") ? name.slice(5) : `node:${name}`,
  ]));
  for (const specifier of specifiers) {
    if (specifier.startsWith("node:")) {
      if (!builtinNames.has(specifier)) fail(`SDK imports a non-built-in external module: ${path}`);
      continue;
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      fail(`SDK imports a non-relative external module: ${path}`);
    }
    const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
    if (resolved.startsWith("../") || !inventoryPaths.has(resolved)) {
      fail(`SDK import is unresolved in the fixed inventory: ${path}`);
    }
  }
}

function checkHelperImports(path, source) {
  const expected = expectedHelperImports[path];
  if (!expected || JSON.stringify(importSpecifiers(source)) !== JSON.stringify(expected)) {
    fail(`Helper imports differ from the fixed local module allowlist: ${path}`);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function build() {
  const packageRootInfo = await lstat(packageRoot);
  if (packageRootInfo.isSymbolicLink() || !packageRootInfo.isDirectory()) {
    fail("Managed package root is not a regular directory");
  }
  const packageRealRoot = await realpath(packageRoot);

  const manifestBytes = await readBounded(packageRoot, "package.json", 20000);
  let helperManifest;
  try {
    helperManifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("Managed helper package metadata is invalid");
  }
  if (
    helperManifest.name !== "@opencode-overseer-relay/managed-helper" ||
    helperManifest.version !== "0.2.0" ||
    helperManifest.private !== true ||
    helperManifest.type !== "module" ||
    helperManifest.engines?.node !== ">=18" ||
    helperManifest.dependencies?.["@opencode/client"] !== "2.2.6" ||
    helperManifest.scripts?.build !== "node scripts/build.mjs"
  ) {
    fail("Managed helper package metadata does not match the approved Node build input");
  }

  const inventoryBytes = await readBounded(packageRoot, inventoryPath, 16000);
  if (sha256(inventoryBytes) !== inventorySha256) {
    fail("The fixed SDK inventory has changed without a deliberate build update");
  }
  let inventory;
  try {
    inventory = JSON.parse(inventoryBytes.toString("utf8"));
  } catch {
    fail("The fixed SDK inventory is invalid JSON");
  }
  if (
    inventory.schemaVersion !== 1 ||
    inventory.package?.name !== "@opencode/client" ||
    inventory.package?.version !== "2.2.6" ||
    inventory.package?.sourceRoot !== sdkRootPath ||
    inventory.package?.lockfile?.path !== "bun.lock" ||
    inventory.package?.lockfile?.sha256 !== "91846af05d7cd459a4cdeb0129c9bccf9043c45f646df2a11d536c00dd457c51" ||
    inventory.package?.lockfile?.integrity !== "sha512-o90b8Z6tk62U3MiRK1g6r7WmNWLzHzIHme75/MCWa9/XmOREMzY4W1N01wAuHwU3J6UH/PlUDNKvLkeX5qCyeA==" ||
    inventory.package?.license?.spdx !== "MIT" ||
    inventory.package?.license?.sourcePath !== "licenses/opencode-MIT.txt" ||
    inventory.package?.license?.sha256 !== "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b"
  ) {
    fail("SDK inventory provenance does not match the approved lock and license inputs");
  }
  if (
    inventory.bounds?.fileCount !== expectedSdkPaths.length ||
    inventory.bounds?.maxFileBytes !== 70000 ||
    inventory.bounds?.totalBytes !== 106195 ||
    inventory.bounds?.maxTotalBytes !== 110000 ||
    !Array.isArray(inventory.files) ||
    inventory.files.length !== expectedSdkPaths.length ||
    inventory.files.some((entry, index) => entry.path !== expectedSdkPaths[index])
  ) {
    fail("SDK inventory paths or size bounds differ from the fixed artifact set");
  }

  const lockBytes = await readBounded(packageRoot, "bun.lock", 16000);
  const lockSha256 = sha256(lockBytes);
  if (lockSha256 !== inventory.package.lockfile.sha256) {
    fail("bun.lock changed from the approved project-local lock input");
  }
  const lock = parseJsonc(lockBytes);
  const lockedPackage = lock.packages?.["@opencode/client"];
  if (
    lock.workspaces?.[""]?.name !== helperManifest.name ||
    lock.workspaces?.[""]?.dependencies?.["@opencode/client"] !== "2.2.6" ||
    !Array.isArray(lockedPackage) ||
    lockedPackage[0] !== "@opencode/client@2.2.6" ||
    lockedPackage.at(-1) !== inventory.package.lockfile.integrity ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(lockedPackage.at(-1) ?? "")
  ) {
    fail("bun.lock does not contain the exact approved @opencode/client 2.2.6 integrity record");
  }

  const sdkRoot = join(packageRoot, ...sdkRootPath.split("/"));
  await assertDirectoryPath(packageRoot, sdkRootPath);
  const sdkRealRoot = await realpath(sdkRoot);
  if (!isWithin(packageRealRoot, sdkRealRoot)) {
    fail("Project-local SDK package resolves outside the managed package root");
  }
  const sdkPackageBytes = await readBounded(packageRoot, `${sdkRootPath}/package.json`, 20000, sdkRealRoot);
  if (sha256(sdkPackageBytes) !== inventory.package.metadataSha256) {
    fail("Installed @opencode/client package metadata hash does not match the pinned 2.2.6 package");
  }
  let sdkPackage;
  try {
    sdkPackage = JSON.parse(sdkPackageBytes.toString("utf8"));
  } catch {
    fail("Installed @opencode/client package metadata is invalid");
  }
  if (
    sdkPackage.name !== "@opencode/client" ||
    sdkPackage.version !== "2.2.6" ||
    sdkPackage.type !== "module" ||
    sdkPackage.license !== "MIT" ||
    sdkPackage.exports?.["./service"]?.import !== "./dist/promise/service.js"
  ) {
    fail("Installed @opencode/client package metadata is not the pinned ESM package");
  }

  const sdkLicense = await readBounded(packageRoot, inventory.package.license.sourcePath, 4096);
  if (sha256(sdkLicense) !== inventory.package.license.sha256) {
    fail("The upstream @opencode/client MIT license text has changed");
  }
  const helperModules = new Map();
  let helperTotalBytes = 0;
  for (const entry of helperSources) {
    const bytes = await readBounded(packageRoot, entry.source, entry.maxBytes);
    checkHelperImports(entry.source, bytes.toString("utf8"));
    helperTotalBytes += bytes.length;
    helperModules.set(entry.source, bytes);
  }
  const adapterSource = await readBounded(packageRoot, "src/sdk-adapter.mjs", 8000);
  helperTotalBytes += adapterSource.length;
  if (helperTotalBytes > 100000) fail("Managed helper source modules exceed their fixed total size bound");
  const mainSource = helperModules.get("src/main.mjs");
  const coreSource = helperModules.get("src/core.mjs");
  const contractSource = helperModules.get("src/contract.mjs");
  const adapterText = adapterSource.toString("utf8");
  const expectedAdapterText =
    'import {\n' +
    '  discover as discoverService,\n' +
    '  headers as serviceHeaders,\n' +
    '} from "@opencode/client/service";\n\n' +
    'export const sdkAdapter = Object.freeze({\n' +
    '  discover: discoverService,\n' +
    '  headers: serviceHeaders,\n' +
    '});\n';
  const sourceImport = 'from "@opencode/client/service";';
  if (adapterText !== expectedAdapterText || adapterText.split(sourceImport).length !== 2) {
    fail("SDK adapter is not the approved import-safe stub");
  }
  const adapterImport = 'import { sdkAdapter } from "./sdk-adapter.mjs";';
  const mainText = mainSource.toString("utf8");
  if (mainText.split(adapterImport).length !== 2) fail("Managed helper entry does not contain its fixed SDK adapter import");
  const stagedMainSource = Buffer.from(
    mainText.replace(adapterImport, `import * as sdkAdapter from "${serviceModuleImport}";`),
    "utf8",
  );

  const inventoryPaths = new Set(expectedSdkPaths);
  const sdkModules = [];
  let sdkTotalBytes = 0;
  for (let index = 0; index < inventory.files.length; index += 1) {
    const entry = inventory.files[index];
    validateRelativePath(entry.path);
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > inventory.bounds.maxFileBytes ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      fail(`SDK inventory entry is invalid: ${expectedSdkPaths[index]}`);
    }
    const sourcePath = `${sdkRootPath}/${entry.path}`;
    const bytes = await readBounded(
      packageRoot,
      sourcePath,
      inventory.bounds.maxFileBytes,
      sdkRealRoot,
    );
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      fail(`Installed SDK file does not match its pinned hash: ${entry.path}`);
    }
    const source = bytes.toString("utf8");
    checkSdkImports(entry.path, source, inventoryPaths);
    if (entry.path === "dist/promise/service.js") {
      if (!/\bexport\s*\{[^}]*\bdiscover\b/s.test(source) || !/\bexport\s*\{[^}]*\bheaders\b/s.test(source)) {
        fail("Pinned SDK service entry does not export the approved discovery/header symbols");
      }
    }
    sdkTotalBytes += bytes.length;
    sdkModules.push({ ...entry, bytes });
  }
  if (sdkTotalBytes !== inventory.bounds.totalBytes || sdkTotalBytes > inventory.bounds.maxTotalBytes) {
    fail("SDK files exceed or differ from the fixed total byte bounds");
  }

  const files = new Map();
  const addOutput = (path, bytes) => {
    validateRelativePath(path);
    if (files.has(path)) fail(`Duplicate staged output path: ${path}`);
    files.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8"));
  };
  addOutput("relay-managed.mjs", stagedMainSource);
  addOutput("core.mjs", coreSource);
  addOutput("contract.mjs", contractSource);
  addOutput(
    `${stagedSdkRoot}/package.json`,
    '{\n  "type": "module"\n}\n',
  );
  for (const module of sdkModules) {
    addOutput(`${stagedSdkRoot}/${module.path.slice("dist/".length)}`, module.bytes);
  }
  addOutput("licenses/opencode-MIT.txt", sdkLicense);

  const licenseHash = sha256(sdkLicense);
  const notice =
    "# Third-party notices\n\n" +
    "This bounded ESM artifact set includes the unmodified `@opencode/client` package modules listed in `artifact-manifest.json`.\n\n" +
    "## @opencode/client@2.2.6\n\n" +
    "- License: MIT\n" +
    "- Registry tarball: https://registry.npmjs.org/@opencode/client/-/client-2.2.6.tgz\n" +
    `- SHA-512 integrity recorded in \`bun.lock\`: ${inventory.package.lockfile.integrity}\n` +
    `- Lock input SHA-256: ${lockSha256}\n` +
    "- Source repository: https://github.com/anomalyco/opencode (packages/client)\n" +
    `- Exact license text: \`licenses/opencode-MIT.txt\` (SHA-256 ${licenseHash})\n`;
  addOutput("THIRD_PARTY_NOTICES.md", notice);

  const provenance = {
    schemaVersion: 1,
    build: {
      command: "node scripts/build.mjs",
      implementation: "Node.js standard library",
      target: "node",
      format: "esm",
      runtime: "Node.js >=18",
    },
    lockfile: {
      path: "bun.lock",
      sha256: lockSha256,
      normalizedPackageRecord: {
        name: "@opencode/client",
        version: "2.2.6",
        integrity: inventory.package.lockfile.integrity,
      },
    },
    inventory: {
      path: inventoryPath,
      sha256: sha256(inventoryBytes),
    },
    helperSources: [
      {
        path: "src/main.mjs",
        stagedPath: "relay-managed.mjs",
        sourceSha256: sha256(mainSource),
        stagedSha256: sha256(stagedMainSource),
      },
      { path: "src/core.mjs", stagedPath: "core.mjs", sha256: sha256(coreSource) },
      { path: "src/contract.mjs", stagedPath: "contract.mjs", sha256: sha256(contractSource) },
      {
        path: "src/sdk-adapter.mjs",
        buildInput: true,
        sourceSha256: sha256(adapterSource),
      },
    ],
    sdk: {
      name: "@opencode/client",
      version: "2.2.6",
      sourceRoot: sdkRootPath,
      stagedRoot: stagedSdkRoot,
      packageMetadataSha256: sha256(sdkPackageBytes),
      tarballIntegrity: inventory.package.lockfile.integrity,
      license: {
        spdx: "MIT",
        path: "licenses/opencode-MIT.txt",
        sha256: licenseHash,
        upstreamPath: "packages/client/LICENSE",
      },
      modules: sdkModules.map(({ path, size, sha256: digest }) => ({
        sourcePath: `${sdkRootPath}/${path}`,
        stagedPath: `${stagedSdkRoot}/${path.slice("dist/".length)}`,
        size,
        sha256: digest,
      })),
    },
  };
  addOutput("provenance.json", jsonBytes(provenance));

  const outputPaths = [...files.keys()].sort(compare);
  const totalOutputBytes = outputPaths.reduce((sum, path) => sum + files.get(path).length, 0);
  if (outputPaths.length > 32 || totalOutputBytes > 200000) {
    fail("Staged helper artifact set exceeds its output bounds");
  }
  const artifactManifest = {
    schemaVersion: 1,
    hashAlgorithm: "SHA-256",
    files: outputPaths.map((path) => ({
      path,
      size: files.get(path).length,
      sha256: sha256(files.get(path)),
    })),
  };
  addOutput("artifact-manifest.json", jsonBytes(artifactManifest));

  try {
    const existing = await lstat(distRoot);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      fail("Existing dist output is not a regular directory");
    }
    await rm(distRoot, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(distRoot, { recursive: true });
  for (const path of [...files.keys()].sort(compare)) {
    const outputPath = join(distRoot, ...path.split("/"));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, files.get(path));
  }

  console.log(
    `Built ${sdkModules.length} locked SDK modules (${sdkTotalBytes} bytes) and ${helperSources.length} fixed helper modules (${helperTotalBytes} bytes); ` +
    `artifact manifest SHA-256 ${sha256(jsonBytes(artifactManifest))}`,
  );
}

try {
  await build();
} catch (error) {
  console.error(`Build failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
