// OpenAgentd plugin runtime prelude. Evaluated once per plugin runtime before
// the plugin module is imported. Builds the `openagentd` module API on top of
// the two raw native entry points (`__n.sync` / `__n.async`), plus the bridge
// functions the Rust host calls (`__oad_invoke`, `__oad_drop`, `__oad_error`,
// `__oad_describe`).
(() => {
  "use strict";
  const N = globalThis.__n;
  delete globalThis.__n;

  // ── errors ────────────────────────────────────────────────────────────────
  class ProviderError extends Error {
    constructor(message, opts) {
      super(message);
      this.name = new.target.name;
      this.kind = "other";
      if (opts) Object.assign(this, opts);
    }
  }
  class AuthError extends ProviderError {
    constructor(message, opts) { super(message, opts); this.kind = "auth"; }
  }
  class ValueError extends ProviderError {
    constructor(message, opts) { super(message, opts); this.kind = "invalid"; }
  }
  class UnconfiguredError extends ProviderError {
    constructor(message, opts) { super(message, opts); this.kind = "unconfigured"; }
  }
  class NetworkError extends ProviderError {
    constructor(message, opts) { super(message, opts); this.kind = "network"; }
  }
  class HttpError extends ProviderError {
    constructor(status, message, opts) { super(message, opts); this.kind = "http"; this.status = status; }
  }
  const ERRORS = { ProviderError, AuthError, ValueError, UnconfiguredError, NetworkError, HttpError, TypeError, RangeError, SyntaxError };

  function makeError(e) {
    const C = ERRORS[e.name] || Error;
    const x = C === HttpError ? new HttpError((e.props && e.props.status) || 0, e.message) : new C(e.message);
    if (e.props) Object.assign(x, e.props);
    return x;
  }
  function unwrap(s) {
    const r = JSON.parse(s);
    if ("err" in r) throw makeError(r.err);
    return r.ok;
  }
  const enc = (v) => JSON.stringify(v === undefined ? null : v);
  const sync = (name, arg) => unwrap(N.sync(name, enc(arg)));
  const call = async (name, arg) => unwrap(await N.async(name, enc(arg)));
  const native = (name, arg) => sync("native", { name, arg: arg === undefined ? null : arg });

  // ── bytes ─────────────────────────────────────────────────────────────────
  const HEX = "0123456789abcdef";
  function toHex(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
    return s;
  }
  function fromHex(h) {
    const out = new Uint8Array(h.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function bytesArg(data) {
    if (typeof data === "string") return { text: data };
    if (data instanceof Uint8Array) return { hex: toHex(data) };
    if (data instanceof ArrayBuffer) return { hex: toHex(new Uint8Array(data)) };
    if (ArrayBuffer.isView(data)) return { hex: toHex(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
    throw new TypeError("expected a string or Uint8Array");
  }
  const utf8 = {
    encode: (s) => fromHex(sync("utf8Encode", { text: String(s) })),
    decode: (b) => sync("utf8Decode", bytesArg(b)),
  };
  const base64 = {
    encode: (data, opts = {}) => sync("base64Encode", { ...bytesArg(data), url: !!opts.url, pad: opts.pad ?? !opts.url }),
    decode: (text, opts = {}) => fromHex(sync("base64Decode", { text: String(text), url: !!opts.url })),
  };
  const crypto = {
    randomBytes: (n) => fromHex(sync("randomHex", { n })),
    randomHex: (n) => sync("randomHex", { n }),
    randomUUID: () => sync("uuid", { version: 4 }),
    uuid7: () => sync("uuid", { version: 7 }),
    sha256: (data) => fromHex(sync("sha256", bytesArg(data))),
    sha256Hex: (data) => sync("sha256", bytesArg(data)),
    getRandomValues(arr) {
      const b = fromHex(sync("randomHex", { n: arr.byteLength }));
      new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(b);
      return arr;
    },
  };

  // ── logging / timers ──────────────────────────────────────────────────────
  function show(x) {
    if (typeof x === "string") return x;
    if (x instanceof Error) return x.stack ? `${x}\n${x.stack}` : String(x);
    try {
      const s = JSON.stringify(x);
      return s === undefined ? String(x) : s;
    } catch {
      return String(x);
    }
  }
  const fmt = (a) => a.map(show).join(" ");
  const log = {
    debug: (...a) => N.log("debug", fmt(a)),
    info: (...a) => N.log("info", fmt(a)),
    warn: (...a) => N.log("warn", fmt(a)),
    error: (...a) => N.log("error", fmt(a)),
  };
  const sleep = (ms) => call("sleep", { ms: Math.max(0, Number(ms) || 0) });
  const timers = new Map();
  let timerSeq = 0;
  function setTimeout(fn, ms, ...args) {
    const id = ++timerSeq;
    timers.set(id, true);
    sleep(ms).then(() => {
      if (timers.delete(id)) fn(...args);
    });
    return id;
  }
  function clearTimeout(id) {
    timers.delete(id);
  }
  function setInterval(fn, ms, ...args) {
    const id = ++timerSeq;
    timers.set(id, true);
    const tick = () => sleep(ms).then(() => {
      if (!timers.has(id)) return;
      fn(...args);
      tick();
    });
    tick();
    return id;
  }

  // ── fetch ─────────────────────────────────────────────────────────────────
  function headerPairs(h) {
    if (!h) return [];
    if (h instanceof Headers) return h.entries();
    if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)]);
    return Object.entries(h).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]);
  }
  class Headers {
    constructor(init) { this._p = headerPairs(init); }
    get(name) {
      const n = String(name).toLowerCase();
      const v = this._p.filter(([k]) => k.toLowerCase() === n).map(([, x]) => x);
      return v.length ? v.join(", ") : null;
    }
    has(name) { return this.get(name) !== null; }
    set(name, value) { this.delete(name); this._p.push([String(name), String(value)]); }
    append(name, value) { this._p.push([String(name), String(value)]); }
    delete(name) { const n = String(name).toLowerCase(); this._p = this._p.filter(([k]) => k.toLowerCase() !== n); }
    entries() { return this._p.map(([k, v]) => [k, v]); }
    toObject() { const o = {}; for (const [k, v] of this._p) o[k] = v; return o; }
    [Symbol.iterator]() { return this.entries()[Symbol.iterator](); }
  }
  class Response {
    constructor(r) {
      this.status = r.status;
      this.statusText = r.statusText;
      this.ok = r.status >= 200 && r.status < 300;
      this.url = r.url;
      this.headers = new Headers(r.headers);
      this._body = r.body;
    }
    async text() { return this._body; }
    async json() { return JSON.parse(this._body); }
  }
  async function fetch(input, init = {}) {
    const headers = new Headers(init.headers);
    let body = init.body ?? null;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
    } else if (init.form !== undefined) {
      body = url.encodeForm(init.form);
      if (!headers.has("content-type")) headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    if (body !== null && typeof body !== "string") body = bytesArg(body).text ?? utf8.decode(body);
    const method = (init.method || (body !== null ? "POST" : "GET")).toUpperCase();
    const r = await call("fetch", { url: String(input), method, headers: headers.entries(), body, timeoutMs: init.timeout ?? null });
    return new Response(r);
  }

  // ── url helpers (Python urllib semantics) ─────────────────────────────────
  const quotePlus = (s) =>
    encodeURIComponent(String(s))
      .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
      .replace(/%20/g, "+");
  const url = {
    quotePlus,
    encodeForm(pairs) {
      const list = Array.isArray(pairs) ? pairs : Object.entries(pairs);
      return list.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
    },
    parseQuery: (qs) => sync("parseQuery", { text: String(qs) }),
    queryOf: (text) => sync("urlQuery", { text: String(text) }),
  };

  // ── system ────────────────────────────────────────────────────────────────
  const env = {
    get: (name) => sync("envGet", { name: String(name) }),
    all: () => sync("envAll", null),
  };
  const fs = {
    readText: (path) => sync("readText", { path: String(path) }),
    writeText: (path, text) => sync("writeText", { path: String(path), text: String(text) }),
    exists: (path) => sync("exists", { path: String(path) }),
    remove: (path) => sync("remove", { path: String(path) }),
    mkdir: (path) => sync("mkdir", { path: String(path) }),
  };
  const subprocess = {
    run: (cmd, args = [], opts = {}) =>
      call("run", { cmd: String(cmd), args: args.map(String), timeoutMs: opts.timeoutMs ?? null, input: opts.input ?? null, cwd: opts.cwd ?? null }),
    which: (name) => sync("which", { name: String(name) }),
  };
  async function listen(opts = {}) {
    const s = await call("listen", { host: opts.host ?? "127.0.0.1", port: opts.port ?? 0 });
    return {
      port: s.port,
      async accept(timeoutMs) {
        const q = await call("accept", { id: s.id, timeoutMs: timeoutMs ?? null });
        if (q === null) return null;
        const conn = q.conn;
        delete q.conn;
        q.respond = (status, reason, o = {}) =>
          call("respond", { conn, status, reason: reason ?? "", headers: headerPairs(o.headers), body: o.body ?? null });
        return q;
      },
      close: () => sync("close", { id: s.id }),
    };
  }

  // ── python-compatible helpers ─────────────────────────────────────────────
  const pyJsonDumps = (value) => sync("pyJsonDumps", { value });
  function pyRepr(s) {
    s = String(s);
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of s) {
      if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch === q) out += "\\" + ch;
      else {
        const c = ch.codePointAt(0);
        out += c < 0x20 || c === 0x7f ? "\\x" + c.toString(16).padStart(2, "0") : ch;
      }
    }
    return out + q;
  }
  const parseIsoTimestamp = (text) => sync("parseIso", { text: text == null ? null : String(text) });
  const httpStatusMessage = (status, u) => native("http.statusMessage", { status, url: String(u) });

  // ── provider helpers ──────────────────────────────────────────────────────
  function credentials(c) {
    const id = c.providerId;
    const overrides = c.overrides || {};
    const scope = { provider: id, credentialId: c.credentialId, overrides, pinned: c.pinned };
    const store = {
      providerId: id,
      credentialId: c.credentialId ?? null,
      get(name, dflt = "") {
        const v = native("creds.get", { ...scope, name: String(name) });
        return v ? v : dflt;
      },
      readOAuth: () => native("creds.oauth", { ...scope, action: "read" }),
      writeOAuth: (document, options = {}) => native("creds.oauth", { ...scope, action: "write", document, ...options }),
      removeOAuth: (...expected) => native("creds.oauth", { ...scope, action: "remove", ...(expected.length ? { expected: expected[0] } : {}) }),
      tokenPath: (file) => sync("tokenPath", { provider: id, credentialId: c.credentialId, file: String(file) }),
      readJson(file) {
        const t = sync("readText", { path: store.tokenPath(file) });
        if (t == null) return {};
        try {
          const v = JSON.parse(t);
          return v && typeof v === "object" && !Array.isArray(v) ? v : {};
        } catch {
          return {};
        }
      },
      writeJson(file, obj) {
        sync("writeText", { path: store.tokenPath(file), text: pyJsonDumps(obj) });
      },
      remove(file) {
        sync("remove", { path: store.tokenPath(file) });
      },
    };
    return store;
  }
  const gemini = {
    convertMessages: (messages) => native("gemini.convertMessages", messages),
    normalizeTurns: (contents) => native("gemini.normalizeTurns", contents),
    convertTools: (tools) => native("gemini.convertTools", tools ?? null),
  };

  // ── regex (native; Python-style syntax) ───────────────────────────────────
  const expandReplacement = (t, m) =>
    t.replace(/\$(\$|\d+|<([^>]+)>)/g, (_all, x, name) =>
      x === "$" ? "$" : name !== undefined ? (m.named[name] ?? "") : x === "0" ? m.text : (m.groups[Number(x) - 1] ?? ""));
  class NativeRegex {
    constructor(source, flags) {
      const r = sync("reCompile", { pattern: source, flags });
      this.source = source;
      this.flags = flags;
      this.groupNames = r.names;
      Object.defineProperty(this, "_id", { value: r.id });
      Object.freeze(this);
    }
    _match(text, s) {
      const groups = [];
      for (let k = 2; k < s.length; k += 2) groups.push(s[k] < 0 ? undefined : text.slice(s[k], s[k + 1]));
      const named = {};
      for (const [n, i] of Object.entries(this.groupNames)) named[n] = groups[i - 1];
      return { text: text.slice(s[0], s[1]), index: s[0], end: s[1], groups, named };
    }
    _spans(text, all) { return unwrap(N.re(all ? "all" : "first", this._id, text)); }
    test(text) { return unwrap(N.re("test", this._id, String(text))); }
    find(text) {
      text = String(text);
      const s = this._spans(text, false);
      return s.length ? this._match(text, s[0]) : null;
    }
    findAll(text) {
      text = String(text);
      return this._spans(text, true).map((s) => this._match(text, s));
    }
    subn(text, repl) {
      text = String(text);
      const spans = this._spans(text, true);
      if (!spans.length) return [text, 0];
      let out = "", last = 0;
      for (const s of spans) {
        const m = this._match(text, s);
        out += text.slice(last, s[0]) + (typeof repl === "function" ? String(repl(m)) : expandReplacement(String(repl), m));
        last = s[1];
      }
      return [out + text.slice(last), spans.length];
    }
    replace(text, repl) { return this.subn(text, repl)[0]; }
  }
  const regex = { compile: (pattern, flags) => new NativeRegex(String(pattern), flags == null ? "" : String(flags)) };

  const api = {
    definePlugin: (p) => p,
    defineProvider: (p) => p,
    log, sleep, fetch, Headers, Response, crypto, base64, utf8, url, env, fs, subprocess, listen,
    pyJsonDumps, pyRepr, parseIsoTimestamp, httpStatusMessage, gemini, regex, native,
    credentialStore: (providerId, overrides) => credentials({ providerId: String(providerId), overrides: overrides || {} }),
    ProviderError, AuthError, ValueError, UnconfiguredError, NetworkError, HttpError,
    platform: sync("platform", null),
    version: sync("version", null),
  };
  Object.freeze(api);
  globalThis.__oad_api = api;

  // Familiar web globals.
  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Response = Response;
  globalThis.setTimeout = setTimeout;
  globalThis.clearTimeout = clearTimeout;
  globalThis.setInterval = setInterval;
  globalThis.clearInterval = clearTimeout;
  globalThis.console = { log: log.info, info: log.info, debug: log.debug, warn: log.warn, error: log.error };
  if (!globalThis.crypto) globalThis.crypto = { randomUUID: crypto.randomUUID, getRandomValues: crypto.getRandomValues };
  if (!globalThis.TextEncoder) {
    globalThis.TextEncoder = class TextEncoder { encode(s = "") { return utf8.encode(s); } };
  }
  if (!globalThis.TextDecoder) {
    globalThis.TextDecoder = class TextDecoder { decode(b) { return b === undefined ? "" : utf8.decode(b); } };
  }

  // ── host bridge ───────────────────────────────────────────────────────────
  const HANDLES = new Map();
  let nextHandle = 1;

  function revive(v) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1) {
        if (keys[0] === "$oadCallback") {
          const id = v.$oadCallback;
          return (...args) => sync("callback", { id, args });
        }
        if (keys[0] === "$oadHandle") return HANDLES.get(v.$oadHandle);
        if (keys[0] === "$oadCredentials") return credentials(v.$oadCredentials);
      }
    }
    return v;
  }
  function reviveArgs(args) {
    return args.map((a) => {
      a = revive(a);
      if (a && typeof a === "object" && !Array.isArray(a) && Object.getPrototypeOf(a) === Object.prototype) {
        for (const k of Object.keys(a)) a[k] = revive(a[k]);
      }
      return a;
    });
  }
  function resolveTarget(t) {
    if (t.handle != null) {
      const o = HANDLES.get(t.handle);
      if (o === undefined) throw new Error(`plugin object ${t.handle} was released`);
      return o;
    }
    let o = globalThis.__oad_ns;
    for (const p of t.path) o = o == null ? undefined : o[p];
    if (o == null) throw new TypeError(`export '${t.path.join(".")}' is not defined`);
    return o;
  }
  function methodNames(o) {
    const out = new Set();
    for (let p = o; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === "constructor") continue;
        try {
          if (typeof o[k] === "function") out.add(k);
        } catch {}
      }
    }
    return [...out];
  }
  function toJson(v) {
    const s = JSON.stringify(v === undefined ? null : v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
    return s === undefined ? "null" : s;
  }
  globalThis.__oad_invoke = async (targetJson, method, argsJson, mode) => {
    const obj = resolveTarget(JSON.parse(targetJson));
    const f = obj[method];
    if (typeof f !== "function") throw new TypeError(`${method} is not a function`);
    const args = reviveArgs(JSON.parse(argsJson));
    const r = await f.apply(obj, args);
    if (r instanceof Error) throw r;
    if (mode === "keep") {
      if (r === null || typeof r !== "object") throw new TypeError(`${method}() must return an object`);
      const id = nextHandle++;
      HANDLES.set(id, r);
      return `{"handle":${id},"methods":${JSON.stringify(methodNames(r))},"value":${toJson(r)}}`;
    }
    if (mode === "args") return `{"value":${toJson(r)},"args":${toJson(args)}}`;
    return `{"value":${toJson(r)}}`;
  };
  globalThis.__oad_drop = (id) => {
    HANDLES.delete(id);
  };
  globalThis.__oad_error = (e) => {
    if (e instanceof Error) {
      const props = {};
      for (const k of Object.keys(e)) if (k !== "name" && k !== "message" && k !== "stack") props[k] = e[k];
      const base = { name: e.name || "Error", message: String(e.message ?? ""), stack: e.stack ? String(e.stack) : null };
      try {
        return toJson({ ...base, props });
      } catch {
        return toJson({ ...base, props: {} });
      }
    }
    let msg;
    try {
      msg = typeof e === "string" ? e : JSON.stringify(e);
    } catch {
      msg = String(e);
    }
    return toJson({ name: "Error", message: String(msg), stack: null, props: {} });
  };
  globalThis.__oad_describe = () => {
    const ns = globalThis.__oad_ns;
    const out = { exports: Object.keys(ns) };
    const p = ns.provider;
    if (p !== undefined) {
      if (p && typeof p === "object") {
        out.provider = JSON.parse(toJson(p));
        out.providerMethods = methodNames(p);
      } else {
        out.providerInvalid = p === null ? "null" : typeof p;
      }
    }
    out.pluginFactory = typeof ns.plugin === "function" ? "plugin" : typeof ns.default === "function" ? "default" : null;
    return toJson(out);
  };
})();
