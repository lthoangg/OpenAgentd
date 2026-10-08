//! `/api/settings` — port of `app/api/routes/settings.py`.

use crate::error::{ApiError, ApiResult};
use crate::providers::{self as prov, s};
use crate::schema::Body;
use crate::usage::{self, UsageError};
use crate::util::*;
use crate::AppState;
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

async fn get_summarization() -> ApiResult<Response> {
    let cfg = rs::load_runtime_settings().map_err(internal)?;
    Ok(json(json!({"prompt_token_threshold": cfg.summarization.prompt_token_threshold})))
}

async fn put_summarization(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let t = b.opt_int("prompt_token_threshold");
    b.finish(&["prompt_token_threshold"])?;
    if matches!(t, Some(x) if x < 1) {
        return Err(ApiError::unprocessable("prompt_token_threshold must be a positive integer or null"));
    }
    let mut cfg = rs::load_runtime_settings().map_err(internal)?;
    cfg.summarization.prompt_token_threshold = t;
    rs::save_runtime_settings(&cfg).map_err(internal)?;
    Ok(json(json!({"prompt_token_threshold": t})))
}

fn title_json(t: &rs::TitleGenerationSettings) -> Value {
    json!({"enabled": t.enabled, "model": t.model.clone().unwrap_or_default(), "wait_timeout_seconds": t.wait_timeout_seconds})
}

async fn get_title() -> ApiResult<Response> {
    let cfg = rs::load_runtime_settings().map_err(internal)?;
    Ok(json(title_json(&cfg.title_generation)))
}

async fn put_title(raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let enabled = b.bool("enabled", None);
    let model = b.str("model", Some(""));
    let wait = b.float("wait_timeout_seconds", 3.0);
    b.finish(&["enabled", "model", "wait_timeout_seconds"])?;
    let mut cfg = rs::load_runtime_settings().map_err(internal)?;
    cfg.title_generation.enabled = enabled;
    let m = crate::routes::library::py_strip(&model);
    cfg.title_generation.model = (!m.is_empty()).then_some(m);
    cfg.title_generation.wait_timeout_seconds = wait.max(0.0);
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
    b.finish(&["api_key", "extra"])?;
    let entry = find_or_404(&id)?;
    if rs::provider_is_disconnected(&id) {
        return Err(ApiError::conflict(format!("Provider '{id}' is disconnected. Reconnect it first.")));
    }
    let mut overrides = prov::saved_overrides(entry);
    overrides.extend(build_overrides(entry, &token, &extra));
    let found = prov::filter_agent_model_ids(prov::discover_provider_models(entry, &overrides).await);
    if !found.is_empty() {
        if token.is_empty() && extra.is_empty() {
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
    match usage::get_provider_usage(&id, token.as_deref()).await {
        Ok(v) => Ok(json(v)),
        Err(UsageError::Unsupported(_)) => Err(ApiError::not_found(format!("Usage monitoring unsupported for '{id}'."))),
        Err(UsageError::Credentials(m)) => Err(ApiError::not_found(m)),
        Err(UsageError::Unavailable(_)) => Err(ApiError::new(502, "Provider usage unavailable.")),
    }
}

async fn provider_reset(AxPath(id): AxPath<String>) -> ApiResult<Response> {
    match usage::consume_provider_reset(&id).await {
        Ok(v) => Ok(json(v)),
        Err(UsageError::Unsupported(_)) => Err(ApiError::not_found(format!("Rate limit reset unsupported for '{id}'."))),
        Err(UsageError::Credentials(m)) => Err(ApiError::new(401, m)),
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

fn test_lock() -> &'static tokio::sync::Mutex<()> {
    static L: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(Default::default)
}

async fn test_provider(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let token = b.str("api_key", Some(""));
    let model = b.str("model", None);
    let extra = b.dict_str("extra");
    b.finish(&["api_key", "model", "extra"])?;
    let entry = find_or_404(&id)?;
    let _g = test_lock().lock().await;
    let mut saved: Vec<(String, Option<String>)> = vec![];
    let env_var = s(entry, "env_var");
    if !token.is_empty() && !env_var.is_empty() {
        saved.push((env_var.into(), std::env::var(env_var).ok()));
        std::env::set_var(env_var, &token);
    }
    for (k, val) in &extra {
        saved.push((k.clone(), std::env::var(k).ok()));
        std::env::set_var(k, val);
    }
    let started = std::time::Instant::now();
    let res: Result<(), String> = async {
        let p = appv3_providers::factory::build_provider(Some(&format!("{id}:{model}")), Default::default()).map_err(|e| e.to_string())?;
        let mut kw = appv3_providers::Kwargs::new();
        kw.insert("max_tokens".into(), json!(1));
        p.chat(&[appv3_providers::ChatMessage::user("ping")], None, &kw).await.map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    for (k, prev) in saved.into_iter().rev() {
        match prev {
            Some(p) => std::env::set_var(&k, p),
            None => std::env::remove_var(&k),
        }
    }
    Ok(json(match res {
        Ok(()) => json!({"ok": true, "latency_ms": started.elapsed().as_millis() as i64, "error": null}),
        Err(e) => {
            tracing::warn!("provider_test_failed provider={} error={}", id, e);
            json!({"ok": false, "latency_ms": null, "error": e})
        }
    }))
}

/// `_write_env_credentials`.
fn write_env_credentials(env_file: &Path, creds: &[(String, String)]) -> std::io::Result<()> {
    let lookup = |k: &str| creds.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    if !env_file.exists() {
        let mut lines: Vec<String> =
            ["# Generated by openagentd", "# Edit as needed. See .env.example for the full reference.", "", "APP_ENV=production", ""].map(String::from).to_vec();
        lines.extend(creds.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k}={v}")));
        return appv3_core::secret_files::write_secret_file(env_file, &(lines.join("\n") + "\n"));
    }
    let existing = std::fs::read_to_string(env_file)?;
    let mut out: Vec<String> = vec![];
    let mut handled: Vec<String> = vec![];
    for line in existing.lines() {
        let key = line.split('=').next().unwrap_or("").trim().to_string();
        match lookup(&key) {
            None => out.push(line.to_string()),
            Some(v) => {
                handled.push(key.clone());
                if !v.is_empty() {
                    out.push(format!("{key}={v}"));
                }
            }
        }
    }
    for (k, v) in creds {
        if !handled.contains(k) && !v.is_empty() {
            out.push(format!("{k}={v}"));
        }
    }
    appv3_core::secret_files::write_secret_file(env_file, &(out.join("\n") + "\n"))
}

async fn save_provider(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    save_provider_named(id, raw).await
}

async fn save_provider_named(id: String, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let token = b.str("api_key", Some(""));
    let extra = b.dict_str("extra");
    b.finish(&["api_key", "extra"])?;
    let entry = find_or_404(&id)?;
    let mut creds: Vec<(String, String)> = vec![];
    let set = |creds: &mut Vec<(String, String)>, k: String, v: String| match creds.iter_mut().find(|(n, _)| *n == k) {
        Some(slot) => slot.1 = v,
        None => creds.push((k, v)),
    };
    let extra_get = |k: &str| extra.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let fields = entry.get("credentials").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if !fields.is_empty() {
        if !token.is_empty() {
            set(&mut creds, s(&fields[0], "name").to_string(), token.clone());
        }
        for f in &fields {
            let name = s(f, "name");
            if let Some(val) = extra_get(name) {
                set(&mut creds, name.to_string(), val);
            }
        }
    } else if s(entry, "kind") == "api_key" && !s(entry, "env_var").is_empty() {
        set(&mut creds, s(entry, "env_var").to_string(), token.clone());
    } else if s(entry, "kind") == "cloud_creds" {
        for n in entry.get("env_vars").and_then(|v| v.as_array()).into_iter().flatten() {
            let n = n.as_str().unwrap_or("");
            if let Some(val) = extra_get(n) {
                set(&mut creds, n.to_string(), val);
            }
        }
    }
    for (k, val) in &extra {
        if !creds.iter().any(|(n, _)| n == k) {
            creds.push((k.clone(), val.clone()));
        }
    }
    if creds.is_empty() {
        return Ok(json(json!({"saved": false})));
    }
    let env_file = settings().config_dir.join(".env");
    write_env_credentials(&env_file, &creds).map_err(internal)?;
    let _ = rs::clear_provider_cached_models(&id);
    for (k, val) in &creds {
        if val.is_empty() {
            std::env::remove_var(k);
        } else {
            std::env::set_var(k, val);
        }
    }
    tracing::info!("provider_credentials_saved provider={} env_vars={:?}", id, creds.iter().map(|(k, _)| k).collect::<Vec<_>>());
    Ok(json(json!({"saved": true})))
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
