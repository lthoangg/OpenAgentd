//! MCP servers that plugins provide.
//!
//! A plugin's module registers a [`PluginServers`] contribution with the
//! kernel right before it starts, and calls
//! [`McpManager::sync_plugin_servers`] once its start hook is done and from
//! its stop hook (the kernel has removed the contribution by then). The
//! manager runs those servers next to the user's own and never writes them
//! to `mcp.json`.
//!
//! A plugin's server runs as `<plugin>/<server>` ([`full_name`]). A name in
//! `mcp.json` is limited to letters, digits, `_` and `-`
//! ([`crate::config::validate_server_name`]), so a plugin's server never
//! shares a name with one of the user's. The plugin loader validates the
//! names inside a plugin; the manager does not.

use crate::config::ServerConfig;
use crate::{publish_status, McpManager, Runner, ServerStatus};
use serde_json::{json, Value};
use std::sync::Arc;

/// MCP servers a plugin provides, registered as a kernel contribution by the plugin's module.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginServers {
    pub plugin: String,
    /// `(name inside the plugin, config)`; each runs as `<plugin>/<name>`.
    pub servers: Vec<(String, ServerConfig)>,
}

/// The name a plugin's server runs under: `<plugin>/<server>`.
pub fn full_name(plugin: &str, server: &str) -> String {
    format!("{plugin}/{server}")
}

/// What the settings API and the `mcp` tool answer when someone tries to
/// change a plugin's server: the plugin owns it.
pub fn managed_by_plugin_message(name: &str, plugin: &str) -> String {
    format!("{name} comes from plugin {plugin}; manage it in Settings → Plugins")
}

/// One server a running plugin provides.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Wanted {
    /// The full name, `<plugin>/<server>`.
    pub name: String,
    pub plugin: String,
    pub config: ServerConfig,
}

/// The servers `contributions` provide, in order. A name provided twice
/// keeps its first definition.
pub(crate) fn wanted(contributions: &[Arc<PluginServers>]) -> Vec<Wanted> {
    let mut out: Vec<Wanted> = vec![];
    for c in contributions {
        for (server, config) in &c.servers {
            let name = full_name(&c.plugin, server);
            if out.iter().any(|w| w.name == name) {
                continue;
            }
            out.push(Wanted { name, plugin: c.plugin.clone(), config: config.clone() });
        }
    }
    out
}

/// What the running plugin modules provide now: the kernel's contributions.
pub(crate) fn wanted_now() -> Vec<Wanted> {
    wanted(&appv3_kernel::global().contributions::<PluginServers>())
}

/// The running plugin module's server called `name`, if there is one.
pub(crate) fn wanted_server(name: &str) -> Option<Wanted> {
    wanted_now().into_iter().find(|w| w.name == name)
}

/// What turns the plugin servers that run (`current`) into the ones the
/// plugins provide (`desired`): the names to stop, then the servers to
/// start. A server that is gone, or whose config changed, is stopped; one
/// that is new, or whose config changed, is started. A name appears once in
/// each list.
pub(crate) fn plan_sync(current: &[(String, ServerConfig)], desired: &[(String, ServerConfig)]) -> (Vec<String>, Vec<(String, ServerConfig)>) {
    let same = |list: &[(String, ServerConfig)], name: &str, config: &ServerConfig| list.iter().any(|(n, c)| n == name && c == config);
    let stop = current.iter().filter(|(n, c)| !same(desired, n, c)).map(|(n, _)| n.clone()).collect();
    let start = desired.iter().filter(|(n, c)| !same(current, n, c)).cloned().collect();
    (stop, start)
}

/// `config` of a plugin's server in the settings API: [`crate::masked_config_body`],
/// plus the working directory, and a stdio server's `env` values are masked
/// too (a whole `${NAME}` reference shows as written): the plugin wrote
/// them, not the reader.
pub fn plugin_config_body(cfg: Option<&ServerConfig>) -> Value {
    let mut v = crate::masked_config_body(cfg);
    if let Some(ServerConfig::Stdio { env, cwd, .. }) = cfg {
        v["env"] = crate::admin::mask_map(env);
        if let Some(dir) = cwd {
            v["cwd"] = json!(dir.display().to_string());
        }
    }
    v
}

impl McpManager {
    /// Brings the plugins' servers in line with what the running plugin
    /// modules provide (their [`PluginServers`] contributions): a server no
    /// plugin provides any more, or whose config changed, is stopped; a new
    /// or changed one is started. The user's own servers are never touched.
    ///
    /// Call it once a plugin module's start hook is done (the contribution
    /// is registered before the hook runs) and from its stop hook (the kernel
    /// has removed the contribution before it runs). It works whether or not
    /// [`McpManager::start`] has run; `start` and `reload_from_config` also
    /// run whatever the plugins provide.
    pub async fn sync_plugin_servers(&self) {
        let _g = self.lock.lock().await;
        // Read the contributions with the lock held: a sync that waited for
        // another operation applies what the plugins provide now, not what
        // they provided when it began.
        let contributions = appv3_kernel::global().contributions::<PluginServers>();
        let desired = wanted(&contributions);
        let provided: usize = contributions.iter().map(|c| c.servers.len()).sum();
        if desired.len() < provided {
            tracing::warn!("mcp_plugin_server_duplicate provided={} distinct={}", provided, desired.len());
        }
        self.apply_plugin_servers(desired).await;
    }

    /// [`McpManager::sync_plugin_servers`] for `wanted`. The caller holds `self.lock`.
    pub(crate) async fn apply_plugin_servers(&self, wanted: Vec<Wanted>) {
        let current: Vec<(String, ServerConfig)> = self.runners.read().unwrap().iter().filter(|(_, r)| r.plugin.is_some()).map(|(n, r)| (n.clone(), r.config.clone())).collect();
        let desired: Vec<(String, ServerConfig)> = wanted.iter().map(|w| (w.name.clone(), w.config.clone())).collect();
        let (stop, start) = plan_sync(&current, &desired);
        if stop.is_empty() && start.is_empty() {
            return;
        }
        let doomed: Vec<Arc<Runner>> = {
            let runners = self.runners.read().unwrap();
            stop.iter().filter_map(|n| runners.get(n).cloned()).collect()
        };
        futures::future::join_all(doomed.iter().map(Self::stop_runner)).await;
        {
            let mut runners = self.runners.write().unwrap();
            for n in &stop {
                runners.shift_remove(n);
            }
        }
        // The UI refetches its list on these.
        for n in &stop {
            publish_status(n, "stopped");
        }
        for (name, config) in &start {
            let plugin = wanted.iter().find(|w| w.name == *name).map(|w| w.plugin.as_str());
            self.spawn(name, config, plugin);
            if let Some(st) = self.get_status(name) {
                publish_status(name, &st.state);
            }
        }
        tracing::info!("mcp_plugin_servers_synced stopped={:?} started={:?}", stop, start.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>());
    }

    /// The plugin that provides server `name`: the owner of a running
    /// plugin server by that name, or else the running plugin module that
    /// provides one. `None` for the user's own servers and unknown names.
    pub fn plugin_of(&self, name: &str) -> Option<String> {
        let owner = self.runners.read().unwrap().get(name).and_then(|r| r.plugin.clone());
        owner.or_else(|| wanted_server(name).map(|w| w.plugin))
    }

    /// The config plugin server `name` runs with (or, when it does not run
    /// yet, the one its plugin provides). Secrets are not masked here.
    pub fn plugin_server_config(&self, name: &str) -> Option<ServerConfig> {
        let running = self.runners.read().unwrap().get(name).filter(|r| r.plugin.is_some()).map(|r| r.config.clone());
        running.or_else(|| wanted_server(name).map(|w| w.config))
    }

    /// The plugins' servers with the configs they run, in listing order.
    pub fn plugin_servers(&self) -> Vec<(ServerStatus, ServerConfig)> {
        self.ordered_runners().into_iter().filter(|(_, r)| r.plugin.is_some()).map(|(_, r)| (r.status.lock().unwrap().clone(), r.config.clone())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    fn stdio(command: &str, enabled: bool) -> ServerConfig {
        ServerConfig::Stdio { command: command.into(), args: vec![], env: IndexMap::new(), enabled, timeout: None, cwd: None }
    }

    fn pair(name: &str, command: &str) -> (String, ServerConfig) {
        (name.to_string(), stdio(command, true))
    }

    #[test]
    fn a_new_server_is_started() {
        let (stop, start) = plan_sync(&[], &[pair("p/a", "x"), pair("p/b", "y")]);
        assert!(stop.is_empty());
        assert_eq!(start, [pair("p/a", "x"), pair("p/b", "y")]);
    }

    #[test]
    fn a_server_that_is_gone_is_stopped() {
        let (stop, start) = plan_sync(&[pair("p/a", "x"), pair("p/b", "y")], &[pair("p/b", "y")]);
        assert_eq!(stop, ["p/a"]);
        assert!(start.is_empty());
    }

    #[test]
    fn a_changed_server_is_stopped_then_started_again() {
        let (stop, start) = plan_sync(&[pair("p/a", "x"), pair("p/b", "y")], &[pair("p/a", "x2"), pair("p/b", "y")]);
        assert_eq!(stop, ["p/a"]);
        assert_eq!(start, [pair("p/a", "x2")]);
        // Any field counts: enabled, env, timeout, working directory.
        let base = stdio("x", true);
        let mut env = IndexMap::new();
        env.insert("K".to_string(), "v".to_string());
        for changed in [
            stdio("x", false),
            ServerConfig::Stdio { command: "x".into(), args: vec![], env, enabled: true, timeout: None, cwd: None },
            ServerConfig::Stdio { command: "x".into(), args: vec![], env: IndexMap::new(), enabled: true, timeout: Some(5), cwd: None },
            ServerConfig::Stdio { command: "x".into(), args: vec![], env: IndexMap::new(), enabled: true, timeout: None, cwd: Some("/w".into()) },
        ] {
            let (stop, start) = plan_sync(&[("p/a".to_string(), base.clone())], &[("p/a".to_string(), changed.clone())]);
            assert_eq!((stop.len(), start.len()), (1, 1), "{changed:?}");
        }
    }

    #[test]
    fn nothing_changes_when_the_plugins_still_provide_what_runs() {
        let both = [pair("p/a", "x"), pair("q/b", "y")];
        assert_eq!(plan_sync(&both, &both), (vec![], vec![]));
        assert_eq!(plan_sync(&[], &[]), (vec![], vec![]));
    }

    #[test]
    fn a_plan_mixes_every_case() {
        let (stop, start) = plan_sync(&[pair("p/keep", "k"), pair("p/old", "o"), pair("p/edit", "e")], &[pair("p/new", "n"), pair("p/keep", "k"), pair("p/edit", "e2")]);
        assert_eq!(stop, ["p/old", "p/edit"]);
        assert_eq!(start, [pair("p/new", "n"), pair("p/edit", "e2")]);
    }

    fn provides(plugin: &str, servers: &[(&str, &str)]) -> Arc<PluginServers> {
        Arc::new(PluginServers { plugin: plugin.into(), servers: servers.iter().map(|(n, c)| (n.to_string(), stdio(c, true))).collect() })
    }

    #[test]
    fn servers_run_as_plugin_slash_server_and_the_first_definition_of_a_name_wins() {
        let w =
            wanted(&[provides("changelog-tools", &[("github", "a"), ("git.hub", "b")]), provides("other", &[("github", "c")]), provides("changelog-tools", &[("github", "dup")])]);
        assert_eq!(w.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), ["changelog-tools/github", "changelog-tools/git.hub", "other/github"]);
        assert_eq!(w.iter().map(|w| w.plugin.as_str()).collect::<Vec<_>>(), ["changelog-tools", "changelog-tools", "other"]);
        assert_eq!(w[0].config, stdio("a", true), "the first definition is kept");
    }

    /// `(name, plugin)` of every listed server.
    fn names(m: &McpManager) -> Vec<(String, Option<String>)> {
        m.list_status().into_iter().map(|s| (s.name, s.plugin)).collect()
    }

    /// A server that never starts (disabled), so a sync can be checked without a process.
    fn want(plugin: &str, server: &str, command: &str) -> Wanted {
        Wanted { name: full_name(plugin, server), plugin: plugin.into(), config: stdio(command, false) }
    }

    fn runner(m: &McpManager, name: &str) -> Arc<Runner> {
        m.runners.read().unwrap().get(name).cloned().unwrap_or_else(|| panic!("no runner {name}"))
    }

    #[tokio::test]
    async fn a_sync_adds_changes_and_removes_plugin_servers_and_leaves_the_users_alone() {
        let m = McpManager::default();
        m.spawn_runner("mine", &stdio("user-cmd", false));
        let mine = runner(&m, "mine");

        m.apply_plugin_servers(vec![want("changelog-tools", "github", "a"), want("changelog-tools", "docs", "b")]).await;
        let tools = Some("changelog-tools".to_string());
        assert_eq!(names(&m), [("mine".to_string(), None), ("changelog-tools/github".to_string(), tools.clone()), ("changelog-tools/docs".to_string(), tools)]);
        let github = runner(&m, "changelog-tools/github");

        // One server goes, the other is not restarted.
        m.apply_plugin_servers(vec![want("changelog-tools", "github", "a")]).await;
        assert!(Arc::ptr_eq(&github, &runner(&m, "changelog-tools/github")), "an unchanged server is not restarted");
        assert!(m.get_status("changelog-tools/docs").is_none());
        // One changes, another arrives.
        m.apply_plugin_servers(vec![want("changelog-tools", "github", "a2"), want("lint", "rules", "c")]).await;
        assert!(!Arc::ptr_eq(&github, &runner(&m, "changelog-tools/github")), "a changed server restarts");
        assert_eq!(m.plugin_servers().iter().map(|(s, _)| s.name.as_str()).collect::<Vec<_>>(), ["changelog-tools/github", "lint/rules"]);
        assert_eq!(m.plugin_servers()[0].1, stdio("a2", false));

        // No plugin provides anything: the plugin servers go, the user's stays, untouched.
        m.apply_plugin_servers(vec![]).await;
        assert_eq!(names(&m), [("mine".to_string(), None)]);
        assert!(Arc::ptr_eq(&mine, &runner(&m, "mine")), "the user's server was not touched");
    }

    #[tokio::test]
    async fn listings_put_the_users_servers_first_whatever_started_last() {
        let m = McpManager::default();
        m.apply_plugin_servers(vec![want("p", "s", "a")]).await;
        m.spawn_runner("late", &stdio("x", false));
        assert_eq!(names(&m).iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["late", "p/s"]);
        assert_eq!(m.server_names(), ["late", "p/s"]);
    }

    #[tokio::test]
    async fn only_a_plugins_own_stop_removes_its_server() {
        let m = McpManager::default();
        m.apply_plugin_servers(vec![want("p", "s", "a")]).await;
        m.remove_runner("p/s").await;
        assert!(m.get_status("p/s").is_some());
        m.spawn_runner("mine", &stdio("x", false));
        m.remove_runner("mine").await;
        assert!(m.get_status("mine").is_none());
    }

    #[tokio::test]
    async fn stopping_the_manager_stops_the_plugins_servers_even_if_it_never_started() {
        let m = McpManager::default();
        m.apply_plugin_servers(vec![want("p", "s", "a")]).await;
        assert_eq!(m.plugin_of("p/s").as_deref(), Some("p"));
        assert_eq!(m.plugin_of("mine"), None);
        m.stop().await;
        assert!(m.list_status().is_empty());
    }

    #[test]
    fn the_settings_body_masks_a_plugin_servers_env_and_shows_its_directory() {
        let mut env = IndexMap::new();
        env.insert("TOKEN".to_string(), "literal".to_string());
        env.insert("REF".to_string(), "${GITHUB_TOKEN}".to_string());
        let cfg = ServerConfig::Stdio { command: "node".into(), args: vec!["s.js".into()], env, enabled: true, timeout: Some(30), cwd: Some("/plugins/p".into()) };
        let v = plugin_config_body(Some(&cfg));
        assert_eq!(v["env"], json!({"TOKEN": "********", "REF": "${GITHUB_TOKEN}"}));
        assert_eq!((v["cwd"].as_str(), v["command"].as_str(), v["timeout"].as_u64()), (Some("/plugins/p"), Some("node"), Some(30)));
        assert!(plugin_config_body(Some(&stdio("x", true))).get("cwd").is_none());
        assert_eq!(plugin_config_body(None), Value::Null);
    }

    #[test]
    fn the_refusal_text_names_the_plugin() {
        assert_eq!(
            managed_by_plugin_message("changelog-tools/github", "changelog-tools"),
            "changelog-tools/github comes from plugin changelog-tools; manage it in Settings → Plugins"
        );
    }
}
