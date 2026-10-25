// Type declarations for OpenAgentd v3 plugins (`import … from "openagentd"`).
//
// A plugin is any `*.ts` / `*.js` file in a plugins directory
// (`{OPENAGENTD_CONFIG_DIR}/plugins`, or `OPENAGENTD_PLUGINS_DIRS`). Files whose
// name starts with `_` are helper modules: they are not loaded on their own but
// can be imported with a relative path (`import { x } from "./_util.ts"`).
//
// What a file provides is decided by its exports:
//   export const provider: ProviderPlugin      → an LLM provider (OAuth / API key)
//   export async function plugin(): ToolHooks  → tool hooks (v2 functional contract)
// A file that exports `provider` is only a provider plugin.
//
// Plugins run in QuickJS (ES2023). There is no Node.js / npm; use the APIs below.

declare module "openagentd" {
  // ── plugin shapes ───────────────────────────────────────────────────────

  export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

  export interface ToolInput {
    tool: string;
    session_id: string | null;
    run_id: string;
    agent_name: string;
    call_id: string;
  }
  export interface ToolAfterInput extends ToolInput {
    args: any;
  }
  /** Returned by `plugin()`. Throwing in `tool.before` aborts the call (the error becomes the tool result). */
  export interface ToolHooks {
    /** Mutate (or replace) `output.args` to change the call's arguments. */
    "tool.before"?: (input: ToolInput, output: { args: any }) => void | Promise<void>;
    /** Replace `output.output` to change the result the model sees. */
    "tool.after"?: (input: ToolAfterInput, output: { output: string }) => void | Promise<void>;
    /** Limit the hooks to some agents (like v2, `role` is currently always "agent"). */
    applies_to?: (agentName: string, role: string) => boolean;
  }

  export interface CredentialField {
    name: string;
    label: string;
    secret?: boolean;
    required?: boolean;
    placeholder?: string;
  }

  /** Scoped credentials and account caches. Legacy stores retain per-provider cache paths. */
  export interface CredentialStore {
    readonly providerId: string;
    /** The selected account/key, or null for a legacy/provider-wide store. */
    readonly credentialId: string | null;
    /** Saved credential / environment value, or `dflt` when unset. */
    get(name: string, dflt?: string): string;
    /** OAuth operations require an account-scoped store. Missing tokens return null. */
    readOAuth(): Record<string, Json> | null;
    /** Atomic write to an existing account. False means `expected` lost a refresh race. */
    writeOAuth(document: Record<string, Json>, options?: { expected?: Json; label?: string }): boolean;
    /** Keep the account but revoke its tokens; optionally compare the previous document. */
    removeOAuth(expected?: Json): boolean;
    /** Account-scoped cache path; OAuth tokens belong in readOAuth/writeOAuth instead. */
    tokenPath(file: string): string;
    /** Parsed JSON object, or `{}` when missing / invalid. */
    readJson(file: string): Record<string, any>;
    writeJson(file: string, value: Json): void;
    remove(file: string): void;
  }

  /** Receives OAuth progress events (`started`, `device_code`, `code_required`, `token_acquired`, `success`, `failed`). */
  export type OAuthEmit = (event: string, data: Record<string, Json>) => void;

  export interface BuildContext {
    providerId: string;
    credentialId: string | null;
    model: string;
    modelKwargs: Record<string, Json>;
    credentials: CredentialStore;
  }

  export interface OAuthContext {
    providerId: string;
    credentialId: string;
    credentials: CredentialStore;
  }

  export interface UsageWindow {
    used_percent: number;
    window_minutes?: number | null;
    resets_at?: number | null;
  }
  export interface UsageLimit {
    limit_id?: string | null;
    limit_name?: string | null;
    primary?: UsageWindow | null;
    secondary?: UsageWindow | null;
    credits?: Json;
    spend?: Json;
    plan_type?: string | null;
    rate_limit_reached_type?: string | null;
    reset_credits_available?: number | null;
    period_start_at?: number | null;
    period_end_at?: number | null;
  }
  export interface UsageResponse {
    provider: string;
    limits: UsageLimit[];
  }

  export interface ProviderPlugin {
    id: string;
    label: string;
    description: string;
    kind: "api_key" | "oauth";
    credentials?: CredentialField[];
    modelsDevProviderId?: string;
    metadataSourceProvider?: string;
    modelRegistryAliases?: Record<string, string>;
    docsUrl?: string;
    oauthCommand?: string;
    supportsFastMode?: boolean;
    supportsPromptCacheKey?: boolean;
    /** Opt in only when instances, login, refresh and caches are isolated per account. */
    supportsMultipleCredentials?: boolean;

    /** Create a provider instance for one model. Throw `ValueError` for missing credentials. */
    build(ctx: BuildContext): ProviderInstance | Promise<ProviderInstance>;
    /** Required for `kind: "oauth"`. May run until the flow finishes (e.g. waiting for a local callback). */
    login?(emit: OAuthEmit, ctx: OAuthContext): void | Promise<void>;
    /** Handles a pasted callback URL / code. */
    oauthCallback?(code: string, emit: OAuthEmit, ctx: OAuthContext): void | Promise<void>;
    isConfigured?(credentials: CredentialStore): boolean;
    discoverModels?(credentials: CredentialStore): string[] | Promise<string[]>;
    /** Throw `ValueError` for a credentials problem. */
    getUsage?(credentials: CredentialStore): UsageResponse | Promise<UsageResponse>;
  }

  // Internal chat schema (snake_case, as stored in the database).
  export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string; thought?: Json; thought_signature?: string | null };
  }
  export type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image_url"; url: string; media_type?: string; detail?: string }
    | { type: "image_data"; data: string; media_type: string };
  export interface MessageMeta {
    exclude_from_context?: boolean;
    kind?: string;
    pinned?: boolean;
    extra?: Record<string, Json> | null;
    db_id?: string | null;
  }
  export interface SystemMessage { role: "system"; content: string | null; meta?: MessageMeta }
  export interface UserMessage { role: "user"; content: string | null; parts?: ContentBlock[] | null; meta?: MessageMeta }
  export interface AssistantMessage {
    role: "assistant";
    content?: string | null;
    reasoning_content?: string | null;
    reasoning_signature?: string | null;
    redacted_thinking_blocks?: Json[] | null;
    raw_content_blocks?: Json[] | null;
    reasoning_items?: Json[] | null;
    tool_calls?: ToolCall[] | null;
    agent_id?: string | null;
    agent_name?: string | null;
    meta?: MessageMeta;
  }
  export interface ToolMessage { role: "tool"; content: string | null; tool_call_id: string; name?: string | null; parts?: ContentBlock[] | null; meta?: MessageMeta }
  export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;
  /** OpenAI-style tool spec: `{type: "function", function: {name, description, parameters}}`. */
  export type ToolSpec = Record<string, any>;

  export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
    thoughts_tokens?: number | null;
    tool_use_tokens?: number | null;
  }
  export interface Delta {
    role?: string | null;
    content?: string | null;
    reasoning_content?: string | null;
    reasoning_signature?: string | null;
    tool_calls?: { index?: number | null; id?: string | null; function?: { name?: string | null; arguments?: string | null; thought?: Json; thought_signature?: string | null } | null }[] | null;
    [k: string]: any;
  }
  export interface Chunk {
    id: string;
    created: number;
    model: string;
    choices: { index: number; delta: Delta; finish_reason?: string | null }[];
    usage?: Usage | null;
  }

  export interface ModelCall {
    messages: ChatMessage[];
    tools: ToolSpec[] | null;
    /** Model kwargs merged with this call's kwargs. */
    kwargs: Record<string, Json>;
    stream: boolean;
  }

  interface InstanceCommon {
    /** Default: the build context's provider id. */
    providerName?: string | null;
    /** Model id used for cost lookups; `null` disables them. Default: `providerName:model`. */
    costModelId?: string | null;
    /** Whether an interrupt may abort an in-flight stream. Default: true. */
    supportInterrupt?: boolean;
  }

  /** Reuse the built-in Anthropic Messages provider, adjusting requests and responses. */
  export interface AnthropicInstance extends InstanceCommon {
    base: "anthropic";
    options: {
      apiKey: string;
      baseUrl?: string;
      headers?: Record<string, string> | [string, string][];
      useApiKeyHeader?: boolean;
      /** Always use `/v1/messages?beta=true`. */
      beta?: boolean;
      /** Per-read timeout in ms; `null` = none. Default 120000. */
      timeoutMs?: number | null;
    };
    /** Runs before each request; returned values replace the auth headers. */
    beforeCall?(call: { stream: boolean }): void | { apiKey?: string; headers?: Record<string, string> | [string, string][] } | Promise<void | { apiKey?: string; headers?: Record<string, string> | [string, string][] }>;
    transformInput?(call: ModelCall): { messages?: ChatMessage[]; tools?: ToolSpec[] | null } | Promise<{ messages?: ChatMessage[]; tools?: ToolSpec[] | null }>;
    transformChunk?(chunk: Chunk): Chunk | Promise<Chunk>;
    transformResponse?(message: AssistantMessage): AssistantMessage | Promise<AssistantMessage>;
  }

  export interface HttpRequest {
    url: string;
    method?: string;
    headers?: Record<string, string> | [string, string][];
    /** Sent as JSON. */
    body: Json;
    /** Non-streaming: whole request; streaming: until response headers. */
    timeoutMs?: number | null;
  }
  export interface HttpErrorInfo {
    status: number;
    url: string;
    headers: [string, string][];
    body: string;
    stream: boolean;
  }
  export interface StreamEvent {
    delta?: Delta;
    finishReason?: string | null;
    usage?: Usage | null;
  }
  export interface StreamParser {
    /** Called for each SSE `data:` JSON payload. */
    event(data: any): StreamEvent | StreamEvent[] | null | undefined | Promise<StreamEvent | StreamEvent[] | null | undefined>;
  }
  /** A provider speaking its own HTTP/SSE protocol; OpenAgentd performs the I/O. */
  export interface HttpInstance extends InstanceCommon {
    base: "http";
    request(call: ModelCall): HttpRequest | Promise<HttpRequest>;
    /** Throw a `ProviderError` to replace the default HTTP error. */
    onError?(err: HttpErrorInfo): void | Promise<void>;
    streamParser(call: ModelCall): StreamParser | Promise<StreamParser>;
    parseResponse(data: any): { message: AssistantMessage; usage?: Usage | null } | Promise<{ message: AssistantMessage; usage?: Usage | null }>;
  }

  export type ProviderInstance = AnthropicInstance | HttpInstance;

  /** Identity helper that type-checks a provider plugin. */
  export function definePlugin(p: ProviderPlugin): ProviderPlugin;
  export function defineProvider(p: ProviderPlugin): ProviderPlugin;
  /** The credential store of any provider (v2 `ProviderCredentialStore(id)`). */
  export function credentialStore(providerId: string, overrides?: Record<string, string>): CredentialStore;

  // ── errors (mapped to OpenAgentd provider errors) ───────────────────────
  export class ProviderError extends Error {
    kind: string;
    constructor(message: string, opts?: Record<string, any>);
  }
  /** Credentials rejected (e.g. a failed OAuth refresh). */
  export class AuthError extends ProviderError {}
  /** Invalid configuration / missing credentials (Python `ValueError`). */
  export class ValueError extends ProviderError {}
  export class UnconfiguredError extends ProviderError {}
  /** Transient transport failure (retried). */
  export class NetworkError extends ProviderError {}
  export class HttpError extends ProviderError {
    status: number;
    body?: string;
    headers?: [string, string][];
    constructor(status: number, message: string, opts?: { body?: string; headers?: [string, string][] });
  }

  // ── runtime APIs ────────────────────────────────────────────────────────
  export const log: { debug(...a: any[]): void; info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void };
  export function sleep(ms: number): Promise<void>;

  export class Headers {
    constructor(init?: Record<string, string> | [string, string][] | Headers);
    get(name: string): string | null;
    has(name: string): boolean;
    set(name: string, value: string): void;
    append(name: string, value: string): void;
    delete(name: string): void;
    entries(): [string, string][];
    toObject(): Record<string, string>;
  }
  export class Response {
    readonly status: number;
    readonly statusText: string;
    readonly ok: boolean;
    readonly url: string;
    readonly headers: Headers;
    text(): Promise<string>;
    json(): Promise<any>;
  }
  export interface FetchInit {
    method?: string;
    headers?: Record<string, string> | [string, string][] | Headers;
    body?: string | Uint8Array | null;
    /** JSON body (sets `Content-Type: application/json`). */
    json?: any;
    /** Form body, Python `urlencode` encoding. */
    form?: Record<string, string> | [string, string][];
    /** Whole-request timeout in ms. */
    timeout?: number;
  }
  /** Buffered fetch. Transport failures throw `NetworkError` (`timeout` / `connect` flags set). */
  export function fetch(url: string, init?: FetchInit): Promise<Response>;

  export const crypto: {
    randomBytes(n: number): Uint8Array;
    randomHex(n: number): string;
    randomUUID(): string;
    uuid7(): string;
    sha256(data: string | Uint8Array): Uint8Array;
    sha256Hex(data: string | Uint8Array): string;
    getRandomValues<T extends ArrayBufferView>(arr: T): T;
  };
  export const base64: {
    encode(data: string | Uint8Array, opts?: { url?: boolean; pad?: boolean }): string;
    decode(text: string, opts?: { url?: boolean }): Uint8Array;
  };
  export const utf8: { encode(s: string): Uint8Array; decode(b: Uint8Array): string };
  /** Python `urllib.parse` semantics. */
  export const url: {
    quotePlus(s: string): string;
    encodeForm(pairs: Record<string, string> | [string, string][]): string;
    /** `parse_qs`: blank values dropped. */
    parseQuery(qs: string): Record<string, string[]>;
    /** `urlparse(text).query`. */
    queryOf(text: string): string;
  };
  export const env: { get(name: string): string | null; all(): Record<string, string> };
  export const fs: {
    readText(path: string): string | null;
    writeText(path: string, text: string): void;
    exists(path: string): boolean;
    remove(path: string): boolean;
    mkdir(path: string): void;
  };
  export const subprocess: {
    /** stdin is closed unless `input` is given. */
    run(cmd: string, args?: string[], opts?: { timeoutMs?: number; input?: string; cwd?: string }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
    which(name: string): string | null;
  };
  export interface IncomingRequest {
    method: string;
    target: string;
    path: string;
    query: string;
    headers: [string, string][];
    respond(status: number, reason?: string, opts?: { headers?: Record<string, string> | [string, string][]; body?: string }): Promise<void>;
  }
  /** A minimal local HTTP server (OAuth redirect callbacks). Bind failures throw. */
  export function listen(opts?: { host?: string; port?: number }): Promise<{ port: number; accept(timeoutMs?: number): Promise<IncomingRequest | null>; close(): void }>;

  /** Python `json.dumps` text (for values stored alongside v2). */
  export function pyJsonDumps(value: any): string;
  export function pyRepr(s: string): string;
  /** Python `datetime.fromisoformat(...).timestamp()` in seconds, or null. */
  export function parseIsoTimestamp(text: string | null | undefined): number | null;
  /** httpx `raise_for_status()` message. */
  export function httpStatusMessage(status: number, url: string): string;
  /** Built-in Gemini conversions (the googlegenai provider's). */
  export const gemini: {
    convertMessages(messages: ChatMessage[]): { contents: any[]; systemInstruction: any | null };
    normalizeTurns(contents: any[]): any[];
    convertTools(tools: ToolSpec[] | null): any[] | null;
  };
  export interface RegexMatch {
    text: string;
    /** UTF-16 offsets, usable with `String.prototype.slice`. */
    index: number;
    end: number;
    /** Capture groups 1..n (`undefined` when a group did not participate). */
    groups: (string | undefined)[];
    named: Record<string, string | undefined>;
  }
  export interface NativeRegex {
    readonly source: string;
    readonly flags: string;
    readonly groupNames: Record<string, number>;
    test(text: string): boolean;
    find(text: string): RegexMatch | null;
    findAll(text: string): RegexMatch[];
    /** `re.subn`: string replacements expand `$0`, `$1`, `$<name>`, `$$`. */
    subn(text: string, repl: string | ((m: RegexMatch) => string)): [string, number];
    replace(text: string, repl: string | ((m: RegexMatch) => string)): string;
  }
  /**
   * Native regular expressions in Python-style syntax (`\b`, `\s`, `\w` are
   * Unicode-aware; `(?P<name>…)`, `(?P=name)`). Linear-time unless the pattern
   * needs lookaround or back-references. Much faster than `RegExp` for
   * scanning large tool output; compile once and reuse. One difference from
   * Python: `\s` is Unicode White_Space, which excludes `\x1c`–`\x1f`.
   */
  export const regex: {
    /** Flags: `i` ignore case, `m` multi-line, `s` dot matches newline, `x` verbose. Throws `SyntaxError`. */
    compile(pattern: string, flags?: string): NativeRegex;
  };
  /** Call a native function registered by OpenAgentd. */
  export function native(name: string, arg?: any): any;
  export const platform: "macos" | "linux" | "windows" | string;
  export const version: string;

  const api: {
    log: typeof log; sleep: typeof sleep; fetch: typeof fetch; crypto: typeof crypto; base64: typeof base64; utf8: typeof utf8; url: typeof url;
    env: typeof env; fs: typeof fs; subprocess: typeof subprocess; listen: typeof listen; platform: string; version: string;
  };
  export default api;
}
