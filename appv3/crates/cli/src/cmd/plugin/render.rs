//! Styled output lines and the text helpers every message goes through.
//!
//! What a plugin supplies is untrusted text, and the summary is what the user
//! approves an install on: it reaches the terminal only through [`exact`] and
//! [`inline`], which show control and direction-changing characters as
//! escapes instead of acting on them.

use crate::ui::{bold, dim, green, red, yellow};

// ── styled lines ────────────────────────────────────────────────────────────
//
// Output is built as lines of toned spans and painted only when printed, so
// the formatting is testable as plain text whatever the terminal is.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Tone {
    Plain,
    Bold,
    Dim,
    Good,
    Warn,
    Bad,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Span(Tone, String);

pub(super) type Line = Vec<Span>;

pub(super) fn sp(tone: Tone, text: impl Into<String>) -> Span {
    Span(tone, text.into())
}

pub(super) fn ind(n: usize) -> Span {
    sp(Tone::Plain, " ".repeat(n))
}

pub(super) fn blank() -> Line {
    vec![]
}

/// `  Title`: a section heading.
pub(super) fn heading(title: &str) -> Line {
    vec![ind(2), sp(Tone::Bold, title)]
}

/// An entry under a heading.
pub(super) fn item(tone: Tone, text: impl Into<String>) -> Line {
    vec![ind(4), sp(tone, text)]
}

/// `  ✓  text`, like the checks of `agentd doctor`.
pub(super) fn verdict(tone: Tone, glyph: &str, text: &str) -> Line {
    vec![ind(2), sp(tone, glyph), sp(Tone::Plain, format!("  {text}"))]
}

/// `✗ text` or `⚠ text` under a row; `text` is free text from outside.
pub(super) fn note(indent: usize, tone: Tone, glyph: &str, text: &str) -> Line {
    vec![ind(indent), sp(tone, glyph), sp(Tone::Plain, format!(" {}", inline(text, 400)))]
}

/// `line` without trailing whitespace: padding must not leave spaces after the last word.
fn trimmed(line: &[Span]) -> Line {
    let mut out: Line = line.to_vec();
    while let Some(Span(_, text)) = out.last_mut() {
        text.truncate(text.trim_end().len());
        if !text.is_empty() {
            break;
        }
        out.pop();
    }
    out
}

fn paint(line: &[Span]) -> String {
    trimmed(line)
        .iter()
        .map(|Span(tone, text)| match tone {
            Tone::Plain => text.clone(),
            Tone::Bold => bold(text),
            Tone::Dim => dim(text),
            Tone::Good => green(text),
            Tone::Warn => yellow(text),
            Tone::Bad => red(text),
        })
        .collect()
}

pub(super) fn emit(lines: &[Line]) {
    for l in lines {
        println!("{}", paint(l));
    }
}

#[cfg(test)]
pub(super) fn plain_text(lines: &[Line]) -> Vec<String> {
    lines.iter().map(|l| trimmed(l).iter().map(|Span(_, t)| t.as_str()).collect()).collect()
}

// ── untrusted text ──────────────────────────────────────────────────────────

/// Zero-width and direction-changing formatting characters: they can reorder
/// or hide text without being visible themselves.
fn is_format_char(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// `s` with every control and formatting character shown as an escape
/// (`\n`, `\u{1b}`), for what must be read exactly, such as a command line.
pub(super) fn exact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_control() || is_format_char(c) {
            out.extend(c.escape_default());
        } else {
            out.push(c);
        }
    }
    out
}

/// `s` on one line of at most `max` characters, for free text (a
/// description, a reason): control characters become spaces and formatting
/// characters are dropped, so nothing in it reaches the terminal as a command.
pub(super) fn inline(s: &str, max: usize) -> String {
    let spaced: String = s.chars().filter(|c| !is_format_char(*c)).map(|c| if c.is_control() { ' ' } else { c }).collect();
    let one = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > max {
        format!("{}…", one.chars().take(max).collect::<String>())
    } else {
        one
    }
}

/// `s` as one shell word, quoted only when it needs it, so a command line
/// shows its arguments exactly.
pub(super) fn shell_word(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

pub(super) fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// `s` cut to `max` characters, with an ellipsis when cut.
pub(super) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s.to_string()
    }
}

pub(super) fn pad(s: &str, width: usize) -> String {
    format!("{s}{}", " ".repeat(width.saturating_sub(s.chars().count())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_text_cannot_drive_the_terminal() {
        assert_eq!(exact("a\u{1b}[31mb\nc\u{202e}d\u{200b}e\u{7f}"), r"a\u{1b}[31mb\nc\u{202e}d\u{200b}e\u{7f}");
        assert_eq!(exact("plain ünïcode ✓"), "plain ünïcode ✓");
        assert_eq!(inline("a\u{1b}[2Jb\r\n\tc\u{200b}d", 80), "a [2Jb cd");
        assert_eq!(inline("  spaced   out  ", 80), "spaced out");
        assert_eq!(inline(&"x".repeat(50), 10), format!("{}…", "x".repeat(10)));
        assert_eq!(inline("short", 10), "short");
    }

    #[test]
    fn commands_show_their_exact_arguments() {
        for (arg, shown) in [
            ("npx", "npx"),
            ("-y", "-y"),
            ("@scope/pkg@1.2", "@scope/pkg@1.2"),
            ("--flag=a,b:c", "--flag=a,b:c"),
            ("two words", "'two words'"),
            ("it's", r"'it'\''s'"),
            ("", "''"),
            ("$HOME", "'$HOME'"),
            ("a;b", "'a;b'"),
        ] {
            assert_eq!(shell_word(arg), shown, "{arg:?}");
        }
    }
}
