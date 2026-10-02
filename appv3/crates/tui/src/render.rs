//! Transcript cells to terminal lines.

use crate::markdown;
use crate::theme::Theme;
use crate::transcript::Cell;
use crate::wrap::{truncate, wrap_spans};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

const RESULT_LINES: usize = 5;

/// Lines for one finished cell, starting with a blank separator line.
pub fn cell_lines(cell: &Cell, width: usize, th: &Theme) -> Vec<Line<'static>> {
    let mut out = vec![Line::default()];
    match cell {
        Cell::User(text) => {
            let style = th.fg(th.user);
            out.extend(paragraphs(text, width, &[Span::styled("> ", style.add_modifier(Modifier::BOLD))], style));
        }
        Cell::AgentResult { from, text } => {
            out.push(Line::from(vec![Span::styled("◆ ", th.fg(th.accent)), Span::styled(format!("{from} finished"), Style::default().add_modifier(Modifier::BOLD))]));
            out.extend(result_lines(text, width, th));
        }
        Cell::Text { markdown: md, first } => {
            let body = markdown::render(md, width.saturating_sub(2), th);
            for (i, l) in body.into_iter().enumerate() {
                let lead = if i == 0 && *first { Span::styled("● ", th.fg(th.text)) } else { Span::raw("  ") };
                let mut spans = vec![lead];
                spans.extend(l.spans);
                out.push(Line::from(spans));
            }
        }
        Cell::Thinking(text) => {
            out.push(Line::from(Span::styled("✻ Thinking", th.dim_italic())));
            out.extend(thinking_lines(text, width, th));
        }
        Cell::Tool { name, args, result } => {
            out.push(tool_header(name, args, width, Span::styled("● ", th.fg(th.tool)), th));
            if let Some(r) = result {
                out.extend(result_lines(r, width, th));
            }
        }
        Cell::Info(text) => out.extend(paragraphs(text, width, &[Span::styled("· ", th.dim())], th.dim())),
        Cell::Error { title, message } => {
            let title = if title.is_empty() { "Error" } else { title };
            out.push(Line::from(Span::styled(format!("✗ {title}"), th.fg(th.error).add_modifier(Modifier::BOLD))));
            out.extend(paragraphs(message, width, &[Span::raw("  ")], th.fg(th.error)));
        }
    }
    out
}

/// Thinking text: markdown (models use bold titles), dimmed and indented.
pub fn thinking_lines(text: &str, width: usize, th: &Theme) -> Vec<Line<'static>> {
    let dim = th.dim_italic();
    markdown::render(text, width.saturating_sub(2), th)
        .into_iter()
        .map(|l| {
            let mut spans = vec![Span::raw("  ")];
            spans.extend(l.spans.into_iter().map(|s| Span::styled(s.content, dim.add_modifier(s.style.add_modifier))));
            Line::from(spans)
        })
        .collect()
}

/// `Read(notes.txt)`: the tool name and its most telling argument.
pub fn tool_header(name: &str, args: &str, width: usize, bullet: Span<'static>, th: &Theme) -> Line<'static> {
    let shown = name.replace('_', " ");
    let mut label: String = shown.chars().next().map(|c| c.to_uppercase().collect::<String>() + &shown[c.len_utf8()..]).unwrap_or_default();
    let summary = tool_summary(name, args);
    let mut spans = vec![bullet, Span::styled(label.clone(), Style::default().add_modifier(Modifier::BOLD))];
    if !summary.is_empty() {
        label = truncate(&format!("({summary})"), width.saturating_sub(crate::wrap::width(&label) + 3));
        spans.push(Span::styled(label, th.dim()));
    }
    Line::from(spans)
}

pub fn tool_summary(name: &str, args: &str) -> String {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(args) else { return one_line(args) };
    let get = |k: &str| map.get(k).and_then(Value::as_str).map(one_line);
    if name == "delegate" {
        let profile = get("profile").unwrap_or_default();
        let task = get("task").unwrap_or_default();
        return if profile.is_empty() { task } else { format!("{profile}: {task}") };
    }
    for k in ["command", "path", "file_path", "pattern", "query", "url", "description", "task", "name"] {
        if let Some(v) = get(k) {
            return v;
        }
    }
    map.values().find_map(|v| v.as_str().map(one_line)).unwrap_or_default()
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `⎿` plus the first lines of a tool result, dimmed.
pub fn result_lines(text: &str, width: usize, th: &Theme) -> Vec<Line<'static>> {
    let text = text.trim_end();
    if text.is_empty() {
        return vec![Line::from(vec![Span::styled("  ⎿  ", th.dim()), Span::styled("(no output)", th.dim())])];
    }
    let mut lines = vec![];
    let all: Vec<&str> = text.lines().collect();
    for (i, l) in all.iter().take(RESULT_LINES).enumerate() {
        let lead = if i == 0 { "  ⎿  " } else { "     " };
        lines.push(Line::from(vec![Span::styled(lead, th.dim()), Span::styled(truncate(l, width.saturating_sub(5)), th.dim())]));
    }
    if all.len() > RESULT_LINES {
        lines.push(Line::from(Span::styled(format!("     … +{} lines", all.len() - RESULT_LINES), th.dim())));
    }
    lines
}

/// Plain text with its own line breaks, wrapped; `lead` starts the first line.
pub fn paragraphs(text: &str, width: usize, lead: &[Span<'static>], style: Style) -> Vec<Line<'static>> {
    let lead_w: usize = lead.iter().map(|s| crate::wrap::width(&s.content)).sum();
    let rest = [Span::raw(" ".repeat(lead_w))];
    let mut out = vec![];
    for (i, para) in text.split('\n').enumerate() {
        let first: &[Span<'static>] = if i == 0 { lead } else { &rest };
        out.extend(wrap_spans(&[Span::styled(para.to_string(), style)], width, first, &rest));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_summaries() {
        assert_eq!(tool_summary("read", r#"{"path": "notes.txt"}"#), "notes.txt");
        assert_eq!(tool_summary("shell", r#"{"command": "ls\n -la"}"#), "ls -la");
        assert_eq!(tool_summary("delegate", r#"{"task": "list files", "profile": "helper"}"#), "helper: list files");
        let lines = cell_lines(&Cell::Tool { name: "read".into(), args: r#"{"path":"a"}"#.into(), result: Some("1\n2\n3\n4\n5\n6\n7".into()) }, 40, &Theme::dark());
        let text: Vec<String> = lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect()).collect();
        assert_eq!(text[1], "● Read(a)");
        assert_eq!(text[2], "  ⎿  1");
        assert_eq!(text.last().unwrap(), "     … +2 lines");
    }
}
