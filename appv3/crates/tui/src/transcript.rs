//! Turns session-stream events and history rows into transcript cells.
//!
//! Finished cells go to the terminal scrollback and never change. The open
//! parts of a turn (text still streaming, running tools) stay in `Turn` and
//! are drawn in the live area until they finish.

use serde_json::Value;
use std::collections::HashSet;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    User(String),
    /// A sub-agent's deliverable, delivered to the lead as a user message.
    AgentResult {
        from: String,
        text: String,
    },
    /// A chunk of assistant markdown. `first` marks the start of a reply.
    Text {
        markdown: String,
        first: bool,
    },
    Thinking(String),
    Tool {
        name: String,
        args: String,
        result: Option<String>,
    },
    Info(String),
    Error {
        title: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
    pub recommended: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestionItem {
    pub question: String,
    pub header: String,
    pub multiple: bool,
    pub custom: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub id: String,
    pub items: Vec<QuestionItem>,
    pub plan_review: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LiveTool {
    pub id: String,
    pub name: String,
    pub args: String,
    pub output: String,
}

/// What the app must do after an event, beyond the transcript.
#[derive(Debug, PartialEq)]
pub enum Effect {
    None,
    /// A contract event this client deliberately does not use.
    Ignored,
    /// Not in this client's event list (the contract test fails on this).
    Unknown,
    Session(String),
    QueuedStarted(Vec<String>),
    Subagent(Value),
    Question(Question),
    QuestionClosed(String),
    Done,
}

/// Session-stream events this client drops, with the reason.
pub const IGNORED_EVENTS: &[(&str, &str)] =
    &[("rate_limit", "a provider_status \"retrying\" event follows with the same data"), ("permission_asked", "tools are auto-allowed; the event is only an announcement")];

/// Append-only text with a commit offset: `all[..done]` is in scrollback.
#[derive(Default, Debug)]
struct Buf {
    all: String,
    done: usize,
}

impl Buf {
    fn pending(&self) -> &str {
        &self.all[self.done..]
    }

    /// Take the pending part up to the last paragraph break outside a code
    /// fence (or all of it), so a committed chunk renders the same as it
    /// would inside the full text.
    fn take(&mut self, all: bool) -> Option<String> {
        let p = self.pending();
        let n = if all { p.len() } else { safe_split(p) };
        if n == 0 {
            return None;
        }
        let chunk = p[..n].to_string();
        self.done += n;
        (!chunk.trim().is_empty()).then_some(chunk)
    }

    /// Replay after (re)attach: the server sends the whole turn's text so far.
    fn replace(&mut self, text: &str) {
        self.all = text.to_string();
        if self.done > self.all.len() || !self.all.is_char_boundary(self.done) {
            self.done = self.all.len();
        }
    }
}

/// Byte offset just after the last blank line that is outside a code fence.
fn safe_split(s: &str) -> usize {
    let mut in_fence = false;
    let mut cut = 0;
    let mut pos = 0;
    for line in s.split_inclusive('\n') {
        pos += line.len();
        if !line.ends_with('\n') {
            break;
        }
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
        } else if !in_fence && t.trim().is_empty() {
            cut = pos;
        }
    }
    cut
}

#[derive(Default)]
pub struct Turn {
    pub working: bool,
    pub started: Option<Instant>,
    pub tools: Vec<LiveTool>,
    /// Provider retry/quota notice, cleared by the next model output.
    pub notice: Option<String>,
    pub compacting: bool,
    pub output_tokens: i64,
    pub mode: Option<String>,
    text: Buf,
    thinking: Buf,
    reply_started: bool,
    finished_tools: HashSet<String>,
    replay_text: bool,
    replay_thinking: bool,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

impl Turn {
    /// A new stream connection replays the turn's accumulated text first.
    pub fn on_attach(&mut self) {
        self.replay_text = true;
        self.replay_thinking = true;
    }

    pub fn pending_text(&self) -> &str {
        self.text.pending()
    }

    pub fn pending_thinking(&self) -> &str {
        self.thinking.pending()
    }

    fn flush_thinking(&mut self, out: &mut Vec<Cell>) {
        if let Some(t) = self.thinking.take(true) {
            out.push(Cell::Thinking(t.trim().to_string()));
        }
    }

    fn flush_text(&mut self, out: &mut Vec<Cell>, all: bool) {
        if let Some(t) = self.text.take(all) {
            out.push(Cell::Text { markdown: t, first: !self.reply_started });
            self.reply_started = true;
        }
    }

    fn flush_all(&mut self, out: &mut Vec<Cell>) {
        self.flush_thinking(out);
        self.flush_text(out, true);
    }

    fn mark_working(&mut self) {
        self.working = true;
        self.started.get_or_insert_with(Instant::now);
    }

    fn tool(&mut self, data: &Value) -> Option<&mut LiveTool> {
        let id = s(data, "tool_call_id");
        if self.finished_tools.contains(&id) {
            return None;
        }
        if let Some(i) = self.tools.iter().position(|t| t.id == id) {
            return self.tools.get_mut(i);
        }
        self.tools.push(LiveTool { id, name: s(data, "name"), args: String::new(), output: String::new() });
        self.tools.last_mut()
    }

    pub fn apply(&mut self, event: &str, data: &Value, out: &mut Vec<Cell>) -> Effect {
        match event {
            "session" => return Effect::Session(s(data, "session_id")),
            "agent_status" => match s(data, "status").as_str() {
                "working" => self.mark_working(),
                "waiting_input" => self.notice = Some("Waiting for your answer".into()),
                _ => {}
            },
            "thinking" => {
                self.mark_working();
                self.notice = None;
                self.flush_text(out, true);
                let t = s(data, "text");
                if std::mem::take(&mut self.replay_thinking) {
                    self.thinking.replace(&t);
                } else {
                    self.thinking.all.push_str(&t);
                }
            }
            "message" => {
                self.mark_working();
                self.notice = None;
                self.flush_thinking(out);
                let t = s(data, "text");
                if std::mem::take(&mut self.replay_text) {
                    self.text.replace(&t);
                } else {
                    self.text.all.push_str(&t);
                }
                self.flush_text(out, false);
            }
            "tool_call" => {
                self.mark_working();
                self.notice = None;
                self.flush_all(out);
                self.reply_started = false;
                self.tool(data);
            }
            "tool_start" => {
                let args = s(data, "arguments");
                if let Some(t) = self.tool(data) {
                    t.args = args;
                }
            }
            "tool_output_delta" => {
                let text = s(data, "text");
                if let Some(t) = self.tool(data) {
                    t.output.push_str(&text);
                    // Only the tail is drawn; keep memory bounded.
                    if t.output.len() > 64 * 1024 {
                        let cut = t.output.len() - 32 * 1024;
                        let cut = (cut..t.output.len()).find(|&i| t.output.is_char_boundary(i)).unwrap_or(t.output.len());
                        t.output.drain(..cut);
                    }
                }
            }
            "tool_end" => {
                let id = s(data, "tool_call_id");
                if self.finished_tools.contains(&id) {
                    return Effect::None;
                }
                let result = data.get("result").and_then(Value::as_str).map(String::from);
                let (name, args) = match self.tools.iter().position(|t| t.id == id) {
                    Some(i) => {
                        let t = self.tools.remove(i);
                        (t.name, t.args)
                    }
                    None => (s(data, "name"), String::new()),
                };
                self.flush_all(out);
                out.push(Cell::Tool { name, args, result });
                self.finished_tools.insert(id);
            }
            "usage" => {
                let meta = data.get("metadata");
                if meta.and_then(|m| m.get("turn_total")).is_none() {
                    self.output_tokens += data.get("completion_tokens").and_then(Value::as_i64).unwrap_or(0);
                    // One model call ended; the next call's text is a new paragraph.
                    self.flush_all(out);
                }
            }
            "done" => {
                self.flush_all(out);
                for t in std::mem::take(&mut self.tools) {
                    out.push(Cell::Tool { name: t.name, args: t.args, result: Some("(interrupted)".into()) });
                }
                let mode = self.mode.take();
                *self = Turn { mode, ..Turn::default() };
                return Effect::Done;
            }
            "error" => {
                self.flush_all(out);
                out.push(Cell::Error { title: s(data, "title"), message: s(data, "message") });
            }
            "provider_status" => {
                let msg = s(data, "message");
                self.notice = Some(match s(data, "status").as_str() {
                    "retrying" => {
                        let delay = data.get("delay_seconds").and_then(Value::as_f64).unwrap_or(0.0);
                        let attempt = data.get("attempt").and_then(Value::as_i64).unwrap_or(0);
                        let max = data.get("max_attempts").and_then(Value::as_i64).unwrap_or(0);
                        format!("Provider error, retrying in {delay:.0}s (attempt {attempt}/{max}) {msg}")
                    }
                    "waiting_quota" => format!("Waiting for provider quota {msg}"),
                    other => format!("Provider {other} {msg}"),
                });
            }
            "agent_not_configured" => {
                out.push(Cell::Error { title: "Agent not configured".into(), message: format!("{} Set it up in the desktop or web app.", s(data, "message")) })
            }
            "interaction_mode" => self.mode = Some(s(data, "interaction_mode")),
            "queued_turn_start" => {
                self.mark_working();
                self.flush_all(out);
                self.reply_started = false;
                let mut ids = vec![];
                for m in data.get("messages").and_then(Value::as_array).into_iter().flatten() {
                    ids.push(s(m, "id"));
                    out.push(user_cell(&s(m, "content"), m.get("extra")));
                }
                return Effect::QueuedStarted(ids);
            }
            "question_asked" => {
                // The question card stands for the asking tool, whose result
                // arrives only in a later turn.
                let id = s(data, "tool_call_id");
                self.tools.retain(|t| t.id != id);
                self.finished_tools.insert(id);
                return question(data).map(Effect::Question).unwrap_or(Effect::None);
            }
            "question_answered" | "question_dismissed" => return Effect::QuestionClosed(s(data, "question_id")),
            "summarization_start" => self.compacting = true,
            "summarization_content" => {}
            "summarization_end" => {
                self.compacting = false;
                out.push(Cell::Info("Conversation compacted".into()));
            }
            "subagent_spawned" | "subagent_status" => return Effect::Subagent(data.clone()),
            other if IGNORED_EVENTS.iter().any(|(n, _)| *n == other) => return Effect::Ignored,
            _ => return Effect::Unknown,
        }
        Effect::None
    }
}

fn user_cell(content: &str, extra: Option<&Value>) -> Cell {
    match extra.and_then(|e| e.get("from_agent")).and_then(Value::as_str) {
        Some(from) => Cell::AgentResult { from: from.into(), text: content.into() },
        None => Cell::User(content.into()),
    }
}

/// `question_asked` payload or a history `pending_question` row.
pub fn question(v: &Value) -> Option<Question> {
    let id = v.get("question_id").or_else(|| v.get("id")).and_then(Value::as_str)?.to_string();
    let items: Vec<QuestionItem> = v
        .get("questions")
        .and_then(Value::as_array)?
        .iter()
        .map(|q| QuestionItem {
            question: s(q, "question"),
            header: s(q, "header"),
            multiple: q.get("multiple") == Some(&Value::Bool(true)),
            // The backend treats a missing `custom` as allowed.
            custom: q.get("custom") != Some(&Value::Bool(false)),
            options: q
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|o| QuestionOption {
                    label: s(o, "label"),
                    description: o.get("description").and_then(Value::as_str).filter(|d| !d.is_empty()).map(String::from),
                    recommended: o.get("recommended") == Some(&Value::Bool(true)),
                })
                .collect(),
        })
        .collect();
    (!items.is_empty()).then(|| Question { id, items, plan_review: v.get("kind").and_then(Value::as_str) == Some("plan_review") })
}

/// The lead's stored messages, as the same cells the live stream produces.
pub fn history_cells(lead: &Value) -> Vec<Cell> {
    let msgs = lead.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let results: std::collections::HashMap<String, String> = msgs.iter().filter(|m| s(m, "role") == "tool").map(|m| (s(m, "tool_call_id"), s(m, "content"))).collect();
    let mut out = vec![];
    for m in &msgs {
        if m.get("is_summary") == Some(&Value::Bool(true)) {
            out.push(Cell::Info("Earlier conversation was compacted".into()));
            continue;
        }
        match s(m, "role").as_str() {
            "user" => {
                let content = s(m, "content");
                if !content.trim().is_empty() {
                    out.push(user_cell(&content, m.get("extra")));
                }
            }
            "assistant" => {
                let reasoning = s(m, "reasoning_content");
                if !reasoning.trim().is_empty() {
                    out.push(Cell::Thinking(reasoning.trim().to_string()));
                }
                let content = s(m, "content");
                if !content.trim().is_empty() {
                    out.push(Cell::Text { markdown: content, first: true });
                }
                for tc in m.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                    let f = tc.get("function").cloned().unwrap_or(Value::Null);
                    out.push(Cell::Tool { name: s(&f, "name"), args: s(&f, "arguments"), result: results.get(&s(tc, "id")).cloned() });
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feed(turn: &mut Turn, events: &[(&str, Value)]) -> Vec<Cell> {
        let mut out = vec![];
        for (e, d) in events {
            turn.apply(e, d, &mut out);
        }
        out
    }

    #[test]
    fn text_commits_at_paragraph_breaks_outside_fences() {
        assert_eq!(safe_split("a\n\nb"), 3);
        assert_eq!(safe_split("```\na\n\nb\n"), 0);
        assert_eq!(safe_split("```\na\n\n```\n\nc"), 12);
        let mut t = Turn::default();
        let cells = feed(&mut t, &[("message", json!({"text": "Hello\n\nWor"})), ("message", json!({"text": "ld"}))]);
        assert_eq!(cells, vec![Cell::Text { markdown: "Hello\n\n".into(), first: true }]);
        assert_eq!(t.pending_text(), "World");
        let cells = feed(&mut t, &[("done", json!({}))]);
        assert_eq!(cells, vec![Cell::Text { markdown: "World".into(), first: false }]);
        assert!(!t.working);
    }

    #[test]
    fn replay_does_not_duplicate_text_or_tools() {
        let mut t = Turn::default();
        let mut cells = feed(
            &mut t,
            &[
                ("message", json!({"text": "One\n\nTw"})),
                ("tool_call", json!({"tool_call_id": "c1", "name": "read"})),
                ("tool_end", json!({"tool_call_id": "c1", "name": "read", "result": "ok"})),
            ],
        );
        t.on_attach();
        // The server replays the whole turn: all text, then every tool.
        cells.extend(feed(
            &mut t,
            &[
                ("message", json!({"text": "One\n\nTwo"})),
                ("tool_call", json!({"tool_call_id": "c1", "name": "read"})),
                ("tool_end", json!({"tool_call_id": "c1", "name": "read", "result": "ok"})),
                ("done", json!({})),
            ],
        ));
        let texts: Vec<_> = cells.iter().filter_map(|c| if let Cell::Text { markdown, .. } = c { Some(markdown.as_str()) } else { None }).collect();
        assert_eq!(texts, vec!["One\n\n", "Tw", "o"]);
        assert_eq!(cells.iter().filter(|c| matches!(c, Cell::Tool { .. })).count(), 1);
    }

    /// Every session event in the shared contract is either handled or listed
    /// in `IGNORED_EVENTS`, so a new backend event fails here until the TUI
    /// decides what to do with it.
    #[test]
    fn handles_every_contract_event() {
        let contract: Value = serde_json::from_str(include_str!("../../../contract/sse_events.json")).unwrap();
        for name in contract["session_stream"].as_array().unwrap() {
            let name = name.as_str().unwrap();
            let effect = Turn::default().apply(name, &json!({}), &mut vec![]);
            assert_ne!(effect, Effect::Unknown, "session event {name:?} is not handled by the TUI");
        }
        for (name, _) in IGNORED_EVENTS {
            assert!(contract["session_stream"].as_array().unwrap().iter().any(|n| n == name), "{name} is not a contract event");
        }
    }

    /// A real captured turn (read, delegate to a sub-agent, reply).
    #[test]
    fn golden_delegate_turn() {
        let mut parser = crate::sse::SseParser::default();
        let events = parser.feed(include_bytes!("../tests/fixtures/stream_delegate.sse"));
        let mut t = Turn::default();
        t.on_attach();
        let mut cells = vec![];
        let mut effects = vec![];
        for (e, d) in &events {
            effects.push(t.apply(e, d, &mut cells));
        }
        let tools: Vec<_> = cells.iter().filter_map(|c| if let Cell::Tool { name, result, .. } = c { Some((name.as_str(), result.clone())) } else { None }).collect();
        assert_eq!(tools[0], ("read", Some("hello world\n".into())));
        assert_eq!(tools[1].0, "delegate");
        assert!(matches!(cells.last(), Some(Cell::Text { .. })), "{cells:?}");
        assert!(effects.iter().any(|e| matches!(e, Effect::Subagent(v) if v["handle"] == "helper#1")));
        assert_eq!(effects.last(), Some(&Effect::Done));
        assert!(t.tools.is_empty() && !t.working);
    }

    #[test]
    fn questions_parse_with_backend_defaults() {
        let q = question(&json!({"question_id": "q1", "questions": [{"question": "Pick", "options": [{"label": "A"}]}], "kind": "plan_review"})).unwrap();
        assert!(q.plan_review && q.items[0].custom && !q.items[0].multiple);
        assert_eq!(q.items[0].options[0].label, "A");
    }
}
