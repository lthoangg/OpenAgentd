//! Plugin API v2: tools, `defineTool`, and the permissions of a plugin bundle.

use appv3_jsplugin::{register_native, JsError, JsPlugin, LoadOptions, Mode, Sandbox, Target, ToolCtx, ToolSpec};
use appv3_plugins::{Net, Permissions};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn write(dir: &Path, name: &str, src: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, src).unwrap();
    p
}

/// A bundle in a temporary folder: entry `<tmp>/bundle/index.ts`, data folder `<tmp>/data`.
struct Bundle {
    dir: tempfile::TempDir,
}

impl Bundle {
    fn new() -> Self {
        Self { dir: tempfile::tempdir().unwrap() }
    }
    fn root(&self) -> PathBuf {
        self.dir.path().join("bundle")
    }
    fn data(&self) -> PathBuf {
        self.dir.path().join("data")
    }
    fn options(&self, permissions: Permissions) -> LoadOptions {
        LoadOptions { sandbox: Some(Sandbox { plugin: "changelog-tools".into(), root: self.root(), data_dir: self.data(), permissions }) }
    }
    fn load(&self, src: &str, permissions: Permissions) -> Result<Arc<JsPlugin>, String> {
        let entry = write(&self.root(), "index.ts", src);
        JsPlugin::load_with(&entry, self.options(permissions))
    }
    /// The same source loaded as a v1 plugin: no sandbox.
    fn load_unrestricted(&self, src: &str) -> Arc<JsPlugin> {
        JsPlugin::load(&write(&self.root(), "index.ts", src)).unwrap()
    }
}

fn ctx() -> ToolCtx {
    ToolCtx { session_id: Some("s1".into()), agent_name: "alice".into(), workspace: Some("/work/space".into()), call_id: "call-1".into() }
}

#[allow(clippy::result_large_err)] // JsError carries name, message, stack and props
async fn run(p: &JsPlugin, tool: &str, args: Value) -> Result<Value, JsError> {
    p.run_tool(tool, args, ctx()).await
}

/// What the plugin tried and was refused: the error a `PermissionError` leaves behind.
fn denied(e: &JsError, permission: &str, text: &str) {
    assert_eq!(e.name, "PermissionError", "{e:?}");
    assert_eq!(e.props["permission"], permission, "{e:?}");
    assert!(e.message.starts_with("plugin changelog-tools may not "), "{}", e.message);
    assert!(e.message.contains(text), "{} (wanted {text})", e.message);
}

// ── tools ─────────────────────────────────────────────────────────────────

const TOOLS: &str = r#"
import { defineTool, sleep } from "openagentd";

export default {
  tools: [
    defineTool({
      name: "draft_release_notes",
      description: "Draft release notes from a list of changes.",
      input: { type: "object", properties: { since: { type: "string", description: "Tag to start from" } }, required: ["since"] },
      readOnly: true,
      run(args: { since: string }) { return `notes since ${args.since}`; },
    }),
    {
      name: "publish",
      description: "Publish the notes.",
      input: { type: "object", properties: {} },
      async run() {
        await sleep(20);
        return [{ type: "text", text: "published" }, { type: "image", data: "AAAA", mimeType: "image/png" }];
      },
    },
    defineTool({
      name: "echo",
      description: "Return what run() received.",
      input: { type: "object", properties: {} },
      run(args: any, ctx: any) { return JSON.stringify({ args, ctx }); },
    }),
  ],
};
"#;

#[test]
fn a_bundle_with_tools_loads_and_lists_them_in_order() {
    let b = Bundle::new();
    let p = b.load(TOOLS, Permissions::default()).unwrap();
    let names: Vec<&str> = p.tools().iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["draft_release_notes", "publish", "echo"]);
    assert_eq!(
        p.tools()[0],
        ToolSpec {
            name: "draft_release_notes".into(),
            description: "Draft release notes from a list of changes.".into(),
            input_schema: json!({"type": "object", "properties": {"since": {"type": "string", "description": "Tag to start from"}}, "required": ["since"]}),
            read_only: true,
        }
    );
    assert_eq!(p.tools()[1].input_schema, json!({"type": "object", "properties": {}}));
    assert!(!p.tools()[1].read_only && !p.tools()[2].read_only);
    assert!(p.warnings().is_empty(), "{:?}", p.warnings());
    // The describe output carries the same list for consumers that read it.
    assert_eq!(p.describe["default"]["tools"][0]["name"], "draft_release_notes");
    assert_eq!(p.describe["exports"], json!(["default"]));
    // The data folder exists after the load.
    assert!(b.data().is_dir());
}

#[test]
fn a_file_loaded_without_a_sandbox_still_has_its_tools() {
    let b = Bundle::new();
    let p = b.load_unrestricted(TOOLS);
    assert_eq!(p.tools().len(), 3);
}

/// The form the type declarations document: type imports, a typed `defineTool`, `satisfies Plugin`.
#[tokio::test(flavor = "multi_thread")]
async fn the_documented_typescript_form_loads_and_runs() {
    let src = r#"
import { defineTool } from "openagentd";
import type { Plugin, ToolContext } from "openagentd";

export default {
  tools: [
    defineTool<{ name: string }>({
      name: "greet",
      description: "Say hello.",
      input: { type: "object", properties: { name: { type: "string", description: "Who to greet" } } },
      readOnly: true,
      run: (args, ctx: ToolContext) => `hello ${args.name} from ${ctx.agentName}`,
    }),
  ],
} satisfies Plugin;
"#;
    let b = Bundle::new();
    let p = b.load(src, Permissions::default()).unwrap();
    assert_eq!(p.tools()[0].name, "greet");
    assert!(p.tools()[0].read_only && p.warnings().is_empty());
    assert_eq!(run(&p, "greet", json!({"name": "Ada"})).await.unwrap(), json!("hello Ada from alice"));
}

#[tokio::test(flavor = "multi_thread")]
async fn run_tool_returns_a_string_or_content_blocks() {
    let b = Bundle::new();
    let p = b.load(TOOLS, Permissions::default()).unwrap();
    let notes = run(&p, "draft_release_notes", json!({"since": "v1.2"})).await.unwrap();
    assert_eq!(notes, json!("notes since v1.2"));
    // `publish` is async: the sleep inside it is awaited.
    let t = std::time::Instant::now();
    let blocks = run(&p, "publish", json!({})).await.unwrap();
    assert!(t.elapsed() >= std::time::Duration::from_millis(15));
    assert_eq!(blocks, json!([{"type": "text", "text": "published"}, {"type": "image", "data": "AAAA", "mimeType": "image/png"}]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_context_and_arguments_reach_run() {
    let b = Bundle::new();
    let p = b.load(TOOLS, Permissions::default()).unwrap();
    let out = run(&p, "echo", json!({"n": [1, 2], "s": "é"})).await.unwrap();
    let seen: Value = serde_json::from_str(out.as_str().unwrap()).unwrap();
    assert_eq!(seen["args"], json!({"n": [1, 2], "s": "é"}));
    assert_eq!(seen["ctx"], json!({"sessionId": "s1", "agentName": "alice", "workspace": "/work/space", "callId": "call-1"}));
    // Missing values arrive as null, and no arguments as an empty object.
    let out = p.run_tool("echo", Value::Null, ToolCtx { agent_name: "bob".into(), ..Default::default() }).await.unwrap();
    let seen: Value = serde_json::from_str(out.as_str().unwrap()).unwrap();
    assert_eq!(seen["args"], json!({}));
    assert_eq!(seen["ctx"], json!({"sessionId": null, "agentName": "bob", "workspace": null, "callId": ""}));
}

#[tokio::test(flavor = "multi_thread")]
async fn markers_in_model_written_arguments_stay_plain_data() {
    let b = Bundle::new();
    let p = b.load(TOOLS, Permissions::default()).unwrap();
    let args = json!({"$oadCallback": 1, "x": {"$oadHandle": 1}, "y": {"$oadCredentials": {"providerId": "p"}}});
    let out = run(&p, "echo", args.clone()).await.unwrap();
    let seen: Value = serde_json::from_str(out.as_str().unwrap()).unwrap();
    assert_eq!(seen["args"], args);
}

#[test]
fn tool_context_serialises_in_camel_case() {
    let c = ToolCtx { session_id: Some("s".into()), agent_name: "a".into(), workspace: None, call_id: "c".into() };
    assert_eq!(serde_json::to_value(&c).unwrap(), json!({"sessionId": "s", "agentName": "a", "workspace": null, "callId": "c"}));
}

const FAILING: &str = r#"
export default {
  tools: [
    { name: "boom", description: "Throws.", input: { type: "object" }, run() { throw new Error("it broke"); } },
    { name: "reject", description: "Rejects.", input: { type: "object" }, async run() { throw new TypeError("later"); } },
    { name: "nothing", description: "Returns nothing.", input: { type: "object" }, run() {} },
    { name: "object", description: "Returns an object.", input: { type: "object" }, run() { return { a: 1 }; } },
    { name: "bad_block", description: "Bad content block.", input: { type: "object" }, run() { return [{ type: "text", text: "ok" }, { type: "audio" }]; } },
    { name: "bad_image", description: "Image without a type.", input: { type: "object" }, run() { return [{ type: "image", data: "AA" }]; } },
    { name: "empty", description: "No blocks.", input: { type: "object" }, run() { return []; } },
  ],
};
"#;

#[tokio::test(flavor = "multi_thread")]
async fn tool_failures_come_back_as_errors() {
    let b = Bundle::new();
    let p = b.load(FAILING, Permissions::default()).unwrap();
    let e = run(&p, "boom", json!({})).await.unwrap_err();
    assert_eq!((e.name.as_str(), e.message.as_str()), ("Error", "it broke"));
    let e = run(&p, "reject", json!({})).await.unwrap_err();
    assert_eq!((e.name.as_str(), e.message.as_str()), ("TypeError", "later"));
    let e = run(&p, "nothing", json!({})).await.unwrap_err();
    assert!(e.message.contains("tool nothing: run() returned nothing"), "{}", e.message);
    let e = run(&p, "object", json!({})).await.unwrap_err();
    assert!(e.message.contains("returned object; it must return a string or an array of content blocks"), "{}", e.message);
    let e = run(&p, "bad_block", json!({})).await.unwrap_err();
    assert!(e.message.contains("invalid content block at index 1"), "{}", e.message);
    assert!(run(&p, "bad_image", json!({})).await.unwrap_err().message.contains("index 0"));
    assert_eq!(run(&p, "empty", json!({})).await.unwrap(), json!([]));
    let e = run(&p, "missing", json!({})).await.unwrap_err();
    assert!(e.message.contains("has no tool named 'missing'"), "{}", e.message);
    // The plugin keeps answering after failures.
    assert_eq!(run(&p, "empty", json!({})).await.unwrap(), json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_that_never_yields_is_interrupted_and_the_plugin_keeps_answering() {
    let src = r#"
export default {
  tools: [
    { name: "spin", description: "Never yields.", input: { type: "object" }, run() { while (true) {} } },
    { name: "ok", description: "Fine.", input: { type: "object" }, run() { return "fine"; } },
  ],
};
"#;
    let b = Bundle::new();
    let p = b.load(src, Permissions::default()).unwrap();
    let started = std::time::Instant::now();
    let e = run(&p, "spin", json!({})).await.unwrap_err();
    assert_eq!(e.name, "TimeoutError", "{e:?}");
    assert!(started.elapsed() < appv3_jsplugin::BUSY_LIMIT * 2, "took {:?}", started.elapsed());
    assert_eq!(run(&p, "ok", json!({})).await.unwrap(), json!("fine"));
}

/// Plugin code can catch a refusal and tell what it was.
#[tokio::test(flavor = "multi_thread")]
async fn a_permission_error_can_be_caught_by_the_plugin() {
    let src = r#"
import { defineTool, fetch, PermissionError } from "openagentd";
export default { tools: [defineTool({
  name: "probe", description: "Try a fetch and report the refusal.", input: { type: "object" },
  async run() {
    try { await fetch("http://example.invalid/"); return "fetched"; }
    catch (e: any) { return JSON.stringify({ is: e instanceof PermissionError, name: e.name, permission: e.permission, target: e.target }); }
  },
})] };
"#;
    let b = Bundle::new();
    let p = b.load(src, Permissions::default()).unwrap();
    let out = run(&p, "probe", json!({})).await.unwrap();
    let seen: Value = serde_json::from_str(out.as_str().unwrap()).unwrap();
    assert_eq!(seen, json!({"is": true, "name": "PermissionError", "permission": "net", "target": "example.invalid"}));
}

// ── validation at load ────────────────────────────────────────────────────

fn with_tools(defs: &str) -> String {
    format!("export default {{ tools: [{defs}] }};")
}

#[test]
fn invalid_tool_definitions_fail_the_load_with_an_error_naming_the_tool() {
    let ok = r#"description: "d", input: { type: "object" }, run() { return "x"; }"#;
    let long = "a".repeat(65);
    let cases: Vec<(String, &str)> = vec![
        (with_tools(&format!(r#"{{ name: "Bad Name", {ok} }}"#)), r#"tool "Bad Name": name must match ^[a-z][a-z0-9_]{0,63}$"#),
        (with_tools(&format!(r#"{{ name: "1st", {ok} }}"#)), r#"tool "1st": name must match"#),
        (with_tools(&format!(r#"{{ name: "has-dash", {ok} }}"#)), r#"tool "has-dash": name must match"#),
        (with_tools(&format!(r#"{{ name: "{long}", {ok} }}"#)), "name must match"),
        (with_tools(&format!(r#"{{ {ok} }}"#)), "tools[0]: name must be a string"),
        (with_tools(&format!(r#"{{ name: "dup", {ok} }}, {{ name: "dup", {ok} }}"#)), "tool dup: defined more than once"),
        (with_tools(r#"{ name: "nodesc", input: { type: "object" }, run() { return "x"; } }"#), "tool nodesc: description must be a non-empty string"),
        (with_tools(r#"{ name: "blank", description: "  ", input: { type: "object" }, run() { return "x"; } }"#), "tool blank: description must be a non-empty string"),
        (with_tools(r#"{ name: "noinput", description: "d", run() { return "x"; } }"#), r#"tool noinput: input must be a JSON Schema object with "type": "object""#),
        (with_tools(r#"{ name: "arrayinput", description: "d", input: [], run() { return "x"; } }"#), "tool arrayinput: input must be a JSON Schema object"),
        (
            with_tools(r#"{ name: "cyclic", description: "d", input: (() => { const o: any = { type: "object" }; o.self = o; return o; })(), run() { return "x"; } }"#),
            "tool cyclic: input must be JSON-serialisable",
        ),
        (with_tools(r#"{ name: "stringtype", description: "d", input: { type: "string" }, run() { return "x"; } }"#), "tool stringtype: input must be a JSON Schema object"),
        (with_tools(r#"{ name: "notype", description: "d", input: { properties: {} }, run() { return "x"; } }"#), "tool notype: input must be a JSON Schema object"),
        (with_tools(r#"{ name: "norun", description: "d", input: { type: "object" } }"#), "tool norun: run must be a function"),
        (with_tools(r#"{ name: "strrun", description: "d", input: { type: "object" }, run: "x" }"#), "tool strrun: run must be a function"),
        (with_tools(r#"{ name: "ro", description: "d", input: { type: "object" }, readOnly: "yes", run() { return "x"; } }"#), "tool ro: readOnly must be true or false"),
        (with_tools(r#"{ name: "props", description: "d", input: { type: "object", properties: [] }, run() { return "x"; } }"#), "tool props: input.properties must be an object"),
        (with_tools(r#""not a tool""#), "tools[0] must be an object"),
        ("export default { tools: {} };".into(), "tools must be an array"),
        (r#"import { defineTool } from "openagentd"; export default { tools: [defineTool({ name: "Bad", description: "d", input: { type: "object" }, run() { return "x"; } })] };"#.into(), r#"tool "Bad": name must match"#),
        (r#"import { defineTool } from "openagentd"; export default { tools: [defineTool({ name: "ok" })] };"#.into(), "tool ok: description must be a non-empty string"),
        (r#"import { defineTool } from "openagentd"; export default { tools: [defineTool(null)] };"#.into(), "defineTool() must be an object"),
        (r#"export default { hooks: () => ({}) };"#.into(), "hooks must be an object, not function"),
        (r#"export default { hooks: { applies_to: "alice" } };"#.into(), "hooks.applies_to must be a function"),
        (r#"export default { hooks: { "tool.before": 1 } };"#.into(), "hooks.tool.before must be a function"),
    ];
    let b = Bundle::new();
    for (src, want) in &cases {
        let e = b.load(src, Permissions::default()).err().unwrap_or_else(|| panic!("loaded: {src}"));
        assert!(e.contains(want), "{src}\n  error: {e}\n  wanted: {want}");
    }
}

#[test]
fn a_property_without_a_description_is_a_warning_not_an_error() {
    let src = r#"
export default {
  tools: [{
    name: "draft_release_notes",
    description: "Draft release notes.",
    input: { type: "object", properties: {
      since: { type: "string" },
      until: { type: "string", description: "End tag" },
      blank: { type: "string", description: "   " },
      loose: true,
    } },
    run() { return "x"; },
  }],
};
"#;
    let b = Bundle::new();
    let p = b.load(src, Permissions::default()).unwrap();
    assert_eq!(p.tools().len(), 1);
    assert_eq!(
        p.warnings(),
        [
            "tool draft_release_notes: input property 'since' has no description",
            "tool draft_release_notes: input property 'blank' has no description",
            "tool draft_release_notes: input property 'loose' has no description",
        ]
    );
}

#[test]
fn unknown_keys_and_hooks_are_warnings() {
    let src = r#"export default { tool: [], hooks: { "tool.before"() {}, "tool.befor"() {} } };"#;
    let b = Bundle::new();
    let p = b.load(src, Permissions::default()).unwrap();
    assert!(p.tools().is_empty());
    assert_eq!(p.warnings().len(), 2, "{:?}", p.warnings());
    assert!(p.warnings().iter().any(|w| w.contains("hooks.tool.befor is not a known hook")), "{:?}", p.warnings());
    assert!(p.warnings().iter().any(|w| w.contains("unknown key 'tool'")), "{:?}", p.warnings());
}

// ── v1 files are unchanged ────────────────────────────────────────────────

#[test]
fn v1_describe_output_has_no_default_entry() {
    let b = Bundle::new();
    let v1 = r#"
export const provider = { id: "demo", label: "Demo", kind: "api_key", build() { return {}; } };
export function plugin() { return { "tool.before"() {} }; }
"#;
    let p = b.load_unrestricted(v1);
    let mut keys: Vec<&str> = p.describe.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["exports", "pluginFactory", "provider", "providerMethods"]);
    assert_eq!(p.describe["pluginFactory"], "plugin");
    assert!(p.tools().is_empty() && p.warnings().is_empty());
    // A default export that is a function is still the v1 factory.
    let p = b.load_unrestricted("export default async function plugin() { return {}; }");
    assert_eq!(p.describe, json!({"exports": ["default"], "pluginFactory": "default"}));
}

#[test]
fn a_v1_plugin_keeps_full_access() {
    std::env::set_var("OAD_SB_V1_SECRET", "visible");
    let b = Bundle::new();
    let outside = b.dir.path().join("anywhere.txt");
    let src = r#"
import { env, fs, native, bundle } from "openagentd";
export function go(path: string) {
  fs.writeText(path, "written");
  let n = "";
  try { native("oad.sb.unregistered"); } catch (e: any) { n = e.name; }
  return { env: env.get("OAD_SB_V1_SECRET"), all: "OAD_SB_V1_SECRET" in env.all(), file: fs.readText(path), native: n, bundle };
}
"#;
    let p = b.load_unrestricted(src);
    let v = p.call_blocking(&Target::export(""), "go", &[json!(outside.to_str().unwrap())], Mode::Value).unwrap().value;
    assert_eq!(v, json!({"env": "visible", "all": true, "file": "written", "native": "TypeError", "bundle": null}));
}

// ── hooks and provider of a v2 default export ─────────────────────────────

const HOOKS_AND_PROVIDER: &str = r#"
export default {
  hooks: {
    "tool.before"(input: any, output: any) { output.args.command = "rtk " + output.args.command; },
    async "tool.after"(input: any, output: any) { output.output += "!"; },
    applies_to(agent: string, role: string) { return agent === "alice" && role === "agent"; },
  },
  provider: {
    id: "mine",
    label: "Mine",
    kind: "api_key",
    async build(ctx: any) { return { base: "http", tag: "built:" + ctx.model, ping(n: number) { return n + 1; } }; },
    login(emit: (e: string, d: any) => void) { emit("started", { n: 1 }); },
  },
};
"#;

#[test]
fn hooks_and_provider_are_reached_through_the_default_export() {
    let b = Bundle::new();
    let p = b.load(HOOKS_AND_PROVIDER, Permissions::default()).unwrap();
    let d = &p.describe["default"];
    assert_eq!(d["hooks"], json!(["tool.before", "tool.after", "applies_to"]));
    assert_eq!(d["provider"]["id"], "mine");
    assert_eq!(d["provider"]["kind"], "api_key");
    let methods: Vec<&str> = d["providerMethods"].as_array().unwrap().iter().map(|m| m.as_str().unwrap()).collect();
    assert!(methods.contains(&"build") && methods.contains(&"login"), "{methods:?}");
    // Nothing at the v1 places.
    assert!(p.describe.get("provider").is_none() && p.describe["pluginFactory"].is_null());

    // Hooks: `default.hooks`, v1's methods and modes.
    let hooks = Target::export("default.hooks");
    let r = p.call_blocking(&hooks, "tool.before", &[json!({"tool": "shell"}), json!({"args": {"command": "ls"}})], Mode::Args).unwrap();
    assert_eq!(r.args.unwrap()[1], json!({"args": {"command": "rtk ls"}}));
    let r = p.call_blocking(&hooks, "tool.after", &[json!({"tool": "shell"}), json!({"output": "done"})], Mode::Args).unwrap();
    assert_eq!(r.args.unwrap()[1], json!({"output": "done!"}));
    assert_eq!(p.call_blocking(&hooks, "applies_to", &[json!("alice"), json!("agent")], Mode::Value).unwrap().value, json!(true));
    assert_eq!(p.call_blocking(&hooks, "applies_to", &[json!("bob"), json!("agent")], Mode::Value).unwrap().value, json!(false));

    // Provider: `default.provider`, built with `Mode::Keep` like v1's.
    let provider = Target::export("default.provider");
    let built = p.call_blocking(&provider, "build", &[json!({"model": "m1"})], Mode::Keep).unwrap();
    assert_eq!((built.value["base"].as_str(), built.value["tag"].as_str()), (Some("http"), Some("built:m1")));
    assert!(built.methods.contains(&"ping".to_string()));
    let handle = Target::Handle(built.handle.unwrap());
    assert_eq!(p.call_blocking(&handle, "ping", &[json!(41)], Mode::Value).unwrap().value, json!(42));
    p.release(built.handle.unwrap());
}

// ── network ───────────────────────────────────────────────────────────────

struct Server {
    port: u16,
    hits: Arc<AtomicUsize>,
}

/// A local HTTP server counting the connections it gets. `/redirect` sends
/// the client to `localhost`, `/same` to the same host; anything else answers `ok`.
fn serve() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let count = hits.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut s) = conn else { continue };
            count.fetch_add(1, Ordering::SeqCst);
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let path = req.split_whitespace().nth(1).unwrap_or("/");
            let reply = match path {
                "/redirect" => format!("HTTP/1.1 302 Found\r\nLocation: http://localhost:{port}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                "/same" => format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                _ => "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string(),
            };
            let _ = s.write_all(reply.as_bytes());
        }
    });
    Server { port, hits }
}

const FETCHER: &str = r#"
import { defineTool, fetch } from "openagentd";
export default {
  tools: [defineTool({
    name: "get",
    description: "GET a URL.",
    input: { type: "object", properties: { url: { type: "string", description: "URL" } } },
    async run(a: any) { const r = await fetch(a.url); return `${r.status} ${await r.text()}`; },
  })],
};
"#;

fn hosts(list: &[&str]) -> Net {
    Net::Hosts(list.iter().map(|s| s.to_string()).collect())
}

fn net(net: Net) -> Permissions {
    Permissions { net, ..Default::default() }
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_to_a_host_that_is_not_allowed_is_refused_before_connecting() {
    let srv = serve();
    let url = json!({"url": format!("http://127.0.0.1:{}/", srv.port)});
    for n in [Net::None, hosts(&[]), hosts(&["example.com", "*.example.org", "localhost"])] {
        let b = Bundle::new();
        let p = b.load(FETCHER, net(n)).unwrap();
        let e = run(&p, "get", url.clone()).await.unwrap_err();
        denied(&e, "net", "may not fetch 127.0.0.1 (add it to permissions.net)");
        assert_eq!(e.message, "plugin changelog-tools may not fetch 127.0.0.1 (add it to permissions.net)");
        assert_eq!(e.props["target"], "127.0.0.1");
    }
    assert_eq!(srv.hits.load(Ordering::SeqCst), 0, "a refused fetch must not connect");
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_to_an_allowed_host_goes_through() {
    let srv = serve();
    let url = json!({"url": format!("http://127.0.0.1:{}/", srv.port)});
    for n in [hosts(&["127.0.0.1"]), hosts(&["example.com", "127.0.0.1"]), Net::Any] {
        let b = Bundle::new();
        let p = b.load(FETCHER, net(n)).unwrap();
        assert_eq!(run(&p, "get", url.clone()).await.unwrap(), json!("200 ok"));
    }
    assert_eq!(srv.hits.load(Ordering::SeqCst), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn wildcard_entries_match_subdomains_only() {
    let b = Bundle::new();
    let p = b.load(FETCHER, net(hosts(&["*.example.com"]))).unwrap();
    // Refused before any DNS lookup or connection, so no network is needed.
    for host in ["example.com", "evilexample.com", "example.com.evil.test", "127.0.0.1"] {
        let e = run(&p, "get", json!({"url": format!("http://{host}/")})).await.unwrap_err();
        denied(&e, "net", &format!("may not fetch {host} "));
    }
    // A URL that is no HTTP URL at all fails as it always did, without a connection.
    let e = run(&p, "get", json!({"url": "not a url"})).await.unwrap_err();
    assert_eq!(e.name, "NetworkError", "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_to_another_host_is_refused() {
    let srv = serve();
    let b = Bundle::new();
    let p = b.load(FETCHER, net(hosts(&["127.0.0.1"]))).unwrap();
    // Same host: followed.
    assert_eq!(run(&p, "get", json!({"url": format!("http://127.0.0.1:{}/same", srv.port)})).await.unwrap(), json!("200 ok"));
    assert_eq!(srv.hits.load(Ordering::SeqCst), 2);
    // `localhost` is another host name: the request fails, and nothing connects to it.
    let e = run(&p, "get", json!({"url": format!("http://127.0.0.1:{}/redirect", srv.port)})).await.unwrap_err();
    denied(&e, "net", "may not follow a redirect to localhost (add it to permissions.net)");
    assert_eq!(e.props["target"], "localhost");
    assert_eq!(srv.hits.load(Ordering::SeqCst), 3, "only the first request was made");
    // Allowing both hosts lets the redirect through (or fails to connect: never a refusal).
    let p = b.load(FETCHER, net(Net::Any)).unwrap();
    let r = run(&p, "get", json!({"url": format!("http://127.0.0.1:{}/redirect", srv.port)})).await;
    assert!(r.as_ref().map_or_else(|e| e.name != "PermissionError", |_| true), "{r:?}");
}

const LISTENER: &str = r#"
import { defineTool, listen } from "openagentd";
export default {
  tools: [defineTool({
    name: "open",
    description: "Open a port and close it.",
    input: { type: "object", properties: { host: { type: "string", description: "Address" } } },
    async run(a: any) {
      const s = await listen(a.host ? { host: a.host, port: 0 } : { port: 0 });
      const port = s.port;
      s.close();
      return port > 0 ? "listening" : "no port";
    },
  })],
};
"#;

#[tokio::test(flavor = "multi_thread")]
async fn listening_needs_the_permission_and_a_loopback_address() {
    let b = Bundle::new();
    let off = b.load(LISTENER, Permissions::default()).unwrap();
    let e = run(&off, "open", json!({})).await.unwrap_err();
    denied(&e, "listen", "may not listen on a local port (set permissions.listen to true)");
    let on = b.load(LISTENER, Permissions { listen: true, ..Default::default() }).unwrap();
    assert_eq!(run(&on, "open", json!({})).await.unwrap(), json!("listening"));
    assert_eq!(run(&on, "open", json!({"host": "localhost"})).await.unwrap(), json!("listening"));
    let e = run(&on, "open", json!({"host": "0.0.0.0"})).await.unwrap_err();
    denied(&e, "listen", "may not listen on 0.0.0.0 (only loopback addresses such as 127.0.0.1 are allowed)");
}

// ── subprocess ────────────────────────────────────────────────────────────

const PROGRAMS: &str = r#"
import { defineTool, subprocess } from "openagentd";
export default {
  tools: [
    defineTool({
      name: "exec",
      description: "Run a program.",
      input: { type: "object", properties: { cmd: { type: "string", description: "Program" }, args: { type: "array", description: "Arguments" } } },
      async run(a: any) { const r = await subprocess.run(a.cmd, a.args ?? []); return r.stdout.trim(); },
    }),
    defineTool({
      name: "find",
      description: "Look a program up.",
      input: { type: "object", properties: { name: { type: "string", description: "Program" } } },
      run(a: any) { return String(subprocess.which(a.name)); },
    }),
  ],
};
"#;

/// A program that prints `hi`, and one that is not allowed alongside it.
fn shell() -> (&'static str, Vec<&'static str>) {
    if cfg!(windows) {
        ("cmd", vec!["/d", "/c", "echo hi"])
    } else {
        ("sh", vec!["-c", "echo hi"])
    }
}

fn other_program() -> &'static str {
    if cfg!(windows) {
        "where"
    } else {
        "echo"
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_listed_programs_run() {
    let (prog, args) = shell();
    let b = Bundle::new();
    let p = b.load(PROGRAMS, Permissions { subprocess: vec![prog.into()], ..Default::default() }).unwrap();
    assert_eq!(run(&p, "exec", json!({"cmd": prog, "args": args})).await.unwrap(), json!("hi"));
    let e = run(&p, "exec", json!({"cmd": other_program(), "args": ["x"]})).await.unwrap_err();
    denied(&e, "subprocess", &format!("may not run {} (add it to permissions.subprocess)", other_program()));
    // `which` answers for programs the plugin may run only.
    assert_ne!(run(&p, "find", json!({"name": prog})).await.unwrap(), json!("null"));
    let e = run(&p, "find", json!({"name": other_program()})).await.unwrap_err();
    denied(&e, "subprocess", "may not look up");
    // No permission, no program.
    let none = b.load(PROGRAMS, Permissions::default()).unwrap();
    let e = run(&none, "exec", json!({"cmd": prog, "args": args})).await.unwrap_err();
    denied(&e, "subprocess", &format!("may not run {prog}"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_program_path_counts_by_its_file_name_but_not_from_a_writable_folder() {
    let b = Bundle::new();
    let p = b.load(PROGRAMS, Permissions { subprocess: vec!["sh".into()], ..Default::default() }).unwrap();
    assert_eq!(run(&p, "exec", json!({"cmd": "/bin/sh", "args": ["-c", "echo hi"]})).await.unwrap(), json!("hi"));
    let e = run(&p, "exec", json!({"cmd": "bin/sh", "args": ["-c", "echo hi"]})).await.unwrap_err();
    denied(&e, "subprocess", "use the program's name or an absolute path");
    let local = b.data().join("sh");
    std::fs::write(&local, "#!/bin/sh\necho gotcha\n").unwrap();
    let e = run(&p, "exec", json!({"cmd": local.to_str().unwrap()})).await.unwrap_err();
    denied(&e, "subprocess", "it is in a folder the plugin can write to");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn children_of_a_bundle_do_not_inherit_server_variables() {
    std::env::set_var("OPENAGENTD_SB_TEST_MODE", "production");
    let args = json!(["-c", "echo ${OPENAGENTD_SB_TEST_MODE:-unset}"]);
    let b = Bundle::new();
    let p = b.load(PROGRAMS, Permissions { subprocess: vec!["sh".into()], ..Default::default() }).unwrap();
    assert_eq!(run(&p, "exec", json!({"cmd": "sh", "args": args})).await.unwrap(), json!("unset"));
    // A v1 plugin is as unrestricted as ever.
    let v1 = b.load_unrestricted(PROGRAMS);
    let out = v1.run_tool("exec", json!({"cmd": "sh", "args": args}), ctx()).await.unwrap();
    assert_eq!(out, json!("production"));
}

// ── file system ───────────────────────────────────────────────────────────

const FILES: &str = r#"
import { defineTool, fs } from "openagentd";
export default {
  tools: [defineTool({
    name: "fsop",
    description: "File operations.",
    input: { type: "object", properties: {
      op: { type: "string", description: "read, write, exists, remove or mkdir" },
      path: { type: "string", description: "Path" },
      text: { type: "string", description: "Text to write" },
    } },
    run(a: any) {
      switch (a.op) {
        case "read": return String(fs.readText(a.path));
        case "write": fs.writeText(a.path, a.text ?? ""); return "ok";
        case "exists": return String(fs.exists(a.path));
        case "remove": return String(fs.remove(a.path));
        case "mkdir": fs.mkdir(a.path); return "ok";
      }
      throw new Error("unknown op " + a.op);
    },
  })],
};
"#;

struct Files {
    b: Bundle,
    p: Arc<JsPlugin>,
    extra: PathBuf,
    outside: PathBuf,
}

impl Files {
    fn new() -> Self {
        let b = Bundle::new();
        let extra = b.dir.path().join("extra");
        let outside = b.dir.path().join("outside");
        for d in [&extra, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(b.dir.path().join("outside").join("secret.txt"), "secret").unwrap();
        std::fs::write(extra.join("shared.txt"), "shared").unwrap();
        let entry = write(&b.root(), "index.ts", FILES);
        std::fs::write(b.root().join("notes.txt"), "from root").unwrap();
        assert!(!b.data().exists());
        let p = JsPlugin::load_with(&entry, b.options(Permissions { fs: vec![extra.clone()], ..Default::default() })).unwrap();
        assert!(b.data().is_dir(), "load creates the data folder");
        Self { b, p, extra, outside }
    }
    #[allow(clippy::result_large_err)] // see `run`
    async fn op(&self, op: &str, path: &Path) -> Result<Value, JsError> {
        self.p.run_tool("fsop", json!({"op": op, "path": path.to_str().unwrap(), "text": "t"}), ctx()).await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_bundle_folder_is_readable_but_not_writable() {
    let f = Files::new();
    let notes = f.b.root().join("notes.txt");
    assert_eq!(f.op("read", &notes).await.unwrap(), json!("from root"));
    assert_eq!(f.op("exists", &notes).await.unwrap(), json!("true"));
    let e = f.op("write", &f.b.root().join("new.txt")).await.unwrap_err();
    denied(&e, "fs", "may not write ");
    assert!(e.message.contains("writes are limited to its data folder and permissions.fs"), "{}", e.message);
    assert_eq!(e.props["target"], f.b.root().join("new.txt").to_str().unwrap());
    assert!(!f.b.root().join("new.txt").exists());
    denied(&f.op("write", &notes).await.unwrap_err(), "fs", "may not write ");
    denied(&f.op("remove", &notes).await.unwrap_err(), "fs", "may not remove ");
    denied(&f.op("mkdir", &f.b.root().join("sub")).await.unwrap_err(), "fs", "may not create ");
    assert!(notes.exists() && !f.b.root().join("sub").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_data_folder_is_readable_and_writable() {
    let f = Files::new();
    let state = f.b.data().join("state.json");
    assert_eq!(f.op("exists", &state).await.unwrap(), json!("false"));
    assert_eq!(f.op("write", &state).await.unwrap(), json!("ok"));
    assert_eq!(std::fs::read_to_string(&state).unwrap(), "t");
    assert_eq!(f.op("read", &state).await.unwrap(), json!("t"));
    assert_eq!(f.op("mkdir", &f.b.data().join("a/b/c")).await.unwrap(), json!("ok"));
    assert!(f.b.data().join("a/b/c").is_dir());
    assert_eq!(f.op("remove", &state).await.unwrap(), json!("true"));
    assert_eq!(f.op("remove", &state).await.unwrap(), json!("false"));
    assert_eq!(f.op("exists", &state).await.unwrap(), json!("false"));
}

#[tokio::test(flavor = "multi_thread")]
async fn files_outside_every_allowed_folder_are_off_limits() {
    let f = Files::new();
    let secret = f.outside.join("secret.txt");
    let e = f.op("read", &secret).await.unwrap_err();
    denied(&e, "fs", "may not read ");
    assert!(e.message.contains("reads are limited to its own folder, its data folder and permissions.fs"), "{}", e.message);
    denied(&f.op("exists", &secret).await.unwrap_err(), "fs", "may not read ");
    denied(&f.op("write", &f.outside.join("new.txt")).await.unwrap_err(), "fs", "may not write ");
    denied(&f.op("remove", &secret).await.unwrap_err(), "fs", "may not remove ");
    assert!(secret.exists());
    // The folders' parent and relative paths are outside too.
    denied(&f.op("read", f.b.dir.path()).await.unwrap_err(), "fs", "may not read ");
    denied(&f.op("read", Path::new("Cargo.toml")).await.unwrap_err(), "fs", "may not read ");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_permitted_extra_folder_can_be_read_and_written() {
    let f = Files::new();
    assert_eq!(f.op("read", &f.extra.join("shared.txt")).await.unwrap(), json!("shared"));
    assert_eq!(f.op("write", &f.extra.join("new.txt")).await.unwrap(), json!("ok"));
    assert_eq!(std::fs::read_to_string(f.extra.join("new.txt")).unwrap(), "t");
    assert_eq!(f.op("remove", &f.extra.join("new.txt")).await.unwrap(), json!("true"));
    assert_eq!(f.op("mkdir", &f.extra.join("d")).await.unwrap(), json!("ok"));
    assert!(f.extra.join("d").is_dir());
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_cannot_climb_out_of_an_allowed_folder() {
    let f = Files::new();
    let climb = f.b.data().join("..").join("outside").join("secret.txt");
    denied(&f.op("read", &climb).await.unwrap_err(), "fs", "may not read ");
    // `..` after a name that does not exist cannot be resolved, so it is refused. Windows
    // drops `nope\..` before it looks, so there the path resolves, lands outside, and is
    // refused as outside.
    let hidden = f.b.data().join("nope").join("..").join("..").join("outside").join("secret.txt");
    let e = f.op("read", &hidden).await.unwrap_err();
    denied(&e, "fs", "may not read ");
    assert!(cfg!(windows) || e.message.contains("cannot be resolved"), "{}", e.message);
    // Climbing out of the bundle folder to write next to the entry file.
    denied(&f.op("write", &f.b.root().join("..").join("data").join("..").join("bundle").join("x.txt")).await.unwrap_err(), "fs", "may not write ");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_link_inside_the_data_folder_cannot_lead_out() {
    let f = Files::new();
    std::os::unix::fs::symlink(&f.outside, f.b.data().join("out")).unwrap();
    std::os::unix::fs::symlink(f.outside.join("secret.txt"), f.b.data().join("file")).unwrap();
    denied(&f.op("read", &f.b.data().join("out").join("secret.txt")).await.unwrap_err(), "fs", "may not read ");
    denied(&f.op("write", &f.b.data().join("out").join("new.txt")).await.unwrap_err(), "fs", "may not write ");
    denied(&f.op("read", &f.b.data().join("file")).await.unwrap_err(), "fs", "may not read ");
    assert!(!f.outside.join("new.txt").exists());
    // Removing the link removes the link, not its target.
    assert_eq!(f.op("remove", &f.b.data().join("file")).await.unwrap(), json!("true"));
    assert!(f.outside.join("secret.txt").exists());
    assert!(f.b.data().join("file").symlink_metadata().is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn names_the_server_never_serves_stay_protected_inside_a_folder() {
    let f = Files::new();
    let e = f.op("write", &f.b.data().join(".env")).await.unwrap_err();
    denied(&e, "fs", "that name is protected");
    denied(&f.op("write", &f.extra.join(".git").join("config")).await.unwrap_err(), "fs", "that name is protected");
    assert!(!f.b.data().join(".env").exists());
    assert_eq!(f.op("write", &f.b.data().join("env.txt")).await.unwrap(), json!("ok"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_bundle_export_says_where_the_plugin_runs() {
    let b = Bundle::new();
    let src = r#"
import { defineTool, bundle } from "openagentd";
export default { tools: [defineTool({ name: "where", description: "Where.", input: { type: "object" }, run() { return JSON.stringify(bundle); } })] };
"#;
    let p = b.load(src, Permissions::default()).unwrap();
    let v: Value = serde_json::from_str(run(&p, "where", json!({})).await.unwrap().as_str().unwrap()).unwrap();
    assert_eq!(v["name"], "changelog-tools");
    assert_eq!(Path::new(v["root"].as_str().unwrap()), dunce::canonicalize(b.root()).unwrap());
    assert_eq!(Path::new(v["dataDir"].as_str().unwrap()), dunce::canonicalize(b.data()).unwrap());
}

// ── imports ───────────────────────────────────────────────────────────────

#[test]
fn a_bundle_imports_only_from_its_own_folder() {
    let b = Bundle::new();
    write(&b.root(), "lib/util.ts", "export const twice = (n: number): number => n * 2;\n");
    write(b.dir.path(), "outside.ts", "export const secret = 42;\n");
    let inside = r#"import { twice } from "./lib/util.ts"; import { defineTool } from "openagentd";
export default { tools: [defineTool({ name: "t", description: "d", input: { type: "object" }, run() { return String(twice(21)); } })] };"#;
    assert!(b.load(inside, Permissions::default()).is_ok());
    let escaping = r#"import { secret } from "../outside.ts"; export default { tools: [] }; export const s = secret;"#;
    let e = b.load(escaping, Permissions::default()).err().unwrap();
    assert!(e.contains("plugin changelog-tools may not import "), "{e}");
    assert!(e.contains("may not import ../outside.ts (outside its folder)"), "{e}");
    // A single-file plugin imports from anywhere, as before.
    let entry = write(&b.root(), "index.ts", escaping);
    assert!(JsPlugin::load(&entry).is_ok());
}

// ── environment ───────────────────────────────────────────────────────────

const ENVIRONMENT: &str = r#"
import { defineTool, env } from "openagentd";
export default {
  tools: [defineTool({
    name: "vars",
    description: "Read environment variables.",
    input: { type: "object", properties: { name: { type: "string", description: "Variable" } } },
    run(a: any) { return a.name ? String(env.get(a.name)) : JSON.stringify(env.all()); },
  })],
};
"#;

#[tokio::test(flavor = "multi_thread")]
async fn only_listed_environment_variables_are_readable() {
    std::env::set_var("OAD_SB_ALLOWED", "yes");
    std::env::set_var("OAD_SB_DENIED", "no");
    let b = Bundle::new();
    let p = b.load(ENVIRONMENT, Permissions { env: vec!["OAD_SB_ALLOWED".into(), "OAD_SB_NOT_SET".into()], ..Default::default() }).unwrap();
    assert_eq!(run(&p, "vars", json!({"name": "OAD_SB_ALLOWED"})).await.unwrap(), json!("yes"));
    assert_eq!(run(&p, "vars", json!({"name": "OAD_SB_NOT_SET"})).await.unwrap(), json!("null"));
    let e = run(&p, "vars", json!({"name": "OAD_SB_DENIED"})).await.unwrap_err();
    denied(&e, "env", "may not read the environment variable OAD_SB_DENIED (add it to permissions.env)");
    assert_eq!(e.message, "plugin changelog-tools may not read the environment variable OAD_SB_DENIED (add it to permissions.env)");
    assert_eq!(e.props["target"], "OAD_SB_DENIED");
    // `env.all()` has the permitted names that are set, and nothing else.
    let all: Value = serde_json::from_str(run(&p, "vars", json!({})).await.unwrap().as_str().unwrap()).unwrap();
    assert_eq!(all, json!({"OAD_SB_ALLOWED": "yes"}));
    // Without a permission there is nothing to read.
    let none = b.load(ENVIRONMENT, Permissions::default()).unwrap();
    assert_eq!(run(&none, "vars", json!({})).await.unwrap(), json!("{}"));
    denied(&run(&none, "vars", json!({"name": "PATH"})).await.unwrap_err(), "env", "may not read the environment variable PATH");
    // A single-file plugin reads any variable.
    let v1 = b.load_unrestricted(ENVIRONMENT);
    assert_eq!(v1.run_tool("vars", json!({"name": "OAD_SB_DENIED"}), ctx()).await.unwrap(), json!("no"));
    let all: Value = serde_json::from_str(v1.run_tool("vars", json!({}), ctx()).await.unwrap().as_str().unwrap()).unwrap();
    assert_eq!((all["OAD_SB_ALLOWED"].as_str(), all["OAD_SB_DENIED"].as_str()), (Some("yes"), Some("no")));
}

// ── registered host natives ───────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn host_natives_that_reach_outside_are_denied_to_a_bundle() {
    register_native("oad.sb.secret", Arc::new(|_| Ok(json!("leaked"))));
    register_native("http.statusMessage", Arc::new(|a: Value| Ok(json!(format!("status {}", a["status"])))));
    let src = r#"
import { defineTool, native, httpStatusMessage } from "openagentd";
export default { tools: [defineTool({
  name: "call", description: "Call a native.", input: { type: "object", properties: { name: { type: "string", description: "Native" } } },
  run(a: any) { return a.name === "http" ? String(httpStatusMessage(404, "http://x/")) : String(native(a.name, {})); },
})] };
"#;
    let b = Bundle::new();
    let p = b.load(src, Permissions::default()).unwrap();
    let e = run(&p, "call", json!({"name": "oad.sb.secret"})).await.unwrap_err();
    denied(&e, "native", "may not call the native function 'oad.sb.secret' (not available to plugin bundles)");
    // Pure computation passes the check.
    assert_eq!(run(&p, "call", json!({"name": "http"})).await.unwrap(), json!("status 404"));
    // Credentials need a declared provider (see the credentials tests).
    let e = run(&p, "call", json!({"name": "creds.get"})).await.unwrap_err();
    denied(&e, "credentials", "its default export declares no provider");
    // A single-file plugin may call whatever the host registered.
    let v1 = b.load_unrestricted(src);
    assert_eq!(v1.run_tool("call", json!({"name": "oad.sb.secret"}), ctx()).await.unwrap(), json!("leaked"));
}

// ── reloading ─────────────────────────────────────────────────────────────

fn counter_tool(name: &str) -> String {
    format!(
        r#"import {{ defineTool }} from "openagentd";
let calls = 0;
export default {{ tools: [defineTool({{ name: "{name}", description: "Counts calls.", input: {{ type: "object" }}, run() {{ calls += 1; return "{name}:" + calls; }} }})] }};
"#
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn loading_an_edited_file_again_leaves_the_old_instance_answering() {
    let b = Bundle::new();
    let entry = write(&b.root(), "index.ts", &counter_tool("first"));
    let old = JsPlugin::load_with(&entry, b.options(Permissions::default())).unwrap();
    assert_eq!(run(&old, "first", json!({})).await.unwrap(), json!("first:1"));

    write(&b.root(), "index.ts", &counter_tool("second"));
    let new = JsPlugin::load_with(&entry, b.options(Permissions::default())).unwrap();
    assert_eq!(new.tools().iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["second"]);
    assert_eq!(old.tools().iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["first"]);

    // Each instance has its own runtime and state.
    assert_eq!(run(&new, "second", json!({})).await.unwrap(), json!("second:1"));
    assert_eq!(run(&old, "first", json!({})).await.unwrap(), json!("first:2"));
    assert!(run(&old, "second", json!({})).await.is_err());
    assert!(run(&new, "first", json!({})).await.is_err());
}

#[test]
fn the_data_folder_is_created_and_a_bad_one_fails_the_load() {
    let b = Bundle::new();
    let entry = write(&b.root(), "index.ts", "export default { tools: [] };");
    let blocker = write(b.dir.path(), "file.txt", "x");
    let opts = LoadOptions { sandbox: Some(Sandbox { plugin: "p".into(), root: b.root(), data_dir: blocker.join("data"), permissions: Permissions::default() }) };
    let e = JsPlugin::load_with(&entry, opts).err().unwrap();
    assert!(e.contains("plugin p: cannot create its data folder"), "{e}");
    let opts = LoadOptions {
        sandbox: Some(Sandbox {
            plugin: "p".into(),
            root: b.root(),
            data_dir: b.data().join("nested/deeper"),
            permissions: Permissions { fs: vec!["rel".into()], ..Default::default() },
        }),
    };
    let e = JsPlugin::load_with(&entry, opts).err().unwrap();
    assert!(e.contains("must be an absolute path"), "{e}");
}
