use appv3_jsplugin::{plugin_files, Callback, JsPlugin, Mode, Target};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn write(dir: &std::path::Path, name: &str, src: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, src).unwrap();
    p
}

const DEMO: &str = r#"
import { sleep, crypto, base64, url, pyJsonDumps, pyRepr, HttpError, ValueError, subprocess, listen, fetch, parseIsoTimestamp } from "openagentd";
import { shout } from "./_util.ts";

interface Ctx { n: number }
let calls = 0;

export const provider = {
  id: "demo",
  label: "Demo",
  kind: "oauth" as const,
  modelRegistryAliases: { a: "b:c" },
  async build(ctx: Ctx) {
    const base = ctx.n;
    return {
      base: "http",
      tag: shout("x"),
      async bump(k: number) { await sleep(5); calls += k; return base + calls; },
      fail() { throw new HttpError(429, "slow down", { body: "{}" }); },
      bad() { throw new ValueError("missing creds"); },
    };
  },
  async login(emit: (e: string, d: any) => void) { emit("started", { message: "hi" }); emit("success", { n: 1 }); },
};

export function helpers() {
  const pk = base64.encode(crypto.sha256("abc"), { url: true });
  return {
    pk,
    hex: crypto.sha256Hex("abc"),
    form: url.encodeForm([["a b", "x/y~*"], ["s", "é"]]),
    q: url.parseQuery("code=a%20b&state=x+y&empty=&code=2"),
    query: url.queryOf("https://x/cb?code=1&state=2#frag"),
    dumps: pyJsonDumps({ a: [1, "é"], b: null }),
    repr: pyRepr("it's"),
    ts: parseIsoTimestamp("2026-01-01T00:00:00Z"),
    uuid: crypto.uuid7().length,
  };
}

export async function mutate(input: any, output: any) { output.args.command = "rtk " + output.args.command; }

export async function shell() {
  const r = await subprocess.run("sh", ["-c", "echo hi; echo err 1>&2; exit 3"]);
  const t = await subprocess.run("sleep", ["5"], { timeoutMs: 50 });
  return { r, timedOut: t.timedOut };
}

export async function roundtrip() {
  const srv = await listen({ port: 0 });
  const got = srv.accept(5000);
  const resp = fetch(`http://127.0.0.1:${srv.port}/cb?code=1&state=s`);
  const req = await got;
  await req!.respond(200, "OK", { headers: { "Content-Type": "text/plain" }, body: "done" });
  const r = await resp;
  srv.close();
  return { path: req!.path, query: req!.query, status: r.status, body: await r.text(), ct: r.headers.get("content-type") };
}

export async function netfail() {
  // Windows retries a refused SYN for about 2 s; the timeout must outlast that.
  try { await fetch("http://127.0.0.1:1/", { timeout: 10000 }); return "no error"; } catch (e: any) { return [e.name, e.kind, e.connect]; }
}
"#;

fn setup() -> (tempfile::TempDir, Arc<JsPlugin>) {
    let d = tempfile::tempdir().unwrap();
    write(d.path(), "_util.ts", "export const shout = (s: string): string => s.toUpperCase() + '!';\n");
    // Windows has no `sh`/`sleep`; same behaviour through cmd.exe.
    let demo = if cfg!(windows) {
        DEMO.replace(r#"subprocess.run("sh", ["-c", "echo hi; echo err 1>&2; exit 3"])"#, r#"subprocess.run("cmd", ["/d", "/c", "echo hi& >&2 echo err& exit 3"])"#)
            .replace(r#"subprocess.run("sleep", ["5"]"#, r#"subprocess.run("ping", ["-n", "6", "127.0.0.1"]"#)
    } else {
        DEMO.to_string()
    };
    let p = write(d.path(), "demo.ts", &demo);
    let plugin = JsPlugin::load(&p).unwrap();
    (d, plugin)
}

#[test]
fn discovery_skips_helpers_and_declarations() {
    let d = tempfile::tempdir().unwrap();
    for n in ["b.ts", "a.js", "_h.ts", "types.d.ts", "x.py", ".hidden.ts"] {
        write(d.path(), n, "");
    }
    let names: Vec<String> = plugin_files(&[d.path().to_path_buf(), d.path().to_path_buf()]).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["a.js", "b.ts"]);
}

#[test]
fn describe_and_keep_handles() {
    let (_d, p) = setup();
    assert_eq!(p.describe["provider"]["id"], "demo");
    assert_eq!(p.describe["provider"]["modelRegistryAliases"], json!({"a": "b:c"}));
    let methods: Vec<&str> = p.describe["providerMethods"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert!(methods.contains(&"build") && methods.contains(&"login"));
    let r = p.call_blocking(&Target::export("provider"), "build", &[json!({"n": 100})], Mode::Keep).unwrap();
    assert_eq!(r.value["base"], "http");
    assert_eq!(r.value["tag"], "X!");
    assert!(r.methods.contains(&"bump".to_string()));
    let h = Target::Handle(r.handle.unwrap());
    assert_eq!(p.call_blocking(&h, "bump", &[json!(2)], Mode::Value).unwrap().value, json!(102));
    let e = p.call_blocking(&h, "fail", &[], Mode::Value).unwrap_err();
    assert_eq!((e.name.as_str(), e.message.as_str()), ("HttpError", "slow down"));
    assert_eq!(e.props["kind"], "http");
    assert_eq!(e.props["status"], 429);
    assert_eq!(e.props["body"], "{}");
    assert_eq!(p.call_blocking(&h, "bad", &[], Mode::Value).unwrap_err().props["kind"], "invalid");
    p.release(r.handle.unwrap());
    let gone = p.call_blocking(&h, "bump", &[json!(1)], Mode::Value).unwrap_err();
    assert!(gone.message.contains("released"), "{}", gone.message);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_calls_interleave() {
    let (_d, p) = setup();
    let r = p.call(&Target::export("provider"), "build", &[json!({"n": 0})], Mode::Keep).await.unwrap();
    let h = Target::Handle(r.handle.unwrap());
    let t = std::time::Instant::now();
    let one = [json!(1)];
    let futs: Vec<_> = (0..20).map(|_| p.call(&h, "bump", &one, Mode::Value)).collect();
    let out = futures_join(futs).await;
    assert!(t.elapsed() < std::time::Duration::from_millis(80), "{:?}", t.elapsed());
    let mut nums: Vec<i64> = out.into_iter().map(|r| r.unwrap().value.as_i64().unwrap()).collect();
    nums.sort();
    assert_eq!(nums, (1..=20).collect::<Vec<_>>());
}

async fn futures_join<F: std::future::Future>(v: Vec<F>) -> Vec<F::Output> {
    let mut out = vec![];
    let mut pinned: Vec<std::pin::Pin<Box<F>>> = v.into_iter().map(Box::pin).collect();
    let mut done: Vec<Option<F::Output>> = pinned.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut all = true;
        for (i, f) in pinned.iter_mut().enumerate() {
            if done[i].is_none() {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => done[i] = Some(v),
                    std::task::Poll::Pending => all = false,
                }
            }
        }
        if all {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    out.extend(done.into_iter().map(|v| v.unwrap()));
    out
}

#[test]
fn callbacks_reach_rust() {
    let (_d, p) = setup();
    let seen: Arc<Mutex<Vec<Value>>> = Default::default();
    let s = seen.clone();
    let cb = Callback::new(Arc::new(move |args| {
        s.lock().unwrap().push(Value::Array(args));
        Value::Null
    }));
    p.call_blocking(&Target::export("provider"), "login", &[cb.marker()], Mode::Value).unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![json!(["started", {"message": "hi"}]), json!(["success", {"n": 1}])]);
}

#[test]
fn helpers_match_python_semantics() {
    let (_d, p) = setup();
    let v = p.call_blocking(&Target::export(""), "helpers", &[], Mode::Value).unwrap().value;
    assert_eq!(v["hex"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(v["pk"], "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    assert_eq!(v["form"], "a+b=x%2Fy~%2A&s=%C3%A9");
    assert_eq!(v["q"], json!({"code": ["a b", "2"], "state": ["x y"]}));
    assert_eq!(v["query"], "code=1&state=2");
    assert_eq!(v["dumps"], "{\"a\": [1, \"\\u00e9\"], \"b\": null}");
    assert_eq!(v["repr"], "\"it's\"");
    assert_eq!(v["ts"], 1767225600);
    assert_eq!(v["uuid"], 36);
}

#[test]
fn args_mode_returns_mutated_arguments() {
    let (_d, p) = setup();
    let r = p.call_blocking(&Target::export(""), "mutate", &[json!({"tool": "shell"}), json!({"args": {"command": "ls"}})], Mode::Args).unwrap();
    assert_eq!(r.args.unwrap()[1], json!({"args": {"command": "rtk ls"}}));
}

#[test]
fn subprocess_and_local_http() {
    let (_d, p) = setup();
    let v = p.call_blocking(&Target::export(""), "shell", &[], Mode::Value).unwrap().value;
    let r: Value = serde_json::from_str(&v["r"].to_string().replace("\\r\\n", "\\n")).unwrap();
    assert_eq!(r, json!({"code": 3, "stdout": "hi\n", "stderr": "err\n", "timedOut": false}));
    assert_eq!(v["timedOut"], true);
    let v = p.call_blocking(&Target::export(""), "roundtrip", &[], Mode::Value).unwrap().value;
    assert_eq!(v, json!({"path": "/cb", "query": "code=1&state=s", "status": 200, "body": "done", "ct": "text/plain"}));
    let v = p.call_blocking(&Target::export(""), "netfail", &[], Mode::Value).unwrap().value;
    assert_eq!(v, json!(["NetworkError", "network", true]));
}

#[test]
fn load_errors_are_reported() {
    let d = tempfile::tempdir().unwrap();
    let p = write(d.path(), "bad.ts", "export const x: number = ;\n");
    let e = JsPlugin::load(&p).unwrap_err();
    assert!(e.contains("bad.ts:1:"), "{e}");
    let p = write(d.path(), "imp.ts", "import x from \"lodash\";\nexport const y = x;\n");
    let e = JsPlugin::load(&p).unwrap_err();
    assert!(e.contains("lodash"), "{e}");
    let p = write(d.path(), "throws.js", "throw new Error('boom');\n");
    let e = JsPlugin::load(&p).unwrap_err();
    assert_eq!(e, "boom");
}

const REGEX_DEMO: &str = r#"
import { regex } from "openagentd";

const TOKEN = regex.compile(String.raw`\b(?P<kind>sk|gh)-(\w{4,})\b`, "i");
const PEM = regex.compile(String.raw`-----BEGIN (?P<l>[A-Z ]+)-----.*?-----END (?P=l)-----`, "s");

export function run(text: string) {
  const all = TOKEN.findAll(text);
  let err = "";
  try { regex.compile("("); } catch (e: any) { err = e.name; }
  return {
    test: [TOKEN.test(text), TOKEN.test("nothing")],
    first: TOKEN.find(text),
    spans: all.map((m) => text.slice(m.index, m.end)),
    names: TOKEN.groupNames,
    subn: TOKEN.subn(text, (m) => `<${m.named.kind!.toLowerCase()}>`),
    template: TOKEN.replace(text, "[$<kind>:$2|$$]"),
    pem: PEM.subn("a -----BEGIN X KEY-----\n1\n-----END X KEY----- b", "[KEY]"),
    err,
  };
}
"#;

#[test]
fn native_regex_module() {
    let d = tempfile::tempdir().unwrap();
    let p = JsPlugin::load(&write(d.path(), "re.ts", REGEX_DEMO)).unwrap();
    // "é" and "😀" check that offsets are UTF-16 (what JS `slice` expects).
    let v = p.call_blocking(&Target::export(""), "run", &[json!("é SK-abcd 😀 gh-wxyz9 xsk-nope")], Mode::Value).unwrap().value;
    assert_eq!(v["test"], json!([true, false]));
    assert_eq!(v["first"], json!({"text": "SK-abcd", "index": 2, "end": 9, "groups": ["SK", "abcd"], "named": {"kind": "SK"}}));
    assert_eq!(v["spans"], json!(["SK-abcd", "gh-wxyz9"]));
    assert_eq!(v["names"], json!({"kind": 1}));
    assert_eq!(v["subn"], json!(["é <sk> 😀 <gh> xsk-nope", 2]));
    assert_eq!(v["template"], json!("é [SK:abcd|$] 😀 [gh:wxyz9|$] xsk-nope"));
    assert_eq!(v["pem"], json!(["a [KEY] b", 1]));
    assert_eq!(v["err"], json!("SyntaxError"));
}

const SPIN: &str = r#"
export function spin() { while (true) {} }
export async function spinLater() { await Promise.resolve(); while (true) {} }
export function ok() { return 1; }
export function never() { return new Promise(() => {}); }
"#;

#[tokio::test(flavor = "multi_thread")]
async fn busy_loop_in_a_call_is_interrupted() {
    let d = tempfile::tempdir().unwrap();
    let p = JsPlugin::load(&write(d.path(), "spin.ts", SPIN)).unwrap();
    for method in ["spin", "spinLater"] {
        let t = std::time::Instant::now();
        let e = p.call(&Target::export(""), method, &[], Mode::Value).await.unwrap_err();
        assert_eq!(e.name, "TimeoutError", "{method}: {e:?}");
        assert!(t.elapsed() < appv3_jsplugin::BUSY_LIMIT * 2, "{method} took {:?}", t.elapsed());
        // The plugin's thread is usable again.
        assert_eq!(p.call(&Target::export(""), "ok", &[], Mode::Value).await.unwrap().value, json!(1));
    }
}

#[test]
fn busy_loop_at_top_level_fails_the_load() {
    let d = tempfile::tempdir().unwrap();
    let e = JsPlugin::load(&write(d.path(), "top.ts", "while (true) {}\nexport const x = 1;\n")).unwrap_err();
    assert!(e.contains("without yielding") || e.contains("to load"), "{e}");
}

#[test]
fn blocking_call_times_out_on_a_promise_that_never_settles() {
    let d = tempfile::tempdir().unwrap();
    let p = JsPlugin::load(&write(d.path(), "never.ts", SPIN)).unwrap();
    let e = p.call_blocking(&Target::export(""), "never", &[], Mode::Value).unwrap_err();
    assert_eq!(e.name, "TimeoutError");
    assert!(e.message.contains("'never' timed out"), "{}", e.message);
}
