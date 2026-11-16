use super::super::tests::{fixture, span, turn, DAY_NS};
use super::super::{apply_filters, attrs_of, facets, list_traces, run_queries, trace_detail, trace_json, Filters, KnownWorkspaces, Resolver};
use super::*;
use chrono::TimeZone;

fn write_spans(path: &std::path::Path, spans: &[Map<String, Value>]) -> Signatures {
    let body: String = spans.iter().map(|s| format!("{}\n", Value::Object(s.clone()))).collect();
    std::fs::write(path, body).unwrap();
    let m = std::fs::metadata(path).unwrap();
    vec![(path.to_string_lossy().into_owned(), m.len(), mtime_ns(&m), inode(&m))]
}

fn at(ns: f64) -> DateTime<Utc> {
    Utc.timestamp_nanos(ns as i64)
}

#[test]
fn span_window_is_reused_until_the_selection_or_a_file_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().into_owned();
    let path = tmp.path().join("2023-11-14-22.jsonl");
    let base = 1_700_000_000e9;
    let mut spans = turn("0xa", Some("/w/app"), "openai:gpt", "OK", base, 0.5);
    spans.extend(turn("0xb", Some("/w/app"), "openai:gpt", "OK", base + 60e9, 0.25));
    let sigs = write_spans(&path, &spans);
    let cache = SpanWindowCache::default();

    let first = cache.get(&dir, &sigs, at(base - 3600e9), at(base + 120e9));
    assert_eq!(first.spans.len(), 4);
    assert!(first.index.by_trace.contains_key("0xb"));

    // A later window that selects the same spans (a filter change, the
    // trace list, the next poll) reuses the parse.
    let same = cache.get(&dir, &sigs, at(base - 60e9), at(base + 300e9));
    assert!(Arc::ptr_eq(&first, &same));

    // Once the start passes a span, the window drops it.
    let aged = cache.get(&dir, &sigs, at(base + 30e9), at(base + 300e9));
    assert!(!Arc::ptr_eq(&first, &aged));
    assert_eq!(aged.spans.len(), 2);
    assert!(!aged.index.by_trace.contains_key("0xa"));

    // An earlier start would bring the aged-out span back, so no reuse.
    let wider = cache.get(&dir, &sigs, at(base - 60e9), at(base + 300e9));
    assert_eq!(wider.spans.len(), 4);

    // A written span changes the file signature.
    spans.extend(turn("0xc", Some("/w/app"), "openai:gpt", "OK", base + 90e9, 0.125));
    let grown = write_spans(&path, &spans);
    let fresh = cache.get(&dir, &grown, at(base - 60e9), at(base + 300e9));
    assert_eq!(fresh.spans.len(), 6);
    assert!(fresh.index.by_trace.contains_key("0xc"));
}

/// While an agent runs, only the live hour's file changes; the closed
/// hours (a week of them on the telemetry page) must not be re-parsed.
#[test]
fn only_changed_span_files_are_parsed_again() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().into_owned();
    let (closed, live) = (tmp.path().join("2023-11-14-21.jsonl"), tmp.path().join("2023-11-14-22.jsonl"));
    let base = 1_700_000_000e9;
    let mut live_spans = turn("0xb", None, "openai:gpt", "OK", base, 0.25);
    let closed_sig = write_spans(&closed, &turn("0xa", None, "openai:gpt", "OK", base - 1800e9, 0.5));
    let sigs = [closed_sig.clone(), write_spans(&live, &live_spans)].concat();
    let cache = SpanWindowCache::default();
    let (start, end) = (at(base - 7200e9), at(base + 300e9));
    let first = cache.get(&dir, &sigs, start, end);
    assert_eq!(first.spans.len(), 4);

    live_spans.extend(turn("0xc", None, "openai:gpt", "OK", base + 60e9, 0.125));
    let grown = [closed_sig.clone(), write_spans(&live, &live_spans)].concat();
    let next = cache.get(&dir, &grown, start, end);
    assert_eq!(next.spans.len(), 6);
    assert!(next.index.by_trace.contains_key("0xc"));
    let span_of = |w: &SpanWindow, trace: &str| w.spans.iter().find(|s| s.get("trace_id") == Some(&json!(trace))).unwrap().clone();
    assert!(Arc::ptr_eq(&span_of(&first, "0xa"), &span_of(&next, "0xa")), "the closed file was parsed again");
    assert!(!Arc::ptr_eq(&span_of(&first, "0xb"), &span_of(&next, "0xb")), "the live file was not re-read");

    // A file that leaves the window stays parsed, so widening the range
    // again (7d → 90d) parses nothing.
    let live_only = [write_spans(&live, &live_spans)].concat();
    let _ = cache.get(&dir, &live_only, at(base - 60e9), end);
    assert_eq!(cache.0.lock().unwrap().files.len(), 2);
    let wide = cache.get(&dir, &grown, start, end);
    assert!(Arc::ptr_eq(&span_of(&first, "0xa"), &span_of(&wide, "0xa")), "the closed file was parsed again");
}

#[test]
fn files_outside_the_window_are_trimmed_oldest_first_past_the_cap() {
    let parsed = |size| ParsedFile { sig: (size, 0, 0), spans: Arc::new(vec![]) };
    let mut files: HashMap<String, ParsedFile> = ["h1", "h2", "h3", "live"].into_iter().map(|p| (p.to_string(), parsed(10))).collect();
    let window = std::collections::HashSet::from(["live"]);
    trim_outside_window(&mut files, &window, 20);
    let mut kept: Vec<&str> = files.keys().map(String::as_str).collect();
    kept.sort();
    assert_eq!(kept, ["h2", "h3", "live"]);
    trim_outside_window(&mut files, &window, 0);
    assert_eq!(files.keys().collect::<Vec<_>>(), ["live"]);
}

#[test]
fn an_idle_cache_lets_go_of_every_parse() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().into_owned();
    let base = 1_700_000_000e9;
    let sigs = write_spans(&tmp.path().join("2023-11-14-22.jsonl"), &turn("0xa", None, "openai:gpt", "OK", base, 0.5));
    let cache = SpanWindowCache::default();
    assert!(!cache.release_if_idle(std::time::Duration::ZERO), "nothing to release before any use");
    cache.get(&dir, &sigs, at(base - 60e9), at(base + 60e9));
    assert!(!cache.release_if_idle(std::time::Duration::from_secs(300)));
    assert_eq!(cache.0.lock().unwrap().files.len(), 1);
    assert!(cache.release_if_idle(std::time::Duration::ZERO));
    let state = cache.0.lock().unwrap();
    assert!(state.window.is_none() && state.files.is_empty());
}

/// A span line as files hold it: what the queries read, plus what they
/// never do — the resource block older files repeat, events, and
/// attributes such as tool call ids and request fingerprints.
fn as_written(mut s: Map<String, Value>, parent: Option<&str>) -> Map<String, Value> {
    s.insert("parent_id".into(), json!(parent));
    s.insert("kind".into(), json!("INTERNAL"));
    s.insert("events".into(), json!([{"name": "exception", "timestamp": 1, "attributes": {"exception.message": "boom"}}]));
    s.insert("resource".into(), json!({"service.name": "openagentd", "telemetry.sdk.version": "3.0.0"}));
    let attrs = s["attributes"].as_object_mut().unwrap();
    attrs.insert("gen_ai.tool.call.id".into(), json!("call_1"));
    attrs.insert("openagentd.request.system_sha".into(), json!("abc"));
    attrs.insert(TTFT_ATTR.into(), json!(0.25));
    attrs.insert(OUTPUT_TPS_ATTR.into(), json!(40.0));
    attrs.insert("run_id".into(), json!("r1"));
    attrs.insert("gen_ai.agent.name".into(), json!("lead"));
    attrs.insert("empty".into(), Value::Null);
    s
}

/// Summary, trace list and trace detail from the kept-to-what-is-read
/// parse match those from parsing every line whole, as before.
#[test]
fn slim_parse_answers_exactly_like_a_whole_parse() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_string_lossy().into_owned();
    let hour: f64 = 3600e9;
    let base = (1_700_000_000e9_f64 / hour).floor() * hour + 600e9;
    let mut all: Vec<Map<String, Value>> = vec![];
    for (i, s) in fixture().into_iter().enumerate() {
        all.push(as_written(s, if i % 2 == 1 { Some("0xparent") } else { None }));
    }
    // One trace spread over two hours, and a span the writer would not
    // have put in its file (found by the full scan).
    let mut late = span("execute_tool shell", "0xa", "OK", base + hour, json!({"gen_ai.tool.name": "shell", "gen_ai.conversation.id": "s-0xa"}));
    late = as_written(late, Some("0xa-agent_run lead"));
    all.push(late);
    let stray = as_written(span("execute_tool read", "0xa", "OK", base + 30.0 * 60e9, json!({"gen_ai.tool.name": "read"})), None);
    let mut by_file: std::collections::BTreeMap<String, Vec<Map<String, Value>>> = Default::default();
    for s in &all {
        let end = s["end_time"].as_f64().unwrap() as i64;
        by_file.entry(appv3_core::otel::hourly_partition(Utc.timestamp_nanos(end))).or_default().push(s.clone());
    }
    let other_hour = appv3_core::otel::hourly_partition(Utc.timestamp_nanos((base + 5.0 * hour) as i64));
    by_file.entry(other_hour).or_default().push(stray.clone());
    all.push(stray);
    let mut sigs = vec![];
    for (name, spans) in &by_file {
        sigs.extend(write_spans(&tmp.path().join(format!("{name}.jsonl")), spans));
    }
    let (start, end) = (at(base - 400.0 * DAY_NS), at(base + 400.0 * DAY_NS));

    let w = SpanWindowCache::default().get(&dir, &sigs, start, end);
    assert_eq!(w.spans.len(), all.len());
    assert!(w.spans.iter().all(|s| !s.contains_key("events") && !s.contains_key("resource")));
    assert!(w.spans.iter().all(|s| !attrs_of(s).contains_key("gen_ai.tool.call.id")));
    let r = Resolver { index: &w.index, known: &KnownWorkspaces::new() };
    let mut slim = run_queries(&apply_filters(&w.spans, &r, &Filters::default()), &r, start, end);
    slim["facets"] = facets(&w.spans, &r);
    let slim_traces = list_traces(&apply_filters(&w.spans, &r, &Filters::default()), &r, 200, 0, false);

    let index = TurnIndex::build(&all);
    let r = Resolver { index: &index, known: &KnownWorkspaces::new() };
    let mut whole = run_queries(&apply_filters(&all, &r, &Filters::default()), &r, start, end);
    whole["facets"] = facets(&all, &r);
    assert_eq!(slim, whole);
    assert_eq!(slim_traces, list_traces(&apply_filters(&all, &r, &Filters::default()), &r, 200, 0, false));

    for tid in ["0xa", "0xb", "0xe"] {
        let expected = trace_json(all.iter().filter(|s| s["trace_id"] == tid).collect());
        assert_eq!(trace_detail(&w, &sigs, tid), Some(expected), "trace {tid}");
    }
    assert_eq!(trace_detail(&w, &sigs, "0xnope"), None);
}
