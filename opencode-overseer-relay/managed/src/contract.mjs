const MAX_REF_DEPTH = 12;
const MAX_UNION_BRANCHES = 32;
const MAX_SCHEMA_BRANCHES = 128;
const MAX_OPENAPI_PATHS = 256;
const MAX_OPENAPI_OPERATIONS = 512;

function scanJson(text, maxDepth) {
  let index = 0;
  let nodes = 0;
  const ws = () => { while ([" ", "\t", "\n", "\r"].includes(text[index])) index += 1; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 34) {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (code < 32) throw new Error("invalid JSON");
      if (code === 92) {
        index += 1;
        const escaped = text[index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) throw new Error("invalid JSON");
          index += 5;
          continue;
        }
        if (!["\"", "\\", "/", "b", "f", "n", "r", "t"].includes(escaped)) throw new Error("invalid JSON");
      }
      index += 1;
    }
    throw new Error("invalid JSON");
  };
  const value = (depth) => {
    ws();
    nodes += 1;
    if (nodes > 50000 || depth > maxDepth) throw new Error("JSON bounds");
    const char = text[index];
    if (char === "\"") { string(); return; }
    if (char === "{") {
      index += 1; ws();
      if (text[index] === "}") { index += 1; return; }
      const keys = new Set();
      while (true) {
        ws();
        if (text[index] !== "\"") throw new Error("invalid JSON");
        const key = string();
        if (keys.has(key)) throw new Error("duplicate key");
        keys.add(key); ws();
        if (text[index++] !== ":") throw new Error("invalid JSON");
        value(depth + 1); ws();
        if (text[index] === "}") { index += 1; return; }
        if (text[index++] !== ",") throw new Error("invalid JSON");
      }
    }
    if (char === "[") {
      index += 1; ws();
      if (text[index] === "]") { index += 1; return; }
      while (true) {
        value(depth + 1); ws();
        if (text[index] === "]") { index += 1; return; }
        if (text[index++] !== ",") throw new Error("invalid JSON");
      }
    }
    if (char === "t" && text.slice(index, index + 4) === "true") index += 4;
    else if (char === "f" && text.slice(index, index + 5) === "false") index += 5;
    else if (char === "n" && text.slice(index, index + 4) === "null") index += 4;
    else {
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
      if (!number || !Number.isFinite(Number(number[0]))) throw new Error("invalid number");
      index += number[0].length;
    }
  };
  value(0); ws();
  if (index !== text.length) throw new Error("trailing JSON");
}

export function parseStrictJson(input, { maxBytes = 2 * 1024 * 1024, maxDepth = 96 } = {}) {
  try {
    let text;
    if (typeof input === "string") text = input;
    else if (input instanceof Uint8Array) {
      if (input.byteLength > maxBytes) throw new Error("too large");
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } else throw new Error("unsupported input");
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("too large");
    scanJson(text, maxDepth);
    return JSON.parse(text);
  } catch {
    throw new TypeError("invalid bounded JSON");
  }
}

function invalid() {
  throw new Error("API contract is unsupported");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointerValue(document, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) {
    invalid();
  }
  const tokens = reference.slice(2).split("/").map((token) => {
    if (/~(?![01])/.test(token)) invalid();
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
  });
  if (tokens.length < 3 || tokens[0] !== "components" || tokens[1] !== "schemas") invalid();
  let value = document;
  for (const token of tokens) {
    if (!isRecord(value) || !Object.hasOwn(value, token)) invalid();
    value = value[token];
  }
  return value;
}

function schemaBranches(document, schema, ancestry = new Set(), depth = 0) {
  if (depth > MAX_REF_DEPTH || !isRecord(schema)) invalid();
  if (["not", "if", "then", "else"].some((key) => Object.hasOwn(schema, key))) invalid();
  if (Object.hasOwn(schema, "$ref")) {
    if (Object.keys(schema).length !== 1) invalid();
    const reference = schema.$ref;
    if (ancestry.has(reference)) invalid();
    const next = new Set(ancestry);
    next.add(reference);
    return schemaBranches(document, pointerValue(document, reference), next, depth + 1);
  }
  if (Object.hasOwn(schema, "anyOf")) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0 || schema.anyOf.length > MAX_UNION_BRANCHES) {
      invalid();
    }
    const branches = schema.anyOf.flatMap((branch) => schemaBranches(document, branch, ancestry, depth + 1));
    if (branches.length > MAX_SCHEMA_BRANCHES) invalid();
    return branches;
  }
  if (Object.hasOwn(schema, "oneOf") || Object.hasOwn(schema, "allOf")) invalid();
  return [schema];
}

function objectBranch(document, schema) {
  const branches = schemaBranches(document, schema);
  if (branches.length === 0 || branches.some((branch) => branch.type !== "object" || !isRecord(branch.properties))) invalid();
  return branches[0];
}

function fieldSchema(document, object, name) {
  if (!Object.hasOwn(object.properties, name)) invalid();
  return object.properties[name];
}

function supportsType(document, schema, expected) {
  const branches = schemaBranches(document, schema);
  return branches.length > 0 && branches.every((branch) => {
    return branch.type === expected || (Array.isArray(branch.type) && branch.type.includes(expected));
  });
}

function supportsStringOrNull(document, schema) {
  const branches = schemaBranches(document, schema);
  const found = new Set();
  for (const branch of branches) {
    const types = Array.isArray(branch.type) ? branch.type : [branch.type];
    if (types.length === 0 || types.some((type) => !["string", "null"].includes(type))) return false;
    for (const type of types) found.add(type);
  }
  return found.has("string") && found.has("null");
}

function supportsValue(document, schema, expectedType, expectedValue) {
  return schemaBranches(document, schema).some((branch) => {
    const typeSupported = branch.type === expectedType ||
      (Array.isArray(branch.type) && branch.type.includes(expectedType));
    if (!typeSupported) return false;
    if (Array.isArray(branch.enum) && !branch.enum.includes(expectedValue)) return false;
    if (Object.hasOwn(branch, "const") && branch.const !== expectedValue) return false;
    return true;
  });
}

function supportsStringValue(document, schema, expectedValue) {
  return schemaBranches(document, schema).some((branch) => {
    const types = Array.isArray(branch.type) ? branch.type : [branch.type];
    if (!types.includes("string")) return false;
    if (Array.isArray(branch.enum) && !branch.enum.includes(expectedValue)) return false;
    if (Object.hasOwn(branch, "const") && branch.const !== expectedValue) return false;
    if (Object.hasOwn(branch, "minLength") &&
        (!Number.isSafeInteger(branch.minLength) || branch.minLength < 0 || expectedValue.length < branch.minLength)) return false;
    if (Object.hasOwn(branch, "maxLength") &&
        (!Number.isSafeInteger(branch.maxLength) || branch.maxLength < 0 || expectedValue.length > branch.maxLength)) return false;
    if (Object.hasOwn(branch, "pattern")) {
      if (typeof branch.pattern !== "string" || branch.pattern.length > 4096) return false;
      try { if (!new RegExp(branch.pattern).test(expectedValue)) return false; }
      catch { return false; }
    }
    return true;
  });
}

function isRequired(object, name) {
  return Array.isArray(object.required) && object.required.includes(name);
}

function requireField(document, object, name, type, required = false) {
  const schema = fieldSchema(document, object, name);
  if (!supportsType(document, schema, type) || (required && !isRequired(object, name))) invalid();
  return schema;
}

function requireResponseSchema(operation) {
  const response = operation.responses?.["200"];
  const schema = response?.content?.["application/json"]?.schema;
  if (!isRecord(schema)) invalid();
  return schema;
}

function responseDataSchema(document, operation) {
  const wrapper = objectBranch(document, requireResponseSchema(operation));
  if (!isRequired(wrapper, "data")) invalid();
  return fieldSchema(document, wrapper, "data");
}

function validatePathParameters(document, pathItem, operation, expectedNames, requiredQueryNames = []) {
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  if ((pathItem.parameters !== undefined && !Array.isArray(pathItem.parameters)) ||
      (operation.parameters !== undefined && !Array.isArray(operation.parameters))) invalid();

  const parsed = parameters.map((parameter) => {
    if (!isRecord(parameter) || Object.hasOwn(parameter, "$ref")) invalid();
    if (typeof parameter.name !== "string" || typeof parameter.in !== "string" || !isRecord(parameter.schema)) invalid();
    if (!["path", "query", "header", "cookie"].includes(parameter.in) ||
        (parameter.required !== undefined && typeof parameter.required !== "boolean")) invalid();
    return parameter;
  });
  const identities = new Set();
  for (const parameter of parsed) {
    const identity = `${parameter.in}:${parameter.name}`;
    if (identities.has(identity)) invalid();
    identities.add(identity);
  }
  const requiredPath = parsed
    .filter((parameter) => parameter.in === "path" && parameter.required === true)
    .map((parameter) => parameter.name)
    .sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(requiredPath) !== JSON.stringify(expected)) invalid();
  for (const name of expected) {
    const parameter = parsed.find((item) => item.in === "path" && item.name === name && item.required === true);
    if (!parameter || !supportsType(document, parameter.schema, "string")) invalid();
  }
  const requiredQuery = parsed
    .filter((parameter) => parameter.in === "query" && parameter.required === true)
    .map((parameter) => parameter.name)
    .sort();
  if (requiredQuery.some((name) => !requiredQueryNames.includes(name))) invalid();
  for (const parameter of parsed) {
    if (parameter.required === true && parameter.in !== "path" && parameter.in !== "query") invalid();
  }
  return parsed;
}

function validateOperation(document, path, method, pathParameters, requiredQueryParameters = []) {
  const pathItem = document.paths[path];
  if (!isRecord(pathItem)) invalid();
  const operation = pathItem[method];
  if (!isRecord(operation) || Object.hasOwn(operation, "$ref")) invalid();
  validatePathParameters(document, pathItem, operation, pathParameters, requiredQueryParameters);
  return operation;
}

function requireObjectResponse(document, operation, properties) {
  const schema = responseDataSchema(document, operation);
  const object = objectBranch(document, schema);
  for (const [name, type, required] of properties) requireField(document, object, name, type, required);
  return object;
}

function validateServerInfo(document, operation) {
  const info = objectBranch(document, requireResponseSchema(operation));
  for (const name of ["version", "pid", "urls", "paths"]) {
    if (!isRequired(info, name)) invalid();
  }
  requireField(document, info, "version", "string", true);
  requireField(document, info, "pid", "integer", true);
  const urlsSchema = fieldSchema(document, info, "urls");
  const array = schemaBranches(document, urlsSchema).find((branch) => branch.type === "array");
  if (!array || !isRecord(array.items) || !supportsType(document, array.items, "string")) invalid();
  const paths = objectBranch(document, fieldSchema(document, info, "paths"));
  const tmp = requireField(document, paths, "tmp", "string", true);
  void tmp;
}

function findVariantByType(document, schema, expectedType) {
  return schemaBranches(document, schema).find((branch) => {
    if (!isRecord(branch.properties) || !Object.hasOwn(branch.properties, "type")) return false;
    return supportsValue(document, branch.properties.type, "string", expectedType);
  });
}

function validateInboxUser(document, schema) {
  const variants = schemaBranches(document, schema);
  const user = variants.find((branch) => {
    return isRecord(branch.properties) && supportsValue(document, branch.properties.type, "string", "user");
  });
  if (!user) invalid();
  for (const name of ["id", "sessionID", "time", "type", "payload", "delivery"]) {
    if (!isRequired(user, name)) invalid();
  }
  requireField(document, user, "id", "string", true);
  requireField(document, user, "sessionID", "string", true);
  const time = objectBranch(document, fieldSchema(document, user, "time"));
  requireField(document, time, "created", "number", true);
  if (!supportsValue(document, fieldSchema(document, user, "type"), "string", "user")) invalid();
  const delivery = fieldSchema(document, user, "delivery");
  if (!supportsValue(document, delivery, "string", "queue") || !supportsValue(document, delivery, "string", "steer")) invalid();
  const payload = objectBranch(document, fieldSchema(document, user, "payload"));
  requireField(document, payload, "text", "string", true);
  if (Object.hasOwn(payload.properties, "metadata") && !supportsType(document, payload.properties.metadata, "object")) invalid();
}

function validateInboxResponse(document, operation) {
  const wrapper = objectBranch(document, requireResponseSchema(operation));
  const dataSchema = requireField(document, wrapper, "data", "array", true);
  const array = schemaBranches(document, dataSchema).find((branch) => branch.type === "array");
  if (!array || !isRecord(array.items)) invalid();
  validateInboxUser(document, array.items);
}

function validateMessagePage(document, operation) {
  const wrapper = objectBranch(document, requireResponseSchema(operation));
  const dataSchema = requireField(document, wrapper, "data", "array", true);
  const cursorSchema = requireField(document, wrapper, "cursor", "object", true);
  const array = schemaBranches(document, dataSchema).find((branch) => branch.type === "array");
  if (!array || !isRecord(array.items)) invalid();
  const user = findVariantByType(document, array.items, "user");
  if (!user) invalid();
  for (const name of ["id", "time", "text", "type"]) {
    if (!isRequired(user, name)) invalid();
  }
  requireField(document, user, "id", "string", true);
  requireField(document, user, "text", "string", true);
  if (!supportsValue(document, fieldSchema(document, user, "type"), "string", "user")) invalid();
  const time = objectBranch(document, fieldSchema(document, user, "time"));
  requireField(document, time, "created", "number", true);
  if (Object.hasOwn(user.properties, "metadata") && !supportsType(document, user.properties.metadata, "object")) invalid();

  const cursor = objectBranch(document, cursorSchema);
  for (const name of ["previous", "next"]) {
    const value = fieldSchema(document, cursor, name);
    if (!supportsStringOrNull(document, value)) invalid();
  }
}

function validateMessageQuery(document, operation, pathItem) {
  const parameters = validatePathParameters(document, pathItem, operation, ["sessionID"], ["limit", "type"]);
  const expected = new Map([
    ["type", (schema) => supportsValue(document, schema, "string", "user")],
    ["limit", (schema) => supportsValue(document, schema, "string", "100")],
    ["order", (schema) => supportsValue(document, schema, "string", "desc")],
    ["cursor", (schema) => supportsType(document, schema, "string")],
  ]);
  for (const [name, predicate] of expected) {
    const parameter = parameters.find((item) => item.in === "query" && item.name === name);
    if (!parameter || (parameter.required === true && !["type", "limit"].includes(name)) || !predicate(parameter.schema)) invalid();
  }
}

function validatePromptRequest(document, operation) {
  const requestBody = operation.requestBody;
  const schema = requestBody?.content?.["application/json"]?.schema;
  if (requestBody?.required !== true || !isRecord(schema)) invalid();
  const body = objectBranch(document, schema);
  const allowed = new Set(["text", "delivery", "resume", "metadata"]);
  if (Array.isArray(body.required) && body.required.some((name) => !allowed.has(name))) invalid();
  if (!Array.isArray(body.required) || !body.required.includes("text")) invalid();
  requireField(document, body, "text", "string", true);
  const delivery = fieldSchema(document, body, "delivery");
  if (!supportsValue(document, delivery, "string", "queue")) invalid();
  if (!supportsValue(document, fieldSchema(document, body, "resume"), "boolean", true)) invalid();
  requireField(document, body, "metadata", "object");
}

function validateResumeCommandRequest(document, operation) {
  const requestBody = operation.requestBody;
  const schema = requestBody?.content?.["application/json"]?.schema;
  if (requestBody?.required !== true || !isRecord(schema)) invalid();
  const body = objectBranch(document, schema);
  if (!Array.isArray(body.required) || body.required.length !== 2 ||
      new Set(body.required).size !== 2 || !body.required.includes("name") || !body.required.includes("text")) invalid();
  const name = requireField(document, body, "name", "string", true);
  const text = requireField(document, body, "text", "string", true);
  if (!supportsStringValue(document, name, "resume_goal") || !supportsStringValue(document, text, "")) invalid();
  if (!supportsValue(document, fieldSchema(document, body, "delivery"), "string", "queue")) invalid();
  if (!isRecord(operation.responses) || !Object.hasOwn(operation.responses, "204") || !isRecord(operation.responses["204"])) invalid();
}

function validateDocumentBounds(document) {
  const paths = Object.entries(document.paths);
  if (paths.length > MAX_OPENAPI_PATHS) invalid();
  const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
  let operations = 0;
  for (const [, pathItem] of paths) {
    if (!isRecord(pathItem)) invalid();
    for (const [name, operation] of Object.entries(pathItem)) {
      if (!methods.has(name)) continue;
      operations += 1;
      if (operations > MAX_OPENAPI_OPERATIONS || !isRecord(operation)) invalid();
    }
  }
}

export function qualifyOpenApi(document, requireResumeCommand = false) {
  try {
    if (typeof requireResumeCommand !== "boolean" || !isRecord(document) || typeof document.openapi !== "string" || !/^3\./.test(document.openapi) || !isRecord(document.paths)) {
      invalid();
    }
    validateDocumentBounds(document);
    const info = validateOperation(document, "/api/info", "get", []);
    const session = validateOperation(document, "/api/session/{sessionID}", "get", ["sessionID"]);
    const inbox = validateOperation(document, "/api/session/{sessionID}/inbox", "get", ["sessionID"]);
    const messages = validateOperation(document, "/api/session/{sessionID}/message", "get", ["sessionID"], ["limit", "type"]);
    validateMessageQuery(document, messages, document.paths["/api/session/{sessionID}/message"]);
    const prompt = validateOperation(document, "/api/session/{sessionID}/prompt", "post", ["sessionID"]);
    let command;
    if (requireResumeCommand) command = validateOperation(document, "/api/session/{sessionID}/command", "post", ["sessionID"]);

    validateServerInfo(document, info);
    const sessionData = responseDataSchema(document, session);
    const sessionObject = objectBranch(document, sessionData);
    for (const name of ["id", "projectID", "cost", "tokens", "location", "time"]) {
      if (!isRequired(sessionObject, name)) invalid();
    }
    requireField(document, sessionObject, "id", "string", true);
    requireField(document, sessionObject, "projectID", "string", true);
    requireField(document, sessionObject, "cost", "number", true);
    if (Object.hasOwn(sessionObject.properties, "agent")) requireField(document, sessionObject, "agent", "string");
    const tokens = objectBranch(document, fieldSchema(document, sessionObject, "tokens"));
    for (const name of ["input", "output", "reasoning"]) requireField(document, tokens, name, "number", true);
    const cache = objectBranch(document, fieldSchema(document, tokens, "cache"));
    requireField(document, cache, "read", "number", true);
    requireField(document, cache, "write", "number", true);
    const location = objectBranch(document, fieldSchema(document, sessionObject, "location"));
    requireField(document, location, "directory", "string", true);
    const time = objectBranch(document, fieldSchema(document, sessionObject, "time"));
    requireField(document, time, "created", "number", true);
    requireField(document, time, "updated", "number", true);
    if (Object.hasOwn(time.properties, "archived")) requireField(document, time, "archived", "number");
    if (Object.hasOwn(sessionObject.properties, "subpath")) requireField(document, sessionObject, "subpath", "string");

    validateInboxResponse(document, inbox);
    validateMessagePage(document, messages);
    validateInboxUser(document, responseDataSchema(document, prompt));
    validatePromptRequest(document, prompt);
    if (command) validateResumeCommandRequest(document, command);
    return true;
  } catch {
    return false;
  }
}
