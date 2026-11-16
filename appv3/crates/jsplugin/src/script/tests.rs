use super::*;
use std::sync::Mutex;

/// A host that echoes `{name, args}` as JSON, fails `fail`, and waits `args.ms` for `slow`.
fn echo_host() -> HostCallFn {
    Arc::new(|name: String, args: Value| -> HostFuture {
        Box::pin(async move {
            match name.as_str() {
                "fail" => Err("no such file".into()),
                "slow" => {
                    let ms = args.get("ms").and_then(Value::as_u64).unwrap_or(0);
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    Ok(format!("slept {ms}"))
                }
                _ => Ok(json!({"tool": name, "args": args}).to_string()),
            }
        })
    })
}

fn inline(code: &str) -> ScriptSource {
    ScriptSource { code: code.into(), file: None, args: Value::Null }
}

async fn run(code: &str) -> ScriptOutcome {
    run_script(inline(code), ScriptLimits::default(), echo_host()).await
}

#[tokio::test]
async fn tool_calls_round_trip_and_the_return_value_comes_back() {
    let o = run(r#"
const r = JSON.parse(await tools.grep({ pattern: "TODO" }));
console.log("got", r.tool, r.args);
return { n: 2 };
"#)
    .await;
    assert_eq!(o.error, None);
    assert_eq!(o.logs, "got grep {\n  \"pattern\": \"TODO\"\n}");
    assert_eq!(o.value.as_deref(), Some("{\n  \"n\": 2\n}"));
    assert_eq!(o.calls, 1);
}

#[tokio::test]
async fn calls_in_promise_all_run_in_parallel() {
    let t = Instant::now();
    let o = run("const r = await Promise.all([1,2,3,4,5].map(() => tools.slow({ ms: 300 }))); return r.length;").await;
    assert_eq!(o.error, None);
    assert_eq!(o.value.as_deref(), Some("5"));
    assert!(t.elapsed() < Duration::from_millis(1200), "took {:?}", t.elapsed());
}

#[tokio::test]
async fn a_failed_tool_throws_a_catchable_tool_error() {
    let o = run(r#"try { await tools.fail({}); } catch (e) { console.log(e.name, e.tool, e.message); } return "after";"#).await;
    assert_eq!(o.logs, "ToolError fail no such file");
    assert_eq!(o.value.as_deref(), Some("after"));
    let o = run("const a = 1;\nawait tools.fail({});\nreturn a;").await;
    let e = o.error.unwrap();
    assert!(e.starts_with("ToolError at line 2: no such file"), "{e}");
}

#[tokio::test]
async fn the_sandbox_has_no_io_of_its_own() {
    let o = run("return [typeof fetch, typeof require, typeof process, typeof std, typeof os, typeof __s, typeof __n].join(',');").await;
    assert_eq!(o.value.as_deref(), Some("undefined,undefined,undefined,undefined,undefined,undefined,undefined"));
    let o = run(r#"import x from "/etc/hosts"; return 1;"#).await;
    assert!(o.error.unwrap().contains("may import only relative files"));
    let o = run(r#"const m = await import("./x.js"); return 1;"#).await;
    assert!(o.error.unwrap().contains("may import only relative files"));
}

#[tokio::test]
async fn typescript_is_stripped() {
    let o = run("interface Row { n: number }\nconst rows: Row[] = [{ n: 1 }, { n: 2 }];\nreturn rows.reduce((a: number, r: Row) => a + r.n, 0);").await;
    assert_eq!(o.error, None);
    assert_eq!(o.value.as_deref(), Some("3"));
}

#[tokio::test]
async fn syntax_errors_name_the_line_and_column() {
    let o = run("const a = 1;\nconst b = ;\n").await;
    let e = o.error.unwrap();
    assert!(e.starts_with("SyntaxError at line 2, column"), "{e}");
    assert_eq!(o.calls, 0);
    let o = run("export const a = 1;").await;
    assert!(o.error.unwrap().contains("cannot export"));
}

#[tokio::test]
async fn runtime_errors_name_the_line_and_its_text() {
    let o = run("const x = 1;\nconsole.log('before');\nconst y = null;\ny.split(',');\n").await;
    assert_eq!(o.logs, "before");
    let e = o.error.unwrap();
    assert!(e.starts_with("TypeError at line 4:"), "{e}");
    assert!(e.contains("4 | y.split(',');"), "{e}");
}

#[tokio::test]
async fn errors_quickjs_finds_at_compile_time_name_their_line() {
    // oxc does not check regular expressions; QuickJS rejects this one.
    let o = run("const a = 1;\nconst m = 'x'.match(/(?m)^x/);\nreturn m;").await;
    let e = o.error.unwrap();
    assert!(e.starts_with("SyntaxError at line 2, column 24: Invalid regular expression"), "{e}");
}

#[tokio::test]
async fn treating_a_tool_result_as_a_list_gets_a_hint() {
    let o = run("const files = await tools.glob({});\nreturn files.map(f => f);").await;
    let e = o.error.unwrap();
    assert!(e.starts_with("TypeError at line 2: not a function (a tools.* result is a string"), "{e}");
}

#[tokio::test]
async fn busy_javascript_is_interrupted() {
    let limits = ScriptLimits { busy: Duration::from_millis(500), ..Default::default() };
    let o = run_script(inline("console.log('start'); while (true) {}"), limits, echo_host()).await;
    assert_eq!(o.logs, "start");
    assert!(o.error.unwrap().starts_with("TimeoutError"));
}

#[tokio::test]
async fn the_time_limit_returns_what_was_logged() {
    let limits = ScriptLimits { timeout: Duration::from_millis(600), ..Default::default() };
    let o = run_script(inline("console.log('one'); await tools.slow({ ms: 100 }); console.log('two'); await tools.slow({ ms: 5000 }); console.log('three');"), limits, echo_host())
        .await;
    assert!(o.timed_out);
    assert_eq!(o.logs, "one\ntwo");
    assert_eq!(o.calls, 2);
    assert!(o.error.unwrap().contains("time limit"));
    // A script that never settles is stopped by the limit too.
    let limits = ScriptLimits { timeout: Duration::from_millis(300), ..Default::default() };
    let o = run_script(inline("await new Promise(() => {});"), limits, echo_host()).await;
    assert!(o.timed_out);
}

#[tokio::test]
async fn sleep_waits_without_counting_as_a_call() {
    let t = Instant::now();
    let o = run("await sleep(200); return 'ok';").await;
    assert_eq!(o.value.as_deref(), Some("ok"));
    assert_eq!(o.calls, 0);
    assert!(t.elapsed() >= Duration::from_millis(200));
}

#[tokio::test]
async fn calls_past_the_limit_throw() {
    let limits = ScriptLimits { max_calls: 3, ..Default::default() };
    let o = run_script(inline("let ok = 0; try { for (;;) { await tools.read({}); ok++; } } catch (e) { console.log(e.message); } return ok;"), limits, echo_host()).await;
    assert_eq!(o.value.as_deref(), Some("3"));
    assert!(o.logs.contains("at most 3"), "{}", o.logs);
}

#[tokio::test]
async fn output_is_cut_at_the_limit() {
    let limits = ScriptLimits { max_output: 10, ..Default::default() };
    let o = run_script(inline("console.log('123456'); console.log('abcdef'); console.log('zzz'); return 'v';"), limits, echo_host()).await;
    assert!(o.truncated);
    assert_eq!(o.logs, "123456\nabcd");
    assert_eq!(o.value.as_deref(), Some(""));
}

#[tokio::test]
async fn args_reach_the_script() {
    let src = ScriptSource { code: "return args.pattern ?? 'TODO';".into(), file: None, args: json!({"pattern": "FIXME"}) };
    let o = run_script(src, ScriptLimits::default(), echo_host()).await;
    assert_eq!(o.value.as_deref(), Some("FIXME"));
    let o = run("return args === null ? 'none' : 'some';").await;
    assert_eq!(o.value.as_deref(), Some("none"));
}

#[tokio::test]
async fn a_file_script_imports_from_its_own_folder_only() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("scripts");
    std::fs::create_dir_all(dir.join("lib")).unwrap();
    std::fs::write(dir.join("lib/count.ts"), "export const count = (s: string): number => s.split('\\n').filter(Boolean).length;").unwrap();
    std::fs::write(d.path().join("outside.js"), "export const x = 1;").unwrap();
    let main = dir.join("main.ts");
    let code = "// @description demo\nimport { count } from './lib/count';\nreturn count(await tools.grep({}) + '\\nb');";
    std::fs::write(&main, code).unwrap();
    let o = run_script(ScriptSource { code: code.into(), file: Some(main.clone()), args: Value::Null }, ScriptLimits::default(), echo_host()).await;
    assert_eq!(o.error, None);
    assert_eq!(o.value.as_deref(), Some("2"));
    let code = "import { x } from '../outside.js';\nreturn x;";
    let o = run_script(ScriptSource { code: code.into(), file: Some(main), args: Value::Null }, ScriptLimits::default(), echo_host()).await;
    let e = o.error.unwrap();
    assert_eq!(e, "ImportError: cannot import ../outside.js: it is outside the script's own folder");
}

#[tokio::test]
async fn dropping_the_run_stops_the_script() {
    let calls = Arc::new(Mutex::new(0));
    let c = calls.clone();
    let host: HostCallFn = Arc::new(move |_n: String, _a: Value| -> HostFuture {
        *c.lock().unwrap() += 1;
        Box::pin(async { Ok(String::new()) })
    });
    let fut = run_script(inline("for (;;) { await tools.tick({}); await sleep(20); }"), ScriptLimits::default(), host);
    let _ = tokio::time::timeout(Duration::from_millis(300), fut).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let after_stop = *calls.lock().unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(*calls.lock().unwrap(), after_stop, "the script kept calling after it was dropped");
    assert!(after_stop > 0);
    // A busy script is stopped too, and the process survives it.
    let fut = run_script(inline("for (;;) {}"), ScriptLimits::default(), echo_host());
    let _ = tokio::time::timeout(Duration::from_millis(200), fut).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
}
