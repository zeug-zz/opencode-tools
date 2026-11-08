// src/promise/media.ts
var MEDIA_URI_CAPABILITY = "experimental-media-uri";
var CAPABILITIES_HEADER = "X-OpenCode-Capabilities";
var MEDIA_REF = /^media:([0-9a-f]{64})$/;
function mediaHashFromUri2(uri) {
  if (!uri)
    return;
  return MEDIA_REF.exec(uri)?.[1];
}
function withMediaRefs2(api) {
  return {
    ...api,
    message: {
      ...api.message,
      list: (input, options) => api.message.list(input, mediaRefOptions(options))
    },
    session: {
      ...api.session,
      message: {
        ...api.session.message,
        get: (input, options) => api.session.message.get(input, mediaRefOptions(options))
      },
      inbox: {
        ...api.session.inbox,
        list: (input, options) => api.session.inbox.list(input, mediaRefOptions(options))
      }
    }
  };
}
function mediaRefOptions(options) {
  if (options?.mediaRefs === false)
    return options;
  const headers = new Headers(options?.headers);
  headers.set(CAPABILITIES_HEADER, MEDIA_URI_CAPABILITY);
  return { ...options, headers };
}

export { mediaHashFromUri2, withMediaRefs2 };
