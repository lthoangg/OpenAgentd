//! `GET /api/plugins` — what the plugin runtime loaded, and what it could not.
//!
//! v3-only (v2 has no equivalent; the web UI treats 404 as "not available").
//! A plugin that fails to load, or that a consumer rejects, otherwise leaves
//! only a log line. The response also lists v2 `*.py` plugins with no
//! `*.ts`/`*.js` port, which v3 silently ignores. Plugins load once per
//! process, so the list reflects the running server; file changes apply
//! after a restart (as in v2).

use crate::util::{blocking, json};
use crate::AppState;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::{json as j, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(list_plugins))
}

async fn list_plugins() -> Response {
    json(
        blocking(|| {
            let dirs = appv3_core::settings().plugins_dirs.clone();
            // Force both consumers so their contract errors are recorded.
            let providers: Vec<(PathBuf, String)> =
                appv3_providers::plugin::provider_plugins().iter().filter_map(|p| Some((p.source()?.to_path_buf(), p.info().id.clone()))).collect();
            let hooks: Vec<(PathBuf, Vec<&'static str>)> = appv3_agent::plugins::tool_plugins()
                .iter()
                .filter_map(|p| {
                    let mut h = vec![];
                    if p.has_before() {
                        h.push("tool.before");
                    }
                    if p.has_after() {
                        h.push("tool.after");
                    }
                    Some((p.source()?.to_path_buf(), h))
                })
                .collect();
            status(&dirs, &appv3_jsplugin::plugin_files(&dirs), &providers, &hooks, &appv3_jsplugin::problems())
        })
        .await,
    )
}

/// v2 `*.py` plugin files across `dirs`, skipping `_*`, deduplicated.
fn v2_plugin_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(d) else { continue };
        let mut files: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "py") && !p.file_name().and_then(|n| n.to_str()).unwrap_or("_").starts_with('_'))
            .collect();
        files.sort();
        for f in files {
            if seen.insert(dunce::canonicalize(&f).unwrap_or_else(|_| f.clone())) {
                out.push(f);
            }
        }
    }
    out
}

fn stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn status(dirs: &[PathBuf], files: &[PathBuf], providers: &[(PathBuf, String)], hooks: &[(PathBuf, Vec<&str>)], problems: &[(PathBuf, String)]) -> Value {
    let plugins: Vec<Value> = files
        .iter()
        .map(|f| {
            let errors: Vec<&str> = problems.iter().filter(|(p, _)| p == f).map(|(_, m)| m.as_str()).collect();
            let provider = providers.iter().find(|(p, _)| p == f).map(|(_, id)| id.clone());
            let hook_names: Vec<&str> = hooks.iter().filter(|(p, _)| p == f).flat_map(|(_, h)| h.iter().copied()).collect();
            j!({
                "name": stem(f),
                "file": file_name(f),
                "path": f.to_string_lossy(),
                "status": if errors.is_empty() { "loaded" } else { "error" },
                "provider": provider,
                "hooks": hook_names,
                "errors": errors,
            })
        })
        .collect();
    let ported: HashSet<String> = files.iter().map(|f| stem(f)).collect();
    let unported: Vec<Value> =
        v2_plugin_files(dirs).iter().filter(|p| !ported.contains(&stem(p))).map(|p| j!({"name": stem(p), "file": file_name(p), "path": p.to_string_lossy()})).collect();
    j!({
        "dirs": dirs.iter().map(|d| d.to_string_lossy()).collect::<Vec<_>>(),
        "plugins": plugins,
        "unported": unported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_loaded_errors_and_unported() {
        let d = tempfile::tempdir().unwrap();
        let p = |n: &str| {
            let f = d.path().join(n);
            std::fs::write(&f, "").unwrap();
            f
        };
        let (auth_ts, scrub_ts, bad_ts) = (p("auth.ts"), p("scrub.ts"), p("bad.ts"));
        p("auth.py"); // ported
        p("legacy.py"); // not ported
        p("_helper.py"); // helper module, not a plugin (v2 rule)
        std::fs::create_dir(d.path().join("__pycache__")).unwrap();
        let dirs = vec![d.path().to_path_buf()];
        let files = appv3_jsplugin::plugin_files(&dirs);
        let v = status(&dirs, &files, &[(auth_ts.clone(), "auth".into())], &[(scrub_ts.clone(), vec!["tool.after"])], &[(bad_ts.clone(), "bad.ts:1:5: Unexpected token".into())]);
        let by_name = |n: &str| v["plugins"].as_array().unwrap().iter().find(|x| x["name"] == n).cloned().unwrap();
        assert_eq!(by_name("auth")["provider"], "auth");
        assert_eq!(by_name("auth")["status"], "loaded");
        assert_eq!(by_name("scrub")["hooks"], j!(["tool.after"]));
        assert_eq!(by_name("bad")["status"], "error");
        assert_eq!(by_name("bad")["errors"], j!(["bad.ts:1:5: Unexpected token"]));
        assert_eq!(v["unported"].as_array().unwrap().iter().map(|x| x["file"].as_str().unwrap()).collect::<Vec<_>>(), ["legacy.py"]);
    }
}
