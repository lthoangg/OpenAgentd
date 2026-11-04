//! Plugin bundles as kernel modules.
//!
//! Each folder in the plugin dirs that holds a manifest is one module,
//! `plugin:<name>`. Starting it registers what the bundle provides: its
//! skills, its MCP servers, and from its `dev.openagentd/` code the tools
//! the `mcp` tool calls, its tool hooks and its model provider. Stopping it
//! removes all of that.
//! [`reload`] compares the folders with the running modules and starts,
//! restarts or removes modules, so adding, editing, turning off or deleting
//! a plugin takes effect without a server restart, and a broken plugin (or
//! a broken part of one) leaves the rest running. New skills reach sessions
//! that start afterwards; MCP servers and tools are usable at once through
//! the `mcp` tool, and an edited tool runs its new code on its next call. A
//! provider is offered in Settings while its module runs.
//!
//! A bundle's code reaches the stored credentials of its own provider and of
//! no other: `install_credentials_gate` lets it use the provider id it
//! declares only while that provider is accepted (no built-in provider and no
//! earlier plugin has the id) and this plugin's module runs.

use appv3_agent::plugins::{bundle_tools, ExtraTool, JsToolPlugin, ToolHooks, ToolPluginRef};
use appv3_agent::skills::PluginSkills;
use appv3_jsplugin::{JsPlugin, LoadOptions, Sandbox, ToolSpec};
use appv3_kernel::{Kernel, Module, Registrar, State};
use appv3_mcp::config::ServerConfig;
use appv3_mcp::PluginServers;
use appv3_plugins::{Bundle, Net, Transport};
use appv3_providers::js_plugin::JsProviderPlugin;
use appv3_providers::plugin::{bundle_provider_owner, BundleProvider, PluginRef};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const CODE_LABEL: &str = "dev.openagentd/plugin.ts";

/// The kernel module id of plugin `name`.
pub fn module_id(name: &str) -> String {
    format!("plugin:{name}")
}

/// A plugin folder as the last [`reload`] found it.
#[derive(Clone)]
pub struct Found {
    pub path: PathBuf,
    /// The manifest's name, or the folder's when the manifest was rejected.
    pub name: String,
    pub enabled: bool,
    /// `Err`: why the plugin cannot load.
    pub bundle: Result<Bundle, String>,
    /// What its code provides, from its last load.
    pub code: CodeInfo,
}

/// What a bundle's code provided when it last loaded.
#[derive(Clone, Default)]
pub struct CodeInfo {
    pub tools: Vec<ToolSpec>,
    pub warnings: Vec<String>,
    /// Why the code, or a part of it (its hooks, its provider), did not load;
    /// the rest of the bundle runs.
    pub errors: Vec<String>,
}

/// One running plugin: what [`reload`] compares to decide on a restart.
struct Loaded {
    root: PathBuf,
    fingerprint: u64,
    code: CodeInfo,
}

#[derive(Default)]
struct Registry {
    found: Vec<Found>,
    loaded: HashMap<String, Loaded>,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// The plugins the last reload found, in folder order.
pub fn found() -> Vec<Found> {
    registry().lock().unwrap().found.clone()
}

struct PluginModule {
    id: String,
    bundle: Bundle,
    tools: Vec<ExtraTool>,
    hooks: Option<ToolPluginRef>,
    /// The provider the code declares and the providers crate can use.
    provider: Option<PluginRef>,
    /// Keeps the code's runtime alive while the module runs.
    _code: Option<Arc<JsPlugin>>,
}

#[async_trait::async_trait]
impl Module for PluginModule {
    fn id(&self) -> &str {
        &self.id
    }

    fn register(&self, r: &mut Registrar) -> anyhow::Result<()> {
        let b = &self.bundle;
        if !b.skills.is_empty() {
            let skills = b.skills.iter().map(|s| (s.name.clone(), s.dir.clone())).collect();
            r.add(PluginSkills { plugin: b.name.clone(), root: b.root.clone(), data_dir: b.data_dir.clone(), skills });
        }
        if !b.mcp_servers.is_empty() {
            r.add(PluginServers { plugin: b.name.clone(), servers: b.mcp_servers.iter().map(|s| (s.name.clone(), server_config(&s.transport))).collect() });
        }
        for t in &self.tools {
            r.add(t.clone());
        }
        if let Some(h) = &self.hooks {
            r.add(ToolHooks(h.clone()));
        }
        if let Some(p) = &self.provider {
            r.add(BundleProvider(p.clone()));
        }
        Ok(())
    }

    async fn start(&self, _: &Kernel) -> anyhow::Result<()> {
        appv3_mcp::mcp_manager().sync_plugin_servers().await;
        Ok(())
    }

    /// The kernel has removed this module's contributions by now, so the
    /// sync stops its MCP servers.
    async fn stop(&self) {
        appv3_mcp::mcp_manager().sync_plugin_servers().await;
    }
}

fn server_config(t: &Transport) -> ServerConfig {
    match t {
        Transport::Stdio { command, args, env, cwd } => ServerConfig::Stdio {
            command: command.clone(),
            args: args.clone(),
            env: env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            enabled: true,
            timeout: None,
            cwd: Some(cwd.clone()),
        },
        // A plugin's declared `streamable-http` gets no legacy fallback (Agent Plugins defines none).
        Transport::Http { url, headers } => ServerConfig::Http {
            url: url.clone(),
            headers: headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            oauth: None,
            enabled: true,
            timeout: None,
            kind: appv3_mcp::config::HttpKind::Streamable,
        },
        Transport::Sse { url, headers } => ServerConfig::Http {
            url: url.clone(),
            headers: headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            oauth: None,
            enabled: true,
            timeout: None,
            kind: appv3_mcp::config::HttpKind::Sse,
        },
    }
}

/// Every plugin folder in `dirs`, loaded. A second folder with a name
/// already taken is refused.
fn scan(dirs: &[PathBuf], data_root: &Path, config_dir: &Path) -> Vec<Found> {
    let disabled = appv3_plugins::disabled(config_dir);
    let mut out: Vec<Found> = vec![];
    for path in appv3_plugins::discover(dirs) {
        let folder = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut bundle = appv3_plugins::load(&path, data_root);
        if let Ok(b) = &bundle {
            if let Some(first) = out.iter().find(|f| f.name == b.name) {
                bundle = Err(format!("another plugin is already named {}: {}", b.name, first.path.display()));
            }
        }
        let name = match &bundle {
            Ok(b) => b.name.clone(),
            Err(_) => folder,
        };
        out.push(Found { enabled: !disabled.contains(&name), path, name, bundle, code: CodeInfo::default() });
    }
    out
}

/// What a bundle's code gave: the runtime, the parts of it the server uses, and what the plugin status shows.
struct Code {
    js: Option<Arc<JsPlugin>>,
    hooks: Option<ToolPluginRef>,
    provider: Option<PluginRef>,
    info: CodeInfo,
}

impl Code {
    /// Code that did not load (or none): nothing runs, and `errors` say why.
    fn failed(errors: Vec<String>) -> Self {
        Code { js: None, hooks: None, provider: None, info: CodeInfo { errors, ..Default::default() } }
    }
}

/// Loads a bundle's code in its sandbox; also creates its data folder.
fn load_code(b: &Bundle) -> Code {
    if let Err(e) = std::fs::create_dir_all(&b.data_dir) {
        tracing::warn!("plugin_data_dir_failed plugin={} path={} error={}", b.name, b.data_dir.display(), e);
    }
    let Some(path) = &b.code else { return Code::failed(vec![]) };
    let sandbox = Sandbox { plugin: b.name.clone(), root: b.root.clone(), data_dir: b.data_dir.clone(), permissions: b.permissions.clone() };
    let js = match JsPlugin::load_with(path, LoadOptions { sandbox: Some(sandbox) }) {
        Ok(js) => js,
        Err(e) => {
            tracing::warn!("plugin_code_failed plugin={} error={}", b.name, e);
            return Code::failed(vec![format!("{CODE_LABEL}: {e}")]);
        }
    };
    let mut info = CodeInfo { tools: js.tools().to_vec(), warnings: js.warnings().iter().map(|w| format!("{CODE_LABEL}: {w}")).collect(), errors: vec![] };
    let hooks = match JsToolPlugin::from_bundle(&js, &b.name) {
        Ok(h) => h.map(|h| Arc::new(h) as ToolPluginRef),
        Err(e) => {
            info.errors.push(format!("{CODE_LABEL}: {e}"));
            None
        }
    };
    // A provider the providers crate refuses (an empty or built-in id, no `build`) is shown here; the tools and hooks stay.
    let provider = match JsProviderPlugin::from_bundle(&js) {
        Ok(p) => p.map(|p| Arc::new(p) as PluginRef),
        Err(e) => {
            info.errors.push(format!("{CODE_LABEL}: {e}"));
            None
        }
    };
    Code { js: Some(js), hooks, provider, info }
}

/// Makes the bundle code's right to credentials depend on the providers crate (once per process): a bundle may use the
/// credentials of provider id `id` only when `id` is a provider [`appv3_providers::plugin::provider_plugins`] lists
/// from this very plugin's module. A built-in provider's id, a single file's, an id an earlier plugin has, and a
/// plugin that is turned off all fail that, and so does every id no module offers. Asked at every use.
fn install_credentials_gate() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        appv3_jsplugin::set_credentials_gate(Arc::new(|plugin: &str, id: &str| bundle_provider_owner(id).is_some_and(|module| *module == *module_id(plugin))));
    });
}

fn reload_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// Brings the running plugin modules in line with the plugin folders:
/// starts the new and enabled ones, restarts the ones whose files changed,
/// and removes the ones deleted, disabled or broken. One reload at a time.
pub async fn reload() {
    let _g = reload_lock().lock().await;
    install_credentials_gate();
    let s = appv3_core::settings();
    let (dirs, data_root, config_dir) = (s.plugins_dirs.clone(), s.data_dir.join("plugin-data"), s.config_dir.clone());
    let mut found = match tokio::task::spawn_blocking(move || scan(&dirs, &data_root, &config_dir)).await {
        Ok(found) => found,
        Err(e) => return tracing::error!("plugin_scan_failed error={}", e),
    };
    let k = appv3_kernel::global();
    let mut loaded = std::mem::take(&mut registry().lock().unwrap().loaded);
    let mut keep: HashMap<String, Loaded> = HashMap::new();
    for f in &mut found {
        let Ok(b) = &f.bundle else { continue };
        if !f.enabled {
            continue;
        }
        if let Some(l) = loaded.remove(&b.name).filter(|l| l.fingerprint == b.fingerprint && l.root == b.root) {
            f.code = l.code.clone();
            keep.insert(b.name.clone(), l);
            continue;
        }
        let id = module_id(&b.name);
        let bundle = b.clone();
        let code = match tokio::task::spawn_blocking(move || load_code(&bundle)).await {
            Ok(r) => r,
            Err(e) => Code::failed(vec![format!("{CODE_LABEL}: {e}")]),
        };
        let tools = code.js.as_ref().map(|js| bundle_tools(&b.name, js)).unwrap_or_default();
        k.stop(&id).await;
        let module = PluginModule { id: id.clone(), bundle: b.clone(), tools, hooks: code.hooks, provider: code.provider, _code: code.js };
        match k.add(module) {
            Ok(()) => match k.start(&id).await {
                Ok(()) => tracing::info!("plugin_started name={} skills={} mcp_servers={} tools={}", b.name, b.skills.len(), b.mcp_servers.len(), code.info.tools.len()),
                Err(e) => tracing::warn!("plugin_start_failed name={} error={}", b.name, e),
            },
            Err(e) => tracing::warn!("plugin_add_failed name={} error={}", b.name, e),
        }
        f.code = code.info.clone();
        keep.insert(b.name.clone(), Loaded { root: b.root.clone(), fingerprint: b.fingerprint, code: code.info });
    }
    // What is left ran before and is now gone, disabled or broken.
    for name in loaded.keys() {
        k.remove(&module_id(name)).await;
        tracing::info!("plugin_removed name={}", name);
    }
    let mut r = registry().lock().unwrap();
    r.found = found;
    r.loaded = keep;
}

/// The plugin's state as the settings API reports it.
fn state(f: &Found, modules: &[appv3_kernel::ModuleStatus]) -> (&'static str, Vec<String>) {
    let b = match &f.bundle {
        Err(e) => return ("failed", vec![e.clone()]),
        Ok(b) => b,
    };
    if !f.enabled {
        return ("disabled", vec![]);
    }
    let mut errors = vec![];
    let state = match modules.iter().find(|m| m.id == module_id(&b.name)) {
        Some(m) => {
            errors.extend(m.error.clone());
            m.state.as_str()
        }
        None => State::Pending.as_str(),
    };
    errors.extend(f.code.errors.iter().cloned());
    (state, errors)
}

/// One entry of `bundles` in `GET /api/plugins`.
pub fn bundle_json(f: &Found, modules: &[appv3_kernel::ModuleStatus]) -> Value {
    let (state, errors) = state(f, modules);
    let Ok(b) = &f.bundle else {
        return json!({
            "name": f.name, "version": null, "description": null, "path": f.path.display().to_string(),
            "enabled": f.enabled, "state": state, "errors": errors, "warnings": [], "skills": [], "mcp_servers": [], "tools": [],
            "permissions": null, "has_code": false,
        });
    };
    let qualified = |n: &str| format!("{}/{n}", b.name);
    let skills: Vec<Value> = b.skills.iter().map(|s| json!({"name": qualified(&s.name), "description": s.description})).collect();
    let servers: Vec<Value> = b
        .mcp_servers
        .iter()
        .map(|s| match &s.transport {
            Transport::Stdio { command, args, .. } => json!({"name": qualified(&s.name), "transport": "stdio", "command": command, "args": args, "url": null}),
            Transport::Http { url, .. } => json!({"name": qualified(&s.name), "transport": "http", "command": null, "args": [], "url": url}),
            Transport::Sse { url, .. } => json!({"name": qualified(&s.name), "transport": "sse", "command": null, "args": [], "url": url}),
        })
        .collect();
    let tools: Vec<Value> = f.code.tools.iter().map(|t| json!({"name": qualified(&t.name), "description": t.description, "read_only": t.read_only})).collect();
    let permissions = b.code.as_ref().map(|_| {
        let p = &b.permissions;
        let net = match &p.net {
            Net::None => json!(false),
            Net::Any => json!(true),
            Net::Hosts(hosts) => json!(hosts),
        };
        json!({"net": net, "listen": p.listen, "fs": p.fs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>(), "subprocess": p.subprocess, "env": p.env})
    });
    let mut warnings: Vec<String> = b.warnings.iter().chain(&f.code.warnings).cloned().collect();
    // The `mcp` tool lists a plugin's tools under the plugin's name, and a
    // server of the user's with that name wins.
    if !f.code.tools.is_empty() && appv3_mcp::mcp_manager().get_status(&b.name).is_some() {
        warnings.push(format!("Agents cannot use this plugin's tools: an MCP server in mcp.json is also named '{}'. Rename that server to use them.", b.name));
    }
    json!({
        "name": b.name, "version": b.version, "description": b.description, "path": b.root.display().to_string(),
        "enabled": f.enabled, "state": state, "errors": errors, "warnings": warnings, "skills": skills, "mcp_servers": servers, "tools": tools,
        "permissions": permissions, "has_code": b.code.is_some(),
    })
}

/// `bundles` of `GET /api/plugins`.
pub fn bundles_json() -> Vec<Value> {
    let modules = appv3_kernel::global().status();
    found().iter().map(|f| bundle_json(f, &modules)).collect()
}
