//! Seeds the "reopen after a long plan-mode run" database used by
//! `scripts/perf/reopen.py`. Run once (any tree; the schema is unchanged
//! since `fad35386`). `scripts/perf/run-all.sh` copies this file into
//! `appv3/crates/agent/tests/` and runs it as an ignored test.
//!
//! Shape: one user prompt, then 1,100 lead rows of assistant tool calls and
//! 4 KB tool results with usage (so the newest ~11 pages hold no prompt),
//! plus 4 member sessions of 300 rows each.

use appv3_db::queries::*;
use serde_json::json;

#[test]
#[ignore]
fn seed_reopen_db() {
    let db = std::env::var("OAD_SEED_DB").expect("OAD_SEED_DB");
    let ws = std::env::var("OAD_SEED_WS").expect("OAD_SEED_WS");
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let pool = appv3_db::create_pool(&db).await.unwrap();
        let lead = create_session(&pool, NewSession { workspace: ws.clone(), title: Some("Plan the refactor".into()), interaction_mode: Some("plan".into()), ..Default::default() }).await.unwrap();
        save_message(&pool, &lead.id, NewMessage::user("Plan a refactor of the billing module, then implement it.")).await.unwrap();
        let usage = |i: i64| {
            let mut m = serde_json::Map::new();
            m.insert("usage".into(), json!({"input": 20_000 + i, "output": 400, "cache_read": 15_000}));
            m
        };
        async fn pairs(pool: &appv3_db::DbPool, sid: &str, n: usize, usage: &dyn Fn(i64) -> serde_json::Map<String, serde_json::Value>) {
            for i in 0..n {
                let tc = json!([{"id": format!("c{i}"), "type": "function", "function": {"name": "read", "arguments": "{\"path\":\"src/billing/mod.rs\"}"}}]);
                save_message(pool, sid, NewMessage { tool_calls: Some(tc), extra: Some(usage(i as i64)), ..NewMessage::assistant(Some(format!("Step {i}: checking how invoices are rounded."))) }).await.unwrap();
                save_message(pool, sid, NewMessage::tool(format!("c{i}"), "read", format!("{i}: {}", "fn round_invoice(x: f64) -> f64 { x } // ".repeat(100)))).await.unwrap();
            }
        }
        pairs(&pool, &lead.id, 550, &usage).await;
        for m in 1..=4 {
            let member = create_session(&pool, NewSession { workspace: ws.clone(), parent_session_id: Some(lead.id.clone()), agent_name: Some(format!("explorer#{m}")), ..Default::default() }).await.unwrap();
            save_message(&pool, &member.id, NewMessage::user("[Task from Lead]: map the billing call graph")).await.unwrap();
            pairs(&pool, &member.id, 150, &usage).await;
        }
        println!("SEEDED lead={}", appv3_db::codec::api_uuid(&lead.id));
    });
}
