//! `agentd run` against the real binary, with a stand-in model provider on a
//! local port. Nothing here touches real user data or the network.

mod common;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A run that has not ended by now is waiting on something nobody will give it.
const LIMIT: Duration = Duration::from_secs(60);

fn http(status: &str, headers: &str, body: &str) -> String {
    format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

fn stream(deltas: &[(Value, Value)]) -> String {
    let mut sse = String::new();
    for (delta, finish) in deltas {
        let chunk = json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "mock-1", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]});
        sse += &format!("data: {chunk}\n\n");
    }
    http("200 OK", "Content-Type: text/event-stream\r\n", &(sse + "data: [DONE]\n\n"))
}

/// The model answers with `text`.
fn says(text: &str) -> String {
    stream(&[(json!({"role": "assistant", "content": text}), Value::Null), (json!({}), json!("stop"))])
}

/// The model calls one tool.
fn calls(tool: &str, arguments: Value) -> String {
    let call = json!({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": tool, "arguments": arguments.to_string()}}]});
    stream(&[(call, Value::Null), (json!({}), json!("tool_calls"))])
}

/// An OpenAI-compatible endpoint. `chat(n)` is the whole HTTP response to
/// chat request `n` (from 0), and `GET /models` lists `mock-1`. Returns its
/// base URL and the body of every chat request.
fn provider(chat: impl Fn(usize) -> String + Send + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
    let bodies = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = bodies.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let (mut request_line, mut line, mut len) = (String::new(), String::new(), 0usize);
            let _ = reader.read_line(&mut request_line);
            while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                line.clear();
            }
            let mut body = vec![0; len];
            let _ = reader.read_exact(&mut body);
            let response = if request_line.contains("/chat/completions") {
                let n = {
                    let mut all = seen.lock().unwrap();
                    all.push(String::from_utf8_lossy(&body).into_owned());
                    all.len() - 1
                };
                chat(n)
            } else if request_line.contains("/models") {
                http("200 OK", "Content-Type: application/json\r\n", r#"{"object":"list","data":[{"id":"mock-1","object":"model"}]}"#)
            } else {
                http("404 Not Found", "", "")
            };
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (base, bodies)
}

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

/// `agentd run <args>` in throw-away roots under `root`, with the `ollama`
/// provider at `base`. `listed` is whether the install already lists
/// `mock-1`, as it does once the app has shown the provider's models.
fn agentd_run(root: &Path, base: &str, listed: bool, args: &[&str]) -> Ran {
    let models = if listed { "providers:\n  ollama:\n    cached_models:\n    - mock-1\n" } else { "" };
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config/settings.yaml"), format!("title_generation:\n  enabled: false\n{models}")).unwrap();
    let workspace = root.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();
    let (out, err) = (root.join("stdout"), root.join("stderr"));
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentd"));
    cmd.arg("run").args(args).current_dir(&workspace).stdin(Stdio::null());
    cmd.stdout(std::fs::File::create(&out).unwrap()).stderr(std::fs::File::create(&err).unwrap());
    common::sandbox(&mut cmd, root);
    cmd.env("OLLAMA_BASE_URL", base);
    let mut child = cmd.spawn().expect("spawn agentd");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            panic!("agentd run was still running after {LIMIT:?}\nstdout: {}", std::fs::read_to_string(&out).unwrap_or_default());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    Ran { code: status.code().unwrap_or(-1), stdout: std::fs::read_to_string(&out).unwrap(), stderr: std::fs::read_to_string(&err).unwrap() }
}

#[test]
fn a_run_prints_the_models_reply() {
    let root = tempfile::tempdir().unwrap();
    let (base, bodies) = provider(|_| says("Hello from the model."));
    let ran = agentd_run(root.path(), &base, true, &["--model", "ollama:mock-1", "hi"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(ran.stdout.contains("Hello from the model."), "{}", ran.stdout);
    assert_eq!(bodies.lock().unwrap().len(), 1);
}

/// A usage limit that resets in hours: the run says so and ends, instead of
/// sleeping until the reset with nothing on screen.
#[test]
fn a_run_ends_with_an_error_when_the_usage_limit_resets_hours_later() {
    let root = tempfile::tempdir().unwrap();
    let limited = || http("429 Too Many Requests", "Content-Type: application/json\r\nRetry-After: 7200\r\n", r#"{"error":{"message":"Too many requests."}}"#);
    let (base, bodies) = provider(move |_| limited());
    let ran = agentd_run(root.path(), &base, true, &["--model", "ollama:mock-1", "--json", "hi"]);
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert!(ran.stderr.contains("usage limit") && ran.stderr.contains("2h 00m"), "{}", ran.stderr);
    assert!(ran.stdout.contains(r#""status":"waiting_quota""#), "the JSON log keeps the provider's status\n{}", ran.stdout);
    assert_eq!(bodies.lock().unwrap().len(), 1, "it did not ask again");
}

/// Nobody can answer a question in a one-shot run: the agent is told so and
/// goes on, and the run does not end with an error.
#[test]
fn a_question_is_refused_and_the_run_goes_on() {
    let root = tempfile::tempdir().unwrap();
    let (base, bodies) = provider(|n| match n {
        0 => calls("ask_user", json!({"questions": [{"question": "Which colour?"}]})),
        _ => says("Picked blue."),
    });
    let ran = agentd_run(root.path(), &base, true, &["--model", "ollama:mock-1", "paint it"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(ran.stdout.contains("Picked blue."), "{}", ran.stdout);
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert!(bodies[1].contains("nobody is there to answer"), "the agent was not told why\n{}", bodies[1]);
}

/// An install that has only used the CLI has no model list yet (the app's
/// routes are what fetch one), so `--model` asks the provider.
#[test]
fn a_model_the_install_has_not_listed_yet_is_looked_up() {
    let root = tempfile::tempdir().unwrap();
    let (base, _) = provider(|_| says("Hello from the model."));
    let ran = agentd_run(root.path(), &base, false, &["--model", "ollama:mock-1", "hi"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(ran.stdout.contains("Hello from the model."), "{}", ran.stdout);

    let ran = agentd_run(root.path(), &base, false, &["--model", "ollama:no-such-model", "hi"]);
    assert_eq!(ran.code, 1);
    assert!(ran.stderr.contains("unknown model"), "{}", ran.stderr);
}
