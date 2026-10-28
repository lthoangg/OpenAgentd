//! `workspace(action='set_groups')`: the lead proposes groups for a
//! repository to join or leave, and the user confirms them on a card
//! ([`crate::confirm`]). Its other groups stay as they are: a lead may not
//! see them (`list` shows only what it can reach). Groups decide which
//! agents may message each other ([`crate::workspace_messages::can_reach`]),
//! so the card names the repositories that gain or lose that reach.

use crate::confirm::Proposal;
use crate::workspace_messages::{registered_workspaces, Target};
use appv3_db::{self as db, codec, DbPool};
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// The stored change's `type`.
pub const SET_GROUPS_CHANGE: &str = "set_groups";
/// Most groups one repository may be put in at once.
pub const MAX_GROUPS: usize = 20;

fn looks_like_path(q: &str) -> bool {
    q.starts_with('~') || q.contains('/') || q.contains('\\') || std::path::Path::new(q).is_absolute()
}

/// The repository `query` (a workspace name or path) names, among every
/// registered workspace. A worktree resolves to its repository.
pub fn resolve_repo(targets: &[Target], query: &str) -> Result<Target, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("workspace is required for action='set_groups'.".into());
    }
    let found: Vec<&Target> = if looks_like_path(q) {
        let resolved = db::resolve_path(q);
        targets.iter().filter(|t| t.path == resolved || db::resolve_path(&t.path) == resolved).collect()
    } else {
        targets.iter().filter(|t| t.name.eq_ignore_ascii_case(q)).collect()
    };
    let t = match found.as_slice() {
        [] => {
            return Err(format!(
                "'{q}' is not a workspace registered in OpenAgentd. Ask the user to open that folder in the app first (it then appears in the sidebar); paths are not registered from chat."
            ))
        }
        [one] => *one,
        many => {
            let paths: Vec<&str> = many.iter().map(|t| t.path.as_str()).collect();
            return Err(format!("Several workspaces are named '{q}': {}. Pass the path instead.", paths.join(", ")));
        }
    };
    if t.kind == "chat" {
        return Err("Chat is in no group: it can already message every workspace, and every workspace can message it.".into());
    }
    let repo = t.repo().to_string();
    targets.iter().find(|r| r.kind != "worktree" && r.path == repo).cloned().ok_or_else(|| format!("The repository of '{}' ({repo}) is not registered in OpenAgentd.", t.name))
}

/// Group names given as `field`: trimmed, valid, deduplicated (case-insensitive).
pub fn parse_group_names(field: &str, v: Option<&Value>) -> Result<Vec<String>, String> {
    let items = match v {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(format!("{field}: Input should be a valid list of group names")),
    };
    let mut out: Vec<String> = vec![];
    for (i, it) in items.iter().enumerate() {
        let Some(s) = it.as_str() else { return Err(format!("{field}.{i}: Input should be a valid string")) };
        let name = db::clean_name(s).map_err(|e| format!("{field}.{i}: {e}"))?;
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&name)) {
            out.push(name);
        }
    }
    if out.len() > MAX_GROUPS {
        return Err(format!("{field}: at most {MAX_GROUPS} groups."));
    }
    Ok(out)
}

/// Other repositories `repo` shares a group with, given its group ids.
fn reach(targets: &[Target], repo: &str, groups: &BTreeSet<String>) -> BTreeSet<String> {
    targets.iter().filter(|t| t.kind == "repo" && t.path != repo && t.groups.iter().any(|g| groups.contains(g))).map(|t| t.name.clone()).collect()
}

fn names(set: &BTreeSet<String>) -> String {
    set.iter().map(|n| format!("**{n}**")).collect::<Vec<_>>().join(", ")
}

/// What joining `join` and leaving `leave` would change, as a card;
/// `Ok(None)` when nothing would.
pub async fn propose(pool: &DbPool, workspace: &str, join: &[String], leave: &[String]) -> Result<Option<Proposal>, String> {
    if join.is_empty() && leave.is_empty() {
        return Err("action='set_groups' needs group names in join, leave, or both.".into());
    }
    if let Some(n) = join.iter().find(|j| leave.iter().any(|l| l.eq_ignore_ascii_case(j))) {
        return Err(format!("'{n}' is in both join and leave."));
    }
    let err = |e: anyhow::Error| e.to_string();
    let targets = registered_workspaces(pool).await.map_err(err)?;
    let repo = resolve_repo(&targets, workspace)?;
    let groups = db::list_workspace_groups(pool).await.map_err(|e| e.to_string())?;
    let before: BTreeSet<String> = repo.groups.iter().cloned().collect();
    let mut after = before.clone();
    let mut joining: Vec<Value> = vec![];
    let mut new_names: Vec<String> = vec![];
    for name in join {
        match groups.iter().find(|g| g.name.eq_ignore_ascii_case(name)) {
            Some(g) => {
                if after.insert(g.id.clone()) {
                    joining.push(json!({"name": g.name, "id": g.id}));
                }
            }
            None => {
                new_names.push(name.clone());
                joining.push(json!({"name": name, "id": null}));
            }
        }
    }
    for name in leave {
        match groups.iter().find(|g| g.name.eq_ignore_ascii_case(name)) {
            Some(g) => {
                after.remove(&g.id);
            }
            None => return Err(format!("There is no group named '{name}' to leave.")),
        }
    }
    if new_names.is_empty() && before == after {
        return Ok(None);
    }
    let name_of = |id: &String| groups.iter().find(|g| &g.id == id).map(|g| g.name.clone()).unwrap_or_default();
    let joined: BTreeSet<String> = after.difference(&before).map(name_of).chain(new_names.iter().map(|n| format!("{n} (new)"))).collect();
    let left: BTreeSet<String> = before.difference(&after).map(name_of).collect();
    let gained: BTreeSet<String> = reach(&targets, &repo.path, &after).difference(&reach(&targets, &repo.path, &before)).cloned().collect();
    let lost: BTreeSet<String> = reach(&targets, &repo.path, &before).difference(&reach(&targets, &repo.path, &after)).cloned().collect();

    let mut q = format!("Change the workspace groups of **{}** (`{}`):", repo.name, repo.path);
    if !joined.is_empty() {
        q.push_str(&format!(" join {};", joined.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ")));
    }
    if !left.is_empty() {
        q.push_str(&format!(" leave {};", left.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ")));
    }
    q.pop();
    q.push('.');
    if !gained.is_empty() {
        q.push_str(&format!(" Agents in **{}** and {} can then message each other.", repo.name, names(&gained)));
    }
    if !lost.is_empty() {
        q.push_str(&format!(" They can no longer message {}.", names(&lost)));
    }
    if gained.is_empty() && lost.is_empty() {
        q.push_str(" Which workspaces it can message does not change.");
    }
    let before_ids: Vec<&String> = before.iter().collect();
    let leaving: Vec<&String> = before.difference(&after).collect();
    Ok(Some(Proposal {
        question: q,
        apply: "Save these groups now. You can change them later in Settings → Workspaces.".into(),
        change: json!({"type": SET_GROUPS_CHANGE, "repo": repo.path, "name": repo.name, "before": before_ids, "join": joining, "leave": leaving}),
    }))
}

/// Apply a confirmed `set_groups` change, if nothing it depends on changed
/// since the card opened.
pub async fn apply(pool: &DbPool, change: &Value) -> Result<String, String> {
    let err = |e: anyhow::Error| e.to_string();
    let repo_path = change["repo"].as_str().unwrap_or_default();
    let targets = registered_workspaces(pool).await.map_err(err)?;
    let Some(repo) = targets.iter().find(|t| t.kind == "repo" && t.path == repo_path).cloned() else {
        return Err(format!("'{repo_path}' is no longer a registered workspace."));
    };
    let before: BTreeSet<String> = change["before"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
    let current: BTreeSet<String> = repo.groups.iter().cloned().collect();
    if before != current {
        return Err(format!("the groups of '{}' changed since this was proposed. Check them with action='list' and propose again.", repo.name));
    }
    let groups = db::list_workspace_groups(pool).await.map_err(|e| e.to_string())?;
    let leave: BTreeSet<&str> = change["leave"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let mut ids: Vec<String> = current.iter().filter(|g| !leave.contains(g.as_str())).cloned().collect();
    let mut to_create: Vec<String> = vec![];
    for g in change["join"].as_array().into_iter().flatten() {
        let name = g["name"].as_str().unwrap_or_default();
        match g["id"].as_str() {
            Some(id) if groups.iter().any(|x| x.id == id) => ids.push(id.to_string()),
            Some(_) => return Err(format!("group '{name}' was deleted since this was proposed.")),
            None if groups.iter().any(|x| x.name.eq_ignore_ascii_case(name)) => {
                return Err(format!("a group named '{name}' was created since this was proposed, so joining it would reach workspaces the card did not show. Propose again."))
            }
            None => to_create.push(name.to_string()),
        }
    }
    for name in &to_create {
        let g = db::create_workspace_group(pool, name, None, None).await.map_err(|e| e.to_string())?;
        ids.push(g.id);
    }
    db::set_workspace_groups(pool, &repo.path, &ids).await.map_err(|e| e.to_string())?;
    let targets = registered_workspaces(pool).await.map_err(err)?;
    let now: BTreeSet<String> = targets.iter().find(|t| t.path == repo.path).map(|t| t.groups.iter().cloned().collect()).unwrap_or_default();
    let group_names: Vec<String> = db::list_workspace_groups(pool).await.map_err(|e| e.to_string())?.into_iter().filter(|g| now.contains(&g.id)).map(|g| g.name).collect();
    let reachable: Vec<String> = reach(&targets, &repo.path, &now).into_iter().collect();
    tracing::info!("workspace_groups_set repo={} groups={}", repo.path, now.iter().map(|g| codec::api_uuid(g)).collect::<Vec<_>>().join(","));
    let groups_text = if group_names.is_empty() { "no group".to_string() } else { format!("groups: {}", group_names.join(", ")) };
    let reach_text =
        if reachable.is_empty() { "It shares a group with no other repository.".to_string() } else { format!("It can message (and be messaged by): {}.", reachable.join(", ")) };
    Ok(format!("'{}' is now in {groups_text}. {reach_text}", repo.name))
}
