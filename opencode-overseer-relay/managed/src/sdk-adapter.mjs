import {
  discover as discoverService,
  headers as serviceHeaders,
} from "@opencode/client/service";

export const sdkAdapter = Object.freeze({
  discover: discoverService,
  headers: serviceHeaders,
});
