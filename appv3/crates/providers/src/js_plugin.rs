//! Provider plugins written in JavaScript/TypeScript (`export const provider`).
//!
//! `provider.build(ctx)` returns an *instance* object kept alive in the
//! plugin runtime. Its `base` picks how requests are made:
//!   * `"anthropic"` — the built-in Anthropic Messages provider does the HTTP
//!     and stream parsing; the instance can refresh auth (`beforeCall`) and
//!     rewrite inputs / chunks / responses.
//!   * `"http"` — the plugin builds each request (`request`) and parses each
//!     SSE payload (`streamParser().event`) / JSON response (`parseResponse`);
//!     OpenAgentd performs the I/O.

use crate::anthropic::{build_headers, AnthropicProvider};
use crate::creds::CredentialStore;
use crate::openai::shared_client;
use crate::plugin::*;
use crate::plugin_json::*;
use crate::sse;
use crate::types::*;
use crate::usage::usage_to_dict;
use appv3_jsplugin::{Callback, JsError, JsPlugin, Mode, Target};
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_ANTHROPIC_BASE: &str = "https://api.anthropic.com";

/// Map a JS exception to a provider error by its `kind`
/// (`AuthError`, `ValueError`, `HttpError`, … from `openagentd`).
pub fn provider_error(e: JsError) -> ProviderError {
    let msg = e.message.clone();
    match e.prop_str("kind") {
        Some("auth") => ProviderError::Auth(msg),
        Some("invalid") => ProviderError::Invalid(msg),
        Some("unconfigured") => ProviderError::Unconfigured(msg),
        Some("network") => ProviderError::Network(msg),
        Some("http") => ProviderError::Http {
            status: e.props.get("status").and_then(|s| s.as_u64()).unwrap_or(500) as u16,
            body: e.prop_str("body").unwrap_or("").to_string(),
            headers: header_pairs(e.props.get("headers")),
            message: msg,
        },
        _ => ProviderError::Other(msg),
    }
}

/// Headers given as `{k: v}` or `[[k, v], …]`.
fn header_pairs(v: Option<&Value>) -> Vec<(String, String)> {
    let as_s = |x: &Value| x.as_str().map(String::from).unwrap_or_else(|| x.to_string());
    match v {
        Some(Value::Object(o)) => o.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), as_s(v))).collect(),
        Some(Value::Array(a)) => a.iter().filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), as_s(p.get(1)?)))).collect(),
        _ => vec![],
    }
}

fn credentials_arg(c: &CredentialStore) -> Value {
    json!({"$oadCredentials": {"providerId": c.provider_id, "credentialId": c.credential_id, "overrides": c.overrides(), "pinned": c.pinned_values()}})
}

fn credentials_from_arg(a: &Value) -> CredentialStore {
    let values = |key: &str| a.get(key).and_then(|o| o.as_object()).map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect());
    let provider = a.get("provider").and_then(|p| p.as_str()).unwrap_or("");
    let id = a.get("credentialId").and_then(|c| c.as_str());
    let overrides = values("overrides").unwrap_or_default();
    let mut store = match a.get("pinned").and_then(|p| p.as_object()) {
        Some(values) => {
            CredentialStore::for_credential(provider, values.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).with_overrides(overrides)
        }
        None => match id {
            Some(id) => CredentialStore::for_account(provider, id).with_overrides(overrides),
            None => CredentialStore::for_provider(provider, overrides),
        },
    };
    store.credential_id = id.map(String::from);
    store
}

fn oauth_document(a: Value) -> Result<Value, String> {
    use appv3_core::credentials as store;
    let provider = a.get("provider").and_then(|p| p.as_str()).ok_or("OAuth storage requires a provider")?;
    let id = a.get("credentialId").and_then(|p| p.as_str()).ok_or("OAuth storage requires a scoped credential")?;
    let action = a.get("action").and_then(|p| p.as_str()).unwrap_or("read");
    if action == "read" {
        let f = store::load().map_err(|e| e.to_string())?;
        return f.find(provider, id).map(|c| c.oauth.clone().unwrap_or(Value::Null)).ok_or_else(|| "OAuth account no longer exists".into());
    }
    if !matches!(action, "write" | "remove") {
        return Err("Unknown OAuth storage operation".into());
    }
    let document = a.get("document").cloned().unwrap_or(Value::Null);
    if action == "write" && !document.as_object().is_some_and(|o| !o.is_empty()) {
        return Err("OAuth tokens must be a nonempty object; use removeOAuth() to revoke an account".into());
    }
    let changed = store::update(|f| {
        let c = f.find_mut(provider, id)?;
        if let Some(expected) = a.get("expected") {
            if c.oauth.as_ref().unwrap_or(&Value::Null) != expected {
                return Some(false);
            }
        }
        c.oauth = (action == "write").then_some(document);
        if let Some(label) = a.get("label").and_then(|l| l.as_str()).map(str::trim).filter(|l| !l.is_empty()) {
            c.label = label.to_string();
        }
        Some(true)
    })
    .map_err(|e| e.to_string())?
    .ok_or("OAuth account no longer exists")?;
    if changed && action == "write" {
        store::clear_cooldown(provider, id);
    }
    Ok(json!(changed))
}

/// Natives the `openagentd` module forwards to this crate.
pub fn register_natives() {
    use appv3_jsplugin::register_native;
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        register_native(
            "creds.get",
            Arc::new(|a: Value| {
                let store = credentials_from_arg(&a);
                Ok(json!(store.get(a.get("name").and_then(|n| n.as_str()).unwrap_or(""))))
            }),
        );
        register_native("creds.oauth", Arc::new(oauth_document));
        register_native(
            "gemini.convertMessages",
            Arc::new(|a: Value| {
                let (contents, system) = crate::google::convert_messages(&messages_from_json(&a)?);
                Ok(json!({"contents": contents, "systemInstruction": system}))
            }),
        );
        register_native("gemini.normalizeTurns", Arc::new(|a: Value| Ok(json!(crate::google::normalize_turns(a.as_array().cloned().unwrap_or_default())))));
        register_native("gemini.convertTools", Arc::new(|a: Value| Ok(json!(crate::google::convert_tools(a.as_array().map(|t| t.as_slice()))))));
        register_native(
            "http.statusMessage",
            Arc::new(|a: Value| Ok(json!(http_status_message(a.get("status").and_then(|s| s.as_u64()).unwrap_or(0) as u16, a.get("url").and_then(|u| u.as_str()).unwrap_or(""))))),
        );
    });
}

fn str_field(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn bool_field(v: &Value, k: &str, default: bool) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(default)
}

fn info_from_json(p: &Value) -> PluginInfo {
    PluginInfo {
        id: str_field(p, "id"),
        label: str_field(p, "label"),
        description: str_field(p, "description"),
        kind: str_field(p, "kind"),
        credentials: p
            .get("credentials")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .map(|f| CredentialField {
                name: str_field(f, "name"),
                label: str_field(f, "label"),
                secret: bool_field(f, "secret", true),
                required: bool_field(f, "required", true),
                placeholder: str_field(f, "placeholder"),
            })
            .collect(),
        models_dev_provider_id: str_field(p, "modelsDevProviderId"),
        metadata_source_provider: str_field(p, "metadataSourceProvider"),
        model_registry_aliases: p
            .get("modelRegistryAliases")
            .and_then(|a| a.as_object())
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
            .unwrap_or_default(),
        docs_url: str_field(p, "docsUrl"),
        oauth_command: str_field(p, "oauthCommand"),
        supports_fast_mode: bool_field(p, "supportsFastMode", false),
        supports_prompt_cache_key: bool_field(p, "supportsPromptCacheKey", false),
        supports_multiple_credentials: bool_field(p, "supportsMultipleCredentials", false),
    }
}

pub struct JsProviderPlugin {
    js: Arc<JsPlugin>,
    info: PluginInfo,
    methods: HashSet<String>,
}

impl JsProviderPlugin {
    /// The plugin file's `provider` export, validated like v2's
    /// `_load_provider_plugin` (errors are logged, the file is skipped).
    pub fn from_plugin(js: &Arc<JsPlugin>) -> Option<Self> {
        let d = &js.describe;
        let fail = |e: String| {
            tracing::warn!("provider_plugin_load_failed file={} error={}", js.path.display(), e);
            appv3_jsplugin::report_problem(&js.path, e);
            None
        };
        if let Some(t) = d.get("providerInvalid").and_then(|t| t.as_str()) {
            return fail(format!("provider in {} must be an object, got {t}", js.path.display()));
        }
        let p = d.get("provider")?;
        let info = info_from_json(p);
        let methods: HashSet<String> = d.get("providerMethods").and_then(|m| m.as_array()).into_iter().flatten().filter_map(|m| m.as_str().map(String::from)).collect();
        if info.id.is_empty() || info.id.contains(':') {
            return fail(format!("invalid provider plugin id in {}: {}", js.path.display(), py_repr_str(&info.id)));
        }
        if !methods.contains("build") {
            return fail(format!("provider plugin {} must define build", py_repr_str(&info.id)));
        }
        if info.kind == "oauth" && !methods.contains("login") {
            return fail(format!("oauth provider plugin {} must define login", py_repr_str(&info.id)));
        }
        Some(Self { js: js.clone(), info, methods })
    }

    fn target() -> Target {
        Target::export("provider")
    }

    #[allow(clippy::result_large_err)] // JsError carries name, message, stack and props
    async fn call(&self, method: &str, args: &[Value]) -> Result<Value, JsError> {
        self.js.call(&Self::target(), method, args, Mode::Value).await.map(|r| r.value)
    }

    async fn oauth_step(&self, method: &str, first: Option<Value>, sink: OAuthSink, store: Option<CredentialStore>) -> Result<(), String> {
        let cb = Callback::new(Arc::new(move |args: Vec<Value>| {
            let event = args.first().and_then(|e| e.as_str()).unwrap_or("").to_string();
            let data = args.get(1).cloned().filter(|d| !d.is_null()).unwrap_or_else(|| json!({}));
            sink(&event, data);
            Value::Null
        }));
        let mut args: Vec<Value> = first.into_iter().collect();
        args.push(cb.marker());
        if let Some(store) = store {
            args.push(json!({"providerId": store.provider_id, "credentialId": store.credential_id, "credentials": credentials_arg(&store)}));
        }
        self.call(method, &args).await.map(|_| ()).map_err(|e| e.message)
    }
}

#[async_trait]
impl ProviderPlugin for JsProviderPlugin {
    fn info(&self) -> &PluginInfo {
        &self.info
    }
    fn source(&self) -> Option<&std::path::Path> {
        Some(&self.js.path)
    }

    fn build(&self, ctx: BuildContext) -> ProviderResult<Arc<dyn LlmProvider>> {
        let arg = json!({"providerId": ctx.provider_id, "credentialId": ctx.credentials.credential_id, "model": ctx.model, "modelKwargs": ctx.model_kwargs, "credentials": credentials_arg(&ctx.credentials)});
        let r = self.js.call_blocking(&Self::target(), "build", &[arg], Mode::Keep).map_err(provider_error)?;
        Ok(Arc::new(JsProvider::new(self.js.clone(), &self.info.id, r, ctx)?))
    }

    fn has_login(&self) -> bool {
        self.methods.contains("login")
    }

    async fn login(&self, sink: OAuthSink) -> Result<(), String> {
        self.oauth_step("login", None, sink, None).await
    }

    async fn login_for(&self, sink: OAuthSink, store: CredentialStore) -> Result<(), String> {
        self.oauth_step("login", None, sink, Some(store)).await
    }

    fn has_oauth_callback(&self) -> bool {
        self.methods.contains("oauthCallback")
    }

    async fn oauth_callback(&self, code: &str, sink: OAuthSink) -> Result<(), String> {
        self.oauth_step("oauthCallback", Some(json!(code)), sink, None).await
    }

    async fn oauth_callback_for(&self, code: &str, sink: OAuthSink, store: CredentialStore) -> Result<(), String> {
        self.oauth_step("oauthCallback", Some(json!(code)), sink, Some(store)).await
    }

    fn is_configured(&self, store: &CredentialStore) -> Option<bool> {
        if !self.methods.contains("isConfigured") {
            return None;
        }
        match self.js.call_blocking(&Self::target(), "isConfigured", &[credentials_arg(store)], Mode::Value) {
            Ok(r) => Some(match r.value {
                Value::Bool(b) => b,
                Value::Null => false,
                Value::Number(n) => n.as_f64() != Some(0.0),
                Value::String(s) => !s.is_empty(),
                _ => true,
            }),
            Err(e) => {
                tracing::warn!("provider_plugin_is_configured_failed provider={} error={}", self.info.id, e);
                Some(false)
            }
        }
    }

    fn has_discover_models(&self) -> bool {
        self.methods.contains("discoverModels")
    }

    async fn discover_models(&self, store: &CredentialStore) -> Result<Vec<String>, String> {
        let v = self.call("discoverModels", &[credentials_arg(store)]).await.map_err(|e| e.message)?;
        Ok(v.as_array().into_iter().flatten().map(|m| m.as_str().map(String::from).unwrap_or_else(|| m.to_string())).collect())
    }

    fn has_usage(&self) -> bool {
        self.methods.contains("getUsage")
    }

    async fn get_usage(&self, store: &CredentialStore) -> Result<Value, PluginUsageError> {
        let v = self.call("getUsage", &[credentials_arg(store)]).await.map_err(|e| {
            if e.prop_str("kind") == Some("invalid") {
                PluginUsageError::Value(e.message)
            } else {
                PluginUsageError::Other(e.message)
            }
        })?;
        normalize_usage(&v).map_err(PluginUsageError::Other)
    }
}

/// Validate a plugin's usage payload into the `ProviderUsageResponse` shape
/// (every field present, v2 schema order), like pydantic does in v2.
fn normalize_usage(v: &Value) -> Result<Value, String> {
    let o = v.as_object().ok_or("getUsage() must return {provider, limits}")?;
    let int = |x: Option<&Value>| x.and_then(|n| n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)));
    let window = |w: Option<&Value>| -> Option<UsageWindow> {
        let w = w?.as_object()?;
        Some(UsageWindow {
            used_percent: w.get("used_percent").and_then(|p| p.as_f64()).unwrap_or(0.0),
            window_minutes: int(w.get("window_minutes")),
            resets_at: int(w.get("resets_at")),
        })
    };
    let s = |l: &Map<String, Value>, k: &str| l.get(k).and_then(|x| x.as_str()).map(String::from);
    let limits: Vec<UsageLimit> = o
        .get("limits")
        .and_then(|l| l.as_array())
        .into_iter()
        .flatten()
        .filter_map(|l| l.as_object())
        .map(|l| UsageLimit {
            limit_id: s(l, "limit_id"),
            limit_name: s(l, "limit_name"),
            primary: window(l.get("primary")),
            secondary: window(l.get("secondary")),
            credits: l.get("credits").filter(|c| !c.is_null()).cloned(),
            spend: l.get("spend").filter(|c| !c.is_null()).cloned(),
            plan_type: s(l, "plan_type"),
            rate_limit_reached_type: s(l, "rate_limit_reached_type"),
            reset_credits_available: int(l.get("reset_credits_available")),
            period_start_at: int(l.get("period_start_at")),
            period_end_at: int(l.get("period_end_at")),
        })
        .collect();
    Ok(usage_response(o.get("provider").and_then(|p| p.as_str()).unwrap_or(""), limits))
}

enum Base {
    Anthropic { inner: Box<AnthropicProvider>, use_api_key_header: bool },
    Http,
}

/// A provider instance created by a JS plugin's `build()`.
pub struct JsProvider {
    js: Arc<JsPlugin>,
    handle: u64,
    methods: HashSet<String>,
    model: String,
    provider_name: Option<String>,
    kw: Kwargs,
    /// `None` = default (`provider:model`); `Some(None)` = no cost lookups.
    cost_model: Option<Option<String>>,
    interrupt: bool,
    base: Base,
}

impl Drop for JsProvider {
    fn drop(&mut self) {
        self.js.release(self.handle);
    }
}

/// Releases a kept JS object when a stream is dropped.
struct HandleGuard(Arc<JsPlugin>, u64);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        self.0.release(self.1);
    }
}

fn ms(v: Option<&Value>) -> Option<Duration> {
    v.and_then(|x| x.as_f64()).map(|m| Duration::from_secs_f64(m.max(0.0) / 1000.0))
}

impl JsProvider {
    fn new(js: Arc<JsPlugin>, plugin_id: &str, r: appv3_jsplugin::CallResult, ctx: BuildContext) -> ProviderResult<Self> {
        let handle = r.handle.ok_or_else(|| ProviderError::Other("build() returned no instance".into()))?;
        let guard = HandleGuard(js.clone(), handle);
        let v = &r.value;
        let methods: HashSet<String> = r.methods.into_iter().collect();
        let base = match v.get("base").and_then(|b| b.as_str()) {
            Some("anthropic") => {
                let o = v.get("options").cloned().unwrap_or_else(|| json!({}));
                let use_api_key_header = bool_field(&o, "useApiKeyHeader", true);
                let timeout = match o.get("timeoutMs") {
                    None => Some(Duration::from_secs(120)),
                    t => ms(t),
                };
                let base_url = Some(str_field(&o, "baseUrl")).filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_ANTHROPIC_BASE.into());
                let mut inner = AnthropicProvider::with_options(
                    &str_field(&o, "apiKey"),
                    &ctx.model,
                    &base_url,
                    ctx.model_kwargs.clone(),
                    &header_pairs(o.get("headers")),
                    use_api_key_header,
                    bool_field(&o, "beta", false),
                    timeout,
                )?;
                inner.provider_name = None;
                Base::Anthropic { inner: Box::new(inner), use_api_key_header }
            }
            Some("http") => {
                for m in ["request", "streamParser", "parseResponse"] {
                    if !methods.contains(m) {
                        return Err(ProviderError::Invalid(format!("provider plugin {}: an http instance must define {m}()", py_repr_str(plugin_id))));
                    }
                }
                Base::Http
            }
            other => return Err(ProviderError::Invalid(format!("provider plugin {}: build() returned an unknown base {other:?}", py_repr_str(plugin_id)))),
        };
        let provider_name = match v.get("providerName") {
            None => Some(ctx.provider_id.clone()),
            Some(p) => p.as_str().map(String::from),
        };
        let cost_model = v.get("costModelId").map(|c| c.as_str().map(String::from));
        std::mem::forget(guard);
        Ok(Self { js, handle, methods, model: ctx.model, provider_name, kw: ctx.model_kwargs, cost_model, interrupt: bool_field(v, "supportInterrupt", true), base })
    }

    fn target(&self) -> Target {
        Target::Handle(self.handle)
    }

    async fn call(&self, method: &str, args: &[Value]) -> ProviderResult<Value> {
        self.js.call(&self.target(), method, args, Mode::Value).await.map(|r| r.value).map_err(provider_error)
    }

    fn call_json(messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs, stream: bool) -> Value {
        json!({"messages": messages_to_json(messages), "tools": tools, "kwargs": kwargs, "stream": stream})
    }

    /// `beforeCall` + `transformInput` (anthropic base).
    async fn prepare(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs, stream: bool) -> ProviderResult<(Vec<ChatMessage>, Option<Vec<ToolSpec>>)> {
        if let (Base::Anthropic { inner, use_api_key_header }, true) = (&self.base, self.methods.contains("beforeCall")) {
            let r = self.call("beforeCall", &[json!({"stream": stream})]).await?;
            if let Some(o) = r.as_object() {
                if o.contains_key("apiKey") || o.contains_key("headers") {
                    inner.set_headers(build_headers(o.get("apiKey").and_then(|k| k.as_str()).unwrap_or(""), &header_pairs(o.get("headers")), *use_api_key_header));
                }
            }
        }
        let mut msgs = messages.to_vec();
        let mut tls = tools.map(|t| t.to_vec());
        if self.methods.contains("transformInput") {
            let r = self.call("transformInput", &[Self::call_json(messages, tools, &self.merged_kwargs(kwargs), stream)]).await?;
            if let Some(m) = r.get("messages") {
                msgs = messages_from_json(m).map_err(|e| ProviderError::Other(format!("transformInput: {e}")))?;
            }
            if let Some(t) = r.get("tools") {
                tls = t.as_array().cloned();
            }
        }
        Ok((msgs, tls))
    }

    async fn transform_response(&self, a: AssistantMessage) -> ProviderResult<AssistantMessage> {
        if !self.methods.contains("transformResponse") {
            return Ok(a);
        }
        let v = self.call("transformResponse", &[assistant_to_json(&a)]).await?;
        assistant_from_json(&v).map_err(|e| ProviderError::Other(format!("transformResponse: {e}")))
    }

    /// `request()` → the HTTP request description (http base).
    async fn http_request(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs, stream: bool) -> ProviderResult<(Value, Value)> {
        let call = Self::call_json(messages, tools, &self.merged_kwargs(kwargs), stream);
        let req = self.call("request", std::slice::from_ref(&call)).await?;
        if req.get("url").and_then(|u| u.as_str()).is_none() {
            return Err(ProviderError::Other("request() must return an object with a url".into()));
        }
        Ok((req, call))
    }

    async fn http_send(&self, req: &Value, stream: bool) -> ProviderResult<reqwest::Response> {
        let method =
            reqwest::Method::from_bytes(req.get("method").and_then(|m| m.as_str()).unwrap_or("POST").to_uppercase().as_bytes()).map_err(|e| ProviderError::Other(e.to_string()))?;
        let mut b = shared_client().request(method, req["url"].as_str().unwrap_or(""));
        for (k, v) in header_pairs(req.get("headers")) {
            b = b.header(k, v);
        }
        if let Some(body) = req.get("body").filter(|b| !b.is_null()) {
            b = b.json(body);
        }
        let timeout = ms(req.get("timeoutMs"));
        if stream {
            return sse::send_head(b, timeout).await;
        }
        if let Some(t) = timeout {
            b = b.timeout(t);
        }
        b.send().await.map_err(ProviderError::from_reqwest)
    }

    async fn http_check(&self, resp: reqwest::Response, stream: bool) -> ProviderResult<reqwest::Response> {
        let status = resp.status().as_u16();
        if status < 400 {
            return Ok(resp);
        }
        let url = resp.url().to_string();
        let headers: Vec<(String, String)> = resp.headers().iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect();
        let body = String::from_utf8_lossy(&resp.bytes().await.unwrap_or_default()).into_owned();
        if self.methods.contains("onError") {
            self.call("onError", &[json!({"status": status, "url": url, "headers": headers, "body": body, "stream": stream})]).await?;
        }
        Err(ProviderError::http(status, &url, body, headers))
    }

    fn event_chunk(stream_id: &str, model: &str, item: &Value) -> ProviderResult<Option<ChatCompletionChunk>> {
        let usage: Option<Usage> = match item.get("usage").filter(|u| !u.is_null()) {
            Some(u) => Some(serde_json::from_value(u.clone()).map_err(|e| ProviderError::Other(format!("invalid usage from streamParser: {e}")))?),
            None => None,
        };
        let finish = item.get("finishReason").and_then(|f| f.as_str()).map(String::from);
        match item.get("delta").filter(|d| !d.is_null()) {
            Some(d) => {
                let delta = delta_from_json(d).map_err(|e| ProviderError::Other(format!("invalid delta from streamParser: {e}")))?;
                Ok(Some(ChatCompletionChunk::delta(stream_id, model, delta, finish, usage)))
            }
            None => Ok(usage.map(|u| ChatCompletionChunk::usage_only(stream_id, model, u))),
        }
    }
}

#[async_trait]
impl LlmProvider for JsProvider {
    fn model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> Option<&str> {
        self.provider_name.as_deref()
    }
    fn support_interrupt(&self) -> bool {
        self.interrupt
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    fn cost_model_id(&self) -> Option<String> {
        match &self.cost_model {
            Some(c) => c.clone(),
            None => match self.provider_name() {
                Some(p) if !p.is_empty() && !self.model.is_empty() => Some(format!("{p}:{}", self.model)),
                _ => Some(self.model.clone()),
            },
        }
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        match &self.base {
            Base::Anthropic { inner, .. } => {
                let (msgs, tls) = self.prepare(messages, tools, kwargs, false).await?;
                let a = inner.chat(&msgs, tls.as_deref(), kwargs).await?;
                self.transform_response(a).await
            }
            Base::Http => {
                let (req, _) = self.http_request(messages, tools, kwargs, false).await?;
                let resp = self.http_check(self.http_send(&req, false).await?, false).await?;
                let data: Value = resp.json().await.map_err(ProviderError::from_reqwest)?;
                let r = self.call("parseResponse", &[data]).await?;
                let mut a = assistant_from_json(r.get("message").unwrap_or(&Value::Null)).map_err(|e| ProviderError::Other(format!("parseResponse: {e}")))?;
                if let Some(u) = r.get("usage").filter(|u| !u.is_null()) {
                    let usage: Usage = serde_json::from_value(u.clone()).map_err(|e| ProviderError::Other(format!("parseResponse usage: {e}")))?;
                    a.meta.extra.get_or_insert_with(Map::new).insert("usage".into(), usage_to_dict(&usage, Some(&self.model)));
                }
                Ok(a)
            }
        }
    }

    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        match &self.base {
            Base::Anthropic { inner, .. } => {
                let (msgs, tls) = self.prepare(messages, tools, kwargs, true).await?;
                let s = inner.stream(&msgs, tls.as_deref(), kwargs).await?;
                if !self.methods.contains("transformChunk") {
                    return Ok(s);
                }
                let js = self.js.clone();
                let target = self.target();
                Ok(Box::pin(s.then(move |r| {
                    let js = js.clone();
                    let target = target.clone();
                    async move {
                        let c = r?;
                        let v = js.call(&target, "transformChunk", &[chunk_to_json(&c)], Mode::Value).await.map_err(provider_error)?.value;
                        chunk_from_json(&v).map_err(|e| ProviderError::Other(format!("transformChunk: {e}")))
                    }
                })))
            }
            Base::Http => {
                let (req, call) = self.http_request(messages, tools, kwargs, true).await?;
                let resp = self.http_check(self.http_send(&req, true).await?, true).await?;
                let parser = self.js.call(&self.target(), "streamParser", &[call], Mode::Keep).await.map_err(provider_error)?;
                let ph = parser.handle.ok_or_else(|| ProviderError::Other("streamParser() must return an object".into()))?;
                let guard = HandleGuard(self.js.clone(), ph);
                let js = self.js.clone();
                let model = self.model.clone();
                let stream_id = format!("chatcmpl-{}", uuid::Uuid::now_v7());
                let events = sse::data_json(resp, None, false);
                let s = async_stream::stream! {
                    let _guard = guard;
                    futures::pin_mut!(events);
                    while let Some(ev) = events.next().await {
                        let data = match ev { Ok(d) => d, Err(e) => { yield Err(e); return; } };
                        let v = match js.call(&Target::Handle(ph), "event", &[data], Mode::Value).await {
                            Ok(r) => r.value,
                            Err(e) => { yield Err(provider_error(e)); return; }
                        };
                        let items = match v { Value::Array(a) => a, Value::Null => vec![], other => vec![other] };
                        for item in items.iter().filter(|i| !i.is_null()) {
                            match JsProvider::event_chunk(&stream_id, &model, item) {
                                Ok(Some(c)) => yield Ok(c),
                                Ok(None) => {}
                                Err(e) => { yield Err(e); return; }
                            }
                        }
                    }
                };
                Ok(Box::pin(s))
            }
        }
    }
}
