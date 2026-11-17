//! Secrets the user gave the agent (`agent_secrets` in `credentials.yaml`).
//!
//! A secret is a name, a value, and the projects that use it: a list of
//! projects, or every project (`"*"`). One name may hold several values, but
//! a project uses at most one of them: the value that lists the project
//! wins over the every-project value. A project is a repository: its
//! worktrees share its values (see [`project_of`]).
//!
//! The agent reaches these only by name, through the `secrets` argument of
//! `shell` and the `secret` tool; it never reads a value. Provider keys and
//! the named secrets connectors keep are separate and never offered here.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::credentials::CredentialsFile;

/// The projects entry meaning "every project".
pub const ALL_PROJECTS: &str = "*";
/// Most characters in a secret name.
pub const MAX_NAME_CHARS: usize = 128;
/// Most bytes in a secret value (a PEM key or a service-account JSON fits).
pub const MAX_VALUE_BYTES: usize = 32 * 1024;

/// One value of a secret.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentSecret {
    pub id: String,
    #[serde(default, deserialize_with = "scalar_string")]
    pub value: String,
    /// Project keys ([`project_of`]), or `["*"]` for every project.
    #[serde(default, deserialize_with = "string_list")]
    pub projects: Vec<String>,
    /// RFC 3339 time the value was saved or last replaced.
    #[serde(default, skip_serializing_if = "String::is_empty", deserialize_with = "scalar_string")]
    pub updated: String,
    /// Where it was entered: `chat` or `settings`.
    #[serde(default, skip_serializing_if = "String::is_empty", deserialize_with = "scalar_string")]
    pub source: String,
}

impl std::fmt::Debug for AgentSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentSecret").field("id", &self.id).field("value", &"<redacted>").field("projects", &self.projects).field("updated", &self.updated).finish()
    }
}

impl AgentSecret {
    pub fn for_all(&self) -> bool {
        self.projects.iter().any(|p| p == ALL_PROJECTS)
    }
    pub fn lists(&self, project: &str) -> bool {
        self.projects.iter().any(|p| p == project)
    }
}

fn scalar_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s,
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(_) => return Err(serde::de::Error::custom("must be a single value")),
    })
}

/// A list of strings; a lone string (`projects: "*"`, as someone might write
/// it by hand) reads as a list of one.
fn string_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => vec![],
        Some(Value::String(s)) => vec![s],
        Some(Value::Array(a)) => a.into_iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Some(_) => return Err(serde::de::Error::custom("must be a list of projects")),
    })
}

/// Environment variables a secret may not be named after: each changes how
/// a command runs (or which config OpenAgentd reads), not what it can reach.
const BLOCKED_NAMES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PWD",
    "OLDPWD",
    "TMPDIR",
    "TMP",
    "TEMP",
    "IFS",
    "ENV",
    "BASH_ENV",
    "PS4",
    "PROMPT_COMMAND",
    "CDPATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "LANG",
    "TERM",
    "SHLVL",
    "ZDOTDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "APP_ENV",
];
const BLOCKED_PREFIXES: &[&str] = &["LD_", "DYLD_", "BASH_FUNC_", "OPENAGENTD_", "AGENTD_", "LC_"];

/// Why `name` cannot be a secret's name, if it cannot.
pub fn check_name(name: &str) -> Result<(), String> {
    let ok_chars = !name.is_empty() && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit());
    if !ok_chars {
        return Err(format!("'{name}' is not a valid secret name: use UPPER_SNAKE_CASE letters, digits and _ (e.g. STRIPE_SECRET_KEY)"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("'{name}' is longer than {MAX_NAME_CHARS} characters"));
    }
    if BLOCKED_NAMES.contains(&name) || BLOCKED_PREFIXES.iter().any(|p| name.starts_with(p)) {
        return Err(format!("'{name}' changes how commands run, so it cannot be a secret's name; pick another name"));
    }
    Ok(())
}

/// Why `value` cannot be stored, if it cannot.
pub fn check_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("the value is empty".into());
    }
    if value.len() > MAX_VALUE_BYTES {
        return Err(format!("the value is longer than {} KB", MAX_VALUE_BYTES / 1024));
    }
    if value.contains('\0') {
        return Err("the value contains a NUL character, which an environment variable cannot hold".into());
    }
    Ok(())
}

/// The project `workspace` belongs to: the repository's main checkout for a
/// git repository or any of its worktrees, else the folder itself. Read from
/// the `.git` entries on disk (no `git` process), walking up from the folder.
pub fn project_of(workspace: &Path) -> String {
    let start = dunce::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    for dir in start.ancestors() {
        let dotgit = dir.join(".git");
        if dotgit.is_dir() {
            return dir.display().to_string();
        }
        if dotgit.is_file() {
            return worktree_main(&dotgit).unwrap_or_else(|| dir.to_path_buf()).display().to_string();
        }
    }
    start.display().to_string()
}

/// For a linked worktree's `.git` file (`gitdir: <repo>/.git/worktrees/<n>`),
/// the repository's main checkout. `None` for anything else (a submodule's
/// `.git` file has no `commondir`), which is then its own project.
fn worktree_main(dotgit_file: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(dotgit_file).ok()?;
    let gitdir = text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim)?;
    let base = dotgit_file.parent()?;
    let gitdir = base.join(gitdir);
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = dunce::canonicalize(gitdir.join(common.trim())).ok()?;
    if common.file_name().is_some_and(|n| n == ".git") {
        common.parent().map(Path::to_path_buf)
    } else {
        Some(common)
    }
}

/// The value `project` uses for `name`: the one listing the project, else
/// the every-project value.
pub fn resolve<'a>(f: &'a CredentialsFile, name: &str, project: &str) -> Option<&'a AgentSecret> {
    let list = f.agent_secrets.get(name)?;
    list.iter().find(|s| s.lists(project) && !s.value.is_empty()).or_else(|| list.iter().find(|s| s.for_all() && !s.value.is_empty()))
}

/// The names `project` can use, sorted.
pub fn usable_names(f: &CredentialsFile, project: &str) -> Vec<String> {
    let mut out: Vec<String> = f.agent_secrets.keys().filter(|n| resolve(f, n, project).is_some()).cloned().collect();
    out.sort();
    out
}

/// A new value id: `sec_` + 8 hex characters.
pub fn new_id() -> String {
    format!("sec_{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// What to change in [`set`].
#[derive(Debug, Default, Clone)]
pub struct Change {
    /// The value to edit; `None` saves a new value.
    pub id: Option<String>,
    /// A new value; required for a new one.
    pub value: Option<String>,
    /// The projects that use it (replaces the list); required for a new one.
    pub projects: Option<Vec<String>>,
    /// `chat` or `settings` (kept from before when empty).
    pub source: String,
}

/// Save or edit a value of `name`, keeping the rules: each project uses at
/// most one value of a name (a project moves to this value from any other),
/// and at most one value is for every project. A value no project uses any
/// more is dropped. Returns the value's id.
pub fn set(f: &mut CredentialsFile, name: &str, change: Change) -> Result<String, String> {
    check_name(name)?;
    if let Some(v) = &change.value {
        check_value(v)?;
    }
    let projects = match &change.projects {
        Some(p) => {
            let mut p: Vec<String> = p.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            p.sort();
            p.dedup();
            if p.is_empty() {
                return Err("choose at least one project, or every project".into());
            }
            if p.iter().any(|x| x == ALL_PROJECTS) {
                p = vec![ALL_PROJECTS.to_string()];
            }
            Some(p)
        }
        None => None,
    };
    let list = f.agent_secrets.get(name).cloned().unwrap_or_default();
    let (is_new, mut entry) = match &change.id {
        Some(id) => (false, list.iter().find(|s| &s.id == id).cloned().ok_or_else(|| format!("{name} has no saved value '{id}'; it may have been deleted"))?),
        None => {
            let value = change.value.clone().ok_or("a new secret needs a value")?;
            let projects = projects.clone().ok_or("a new secret needs the projects that use it")?;
            (true, AgentSecret { id: new_id(), value, projects, updated: now(), source: change.source.clone() })
        }
    };
    if !is_new {
        if let Some(v) = &change.value {
            if *v != entry.value {
                entry.value = v.clone();
                entry.updated = now();
            }
            if !change.source.is_empty() {
                entry.source = change.source.clone();
            }
        }
        if let Some(p) = projects {
            entry.projects = p;
        }
    }
    if entry.for_all() && list.iter().any(|s| s.id != entry.id && s.for_all()) {
        return Err(format!("{name} already has a value for every project; replace that one, or choose projects for this one"));
    }
    let id = entry.id.clone();
    let mut next: Vec<AgentSecret> = list
        .into_iter()
        .map(|mut s| {
            if s.id == entry.id {
                return entry.clone();
            }
            s.projects.retain(|p| p == ALL_PROJECTS || !entry.projects.contains(p));
            s
        })
        .collect();
    if is_new {
        next.push(entry);
    }
    next.retain(|s| !s.projects.is_empty());
    if next.is_empty() {
        f.agent_secrets.shift_remove(name);
    } else {
        f.agent_secrets.insert(name.to_string(), next);
    }
    Ok(id)
}

/// Let `project` use value `id` of `name` too (it leaves any other value).
pub fn add_project(f: &mut CredentialsFile, name: &str, id: &str, project: &str) -> Result<(), String> {
    let current =
        f.agent_secrets.get(name).and_then(|l| l.iter().find(|s| s.id == id)).cloned().ok_or_else(|| format!("{name} has no saved value '{id}'; it may have been deleted"))?;
    if current.lists(project) {
        return Ok(());
    }
    if current.for_all() {
        // Every project uses it already, unless this one has its own value.
        if let Some(list) = f.agent_secrets.get_mut(name) {
            for s in list.iter_mut().filter(|s| s.id != id) {
                s.projects.retain(|p| p != project);
            }
            list.retain(|s| !s.projects.is_empty());
        }
        return Ok(());
    }
    let mut projects = current.projects.clone();
    projects.push(project.to_string());
    set(f, name, Change { id: Some(id.to_string()), projects: Some(projects), ..Default::default() }).map(|_| ())
}

/// Delete value `id` of `name`. Whether it existed.
pub fn remove(f: &mut CredentialsFile, name: &str, id: &str) -> bool {
    let Some(list) = f.agent_secrets.get_mut(name) else { return false };
    let before = list.len();
    list.retain(|s| s.id != id);
    let removed = list.len() != before;
    if list.is_empty() {
        f.agent_secrets.shift_remove(name);
    }
    removed
}

/// Every value, for listings: `(name, value)` without the secret itself.
pub fn entries(f: &CredentialsFile) -> Vec<(String, AgentSecret)> {
    let mut out = vec![];
    for (name, list) in &f.agent_secrets {
        for s in list {
            out.push((name.clone(), AgentSecret { value: String::new(), ..s.clone() }));
        }
    }
    out
}

#[cfg(test)]
mod tests;
