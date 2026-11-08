import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { managedLimits, runManagedOperation } from "../src/core.mjs";

const testRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testRoot, "..");
const fixtureRoot = resolve(testRoot, "fixtures");
const pythonFixtureRoot = resolve(packageRoot, "../tests/fixtures/transport");
const BASE_URL = "http://127.0.0.1:17777";
const HTTPS_URL = "https://127.0.0.1:17777";
const SESSION_ID = "ses_overseer123";
const DIRECTORY = "/workspace";
const CAMPAIGN = "campaign-fixture";
const BATCH_ID = `b-${"0".repeat(64)}`;
const HEADER_CANARY = "dummy-header-canary-not-a-credential";
const PROMPT_CANARY = "dummy prompt body canary";
const RAW_ERROR_CANARY = "dummy raw error canary";

const [openapi, openapi23Overlay, brokenOverlay, commandBrokenOverlay, inboxFixture, messagesFixture] = await Promise.all([
  readFile(resolve(fixtureRoot, "contract-2.2.7.json"), "utf8").then(JSON.parse),
  readFile(resolve(fixtureRoot, "contract-2.3-additions.json"), "utf8").then(JSON.parse),
  readFile(resolve(fixtureRoot, "contract-broken-same-version.json"), "utf8").then(JSON.parse),
  readFile(resolve(fixtureRoot, "contract-command-broken.json"), "utf8").then(JSON.parse),
  readFile(resolve(pythonFixtureRoot, "inbox-pending.json"), "utf8").then(JSON.parse),
  readFile(resolve(pythonFixtureRoot, "messages-page.json"), "utf8").then(JSON.parse),
]);

function input(operation = "session", extra = {}) {
  return {
    schema_version: 1,
    operation,
    connection: { mode: "managed-local", expected_url: BASE_URL, expected_pid: 12345 },
    binding: { session_id: SESSION_ID, directory: DIRECTORY, agent: "build" },
    campaign: CAMPAIGN,
    timeout_ms: 2000,
    ...extra,
  };
}

function sessionResponse(overrides = {}) {
  return { data: {
    id: SESSION_ID,
    agent: "build",
    location: { directory: DIRECTORY },
    time: { created: 1762550000000, updated: 1762550001000 },
    title: "must not be projected",
    ...overrides,
  } };
}

function infoResponse(version = "2.2.7", overrides = {}) {
  return { version, pid: 12345, urls: [BASE_URL], paths: { tmp: "/var/empty" }, ...overrides };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function openapiFor23() {
  const document = structuredClone(openapi);
  const schemas = document.components.schemas;
  Object.assign(schemas.ServerInfo.properties, openapi23Overlay.optional_schema_additions.server_info);
  Object.assign(schemas["Session.Info"].properties, openapi23Overlay.optional_schema_additions.session_info);
  Object.assign(
    document.paths["/api/session/{sessionID}/prompt"].post.requestBody.content["application/json"].schema.properties,
    openapi23Overlay.optional_schema_additions.prompt_request,
  );
  return document;
}

function openapiBrokenAtSameVersion() {
  const document = structuredClone(openapi);
  const schema = document.paths["/api/session/{sessionID}/prompt"].post.requestBody.content["application/json"].schema;
  schema.properties[brokenOverlay.required_prompt_field.name] = brokenOverlay.required_prompt_field.schema;
  schema.required.push(brokenOverlay.required_prompt_field.name);
  return document;
}

function openapiBrokenResume(variant) {
  const document = structuredClone(openapi);
  const commandPath = commandBrokenOverlay.missing_route;
  if (variant === "missing_route") {
    delete document.paths[commandPath];
  } else if (variant === "missing_204") {
    delete document.paths[commandPath].post.responses[commandBrokenOverlay.missing_success_status];
  } else if (variant === "extra_required") {
    const body = document.paths[commandPath].post.requestBody.content["application/json"].schema;
    body.properties[commandBrokenOverlay.extra_required_field.name] = commandBrokenOverlay.extra_required_field.schema;
    body.required.push(commandBrokenOverlay.extra_required_field.name);
  } else if (variant === "missing_session_id") {
    document.paths[commandPath].post.parameters = [];
  } else if (variant === "queue_unsupported") {
    document.components.schemas["Session.Inbox.Delivery"].enum = ["steer"];
  }
  return document;
}

function harness(options = {}) {
  const calls = [];
  let discoveryCalls = 0;
  let headersCalls = 0;
  let lifecycleCalls = 0;
  const endpoint = options.endpoint === undefined
    ? { url: BASE_URL, auth: { type: "basic", username: "opencode", password: HEADER_CANARY } }
    : options.endpoint;
  const sdk = {
    async discover() {
      discoveryCalls += 1;
      if (options.discoverError) throw new Error(options.discoverError);
      return endpoint;
    },
    headers() { headersCalls += 1; return { authorization: `Bearer ${HEADER_CANARY}` }; },
    async ensure() { lifecycleCalls += 1; throw new Error("lifecycle forbidden"); },
    async stop() { lifecycleCalls += 1; throw new Error("lifecycle forbidden"); },
  };
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    const call = {
      url: parsed.href,
      path: parsed.pathname,
      query: parsed.searchParams,
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
    };
    calls.push(call);
    if (options.fetchOverride) return options.fetchOverride(call, calls.length);
    if (parsed.pathname === "/api/info") return jsonResponse(options.info ?? infoResponse(options.hostVersion ?? "2.2.7", options.infoOverrides));
    if (parsed.pathname === "/openapi.json") return jsonResponse(options.contract ?? openapi);
    if (parsed.pathname === `/api/session/${SESSION_ID}`) return jsonResponse(options.session ?? sessionResponse());
    if (parsed.pathname.endsWith("/inbox")) return jsonResponse(options.inbox ?? inboxFixture);
    if (parsed.pathname.endsWith("/message")) return jsonResponse(options.messages ?? messagesFixture);
    if (parsed.pathname.endsWith("/command")) {
      if (options.commandError) throw new Error(options.commandError);
      return options.commandResponse ?? new Response(null, { status: 204 });
    }
    if (parsed.pathname.endsWith("/prompt")) {
      const requestBody = JSON.parse(call.body);
      if (options.postError) throw new Error(options.postError);
      if (options.promptResponse) return jsonResponse(options.promptResponse);
      return jsonResponse({ data: {
        id: "msg_receipt1",
        sessionID: SESSION_ID,
        type: "user",
        time: { created: 1762550002000 },
        delivery: "queue",
        payload: {
          text: requestBody.text,
          metadata: { ...requestBody.metadata, additive: "nested metadata canary" },
          error: RAW_ERROR_CANARY,
        },
      } });
    }
    return jsonResponse({ error: RAW_ERROR_CANARY }, 404);
  };
  return {
    calls, sdk, fetch,
    get discoveryCalls() { return discoveryCalls; },
    get headersCalls() { return headersCalls; },
    get lifecycleCalls() { return lifecycleCalls; },
  };
}

async function run(value, setup = {}) {
  const fake = harness(setup);
  const result = await runManagedOperation(value, { sdk: fake.sdk, fetch: fake.fetch });
  return { result, fake };
}

function assertNoSensitiveOutput(result, ...values) {
  const encoded = JSON.stringify(result);
  for (const value of values) assert.equal(encoded.includes(value), false, `output leaked ${value}`);
  assert.equal(encoded.includes("authorization"), false);
  assert.equal(encoded.includes("password"), false);
}

test("session operation uses unwrapped ServerInfo, checks binding, and projects the public data wrapper", async () => {
  const { result, fake } = await run(input("session"), { hostVersion: "2.2.7" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.host_version, "2.2.7");
  assert.deepEqual(result.data, { data: {
    id: SESSION_ID,
    agent: "build",
    location: { directory: DIRECTORY },
    time: { created: 1762550000000, updated: 1762550001000 },
  } });
  assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info", "/openapi.json", `/api/session/${SESSION_ID}`]);
  assert.ok(fake.calls.every((call) => call.redirect === "manual"));
  assert.ok(fake.calls.every((call) => call.headers.get("authorization") === `Bearer ${HEADER_CANARY}`));
  assert.equal(fake.discoveryCalls, 1);
  assert.equal(fake.headersCalls, 1);
  assert.equal(fake.lifecycleCalls, 0);
  assertNoSensitiveOutput(result, HEADER_CANARY, "must not be projected");
});

test("resume_goal posts the fixed native command after worker preflight and returns delivery only", async () => {
  let bodyCanceled = false;
  let bodyRead = false;
  const commandResponse = {
    status: 204,
    ok: true,
    url: `${BASE_URL}/api/session/${SESSION_ID}/command`,
    redirected: false,
    headers: new Headers({ "content-type": "text/plain" }),
    body: {
      cancel() { bodyCanceled = true; return Promise.resolve(); },
      getReader() { bodyRead = true; throw new Error("204 body must not be parsed"); },
    },
  };
  const { result, fake } = await run(input("resume_goal"), { commandResponse });
  assert.deepEqual(result, { ok: true, data: { delivered: true }, host_version: "2.2.7" });
  assert.deepEqual(fake.calls.map((call) => call.path), [
    "/api/info", "/openapi.json", `/api/session/${SESSION_ID}`, `/api/session/${SESSION_ID}/command`,
  ]);
  const post = fake.calls.at(-1);
  assert.equal(post.method, "POST");
  assert.equal(post.redirect, "manual");
  assert.deepEqual(JSON.parse(post.body), { name: "resume_goal", text: "", delivery: "queue" });
  assert.ok(fake.calls.every((call) => new URL(call.url).origin === BASE_URL));
  assert.ok(fake.calls.every((call) => call.headers.get("authorization") === `Bearer ${HEADER_CANARY}`));
  assert.equal(bodyCanceled, true);
  assert.equal(bodyRead, false);
  assert.equal(fake.discoveryCalls, 1);
  assert.equal(fake.headersCalls, 1);
  assert.equal(fake.lifecycleCalls, 0);
  assertNoSensitiveOutput(result, HEADER_CANARY, RAW_ERROR_CANARY);
});

test("resume_goal rejects unknown input keys before discovery", async () => {
  for (const extra of [{ data: { text: "not accepted" } }, { cursor: "not-accepted" }, { route: "/api/session/other/command" }]) {
    const { result, fake } = await run(input("resume_goal", extra));
    assert.deepEqual(result, { ok: false, code: "input_invalid", post_started: false });
    assert.equal(fake.discoveryCalls, 0);
    assert.equal(fake.calls.length, 0);
  }
});

test("resume_goal worker binding mismatch or archive blocks the command POST", async () => {
  const moved = sessionResponse();
  moved.data.location.directory = "/different-workspace";
  const archived = sessionResponse();
  archived.data.time.archived = 1762550003000;
  const wrongAgent = sessionResponse();
  wrongAgent.data.agent = "other";
  for (const session of [moved, archived, wrongAgent]) {
    const { result, fake } = await run(input("resume_goal"), { session });
    assert.deepEqual(result, { ok: false, code: "session_binding_mismatch", post_started: false });
    assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info", "/openapi.json", `/api/session/${SESSION_ID}`]);
    assert.equal(fake.calls.some((call) => call.method === "POST"), false);
  }
});

test("resume_goal contract incompatibilities fail before session preflight and command POST", async () => {
  for (const variant of ["extra_required", "missing_204", "missing_route", "missing_session_id", "queue_unsupported"]) {
    const { result, fake } = await run(input("resume_goal"), { contract: openapiBrokenResume(variant) });
    assert.deepEqual(result, { ok: false, code: "contract_invalid", post_started: false }, variant);
    assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info", "/openapi.json"], variant);
    assert.equal(fake.calls.some((call) => call.method === "POST"), false, variant);
    assert.equal(fake.lifecycleCalls, 0, variant);
  }
});

test("existing operations do not require the resume command route", async () => {
  const contract = structuredClone(openapi);
  delete contract.paths[commandBrokenOverlay.missing_route];
  const { result, fake } = await run(input("session"), { contract });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fake.calls.some((call) => call.path.endsWith("/command")), false);
});

test("resume_goal accepts only HTTP 204 and reports started POST failures without body leakage", async () => {
  const non204 = await run(input("resume_goal"), {
    commandResponse: new Response(RAW_ERROR_CANARY, { status: 200, headers: { "content-type": "text/plain" } }),
  });
  assert.deepEqual(non204.result, { ok: false, code: "post_failed", post_started: true });
  assert.equal(non204.fake.calls.filter((call) => call.method === "POST").length, 1);
  assertNoSensitiveOutput(non204.result, RAW_ERROR_CANARY, HEADER_CANARY);

  const thrown = await run(input("resume_goal"), { commandError: `private ${RAW_ERROR_CANARY}` });
  assert.deepEqual(thrown.result, { ok: false, code: "post_failed", post_started: true });
  assert.equal(thrown.fake.calls.filter((call) => call.method === "POST").length, 1);
  assertNoSensitiveOutput(thrown.result, RAW_ERROR_CANARY, HEADER_CANARY);
});

test("compatible 2.3 host and additive optional API fields pass without a version equality gate", async () => {
  const { result } = await run(input("session"), { hostVersion: "2.3", contract: openapiFor23() });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.host_version, "2.3");
});

test("canonical HTTPS loopback uses only injected fetch and SDK fakes", async () => {
  const { result, fake } = await run(input("session", {
    connection: { mode: "managed-local", expected_url: HTTPS_URL, expected_pid: 12345 },
  }), {
    endpoint: { url: HTTPS_URL, auth: { type: "basic", username: "opencode", password: HEADER_CANARY } },
    info: infoResponse("2.2.7", { urls: [HTTPS_URL] }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(fake.calls.every((call) => call.url.startsWith(`${HTTPS_URL}/`)));
  assert.equal(fake.discoveryCalls, 1);
  assert.equal(fake.lifecycleCalls, 0);
});

test("same-version broken contract fails before session read or POST", async () => {
  const { result, fake } = await run(input("prompt", { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }), {
    hostVersion: brokenOverlay.host_version,
    contract: openapiBrokenAtSameVersion(),
  });
  assert.deepEqual(result, { ok: false, code: "contract_invalid", post_started: false });
  assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info", "/openapi.json"]);
  assert.equal(fake.calls.some((call) => call.method === "POST"), false);
  assertNoSensitiveOutput(result, HEADER_CANARY, PROMPT_CANARY, RAW_ERROR_CANARY);
});

test("URL absence or mismatch and a configured PID mismatch stop before any business operation", async () => {
  const missing = await run(input(), { endpoint: undefined, discoverError: "auth secret canary" });
  assert.equal(missing.result.ok, false);
  assert.equal(missing.fake.calls.length, 0);
  assertNoSensitiveOutput(missing.result, "auth secret canary", HEADER_CANARY);

  const urlMismatch = await run(input(), { endpoint: { url: "http://127.0.0.1:17778", auth: { password: HEADER_CANARY } } });
  assert.deepEqual(urlMismatch.result, { ok: false, code: "identity_mismatch", post_started: false });
  assert.equal(urlMismatch.fake.calls.length, 0);

  const pidMismatch = await run(input(), { infoOverrides: { pid: 12346 } });
  assert.deepEqual(pidMismatch.result, { ok: false, code: "identity_mismatch", post_started: false });
  assert.deepEqual(pidMismatch.fake.calls.map((call) => call.path), ["/api/info"]);

  const infoUrlMismatch = await run(input(), { infoOverrides: { urls: ["http://127.0.0.1:17778"] } });
  assert.deepEqual(infoUrlMismatch.result, { ok: false, code: "identity_mismatch", post_started: false });
  assert.deepEqual(infoUrlMismatch.fake.calls.map((call) => call.path), ["/api/info"]);
});

test("URL-only input follows a healthy service restart without a PID rebind", async () => {
  const value = input();
  delete value.connection.expected_pid;
  const restartedPid = 2147483648;
  const { result, fake } = await run(value, {
    info: infoResponse("2.2.7", { pid: restartedPid }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info", "/openapi.json", `/api/session/${SESSION_ID}`]);
  assert.equal(fake.discoveryCalls, 1);
});

test("ServerInfo PID must remain a positive safe integer when the config omits its legacy pin", async () => {
  const value = input();
  delete value.connection.expected_pid;
  for (const pid of [undefined, 0, -1, true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const info = infoResponse("2.2.7", { pid });
    if (pid === undefined) delete info.pid;
    const { result, fake } = await run(value, { info });
    assert.deepEqual(result, { ok: false, code: "identity_mismatch", post_started: false }, String(pid));
    assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info"], String(pid));
  }
});

test("health URLs accept the pinned loopback alongside ignored remote advertisements", async () => {
  const accepted = await run(input(), {
    info: infoResponse("2.2.7", { urls: [BASE_URL, "https://abc.opentunnel.xyz"] }),
  });
  assert.equal(accepted.result.ok, true, JSON.stringify(accepted.result));
  assert.ok(accepted.fake.calls.every((call) => new URL(call.url).origin === BASE_URL));

  for (const urls of [
    ["https://abc.opentunnel.xyz"],
    ["http://127.0.0.1:17778"],
    [],
  ]) {
    const rejected = await run(input(), { info: infoResponse("2.2.7", { urls }) });
    assert.deepEqual(rejected.result, { ok: false, code: "identity_mismatch", post_started: false });
    assert.deepEqual(rejected.fake.calls.map((call) => call.path), ["/api/info"]);
  }
});

test("discovered and health URLs normalize only a harmless trailing slash", async () => {
  const accepted = await run(input(), {
    endpoint: { url: `${BASE_URL}/`, auth: { password: HEADER_CANARY } },
    info: infoResponse("2.2.7", { urls: [`${BASE_URL}/`] }),
  });
  assert.equal(accepted.result.ok, true, JSON.stringify(accepted.result));

  const rejectedDiscovered = [
    `${BASE_URL}/evil`,
    "http://user:secret@127.0.0.1:17777",
    `${BASE_URL}?query=1`,
    `${BASE_URL}#fragment`,
  ];
  for (const url of rejectedDiscovered) {
    const { result, fake } = await run(input(), { endpoint: { url } });
    assert.deepEqual(result, { ok: false, code: "identity_mismatch", post_started: false }, url);
    assert.equal(fake.calls.length, 0, url);
  }

  const rejectedHealth = [
    `${BASE_URL}/evil`,
    "http://user:secret@127.0.0.1:17777",
    `${BASE_URL}?query=1`,
    `${BASE_URL}#fragment`,
  ];
  for (const url of rejectedHealth) {
    const { result, fake } = await run(input(), { info: infoResponse("2.2.7", { urls: [url] }) });
    assert.deepEqual(result, { ok: false, code: "identity_mismatch", post_started: false }, url);
    assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info"], url);
  }
});

test("credential URL and unknown target overrides are rejected before discovery", async () => {
  const credential = input();
  credential.connection.expected_url = "http://user:secret@127.0.0.1:17777";
  const first = await run(credential);
  assert.deepEqual(first.result, { ok: false, code: "input_invalid", post_started: false });
  assert.equal(first.fake.discoveryCalls, 0);
  assert.equal(first.fake.calls.length, 0);
  assertNoSensitiveOutput(first.result, "secret", HEADER_CANARY);

  const noncanonical = input();
  noncanonical.connection.expected_url = `${BASE_URL}/`;
  const trailingSlash = await run(noncanonical);
  assert.deepEqual(trailingSlash.result, { ok: false, code: "input_invalid", post_started: false });
  assert.equal(trailingSlash.fake.discoveryCalls, 0);

  const override = { ...input(), route: "/api/session/other/prompt", method: "POST", headers: { authorization: "CANARY" }, session_id: "ses_other" };
  const second = await run(override);
  assert.deepEqual(second.result, { ok: false, code: "input_invalid", post_started: false });
  assert.equal(second.fake.discoveryCalls, 0);
  assert.equal(second.fake.calls.length, 0);
});

test("inbox projection drops non-user records and raw content while retaining a blank compatibility text", async () => {
  const inbox = structuredClone(inboxFixture);
  inbox.data.push({ type: "synthetic", payload: { text: RAW_ERROR_CANARY } });
  inbox.data[0].payload.text = PROMPT_CANARY;
  inbox.data[0].payload.metadata.extra = "metadata canary";
  inbox.data[0].rawError = RAW_ERROR_CANARY;
  inbox.data[0].time = { created: 1762550002000 };
  inbox.data[0].delivery = "queue";
  const { result, fake } = await run(input("inbox"), { inbox });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data, { data: [{
    id: "msg_fixture_1",
    sessionID: SESSION_ID,
    type: "user",
    time: { created: 1762550002000 },
    delivery: "queue",
    payload: { text: "", metadata: { overseerRelay: { campaign: CAMPAIGN, batchId: BATCH_ID } } },
  }] });
  assert.equal(fake.calls.at(-1).path, `/api/session/${SESSION_ID}/inbox`);
  assertNoSensitiveOutput(result, PROMPT_CANARY, RAW_ERROR_CANARY, "metadata canary", HEADER_CANARY);
});

test("message page projection sanitizes text/metadata and bounds the opaque cursor", async () => {
  const messages = structuredClone(messagesFixture);
  messages.data[0].text = PROMPT_CANARY;
  messages.data[0].metadata.secret = "metadata canary";
  messages.data[0].rawError = RAW_ERROR_CANARY;
  messages.cursor.next = "cursor/next";
  const { result, fake } = await run(input("messages"), { messages });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.data[0], {
    id: "msg_fixture_1",
    sessionID: SESSION_ID,
    type: "user",
    time: { created: 1762550002000 },
    text: "",
    metadata: { overseerRelay: { campaign: CAMPAIGN, batchId: BATCH_ID } },
  });
  assert.equal(result.data.cursor.next, "cursor/next");
  assert.match(fake.calls.at(-1).url, /type=user&limit=100&order=desc$/);
  assertNoSensitiveOutput(result, PROMPT_CANARY, RAW_ERROR_CANARY, "metadata canary", HEADER_CANARY);

  const next = await run(input("messages", { cursor: "opaque/next" }));
  assert.equal(next.result.ok, true, JSON.stringify(next.result));
  assert.match(next.fake.calls.at(-1).url, /type=user&limit=100&cursor=opaque%2Fnext$/);
});

test("prompt sends only fixed queued payload and returns a content-free validated receipt", async () => {
  const { result, fake } = await run(input("prompt", { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const post = fake.calls.filter((call) => call.method === "POST");
  assert.equal(post.length, 1);
  assert.equal(post[0].path, `/api/session/${SESSION_ID}/prompt`);
  assert.equal(post[0].redirect, "manual");
  assert.deepEqual(JSON.parse(post[0].body), {
    text: PROMPT_CANARY,
    delivery: "queue",
    resume: true,
    metadata: { overseerRelay: { campaign: CAMPAIGN, batchId: BATCH_ID } },
  });
  assert.deepEqual(result.data, { data: {
    id: "msg_receipt1",
    sessionID: SESSION_ID,
    type: "user",
    time: { created: 1762550002000 },
    delivery: "queue",
    payload: { metadata: { overseerRelay: { campaign: CAMPAIGN, batchId: BATCH_ID } } },
  } });
  assertNoSensitiveOutput(result, PROMPT_CANARY, RAW_ERROR_CANARY, HEADER_CANARY, "nested metadata canary");
  assert.equal(fake.lifecycleCalls, 0);
});

test("failed prompt fetch is uncertain with post_started true and never retries", async () => {
  const { result, fake } = await run(input("prompt", { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }), {
    postError: `raw response ${RAW_ERROR_CANARY}`,
  });
  assert.deepEqual(result, { ok: false, code: "post_failed", post_started: true });
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  assertNoSensitiveOutput(result, RAW_ERROR_CANARY, PROMPT_CANARY, HEADER_CANARY);
});

test("session move, archive, and wrong agent are rejected before requested operation", async () => {
  const moved = sessionResponse();
  moved.data.location.directory = "/different-workspace";
  const archived = sessionResponse();
  archived.data.time.archived = 1762550003000;
  const wrongAgent = sessionResponse();
  wrongAgent.data.agent = "other";
  for (const session of [moved, archived, wrongAgent]) {
    const { result, fake } = await run(input("inbox"), { session });
    assert.deepEqual(result, { ok: false, code: "session_binding_mismatch", post_started: false });
    assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info", "/openapi.json", `/api/session/${SESSION_ID}`]);
  }
});

test("effective location plus valid subpath matches the bound directory and stays unflattened", async () => {
  const session = sessionResponse();
  session.data.location.directory = DIRECTORY;
  session.data.subpath = "repo";
  const { result } = await run(input("session", {
    binding: { session_id: SESSION_ID, directory: `${DIRECTORY}/repo`, agent: "build" },
  }), { session });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.data.location, { directory: DIRECTORY });
  assert.equal(result.data.data.subpath, "repo");
});

test("unsafe or mismatched effective directories block every operation before POST", async () => {
  const cases = [
    ["parent traversal", "../repo", "response_invalid"],
    ["absolute subpath", `${DIRECTORY}/repo`, "response_invalid"],
    ["empty component", "repo//nested", "response_invalid"],
    ["dot component", "repo/./nested", "response_invalid"],
    ["backslash", "repo\\nested", "response_invalid"],
    ["NUL", "repo\u0000nested", "response_invalid"],
    ["control", "repo\nnested", "response_invalid"],
    ["different effective directory", "other", "session_binding_mismatch"],
  ];
  const operations = ["session", "inbox", "messages", "prompt"];
  for (const [label, subpath, expectedCode] of cases) {
    for (const operation of operations) {
      const session = sessionResponse();
      session.data.location.directory = DIRECTORY;
      session.data.subpath = subpath;
      const binding = { session_id: SESSION_ID, directory: `${DIRECTORY}/repo`, agent: "build" };
      const extra = operation === "prompt"
        ? { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }
        : operation === "messages" ? { cursor: null } : {};
      const { result, fake } = await run(input(operation, { binding, ...extra }), { session });
      assert.deepEqual(result, { ok: false, code: expectedCode, post_started: false }, `${label}/${operation}`);
      assert.deepEqual(fake.calls.map((call) => call.path), ["/api/info", "/openapi.json", `/api/session/${SESSION_ID}`], `${label}/${operation}`);
      assert.equal(fake.calls.some((call) => call.method === "POST"), false, `${label}/${operation}`);
    }
  }
});

test("session timestamps are ordered and archived timestamp zero remains active", async () => {
  const active = sessionResponse();
  active.data.time.archived = 0;
  const accepted = await run(input("session"), { session: active });
  assert.equal(accepted.result.ok, true, JSON.stringify(accepted.result));
  assert.equal(accepted.result.data.data.time.archived, 0);

  const reversed = sessionResponse();
  reversed.data.time.created = reversed.data.time.updated + 1;
  const rejected = await run(input("prompt", { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }), { session: reversed });
  assert.deepEqual(rejected.result, { ok: false, code: "response_invalid", post_started: false });
  assert.deepEqual(rejected.fake.calls.map((call) => call.path), ["/api/info", "/openapi.json", `/api/session/${SESSION_ID}`]);
  assert.equal(rejected.fake.calls.some((call) => call.method === "POST"), false);
});

test("malformed required user records fail and known malformed-free non-user records are ignored", async () => {
  const badInbox = { data: [{ id: "msg_bad", sessionID: SESSION_ID, type: "user", payload: { text: 4 }, delivery: "queue" }] };
  const { result, fake } = await run(input("inbox"), { inbox: badInbox });
  assert.deepEqual(result, { ok: false, code: "response_invalid", post_started: false });
  assert.equal(fake.calls.at(-1).path, `/api/session/${SESSION_ID}/inbox`);

  const badMessages = { data: [{ id: "msg_bad", type: "assistant", time: { created: 1 }, text: "secret" }], cursor: {} };
  const second = await run(input("messages"), { messages: badMessages });
  assert.deepEqual(second.result, { ok: false, code: "response_invalid", post_started: false });
});

test("unwrapped ServerInfo is required and a wrapped or malformed health response stops immediately", async () => {
  const wrapped = await run(input(), { info: { data: infoResponse() } });
  assert.deepEqual(wrapped.result, { ok: false, code: "identity_mismatch", post_started: false });
  assert.deepEqual(wrapped.fake.calls.map((call) => call.path), ["/api/info"]);

  const malformed = await run(input(), { info: infoResponse("not a version", { paths: { tmp: 3 } }) });
  assert.deepEqual(malformed.result, { ok: false, code: "identity_mismatch", post_started: false });
  assert.deepEqual(malformed.fake.calls.map((call) => call.path), ["/api/info"]);

  const absent = await run(input(), { endpoint: null });
  assert.deepEqual(absent.result, { ok: false, code: "service_missing", post_started: false });
  assert.equal(absent.fake.calls.length, 0);
});

test("redirects, malformed JSON, and oversized OpenAPI fail before session or prompt operations", async () => {
  const redirect = await run(input("prompt", { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }), {
    fetchOverride: (call) => call.path === "/openapi.json"
      ? new Response(null, { status: 302, headers: { location: `${BASE_URL}/other` } })
      : jsonResponse(infoResponse()),
  });
  assert.deepEqual(redirect.result, { ok: false, code: "redirect_blocked", post_started: false });
  assert.deepEqual(redirect.fake.calls.map((call) => call.path), ["/api/info", "/openapi.json"]);

  const malformed = await run(input(), {
    fetchOverride: (call) => call.path === "/api/info" ? new Response("{", { status: 200 }) : jsonResponse(openapi),
  });
  assert.deepEqual(malformed.result, { ok: false, code: "response_invalid", post_started: false });

  const oversized = await run(input("prompt", { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }), {
    fetchOverride: (call) => call.path === "/openapi.json"
      ? new Response(" ".repeat(managedLimits.maxOpenApiBytes + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : jsonResponse(infoResponse()),
  });
  assert.deepEqual(oversized.result, { ok: false, code: "response_too_large", post_started: false });
  assert.equal(oversized.fake.calls.some((call) => call.method === "POST"), false);

  const sameOriginRedirect = await run(input(), {
    fetchOverride: (call) => call.path === "/api/info"
      ? {
          status: 200,
          ok: true,
          url: `${BASE_URL}/redirected-info`,
          headers: new Headers({ "content-type": "application/json" }),
          body: jsonResponse(infoResponse()).body,
        }
      : jsonResponse(openapi),
  });
  assert.deepEqual(sameOriginRedirect.result, { ok: false, code: "redirect_blocked", post_started: false });
  assert.equal(sameOriginRedirect.fake.calls.length, 1);
});

test("discovery and fetch deadlines bound never-resolving fakes", async () => {
  const discoveryHarness = harness();
  const discovery = await runManagedOperation(input("session", { timeout_ms: 100 }), {
    sdk: { discover: () => new Promise(() => {}), headers: () => ({}) },
    fetch: discoveryHarness.fetch,
  });
  assert.deepEqual(discovery, { ok: false, code: "timeout", post_started: false });
  assert.equal(discoveryHarness.calls.length, 0);

  const fetchHarness = harness({ fetchOverride: () => new Promise(() => {}) });
  const timed = await runManagedOperation(input("session", { timeout_ms: 100 }), {
    sdk: fetchHarness.sdk,
    fetch: fetchHarness.fetch,
  });
  assert.deepEqual(timed, { ok: false, code: "timeout", post_started: false });
  assert.equal(fetchHarness.calls.length, 1);
  assert.ok(fetchHarness.calls[0].signal instanceof AbortSignal);
});

test("post receipt text/session/queue/metadata are verified internally and never projected", async () => {
  const badReceipt = { data: {
    id: "msg_receipt1", sessionID: "ses_wrong", type: "user", delivery: "queue",
    time: { created: 1762550002000 }, payload: { text: PROMPT_CANARY, metadata: { overseerRelay: { campaign: CAMPAIGN, batchId: BATCH_ID } } },
  } };
  const { result, fake } = await run(input("prompt", { data: { text: PROMPT_CANARY, batch_id: BATCH_ID } }), { promptResponse: badReceipt });
  assert.deepEqual(result, { ok: false, code: "response_invalid", post_started: true });
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  assertNoSensitiveOutput(result, PROMPT_CANARY, HEADER_CANARY);
});

test("CLI emits one static JSON error for duplicate-key input without invoking discovery", () => {
  const cli = spawnSync(process.execPath, [resolve(packageRoot, "src/main.mjs")], {
    cwd: packageRoot,
    input: '{"schema_version":1,"schema_version":1}',
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.equal(cli.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(cli.stdout), { ok: false, code: "input_invalid", post_started: false });
});
