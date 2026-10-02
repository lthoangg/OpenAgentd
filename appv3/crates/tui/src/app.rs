//! The TUI event loop: keyboard input, the session and global streams, and
//! API calls all arrive as `Msg`s on one channel.

use crate::client::{ChatReply, Client, SessionRow, StreamMsg};
use crate::editor::Editor;
use crate::render::{cell_lines, tool_header};
use crate::term::Term;
use crate::theme::Theme;
use crate::transcript::{history_cells, question, Cell, Effect, Question, Turn};
use anyhow::Result;
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::text::Span;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

pub enum SessionPick {
    New,
    Continue,
    Id(String),
}

pub struct Options {
    pub base_url: String,
    pub token: Option<String>,
    pub workspace: String,
    pub session: SessionPick,
    pub theme: crate::theme::ThemeChoice,
    /// Prompt history file (JSON lines), shared by every workspace.
    pub history_file: Option<PathBuf>,
}

pub enum Msg {
    Input(Event),
    Session { gen: u64, msg: StreamMsg },
    Child { sid: String, msg: StreamMsg },
    Global(StreamMsg),
    GlobalRetry,
    Reattach { gen: u64 },
    Chat { text: String, result: Result<ChatReply> },
    History { sid: String, result: Result<Value> },
    Sessions(Result<Vec<SessionRow>>),
    Files(Result<Vec<String>>),
    Plan(Result<Option<String>>),
    Answered(Result<()>),
    Title { sid: String, title: String },
    Failed(String),
    Info(String),
    Resized { seq: u64 },
    Tick,
}

pub struct Sub {
    pub sid: String,
    pub handle: String,
    pub action: String,
    pub started: Instant,
}

pub enum Popup {
    None,
    Mention { start: usize, items: Vec<String>, sel: usize },
    Command { items: Vec<(&'static str, &'static str)>, sel: usize },
    Sessions { rows: Vec<SessionRow>, sel: usize },
}

pub struct QuestionState {
    pub q: Question,
    pub idx: usize,
    pub sel: usize,
    pub toggled: BTreeSet<usize>,
    pub answers: Vec<Vec<String>>,
}

pub const COMMANDS: &[(&str, &str)] =
    &[("/sessions", "switch to another session in this folder"), ("/new", "start a new session"), ("/help", "show keys and commands"), ("/exit", "quit")];

pub struct App {
    pub client: Client,
    pub ws: String,
    pub ws_name: String,
    pub theme: Theme,
    tx: UnboundedSender<Msg>,
    pub term: Term,
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub turn: Turn,
    stream_gen: u64,
    stream_open: bool,
    /// Short retries for a stream that closed before its turn started.
    expect_turn: u8,
    reconnects: u32,
    pub editor: Editor,
    mentions: Vec<String>,
    pub popup: Popup,
    files: Option<Vec<String>>,
    files_loading: bool,
    pub queued: Vec<(Option<String>, String)>,
    pub subs: Vec<Sub>,
    pub question: Option<QuestionState>,
    pub flash: Option<(String, Instant)>,
    quit_armed: Option<Instant>,
    history_file: Option<PathBuf>,
    pub spinner: usize,
    exit: bool,
    resize_seq: u64,
    /// No drawing until a resize settles: the old geometry is wrong.
    resizing: bool,
    /// Cells finished while resizing, printed once it settles.
    held: Vec<Cell>,
    input: Option<crate::input::Input>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn load_history(path: Option<&PathBuf>, ws: &str) -> Vec<String> {
    let Some(text) = path.and_then(|p| std::fs::read_to_string(p).ok()) else { return vec![] };
    let mut out: Vec<String> = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["workspace"] == ws).map(|v| s(&v, "text")).collect();
    let keep = out.len().saturating_sub(500);
    out.drain(..keep);
    out
}

/// Fuzzy file match: every query char in order; substring and basename
/// matches rank first, then shorter paths.
pub fn fuzzy(query: &str, items: &[String], limit: usize) -> Vec<String> {
    let q = query.to_lowercase();
    let mut scored: Vec<(usize, &String)> = items
        .iter()
        .filter_map(|item| {
            let l = item.to_lowercase();
            let mut chars = l.chars();
            if !q.chars().all(|c| chars.any(|x| x == c)) {
                return None;
            }
            let base = l.rsplit('/').next().unwrap_or(&l);
            let rank = if base.starts_with(&q) {
                0
            } else if l.contains(&q) {
                1
            } else {
                2
            };
            Some((rank * 10_000 + l.len(), item))
        })
        .collect();
    scored.sort();
    scored.into_iter().take(limit).map(|(_, i)| i.clone()).collect()
}

pub fn elapsed(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s}s")
    } else {
        format!("{}m {}s", s / 60, s % 60)
    }
}

pub async fn run(opts: Options) -> Result<()> {
    let client = Client::new(&opts.base_url, opts.token.clone())?;
    client.health().await.map_err(|e| anyhow::anyhow!("the server at {} is not ready: {e}", opts.base_url))?;
    let session_id = match &opts.session {
        SessionPick::New => None,
        SessionPick::Id(id) => Some(id.clone()),
        SessionPick::Continue => client.latest_session(&opts.workspace).await?,
    };
    let theme = Theme::resolve(opts.theme);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        crate::term::restore();
        prev(info);
    }));
    let term = Term::enter()?;
    let (tx, rx) = unbounded_channel();
    let ws_name = std::path::Path::new(&opts.workspace).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| opts.workspace.clone());
    let history = load_history(opts.history_file.as_ref(), &opts.workspace);
    let mut app = App {
        client,
        ws: opts.workspace.clone(),
        ws_name,
        theme,
        tx,
        term,
        session_id: None,
        title: None,
        turn: Turn::default(),
        stream_gen: 0,
        stream_open: false,
        expect_turn: 0,
        reconnects: 0,
        editor: Editor::new(history),
        mentions: vec![],
        popup: Popup::None,
        files: None,
        files_loading: false,
        queued: vec![],
        subs: vec![],
        question: None,
        flash: None,
        quit_armed: None,
        history_file: opts.history_file.clone(),
        spinner: 0,
        exit: false,
        resize_seq: 0,
        resizing: false,
        held: vec![],
        input: None,
    };
    let result = app.main(rx, session_id, &opts.base_url).await;
    let _ = app.term.leave();
    result?;
    if let Some(id) = &app.session_id {
        let title = app.title.as_deref().filter(|t| !t.is_empty()).unwrap_or("untitled");
        println!("Session \"{title}\". Resume it with: openagentd tui --session {id}");
    }
    Ok(())
}

impl App {
    async fn main(&mut self, mut rx: UnboundedReceiver<Msg>, session_id: Option<String>, url: &str) -> Result<()> {
        let tx = self.tx.clone();
        self.input = Some(crate::input::Input::spawn(move |ev| tx.send(Msg::Input(ev)).is_ok()));
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(120));
            loop {
                tick.tick().await;
                if tx.send(Msg::Tick).is_err() {
                    break;
                }
            }
        });
        self.spawn_global();
        self.commit(vec![Cell::Info(format!(
            "OpenAgentd · {} · {url}\nEnter sends · Shift+Enter, Alt+Enter, or Ctrl+J adds a line · @ mentions a file · /help for more",
            self.ws
        ))]);
        if let Some(id) = session_id {
            self.switch_session(id);
        }
        self.draw();
        while let Some(msg) = rx.recv().await {
            let mut changed = !matches!(msg, Msg::Tick);
            self.handle(msg);
            // Apply everything already queued before drawing once.
            while let Ok(m) = rx.try_recv() {
                changed |= !matches!(m, Msg::Tick);
                self.handle(m);
            }
            if self.exit {
                break;
            }
            if changed || self.turn.working || !self.subs.is_empty() || self.flash.is_some() {
                self.draw();
            }
        }
        Ok(())
    }

    fn spawn<F>(&self, fut: F)
    where
        F: std::future::Future<Output = Msg> + Send + 'static,
    {
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(fut.await);
        });
    }

    fn spawn_global(&self) {
        let (client, tx) = (self.client.clone(), self.tx.clone());
        tokio::spawn(async move { client.stream("/api/events/stream", tx, Msg::Global).await });
    }

    pub fn commit(&mut self, cells: Vec<Cell>) {
        if self.resizing {
            self.held.extend(cells);
            return;
        }
        let w = self.term.width() as usize;
        let lines: Vec<_> = cells.iter().flat_map(|c| cell_lines(c, w, &self.theme)).collect();
        if let Err(e) = self.term.insert(&lines) {
            self.flash(format!("terminal write failed: {e}"));
        }
    }

    fn flash(&mut self, text: impl Into<String>) {
        self.flash = Some((text.into(), Instant::now()));
    }

    fn draw(&mut self) {
        if self.resizing {
            return;
        }
        if self.flash.as_ref().is_some_and(|(_, t)| t.elapsed() > Duration::from_secs(6)) {
            self.flash = None;
        }
        let view = crate::view::build(self);
        let (lines, cursor) = (view.lines, view.cursor);
        let h = lines.len() as u16;
        let caret = cursor.map(|(_, y)| usize::from(y)).unwrap_or(0);
        let above_caret = lines.iter().take(caret).map(|l| l.spans.iter().map(|s| crate::wrap::width(&s.content)).sum()).collect();
        let res = self.term.draw(h, above_caret, |f| {
            let area = f.area();
            for (i, l) in lines.iter().enumerate() {
                f.buffer_mut().set_line(area.x, area.y + i as u16, l, area.width);
            }
            if let Some((x, y)) = cursor {
                f.set_cursor_position((area.x + x, area.y + y));
            }
        });
        if let Err(e) = res {
            self.flash(format!("draw failed: {e}"));
        }
    }

    // ── Session streams ─────────────────────────────────────────────────────

    fn attach(&mut self) {
        let Some(sid) = self.session_id.clone() else { return };
        if self.stream_open {
            return;
        }
        self.stream_gen += 1;
        self.stream_open = true;
        self.turn.on_attach();
        let (client, tx, gen) = (self.client.clone(), self.tx.clone(), self.stream_gen);
        tokio::spawn(async move { client.stream(&format!("/api/agent/{sid}/stream"), tx, move |msg| Msg::Session { gen, msg }).await });
    }

    fn reattach_later(&self, delay: Duration) {
        let gen = self.stream_gen;
        self.spawn(async move {
            tokio::time::sleep(delay).await;
            Msg::Reattach { gen }
        });
    }

    fn attach_child(&self, sid: &str) {
        let (client, tx, sid) = (self.client.clone(), self.tx.clone(), sid.to_string());
        let path = format!("/api/agent/{sid}/stream");
        tokio::spawn(async move { client.stream(&path, tx, move |msg| Msg::Child { sid: sid.clone(), msg }).await });
    }

    fn switch_session(&mut self, id: String) {
        self.reset_session();
        self.session_id = Some(id.clone());
        let client = self.client.clone();
        self.spawn(async move {
            let result = client.history(&id).await;
            Msg::History { sid: id, result }
        });
    }

    fn reset_session(&mut self) {
        self.session_id = None;
        self.title = None;
        self.stream_gen += 1;
        self.stream_open = false;
        self.expect_turn = 0;
        self.turn = Turn::default();
        self.subs.clear();
        self.queued.clear();
        self.question = None;
    }

    fn on_session_event(&mut self, name: &str, data: &Value) {
        self.expect_turn = 0;
        self.reconnects = 0;
        let mut cells = vec![];
        let effect = self.turn.apply(name, data, &mut cells);
        self.commit(cells);
        match effect {
            Effect::QueuedStarted(ids) => self.queued.retain(|(id, _)| !id.as_ref().is_some_and(|i| ids.contains(i))),
            Effect::Subagent(v) => self.on_subagent(&v),
            Effect::Question(q) => self.open_question(q),
            Effect::QuestionClosed(id) => {
                if self.question.as_ref().is_some_and(|q| q.q.id == id) {
                    self.question = None;
                }
            }
            Effect::Session(id) => {
                if self.session_id.is_none() {
                    self.session_id = Some(id);
                }
            }
            Effect::Done => {
                // Title generation may not publish an update; read the stored title.
                if let (None, Some(sid)) = (&self.title, self.session_id.clone()) {
                    let client = self.client.clone();
                    self.spawn(async move {
                        match client.title(&sid).await {
                            Ok(title) => Msg::Title { sid, title },
                            Err(e) => Msg::Failed(format!("Could not read the session title: {e}")),
                        }
                    });
                }
            }
            Effect::None | Effect::Ignored | Effect::Unknown => {}
        }
    }

    fn on_subagent(&mut self, v: &Value) {
        if self.session_id.as_deref() != Some(s(v, "lead_session_id").as_str()) {
            return;
        }
        let sid = s(v, "session_id");
        let status = s(v, "status");
        let pos = self.subs.iter().position(|x| x.sid == sid);
        if status == "working" {
            if pos.is_none() {
                self.subs.push(Sub { sid: sid.clone(), handle: s(v, "handle"), action: "Starting…".into(), started: Instant::now() });
                self.attach_child(&sid);
            }
            return;
        }
        if let Some(i) = pos {
            let sub = self.subs.remove(i);
            // A completed sub-agent's report arrives as a message to the lead.
            if status != "completed" {
                self.commit(vec![Cell::Error { title: format!("{} {status}", sub.handle), message: String::new() }]);
            }
        }
    }

    fn on_child_event(&mut self, sid: &str, name: &str, data: &Value) {
        let width = self.term.width() as usize;
        let theme = self.theme;
        let Some(sub) = self.subs.iter_mut().find(|x| x.sid == sid) else { return };
        match name {
            "thinking" => sub.action = "Thinking…".into(),
            "message" => sub.action = "Writing…".into(),
            "tool_start" | "tool_call" => {
                let line = tool_header(&s(data, "name"), &s(data, "arguments"), width.saturating_sub(30), Span::raw(""), &theme);
                sub.action = line.spans.iter().map(|x| x.content.as_ref()).collect();
            }
            _ => {}
        }
    }

    fn on_global(&mut self, name: &str, data: &Value) {
        let sid = s(data, "session_id");
        match name {
            "session_turn_started" => {
                if self.session_id.as_deref() == Some(sid.as_str()) {
                    self.expect_turn = 3;
                    self.attach();
                } else if self.subs.iter().any(|x| x.sid == sid) {
                    self.attach_child(&sid);
                }
            }
            "title_update" if self.session_id.as_deref() == Some(sid.as_str()) => self.title = Some(s(data, "title")),
            "subagent_spawned" | "subagent_status" => self.on_subagent(data),
            "workspace_files_changed" => self.files = None,
            _ => {}
        }
    }

    // ── Messages ────────────────────────────────────────────────────────────

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Input(ev) => self.on_input(ev),
            Msg::Tick => self.spinner = self.spinner.wrapping_add(1),
            Msg::Session { gen, msg } if gen == self.stream_gen => match msg {
                StreamMsg::Event(name, data) => self.on_session_event(&name, &data),
                StreamMsg::Closed { ok, events } => {
                    self.stream_open = false;
                    if !ok && self.turn.working {
                        // Lost the connection mid-turn: reconnect and replay.
                        let delay = Duration::from_millis(500 * 2u64.pow(self.reconnects.min(3)));
                        self.reconnects += 1;
                        self.flash("Reconnecting…");
                        self.reattach_later(delay);
                    } else if events == 0 && self.expect_turn > 0 {
                        self.expect_turn -= 1;
                        self.reattach_later(Duration::from_millis(300));
                    }
                }
            },
            Msg::Session { .. } => {}
            Msg::Reattach { gen } => {
                if gen == self.stream_gen {
                    self.attach();
                }
            }
            Msg::Child { sid, msg } => {
                if let StreamMsg::Event(name, data) = msg {
                    self.on_child_event(&sid, &name, &data);
                }
            }
            Msg::Global(StreamMsg::Event(name, data)) => self.on_global(&name, &data),
            Msg::Global(StreamMsg::Closed { .. }) => self.spawn(async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Msg::GlobalRetry
            }),
            Msg::GlobalRetry => self.spawn_global(),
            Msg::Chat { text, result } => self.on_chat(text, result),
            Msg::History { sid, result } => self.on_history(sid, result),
            Msg::Sessions(Ok(rows)) => {
                if rows.is_empty() {
                    self.flash("No sessions in this folder yet");
                } else {
                    self.popup = Popup::Sessions { rows, sel: 0 };
                }
            }
            Msg::Files(Ok(files)) => {
                self.files = Some(files);
                self.files_loading = false;
                self.update_popup();
            }
            Msg::Plan(Ok(Some(plan))) => self.commit(vec![Cell::Info("Plan for review:".into()), Cell::Text { markdown: plan, first: true }]),
            Msg::Plan(Ok(None)) | Msg::Answered(Ok(())) => {}
            Msg::Files(Err(e)) => {
                self.files_loading = false;
                self.flash(format!("Could not list files: {e}"));
            }
            Msg::Sessions(Err(e)) | Msg::Plan(Err(e)) => self.flash(format!("{e}")),
            Msg::Answered(Err(e)) => self.flash(format!("Answer failed: {e}")),
            Msg::Title { sid, title } => {
                if self.session_id.as_deref() == Some(sid.as_str()) && !title.is_empty() {
                    self.title = Some(title);
                }
            }
            Msg::Failed(e) => self.flash(e),
            Msg::Resized { seq } if seq == self.resize_seq => {
                self.resizing = false;
                let cursor_row = self.input.as_ref().and_then(|i| i.paused(|| crossterm::cursor::position().ok())).map(|(_, y)| y);
                let res = crossterm::terminal::size().and_then(|(c, r)| self.term.resized(c, r, cursor_row));
                if let Err(e) = res {
                    self.flash(format!("resize failed: {e}"));
                }
                let held = std::mem::take(&mut self.held);
                self.commit(held);
            }
            Msg::Resized { .. } => {}
            Msg::Info(text) => self.commit(vec![Cell::Info(text)]),
        }
    }

    fn on_chat(&mut self, text: String, result: Result<ChatReply>) {
        match result {
            Ok(r) => {
                if self.session_id.is_none() {
                    self.session_id = Some(r.session_id.clone());
                }
                if r.status == "queued" {
                    self.queued.push((r.message_id, text));
                } else {
                    self.commit(vec![Cell::User(text)]);
                    self.expect_turn = 3;
                    self.attach();
                }
            }
            Err(e) => {
                self.commit(vec![Cell::Error { title: "Message not sent".into(), message: format!("{e}") }]);
                self.editor.set_text(&text);
            }
        }
    }

    fn on_history(&mut self, sid: String, result: Result<Value>) {
        if self.session_id.as_deref() != Some(sid.as_str()) {
            return;
        }
        let h = match result {
            Ok(h) => h,
            Err(e) => {
                self.commit(vec![Cell::Error { title: "Could not load the session".into(), message: format!("{e}") }]);
                self.session_id = None;
                return;
            }
        };
        let lead = &h["lead"];
        self.title = Some(s(lead, "title")).filter(|t| !t.is_empty());
        let mut cells = vec![Cell::Info(format!("Session: {}", self.title.as_deref().unwrap_or("untitled")))];
        cells.extend(history_cells(lead));
        for c in &cells {
            if let Cell::User(t) = c {
                self.editor.push_history(t);
            }
        }
        self.commit(cells);
        self.turn.mode = Some(s(lead, "interaction_mode")).filter(|m| !m.is_empty());
        for m in h["members"].as_array().into_iter().flatten() {
            if m["running"] == Value::Bool(true) {
                let child = s(m, "session_id");
                self.subs.push(Sub { sid: child.clone(), handle: s(m, "name"), action: "Working…".into(), started: Instant::now() });
                self.attach_child(&child);
            }
        }
        if lead["running"] == Value::Bool(true) {
            self.expect_turn = 3;
            self.attach();
        }
        if let Some(q) = question(&h["pending_question"]) {
            self.open_question(q);
        }
    }

    fn open_question(&mut self, q: Question) {
        if self.question.as_ref().is_some_and(|x| x.q.id == q.id) {
            return;
        }
        if q.plan_review {
            if let Some(sid) = self.session_id.clone() {
                let client = self.client.clone();
                self.spawn(async move { Msg::Plan(client.plan(&sid).await) });
            }
        }
        self.popup = Popup::None;
        self.question = Some(QuestionState { q, idx: 0, sel: 0, toggled: BTreeSet::new(), answers: vec![] });
    }

    // ── Input ───────────────────────────────────────────────────────────────

    fn on_input(&mut self, ev: Event) {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.on_key(k),
            Event::Paste(text) => {
                self.editor.insert_str(&text);
                self.update_popup();
            }
            Event::Resize(..) => {
                // Wait for the drag to settle; the terminal reflows meanwhile.
                self.resize_seq += 1;
                self.resizing = true;
                let seq = self.resize_seq;
                self.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    Msg::Resized { seq }
                });
            }
            _ => {}
        }
    }

    fn on_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let shift = k.modifiers.contains(KeyModifiers::SHIFT);
        if !matches!(k.code, KeyCode::Char('c')) || !ctrl {
            self.quit_armed = None;
        }
        match k.code {
            KeyCode::Char('c') if ctrl => {
                if !self.editor.is_empty() {
                    self.editor.clear();
                    self.popup = Popup::None;
                } else if self.quit_armed.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
                    self.exit = true;
                } else {
                    self.quit_armed = Some(Instant::now());
                    self.flash("Press Ctrl+C again to exit");
                }
                return;
            }
            KeyCode::Char('d') if ctrl && self.editor.is_empty() => {
                self.exit = true;
                return;
            }
            KeyCode::Esc => {
                self.on_escape();
                return;
            }
            _ => {}
        }
        if self.popup_key(&k) {
            return;
        }
        if self.question.is_some() && self.editor.is_empty() && self.question_key(&k) {
            return;
        }
        match k.code {
            KeyCode::Enter if shift || alt => self.editor.newline(),
            KeyCode::Char('j') if ctrl => self.editor.newline(),
            KeyCode::Enter => {
                let text = self.editor.text();
                if let Some(stripped) = text.strip_suffix('\\') {
                    // `\` + Enter: a new line on terminals without Shift+Enter.
                    self.editor.set_text(&format!("{stripped}\n"));
                } else if self.question.is_some() {
                    self.answer_with_text();
                } else {
                    self.submit();
                }
            }
            KeyCode::Backspace if alt || ctrl => self.editor.delete_word(),
            KeyCode::Backspace => self.editor.backspace(),
            KeyCode::Delete => self.editor.delete(),
            KeyCode::Left if alt || ctrl => self.editor.word_left(),
            KeyCode::Right if alt || ctrl => self.editor.word_right(),
            KeyCode::Char('b') if alt => self.editor.word_left(),
            KeyCode::Char('f') if alt => self.editor.word_right(),
            KeyCode::Left => self.editor.left(),
            KeyCode::Right => self.editor.right(),
            KeyCode::Up => self.editor.up(),
            KeyCode::Down => self.editor.down(),
            KeyCode::Home => self.editor.home(),
            KeyCode::End => self.editor.end(),
            KeyCode::Char('a') if ctrl => self.editor.home(),
            KeyCode::Char('e') if ctrl => self.editor.end(),
            KeyCode::Char('u') if ctrl => self.editor.delete_to_start(),
            KeyCode::Char('k') if ctrl => self.editor.delete_to_end(),
            KeyCode::Char('w') if ctrl => self.editor.delete_word(),
            KeyCode::Char(c) if !ctrl => self.editor.insert_str(&c.to_string()),
            KeyCode::Tab => {}
            _ => return,
        }
        self.update_popup();
    }

    /// Esc closes the topmost thing: a popup, then a question, then stops
    /// the running turn.
    fn on_escape(&mut self) {
        if !matches!(self.popup, Popup::None) {
            self.popup = Popup::None;
        } else if let Some(q) = self.question.take() {
            if let Some(sid) = self.session_id.clone() {
                let client = self.client.clone();
                self.spawn(async move { Msg::Answered(client.dismiss(&sid, &q.q.id).await) });
            }
            self.commit(vec![Cell::Info("Question dismissed".into())]);
        } else if self.turn.working || !self.subs.is_empty() {
            if let Some(sid) = self.session_id.clone() {
                let (client, ws) = (self.client.clone(), self.ws.clone());
                self.spawn(async move {
                    match client.interrupt(&ws, &sid).await {
                        Ok(()) => Msg::Info("Interrupted by user".into()),
                        Err(e) => Msg::Failed(format!("Interrupt failed: {e}")),
                    }
                });
                self.flash("Interrupting…");
            }
        }
    }

    fn popup_key(&mut self, k: &KeyEvent) -> bool {
        let len = match &self.popup {
            Popup::None => return false,
            Popup::Mention { items, .. } => items.len(),
            Popup::Command { items, .. } => items.len(),
            Popup::Sessions { rows, .. } => rows.len(),
        };
        let sel = match &mut self.popup {
            Popup::Mention { sel, .. } | Popup::Command { sel, .. } | Popup::Sessions { sel, .. } => sel,
            Popup::None => return false,
        };
        match k.code {
            KeyCode::Up => *sel = (*sel + len.max(1) - 1) % len.max(1),
            KeyCode::Down => *sel = (*sel + 1) % len.max(1),
            KeyCode::Enter | KeyCode::Tab if len > 0 && !k.modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) => self.accept_popup(k.code == KeyCode::Enter),
            _ => {
                if matches!(self.popup, Popup::Sessions { .. }) {
                    self.popup = Popup::None;
                }
                return false;
            }
        }
        true
    }

    fn accept_popup(&mut self, enter: bool) {
        match std::mem::replace(&mut self.popup, Popup::None) {
            Popup::Mention { start, items, sel } => {
                let path = items[sel].clone();
                self.editor.replace_token(start, &format!("@{path} "));
                if !self.mentions.contains(&path) {
                    self.mentions.push(path);
                }
            }
            Popup::Command { items, sel } => {
                self.editor.set_text(items[sel].0);
                if enter {
                    self.submit();
                }
            }
            Popup::Sessions { rows, sel } => {
                let row = &rows[sel];
                if self.session_id.as_deref() != Some(row.id.as_str()) {
                    self.switch_session(row.id.clone());
                }
            }
            Popup::None => {}
        }
    }

    /// Open, refresh, or close the `@` and `/` popups for the word at the cursor.
    fn update_popup(&mut self) {
        if matches!(self.popup, Popup::Sessions { .. }) {
            return;
        }
        let (start, token) = self.editor.token();
        if let Some(q) = token.strip_prefix('@') {
            let Some(files) = &self.files else {
                if !self.files_loading {
                    self.files_loading = true;
                    let (client, ws) = (self.client.clone(), self.ws.clone());
                    self.spawn(async move { Msg::Files(client.files(&ws).await) });
                }
                return;
            };
            let items = fuzzy(q, files, 8);
            let sel = match &self.popup {
                Popup::Mention { sel, .. } => (*sel).min(items.len().saturating_sub(1)),
                _ => 0,
            };
            self.popup = if items.is_empty() { Popup::None } else { Popup::Mention { start, items, sel } };
        } else if token.starts_with('/') && start == 0 && self.editor.on_first_line() && !self.editor.text().contains('\n') {
            let items: Vec<_> = COMMANDS.iter().copied().filter(|(c, _)| c.starts_with(&token)).collect();
            let sel = match &self.popup {
                Popup::Command { sel, .. } => (*sel).min(items.len().saturating_sub(1)),
                _ => 0,
            };
            self.popup = if items.is_empty() { Popup::None } else { Popup::Command { items, sel } };
        } else {
            self.popup = Popup::None;
        }
    }

    fn question_key(&mut self, k: &KeyEvent) -> bool {
        let Some(st) = &mut self.question else { return false };
        let item = &st.q.items[st.idx];
        let n = item.options.len();
        match k.code {
            KeyCode::Up if n > 0 => st.sel = (st.sel + n - 1) % n,
            KeyCode::Down if n > 0 => st.sel = (st.sel + 1) % n,
            KeyCode::Char(' ') if item.multiple && n > 0 => {
                if !st.toggled.remove(&st.sel) {
                    st.toggled.insert(st.sel);
                }
            }
            KeyCode::Char(c) if c.is_ascii_digit() && !item.multiple => {
                let i = c.to_digit(10).unwrap_or(0) as usize;
                if i == 0 || i > n {
                    return false;
                }
                st.sel = i - 1;
                self.answer_with_text();
            }
            KeyCode::Enter if !k.modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) && n > 0 => self.answer_with_text(),
            _ => return false,
        }
        true
    }

    /// Answer the current question: typed text (when allowed) plus any
    /// toggled options, else the highlighted option.
    fn answer_with_text(&mut self) {
        let typed = self.editor.text().trim().to_string();
        let Some(st) = &mut self.question else { return };
        let item = &st.q.items[st.idx];
        if !typed.is_empty() && !item.custom {
            self.flash("This question needs one of the listed options");
            return;
        }
        let mut picked: Vec<String> = if item.multiple { st.toggled.iter().map(|i| item.options[*i].label.clone()).collect() } else { vec![] };
        if !typed.is_empty() {
            picked.push(typed);
        } else if picked.is_empty() {
            match item.options.get(st.sel) {
                Some(o) => picked.push(o.label.clone()),
                None => return,
            }
        }
        st.answers.push(picked);
        st.idx += 1;
        st.sel = 0;
        st.toggled.clear();
        self.editor.clear();
        if st.idx < st.q.items.len() {
            return;
        }
        let Some(st) = self.question.take() else { return };
        let summary: Vec<String> = st.q.items.iter().zip(&st.answers).map(|(i, a)| format!("{} → {}", i.question, a.join(", "))).collect();
        self.commit(vec![Cell::Info(summary.join("\n"))]);
        let Some(sid) = self.session_id.clone() else { return };
        let client = self.client.clone();
        self.expect_turn = 3;
        self.spawn(async move { Msg::Answered(client.answer(&sid, &st.q.id, &st.answers).await) });
        self.reattach_later(Duration::from_millis(300));
    }

    fn submit(&mut self) {
        let text = self.editor.text().trim().to_string();
        if text.is_empty() {
            return;
        }
        self.popup = Popup::None;
        if text.starts_with('/') && !text.contains(char::is_whitespace) {
            if let Some((cmd, _)) = COMMANDS.iter().find(|(c, _)| *c == text) {
                self.editor.clear();
                self.command(cmd);
                return;
            }
        }
        self.editor.push_history(&text);
        self.save_history(&text);
        self.editor.clear();
        let mentions: Vec<String> = std::mem::take(&mut self.mentions).into_iter().filter(|m| text.contains(&format!("@{m}"))).collect();
        let (client, ws, sid) = (self.client.clone(), self.ws.clone(), self.session_id.clone());
        self.spawn(async move {
            let result = client.chat(&ws, sid.as_deref(), &text, &mentions).await;
            Msg::Chat { text, result }
        });
    }

    fn save_history(&self, text: &str) {
        let Some(path) = &self.history_file else { return };
        use std::io::Write;
        let line = serde_json::json!({"workspace": self.ws, "text": text}).to_string();
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
            writeln!(f, "{line}")
        };
        if let Err(e) = write() {
            let _ = self.tx.send(Msg::Failed(format!("Could not save prompt history: {e}")));
        }
    }

    fn command(&mut self, cmd: &str) {
        match cmd {
            "/exit" => self.exit = true,
            "/new" => {
                self.reset_session();
                self.commit(vec![Cell::Info("New session".into())]);
            }
            "/sessions" => {
                let (client, ws) = (self.client.clone(), self.ws.clone());
                self.spawn(async move { Msg::Sessions(client.sessions(&ws, 20).await) });
            }
            _ => {
                let help = [
                    "Keys",
                    "  Enter send · Shift+Enter, Alt+Enter, Ctrl+J, or \\ then Enter: new line",
                    "  ↑/↓ earlier prompts · @ mention a file · Tab/Enter pick a suggestion",
                    "  Esc close a popup, dismiss a question, or stop the agent",
                    "  Ctrl+C clear the input, twice to exit · Ctrl+D exit",
                    "  Ctrl+A/E line start/end · Ctrl+U/K delete to start/end · Ctrl+W delete word",
                    "Commands",
                ];
                let mut text: Vec<String> = help.iter().map(|s| s.to_string()).collect();
                text.extend(COMMANDS.iter().map(|(c, d)| format!("  {c}  {d}")));
                text.push("Settings, models, and MCP servers are managed in the desktop or web app.".into());
                self.commit(vec![Cell::Info(text.join("\n"))]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_ranks_basename_then_substring() {
        let files: Vec<String> = ["src/main.rs", "docs/main_notes.md", "src/app/manager.rs", "README.md"].iter().map(|s| s.to_string()).collect();
        assert_eq!(fuzzy("main", &files, 8), vec!["src/main.rs", "docs/main_notes.md"]);
        assert_eq!(fuzzy("mgr", &files, 8), vec!["src/app/manager.rs"]);
        assert_eq!(fuzzy("", &files, 2).len(), 2);
    }

    /// Global-stream events: those `App::on_global` handles, and those it
    /// deliberately ignores. Keep in step with `on_global`.
    const GLOBAL_HANDLED: &[&str] = &["session_turn_started", "title_update", "subagent_spawned", "subagent_status", "workspace_files_changed"];
    const GLOBAL_IGNORED: &[(&str, &str)] = &[
        ("session_turn_completed", "the session stream's own done event ends the turn"),
        ("desktop_notification", "desktop-only notifications"),
        ("config_changed", "settings are edited in the desktop or web app"),
        ("mcp_status_changed", "MCP is managed in the desktop or web app"),
        ("lsp_install_required", "LSP installs are offered by the desktop or web app"),
    ];

    /// Every global contract event is handled or deliberately ignored.
    #[test]
    fn handles_every_global_contract_event() {
        let contract: Value = serde_json::from_str(include_str!("../../../contract/sse_events.json")).unwrap();
        for name in contract["global_stream"].as_array().unwrap() {
            let name = name.as_str().unwrap();
            assert!(GLOBAL_HANDLED.contains(&name) || GLOBAL_IGNORED.iter().any(|(n, _)| *n == name), "global event {name:?} is not handled by the TUI");
        }
    }
}
