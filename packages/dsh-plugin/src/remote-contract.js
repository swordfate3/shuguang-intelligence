/**
 * Hand-authored strict Typert descriptors for the installed DSH 0.2.1-rc.2
 * runtime contract. This is not a generator artifact and needs no SDK or Zod
 * import. Register TYPERT explicitly on the Host and mount REMOTE_INFO on the
 * Client; do not also publish this as an automatically loaded ./typert export.
 *
 * The business API carries command text and a serialized Dawn response only.
 * It contains no Agent/Session lookup, credential, endpoint, or model context.
 */
export const PACKAGE_NAME = "@shuguang/dsh-plugin";
export const MAX_COMMAND_CHARS = 16_004;
export const MAX_RESPONSE_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** @param {unknown} value @returns {string} */
function parseCommand(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_COMMAND_CHARS) {
    throw new TypeError("Invalid Shuguang command text");
  }
  return value;
}

/** @param {unknown} value @returns {string} */
function parseResponse(value) {
  if (typeof value !== "string" || value.length > MAX_RESPONSE_BYTES ||
      encoder.encode(value).byteLength > MAX_RESPONSE_BYTES) {
    throw new TypeError("Invalid Shuguang response size");
  }
  // Domain validation belongs to the Host's existing Dawn HTTP transport.
  // Reject malformed serialization here without importing Node/Buffer code.
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Expected a response object");
    }
  } catch {
    throw new TypeError("Invalid Shuguang response JSON");
  }
  return value;
}

const commandSchema = Object.freeze({ parse: parseCommand });
const responseSchema = Object.freeze({ parse: parseResponse });
const commandCodec = Object.freeze({
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#shuguang/command:input`,
  create: () => commandSchema,
  jsonSchema: { type: "string", minLength: 1, maxLength: MAX_COMMAND_CHARS },
});
const responseCodec = Object.freeze({
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#shuguang/command:result`,
  create: () => responseSchema,
  // Gateway does not otherwise parse JSON-only Host results; enforce the
  // bound during Host encoding as well as Client decoding.
  encode: parseResponse,
  decode: parseResponse,
});

const descriptor = Object.freeze({
  id: `${PACKAGE_NAME}#shuguang/command`,
  service: "shuguang",
  namespace: "shuguang",
  method: "command",
  invocation: Object.freeze({ kind: "direct" }),
  parameters: Object.freeze([
    Object.freeze({
      name: "input",
      wire: "input",
      source: "json",
      codec: commandCodec,
      strictCodec: commandCodec,
    }),
  ]),
  cancellation: Object.freeze({ parameter: "signal" }),
  result: responseCodec,
});
const descriptors = Object.freeze([descriptor]);

/** Mount once through await ctx.remote.$mount(REMOTE_INFO) on the Client. */
export const REMOTE_INFO = Object.freeze({ package: PACKAGE_NAME, descriptors });

/** Register once through ctx.typert.register(TYPERT) on the Host. */
export const TYPERT = Object.freeze({
  package: PACKAGE_NAME,
  face: "host",
  schemas: Object.freeze([]),
  model: Object.freeze({ services: [], events: [], objects: [] }),
  invocations: descriptors,
});
