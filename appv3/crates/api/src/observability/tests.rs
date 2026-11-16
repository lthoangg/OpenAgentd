use super::*;

#[test]
fn quantiles_and_percent() {
    assert_eq!(quantile(&[], 0.5), 0.0);
    assert_eq!(quantile(&[3.0], 0.95), 3.0);
    assert!((quantile(&[1.0, 2.0, 3.0, 4.0], 0.95) - 3.85).abs() < 1e-9);
    assert_eq!(percent(1.0, 3.0), 33.3);
    assert_eq!(percent(1.0, 0.0), 0.0);
}

#[test]
fn py_str_forms() {
    assert_eq!(py_str(&json!(1.0)), "1.0");
    assert_eq!(py_str(&json!(true)), "True");
    assert_eq!(py_str(&json!(["a", 1])), "['a', 1]");
    assert_eq!(safe_int(Some(&json!(2.9))), 2);
    assert_eq!(safe_int(Some(&json!("7"))), 7);
    assert_eq!(safe_int(Some(&json!("7.5"))), 0);
}

const DAY_NS: f64 = 86_400e9;

fn span(name: &str, trace: &str, status: &str, end_ns: f64, attrs: Value) -> Map<String, Value> {
    let Value::Object(m) = json!({
        "name": name, "trace_id": trace, "span_id": format!("{trace}-{name}"), "status": status,
        "start_time": end_ns - 1e9, "end_time": end_ns, "duration_ms": 1000.0, "attributes": attrs,
    }) else {
        unreachable!()
    };
    m
}

fn turn(trace: &str, workspace: Option<&str>, model: &str, status: &str, end_ns: f64, cost: f64) -> Vec<Map<String, Value>> {
    let (provider, model) = model.split_once(':').unwrap();
    let mut run_attrs = json!({"gen_ai.provider.name": provider, "gen_ai.request.model": model, "gen_ai.conversation.id": format!("s-{trace}")});
    if let Some(ws) = workspace {
        run_attrs[WORKSPACE_ATTR] = json!(ws);
    }
    vec![
        span("agent_run lead", trace, status, end_ns, run_attrs),
        span(
            "chat m",
            trace,
            "OK",
            end_ns,
            json!({"gen_ai.provider.name": provider, "gen_ai.request.model": model, "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10, "gen_ai.usage.estimated_cost_usd": cost, "gen_ai.conversation.id": format!("s-{trace}")}),
        ),
    ]
}

fn fixture() -> Vec<Map<String, Value>> {
    let base = 1_700_000_000e9;
    let mut spans = vec![];
    spans.extend(turn("0xa", Some("/w/app"), "openai:gpt", "OK", base, 0.5));
    spans.extend(turn("0xb", Some("/w/app"), "anthropic:claude", "ERROR", base + DAY_NS, 1.25));
    spans.extend(turn("0xc", Some("/w/site"), "openai:gpt", "OK", base + DAY_NS, 0.25));
    // Recorded before workspaces were written on spans.
    spans.extend(turn("0xd", None, "openai:gpt", "OK", base, 0.125));
    // Title generation outside any run, attributed through its session.
    spans.push(span("title_generation", "0xe", "OK", base, json!({"gen_ai.conversation.id": "s-0xc", "gen_ai.usage.estimated_cost_usd": 0.01})));
    spans
}

fn summary_for(spans: &[Map<String, Value>], f: &Filters) -> Value {
    summary_with(spans, f, &KnownWorkspaces::new())
}

fn summary_with(spans: &[Map<String, Value>], f: &Filters, known: &KnownWorkspaces) -> Value {
    let index = TurnIndex::build(spans);
    let r = Resolver { index: &index, known };
    let now = Utc::now();
    run_queries(&apply_filters(spans, &r, f), &r, now, now)
}

fn workspace_row<'a>(v: &'a Value, ws: Option<&str>) -> Option<&'a Value> {
    v["by_workspace"].as_array().unwrap().iter().find(|w| w["workspace"].as_str() == ws)
}

fn cost(v: &Value) -> f64 {
    v["estimated_cost_usd"].as_f64().unwrap()
}

/// `/compact` and idle compaction wrote no `agent_run` span before
/// v3.21, and their LLM-call span names no session: only its parent
/// `summarization` span in the same trace does.
#[test]
fn compaction_spend_without_a_run_span_is_attributed_through_its_trace() {
    let mut spans = fixture();
    let base = 1_700_000_000e9;
    spans.push(span("summarization", "0xs", "OK", base, json!({"gen_ai.conversation.id": "s-0xc", "gen_ai.agent.name": "lead"})));
    spans.push(span(
        "summarization_llm_call",
        "0xs",
        "OK",
        base,
        json!({"gen_ai.operation.name": "summarization", "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.estimated_cost_usd": 0.5}),
    ));
    let v = summary_for(&spans, &Filters::default());
    assert!((cost(workspace_row(&v, Some("/w/site")).unwrap()) - 0.76).abs() < 1e-9, "{}", v["by_workspace"]);
    // Only the pre-tracking turn stays unrecorded.
    assert!((cost(workspace_row(&v, None).unwrap()) - 0.125).abs() < 1e-9, "{}", v["by_workspace"]);

    let site = summary_for(&spans, &Filters { workspace: Some("/w/site".into()), ..Default::default() });
    assert!((site["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.76).abs() < 1e-9);
    let session = summary_for(&spans, &Filters { sessions: Some(BTreeSet::from(["s-0xc".to_string()])), ..Default::default() });
    assert!((session["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.76).abs() < 1e-9);
}

/// A running turn has no `agent_run` span yet; its chat spans carry
/// the workspace themselves.
#[test]
fn spans_of_a_turn_still_running_use_their_own_workspace() {
    let mut spans = fixture();
    let base = 1_700_000_000e9;
    spans.push(span(
        "chat m",
        "0xp",
        "OK",
        base,
        json!({"gen_ai.conversation.id": "s-new", WORKSPACE_ATTR: "/w/app", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.estimated_cost_usd": 0.3}),
    ));
    let v = summary_for(&spans, &Filters::default());
    assert!((cost(workspace_row(&v, Some("/w/app")).unwrap()) - 2.05).abs() < 1e-9, "{}", v["by_workspace"]);
    let app = summary_for(&spans, &Filters { workspace: Some("/w/app".into()), ..Default::default() });
    assert_eq!(app["totals"]["turns"], 2);
    assert!((app["totals"]["estimated_cost_usd"].as_f64().unwrap() - 2.05).abs() < 1e-9);
}

/// Turns recorded before spans carried a workspace take their
/// session's workspace from the database.
#[test]
fn turns_before_workspace_tracking_use_the_session_workspace_on_record() {
    let spans = fixture();
    let known = KnownWorkspaces::from([("s-0xd".to_string(), "/w/old".to_string())]);
    let v = summary_with(&spans, &Filters::default(), &known);
    let old = workspace_row(&v, Some("/w/old")).unwrap_or_else(|| panic!("{}", v["by_workspace"]));
    assert_eq!(old["turns"], 1);
    assert!((cost(old) - 0.125).abs() < 1e-9);
    assert!(workspace_row(&v, None).is_none(), "{}", v["by_workspace"]);

    let index = TurnIndex::build(&spans);
    let r = Resolver { index: &index, known: &known };
    assert!(facets(&spans, &r)["workspaces"].as_array().unwrap().contains(&json!("/w/old")));
    let old_only = Filters { workspace: Some("/w/old".into()), ..Default::default() };
    let (items, total) = list_traces(&apply_filters(&spans, &r, &old_only), &r, 50, 0, false);
    assert_eq!(total, 1);
    assert_eq!(items[0]["trace_id"], "0xd");
    assert_eq!(items[0]["workspace"], "/w/old");
}

#[test]
fn session_workspaces_on_record_match_either_id_form() {
    let spans = vec![span(
        "agent_run lead",
        "0x1",
        "OK",
        1_700_000_000e9,
        json!({"gen_ai.conversation.id": "0190a1b2-0000-7000-8000-000000000000", "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt"}),
    )];
    // Stored (hex) id; the span holds the hyphenated form.
    let known = KnownWorkspaces::from([("0190a1b2000070008000000000000000".to_string(), "/w/old".to_string())]);
    let v = summary_with(&spans, &Filters::default(), &known);
    assert_eq!(v["by_workspace"][0]["workspace"], "/w/old");
}

#[test]
fn workspace_filter_keeps_whole_turns_and_session_spans() {
    let spans = fixture();
    let v = summary_for(&spans, &Filters { workspace: Some("/w/site".into()), ..Default::default() });
    assert_eq!(v["totals"]["turns"], 1);
    assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.26).abs() < 1e-9);
    assert_eq!(v["by_workspace"][0]["workspace"], "/w/site");
}

#[test]
fn model_filter_matches_the_turn_model() {
    let spans = fixture();
    let v = summary_for(&spans, &Filters { model: Some("openai:gpt".into()), ..Default::default() });
    assert_eq!(v["totals"]["turns"], 3);
    assert_eq!(v["by_model"].as_array().unwrap().len(), 1);
    assert_eq!(v["totals"]["errors"], 0);
}

#[test]
fn model_filter_keeps_spans_outside_a_turn_by_their_own_model() {
    let mut spans = fixture();
    let base = 1_700_000_000e9;
    spans.push(span(
            "title_generation",
            "0xg",
            "OK",
            base,
            json!({"gen_ai.conversation.id": "s-0xa", "gen_ai.provider.name": "openai", "gen_ai.request.model": "mini", "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 5, "gen_ai.usage.estimated_cost_usd": 0.02}),
        ));
    let v = summary_for(&spans, &Filters { model: Some("openai:mini".into()), ..Default::default() });
    assert_eq!(v["totals"]["turns"], 0);
    assert_eq!(v["by_model"][0]["provider_model"], "openai:mini");
    assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.02).abs() < 1e-9);

    // Inside a turn the turn's model still decides, and a span with no
    // recorded model stays out of every real model filter.
    let v = summary_for(&spans, &Filters { model: Some("openai:gpt".into()), ..Default::default() });
    assert_eq!(v["totals"]["turns"], 3);
    assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.875).abs() < 1e-9);
}

#[test]
fn breakdowns_carry_daily_cost_and_unrecorded_workspaces() {
    let spans = fixture();
    let v = summary_for(&spans, &Filters::default());
    let days = v["daily_turns"].as_array().unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(days[1]["turns"], 2);
    assert!((days[1]["estimated_cost_usd"].as_f64().unwrap() - 1.5).abs() < 1e-9);
    let unrecorded = v["by_workspace"].as_array().unwrap().iter().find(|w| w["workspace"].is_null()).unwrap();
    assert_eq!(unrecorded["turns"], 1);
    assert_eq!(v["by_workspace"][0]["workspace"], "/w/app");
}

#[test]
fn facets_rank_the_whole_window() {
    let spans = fixture();
    let index = TurnIndex::build(&spans);
    let v = facets(&spans, &Resolver { index: &index, known: &KnownWorkspaces::new() });
    assert_eq!(v["workspaces"], json!(["/w/app", "/w/site"]));
    assert_eq!(v["models"], json!(["openai:gpt", "anthropic:claude"]));
}

#[test]
fn summary_reports_time_to_first_chunk_and_output_speed() {
    let base = 1_700_000_000e9;
    let chat = |trace: &str, model: &str, timing: Option<(f64, f64)>| {
        let (provider, model) = model.split_once(':').unwrap();
        let mut attrs = json!({"gen_ai.provider.name": provider, "gen_ai.request.model": model, "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10});
        if let Some((ttft_s, tps)) = timing {
            attrs[TTFT_ATTR] = json!(ttft_s);
            attrs[OUTPUT_TPS_ATTR] = json!(tps);
        }
        span("chat m", trace, "OK", base, attrs)
    };
    let spans = vec![
        chat("0x1", "openai:gpt", Some((0.5, 40.0))),
        chat("0x2", "openai:gpt", Some((1.5, 60.0))),
        // Recorded before timing was: counts as a call, not as a sample.
        chat("0x3", "openai:gpt", None),
        chat("0x4", "anthropic:claude", Some((2.0, 100.0))),
    ];
    let v = summary_for(&spans, &Filters::default());
    assert_eq!(v["latency_ms"]["ttft_p50"], 1500.0);
    assert_eq!(v["latency_ms"]["ttft_p95"], 1950.0);
    assert_eq!(v["output_tps"]["p50"], 60.0);
    assert_eq!(v["output_tps"]["p5"], 42.0);
    let gpt = v["by_model"].as_array().unwrap().iter().find(|m| m["provider_model"] == "openai:gpt").unwrap();
    assert_eq!(gpt["calls"], 3);
    assert_eq!(gpt["ttft_p50_ms"], 1000.0);
    assert_eq!(gpt["output_tps_p50"], 50.0);

    let v = summary_for(&fixture(), &Filters::default());
    assert_eq!(v["latency_ms"]["ttft_p50"], 0.0);
    assert_eq!(v["by_model"][0]["output_tps_p50"], 0.0);
}

#[test]
fn trace_list_filters_failed_turns_and_reports_workspace() {
    let spans = fixture();
    let turns = TurnIndex::build(&spans);
    let index = Resolver { index: &turns, known: &KnownWorkspaces::new() };
    let all: Vec<&Map<String, Value>> = spans.iter().collect();
    let (items, total) = list_traces(&all, &index, 50, 0, true);
    assert_eq!(total, 1);
    assert_eq!(items[0]["trace_id"], "0xb");
    assert_eq!(items[0]["workspace"], "/w/app");
    assert_eq!(items[0]["error"], true);

    let (items, _) = list_traces(&apply_filters(&spans, &index, &Filters { workspace: Some("/w/app".into()), ..Default::default() }), &index, 50, 0, false);
    assert_eq!(items.len(), 2);
}

#[test]
fn session_filter_keeps_the_session_turns_and_its_title_span() {
    let spans = fixture();
    let v = summary_for(&spans, &Filters { sessions: Some(BTreeSet::from(["s-0xc".to_string()])), ..Default::default() });
    assert_eq!(v["totals"]["turns"], 1);
    assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 0.26).abs() < 1e-9);

    let turns = TurnIndex::build(&spans);
    let index = Resolver { index: &turns, known: &KnownWorkspaces::new() };
    let f = Filters { sessions: Some(BTreeSet::from(["s-0xb".to_string()])), ..Default::default() };
    let (items, total) = list_traces(&apply_filters(&spans, &index, &f), &index, 50, 0, false);
    assert_eq!(total, 1);
    assert_eq!(items[0]["session_id"], "s-0xb");
}

#[test]
fn session_filter_keeps_every_session_in_the_set() {
    let spans = fixture();
    let family = Filters { sessions: Some(BTreeSet::from(["s-0xa".to_string(), "s-0xb".to_string()])), ..Default::default() };
    let v = summary_for(&spans, &family);
    assert_eq!(v["totals"]["turns"], 2);
    assert!((v["totals"]["estimated_cost_usd"].as_f64().unwrap() - 1.75).abs() < 1e-9);
    let ids: Vec<&str> = v["by_session"].as_array().unwrap().iter().map(|s| s["session_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["s-0xb", "s-0xa"]);
    // The whole set is part of the cache key.
    let lead_only = Filters { sessions: Some(BTreeSet::from(["s-0xa".to_string()])), ..Default::default() };
    assert_ne!(family.key_parts(), lead_only.key_parts());
}

#[test]
fn by_session_ranks_by_spend_and_skips_runs_outside_sessions() {
    let mut spans = fixture();
    let base = 1_700_000_000e9;
    spans.push(span("agent_run lead", "0xf", "OK", base, json!({"gen_ai.conversation.id": "no-session", "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt"})));
    spans.push(span(
        "chat m",
        "0xf",
        "OK",
        base,
        json!({"gen_ai.usage.input_tokens": 400, "gen_ai.usage.cache_read.input_tokens": 100, "gen_ai.usage.estimated_cost_usd": 9.0, "gen_ai.conversation.id": "no-session"}),
    ));
    let v = summary_for(&spans, &Filters::default());
    let sessions = v["by_session"].as_array().unwrap();
    let ids: Vec<&str> = sessions.iter().map(|s| s["session_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["s-0xb", "s-0xa", "s-0xc", "s-0xd"]);
    let top = &sessions[0];
    assert_eq!(top["turns"], 1);
    assert_eq!(top["errors"], 1);
    assert_eq!(top["workspace"], "/w/app");
    assert_eq!(top["model"], "anthropic:claude");
    assert_eq!(top["input_tokens"], 100);
    assert_eq!(top["last_active_ms"], ns_to_ms(&json!(base + DAY_NS)));
    // The title span counts toward its session.
    assert!((sessions[2]["estimated_cost_usd"].as_f64().unwrap() - 0.26).abs() < 1e-9);
}

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
