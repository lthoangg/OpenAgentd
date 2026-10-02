//! Multi-line prompt editor with prompt history.

use unicode_width::UnicodeWidthChar;

#[derive(Default)]
pub struct Editor {
    lines: Vec<String>,
    row: usize,
    /// Cursor column in chars.
    col: usize,
    history: Vec<String>,
    /// Index into `history` while browsing it; `None` = editing the draft.
    browsing: Option<usize>,
    draft: String,
}

fn byte_at(s: &str, col: usize) -> usize {
    s.char_indices().nth(col).map(|(i, _)| i).unwrap_or(s.len())
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

impl Editor {
    pub fn new(history: Vec<String>) -> Self {
        Self { lines: vec![String::new()], history, ..Default::default() }
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    pub fn is_empty(&self) -> bool {
        self.lines.iter().all(|l| l.is_empty())
    }

    pub fn set_text(&mut self, text: &str) {
        self.lines = text.split('\n').map(String::from).collect();
        self.row = self.lines.len() - 1;
        self.col = char_len(&self.lines[self.row]);
    }

    pub fn clear(&mut self) {
        self.set_text("");
        self.browsing = None;
    }

    pub fn push_history(&mut self, entry: &str) {
        if self.history.last().map(String::as_str) != Some(entry) {
            self.history.push(entry.to_string());
        }
        self.browsing = None;
    }

    fn line(&mut self) -> &mut String {
        &mut self.lines[self.row]
    }

    pub fn insert_str(&mut self, s: &str) {
        let s = s.replace("\r\n", "\n").replace('\r', "\n");
        for (i, part) in s.split('\n').enumerate() {
            if i > 0 {
                self.newline();
            }
            let col = self.col;
            let line = self.line();
            let b = byte_at(line, col);
            line.insert_str(b, part);
            self.col += char_len(part);
        }
    }

    pub fn newline(&mut self) {
        let col = self.col;
        let line = self.line();
        let b = byte_at(line, col);
        let rest = line.split_off(b);
        self.lines.insert(self.row + 1, rest);
        self.row += 1;
        self.col = 0;
    }

    pub fn backspace(&mut self) {
        if self.col > 0 {
            let col = self.col;
            let line = self.line();
            let b = byte_at(line, col - 1);
            line.remove(b);
            self.col -= 1;
        } else if self.row > 0 {
            let cur = self.lines.remove(self.row);
            self.row -= 1;
            self.col = char_len(&self.lines[self.row]);
            self.lines[self.row].push_str(&cur);
        }
    }

    pub fn delete(&mut self) {
        let col = self.col;
        let len = char_len(&self.lines[self.row]);
        if col < len {
            let line = self.line();
            let b = byte_at(line, col);
            line.remove(b);
        } else if self.row + 1 < self.lines.len() {
            let next = self.lines.remove(self.row + 1);
            self.line().push_str(&next);
        }
    }

    pub fn left(&mut self) {
        if self.col > 0 {
            self.col -= 1;
        } else if self.row > 0 {
            self.row -= 1;
            self.col = char_len(&self.lines[self.row]);
        }
    }

    pub fn right(&mut self) {
        if self.col < char_len(&self.lines[self.row]) {
            self.col += 1;
        } else if self.row + 1 < self.lines.len() {
            self.row += 1;
            self.col = 0;
        }
    }

    pub fn home(&mut self) {
        self.col = 0;
    }

    pub fn end(&mut self) {
        self.col = char_len(&self.lines[self.row]);
    }

    pub fn word_left(&mut self) {
        let chars: Vec<char> = self.lines[self.row].chars().collect();
        let mut c = self.col;
        while c > 0 && chars[c - 1].is_whitespace() {
            c -= 1;
        }
        while c > 0 && !chars[c - 1].is_whitespace() {
            c -= 1;
        }
        if c == self.col && self.col == 0 {
            self.left();
        } else {
            self.col = c;
        }
    }

    pub fn word_right(&mut self) {
        let chars: Vec<char> = self.lines[self.row].chars().collect();
        let mut c = self.col;
        while c < chars.len() && chars[c].is_whitespace() {
            c += 1;
        }
        while c < chars.len() && !chars[c].is_whitespace() {
            c += 1;
        }
        if c == self.col {
            self.right();
        } else {
            self.col = c;
        }
    }

    /// Ctrl+W: delete the word before the cursor.
    pub fn delete_word(&mut self) {
        let end = self.col;
        self.word_left();
        if self.row < self.lines.len() && self.col < end {
            let (s, e) = (self.col, end);
            let line = self.line();
            let (bs, be) = (byte_at(line, s), byte_at(line, e));
            line.replace_range(bs..be, "");
        }
    }

    /// Ctrl+U: delete to the start of the line.
    pub fn delete_to_start(&mut self) {
        let col = self.col;
        let line = self.line();
        let b = byte_at(line, col);
        line.replace_range(..b, "");
        self.col = 0;
    }

    /// Ctrl+K: delete to the end of the line.
    pub fn delete_to_end(&mut self) {
        let col = self.col;
        let line = self.line();
        let b = byte_at(line, col);
        line.truncate(b);
    }

    /// Up: move a line up, or show the previous prompt from the first line.
    pub fn up(&mut self) {
        if self.row > 0 {
            self.row -= 1;
            self.col = self.col.min(char_len(&self.lines[self.row]));
            return;
        }
        let next = match self.browsing {
            None if !self.history.is_empty() => {
                self.draft = self.text();
                self.history.len() - 1
            }
            Some(i) if i > 0 => i - 1,
            _ => return,
        };
        self.browsing = Some(next);
        let entry = self.history[next].clone();
        self.set_text(&entry);
        self.row = 0;
        self.col = self.col.min(char_len(&self.lines[0]));
    }

    /// Down: move a line down, or step forward through prompt history.
    pub fn down(&mut self) {
        if self.row + 1 < self.lines.len() {
            self.row += 1;
            self.col = self.col.min(char_len(&self.lines[self.row]));
            return;
        }
        match self.browsing {
            Some(i) if i + 1 < self.history.len() => {
                self.browsing = Some(i + 1);
                let entry = self.history[i + 1].clone();
                self.set_text(&entry);
            }
            Some(_) => {
                self.browsing = None;
                let draft = std::mem::take(&mut self.draft);
                self.set_text(&draft);
            }
            None => {}
        }
    }

    /// The word ending at the cursor: `(start column, text)`.
    pub fn token(&self) -> (usize, String) {
        let chars: Vec<char> = self.lines[self.row].chars().take(self.col).collect();
        let start = chars.iter().rposition(|c| c.is_whitespace()).map(|i| i + 1).unwrap_or(0);
        (start, chars[start..].iter().collect())
    }

    /// Replace the token from `start` to the cursor with `with`.
    pub fn replace_token(&mut self, start: usize, with: &str) {
        let col = self.col;
        let line = self.line();
        let (bs, be) = (byte_at(line, start), byte_at(line, col));
        line.replace_range(bs..be, with);
        self.col = start + char_len(with);
    }

    pub fn on_first_line(&self) -> bool {
        self.row == 0
    }

    /// Visual lines wrapped to `width` cells, and the cursor's (x, y) in them.
    pub fn layout(&self, width: usize) -> (Vec<String>, (u16, u16)) {
        let width = width.max(1);
        let mut out = vec![];
        let mut cursor = (0u16, 0u16);
        for (r, line) in self.lines.iter().enumerate() {
            let mut cur = String::new();
            let mut w = 0;
            for (c, ch) in line.chars().enumerate() {
                let cw = ch.width().unwrap_or(0);
                if w + cw > width {
                    out.push(std::mem::take(&mut cur));
                    w = 0;
                }
                if r == self.row && c == self.col {
                    cursor = (w as u16, out.len() as u16);
                }
                cur.push(ch);
                w += cw;
            }
            if r == self.row && self.col >= char_len(line) {
                if w >= width {
                    out.push(std::mem::take(&mut cur));
                    w = 0;
                }
                cursor = (w as u16, out.len() as u16);
            }
            out.push(cur);
        }
        (out, cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_lines_and_history() {
        let mut e = Editor::new(vec!["old prompt".into()]);
        e.insert_str("héllo\r\nwörld");
        assert_eq!(e.text(), "héllo\nwörld");
        e.backspace();
        e.left();
        e.newline();
        assert_eq!(e.text(), "héllo\nwör\nl");
        e.up();
        e.up();
        assert_eq!(e.text(), "héllo\nwör\nl", "moving up through lines first");
        e.up();
        assert_eq!(e.text(), "old prompt");
        e.down();
        assert_eq!(e.text(), "héllo\nwör\nl", "down restores the draft");
        let (start, tok) = {
            e.clear();
            e.insert_str("see @src/ma");
            e.token()
        };
        assert_eq!((start, tok.as_str()), (4, "@src/ma"));
        e.replace_token(start, "@src/main.rs ");
        assert_eq!(e.text(), "see @src/main.rs ");
        e.delete_word();
        assert_eq!(e.text(), "see ");
    }

    #[test]
    fn layout_wraps_and_places_cursor() {
        let mut e = Editor::new(vec![]);
        e.insert_str("abcdef");
        let (lines, cur) = e.layout(4);
        assert_eq!(lines, vec!["abcd", "ef"]);
        assert_eq!(cur, (2, 1));
        e.insert_str("gh");
        let (lines, cur) = e.layout(4);
        assert_eq!(lines, vec!["abcd", "efgh", ""]);
        assert_eq!(cur, (0, 2));
    }
}
