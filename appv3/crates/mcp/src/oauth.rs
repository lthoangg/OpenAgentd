//! MCP OAuth, plus the subset of the
//! `mcp` SDK (2.2) `OAuthClientProvider` auth flow it drives: PRM / AS
//! metadata discovery, dynamic client registration, PKCE authorization-code
//! grant over a loopback callback, token exchange and refresh.

use crate::client::{transport_err, McpError};
use crate::config::{resolve_secret_refs, OAuthConfig};
use appv3_providers::plugin::{b64url, parse_qs, pkce_challenge, qs_first, random_bytes, urlencode};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// URL-encoded form body as ordered (name, value) pairs.
type FormPairs = Vec<(String, String)>;
/// Extra request headers for a token call.
type AuthHeaders = Vec<(&'static str, String)>;

const LATEST_PROTOCOL_VERSION: &str = "2026-07-28";
const KNOWN_PROTOCOL_VERSIONS: [&str; 5] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];
const AUTH_REDIRECT_LIMIT: usize = 5;
const CALLBACK_PATH: &str = "/callback";

pub fn needs_oauth_message(name: &str) -> String {
    format!("MCP server '{name}' needs OAuth. Use Settings -> MCP -> Connect OAuth.")
}

fn required(m: String) -> McpError {
    McpError::Transport("OAuthRequiredError", m)
}
fn flow_err(m: String) -> McpError {
    McpError::Transport("OAuthFlowError", m)
}
fn token_err(m: String) -> McpError {
    McpError::Transport("OAuthTokenError", m)
}
fn reg_err(m: String) -> McpError {
    McpError::Transport("OAuthRegistrationError", m)
}

// ── interactive gate + cache file ───────────────────────────────────────────

fn interactive() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

pub fn allow_interactive_oauth(name: &str) {
    interactive().lock().unwrap().insert(name.to_string());
}

pub fn disallow_interactive_oauth(name: &str) {
    interactive().lock().unwrap().remove(name);
}

pub fn interactive_oauth_allowed(name: &str) -> bool {
    interactive().lock().unwrap().contains(name)
}

fn cache_path(name: &str) -> PathBuf {
    appv3_core::settings().cache_dir.join("mcp-oauth").join(format!("{name}.json"))
}

/// Python truthiness of a JSON value.
fn py_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

pub fn has_cached_oauth_tokens(name: &str) -> bool {
    let path = cache_path(name);
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    let Ok(data) = serde_json::from_str::<Value>(&text) else { return false };
    data.get("tokens").map(py_truthy).unwrap_or(false)
}

/// Remove cached OAuth state (tokens + dynamically registered client).
pub fn clear_cached_oauth(name: &str) {
    let _ = std::fs::remove_file(cache_path(name));
}

fn unresolved_secret_ref(raw: &str, resolved: &str) -> bool {
    raw.starts_with('$') && raw == resolved
}

pub fn has_resolved_client_id(oauth: Option<&OAuthConfig>) -> bool {
    let Some(raw) = oauth.and_then(|o| o.client_id.as_deref()).filter(|s| !s.is_empty()) else { return false };
    let id = resolve_secret_refs(raw);
    !id.is_empty() && !unresolved_secret_ref(raw, &id)
}

// ── URL helpers (urllib.parse / pydantic AnyHttpUrl semantics) ──────────────

#[derive(Debug, Clone, Default, PartialEq)]
struct Split {
    scheme: String,
    netloc: String,
    path: String,
    query: String,
    fragment: String,
}

/// `urllib.parse.urlsplit`.
fn urlsplit(url: &str) -> Split {
    let mut s = Split::default();
    let mut rest = url;
    if let Some(i) = rest.find(':') {
        let cand = &rest[..i];
        if !cand.is_empty() && cand.chars().next().unwrap().is_ascii_alphabetic() && cand.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
            s.scheme = cand.to_ascii_lowercase();
            rest = &rest[i + 1..];
        }
    }
    if let Some(r) = rest.strip_prefix("//") {
        let end = r.find(['/', '?', '#']).unwrap_or(r.len());
        s.netloc = r[..end].to_string();
        rest = &r[end..];
    }
    if let Some((a, f)) = rest.split_once('#') {
        s.fragment = f.to_string();
        rest = a;
    }
    if let Some((a, q)) = rest.split_once('?') {
        s.query = q.to_string();
        rest = a;
    }
    s.path = rest.to_string();
    s
}

/// `f"{parsed.scheme}://{parsed.netloc}"`.
fn base_url(url: &str) -> String {
    let p = urlsplit(url);
    format!("{}://{}", p.scheme, p.netloc)
}

/// `str(AnyHttpUrl(url))` with `url_preserve_empty_path=True`; `None` when invalid.
fn norm_url(raw: &str, http_only: bool) -> Option<String> {
    let raw = raw.trim();
    let u = url::Url::parse(raw).ok()?;
    if http_only && !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    if http_only && u.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return None;
    }
    let empty_path = u.has_authority() && urlsplit(raw).path.is_empty();
    let head = &u[..url::Position::BeforePath];
    let tail = &u[url::Position::AfterPath..];
    Some(format!("{head}{}{tail}", if empty_path { "" } else { u.path() }))
}

fn norm_http(raw: &str) -> Option<String> {
    norm_url(raw, true)
}

/// `resource_url_from_server_url`.
fn resource_url_from_server_url(url: &str) -> String {
    let p = urlsplit(url);
    let mut out = String::new();
    if !p.scheme.is_empty() {
        out.push_str(&p.scheme.to_lowercase());
        out.push(':');
    }
    if !p.netloc.is_empty() || p.scheme.is_empty() && p.path.starts_with("//") || matches!(p.scheme.as_str(), "http" | "https") {
        out.push_str("//");
        out.push_str(&p.netloc.to_lowercase());
    }
    out.push_str(&p.path);
    if !p.query.is_empty() {
        out.push('?');
        out.push_str(&p.query);
    }
    out
}

/// `check_resource_allowed`.
fn check_resource_allowed(requested: &str, configured: &str) -> bool {
    let (r, c) = (urlsplit(requested), urlsplit(configured));
    if r.scheme.to_lowercase() != c.scheme.to_lowercase() || r.netloc.to_lowercase() != c.netloc.to_lowercase() {
        return false;
    }
    let slash = |p: &str| if p.ends_with('/') { p.to_string() } else { format!("{p}/") };
    slash(&r.path).starts_with(&slash(&c.path))
}

/// Whether `left` and `right` are root-slash variants of each other.
fn root_slash_variant(left: &str, right: &str) -> bool {
    let (l, r) = (urlsplit(left), urlsplit(right));
    left != right
        && matches!(l.path.as_str(), "" | "/")
        && matches!(r.path.as_str(), "" | "/")
        && l.query.is_empty()
        && l.fragment.is_empty()
        && r.query.is_empty()
        && r.fragment.is_empty()
        && l.scheme == r.scheme
        && l.netloc == r.netloc
}

/// `issuers_match`.
fn issuers_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (shorter, longer) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    longer == format!("{shorter}/") && shorter == base_url(shorter)
}

/// Origin-only issuer URL for a server URL.
fn origin_issuer(server_url: &str) -> String {
    let b = base_url(server_url);
    norm_http(&b).unwrap_or(b)
}

/// `extract_field_from_www_auth`.
fn www_auth_field(header: Option<&str>, field: &str) -> Option<String> {
    let h = header.filter(|h| !h.is_empty())?;
    let re = regex::Regex::new(&format!(r#"{}=(?:"([^"]+)"|([^\s,]+))"#, regex::escape(field))).ok()?;
    let c = re.captures(h)?;
    c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string())
}

/// `urllib.parse.quote(s, safe="")`.
fn quote_all(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Python `repr()` of an optional string.
fn repr_opt(s: Option<&str>) -> String {
    s.map(crate::config::py_repr_str).unwrap_or_else(|| "None".into())
}

fn is_version_at_least(version: Option<&str>, minimum: &str) -> bool {
    let Some(v) = version else { return false };
    let (Some(a), Some(b)) = (KNOWN_PROTOCOL_VERSIONS.iter().position(|x| *x == v), KNOWN_PROTOCOL_VERSIONS.iter().position(|x| *x == minimum)) else { return false };
    a >= b
}

// ── models (pydantic validation + `model_dump(mode="json")`) ────────────────

fn verr(model: &str, field: &str, msg: &str) -> String {
    format!("1 validation error for {model}\n{field}\n  {msg}")
}

/// Lax pydantic `int`.
fn lax_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn lax_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => Some(false),
            Some(1.0) => Some(true),
            _ => None,
        },
        Value::String(s) => match s.to_lowercase().as_str() {
            "0" | "off" | "f" | "false" | "n" | "no" => Some(false),
            "1" | "on" | "t" | "true" | "y" | "yes" => Some(true),
            _ => None,
        },
        _ => None,
    }
}

fn str_list(v: &Value) -> Option<Vec<String>> {
    v.as_array()?.iter().map(|x| x.as_str().map(String::from)).collect()
}

#[derive(Debug, Clone, PartialEq)]
struct Token {
    access_token: String,
    expires_in: Option<i64>,
    scope: Option<String>,
    refresh_token: Option<String>,
}

impl Token {
    fn validate(v: &Value) -> Result<Token, String> {
        const M: &str = "OAuthToken";
        let Some(o) = v.as_object() else { return Err(verr(M, "", "Input should be a valid dictionary or instance of OAuthToken")) };
        let opt_str = |k: &str| -> Result<Option<String>, String> {
            match o.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.clone())),
                Some(_) => Err(verr(M, k, "Input should be a valid string")),
            }
        };
        let access_token = match o.get("access_token") {
            Some(Value::String(s)) => s.clone(),
            None => return Err(verr(M, "access_token", "Field required")),
            Some(_) => return Err(verr(M, "access_token", "Input should be a valid string")),
        };
        match o.get("token_type") {
            None => {}
            Some(Value::String(s)) if s.to_lowercase() == "bearer" => {}
            Some(_) => return Err(verr(M, "token_type", "Input should be 'Bearer'")),
        }
        let expires_in = match o.get("expires_in") {
            None | Some(Value::Null) => None,
            Some(x) => Some(lax_int(x).ok_or_else(|| verr(M, "expires_in", "Input should be a valid integer"))?),
        };
        Ok(Token { access_token, expires_in, scope: opt_str("scope")?, refresh_token: opt_str("refresh_token")? })
    }

    fn dump(&self) -> Value {
        json!({"access_token": self.access_token, "token_type": "Bearer", "expires_in": self.expires_in, "scope": self.scope, "refresh_token": self.refresh_token})
    }
}

/// `OAuthClientInformationFull.model_validate(raw).model_dump(mode="json")`.
fn validate_client_info(v: &Value) -> Result<Map<String, Value>, String> {
    const M: &str = "OAuthClientInformationFull";
    let Some(src) = v.as_object() else { return Err(verr(M, "", "Input should be a valid dictionary or instance of OAuthClientInformationFull")) };
    // Placeholder members (null / "") read as omitted.
    let o: Map<String, Value> = src.iter().filter(|(_, v)| !v.is_null() && v.as_str() != Some("")).map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut out = Map::new();
    let s = |k: &str| -> Result<Value, String> {
        match o.get(k) {
            None => Ok(Value::Null),
            Some(Value::String(s)) => Ok(json!(s)),
            Some(_) => Err(verr(M, k, "Input should be a valid string")),
        }
    };
    let url = |k: &str| -> Result<Value, String> {
        match o.get(k) {
            None => Ok(Value::Null),
            Some(Value::String(s)) => norm_http(s).map(Value::String).ok_or_else(|| verr(M, k, "Input should be a valid URL")),
            Some(_) => Err(verr(M, k, "URL input should be a string or URL")),
        }
    };
    let list = |k: &str, default: Value| -> Result<Value, String> {
        match o.get(k) {
            None => Ok(default),
            Some(x) => str_list(x).map(|l| json!(l)).ok_or_else(|| verr(M, k, "Input should be a valid list")),
        }
    };
    let int = |k: &str| -> Result<Value, String> {
        match o.get(k) {
            None => Ok(Value::Null),
            Some(x) => lax_int(x).map(|i| json!(i)).ok_or_else(|| verr(M, k, "Input should be a valid integer")),
        }
    };
    out.insert("response_types".into(), list("response_types", json!(["code"]))?);
    out.insert("scope".into(), s("scope")?);
    out.insert("client_name".into(), s("client_name")?);
    out.insert("client_uri".into(), url("client_uri")?);
    out.insert("logo_uri".into(), url("logo_uri")?);
    out.insert("contacts".into(), list("contacts", Value::Null)?);
    out.insert("tos_uri".into(), url("tos_uri")?);
    out.insert("policy_uri".into(), url("policy_uri")?);
    out.insert("jwks_uri".into(), url("jwks_uri")?);
    out.insert("jwks".into(), o.get("jwks").cloned().unwrap_or(Value::Null));
    out.insert("software_id".into(), s("software_id")?);
    out.insert("software_version".into(), s("software_version")?);
    let redirect = match o.get("redirect_uris") {
        None => Value::Null,
        Some(x) => {
            let l = str_list(x).ok_or_else(|| verr(M, "redirect_uris", "Input should be a valid list"))?;
            json!(l.iter().map(|u| norm_url(u, false).ok_or_else(|| verr(M, "redirect_uris", "Input should be a valid URL"))).collect::<Result<Vec<_>, _>>()?)
        }
    };
    out.insert("redirect_uris".into(), redirect);
    out.insert("token_endpoint_auth_method".into(), s("token_endpoint_auth_method")?);
    out.insert("grant_types".into(), list("grant_types", json!(["authorization_code", "refresh_token"]))?);
    out.insert("application_type".into(), s("application_type")?);
    let cid = s("client_id")?;
    if cid.is_null() {
        return Err(verr(M, "client_id", "Field required"));
    }
    out.insert("client_id".into(), cid);
    out.insert("client_secret".into(), s("client_secret")?);
    out.insert("client_id_issued_at".into(), int("client_id_issued_at")?);
    out.insert("client_secret_expires_at".into(), int("client_secret_expires_at")?);
    out.insert("issuer".into(), s("issuer")?);
    Ok(out)
}

fn ci_str<'a>(ci: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    ci.get(k).and_then(|v| v.as_str())
}

#[derive(Debug, Clone)]
struct AsMeta {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    scopes_supported: Option<Vec<String>>,
    authorization_response_iss_parameter_supported: Option<bool>,
}

fn opt_url(o: &Map<String, Value>, k: &str) -> Result<Option<String>, ()> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => norm_http(s).map(Some).ok_or(()),
        Some(_) => Err(()),
    }
}

fn opt_list(o: &Map<String, Value>, k: &str) -> Result<Option<Vec<String>>, ()> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(x) => str_list(x).map(Some).ok_or(()),
    }
}

fn opt_bool(o: &Map<String, Value>, k: &str) -> Result<Option<bool>, ()> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(x) => lax_bool(x).map(Some).ok_or(()),
    }
}

impl AsMeta {
    /// `OAuthMetadata.model_validate`; `None` on a validation error.
    fn validate_value(v: &Value) -> Option<AsMeta> {
        let o = v.as_object()?;
        let req = |k: &str| opt_url(o, k).ok().flatten();
        for k in ["service_documentation", "op_policy_uri", "op_tos_uri", "revocation_endpoint", "introspection_endpoint"] {
            opt_url(o, k).ok()?;
        }
        for k in [
            "response_modes_supported",
            "grant_types_supported",
            "token_endpoint_auth_methods_supported",
            "token_endpoint_auth_signing_alg_values_supported",
            "ui_locales_supported",
            "revocation_endpoint_auth_methods_supported",
            "revocation_endpoint_auth_signing_alg_values_supported",
            "introspection_endpoint_auth_methods_supported",
            "introspection_endpoint_auth_signing_alg_values_supported",
            "code_challenge_methods_supported",
            "authorization_grant_profiles_supported",
        ] {
            opt_list(o, k).ok()?;
        }
        opt_bool(o, "client_id_metadata_document_supported").ok()?;
        if o.get("response_types_supported").is_some() {
            str_list(&o["response_types_supported"])?;
        }
        Some(AsMeta {
            issuer: req("issuer")?,
            authorization_endpoint: req("authorization_endpoint")?,
            token_endpoint: req("token_endpoint")?,
            registration_endpoint: opt_url(o, "registration_endpoint").ok()?,
            scopes_supported: opt_list(o, "scopes_supported").ok()?,
            authorization_response_iss_parameter_supported: opt_bool(o, "authorization_response_iss_parameter_supported").ok()?,
        })
    }
}

#[derive(Debug, Clone)]
struct Prm {
    resource: String,
    authorization_servers: Vec<String>,
    scopes_supported: Option<Vec<String>>,
}

impl Prm {
    fn validate(body: &[u8]) -> Option<Prm> {
        let v: Value = serde_json::from_slice(body).ok()?;
        let o = v.as_object()?;
        for k in ["jwks_uri", "resource_documentation", "resource_policy_uri", "resource_tos_uri"] {
            opt_url(o, k).ok()?;
        }
        for k in ["bearer_methods_supported", "resource_signing_alg_values_supported", "authorization_details_types_supported", "dpop_signing_alg_values_supported"] {
            opt_list(o, k).ok()?;
        }
        for k in ["tls_client_certificate_bound_access_tokens", "dpop_bound_access_tokens_required"] {
            opt_bool(o, k).ok()?;
        }
        match o.get("resource_name") {
            None | Some(Value::Null) | Some(Value::String(_)) => {}
            _ => return None,
        }
        let servers = o.get("authorization_servers")?.as_array()?;
        if servers.is_empty() {
            return None;
        }
        let authorization_servers = servers.iter().map(|s| s.as_str().and_then(norm_http)).collect::<Option<Vec<_>>>()?;
        Some(Prm { resource: opt_url(o, "resource").ok().flatten()?, authorization_servers, scopes_supported: opt_list(o, "scopes_supported").ok()? })
    }
}

// ── token storage ───────────────────────────────────────────────────────────

struct FileTokenStorage {
    path: PathBuf,
    oauth: OAuthConfig,
}

fn py_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

impl FileTokenStorage {
    fn read(&self) -> Result<Map<String, Value>, McpError> {
        if !self.path.is_file() {
            return Ok(Map::new());
        }
        let text = std::fs::read_to_string(&self.path).map_err(|e| McpError::Transport("OSError", e.to_string()))?;
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => Ok(m),
            Ok(other) => Err(McpError::Transport("AttributeError", format!("'{}' object has no attribute 'get'", py_type_name(&other)))),
            Err(e) => Err(McpError::Transport("JSONDecodeError", e.to_string())),
        }
    }

    fn write(&self, data: &Map<String, Value>) -> Result<(), McpError> {
        let text = appv3_core::pyjson::dumps_indent(&Value::Object(data.clone()), 2) + "\n";
        appv3_core::secret_files::write_secret_file(&self.path, &text).map_err(|e| McpError::Transport("OSError", e.to_string()))
    }

    fn get_tokens(&self) -> Result<Option<Token>, McpError> {
        let data = self.read()?;
        match data.get("tokens") {
            Some(raw) if py_truthy(raw) => Token::validate(raw).map(Some).map_err(|e| McpError::Transport("ValidationError", e)),
            _ => Ok(None),
        }
    }

    fn set_tokens(&self, t: &Token) -> Result<(), McpError> {
        let mut data = self.read()?;
        data.insert("tokens".into(), t.dump());
        self.write(&data)
    }

    fn get_client_info(&self) -> Result<Option<Map<String, Value>>, McpError> {
        let data = self.read()?;
        if let Some(raw) = data.get("client_info").filter(|r| py_truthy(r)) {
            return validate_client_info(raw).map(Some).map_err(|e| McpError::Transport("ValidationError", e));
        }
        let Some(raw_id) = self.oauth.client_id.as_deref().filter(|s| !s.is_empty()) else { return Ok(None) };
        let client_id = resolve_secret_refs(raw_id);
        let raw_secret = self.oauth.client_secret.as_deref().filter(|s| !s.is_empty());
        let mut secret = raw_secret.map(resolve_secret_refs);
        if client_id.is_empty() || unresolved_secret_ref(raw_id, &client_id) {
            return Ok(None);
        }
        if let (Some(raw), Some(s)) = (raw_secret, secret.as_deref()) {
            if !s.is_empty() && unresolved_secret_ref(raw, s) {
                secret = None;
            }
        }
        let method = if secret.as_deref().map(|s| !s.is_empty()).unwrap_or(false) { "client_secret_post" } else { "none" };
        validate_client_info(&json!({"client_id": client_id, "client_secret": secret, "redirect_uris": null, "token_endpoint_auth_method": method}))
            .map(Some)
            .map_err(|e| McpError::Transport("ValidationError", e))
    }

    fn set_client_info(&self, ci: &Map<String, Value>) -> Result<(), McpError> {
        let mut data = self.read()?;
        data.insert("client_info".into(), Value::Object(ci.clone()));
        self.write(&data)
    }
}

// ── loopback callback ───────────────────────────────────────────────────────

#[derive(Clone)]
struct CodeResult {
    code: String,
    state: Option<String>,
    iss: Option<String>,
}

struct Loopback {
    listener: Mutex<Option<std::net::TcpListener>>,
    redirect_uri: String,
    /// v2 keeps the first callback's result and `done` event set, so a
    /// second authorization on the same connection re-reads it at once.
    last: Mutex<Option<Result<CodeResult, McpError>>>,
}

impl Loopback {
    fn bind() -> Result<Loopback, McpError> {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| McpError::Transport("OSError", e.to_string()))?;
        let port = l.local_addr().map_err(|e| McpError::Transport("OSError", e.to_string()))?.port();
        let _ = l.set_nonblocking(true);
        Ok(Loopback { listener: Mutex::new(Some(l)), redirect_uri: format!("http://localhost:{port}{CALLBACK_PATH}"), last: Mutex::new(None) })
    }

    async fn wait(&self) -> Result<CodeResult, McpError> {
        let timeout = || McpError::Transport("TimeoutError", "Timed out waiting for OAuth callback.".into());
        let taken = self.listener.lock().unwrap().take();
        let Some(std_l) = taken else { return self.last.lock().unwrap().clone().unwrap_or_else(|| Err(timeout())) };
        let listener = tokio::net::TcpListener::from_std(std_l).map_err(|e| McpError::Transport("OSError", e.to_string()))?;
        match tokio::time::timeout(Duration::from_secs(300), serve_callback(listener)).await {
            Ok(r) => {
                *self.last.lock().unwrap() = Some(r.clone());
                r
            }
            Err(_) => Err(timeout()),
        }
    }
}

async fn serve_callback(listener: tokio::net::TcpListener) -> Result<CodeResult, McpError> {
    use appv3_providers::plugin::write_response;
    loop {
        let Ok((mut sock, _)) = listener.accept().await else { continue };
        let target = appv3_providers::codex::read_request_target(&mut sock).await;
        let p = urlsplit(&target);
        if p.path != CALLBACK_PATH {
            write_response(&mut sock, 404, "Not Found", None).await;
            continue;
        }
        let qs = parse_qs(&p.query);
        let error = qs_first(&qs, "error");
        if !error.is_empty() {
            write_response(&mut sock, 200, "OK", Some("<h1>Authorization failed</h1><p>You can close this window.</p>".into())).await;
            return Err(McpError::Transport("RuntimeError", format!("OAuth failed: {error}")));
        }
        let (code, state, iss) = (qs_first(&qs, "code"), qs_first(&qs, "state"), qs_first(&qs, "iss"));
        write_response(&mut sock, 200, "OK", Some("<h1>Authorization successful</h1><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script>".into()))
            .await;
        return Ok(CodeResult { code, state: Some(state).filter(|s| !s.is_empty()), iss: Some(iss).filter(|s| !s.is_empty()) });
    }
}

/// `webbrowser.open(url)` — honours `$BROWSER` like Python's `webbrowser`.
fn open_browser(url: &str) -> Result<(), String> {
    let choice = std::env::var("BROWSER").ok().and_then(|b| b.split(':').map(str::trim).find(|c| !c.is_empty()).map(String::from));
    let argv: Vec<String> = match choice {
        Some(cmdline) => {
            let parts: Vec<String> = cmdline.split_whitespace().map(String::from).collect();
            if parts.len() == 1 {
                vec![parts[0].clone(), url.to_string()]
            } else {
                parts.iter().map(|a| a.replace("%s", url)).collect()
            }
        }
        None => {
            let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
            vec![cmd.to_string(), url.to_string()]
        }
    };
    let mut child =
        appv3_core::proctree::hide_window_std(&mut std::process::Command::new(&argv[0])).args(&argv[1..]).stdin(std::process::Stdio::null()).spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// ── auth-flow HTTP ──────────────────────────────────────────────────────────

struct AuthReq {
    method: reqwest::Method,
    url: String,
    headers: Vec<(&'static str, String)>,
    body: Option<Vec<u8>>,
}

impl AuthReq {
    fn metadata(url: String) -> AuthReq {
        AuthReq { method: reqwest::Method::GET, url, headers: vec![("mcp-protocol-version", LATEST_PROTOCOL_VERSION.into())], body: None }
    }
    fn form(url: String, data: &[(String, String)], extra: Vec<(&'static str, String)>) -> AuthReq {
        let pairs: Vec<(&str, &str)> = data.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let mut headers = vec![("content-type", "application/x-www-form-urlencoded".to_string())];
        headers.extend(extra);
        AuthReq { method: reqwest::Method::POST, url, headers, body: Some(urlencode(&pairs).into_bytes()) }
    }
}

struct Resp {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
    url: url::Url,
}

impl Resp {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn location(&self) -> Option<url::Url> {
        if !matches!(self.status, 301 | 302 | 303 | 307 | 308) {
            return None;
        }
        let loc = self.headers.get("location")?.to_str().ok()?;
        self.url.join(loc).ok()
    }
}

/// `redirect_note`.
fn redirect_note(r: &Resp) -> String {
    let Some(mut loc) = r.location() else { return String::new() };
    let _ = loc.set_username("");
    let _ = loc.set_password(None);
    loc.set_query(None);
    loc.set_fragment(None);
    format!(" (redirected to {loc}; not followed)")
}

/// `next_request_within_origin`.
fn next_within_origin(method: &reqwest::Method, r: &Resp) -> Option<url::Url> {
    let next = r.location()?;
    let next_method = match r.status {
        303 if method != reqwest::Method::HEAD => reqwest::Method::GET,
        301 | 302 if method == reqwest::Method::POST => reqwest::Method::GET,
        _ => method.clone(),
    };
    if next_method != *method {
        return None;
    }
    let sent = &r.url;
    let userinfo = |u: &url::Url| (u.username().to_string(), u.password().map(String::from));
    if (!next.username().is_empty() || next.password().is_some()) && userinfo(&next) != userinfo(sent) {
        return None;
    }
    let same = sent.scheme() == next.scheme() && sent.host_str() == next.host_str() && sent.port() == next.port();
    let upgrade = sent.host_str() == next.host_str() && sent.scheme() == "http" && sent.port().is_none() && next.scheme() == "https" && next.port().is_none();
    (same || upgrade).then_some(next)
}

// ── provider ────────────────────────────────────────────────────────────────

struct Ctx {
    scope: Option<String>,
    prm: Option<Prm>,
    oauth_metadata: Option<AsMeta>,
    auth_server_url: Option<String>,
    protocol_version: Option<String>,
    client_info: Option<Map<String, Value>>,
    tokens: Option<Token>,
    expiry: Option<f64>,
    initialized: bool,
}

fn now_f() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

impl Ctx {
    fn token_valid(&self) -> bool {
        self.tokens.as_ref().map(|t| !t.access_token.is_empty()).unwrap_or(false) && self.expiry.map(|e| now_f() <= e).unwrap_or(true)
    }
    fn can_refresh(&self) -> bool {
        self.tokens.as_ref().and_then(|t| t.refresh_token.as_deref()).map(|r| !r.is_empty()).unwrap_or(false) && self.client_info.is_some()
    }
    fn clear_tokens(&mut self) {
        self.tokens = None;
        self.expiry = None;
    }
    fn set_tokens(&mut self, t: Token) {
        self.expiry = t.expires_in.map(|s| now_f() + s as f64);
        self.tokens = Some(t);
    }
    fn include_resource(&self) -> bool {
        self.prm.is_some() || is_version_at_least(self.protocol_version.as_deref(), "2025-06-18")
    }
    fn resource_url(&self, server_url: &str) -> String {
        let resource = resource_url_from_server_url(server_url);
        if let Some(p) = &self.prm {
            if check_resource_allowed(&resource, &p.resource) {
                return p.resource.clone();
            }
        }
        resource
    }
    fn expected_issuer(&self, server_url: &str) -> String {
        self.auth_server_url.clone().unwrap_or_else(|| origin_issuer(server_url))
    }
    fn token_endpoint(&self, server_url: &str) -> String {
        match &self.oauth_metadata {
            Some(m) => m.token_endpoint.clone(),
            None => format!("{}/token", base_url(server_url)),
        }
    }
    /// `prepare_token_auth`.
    fn prepare_token_auth(&self, mut data: FormPairs) -> Result<(FormPairs, AuthHeaders), McpError> {
        let mut headers = vec![];
        let Some(ci) = &self.client_info else { return Ok((data, headers)) };
        let method = ci_str(ci, "token_endpoint_auth_method");
        let secret = ci_str(ci, "client_secret").filter(|s| !s.is_empty());
        let client_id = ci_str(ci, "client_id").unwrap_or("");
        match (method, secret) {
            (Some("client_secret_basic"), Some(sec)) => {
                let creds = format!("{}:{}", quote_all(client_id), quote_all(sec));
                use base64::Engine;
                headers.push(("authorization", format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(creds))));
                data.retain(|(k, _)| k != "client_secret");
            }
            (Some("client_secret_post"), Some(sec)) => {
                set_pair(&mut data, "client_id", client_id);
                set_pair(&mut data, "client_secret", sec);
            }
            (m, _) if !matches!(m, None | Some("none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt")) => {
                return Err(token_err(format!("Registered client uses unsupported token_endpoint_auth_method {}", repr_opt(m))));
            }
            _ => {}
        }
        Ok((data, headers))
    }
}

fn set_pair(data: &mut Vec<(String, String)>, k: &str, v: &str) {
    match data.iter_mut().find(|(n, _)| n == k) {
        Some(p) => p.1 = v.to_string(),
        None => data.push((k.to_string(), v.to_string())),
    }
}

/// `get_client_metadata_scopes`.
fn select_scopes(www_scope: Option<String>, prm: Option<&Prm>, asm: Option<&AsMeta>, grant_types: &[&str]) -> Option<String> {
    let mut selected =
        www_scope.or_else(|| prm.and_then(|p| p.scopes_supported.as_ref()).map(|s| s.join(" "))).or_else(|| asm.and_then(|a| a.scopes_supported.as_ref()).map(|s| s.join(" ")))?;
    if asm.and_then(|a| a.scopes_supported.as_ref()).map(|s| s.iter().any(|x| x == "offline_access")).unwrap_or(false)
        && grant_types.contains(&"refresh_token")
        && !selected.split_whitespace().any(|s| s == "offline_access")
    {
        selected.push_str(" offline_access");
    }
    Some(selected)
}

/// `union_scopes`.
fn union_scopes(prev: Option<String>, new: Option<String>) -> Option<String> {
    let Some(p) = prev.filter(|s| !s.is_empty()) else { return new };
    let Some(n) = new.filter(|s| !s.is_empty()) else { return Some(p) };
    let mut merged: Vec<String> = p.split_whitespace().map(String::from).collect();
    for s in n.split_whitespace() {
        if !merged.iter().any(|m| m == s) {
            merged.push(s.to_string());
        }
    }
    Some(merged.join(" "))
}

const GRANT_TYPES: [&str; 2] = ["authorization_code", "refresh_token"];

pub struct OAuthProvider {
    name: String,
    server_url: String,
    auth_method: &'static str,
    storage: FileTokenStorage,
    callback: Loopback,
    http: reqwest::Client,
    ctx: tokio::sync::Mutex<Ctx>,
}

/// `build_oauth_provider` — `None` when the server has no `oauth` block.
pub fn build_oauth_provider(name: &str, url: &str, oauth: Option<&OAuthConfig>) -> Result<Option<OAuthProvider>, McpError> {
    let Some(oauth) = oauth else { return Ok(None) };
    let callback = Loopback::bind()?;
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(transport_err)?;
    let auth_method = if oauth.client_secret.as_deref().map(|s| !s.is_empty()).unwrap_or(false) { "client_secret_post" } else { "none" };
    Ok(Some(OAuthProvider {
        name: name.to_string(),
        server_url: url.to_string(),
        auth_method,
        storage: FileTokenStorage { path: cache_path(name), oauth: oauth.clone() },
        callback,
        http,
        ctx: tokio::sync::Mutex::new(Ctx {
            scope: None,
            prm: None,
            oauth_metadata: None,
            auth_server_url: None,
            protocol_version: None,
            client_info: None,
            tokens: None,
            expiry: None,
            initialized: false,
        }),
    }))
}

fn add_auth(ctx: &Ctx, req: &mut reqwest::Request) {
    if let Some(t) = ctx.tokens.as_ref().filter(|t| !t.access_token.is_empty()) {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", t.access_token)) {
            req.headers_mut().insert(reqwest::header::AUTHORIZATION, v);
        }
    }
}

impl OAuthProvider {
    pub fn redirect_uri(&self) -> &str {
        &self.callback.redirect_uri
    }

    async fn exec(&self, r: &AuthReq, url: &url::Url) -> Result<Resp, McpError> {
        let mut b = self.http.request(r.method.clone(), url.clone());
        for (k, v) in &r.headers {
            b = b.header(*k, v);
        }
        if let Some(body) = &r.body {
            b = b.body(body.clone());
        }
        let resp = b.send().await.map_err(transport_err)?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let final_url = resp.url().clone();
        let body = resp.bytes().await.map_err(transport_err)?.to_vec();
        Ok(Resp { status, headers, body, url: final_url })
    }

    /// Send one auth-flow request, following in-origin redirects (`RedirectAwareAuth`).
    async fn send_auth(&self, r: AuthReq) -> Result<Resp, McpError> {
        let url = url::Url::parse(&r.url).map_err(|e| McpError::Transport("UnsupportedProtocol", format!("{e}: {}", r.url)))?;
        let mut resp = self.exec(&r, &url).await?;
        for _ in 0..AUTH_REDIRECT_LIMIT {
            let Some(next) = next_within_origin(&r.method, &resp) else { break };
            resp = self.exec(&r, &next).await?;
        }
        Ok(resp)
    }

    fn initialize(&self, ctx: &mut Ctx) -> Result<(), McpError> {
        ctx.tokens = self.storage.get_tokens()?;
        ctx.client_info = self.storage.get_client_info()?;
        ctx.initialized = true;
        Ok(())
    }

    /// `async_auth_flow` for one transport request.
    ///
    /// `started` fires once the flow lock is held (request ordering matches
    /// v2, where the auth lock serializes transport requests).
    pub async fn send(&self, client: &reqwest::Client, req: reqwest::Request, started: Option<tokio::sync::oneshot::Sender<()>>) -> Result<reqwest::Response, McpError> {
        let mut ctx = self.ctx.lock().await;
        if let Some(tx) = started {
            let _ = tx.send(());
        }
        if !ctx.initialized {
            self.initialize(&mut ctx)?;
        }
        ctx.protocol_version = req.headers().get("mcp-protocol-version").and_then(|v| v.to_str().ok()).map(String::from);
        if !ctx.token_valid() && ctx.can_refresh() {
            let r = self.refresh_request(&ctx)?;
            let resp = self.send_auth(r).await?;
            if !self.handle_refresh_response(&mut ctx, &resp)? {
                ctx.initialized = false;
            }
        }
        let retry = req.try_clone();
        let mut req = req;
        if ctx.token_valid() {
            add_auth(&ctx, &mut req);
        }
        let resp = client.execute(req).await.map_err(transport_err)?;
        let status = resp.status().as_u16();
        let www = resp.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).map(String::from);
        let step_up = status == 403 && www_auth_field(www.as_deref(), "error").as_deref() == Some("insufficient_scope");
        if status != 401 && !step_up {
            return Ok(resp);
        }
        drop(resp);
        if let Err(e) = self.full_flow(&mut ctx, status, www.as_deref(), step_up).await {
            tracing::error!("OAuth flow error: {}", e.formatted());
            return Err(e);
        }
        let Some(mut req) = retry else { return Err(McpError::Transport("RuntimeError", "request body is not replayable".into())) };
        add_auth(&ctx, &mut req);
        client.execute(req).await.map_err(transport_err)
    }

    fn refresh_request(&self, ctx: &Ctx) -> Result<AuthReq, McpError> {
        let rt = ctx.tokens.as_ref().and_then(|t| t.refresh_token.clone()).ok_or_else(|| token_err("No refresh token available".into()))?;
        let cid = ctx.client_info.as_ref().and_then(|c| ci_str(c, "client_id")).filter(|s| !s.is_empty()).ok_or_else(|| token_err("No client info available".into()))?;
        let mut data = vec![("grant_type".to_string(), "refresh_token".to_string()), ("refresh_token".into(), rt), ("client_id".into(), cid.to_string())];
        if ctx.include_resource() {
            data.push(("resource".into(), ctx.resource_url(&self.server_url)));
        }
        let (data, headers) = ctx.prepare_token_auth(data)?;
        Ok(AuthReq::form(ctx.token_endpoint(&self.server_url), &data, headers))
    }

    fn handle_refresh_response(&self, ctx: &mut Ctx, resp: &Resp) -> Result<bool, McpError> {
        if resp.status != 200 {
            tracing::warn!("Token refresh failed: {}{}", resp.status, redirect_note(resp));
            ctx.clear_tokens();
            return Ok(false);
        }
        let parsed = serde_json::from_slice::<Value>(&resp.body).map_err(|e| e.to_string()).and_then(|v| Token::validate(&v));
        let mut t = match parsed {
            Ok(t) => t,
            Err(_) => {
                tracing::error!("Invalid refresh response");
                ctx.clear_tokens();
                return Ok(false);
            }
        };
        if let Some(prior) = &ctx.tokens {
            if t.scope.is_none() {
                t.scope = prior.scope.clone();
            }
            if t.refresh_token.is_none() {
                t.refresh_token = prior.refresh_token.clone();
            }
        }
        self.storage.set_tokens(&t)?;
        ctx.set_tokens(t);
        Ok(true)
    }

    async fn full_flow(&self, ctx: &mut Ctx, status: u16, www: Option<&str>, step_up: bool) -> Result<(), McpError> {
        let granted_scope = ctx.tokens.as_ref().and_then(|t| t.scope.clone());
        if status == 401 || ctx.oauth_metadata.is_none() {
            // Step 1: protected resource metadata (SEP-985).
            let www_rm = if matches!(status, 401 | 403) { www_auth_field(www, "resource_metadata") } else { None };
            let mut urls: Vec<String> = www_rm.into_iter().collect();
            let p = urlsplit(&self.server_url);
            let base = format!("{}://{}", p.scheme, p.netloc);
            if !p.path.is_empty() && p.path != "/" {
                urls.push(format!("{base}/.well-known/oauth-protected-resource{}", p.path));
            }
            urls.push(format!("{base}/.well-known/oauth-protected-resource"));
            let mut prm_failed = None;
            let mut found = false;
            for u in urls {
                let r = self.send_auth(AuthReq::metadata(u.clone())).await?;
                if r.status >= 500 || r.status == 429 {
                    prm_failed = Some(r.status);
                }
                if let Some(prm) = (r.status == 200).then(|| Prm::validate(&r.body)).flatten() {
                    let default = resource_url_from_server_url(&self.server_url);
                    if !check_resource_allowed(&default, &prm.resource) {
                        return Err(flow_err(format!("Protected resource {} does not match expected {default}", prm.resource)));
                    }
                    ctx.auth_server_url = Some(prm.authorization_servers[0].clone());
                    ctx.prm = Some(prm);
                    found = true;
                    break;
                }
                tracing::debug!("Protected resource metadata discovery failed: {u}");
            }
            if !found {
                if let Some(code) = prm_failed {
                    return Err(flow_err(format!("Protected resource metadata request failed: HTTP {code}")));
                }
            }
            let mut expected = ctx.expected_issuer(&self.server_url);
            // SEP-2352: credentials bound to another issuer are dropped.
            if let Some(ci) = &ctx.client_info {
                if let Some(bound) = ci_str(ci, "issuer") {
                    if !issuers_match(bound, &expected) {
                        tracing::debug!("Authorization server changed; discarding bound credentials and re-registering");
                        ctx.client_info = None;
                        ctx.clear_tokens();
                        ctx.oauth_metadata = None;
                    }
                }
            }
            // Step 2: authorization server metadata.
            let asm_urls: Vec<String> = match &ctx.auth_server_url {
                None => vec![format!("{base}/.well-known/oauth-authorization-server")],
                Some(a) => {
                    let ap = urlsplit(a);
                    let abase = format!("{}://{}", ap.scheme, ap.netloc);
                    if !ap.path.is_empty() && ap.path != "/" {
                        let path = ap.path.trim_end_matches('/');
                        vec![
                            format!("{abase}/.well-known/oauth-authorization-server{path}"),
                            format!("{abase}/.well-known/openid-configuration{path}"),
                            format!("{abase}{path}/.well-known/openid-configuration"),
                        ]
                    } else {
                        vec![format!("{abase}/.well-known/oauth-authorization-server"), format!("{abase}/.well-known/openid-configuration")]
                    }
                }
            };
            for u in asm_urls {
                let r = self.send_auth(AuthReq::metadata(u.clone())).await?;
                let asm = match r.status {
                    200 => self.parse_asm(ctx, &r),
                    300..=499 => None,
                    _ => break,
                };
                if let Some(asm) = asm {
                    if ctx.auth_server_url.is_none() && issuers_match(&asm.issuer, &expected) {
                        expected = asm.issuer.clone();
                    }
                    if asm.issuer != expected {
                        return Err(flow_err(format!("Authorization server metadata issuer mismatch: {} != {expected}", asm.issuer)));
                    }
                    ctx.oauth_metadata = Some(asm);
                    break;
                }
                tracing::debug!("OAuth metadata discovery failed: {u}");
            }
        }
        // Step 3: scope selection.
        let challenged = select_scopes(www_auth_field(www, "scope"), ctx.prm.as_ref(), ctx.oauth_metadata.as_ref(), &GRANT_TYPES);
        ctx.scope = if step_up { union_scopes(union_scopes(ctx.scope.clone(), granted_scope), challenged) } else { challenged };
        // Step 4: dynamic client registration.
        if ctx.client_info.is_none() {
            let discovered = ctx.oauth_metadata.is_some().then(|| ctx.expected_issuer(&self.server_url));
            let fallback = base_url(&self.server_url);
            let reg_url = ctx.oauth_metadata.as_ref().and_then(|m| m.registration_endpoint.clone()).unwrap_or_else(|| format!("{fallback}/register"));
            let mut md = Map::new();
            md.insert("response_types".into(), json!(["code"]));
            if let Some(s) = &ctx.scope {
                md.insert("scope".into(), json!(s));
            }
            md.insert("client_name".into(), json!("OpenAgentd"));
            md.insert("redirect_uris".into(), json!([self.callback.redirect_uri]));
            md.insert("token_endpoint_auth_method".into(), json!(self.auth_method));
            md.insert("grant_types".into(), json!(GRANT_TYPES));
            md.insert("application_type".into(), json!("native"));
            let req = AuthReq {
                method: reqwest::Method::POST,
                url: reg_url,
                headers: vec![("content-type", "application/json".into())],
                body: Some(serde_json::to_vec(&Value::Object(md)).unwrap_or_default()),
            };
            let r = self.send_auth(req).await?;
            if !matches!(r.status, 200 | 201) {
                return Err(reg_err(format!("Registration failed: {}{} {}", r.status, redirect_note(&r), r.text())));
            }
            let mut body: Value = serde_json::from_slice(&r.body).map_err(|e| reg_err(format!("Invalid registration response: {e}")))?;
            if let Some(o) = body.as_object_mut() {
                o.shift_remove("issuer");
            }
            let mut ci = validate_client_info(&body).map_err(|e| reg_err(format!("Invalid registration response: {e}")))?;
            let method = ci_str(&ci, "token_endpoint_auth_method").map(String::from);
            if !matches!(method.as_deref(), None | Some("none" | "client_secret_post" | "client_secret_basic")) {
                return Err(reg_err(format!("Authorization server registered the client with unsupported token_endpoint_auth_method {}", repr_opt(method.as_deref()))));
            }
            if matches!(method.as_deref(), Some("client_secret_post" | "client_secret_basic")) && ci.get("client_secret").map(|v| v.is_null()).unwrap_or(true) {
                return Err(reg_err(format!("Authorization server registered the client for {} but issued no client_secret", repr_opt(method.as_deref()))));
            }
            if let (Some(m), Some(iss)) = (&ctx.oauth_metadata, discovered) {
                if m.registration_endpoint.is_some() || base_url(&iss) == fallback {
                    ci.insert("issuer".into(), json!(iss));
                }
            }
            self.storage.set_client_info(&ci)?;
            ctx.client_info = Some(ci);
        }
        // Step 5: authorization + token exchange.
        let (code, verifier) = self.authorization_code_grant(ctx).await?;
        let ci = ctx.client_info.as_ref().ok_or_else(|| flow_err("Missing client info".into()))?;
        let mut data = vec![
            ("grant_type".to_string(), "authorization_code".to_string()),
            ("code".into(), code),
            ("redirect_uri".into(), self.callback.redirect_uri.clone()),
            ("client_id".into(), ci_str(ci, "client_id").unwrap_or("").to_string()),
            ("code_verifier".into(), verifier),
        ];
        if ctx.include_resource() {
            data.push(("resource".into(), ctx.resource_url(&self.server_url)));
        }
        let (data, headers) = ctx.prepare_token_auth(data)?;
        let r = self.send_auth(AuthReq::form(ctx.token_endpoint(&self.server_url), &data, headers)).await?;
        if !matches!(r.status, 200 | 201) {
            return Err(token_err(format!("Token exchange failed ({}){}: {}", r.status, redirect_note(&r), r.text())));
        }
        let mut t = serde_json::from_slice::<Value>(&r.body)
            .map_err(|e| format!("1 validation error for OAuthToken\n  Invalid JSON: {e}"))
            .and_then(|v| Token::validate(&v))
            .map_err(|e| token_err(format!("Invalid token response: {e}")))?;
        if t.scope.is_none() {
            t.scope = ctx.scope.clone();
        }
        self.storage.set_tokens(&t)?;
        ctx.set_tokens(t);
        Ok(())
    }

    /// AS metadata parse with v2's root-slash issuer normalization.
    fn parse_asm(&self, ctx: &Ctx, r: &Resp) -> Option<AsMeta> {
        let mut v: Value = serde_json::from_slice(&r.body).ok()?;
        let path = r.url.path();
        if let Some(expected) = &ctx.auth_server_url {
            if path.contains("/.well-known/oauth-authorization-server") || path.contains("/.well-known/openid-configuration") {
                if let Some(actual) = v.get("issuer").and_then(|i| i.as_str()).map(String::from) {
                    if root_slash_variant(&actual, expected) {
                        tracing::debug!("mcp_oauth_normalized_root_issuer actual={} expected={}", actual, expected);
                        v["issuer"] = json!(expected);
                    }
                }
            }
        }
        AsMeta::validate_value(&v)
    }

    async fn authorization_code_grant(&self, ctx: &Ctx) -> Result<(String, String), McpError> {
        let auth_endpoint = match &ctx.oauth_metadata {
            Some(m) => m.authorization_endpoint.clone(),
            None => format!("{}/authorize", base_url(&self.server_url)),
        };
        let ci = ctx.client_info.as_ref().ok_or_else(|| flow_err("No client info available for authorization".into()))?;
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
        let verifier: String = random_bytes(128).iter().map(|b| CHARS[*b as usize % CHARS.len()] as char).collect();
        let challenge = pkce_challenge(&verifier);
        let state = b64url(&random_bytes(32));
        let mut params: Vec<(String, String)> = vec![
            ("response_type".into(), "code".into()),
            ("client_id".into(), ci_str(ci, "client_id").unwrap_or("").into()),
            ("redirect_uri".into(), self.callback.redirect_uri.clone()),
            ("state".into(), state.clone()),
            ("code_challenge".into(), challenge),
            ("code_challenge_method".into(), "S256".into()),
        ];
        if ctx.include_resource() {
            params.push(("resource".into(), ctx.resource_url(&self.server_url)));
        }
        if let Some(scope) = ctx.scope.as_deref().filter(|s| !s.is_empty()) {
            params.push(("scope".into(), scope.into()));
            if scope.split_whitespace().any(|s| s == "offline_access") {
                params.push(("prompt".into(), "consent".into()));
            }
        }
        let pairs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let url = format!("{auth_endpoint}?{}", urlencode(&pairs));
        // redirect_handler
        if !interactive_oauth_allowed(&self.name) {
            return Err(required(needs_oauth_message(&self.name)));
        }
        tracing::info!("mcp_oauth_authorize name={} url={}", self.name, url);
        if let Err(e) = open_browser(&url) {
            tracing::warn!("mcp_oauth_browser_open_failed name={} error={}", self.name, e);
        }
        let result = self.callback.wait().await?;
        let state_ok = result.state.as_deref().map(|s| constant_eq(s.as_bytes(), state.as_bytes())).unwrap_or(false);
        if !state_ok {
            return Err(flow_err(format!("State parameter mismatch: {} != {state}", result.state.as_deref().unwrap_or("None"))));
        }
        // RFC 9207
        let expected = ctx.oauth_metadata.as_ref().map(|m| m.issuer.clone());
        match &result.iss {
            Some(iss) => {
                if Some(iss) != expected.as_ref() {
                    return Err(flow_err(format!("Authorization response iss mismatch: {iss} != {}", expected.as_deref().unwrap_or("None"))));
                }
            }
            None => {
                if ctx.oauth_metadata.as_ref().and_then(|m| m.authorization_response_iss_parameter_supported).unwrap_or(false) {
                    return Err(flow_err("Authorization response missing iss parameter advertised by the authorization server".into()));
                }
            }
        }
        if result.code.is_empty() {
            return Err(flow_err("No authorization code received".into()));
        }
        Ok((result.code, verifier))
    }
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_helpers() {
        assert_eq!(norm_http("https://Ex.COM").as_deref(), Some("https://ex.com"));
        assert_eq!(norm_http("https://ex.com/").as_deref(), Some("https://ex.com/"));
        assert_eq!(norm_http("https://ex.com:443/a/").as_deref(), Some("https://ex.com/a/"));
        assert_eq!(norm_http("HTTPS://ex.com:8443/x?y=1").as_deref(), Some("https://ex.com:8443/x?y=1"));
        assert_eq!(norm_http("https://ex.com?y=1").as_deref(), Some("https://ex.com?y=1"));
        assert_eq!(norm_http("https://ex.com/a b").as_deref(), Some("https://ex.com/a%20b"));
        assert_eq!(norm_http("ftp://ex.com"), None);
        assert_eq!(resource_url_from_server_url("HTTP://Ex.com/MCP#frag"), "http://ex.com/MCP");
        assert!(check_resource_allowed("https://a.com/mcp", "https://a.com"));
        assert!(check_resource_allowed("https://a.com/mcp", "https://a.com/mcp/"));
        assert!(!check_resource_allowed("https://a.com/api123", "https://a.com/api"));
        assert!(root_slash_variant("https://a.com/", "https://a.com"));
        assert!(!root_slash_variant("https://a.com/x", "https://a.com"));
        assert!(issuers_match("https://a.com", "https://a.com/"));
        assert!(!issuers_match("https://a.com/x", "https://a.com/x/"));
        assert_eq!(origin_issuer("https://A.com:443/mcp"), "https://a.com");
        assert_eq!(www_auth_field(Some(r#"Bearer error="insufficient_scope", scope="a b", resource_metadata=https://x/y"#), "scope").as_deref(), Some("a b"));
        assert_eq!(www_auth_field(Some(r#"Bearer resource_metadata=https://x/y, x=1"#), "resource_metadata").as_deref(), Some("https://x/y"));
    }

    #[test]
    fn scopes() {
        let asm = AsMeta {
            issuer: "https://a".into(),
            authorization_endpoint: "https://a/auth".into(),
            token_endpoint: "https://a/tok".into(),
            registration_endpoint: None,
            scopes_supported: Some(vec!["read".into(), "offline_access".into()]),
            authorization_response_iss_parameter_supported: None,
        };
        assert_eq!(select_scopes(Some("x".into()), None, Some(&asm), &GRANT_TYPES).as_deref(), Some("x offline_access"));
        assert_eq!(select_scopes(None, None, Some(&asm), &GRANT_TYPES).as_deref(), Some("read offline_access"));
        assert_eq!(select_scopes(None, None, None, &GRANT_TYPES), None);
        assert_eq!(union_scopes(Some("a b".into()), Some("b c".into())).as_deref(), Some("a b c"));
    }

    #[test]
    fn models() {
        let t = Token::validate(&json!({"access_token": "a", "token_type": "bearer", "expires_in": "3600"})).unwrap();
        assert_eq!(t.dump().to_string(), r#"{"access_token":"a","token_type":"Bearer","expires_in":3600,"scope":null,"refresh_token":null}"#);
        assert!(Token::validate(&json!({"access_token": "a", "token_type": "mac"})).is_err());
        let ci = validate_client_info(&json!({"client_id": "x", "redirect_uris": ["http://localhost:5/callback"], "client_uri": "https://Ex.com", "scope": "a b", "client_id_issued_at": "12", "logo_uri": ""})).unwrap();
        assert_eq!(
            Value::Object(ci).to_string(),
            r#"{"response_types":["code"],"scope":"a b","client_name":null,"client_uri":"https://ex.com","logo_uri":null,"contacts":null,"tos_uri":null,"policy_uri":null,"jwks_uri":null,"jwks":null,"software_id":null,"software_version":null,"redirect_uris":["http://localhost:5/callback"],"token_endpoint_auth_method":null,"grant_types":["authorization_code","refresh_token"],"application_type":null,"client_id":"x","client_secret":null,"client_id_issued_at":12,"client_secret_expires_at":null,"issuer":null}"#
        );
    }
}
