import { parseStrictJson, qualifyOpenApi } from "./contract.mjs";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OPENAPI_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30000;
const BATCH_ID = /^b-[a-f0-9]{64}$/;
const CAMPAIGN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SESSION_ID = /^ses[A-Za-z0-9._-]{1,124}$/;
const SAFE_VERSION = /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:[-+][A-Za-z0-9.-]{1,32})?$/;

class ManagedFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new ManagedFailure(code); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed, required = []) {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
function wellFormed(value) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function text(value, maximum, allowControls = false) {
  return wellFormed(value) && Buffer.byteLength(value, "utf8") <= maximum &&
    (allowControls || !/[\u0000-\u001f\u007f]/.test(value));
}
function validId(value, pattern, maximum) { return text(value, maximum) && pattern.test(value); }
function loopbackOrigin(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(https?):\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/?)$/.exec(value);
  if (!match || Number(match[3]) > 65535) return undefined;
  return `${match[1]}://${match[2]}:${match[3]}`;
}

function loopbackUrl(value) {
  const origin = loopbackOrigin(value);
  return origin === value ? value : undefined;
}

function posixDirectory(value) {
  if (!text(value, 4096) || !value.startsWith("/")) return false;
  if (value === "/") return true;
  return value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function safeSessionDirectory(directory, subpath) {
  if (!posixDirectory(directory)) fail("response_invalid");
  if (subpath === undefined) return directory;
  if (!text(subpath, 4096) || subpath.startsWith("/") || subpath.includes("\\")) fail("response_invalid");
  const parts = subpath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail("response_invalid");
  const actual = directory === "/" ? `/${parts.join("/")}` : `${directory}/${parts.join("/")}`;
  const confined = directory === "/" ? actual.startsWith("/") : actual.startsWith(`${directory}/`);
  if (!posixDirectory(actual) || !confined) fail("response_invalid");
  return actual;
}

function validateInput(value) {
  if (!record(value) || value.schema_version !== 1 || !["session", "inbox", "messages", "prompt", "resume_goal"].includes(value.operation)) fail("input_invalid");
  const extras = value.operation === "messages" ? ["cursor"] : value.operation === "prompt" ? ["data"] : [];
  if (!keys(value, ["schema_version", "operation", "connection", "binding", "campaign", "timeout_ms", ...extras],
    ["schema_version", "operation", "connection", "binding", "campaign"])) fail("input_invalid");
  const hasExpectedPid = record(value.connection) && Object.hasOwn(value.connection, "expected_pid");
  if (!keys(value.connection, ["mode", "expected_url", "expected_pid"], ["mode", "expected_url"]) ||
      value.connection.mode !== "managed-local" || !loopbackUrl(value.connection.expected_url) ||
      (hasExpectedPid && (!Number.isSafeInteger(value.connection.expected_pid) ||
        value.connection.expected_pid < 1 || value.connection.expected_pid > 2147483647))) fail("input_invalid");
  if (!keys(value.binding, ["session_id", "directory", "agent"], ["session_id", "directory", "agent"]) ||
      !validId(value.binding.session_id, SESSION_ID, 128) || !posixDirectory(value.binding.directory) ||
      !validId(value.binding.agent, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 128) ||
      !validId(value.campaign, CAMPAIGN_ID, 64)) fail("input_invalid");
  if (value.timeout_ms !== undefined && (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < MIN_TIMEOUT_MS || value.timeout_ms > MAX_TIMEOUT_MS)) fail("input_invalid");

  let opData = {};
  if (value.operation === "messages") {
    const cursor = Object.hasOwn(value, "cursor") ? value.cursor : null;
    if (cursor !== null && (!text(cursor, 2048) || !cursor)) fail("input_invalid");
    opData = { cursor };
  } else if (value.operation === "prompt") {
    if (!keys(value.data, ["text", "batch_id"], ["text", "batch_id"]) ||
        !text(value.data.text, MAX_PROMPT_BYTES, true) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.data.text) ||
        !validId(value.data.batch_id, BATCH_ID, 66)) fail("input_invalid");
    opData = { text: value.data.text, batchId: value.data.batch_id };
  }
  return {
    operation: value.operation,
    expectedUrl: value.connection.expected_url,
    expectedPid: hasExpectedPid ? value.connection.expected_pid : undefined,
    binding: { sessionId: value.binding.session_id, directory: value.binding.directory, agent: value.binding.agent },
    campaign: value.campaign,
    timeoutMs: value.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    opData,
  };
}

function remaining(deadline) {
  const value = deadline - Date.now();
  if (value <= 0) fail("timeout");
  return Math.max(1, value);
}
async function beforeDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ManagedFailure("timeout")), remaining(deadline));
    })]);
  } finally { clearTimeout(timer); }
}
function failureCode(error, deadline, fallback) {
  if (error instanceof ManagedFailure) return error.code;
  return Date.now() >= deadline ? "timeout" : fallback;
}

async function readJson(response, maximum, deadline, invalidCode) {
  const contentType = response.headers?.get?.("content-type");
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) fail(invalidCode);
  const length = response.headers?.get?.("content-length");
  if (length !== null && length !== undefined) {
    if (!/^\d+$/.test(length)) fail(invalidCode);
    if (Number(length) > maximum) fail("response_too_large");
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail(invalidCode);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await beforeDeadline(reader.read(), deadline);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail(invalidCode);
      size += part.value.byteLength;
      if (size > maximum) { void reader.cancel().catch(() => {}); fail("response_too_large"); }
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    if (error instanceof ManagedFailure) throw error;
    if (Date.now() >= deadline) fail("timeout");
    fail(invalidCode);
  }
  try { return parseStrictJson(Buffer.concat(chunks, size), { maxBytes: maximum, maxDepth: 96 }); }
  catch { fail(invalidCode); }
}

function discardBody(response) {
  try {
    const canceled = response?.body?.cancel?.();
    if (canceled && typeof canceled.catch === "function") void canceled.catch(() => {});
  } catch { /* A discarded response body must never affect the bounded result. */ }
}

async function fetchJson(fetcher, endpoint, headers, route, method, body, deadline, maximum, invalidCode, state, { successStatus = 200, noContent = false } = {}) {
  const url = new URL(route, `${endpoint}/`);
  if (url.origin !== new URL(endpoint).origin || url.username || url.password || url.hash) fail("identity_mismatch");
  const requestHeaders = new Headers(headers);
  requestHeaders.set("accept", "application/json");
  const options = { method, headers: requestHeaders, redirect: "manual", signal: AbortSignal.timeout(remaining(deadline)) };
  if (method === "POST") {
    options.headers.set("content-type", "application/json");
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    if (method === "POST") state.postStarted = true;
    response = await beforeDeadline(fetcher(url.href, options), deadline);
  }
  catch (error) { fail(failureCode(error, deadline, method === "POST" ? "post_failed" : "request_failed")); }
  if (noContent) discardBody(response);
  const status = response?.status;
  if (response?.redirected === true || (status >= 300 && status < 400) || response?.type === "opaqueredirect") fail("redirect_blocked");
  if (noContent ? status !== successStatus : status !== successStatus || response?.ok !== true) {
    fail(method === "POST" ? "post_failed" : "request_failed");
  }
  if (typeof response.url === "string" && response.url) {
    try { if (new URL(response.url).href !== url.href) fail("redirect_blocked"); }
    catch (error) { if (error instanceof ManagedFailure) throw error; fail("response_invalid"); }
  }
  if (noContent) return undefined;
  return readJson(response, maximum, deadline, invalidCode);
}

function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }

function serverVersion(info, expectedUrl, expectedPid) {
  if (!record(info) || !text(info.version, 64) || !SAFE_VERSION.test(info.version) ||
      !Number.isSafeInteger(info.pid) || info.pid < 1 ||
      (expectedPid !== undefined && info.pid !== expectedPid) ||
      !Array.isArray(info.urls) || info.urls.length === 0 || info.urls.length > 16 ||
       !info.urls.every((url) => text(url, 4096)) ||
       !info.urls.some((url) => loopbackOrigin(url) === expectedUrl) ||
      !record(info.paths) || !text(info.paths.tmp, 4096) || !info.paths.tmp) fail("identity_mismatch");
  return info.version;
}

function sessionProjection(response, binding) {
  const session = response?.data;
  const timeInfo = session?.time;
  if (!record(response) || !record(session) || !text(session.id, 128) || !text(session.agent, 128) ||
      !record(session.location) || !record(timeInfo) ||
      !timestamp(timeInfo.created) || !timestamp(timeInfo.updated) || timeInfo.created > timeInfo.updated) fail("response_invalid");
  if (Object.hasOwn(timeInfo, "archived")) {
    if (!timestamp(timeInfo.archived)) fail("response_invalid");
    if (timeInfo.archived > 0) fail("session_binding_mismatch");
  }
  const hasSubpath = Object.hasOwn(session, "subpath");
  const effectiveDirectory = safeSessionDirectory(session.location.directory, hasSubpath ? session.subpath : undefined);
  if (session.id !== binding.sessionId || session.agent !== binding.agent || effectiveDirectory !== binding.directory) fail("session_binding_mismatch");
  const time = { created: timeInfo.created, updated: timeInfo.updated };
  if (Object.hasOwn(timeInfo, "archived")) time.archived = timeInfo.archived;
  const data = {
    id: session.id,
    agent: session.agent,
    location: { directory: session.location.directory },
    time,
  };
  if (hasSubpath) data.subpath = session.subpath;
  return { data };
}

function metadataProjection(value, { exact = false, campaign, batchId } = {}) {
  if (!record(value)) fail("response_invalid");
  if (exact) {
    const relay = value.overseerRelay;
    if (!record(relay) || relay.campaign !== campaign || relay.batchId !== batchId) fail("response_invalid");
    return { overseerRelay: { campaign, batchId } };
  }
  if (!Object.hasOwn(value, "overseerRelay")) return {};
  const relay = value.overseerRelay;
  if (!record(relay) || !validId(relay.campaign, CAMPAIGN_ID, 64) || !validId(relay.batchId, BATCH_ID, 66)) fail("response_invalid");
  return { overseerRelay: { campaign: relay.campaign, batchId: relay.batchId } };
}

function inboxProjection(response, binding) {
  if (!record(response) || !Array.isArray(response.data) || response.data.length > 256) fail("response_invalid");
  const data = [];
  for (const item of response.data) {
    if (!record(item) || typeof item.type !== "string") fail("response_invalid");
    if (["synthetic", "move", "compaction"].includes(item.type)) continue;
    if (item.type !== "user" || !validId(item.id, /^msg_[A-Za-z0-9_-]{1,124}$/, 128) ||
        item.sessionID !== binding.sessionId || !record(item.time) || !timestamp(item.time.created) ||
        !record(item.payload) || typeof item.payload.text !== "string" || !["queue", "steer"].includes(item.delivery)) fail("response_invalid");
    data.push({
      id: item.id,
      sessionID: binding.sessionId,
      type: "user",
      time: { created: item.time.created },
      delivery: item.delivery,
      payload: { text: "", metadata: metadataProjection(item.payload.metadata === undefined ? {} : item.payload.metadata) },
    });
  }
  return { data };
}

function messagesProjection(response, binding) {
  if (!record(response) || !Array.isArray(response.data) || response.data.length > 100 || !record(response.cursor)) fail("response_invalid");
  const data = response.data.map((item) => {
    if (!record(item) || item.type !== "user" || !validId(item.id, /^msg_[A-Za-z0-9_-]{1,124}$/, 128) ||
        !record(item.time) || !timestamp(item.time.created) || typeof item.text !== "string") fail("response_invalid");
    return {
      id: item.id,
      sessionID: binding.sessionId,
      type: "user",
      time: { created: item.time.created },
      text: "",
      metadata: metadataProjection(item.metadata === undefined ? {} : item.metadata),
    };
  });
  const cursor = (value) => {
    if (value === undefined || value === null) return null;
    if (!text(value, 2048) || !value) fail("response_invalid");
    return value;
  };
  return { data, cursor: { previous: cursor(response.cursor.previous), next: cursor(response.cursor.next) } };
}

function promptProjection(response, binding, campaign, batchId, sentText) {
  const receipt = response?.data;
  if (!record(response) || !record(receipt) || !validId(receipt.id, /^msg_[A-Za-z0-9_-]{1,124}$/, 128) ||
      receipt.sessionID !== binding.sessionId || receipt.type !== "user" || receipt.delivery !== "queue" ||
      !record(receipt.time) || !timestamp(receipt.time.created) || !record(receipt.payload) || receipt.payload.text !== sentText) fail("response_invalid");
  const metadata = metadataProjection(receipt.payload.metadata, { exact: true, campaign, batchId });
  return { data: {
    id: receipt.id,
    sessionID: binding.sessionId,
    type: "user",
    time: { created: receipt.time.created },
    delivery: "queue",
    payload: { metadata },
  } };
}

function operationRoute(operation, sessionId, opData) {
  const id = encodeURIComponent(sessionId);
  if (operation === "session") return `/api/session/${id}`;
  if (operation === "inbox") return `/api/session/${id}/inbox`;
  if (operation === "resume_goal") return `/api/session/${id}/command`;
  if (operation === "prompt") return `/api/session/${id}/prompt`;
  const query = new URLSearchParams({ type: "user", limit: "100" });
  if (opData.cursor === null) query.set("order", "desc");
  else query.set("cursor", opData.cursor);
  return `/api/session/${id}/message?${query.toString()}`;
}

function success(data, hostVersion) {
  const result = { ok: true, data, host_version: hostVersion };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OUTPUT_BYTES) fail("output_too_large");
  return result;
}

export async function runManagedOperation(value, dependencies = {}) {
  let postStarted = false;
  let deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  try {
    const input = validateInput(value);
    deadline = Date.now() + input.timeoutMs;
    const sdk = dependencies.sdk;
    const fetcher = dependencies.fetch ?? globalThis.fetch;
    if (!record(sdk) || typeof sdk.discover !== "function" || typeof sdk.headers !== "function" || typeof fetcher !== "function") fail("service_missing");

    let endpoint;
    try { endpoint = await beforeDeadline(Promise.resolve().then(() => sdk.discover()), deadline); }
    catch (error) { fail(failureCode(error, deadline, "service_missing")); }
    if (!record(endpoint) || typeof endpoint.url !== "string") fail("service_missing");
    if (loopbackOrigin(endpoint.url) !== input.expectedUrl) fail("identity_mismatch");

    let headers;
    try { headers = new Headers(sdk.headers(endpoint) ?? undefined); }
    catch { fail("service_missing"); }
    const state = { get postStarted() { return postStarted; }, set postStarted(value) { postStarted = value; } };
    const info = await fetchJson(fetcher, input.expectedUrl, headers, "/api/info", "GET", undefined,
      deadline, MAX_RESPONSE_BYTES, "response_invalid", state);
    const hostVersion = serverVersion(info, input.expectedUrl, input.expectedPid);

    let openapi;
    try {
      openapi = await fetchJson(fetcher, input.expectedUrl, headers, "/openapi.json", "GET", undefined,
        deadline, MAX_OPENAPI_BYTES, "contract_invalid", state);
    } catch (error) {
      if (error instanceof ManagedFailure && ["timeout", "response_too_large", "redirect_blocked"].includes(error.code)) throw error;
      fail("contract_invalid");
    }
    if (!qualifyOpenApi(openapi, input.operation === "resume_goal")) fail("contract_invalid");

    const sessionResponse = await fetchJson(fetcher, input.expectedUrl, headers,
      `/api/session/${encodeURIComponent(input.binding.sessionId)}`, "GET", undefined,
      deadline, MAX_RESPONSE_BYTES, "response_invalid", state);
    const session = sessionProjection(sessionResponse, input.binding);
    if (input.operation === "session") return success(session, hostVersion);

    const route = operationRoute(input.operation, input.binding.sessionId, input.opData);
    if (input.operation === "inbox") {
      const response = await fetchJson(fetcher, input.expectedUrl, headers, route, "GET", undefined,
        deadline, MAX_RESPONSE_BYTES, "response_invalid", state);
      return success(inboxProjection(response, input.binding), hostVersion);
    }
    if (input.operation === "messages") {
      const response = await fetchJson(fetcher, input.expectedUrl, headers, route, "GET", undefined,
        deadline, MAX_RESPONSE_BYTES, "response_invalid", state);
      return success(messagesProjection(response, input.binding), hostVersion);
    }

    if (input.operation === "resume_goal") {
      await fetchJson(fetcher, input.expectedUrl, headers, route, "POST",
        { name: "resume_goal", text: "", delivery: "queue" }, deadline,
        MAX_RESPONSE_BYTES, "response_invalid", state, { successStatus: 204, noContent: true });
      return success({ delivered: true }, hostVersion);
    }

    const batchId = input.opData.batchId;
    const metadata = { overseerRelay: { campaign: input.campaign, batchId } };
    const body = { text: input.opData.text, delivery: "queue", resume: true, metadata };
    const response = await fetchJson(fetcher, input.expectedUrl, headers, route, "POST", body,
      deadline, MAX_RESPONSE_BYTES, "response_invalid", state);
    return success(promptProjection(response, input.binding, input.campaign, batchId, input.opData.text), hostVersion);
  } catch (error) {
    const code = error instanceof ManagedFailure ? error.code : postStarted ? "post_failed" : "operation_failed";
    return { ok: false, code, post_started: postStarted };
  }
}

export const managedLimits = Object.freeze({
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxOpenApiBytes: MAX_OPENAPI_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxPromptBytes: MAX_PROMPT_BYTES,
});
