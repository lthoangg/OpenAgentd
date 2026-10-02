//! The live area under the scrollback: the open parts of the turn,
//! sub-agents, status, the prompt, popups, and the footer.

use crate::app::{elapsed, App, Popup};
use crate::markdown;
use crate::render::{paragraphs, thinking_lines, tool_header};
use crate::wrap::{truncate, width};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TEXT_TAIL: usize = 12;
const THINKING_TAIL: usize = 4;
const OUTPUT_TAIL: usize = 3;

pub struct View {
    pub lines: Vec<Line<'static>>,
    pub cursor: Option<(u16, u16)>,
}

fn tail(mut lines: Vec<Line<'static>>, n: usize) -> Vec<Line<'static>> {
    let cut = lines.len().saturating_sub(n);
    lines.drain(..cut);
    lines
}

pub fn build(app: &App) -> View {
    let th = &app.theme;
    let w = app.term.width() as usize;
    let spin = SPINNER[app.spinner % SPINNER.len()];

    // Open parts of the turn; trimmed first when the window is short.
    let mut live: Vec<Line<'static>> = vec![];
    let thinking = app.turn.pending_thinking().trim();
    if !thinking.is_empty() {
        live.push(Line::default());
        live.push(Line::from(Span::styled("✻ Thinking…", th.dim_italic())));
        live.extend(tail(thinking_lines(thinking, w, th), THINKING_TAIL));
    }
    for t in &app.turn.tools {
        live.push(Line::default());
        live.push(tool_header(&t.name, &t.args, w, Span::styled(format!("{spin} "), th.fg(th.tool)), th));
        let out: Vec<&str> = t.output.lines().collect();
        for l in &out[out.len().saturating_sub(OUTPUT_TAIL)..] {
            live.push(Line::from(vec![Span::styled("  │ ", th.dim()), Span::styled(truncate(l, w.saturating_sub(4)), th.dim())]));
        }
    }
    let text = app.turn.pending_text();
    if !text.trim().is_empty() {
        live.push(Line::default());
        let body = markdown::render(text, w.saturating_sub(2), th);
        live.extend(tail(body.into_iter().map(|l| Line::from([vec![Span::raw("  ")], l.spans].concat())).collect(), TEXT_TAIL));
    }

    let mut mid: Vec<Line<'static>> = vec![];
    if !app.subs.is_empty() {
        mid.push(Line::default());
    }
    for sub in &app.subs {
        let head = format!("◇ {} · ", sub.handle);
        let time = format!(" · {}", elapsed(sub.started.elapsed()));
        let room = w.saturating_sub(width(&head) + width(&time) + 2);
        mid.push(Line::from(vec![
            Span::styled(format!("{spin} "), th.fg(th.accent)),
            Span::styled(head, Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(truncate(&sub.action, room), th.dim()),
            Span::styled(time, th.dim()),
        ]));
    }
    let status = if app.turn.compacting {
        Some("Compacting conversation…".to_string())
    } else if let Some(n) = &app.turn.notice {
        Some(n.clone())
    } else if app.turn.working {
        let secs = app.turn.started.map(|s| elapsed(s.elapsed())).unwrap_or_default();
        let toks = if app.turn.output_tokens > 0 { format!(" · ↓ {} tokens", app.turn.output_tokens) } else { String::new() };
        Some(format!("Working… ({secs}{toks} · esc to interrupt)"))
    } else {
        None
    };
    if let Some(st) = status {
        mid.push(Line::default());
        mid.push(Line::from(vec![Span::styled(format!("{spin} "), th.fg(th.accent)), Span::styled(truncate(&st, w.saturating_sub(2)), th.fg(th.accent))]));
    }
    for (_, q) in &app.queued {
        mid.push(Line::from(Span::styled(truncate(&format!("  ⧗ queued: {}", q.replace('\n', " ")), w), th.dim())));
    }
    if let Some(st) = &app.question {
        let item = &st.q.items[st.idx];
        mid.push(Line::default());
        let head = if st.q.plan_review {
            "Plan review".to_string()
        } else if item.header.is_empty() {
            "Question".to_string()
        } else {
            item.header.clone()
        };
        let count = if st.q.items.len() > 1 { format!(" ({}/{})", st.idx + 1, st.q.items.len()) } else { String::new() };
        mid.push(Line::from(Span::styled(format!("? {head}{count}"), th.fg(th.warn).add_modifier(Modifier::BOLD))));
        mid.extend(paragraphs(&item.question, w, &[Span::raw("  ")], Style::default()));
        for (i, o) in item.options.iter().enumerate() {
            let selected = i == st.sel;
            let mark = if item.multiple {
                if st.toggled.contains(&i) {
                    "[x] "
                } else {
                    "[ ] "
                }
            } else {
                ""
            };
            let pointer = if selected { "❯ " } else { "  " };
            let style = if selected { th.fg(th.accent).add_modifier(Modifier::BOLD) } else { Style::default() };
            let rec = if o.recommended { " (recommended)" } else { "" };
            let label = format!("{pointer}{}. {mark}{}{rec}", i + 1, o.label);
            let desc = o.description.as_deref().map(|d| format!("  {d}")).unwrap_or_default();
            let room = w.saturating_sub(width(&label));
            mid.push(Line::from(vec![Span::styled(label, style), Span::styled(truncate(&desc, room), th.dim())]));
        }
        let mut hint = String::from("  ↑/↓ choose · Enter select");
        if item.multiple {
            hint.push_str(" · Space toggle");
        }
        if item.custom {
            hint.push_str(" · or type an answer");
        }
        hint.push_str(" · Esc dismiss");
        mid.push(Line::from(Span::styled(truncate(&hint, w), th.dim())));
    }

    // Prompt box.
    let mut input: Vec<Line<'static>> = vec![Line::default(), Line::from(Span::styled("─".repeat(w), th.fg(th.border)))];
    let (rows, (cx, cy)) = app.editor.layout(w.saturating_sub(3).max(1));
    let prompt_style = th.fg(th.accent).add_modifier(Modifier::BOLD);
    let max_rows = (app.term.rows() as usize / 2).max(3);
    let first_row = (cy as usize + 1).saturating_sub(max_rows);
    let shown: Vec<&String> = rows.iter().skip(first_row).take(max_rows).collect();
    let placeholder = app.editor.is_empty() && app.question.is_none();
    for (i, r) in shown.iter().enumerate() {
        let lead = if i == 0 && first_row == 0 { Span::styled("> ", prompt_style) } else { Span::raw("  ") };
        let body = if placeholder { Span::styled(truncate("Type a message, @ to mention a file, / for commands", w.saturating_sub(3)), th.dim()) } else { Span::raw((*r).clone()) };
        input.push(Line::from(vec![lead, body]));
    }
    let cursor_row = 2 + cy as usize - first_row;
    input.push(Line::from(Span::styled("─".repeat(w), th.fg(th.border))));

    let mut below: Vec<Line<'static>> = vec![];
    match &app.popup {
        Popup::None => {}
        Popup::Mention { items, sel, .. } => {
            for (i, it) in items.iter().enumerate() {
                below.push(pick_line(&format!("@{it}"), "", i == *sel, w, app));
            }
        }
        Popup::Command { items, sel } => {
            for (i, (c, d)) in items.iter().enumerate() {
                below.push(pick_line(c, d, i == *sel, w, app));
            }
        }
        Popup::Sessions { rows, sel } => {
            below.push(Line::from(Span::styled("  Sessions in this folder (Enter opens, Esc closes)", th.dim())));
            let first = sel.saturating_sub(9);
            for (i, r) in rows.iter().enumerate().skip(first).take(10) {
                let title = if r.title.is_empty() { "untitled" } else { r.title.as_str() };
                let when = r.updated_at.get(..16).unwrap_or(&r.updated_at).replace('T', " ");
                let extra = format!("{when}{}", if r.running { " · running" } else { "" });
                below.push(pick_line(title, &extra, i == *sel, w, app));
            }
        }
    }
    // Footer: hint or flash on the left, folder and session on the right.
    let left = match &app.flash {
        Some((f, _)) => Span::styled(f.clone(), th.fg(th.warn)),
        None if app.turn.working => Span::styled("esc to interrupt", th.dim()),
        None => Span::styled("/help for keys and commands", th.dim()),
    };
    let mut right = format!("{} · {}", app.ws_name, app.title.as_deref().filter(|t| !t.is_empty()).unwrap_or(if app.session_id.is_some() { "untitled" } else { "new session" }));
    if app.turn.mode.as_deref() == Some("plan") {
        right.push_str(" · plan mode");
    }
    let left_w = width(&left.content);
    let right = truncate(&right, w.saturating_sub(left_w + 6));
    let gap = w.saturating_sub(left_w + width(&right) + 2);
    below.push(Line::from(vec![Span::raw("  "), left, Span::raw(" ".repeat(gap)), Span::styled(right, th.dim())]));

    // Fit the window: drop the oldest open-turn lines first.
    let budget = app.term.rows().saturating_sub(1) as usize;
    let fixed = mid.len() + input.len() + below.len();
    let live = tail(live, budget.saturating_sub(fixed));
    let mut lines = live;
    let input_top = lines.len() + mid.len();
    lines.extend(mid);
    lines.extend(input);
    lines.extend(below);
    let cursor = Some((2 + cx, (input_top + cursor_row) as u16));
    let cut = lines.len().saturating_sub(budget.max(1));
    lines.drain(..cut);
    let cursor = cursor.and_then(|(x, y)| y.checked_sub(cut as u16).map(|y| (x, y)));
    View { lines, cursor }
}

fn pick_line(label: &str, detail: &str, selected: bool, w: usize, app: &App) -> Line<'static> {
    let th = &app.theme;
    let pointer = if selected { "❯ " } else { "  " };
    let style = if selected { th.fg(th.accent).add_modifier(Modifier::BOLD) } else { Style::default() };
    // The detail keeps up to half the row; the label gets the rest.
    let detail = if detail.is_empty() { String::new() } else { truncate(&format!("  {detail}"), w / 2) };
    let label = truncate(&format!("{pointer}{label}"), w.saturating_sub(width(&detail) + 1));
    Line::from(vec![Span::styled(label, style), Span::styled(detail, th.dim())])
}
