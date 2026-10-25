//! `/api/settings` — port of `app/api/routes/settings.py`.

use crate::error::{ApiError, ApiResult};
use crate::providers::{self as prov, s};
use crate::schema::Body;
use crate::usage::{self, UsageError};
use crate::util::*;
use crate::AppState;
use appv3_core::credentials as cred_store;
use appv3_core::pyyaml::Py;
use appv3_core::runtime_settings as rs;
use appv3_core::settings;
use appv3_providers::registry::{get_model_cost, ModelCost};
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/denied-paths", get(get_denied).put(put_denied))
        .route("/sandbox", get(get_denied).put(put_denied))
        .route("/lsp", get(get_lsp))
        .route("/lsp/typescript/install", post(install_typescript))
        .route("/summarization", get(get_summarization).put(put_summarization))
        .route("/title-generation", get(get_title).put(put_title))
        .route("/workspace-messages", get(get_workspace_messages).put(put_workspace_messages))
        .route("/multimodal", get(get_multimodal).put(put_multimodal))
        .route("/providers", get(list_providers))
        .route("/providers/usage-summary", get(usage_summary).put(|b: Bytes| save_provider_named("usage-summary".into(), b)))
        .route("/providers/{id}/models", post(provider_models))
        .route("/providers/{id}/usage", get(provider_usage))
        .route("/providers/{id}/reset", post(provider_reset))
        .route("/providers/{id}/visible-models", put(visible_models))
        .route("/providers/{id}/disconnect", put(disconnect))
        .route("/providers/{id}/test", post(test_provider))
        .route("/providers/{id}/credentials", get(list_credentials).post(add_credential))
        .route("/providers/{id}/credentials/order", put(order_credentials))
        .route("/providers/{id}/credentials/{credential_id}", axum::routing::patch(update_credential).delete(delete_credential))
        .route("/providers/{id}", put(save_provider))
        .route("/default-model", post(default_model))
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::internal(e)
}

fn py_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

fn write_yaml(path: &Path, v: &Value) -> std::io::Result<()> {
    let text = appv3_core::pyyaml::safe_dump(v);
    appv3_core::secret_files::write_atomic(path, &text)
}

// ── denied paths ────────────────────────────────────────────────────────────

const DEFAULT_DENIED: [&str; 2] = ["**/.env", "**/.env.*"];

/// One pydantic `ValidationError` entry as `str(exc)` renders it.
fn pydantic_line(loc: &str, msg: &str, ty: &str, input: &Py) -> String {
    let mut iv = input.repr();
    let c: Vec<char> = iv.chars().collect();
    if c.len() > 50 {
        iv = format!("{}...{}", c[..25].iter().collect::<String>(), c[c.len() - 24..].iter().collect::<String>());
    }
    format!("{loc}\n  {msg} [type={ty}, input_value={iv}, input_type={}]\n    For further information visit https://errors.pydantic.dev/2.13/v/{ty}", input.type_name())
}

/// `denied_paths_config.load_config()` — 422 detail on malformed files, 500
/// for exceptions v2's `except ValueError` does not catch.
fn load_denied() -> Result<Vec<String>, ApiError> {
    let cfg = &settings().config_dir;
    let mut path = cfg.join("denied_paths.yaml");
    if !path.exists() {
        let legacy = cfg.join("sandbox.yaml");
        if legacy.exists() {
            path = legacy;
        } else {
            return Ok(DEFAULT_DENIED.map(String::from).to_vec());
        }
    }
    let shown = pstr(&std::path::absolute(&path).unwrap_or(path.clone()));
    let text = std::fs::read_to_string(&path).map_err(|e| ApiError::unprocessable(e.to_string()))?;
    let raw = match appv3_core::pyyaml::safe_load_py(&text) {
        Ok(p) if !p.truthy() => Py::Dict(vec![]),
        Ok(p) => p,
        Err(e) if e.is_yaml_error() => return Err(ApiError::unprocessable(format!("Invalid YAML in {shown}: {e}"))),
        Err(e) if e.kind == "ValueError" => return Err(ApiError::unprocessable(e.to_string())),
        Err(e) => return Err(internal(format!("{}: {e}", e.kind))),
    };
    let Py::Dict(items) = &raw else { return Err(ApiError::unprocessable(format!("{shown}: expected a YAML mapping at top level"))) };
    // `DeniedPathsFileConfig.model_validate(raw)` (extra="forbid", lax str).
    let mut errs: Vec<String> = vec![];
    let mut patterns = DEFAULT_DENIED.map(String::from).to_vec();
    match raw.get("denied_patterns") {
        None => {}
        Some(Py::List(a) | Py::Set(a) | Py::Tuple(a)) => {
            patterns = vec![];
            for (i, x) in a.iter().enumerate() {
                match x {
                    Py::Str(s) => patterns.push(s.clone()),
                    Py::Bytes(b) => patterns.push(String::from_utf8_lossy(b).into_owned()),
                    other => errs.push(pydantic_line(&format!("denied_patterns.{i}"), "Input should be a valid string", "string_type", other)),
                }
            }
        }
        Some(other) => errs.push(pydantic_line("denied_patterns", "Input should be a valid list", "list_type", other)),
    }
    for (k, v) in items {
        if !matches!(k, Py::Str(s) if s == "denied_patterns") {
            match k {
                Py::Str(s) => errs.push(pydantic_line(s, "Extra inputs are not permitted", "extra_forbidden", v)),
                other => errs.push(pydantic_line(&other.repr(), "Keys should be strings", "invalid_key", other)),
            }
        }
    }
    if !errs.is_empty() {
        let detail = format!("{} validation error{} for DeniedPathsFileConfig\n{}", errs.len(), if errs.len() == 1 { "" } else { "s" }, errs.join("\n"));
        return Err(ApiError::unprocessable(detail));
    }
    Ok(patterns.into_iter().filter(|p| !p.trim().is_empty()).collect())
}

async fn get_denied() -> ApiResult<Response> {
    let p = blocking(load_denied).await?;
    Ok(json(json!({"denied_patterns": p})))
}

async fn put_denied(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let patterns = b.list_str("denied_patterns");
    b.finish(&["denied_patterns"])?;
    let cleaned: Vec<String> = patterns.iter().map(|p| crate::routes::library::py_strip(p)).filter(|p| !p.is_empty()).collect();
    let path = settings().config_dir.join("denied_paths.yaml");
    write_yaml(&path, &json!({"denied_patterns": cleaned})).map_err(internal)?;
    tracing::info!("denied_paths_config_saved path={} patterns={}", path.display(), cleaned.len());
    Ok(json(json!({"denied_patterns": cleaned})))
}

// ── LSP (managed language servers) ──────────────────────────────────────────

fn lsp_body(st: &appv3_tools::lsp::ManagedLspStatus) -> Value {
    use appv3_tools::lsp::managed::{TYPESCRIPT_LANGUAGE_SERVER_VERSION, TYPESCRIPT_VERSION};
    json!({
        "downloads_enabled": st.downloads_enabled,
        "python": {"ty": st.ty_available, "ruff": st.ruff_available},
        "typescript": {"state": st.state, "detail": st.detail, "language_server_version": TYPESCRIPT_LANGUAGE_SERVER_VERSION, "typescript_version": TYPESCRIPT_VERSION},
    })
}

async fn get_lsp() -> Response {
    json(blocking(|| lsp_body(&appv3_tools::lsp::managed_lsp_tools().status())).await)
}

async fn install_typescript() -> ApiResult<Response> {
    use appv3_tools::lsp::managed::InstallError;
    match appv3_tools::lsp::managed_lsp_tools().install_typescript().await {
        Ok(st) => Ok(json(lsp_body(&st))),
        Err(InstallError::Permission(msg)) => Err(ApiError::new(403, msg)),
        Err(e) => {
            let ty = match e {
                InstallError::Value(_) => "ValueError",
                InstallError::Runtime(_) => "RuntimeError",
                _ => "Exception",
            };
            tracing::warn!("managed_lsp_install_request_failed error_type={}", ty);
            Err(ApiError::new(502, "TypeScript language-server installation failed; check backend logs."))
        }
    }
}

// ── summarization / title generation ────────────────────────────────────────

fn summarization_json(s: &rs::SummarizationSettings) -> Value {
    json!({
        "prompt_token_threshold": s.prompt_token_threshold,
        "idle_compaction": s.idle_compaction,
        "idle_compaction_percent": s.idle_compaction_percent,
    })
}

async fn get_summarization() -> ApiResult<Response> {
    let cfg = rs::load_runtime_settings().map_err(internal)?;
    Ok(json(summarization_json(&cfg.summarization)))
}

/// `idle_compaction` and `idle_compaction_percent` (v3 only) keep their
/// stored values when the body omits them, so older clients that send only
/// the threshold leave them alone.
async fn put_summarization(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let t = b.opt_int("prompt_token_threshold");
    let has = |k: &str| v.as_object().is_some_and(|o| o.contains_key(k));
    let idle = if has("idle_compaction") { Some(b.bool("idle_compaction", Some(false))) } else { None };
    let percent = if has("idle_compaction_percent") { Some(b.opt_int("idle_compaction_percent")) } else { None };
    b.finish(&["prompt_token_threshold", "idle_compaction", "idle_compaction_percent"])?;
    if matches!(t, Some(x) if x < 1) {
        return Err(ApiError::unprocessable("prompt_token_threshold must be a positive integer or null"));
    }
    if matches!(percent, Some(Some(p)) if !(1..=100).contains(&p)) {
        return Err(ApiError::unprocessable("idle_compaction_percent must be an integer from 1 to 100 or null"));
    }
    let mut cfg = rs::load_runtime_settings().map_err(internal)?;
    cfg.summarization.prompt_token_threshold = t;
    if let Some(on) = idle {
        cfg.summarization.idle_compaction = on;
    }
    if let Some(p) = percent {
        cfg.summarization.idle_compaction_percent = p;
    }
    rs::save_runtime_settings(&cfg).map_err(internal)?;
    Ok(json(summarization_json(&cfg.summarization)))
}

fn title_json(t: &rs::TitleGenerationSettings) -> Value {
    json!({
        "enabled": t.enabled,
        "model": t.model.clone().unwrap_or_default(),
        "wait_timeout_seconds": t.wait_timeout_seconds,
        "update_after_compaction": t.update_after_compaction,
    })
}

async fn get_title() -> ApiResult<Response> {
    let cfg = rs::load_runtime_settings().map_err(internal)?;
    Ok(json(title_json(&cfg.title_generation)))
}

/// `update_after_compaction` (v3 only) keeps its stored value when the body
/// omits it, so older clients leave it alone.
async fn put_title(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let enabled = b.bool("enabled", None);
    let model = b.str("model", Some(""));
    let wait = b.float("wait_timeout_seconds", 3.0);
    let has_update = v.as_object().is_some_and(|o| o.contains_key("update_after_compaction"));
    let update = if has_update { Some(b.bool("update_after_compaction", Some(false))) } else { None };
    b.finish(&["enabled", "model", "wait_timeout_seconds", "update_after_compaction"])?;
    let mut cfg = rs::load_runtime_settings().map_err(internal)?;
    cfg.title_generation.enabled = enabled;
    let m = crate::routes::library::py_strip(&model);
    cfg.title_generation.model = (!m.is_empty()).then_some(m);
    cfg.title_generation.wait_timeout_seconds = wait.max(0.0);
    if let Some(on) = update {
        cfg.title_generation.update_after_compaction = on;
    }
    rs::save_runtime_settings(&cfg).map_err(internal)?;
    Ok(json(title_json(&cfg.title_generation)))
}

// ── workspace messages ──────────────────────────────────────────────────────

async fn get_workspace_messages() -> ApiResult<Response> {
    let cfg = rs::load_runtime_settings().map_err(internal)?;
    Ok(json(json!({"enabled": cfg.workspace_messages.enabled})))
}

async fn put_workspace_messages(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let enabled = b.bool("enabled", None);
    b.finish(&["enabled"])?;
    let mut cfg = rs::load_runtime_settings().map_err(internal)?;
    cfg.workspace_messages.enabled = enabled;
    rs::save_runtime_settings(&cfg).map_err(internal)?;
    Ok(json(json!({"enabled": enabled})))
}

// ── multimodal ──────────────────────────────────────────────────────────────

fn multimodal_path() -> PathBuf {
    settings().config_dir.join("multimodal.yaml")
}

/// Validate one `MultimodalSectionBody` (extra="allow", `model: str = ""`).
fn section(v: Option<&Value>, loc0: &str, errs: &mut Vec<Value>) -> Value {
    let Some(v) = v else { return json!({"model": ""}) };
    let Value::Object(m) = v else {
        errs.push(crate::error::verr("model_attributes_type", &[json!("body"), json!(loc0)], "Input should be a valid dictionary or object to extract fields from", v.clone()));
        return Value::Null;
    };
    let mut out = Map::new();
    match m.get("model") {
        None => {
            out.insert("model".into(), json!(""));
        }
        Some(Value::String(s)) => {
            out.insert("model".into(), json!(s));
        }
        Some(o) => errs.push(crate::error::verr("string_type", &[json!("body"), json!(loc0), json!("model")], "Input should be a valid string", o.clone())),
    }
    for (k, x) in m {
        if k != "model" {
            out.insert(k.clone(), x.clone());
        }
    }
    Value::Object(out)
}

fn multimodal_model(v: &Value) -> Result<Value, Vec<Value>> {
    let mut errs = vec![];
    let Value::Object(m) = v else {
        return Err(vec![crate::error::verr("model_attributes_type", &[json!("body")], "Input should be a valid dictionary or object to extract fields from", v.clone())]);
    };
    let image = section(m.get("image"), "image", &mut errs);
    let video = section(m.get("video"), "video", &mut errs);
    for (k, x) in m {
        if k != "image" && k != "video" {
            errs.push(crate::error::verr("extra_forbidden", &[json!("body"), json!(k)], "Extra inputs are not permitted", x.clone()));
        }
    }
    if errs.is_empty() {
        Ok(json!({"image": image, "video": video}))
    } else {
        Err(errs)
    }
}

fn drop_none(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(_, x)| !x.is_null()).map(|(k, x)| (k.clone(), drop_none(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(drop_none).collect()),
        o => o.clone(),
    }
}

async fn get_multimodal() -> ApiResult<Response> {
    let raw = blocking(|| -> Result<Value, String> {
        let Ok(text) = std::fs::read_to_string(multimodal_path()) else { return Ok(json!({})) };
        match appv3_core::pyyaml::safe_load(&text) {
            Ok(v) => Ok(if py_falsy(&v) || !v.is_object() { json!({}) } else { v }),
            Err(e) if e.is_yaml_error() => {
                tracing::warn!("multimodal_yaml_invalid path={} err={}", multimodal_path().display(), e);
                Ok(json!({}))
            }
            // Non-YAML exceptions (bad timestamp, `!!bool foo`) escape `load_raw_config` in v2.
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(internal)?;
    // v2 validates the stored file with the response model: failures are 500s.
    let body = multimodal_model(&raw).map_err(|_| internal("multimodal.yaml failed MultimodalSettingsBody validation"))?;
    Ok(json(body))
}

async fn put_multimodal(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let body = multimodal_model(&v).map_err(ApiError::validation)?;
    write_yaml(&multimodal_path(), &drop_none(&body)).map_err(internal)?;
    Ok(json(body))
}

// ── providers ───────────────────────────────────────────────────────────────

fn cost_empty(c: &ModelCost) -> bool {
    c.input.is_none() && c.output.is_none() && c.cache_read.is_none() && c.cache_write.is_none()
}

/// `_model_costs_for_provider`.
fn model_costs(provider: &str, models: &[String]) -> Value {
    let mut out = Map::new();
    for m in models {
        let mut c = get_model_cost(Some(&format!("{provider}:{m}")));
        if cost_empty(&c) {
            c = get_model_cost(Some(m));
        }
        if !cost_empty(&c) {
            out.insert(m.clone(), json!({"input": c.input, "output": c.output, "cache_read": c.cache_read, "cache_write": c.cache_write}));
        }
    }
    Value::Object(out)
}

fn get_or<'a>(e: &'a Value, k: &str, d: &'a Value) -> &'a Value {
    e.get(k).unwrap_or(d)
}

async fn list_providers() -> ApiResult<Response> {
    let entries = prov::all_providers();
    let rt = rs::load_runtime_settings().map_err(internal)?;
    let saved: Vec<bool> = entries.iter().map(prov::provider_is_configured).collect();
    let reach = futures::future::join_all(entries.iter().map(prov::provider_is_reachable)).await;
    let empty_list = json!([]);
    let mut out = vec![];
    for ((entry, is_saved), is_configured) in entries.iter().zip(saved).zip(reach) {
        let id = s(entry, "id");
        let pui = prov::ui(&rt, id);
        let (cached, visible) = if !is_saved {
            if !pui.cached_models.is_empty() || !pui.visible_models.is_empty() {
                let _ = rs::forget_provider_models(id);
            }
            (vec![], vec![])
        } else {
            (prov::filter_opencode_models_for_access(id, &pui.cached_models, is_saved), pui.effective_visible_models())
        };
        out.push(json!({
            "id": id,
            "label": s(entry, "label"),
            "description": s(entry, "description"),
            "kind": s(entry, "kind"),
            "credentials": get_or(entry, "credentials", &empty_list),
            "saved_credentials": prov::saved_display_credentials(entry),
            "env_var": s(entry, "env_var"),
            "env_vars": get_or(entry, "env_vars", &empty_list),
            "oauth_command": s(entry, "oauth_command"),
            "docs_url": s(entry, "docs_url"),
            "is_configured": is_configured,
            "is_saved": is_saved,
            "is_reachable": if is_saved { json!(is_configured) } else { Value::Null },
            "cached_models": cached,
            "visible_models": visible,
            "is_disconnected": pui.is_disconnected,
            "supports_fast_mode": entry.get("supports_fast_mode").and_then(|v| v.as_bool()).unwrap_or(false),
            "public_access": entry.get("public_access").and_then(|v| v.as_bool()).unwrap_or(false),
            "model_costs": model_costs(id, &cached),
            "stored_credentials": credentials_json(entry),
            "env_pinned": appv3_providers::pool::env_pinned(id),
            "supports_multiple_credentials": prov::supports_multiple_credentials(id),
            "supports_credential_usage": prov::supports_credential_usage(id),
        }));
    }
    let any = out.iter().any(|p| p["is_configured"] == json!(true));
    Ok(json(json!({"providers": out, "has_any_configured": any})))
}

fn find_or_404(id: &str) -> ApiResult<&'static Value> {
    prov::find(id).ok_or_else(|| ApiError::not_found(format!("Unknown provider '{id}'")))
}

/// `_build_overrides`.
fn build_overrides(entry: &Value, token: &str, extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    let creds = entry.get("credentials").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if !token.is_empty() && !s(entry, "env_var").is_empty() {
        out.push((s(entry, "env_var").into(), token.into()));
    } else if !token.is_empty() && !creds.is_empty() {
        let name = s(&creds[0], "name");
        if !name.is_empty() {
            out.push((name.into(), token.into()));
        }
    }
    for (k, v) in extra {
        if !v.is_empty() {
            out.retain(|(n, _)| n != k);
            out.push((k.clone(), v.clone()));
        }
    }
    out
}

async fn provider_models(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let token = b.str("api_key", Some(""));
    let extra = b.dict_str("extra");
    let credential_id = b.opt_str("credential_id").filter(|c| !c.is_empty());
    b.finish(&["api_key", "extra", "credential_id"])?;
    let entry = find_or_404(&id)?;
    if rs::provider_is_disconnected(&id) {
        return Err(ApiError::conflict(format!("Provider '{id}' is disconnected. Reconnect it first.")));
    }
    let typed: std::collections::HashMap<String, String> = build_overrides(entry, &token, &extra).into_iter().collect();
    let found = match credential_id.as_deref() {
        // One credential: its own stored values plus what is being tried,
        // never the values of the credential in use.
        Some(cid) => {
            ensure_credential(&id, cid)?;
            prov::filter_agent_model_ids(prov::discover_provider_models_for(entry, &typed, Some(cid)).await)
        }
        None => {
            // An opted-in plugin's values come from its scoped account (see
            // `discover_provider_models_for`), not a merge of the active one.
            let mut overrides = if prov::is_optin_plugin(&id) { Default::default() } else { prov::saved_overrides(entry) };
            overrides.extend(typed);
            prov::filter_agent_model_ids(prov::discover_provider_models(entry, &overrides).await)
        }
    };
    if !found.is_empty() {
        if token.is_empty() && extra.is_empty() && credential_id.is_none() {
            let _ = rs::set_provider_cached_models(&id, &found);
        }
        let costs = model_costs(&id, &found);
        return Ok(json(json!({"provider": id, "models": found, "source": "provider", "model_costs": costs})));
    }
    Ok(json(json!({"provider": id, "models": [], "source": "provider", "model_costs": {}})))
}

async fn usage_summary(q: Qs) -> ApiResult<Response> {
    let force = q.bool("force_refresh", false)?;
    Ok(json(usage::usage_summary(force).await))
}

async fn provider_usage(AxPath(id): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let token = q.opt("api_key");
    let credential_id = q.opt("credential_id").filter(|c| !c.is_empty());
    match usage::get_provider_usage(&id, token.as_deref(), credential_id.as_deref()).await {
        Ok(v) => Ok(json(v)),
        Err(UsageError::Unsupported(_)) => Err(ApiError::not_found(format!("Usage monitoring unsupported for '{id}'."))),
        Err(UsageError::Credentials(m)) => Err(ApiError::not_found(m)),
        Err(UsageError::Rejected(m)) => Err(ApiError::unprocessable(m)),
        Err(UsageError::Unavailable(_)) => Err(ApiError::new(502, "Provider usage unavailable.")),
    }
}

async fn provider_reset(AxPath(id): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let credential_id = q.opt("credential_id").filter(|c| !c.is_empty());
    match usage::consume_provider_reset(&id, credential_id.as_deref()).await {
        Ok(v) => Ok(json(v)),
        Err(UsageError::Unsupported(_)) => Err(ApiError::not_found(format!("Rate limit reset unsupported for '{id}'."))),
        Err(UsageError::Credentials(m)) => Err(ApiError::new(401, m)),
        Err(UsageError::Rejected(m)) => Err(ApiError::unprocessable(m)),
        Err(UsageError::Unavailable(m)) => Err(ApiError::new(502, m)),
    }
}

async fn visible_models(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let models = b.list_str("models");
    b.finish(&["models"])?;
    find_or_404(&id)?;
    rs::set_provider_visible_models(&id, &models).map_err(internal)?;
    Ok(json(json!({"provider": id, "visible_models": rs::provider_ui(&id).visible_models})))
}

async fn disconnect(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let d = b.bool("disconnected", None);
    b.finish(&["disconnected"])?;
    find_or_404(&id)?;
    rs::set_provider_disconnected(&id, d).map_err(internal)?;
    Ok(json(json!({"provider": id, "is_disconnected": rs::provider_is_disconnected(&id)})))
}

/// Candidate values for one credential: the primary secret (`api_key`)
/// under the provider's main field name, plus `extra` named fields.
fn entry_values(entry: &Value, token: &str, extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut creds: Vec<(String, String)> = vec![];
    let set = |creds: &mut Vec<(String, String)>, k: String, v: String| match creds.iter_mut().find(|(n, _)| *n == k) {
        Some(slot) => slot.1 = v,
        None => creds.push((k, v)),
    };
    let extra_get = |k: &str| extra.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let fields = entry.get("credentials").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if !fields.is_empty() {
        if !token.is_empty() {
            set(&mut creds, s(&fields[0], "name").to_string(), token.to_string());
        }
        for f in &fields {
            let name = s(f, "name");
            if let Some(val) = extra_get(name) {
                set(&mut creds, name.to_string(), val);
            }
        }
    } else if !s(entry, "env_var").is_empty() && !token.is_empty() {
        set(&mut creds, s(entry, "env_var").to_string(), token.to_string());
    }
    for (k, val) in extra {
        if !creds.iter().any(|(n, _)| n == k) {
            creds.push((k.clone(), val.clone()));
        }
    }
    creds
}

/// Only names that configure this provider may be stored on it.
fn check_value_names(id: &str, values: &[(String, String)]) -> ApiResult<()> {
    for (k, _) in values {
        if appv3_providers::credentials_migration::owner_of(k).as_deref() != Some(id) {
            return Err(ApiError::unprocessable(format!("'{k}' is not a setting of provider '{id}'.")));
        }
    }
    Ok(())
}

fn store_err(e: impl std::fmt::Display) -> ApiError {
    ApiError::unprocessable(e.to_string())
}

/// 404 unless the provider has a stored credential `cid`.
fn ensure_credential(id: &str, cid: &str) -> ApiResult<()> {
    cred_store::load().map_err(store_err)?;
    if prov::stored_credential_values(id, cid).is_none() {
        return Err(ApiError::not_found(format!("Credential '{cid}' not found for '{id}'.")));
    }
    Ok(())
}

/// Stored values of one credential (none when `None` is given), as
/// overrides for discovery and tests of a single-credential plugin.
fn credential_overrides(id: &str, credential_id: Option<&str>) -> ApiResult<std::collections::HashMap<String, String>> {
    let Some(cid) = credential_id.filter(|c| !c.is_empty()) else { return Ok(Default::default()) };
    let f = cred_store::load().map_err(store_err)?;
    let c = f.find(id, cid).ok_or_else(|| ApiError::not_found(format!("Credential '{cid}' not found for '{id}'.")))?;
    Ok(c.values.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect())
}

async fn test_provider(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let token = b.str("api_key", Some(""));
    let model = b.str("model", None);
    let extra = b.dict_str("extra");
    let credential_id = b.opt_str("credential_id").filter(|c| !c.is_empty());
    b.finish(&["api_key", "model", "extra", "credential_id"])?;
    let entry = find_or_404(&id)?;
    // Builtins and opted-in plugins test one account through its own scoped
    // store; a single-credential plugin keeps the stored-values-as-overrides
    // behavior.
    let scoped = credential_id.clone().filter(|_| prov::supports_multiple_credentials(&id));
    let mut overrides = match &scoped {
        Some(cid) => {
            ensure_credential(&id, cid)?;
            Default::default()
        }
        None => credential_overrides(&id, credential_id.as_deref())?,
    };
    overrides.extend(entry_values(entry, &token, &extra).into_iter().filter(|(_, v)| !v.is_empty()));
    let started = std::time::Instant::now();
    let res: Result<(), String> = async {
        let pm = format!("{id}:{model}");
        let p = blocking(move || match scoped {
            Some(cid) => appv3_providers::factory::build_provider_for_credential(Some(&pm), Default::default(), &cid, overrides),
            None => appv3_providers::factory::build_provider_with_overrides(Some(&pm), Default::default(), overrides),
        })
        .await
        .map_err(|e| e.to_string())?;
        let mut kw = appv3_providers::Kwargs::new();
        kw.insert("max_tokens".into(), json!(1));
        p.chat(&[appv3_providers::ChatMessage::user("ping")], None, &kw).await.map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    Ok(json(match res {
        Ok(()) => json!({"ok": true, "latency_ms": started.elapsed().as_millis() as i64, "error": null}),
        Err(e) => {
            tracing::warn!("provider_test_failed provider={} error={}", id, e);
            json!({"ok": false, "latency_ms": null, "error": e})
        }
    }))
}

async fn save_provider(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    save_provider_named(id, raw).await
}

/// `PUT /providers/{id}`: set values on one credential — `credential_id`,
/// else the credential in use — creating the provider's first credential
/// when it has none. An empty value clears that field.
async fn save_provider_named(id: String, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let token = b.str("api_key", Some(""));
    let extra = b.dict_str("extra");
    let credential_id = b.opt_str("credential_id");
    b.finish(&["api_key", "extra", "credential_id"])?;
    let entry = find_or_404(&id)?;
    let values = entry_values(entry, &token, &extra);
    if values.is_empty() {
        return Ok(json(json!({"saved": false})));
    }
    check_value_names(&id, &values)?;
    let explicit = credential_id.is_some();
    let requested = credential_id.clone().unwrap_or_default();
    let current = cred_store::current(&id);
    let pid = id.clone();
    let names: Vec<String> = values.iter().map(|(k, _)| k.clone()).collect();
    let cid = blocking(move || {
        cred_store::update(|f| {
            // The target is resolved against the file as locked here, so a
            // credential removed since `current` was recorded is not
            // chosen: the first stored one is updated instead.
            let existing = match &credential_id {
                Some(t) => f.find(&pid, t).map(|c| c.id.clone()),
                None => current.as_deref().and_then(|t| f.find(&pid, t)).or_else(|| f.provider(&pid).first()).map(|c| c.id.clone()),
            };
            let c = match existing {
                Some(eid) => f.find_mut(&pid, &eid).expect("exists"),
                // A named credential that is gone is not silently recreated.
                None if explicit => return None,
                None => {
                    f.provider_mut(&pid).push(cred_store::Credential::new("Default"));
                    f.provider_mut(&pid).last_mut().expect("pushed")
                }
            };
            for (k, val) in values {
                if val.is_empty() {
                    c.values.shift_remove(&k);
                } else {
                    c.values.insert(k, val);
                }
            }
            Some(c.id.clone())
        })
    })
    .await
    .map_err(store_err)?
    .ok_or_else(|| ApiError::not_found(format!("Credential '{requested}' not found for '{id}'.")))?;
    cred_store::clear_cooldown(&id, &cid);
    let _ = rs::clear_provider_cached_models(&id);
    tracing::info!("provider_credentials_saved provider={} credential={} names={:?}", id, cid, names);
    Ok(json(json!({"saved": true, "credential_id": cid})))
}

// ── credential list ─────────────────────────────────────────────────────────

/// Last four characters of a secret, for telling keys apart.
fn mask(v: &str) -> String {
    let chars: Vec<char> = v.chars().collect();
    if chars.len() <= 8 {
        return "••••".into();
    }
    format!("…{}", chars[chars.len() - 4..].iter().collect::<String>())
}

/// Public metadata of one stored credential (never a secret value).
pub fn credential_meta(entry: &Value, c: &cred_store::Credential, in_use: bool) -> Value {
    let id = s(entry, "id");
    let oauth_kind = s(entry, "kind") == "oauth";
    let cooldown = cred_store::cooldown(id, &c.id);
    let primary = if s(entry, "env_var").is_empty() {
        entry.get("credentials").and_then(|v| v.as_array()).and_then(|a| a.first()).map(|f| s(f, "name").to_string()).unwrap_or_default()
    } else {
        s(entry, "env_var").to_string()
    };
    let secret_names: Vec<String> = entry
        .get("credentials")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|f| f.get("secret").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|f| s(f, "name").to_string())
        .chain(std::iter::once(primary.clone()))
        .collect();
    let hint = match (&c.oauth, c.value(&primary)) {
        (Some(_), _) => Value::Null,
        (None, Some(v)) => json!(mask(v)),
        _ => Value::Null,
    };
    // An opted-in OAuth plugin's values are settings (region, client), not a
    // connected account: without a token document the row needs a reconnect.
    let needs_reconnect = oauth_kind && c.oauth.is_none() && (prov::is_optin_plugin(id) || !c.has_secret());
    let status = if c.disabled {
        "disabled"
    } else if needs_reconnect {
        "needs_reconnect"
    } else if cooldown.is_some() {
        "cooling_down"
    } else {
        "ready"
    };
    let settings_shown: Map<String, Value> = c.values.iter().filter(|(k, _)| !secret_names.contains(k)).map(|(k, v)| (k.clone(), json!(v))).collect();
    json!({
        "id": c.id,
        "label": c.label,
        "disabled": c.disabled,
        "kind": if c.oauth.is_some() || oauth_kind { "oauth" } else { "api_key" },
        "hint": hint,
        "settings": settings_shown,
        "status": status,
        "in_use": in_use && !c.disabled,
        "cooldown_until": cooldown.as_ref().map(|c| c.until as i64),
        "cooldown_reason": cooldown.map(|c| c.reason),
    })
}

/// The credential the provider's next request uses.
fn in_use_id(provider_id: &str, f: &cred_store::CredentialsFile) -> Option<String> {
    cred_store::select(provider_id, &appv3_providers::pool::enabled_credentials(provider_id, f)).map(|c| c.id.clone())
}

/// Every stored credential of `entry`'s provider, in priority order.
pub fn credentials_json(entry: &Value) -> Value {
    let id = s(entry, "id");
    let f = cred_store::snapshot();
    let in_use = in_use_id(id, &f);
    Value::Array(f.provider(id).iter().map(|c| credential_meta(entry, c, in_use.as_deref() == Some(c.id.as_str()))).collect())
}

async fn list_credentials(AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let entry = find_or_404(&id)?;
    cred_store::load().map_err(store_err)?;
    Ok(json(json!({
        "provider": id,
        "credentials": credentials_json(entry),
        "env_pinned": appv3_providers::pool::env_pinned(&id),
        "supports_multiple_credentials": prov::supports_multiple_credentials(&id),
        "supports_credential_usage": prov::supports_credential_usage(&id),
    })))
}

async fn add_credential(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let label = b.str("label", Some(""));
    let token = b.str("api_key", Some(""));
    let extra = b.dict_str("extra");
    b.finish(&["label", "api_key", "extra"])?;
    let entry = find_or_404(&id)?;
    if prov::is_legacy_plugin(&id) && !cred_store::load().map_err(store_err)?.provider(&id).is_empty() {
        return Err(ApiError::unprocessable(format!("Provider '{id}' keeps a single credential: update the saved one instead of adding another. Existing credentials are kept.")));
    }
    if s(entry, "kind") == "oauth" && token.is_empty() && extra.is_empty() {
        return Err(ApiError::unprocessable("OAuth accounts are added by signing in (GET /api/auth/{provider}/login)."));
    }
    let values: Vec<(String, String)> = entry_values(entry, &token, &extra).into_iter().filter(|(_, v)| !v.is_empty()).collect();
    if values.is_empty() {
        return Err(ApiError::unprocessable("Provide api_key or extra values for the new credential."));
    }
    check_value_names(&id, &values)?;
    let pid = id.clone();
    let label = crate::routes::library::py_strip(&label);
    let c = blocking(move || {
        cred_store::update(|f| {
            let n = f.provider(&pid).len() + 1;
            let mut c = cred_store::Credential::new(if label.is_empty() { format!("Key {n}") } else { label });
            c.values = values.into_iter().collect();
            f.provider_mut(&pid).push(c.clone());
            c
        })
    })
    .await
    .map_err(store_err)?;
    let _ = rs::clear_provider_cached_models(&id);
    tracing::info!("provider_credential_added provider={} credential={}", id, c.id);
    Ok(json_code(201, credential_meta(entry, &c, false)))
}

async fn update_credential(AxPath((id, cid)): AxPath<(String, String)>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let has = |k: &str| v.as_object().is_some_and(|o| o.contains_key(k));
    let label = b.opt_str("label");
    let disabled = if has("disabled") { Some(b.bool("disabled", None)) } else { None };
    let token = b.str("api_key", Some(""));
    let extra = b.dict_str("extra");
    b.finish(&["label", "disabled", "api_key", "extra"])?;
    let entry = find_or_404(&id)?;
    let values = entry_values(entry, &token, &extra);
    check_value_names(&id, &values)?;
    let (pid, c2) = (id.clone(), cid.clone());
    let updated = blocking(move || {
        cred_store::update(|f| {
            let c = f.find_mut(&pid, &c2)?;
            if let Some(l) = label {
                c.label = crate::routes::library::py_strip(&l);
            }
            if let Some(d) = disabled {
                c.disabled = d;
            }
            for (k, val) in values {
                if val.is_empty() {
                    c.values.shift_remove(&k);
                } else {
                    c.values.insert(k, val);
                }
            }
            Some(c.clone())
        })
    })
    .await
    .map_err(store_err)?;
    let c = updated.ok_or_else(|| ApiError::not_found(format!("Credential '{cid}' not found for '{id}'.")))?;
    if !token.is_empty() || !extra.is_empty() {
        cred_store::clear_cooldown(&id, &cid);
        let _ = rs::clear_provider_cached_models(&id);
    }
    let in_use = in_use_id(&id, &cred_store::snapshot());
    Ok(json(credential_meta(entry, &c, in_use.as_deref() == Some(cid.as_str()))))
}

async fn delete_credential(AxPath((id, cid)): AxPath<(String, String)>) -> ApiResult<Response> {
    let entry = find_or_404(&id)?;
    let (pid, c2) = (id.clone(), cid.clone());
    let removed = blocking(move || cred_store::update(|f| f.remove(&pid, &c2).is_some())).await.map_err(store_err)?;
    if !removed {
        return Err(ApiError::not_found(format!("Credential '{cid}' not found for '{id}'.")));
    }
    cred_store::clear_cooldown(&id, &cid);
    if !prov::provider_is_configured(entry) {
        let _ = rs::forget_provider_models(&id);
    }
    tracing::info!("provider_credential_removed provider={} credential={}", id, cid);
    Ok(json(json!({"ok": true, "provider": id, "credential_id": cid})))
}

async fn order_credentials(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let ids = b.list_str("ids");
    b.finish(&["ids"])?;
    let entry = find_or_404(&id)?;
    let pid = id.clone();
    let ok = blocking(move || {
        cred_store::update(|f| {
            let Some(list) = f.providers.get_mut(&pid) else { return ids.is_empty() };
            let mut have: Vec<&str> = list.iter().map(|c| c.id.as_str()).collect();
            let mut want: Vec<&str> = ids.iter().map(String::as_str).collect();
            have.sort_unstable();
            want.sort_unstable();
            if have != want {
                return false;
            }
            list.sort_by_key(|c| ids.iter().position(|i| *i == c.id));
            true
        })
    })
    .await
    .map_err(store_err)?;
    if !ok {
        return Err(ApiError::unprocessable("ids must list every credential of the provider exactly once."));
    }
    // A reorder states the user's preference now: the next request uses the
    // new first ready credential instead of sticking to the current one.
    cred_store::clear_current(&id);
    tracing::info!("provider_credentials_reordered provider={}", id);
    Ok(json(json!({"provider": id, "credentials": credentials_json(entry)})))
}

async fn default_model(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let pm = b.str("provider_model", None);
    let pm = crate::routes::library::py_strip(&pm);
    if b.errs.is_empty() && !pm.contains(':') {
        let input = v.get("provider_model").cloned().unwrap_or(Value::Null);
        b.value_error("provider_model", "provider_model must use '<provider>:<model>' format", input);
    }
    b.finish(&["provider_model"])?;
    let dir = settings().config_dir.join("agents");
    let updated = blocking(move || appv3_agent::loader::configure_unconfigured_agent_models(&dir, &pm)).await;
    Ok(json(json!({"agents_updated": updated})))
}
