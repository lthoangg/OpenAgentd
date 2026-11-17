//! The environment of the commands the agent runs: the scrub of server and
//! provider secrets, `PATH`, and the user's saved secrets a call names. Only
//! secrets the user gave the agent qualify, never provider keys or connector
//! secrets.

use crate::{ToolContext, ToolError};
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Drops server auth, provider keys and other saved values from a command's
/// environment, and marks the command as the agent's.
pub(crate) fn scrubbed_env(cmd: &mut tokio::process::Command) {
    for k in appv3_core::env::child_env_blocklist() {
        cmd.env_remove(k);
    }
    // Whoever embeds this tool, its commands are the agent's.
    cmd.env(appv3_core::auth::AGENT_MARKER_ENV, "1");
}

/// `PATH` for the commands the agent runs, when it needs a change: `path`
/// plus, at the end, the folder of the running `exe` when no `agentd` is
/// reachable through `path`.
///
/// The desktop app keeps `agentd` inside its bundle and puts nothing on
/// `PATH`, so without this the `agentd plugin` commands the self-healing
/// skill points to would not exist for the agent. Appended, so an `agentd`
/// the user installed still wins. Nothing when `exe` is not `agentd` (tests,
/// embedders), or when `PATH` is unset: setting it would drop the shell's
/// default.
pub(crate) fn path_with_cli(path: Option<&OsStr>, exe: Option<&Path>) -> Option<OsString> {
    let (path, exe) = (path?, exe?);
    let dir = exe.parent()?;
    if exe.file_stem() != Some(OsStr::new("agentd")) || appv3_core::which::which_in("agentd", path).is_some() {
        return None;
    }
    std::env::join_paths(std::env::split_paths(path).chain([dir.to_path_buf()])).ok()
}

/// [`path_with_cli`] for this process, worked out once: the server's own
/// `PATH` does not change while it runs.
pub(crate) fn command_path() -> Option<&'static OsStr> {
    static P: OnceLock<Option<OsString>> = OnceLock::new();
    P.get_or_init(|| {
        let exe = std::env::current_exe().ok().and_then(|p| dunce::canonicalize(p).ok());
        path_with_cli(std::env::var_os("PATH").as_deref(), exe.as_deref())
    })
    .as_deref()
}

/// The `secrets` argument: a list of names (a lone name, or a JSON list in
/// a string, as models sometimes send it, is accepted).
pub(crate) fn secret_names(raw: Option<&Value>) -> Result<Vec<String>, String> {
    let items = match raw {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) if s.trim_start().starts_with('[') => serde_json::from_str::<Vec<Value>>(s).map_err(|_| "Input should be a list of secret names".to_string())?,
        Some(Value::String(s)) => vec![Value::String(s.clone())],
        Some(_) => return Err("Input should be a list of secret names".into()),
    };
    let mut out: Vec<String> = vec![];
    for v in items {
        let name = v.as_str().map(str::trim).ok_or("Input should be a list of secret names")?.to_string();
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    }
    Ok(out)
}

/// The values of `names` in the call's project. Only secrets the user gave
/// the agent qualify, never provider keys or connector secrets.
pub(crate) fn resolve_secrets(ctx: &ToolContext, names: &[String]) -> Result<Vec<(String, String)>, ToolError> {
    if names.is_empty() {
        return Ok(vec![]);
    }
    let ws = ctx.workspace.as_deref().filter(|w| !w.is_empty()).map(PathBuf::from).unwrap_or_else(|| ctx.denied.workspace_root.clone());
    let project = appv3_core::agent_secrets::project_of(&ws);
    let f = appv3_core::credentials::snapshot();
    let mut out = vec![];
    let mut missing = vec![];
    for n in names {
        match appv3_core::agent_secrets::resolve(&f, n, &project) {
            Some(s) => out.push((n.clone(), s.value.clone())),
            None => missing.push(n.as_str()),
        }
    }
    if !missing.is_empty() {
        return Err(ToolError::Execution(format!(
            "Not run: {} {} not available in this project. Ask the user for {} with the `secret` tool (action='request'); never ask them to paste a key in chat.",
            missing.join(", "),
            if missing.len() == 1 { "is" } else { "are" },
            if missing.len() == 1 { "it" } else { "them" }
        )));
    }
    tracing::info!("shell_secrets_used names={}", names.join(","));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{path_with_cli, secret_names};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn commands_reach_the_running_agentd_when_path_has_none() {
        let make_exe = |dir: &Path, stem: &str| {
            std::fs::create_dir_all(dir).unwrap();
            let p = dir.join(if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() });
            std::fs::write(&p, b"").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        };
        let d = tempfile::tempdir().unwrap();
        let (app, user, usr) = (d.path().join("App/sidecar/bin"), d.path().join("user/bin"), d.path().join("usr/bin"));
        let exe = make_exe(&app, "agentd");
        make_exe(&usr, "ls");
        let path = std::env::join_paths([&usr]).unwrap();

        // The desktop app's case: no agentd on PATH, so its folder is added last.
        assert_eq!(path_with_cli(Some(&path), Some(&exe)), Some(std::env::join_paths([&usr, &app]).unwrap()));
        // An agentd the user installed is left to win.
        make_exe(&user, "agentd");
        assert_eq!(path_with_cli(Some(&std::env::join_paths([&usr, &user]).unwrap()), Some(&exe)), None);
        // A binary that is not agentd (a test, an embedder) adds nothing.
        assert_eq!(path_with_cli(Some(&path), Some(&make_exe(&app, "embedder"))), None);
        // Without PATH the shell's default stays in force.
        assert_eq!(path_with_cli(None, Some(&exe)), None);
    }

    #[test]
    fn names_come_as_a_list_a_lone_name_or_a_json_list_in_a_string() {
        assert_eq!(secret_names(None).unwrap(), Vec::<String>::new());
        assert_eq!(secret_names(Some(&json!(["A", " B ", "A", ""]))).unwrap(), vec!["A", "B"]);
        assert_eq!(secret_names(Some(&json!("STRIPE_SECRET_KEY"))).unwrap(), vec!["STRIPE_SECRET_KEY"]);
        assert_eq!(secret_names(Some(&json!("[\"A\", \"B\"]"))).unwrap(), vec!["A", "B"]);
    }

    #[test]
    fn anything_else_is_refused() {
        assert!(secret_names(Some(&json!(3))).is_err());
        assert!(secret_names(Some(&json!([1]))).is_err());
        assert!(secret_names(Some(&json!("[not json"))).is_err());
    }
}
