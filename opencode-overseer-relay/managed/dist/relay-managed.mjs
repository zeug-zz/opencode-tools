import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictJson } from "./contract.mjs";
import { runManagedOperation } from "./core.mjs";
import * as sdkAdapter from "./vendor/promise/service.js";

export { parseStrictJson, runManagedOperation };

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 30000;

function staticFailure(code, postStarted = false) {
  return { ok: false, code, post_started: postStarted };
}

async function readStdin() {
  let size = 0;
  const chunks = [];
  let timer;
  const read = (async () => {
    for await (const chunk of process.stdin) {
      size += chunk.byteLength;
      if (size > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        throw new Error("input_too_large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  })();
  try {
    return await Promise.race([
      read,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          process.stdin.destroy();
          reject(new Error("timeout"));
        }, STDIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isMainModule(moduleUrl = import.meta.url, argvPath = process.argv[1]) {
  if (typeof argvPath !== "string" || argvPath.length === 0) return false;
  try {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

export async function runCli() {
  let result;
  try {
    const inputBytes = await readStdin();
    const input = parseStrictJson(inputBytes, { maxBytes: MAX_STDIN_BYTES, maxDepth: 32 });
    result = await runManagedOperation(input, { sdk: sdkAdapter });
  } catch (error) {
    const code = ["timeout", "input_too_large"].includes(error?.message) ? error.message : "input_invalid";
    result = staticFailure(code);
  }
  let output;
  try {
    output = JSON.stringify(result);
  } catch {
    output = JSON.stringify(staticFailure("operation_failed"));
  }
  if (Buffer.byteLength(output, "utf8") > MAX_STDOUT_BYTES) {
    output = JSON.stringify(staticFailure("output_too_large", result?.post_started === true));
  }
  process.stdout.write(`${output}\n`);
  process.exitCode = result?.ok === true ? 0 : 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runCli();
}
