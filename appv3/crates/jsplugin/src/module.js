// The `openagentd` module seen by plugins (`import { fetch } from "openagentd"`).
const api = globalThis.__oad_api;
export const {
  definePlugin, defineProvider, defineTool, log, sleep, fetch, Headers, Response, crypto, base64, utf8, url, env, fs, subprocess, listen,
  pyJsonDumps, pyRepr, parseIsoTimestamp, httpStatusMessage, gemini, regex, native, credentialStore,
  ProviderError, AuthError, ValueError, UnconfiguredError, NetworkError, HttpError, PermissionError, platform, version, bundle,
} = api;
export default api;
