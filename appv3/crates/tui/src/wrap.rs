//! Word wrapping for styled text. Every line it returns fits `width`
//! terminal cells, which the scrollback writer relies on.

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

#[cfg(test)]
pub fn line_width(line: &Line) -> usize {
    line.spans.iter().map(|s| width(&s.content)).sum()
}

/// Wrap `spans` to `max` cells. The first line starts with `first`, later
/// lines with `rest`. Long words are split.
pub fn wrap_spans(spans: &[Span<'static>], max: usize, first: &[Span<'static>], rest: &[Span<'static>]) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = vec![];
    let mut cur: Vec<Span<'static>> = first.to_vec();
    let mut cur_w = first.iter().map(|s| width(&s.content)).sum::<usize>();
    let mut has_text = false;
    let rest_w = rest.iter().map(|s| width(&s.content)).sum::<usize>();
    let push = |cur: &mut Vec<Span<'static>>, text: &str, style: Style| {
        if let Some(last) = cur.last_mut() {
            if last.style == style && !text.is_empty() {
                last.content = format!("{}{}", last.content, text).into();
                return;
            }
        }
        cur.push(Span::styled(text.to_string(), style));
    };
    for span in spans {
        for word in split_words(&span.content) {
            let ww = width(word);
            let is_space = word.chars().all(char::is_whitespace);
            if cur_w + ww <= max {
                if is_space && !has_text {
                    continue;
                }
                push(&mut cur, word, span.style);
                cur_w += ww;
                has_text |= !is_space;
                continue;
            }
            if is_space {
                // The break itself: start the next line.
                out.push(Line::from(std::mem::replace(&mut cur, rest.to_vec())));
                cur_w = rest_w;
                has_text = false;
                continue;
            }
            if has_text && ww <= max.saturating_sub(rest_w) {
                out.push(Line::from(std::mem::replace(&mut cur, rest.to_vec())));
                cur_w = rest_w;
                push(&mut cur, word, span.style);
                cur_w += ww;
                has_text = true;
                continue;
            }
            // A word longer than a line: start it on a fresh line, then split.
            if has_text {
                out.push(Line::from(std::mem::replace(&mut cur, rest.to_vec())));
                cur_w = rest_w;
                has_text = false;
            }
            for g in word.graphemes(true) {
                let gw = width(g);
                if cur_w + gw > max && has_text {
                    out.push(Line::from(std::mem::replace(&mut cur, rest.to_vec())));
                    cur_w = rest_w;
                }
                push(&mut cur, g, span.style);
                cur_w += gw;
                has_text = true;
            }
        }
    }
    if has_text || out.is_empty() {
        out.push(Line::from(cur));
    }
    for l in &mut out {
        trim_end(l);
    }
    out
}

/// Split by grapheme into lines no wider than `max`, without word logic
/// (code blocks).
pub fn hard_wrap(text: &str, style: Style, max: usize, prefix: &[Span<'static>]) -> Vec<Line<'static>> {
    let pw = prefix.iter().map(|s| width(&s.content)).sum::<usize>();
    let avail = max.saturating_sub(pw).max(1);
    let mut out = vec![];
    let mut buf = String::new();
    let mut w = 0;
    for g in text.graphemes(true) {
        let g = if g == "\t" { "    " } else { g };
        let gw = width(g);
        if w + gw > avail && !buf.is_empty() {
            let mut spans = prefix.to_vec();
            spans.push(Span::styled(std::mem::take(&mut buf), style));
            out.push(Line::from(spans));
            w = 0;
        }
        buf.push_str(g);
        w += gw;
    }
    let mut spans = prefix.to_vec();
    spans.push(Span::styled(buf, style));
    out.push(Line::from(spans));
    out
}

/// Cut `s` to at most `max` cells, adding `…` when it was longer.
pub fn truncate(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    let mut out = String::new();
    let mut w = 0;
    for g in s.graphemes(true) {
        let gw = width(g);
        if w + gw + 1 > max {
            break;
        }
        out.push_str(g);
        w += gw;
    }
    out.push('…');
    out
}

fn split_words(s: &str) -> Vec<&str> {
    let mut out = vec![];
    let mut start = 0;
    let mut prev_space: Option<bool> = None;
    for (i, c) in s.char_indices() {
        let sp = c.is_whitespace();
        if prev_space.is_some_and(|p| p != sp) {
            out.push(&s[start..i]);
            start = i;
        }
        prev_space = Some(sp);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn trim_end(line: &mut Line<'static>) {
    while let Some(last) = line.spans.last() {
        let t = last.content.trim_end().to_string();
        if t.is_empty() && line.spans.len() > 1 {
            line.spans.pop();
            continue;
        }
        if let Some(last) = line.spans.last_mut() {
            last.content = t.into();
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(l: &Line) -> String {
        l.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn wraps_words_and_splits_long_ones() {
        let spans = vec![Span::raw("hello brave new world abcdefghijkl")];
        let lines = wrap_spans(&spans, 10, &[Span::raw("> ")], &[Span::raw("  ")]);
        let got: Vec<String> = lines.iter().map(text).collect();
        assert_eq!(got, vec!["> hello", "  brave", "  new", "  world", "  abcdefgh", "  ijkl"]);
        assert!(lines.iter().all(|l| line_width(l) <= 10));
    }

    #[test]
    fn wide_chars_fit() {
        let lines = wrap_spans(&[Span::raw("日本語のテキスト")], 6, &[], &[]);
        assert!(lines.iter().all(|l| line_width(l) <= 6), "{lines:?}");
        assert_eq!(truncate("abcdef", 4), "abc…");
    }
}
