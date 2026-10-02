//! Markdown to terminal lines (pulldown-cmark), wrapped to a fixed width.

use crate::theme::Theme;
use crate::wrap::{hard_wrap, truncate, width, wrap_spans};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

pub fn render(md: &str, max: usize, theme: &Theme) -> Vec<Line<'static>> {
    let mut r = Renderer { theme, max: max.max(8), ..Renderer::new(theme) };
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for ev in Parser::new_ext(md, opts) {
        r.event(ev);
    }
    r.flush();
    while r.out.last().is_some_and(|l| l.spans.iter().all(|s| s.content.trim().is_empty())) {
        r.out.pop();
    }
    r.out
}

struct ListLevel {
    next: Option<u64>,
    indent: usize,
}

struct Renderer<'t> {
    theme: &'t Theme,
    max: usize,
    out: Vec<Line<'static>>,
    cur: Vec<Span<'static>>,
    styles: Vec<Style>,
    lists: Vec<ListLevel>,
    marker: Option<String>,
    quote: usize,
    code: Option<String>,
    link: Option<String>,
    heading: Option<HeadingLevel>,
    need_blank: bool,
    table: Option<Table>,
}

#[derive(Default)]
struct Table {
    rows: Vec<Vec<String>>,
    cell: String,
    header_rows: usize,
}

impl<'t> Renderer<'t> {
    fn new(theme: &'t Theme) -> Self {
        Self {
            theme,
            max: 80,
            out: vec![],
            cur: vec![],
            styles: vec![Style::default()],
            lists: vec![],
            marker: None,
            quote: 0,
            code: None,
            link: None,
            heading: None,
            need_blank: false,
            table: None,
        }
    }

    fn style(&self) -> Style {
        *self.styles.last().unwrap_or(&Style::default())
    }

    fn push_style(&mut self, f: impl FnOnce(Style) -> Style) {
        let s = f(self.style());
        self.styles.push(s);
    }

    fn pop_style(&mut self) {
        if self.styles.len() > 1 {
            self.styles.pop();
        }
    }

    /// Prefix for the next line: quote bars, list indent, and the list marker
    /// on an item's first line.
    fn prefix(&mut self, first: bool) -> Vec<Span<'static>> {
        let mut p = vec![];
        if self.quote > 0 {
            p.push(Span::styled("│ ".repeat(self.quote), self.theme.dim()));
        }
        let n = self.lists.len();
        for (i, l) in self.lists.iter().enumerate() {
            if i + 1 < n {
                p.push(Span::raw(" ".repeat(l.indent)));
            }
        }
        if let Some(last) = self.lists.last() {
            match (&self.marker, first) {
                (Some(m), true) => p.push(Span::styled(m.clone(), self.theme.fg(self.theme.accent))),
                _ => p.push(Span::raw(" ".repeat(last.indent))),
            }
        }
        p
    }

    fn start_block(&mut self) {
        if self.need_blank && !self.out.is_empty() && self.lists.is_empty() {
            let p = self.prefix(false);
            self.out.push(Line::from(p));
        }
        self.need_blank = false;
    }

    fn flush(&mut self) {
        if self.cur.is_empty() {
            return;
        }
        let spans = std::mem::take(&mut self.cur);
        let first = self.prefix(true);
        let rest = self.prefix(false);
        self.marker = None;
        let lines = wrap_spans(&spans, self.max, &first, &rest);
        self.out.extend(lines);
    }

    fn text(&mut self, t: &str) {
        if let Some(code) = &mut self.code {
            code.push_str(t);
            return;
        }
        if let Some(tbl) = &mut self.table {
            tbl.cell.push_str(t);
            return;
        }
        let s = self.style();
        self.cur.push(Span::styled(t.to_string(), s));
    }

    fn event(&mut self, ev: Event) {
        match ev {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => self.text(&t),
            Event::Code(t) => {
                if let Some(tbl) = &mut self.table {
                    tbl.cell.push_str(&t);
                } else {
                    self.cur.push(Span::styled(t.to_string(), self.theme.fg(self.theme.code)));
                }
            }
            // Chat models mean a single newline as a line break.
            Event::SoftBreak => {
                if self.code.is_some() || self.table.is_some() {
                    self.text(" ");
                } else {
                    self.flush();
                }
            }
            Event::HardBreak => self.flush(),
            Event::Rule => {
                self.flush();
                self.start_block();
                self.out.push(Line::from(Span::styled("─".repeat(self.max.min(40)), self.theme.dim())));
                self.need_blank = true;
            }
            Event::TaskListMarker(done) => self.text(if done { "[x] " } else { "[ ] " }),
            Event::Html(t) | Event::InlineHtml(t) | Event::InlineMath(t) | Event::DisplayMath(t) => self.text(&t),
            Event::FootnoteReference(t) => self.text(&format!("[{t}]")),
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => {
                if self.lists.is_empty() || self.cur.is_empty() {
                    self.start_block();
                }
            }
            Tag::Heading { level, .. } => {
                self.flush();
                self.start_block();
                self.heading = Some(level);
                let c = self.theme.heading;
                self.push_style(|s| s.fg(c).add_modifier(Modifier::BOLD));
                if level <= HeadingLevel::H2 {
                    self.text(&format!("{} ", "#".repeat(level as usize)));
                }
            }
            Tag::BlockQuote(_) => {
                self.flush();
                self.start_block();
                self.quote += 1;
                self.push_style(|s| s.add_modifier(Modifier::ITALIC));
            }
            Tag::CodeBlock(kind) => {
                self.flush();
                self.start_block();
                let lang = match kind {
                    CodeBlockKind::Fenced(l) => l.split_whitespace().next().unwrap_or("").to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                if !lang.is_empty() {
                    let p = self.prefix(true);
                    self.marker = None;
                    let mut spans = p;
                    spans.push(Span::styled(format!("  {lang}"), self.theme.dim()));
                    self.out.push(Line::from(spans));
                }
                self.code = Some(String::new());
            }
            Tag::List(start) => {
                self.flush();
                if self.lists.is_empty() {
                    self.start_block();
                }
                let indent = if start.is_some() { 3 } else { 2 };
                self.lists.push(ListLevel { next: start, indent });
            }
            Tag::Item => {
                self.flush();
                if let Some(l) = self.lists.last_mut() {
                    let m = match l.next {
                        Some(n) => {
                            l.next = Some(n + 1);
                            format!("{n}. ")
                        }
                        None => "• ".to_string(),
                    };
                    l.indent = width(&m);
                    self.marker = Some(m);
                }
            }
            Tag::Emphasis => self.push_style(|s| s.add_modifier(Modifier::ITALIC)),
            Tag::Strong => self.push_style(|s| s.add_modifier(Modifier::BOLD)),
            Tag::Strikethrough => self.push_style(|s| s.add_modifier(Modifier::CROSSED_OUT)),
            Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => {
                self.link = Some(dest_url.to_string());
                let c = self.theme.link;
                self.push_style(|s| s.fg(c).add_modifier(Modifier::UNDERLINED));
            }
            Tag::Table(_) => {
                self.flush();
                self.start_block();
                self.table = Some(Table::default());
            }
            Tag::TableHead | Tag::TableRow => {
                if let Some(t) = &mut self.table {
                    t.rows.push(vec![]);
                }
            }
            Tag::TableCell => {
                if let Some(t) = &mut self.table {
                    t.cell.clear();
                }
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => {
                self.flush();
                self.need_blank = true;
            }
            TagEnd::Heading(_) => {
                self.flush();
                self.pop_style();
                self.heading = None;
                self.need_blank = true;
            }
            TagEnd::BlockQuote(_) => {
                self.flush();
                self.quote = self.quote.saturating_sub(1);
                self.pop_style();
                self.need_blank = true;
            }
            TagEnd::CodeBlock => {
                let code = self.code.take().unwrap_or_default();
                let style = self.theme.fg(self.theme.code);
                let mut prefix = self.prefix(false);
                prefix.push(Span::raw("  "));
                for line in code.trim_end_matches('\n').split('\n') {
                    self.out.extend(hard_wrap(line, style, self.max, &prefix));
                }
                self.need_blank = true;
            }
            TagEnd::List(_) => {
                self.flush();
                self.lists.pop();
                if self.lists.is_empty() {
                    self.need_blank = true;
                }
            }
            TagEnd::Item => self.flush(),
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => self.pop_style(),
            TagEnd::Link | TagEnd::Image => {
                self.pop_style();
                if let Some(url) = self.link.take() {
                    let shown: String = self.cur.iter().rev().take(1).map(|s| s.content.to_string()).collect();
                    if !url.is_empty() && shown != url && !url.starts_with('#') {
                        self.cur.push(Span::styled(format!(" ({url})"), self.theme.dim()));
                    }
                }
            }
            TagEnd::TableCell => {
                if let Some(t) = &mut self.table {
                    let cell = std::mem::take(&mut t.cell);
                    if let Some(row) = t.rows.last_mut() {
                        row.push(cell.trim().to_string());
                    }
                }
            }
            TagEnd::TableHead => {
                if let Some(t) = &mut self.table {
                    t.header_rows = t.rows.len();
                }
            }
            TagEnd::Table => {
                if let Some(t) = self.table.take() {
                    self.render_table(t);
                }
                self.need_blank = true;
            }
            _ => {}
        }
    }

    fn render_table(&mut self, t: Table) {
        let cols = t.rows.iter().map(Vec::len).max().unwrap_or(0);
        if cols == 0 {
            return;
        }
        let mut widths = vec![0usize; cols];
        for row in &t.rows {
            for (i, c) in row.iter().enumerate() {
                widths[i] = widths[i].max(width(c));
            }
        }
        // Shrink the widest columns until the row fits.
        let sep = 3;
        while widths.iter().sum::<usize>() + sep * (cols - 1) > self.max {
            let Some((i, w)) = widths.iter().enumerate().max_by_key(|(_, w)| **w).map(|(i, w)| (i, *w)) else { break };
            if w <= 4 {
                break;
            }
            widths[i] = w - 1;
        }
        let border = self.theme.dim();
        for (ri, row) in t.rows.iter().enumerate() {
            let mut spans = vec![];
            for (i, w) in widths.iter().enumerate() {
                if i > 0 {
                    spans.push(Span::styled(" │ ", border));
                }
                let cell = truncate(row.get(i).map(String::as_str).unwrap_or(""), *w);
                let pad = w.saturating_sub(width(&cell));
                let style = if ri < t.header_rows { Style::default().add_modifier(Modifier::BOLD) } else { Style::default() };
                spans.push(Span::styled(format!("{cell}{}", " ".repeat(pad)), style));
            }
            self.out.push(Line::from(spans));
            if ri + 1 == t.header_rows {
                let rule: Vec<String> = widths.iter().map(|w| "─".repeat(*w)).collect();
                self.out.push(Line::from(Span::styled(rule.join("─┼─"), border)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wrap::line_width;

    fn plain(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect()).collect()
    }

    #[test]
    fn renders_blocks() {
        let md = "# Title\n\nSome **bold**\ntext and `code`.\n\n- one\n- two\n  1. nested\n\n```rust\nfn main() {}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let theme = Theme::dark();
        let lines = render(md, 40, &theme);
        let text = plain(&lines);
        assert_eq!(text[0], "# Title");
        assert_eq!(text[1], "");
        assert_eq!(text[2], "Some bold");
        assert_eq!(text[3], "text and code.");
        assert!(text.contains(&"• one".to_string()), "{text:?}");
        assert!(text.contains(&"  1. nested".to_string()), "{text:?}");
        assert!(text.contains(&"  fn main() {}".to_string()), "{text:?}");
        assert!(text.contains(&"a │ b".to_string()), "{text:?}");
        assert!(lines.iter().all(|l| line_width(l) <= 40));
    }

    #[test]
    fn long_code_lines_wrap() {
        let md = format!("```\n{}\n```", "x".repeat(50));
        let lines = render(&md, 20, &Theme::dark());
        assert!(lines.len() >= 3);
        assert!(lines.iter().all(|l| line_width(l) <= 20));
    }
}
