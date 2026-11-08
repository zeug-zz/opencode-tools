import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseStrictJson, qualifyOpenApi } from "../src/contract.mjs";

const testRoot = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(testRoot, "fixtures");
const base = JSON.parse(await readFile(resolve(fixtureRoot, "contract-2.2.7.json"), "utf8"));
const additive = JSON.parse(await readFile(resolve(fixtureRoot, "contract-2.3-additions.json"), "utf8"));
const broken = JSON.parse(await readFile(resolve(fixtureRoot, "contract-broken-same-version.json"), "utf8"));
const commandBroken = JSON.parse(await readFile(resolve(fixtureRoot, "contract-command-broken.json"), "utf8"));
const clone = (value) => structuredClone(value);

function withAdditions() {
  const document = clone(base);
  const schemas = document.components.schemas;
  Object.assign(schemas.ServerInfo.properties, additive.optional_schema_additions.server_info);
  Object.assign(schemas["Session.Info"].properties, additive.optional_schema_additions.session_info);
  const prompt = document.paths["/api/session/{sessionID}/prompt"].post.requestBody.content["application/json"].schema;
  Object.assign(prompt.properties, additive.optional_schema_additions.prompt_request);
  return document;
}

function withBrokenRequiredField() {
  const document = clone(base);
  const prompt = document.paths["/api/session/{sessionID}/prompt"].post.requestBody.content["application/json"].schema;
  prompt.properties[broken.required_prompt_field.name] = broken.required_prompt_field.schema;
  prompt.required.push(broken.required_prompt_field.name);
  return document;
}

test("recorded 2.2.7 contract qualifies and 2.3 optional additions remain compatible", () => {
  assert.equal(base["x-fixture-host-version"], "2.2.7");
  assert.equal(qualifyOpenApi(base), true);
  assert.equal(additive.host_version, "2.3");
  assert.equal(qualifyOpenApi(withAdditions()), true);
});

test("resume qualification is opt-in and accepts the fixed public command route", () => {
  assert.equal(qualifyOpenApi(base, true), true);

  const withoutCommand = clone(base);
  delete withoutCommand.paths[commandBroken.missing_route];
  assert.equal(qualifyOpenApi(withoutCommand), true);
  assert.equal(qualifyOpenApi(withoutCommand, true), false);
});

test("resume qualification rejects missing route requirements, unsupported values, and extra required fields", () => {
  const extraRequired = clone(base);
  const body = extraRequired.paths[commandBroken.missing_route].post.requestBody.content["application/json"].schema;
  body.properties[commandBroken.extra_required_field.name] = commandBroken.extra_required_field.schema;
  body.required.push(commandBroken.extra_required_field.name);
  assert.equal(qualifyOpenApi(extraRequired, true), false);

  const missing204 = clone(base);
  delete missing204.paths[commandBroken.missing_route].post.responses[commandBroken.missing_success_status];
  assert.equal(qualifyOpenApi(missing204, true), false);

  const missingParameter = clone(base);
  missingParameter.paths[commandBroken.missing_route].post.parameters = [];
  assert.equal(qualifyOpenApi(missingParameter, true), false);

  const missingBody = clone(base);
  missingBody.paths[commandBroken.missing_route].post.requestBody.required = false;
  assert.equal(qualifyOpenApi(missingBody, true), false);

  const missingText = clone(base);
  missingText.paths[commandBroken.missing_route].post.requestBody.content["application/json"].schema.required = ["name"];
  assert.equal(qualifyOpenApi(missingText, true), false);

  const unsupportedQueue = clone(base);
  unsupportedQueue.components.schemas["Session.Inbox.Delivery"].enum = ["steer"];
  assert.equal(qualifyOpenApi(unsupportedQueue, true), false);

  const unsupportedName = clone(base);
  unsupportedName.paths[commandBroken.missing_route].post.requestBody.content["application/json"].schema.properties.name.enum = ["other"];
  assert.equal(qualifyOpenApi(unsupportedName, true), false);

  const nonEmptyTextOnly = clone(base);
  nonEmptyTextOnly.paths[commandBroken.missing_route].post.requestBody.content["application/json"].schema.properties.text.minLength = 1;
  assert.equal(qualifyOpenApi(nonEmptyTextOnly, true), false);
});

test("broken schema at the same host version fails instead of trusting the version", () => {
  assert.equal(broken.host_version, "2.2.7");
  assert.equal(qualifyOpenApi(withBrokenRequiredField()), false);
});

test("required paths, supported query values, and prompt values are contract gates", () => {
  const missing = clone(base);
  delete missing.paths["/api/session/{sessionID}/inbox"];
  assert.equal(qualifyOpenApi(missing), false);

  const query = clone(base);
  query.paths["/api/session/{sessionID}/message"].get.parameters.find((item) => item.name === "type").schema.enum = ["assistant"];
  assert.equal(qualifyOpenApi(query), false);

  const delivery = clone(base);
  delivery.components.schemas["Session.Inbox.Delivery"].enum = ["steer"];
  assert.equal(qualifyOpenApi(delivery), false);

  const resume = clone(base);
  resume.paths["/api/session/{sessionID}/prompt"].post.requestBody.content["application/json"].schema.properties.resume = {
    type: "boolean", enum: [false],
  };
  assert.equal(qualifyOpenApi(resume), false);

  const splitDelivery = clone(base);
  splitDelivery.components.schemas["Session.Inbox.Delivery"] = { anyOf: [
    { type: "string", enum: ["queue"] },
    { type: "integer", enum: ["steer"] },
  ] };
  assert.equal(qualifyOpenApi(splitDelivery), false);

  const requiredHeader = clone(base);
  requiredHeader.paths["/api/session/{sessionID}/inbox"].get.parameters.push({
    name: "required-token", in: "header", required: true, schema: { type: "string" },
  });
  assert.equal(qualifyOpenApi(requiredHeader), false);

  const supportedRequiredQueries = clone(base);
  for (const name of ["type", "limit"]) {
    supportedRequiredQueries.paths["/api/session/{sessionID}/message"].get.parameters.find((item) => item.name === name).required = true;
  }
  assert.equal(qualifyOpenApi(supportedRequiredQueries), true);

  const unsupportedRequiredQuery = clone(base);
  unsupportedRequiredQuery.paths["/api/session/{sessionID}/message"].get.parameters.find((item) => item.name === "order").required = true;
  assert.equal(qualifyOpenApi(unsupportedRequiredQuery), false);
});

test("relevant external, cyclic, and over-depth schema refs fail closed", () => {
  const external = clone(base);
  external.paths["/api/session/{sessionID}"].get.parameters[0].schema.$ref = "https://example.invalid/Session.ID";
  assert.equal(qualifyOpenApi(external), false);

  const cycle = clone(base);
  cycle.components.schemas["Session.Info"] = { $ref: "#/components/schemas/Session.Info" };
  assert.equal(qualifyOpenApi(cycle), false);

  const deep = clone(base);
  deep.components.schemas["Session.Info"] = { $ref: "#/components/schemas/Ref0" };
  for (let index = 0; index < 14; index += 1) {
    deep.components.schemas[`Ref${index}`] = { $ref: `#/components/schemas/Ref${index + 1}` };
  }
  deep.components.schemas.Ref14 = base.components.schemas["Session.Info"];
  assert.equal(qualifyOpenApi(deep), false);
});

test("unbounded path and union expansion is rejected before qualification", () => {
  const tooManyPaths = clone(base);
  for (let index = 0; index < 256; index += 1) tooManyPaths.paths[`/extra/${index}`] = { get: {} };
  assert.equal(qualifyOpenApi(tooManyPaths), false);

  const tooManyBranches = clone(base);
  tooManyBranches.paths["/api/session/{sessionID}/message"].get.parameters.find((item) => item.name === "limit").schema = {
    anyOf: Array.from({ length: 32 }, () => ({ anyOf: Array.from({ length: 5 }, () => ({ type: "string" })) })),
  };
  assert.equal(qualifyOpenApi(tooManyBranches), false);
});

test("strict JSON rejects duplicate keys, non-finite numbers, excess depth, and trailing values", () => {
  assert.throws(() => parseStrictJson('{"schema_version":1,"schema_version":2}'));
  assert.throws(() => parseStrictJson('{"n":1e999}'));
  assert.throws(() => parseStrictJson(`${"[".repeat(5)}0${"]".repeat(5)}`, { maxDepth: 4 }));
  assert.throws(() => parseStrictJson("{} {}"));
  assert.deepEqual(parseStrictJson('{"escaped\\u006bey":true}'), { escapedkey: true });
});
