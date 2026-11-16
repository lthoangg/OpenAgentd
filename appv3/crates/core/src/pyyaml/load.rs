//! `yaml.safe_load(text)` — a line-by-line port of PyYAML 6.0.3's pure-Python
//! `SafeLoader` (Reader, Scanner, Parser, Composer, Resolver, SafeConstructor).
//!
//! YAML 1.1 semantics (yes/no/on/off booleans, `0o`-less octals, sexagesimal
//! numbers, `<<` merge keys, timestamps), acceptance quirks and error texts
//! (`MarkedYAMLError.__str__` with snippets) all follow PyYAML. Non-YAML
//! exceptions PyYAML lets escape (`ValueError` from a bad timestamp, `KeyError`
//! from `!!bool foo`, …) are reported with their Python class in [`LoadError::kind`].

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::OnceLock;

type R<T> = Result<T, LoadError>;

/// A failed `safe_load`: `kind` is the Python exception class name, `message`
/// is `str(exc)`.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadError {
    pub kind: &'static str,
    pub message: String,
}

impl LoadError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        LoadError { kind, message: message.into() }
    }
    /// Would `except yaml.YAMLError` catch it?
    pub fn is_yaml_error(&self) -> bool {
        matches!(self.kind, "ReaderError" | "ScannerError" | "ParserError" | "ComposerError" | "ConstructorError")
    }
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LoadError {}

/// A timezone-aware or naive `datetime.datetime`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PyDateTime {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub microsecond: i64,
    /// UTC offset in seconds (`None` = naive).
    pub offset: Option<i64>,
}

impl PyDateTime {
    /// `datetime.isoformat()`.
    pub fn isoformat(&self) -> String {
        let mut s = format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", self.year, self.month, self.day, self.hour, self.minute, self.second);
        if self.microsecond != 0 {
            s.push_str(&format!(".{:06}", self.microsecond));
        }
        if let Some(off) = self.offset {
            let sign = if off < 0 { '-' } else { '+' };
            let a = off.abs();
            s.push_str(&format!("{sign}{:02}:{:02}", a / 3600, (a % 3600) / 60));
        }
        s
    }
    fn utc_seconds(&self) -> i64 {
        days_from_civil(self.year, self.month, self.day) * 86400 + self.hour * 3600 + self.minute * 60 + self.second - self.offset.unwrap_or(0)
    }
}

/// The Python object `yaml.safe_load` returns (aliases are expanded).
#[derive(Debug, Clone, PartialEq)]
pub enum Py {
    None,
    Bool(bool),
    Int(i128),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
    Date(i64, i64, i64),
    DateTime(PyDateTime),
    List(Vec<Py>),
    /// `(key, value)` tuples (inside `!!omap` / `!!pairs` lists).
    Tuple(Vec<Py>),
    Set(Vec<Py>),
    Dict(Vec<(Py, Py)>),
}

// ── marks & errors ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct Mark {
    index: usize,
    line: usize,
    column: usize,
}

const NAME: &str = "<unicode string>";

fn is_in(c: char, set: &str) -> bool {
    set.contains(c)
}

const Z_BLANK: &str = "\0 \t\r\n\u{85}\u{2028}\u{2029}";
const Z_SPACE: &str = "\0 \r\n\u{85}\u{2028}\u{2029}";
const Z_BREAK: &str = "\0\r\n\u{85}\u{2028}\u{2029}";
const BREAK: &str = "\r\n\u{85}\u{2028}\u{2029}";

/// Python `str.isprintable()` (approximation of the Unicode tables for the
/// characters PyYAML's reader lets through).
fn py_printable(c: char) -> bool {
    let u = c as u32;
    !(u < 0x20
        || (0x7f..=0xa0).contains(&u)
        || u == 0xad
        || (0x600..=0x605).contains(&u)
        || u == 0x61c
        || u == 0x6dd
        || u == 0x70f
        || u == 0x1680
        || u == 0x180e
        || (0x2000..=0x200f).contains(&u)
        || (0x2028..=0x202f).contains(&u)
        || (0x205f..=0x2064).contains(&u)
        || (0x2066..=0x206f).contains(&u)
        || u == 0x3000
        || (0xd800..=0xf8ff).contains(&u)
        || u == 0xfeff
        || (0xfff9..=0xfffb).contains(&u)
        || u == 0xfffe
        || u == 0xffff
        || (0xe0000..=0xe007f).contains(&u)
        || u >= 0xf0000)
}

/// Python `repr(str)`.
pub(crate) fn py_repr(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if py_printable(c) => out.push(c),
            c if (c as u32) < 0x100 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if (c as u32) < 0x10000 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push_str(&format!("\\U{:08x}", c as u32)),
        }
    }
    out.push(q);
    out
}

// ── tokens / events / nodes ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Tok {
    StreamStart,
    StreamEnd,
    Directive(String, Option<DirValue>),
    DocumentStart,
    DocumentEnd,
    BlockSequenceStart,
    BlockMappingStart,
    BlockEnd,
    FlowSequenceStart,
    FlowMappingStart,
    FlowSequenceEnd,
    FlowMappingEnd,
    Key,
    Value,
    BlockEntry,
    FlowEntry,
    Alias(String),
    Anchor(String),
    Tag(Option<String>, String),
    Scalar(String, bool),
}

#[derive(Debug, Clone)]
enum DirValue {
    Yaml(u128, u128),
    Tag(String, String),
}

#[derive(Debug, Clone)]
struct Token {
    tok: Tok,
    start: Mark,
    end: Mark,
}

impl Token {
    fn id(&self) -> &'static str {
        match self.tok {
            Tok::StreamStart => "<stream start>",
            Tok::StreamEnd => "<stream end>",
            Tok::Directive(..) => "<directive>",
            Tok::DocumentStart => "<document start>",
            Tok::DocumentEnd => "<document end>",
            Tok::BlockSequenceStart => "<block sequence start>",
            Tok::BlockMappingStart => "<block mapping start>",
            Tok::BlockEnd => "<block end>",
            Tok::FlowSequenceStart => "[",
            Tok::FlowMappingStart => "{",
            Tok::FlowSequenceEnd => "]",
            Tok::FlowMappingEnd => "}",
            Tok::Key => "?",
            Tok::Value => ":",
            Tok::BlockEntry => "-",
            Tok::FlowEntry => ",",
            Tok::Alias(_) => "<alias>",
            Tok::Anchor(_) => "<anchor>",
            Tok::Tag(..) => "<tag>",
            Tok::Scalar(..) => "<scalar>",
        }
    }
}

#[derive(Debug, Clone)]
enum Ev {
    StreamStart,
    StreamEnd,
    DocumentStart,
    DocumentEnd,
    Alias(String),
    Scalar { anchor: Option<String>, tag: Option<String>, implicit: (bool, bool), value: String },
    SequenceStart { anchor: Option<String>, tag: Option<String> },
    SequenceEnd,
    MappingStart { anchor: Option<String>, tag: Option<String> },
    MappingEnd,
}

#[derive(Debug, Clone)]
struct Event {
    ev: Ev,
    start: Mark,
}

#[derive(Debug, Clone)]
enum NodeValue {
    Scalar(String),
    Seq(Vec<usize>),
    Map(Vec<(usize, usize)>),
}

#[derive(Debug, Clone)]
struct Node {
    tag: String,
    value: NodeValue,
    start: Mark,
}

impl Node {
    fn id(&self) -> &'static str {
        match self.value {
            NodeValue::Scalar(_) => "scalar",
            NodeValue::Seq(_) => "sequence",
            NodeValue::Map(_) => "mapping",
        }
    }
}

struct SimpleKey {
    token_number: usize,
    required: bool,
    index: usize,
    line: usize,
    column: usize,
    mark: Mark,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum St {
    StreamStart,
    ImplicitDocumentStart,
    DocumentStart,
    DocumentEnd,
    DocumentContent,
    BlockNode,
    BlockSequenceFirstEntry,
    BlockSequenceEntry,
    IndentlessSequenceEntry,
    BlockMappingFirstKey,
    BlockMappingKey,
    BlockMappingValue,
    FlowSequenceFirstEntry,
    FlowSequenceEntry,
    FlowSequenceEntryMappingKey,
    FlowSequenceEntryMappingValue,
    FlowSequenceEntryMappingEnd,
    FlowMappingFirstKey,
    FlowMappingKey,
    FlowMappingValue,
    FlowMappingEmptyValue,
}

const TAG_PREFIX: &str = "tag:yaml.org,2002:";
/// CPython's default recursion limit lets PyYAML compose ~494 nested flow nodes
/// (block nesting a few fewer — frame counts differ; see REPORT.md §3, "YAML loading").
const MAX_DEPTH: usize = 494;

struct Loader {
    // reader
    buf: Vec<char>,
    pointer: usize,
    line: usize,
    column: usize,
    // scanner
    done: bool,
    flow_level: i64,
    tokens: VecDeque<Token>,
    tokens_taken: usize,
    indent: i64,
    indents: Vec<i64>,
    allow_simple_key: bool,
    possible_simple_keys: BTreeMap<i64, SimpleKey>,
    // parser
    current_event: Option<Event>,
    tag_handles: Vec<(String, String)>,
    states: Vec<St>,
    marks: Vec<Mark>,
    state: Option<St>,
    // composer
    anchors: HashMap<String, usize>,
    nodes: Vec<Node>,
    depth: usize,
}

fn default_tags() -> Vec<(String, String)> {
    vec![("!".into(), "!".into()), ("!!".into(), TAG_PREFIX.into())]
}

impl Loader {
    fn new(text: &str) -> R<Self> {
        let mut buf: Vec<char> = text.chars().collect();
        if let Some(pos) = buf.iter().position(|&c| {
            let u = c as u32;
            !(c == '\t' || c == '\n' || c == '\r' || (0x20..=0x7e).contains(&u) || u == 0x85 || (0xa0..=0xd7ff).contains(&u) || (0xe000..=0xfffd).contains(&u) || u >= 0x10000)
        }) {
            return Err(LoadError::new(
                "ReaderError",
                format!("unacceptable character #x{:04x}: special characters are not allowed\n  in \"{NAME}\", position {pos}", buf[pos] as u32),
            ));
        }
        buf.push('\0');
        let mut l = Loader {
            buf,
            pointer: 0,
            line: 0,
            column: 0,
            done: false,
            flow_level: 0,
            tokens: VecDeque::new(),
            tokens_taken: 0,
            indent: -1,
            indents: vec![],
            allow_simple_key: true,
            possible_simple_keys: BTreeMap::new(),
            current_event: None,
            tag_handles: vec![],
            states: vec![],
            marks: vec![],
            state: Some(St::StreamStart),
            anchors: HashMap::new(),
            nodes: vec![],
            depth: 0,
        };
        let m = l.mark();
        l.tokens.push_back(Token { tok: Tok::StreamStart, start: m, end: m });
        Ok(l)
    }

    // ── reader ──

    fn peek(&self, i: usize) -> char {
        self.buf.get(self.pointer + i).copied().unwrap_or('\0')
    }
    fn ch(&self) -> char {
        self.peek(0)
    }
    fn prefix(&self, n: usize) -> String {
        let end = (self.pointer + n).min(self.buf.len());
        self.buf[self.pointer.min(end)..end].iter().collect()
    }
    fn forward(&mut self, n: usize) {
        for _ in 0..n {
            let Some(&c) = self.buf.get(self.pointer) else { return };
            self.pointer += 1;
            if is_in(c, "\n\u{85}\u{2028}\u{2029}") || (c == '\r' && self.ch() != '\n') {
                self.line += 1;
                self.column = 0;
            } else if c != '\u{feff}' {
                self.column += 1;
            }
        }
    }
    fn mark(&self) -> Mark {
        Mark { index: self.pointer, line: self.line, column: self.column }
    }

    // ── errors ──

    fn mark_str(&self, m: Mark) -> String {
        let mut head = "";
        let mut start = m.index;
        while start > 0 && !is_in(self.buf[start - 1], Z_BREAK) {
            start -= 1;
            if (m.index - start) as f64 > 75.0 / 2.0 - 1.0 {
                head = " ... ";
                start += 5;
                break;
            }
        }
        let mut tail = "";
        let mut end = m.index;
        while end < self.buf.len() && !is_in(self.buf[end], Z_BREAK) {
            end += 1;
            if (end - m.index) as f64 > 75.0 / 2.0 - 1.0 {
                tail = " ... ";
                end -= 5;
                break;
            }
        }
        let snippet: String = if start < end { self.buf[start..end].iter().collect() } else { String::new() };
        format!("  in \"{NAME}\", line {}, column {}:\n    {head}{snippet}{tail}\n{}^", m.line + 1, m.column + 1, " ".repeat(4 + m.index - start + head.chars().count()))
    }

    fn marked(&self, kind: &'static str, context: Option<&str>, cmark: Option<Mark>, problem: Option<String>, pmark: Option<Mark>) -> LoadError {
        let mut lines: Vec<String> = vec![];
        if let Some(c) = context {
            lines.push(c.to_string());
        }
        if let Some(cm) = cmark {
            let differ = match (&problem, pmark) {
                (Some(_), Some(pm)) => cm.line != pm.line || cm.column != pm.column,
                _ => true,
            };
            if differ {
                lines.push(self.mark_str(cm));
            }
        }
        if let Some(p) = problem {
            lines.push(p);
        }
        if let Some(pm) = pmark {
            lines.push(self.mark_str(pm));
        }
        LoadError::new(kind, lines.join("\n"))
    }

    fn scan_err(&self, context: Option<&str>, cmark: Option<Mark>, problem: String) -> LoadError {
        self.marked("ScannerError", context, cmark, Some(problem), Some(self.mark()))
    }

    // ── scanner: public-ish ──

    fn check_token(&mut self, ids: &[&str]) -> R<bool> {
        while self.need_more_tokens()? {
            self.fetch_more_tokens()?;
        }
        Ok(match self.tokens.front() {
            Some(t) => ids.is_empty() || ids.contains(&t.id()),
            None => false,
        })
    }

    fn peek_token(&mut self) -> R<&Token> {
        while self.need_more_tokens()? {
            self.fetch_more_tokens()?;
        }
        Ok(self.tokens.front().expect("token queue ends with STREAM-END"))
    }

    fn get_token(&mut self) -> R<Token> {
        while self.need_more_tokens()? {
            self.fetch_more_tokens()?;
        }
        self.tokens_taken += 1;
        Ok(self.tokens.pop_front().expect("token queue ends with STREAM-END"))
    }

    fn need_more_tokens(&mut self) -> R<bool> {
        if self.done {
            return Ok(false);
        }
        if self.tokens.is_empty() {
            return Ok(true);
        }
        self.stale_possible_simple_keys()?;
        Ok(self.next_possible_simple_key() == Some(self.tokens_taken))
    }

    fn fetch_more_tokens(&mut self) -> R<()> {
        self.scan_to_next_token();
        self.stale_possible_simple_keys()?;
        self.unwind_indent(self.column as i64);
        let ch = self.ch();
        match ch {
            '\0' => return self.fetch_stream_end(),
            '%' if self.column == 0 => return self.fetch_directive(),
            '-' if self.check_document_indicator("---") => return self.fetch_document_indicator(Tok::DocumentStart),
            '.' if self.check_document_indicator("...") => return self.fetch_document_indicator(Tok::DocumentEnd),
            '[' => return self.fetch_flow_collection_start(Tok::FlowSequenceStart),
            '{' => return self.fetch_flow_collection_start(Tok::FlowMappingStart),
            ']' => return self.fetch_flow_collection_end(Tok::FlowSequenceEnd),
            '}' => return self.fetch_flow_collection_end(Tok::FlowMappingEnd),
            ',' => return self.fetch_flow_entry(),
            _ => {}
        }
        let next_blank = is_in(self.peek(1), Z_BLANK);
        if ch == '-' && next_blank {
            return self.fetch_block_entry();
        }
        if ch == '?' && (self.flow_level != 0 || next_blank) {
            return self.fetch_key();
        }
        if ch == ':' && (self.flow_level != 0 || next_blank) {
            return self.fetch_value();
        }
        match ch {
            '*' => return self.fetch_anchor(true),
            '&' => return self.fetch_anchor(false),
            '!' => return self.fetch_tag(),
            '|' if self.flow_level == 0 => return self.fetch_block_scalar(false),
            '>' if self.flow_level == 0 => return self.fetch_block_scalar(true),
            '\'' => return self.fetch_flow_scalar(false),
            '"' => return self.fetch_flow_scalar(true),
            _ => {}
        }
        if self.check_plain() {
            return self.fetch_plain();
        }
        Err(self.scan_err(Some("while scanning for the next token"), None, format!("found character {} that cannot start any token", py_repr(&ch.to_string()))))
    }

    // ── simple keys ──

    fn next_possible_simple_key(&self) -> Option<usize> {
        self.possible_simple_keys.values().map(|k| k.token_number).min()
    }

    fn stale_possible_simple_keys(&mut self) -> R<()> {
        let levels: Vec<i64> = self.possible_simple_keys.keys().copied().collect();
        for level in levels {
            let key = &self.possible_simple_keys[&level];
            if key.line != self.line || self.pointer - key.index > 1024 {
                if key.required {
                    return Err(self.scan_err(Some("while scanning a simple key"), Some(key.mark), "could not find expected ':'".into()));
                }
                self.possible_simple_keys.remove(&level);
            }
        }
        Ok(())
    }

    fn save_possible_simple_key(&mut self) -> R<()> {
        let required = self.flow_level == 0 && self.indent == self.column as i64;
        if self.allow_simple_key {
            self.remove_possible_simple_key()?;
            let token_number = self.tokens_taken + self.tokens.len();
            let key = SimpleKey { token_number, required, index: self.pointer, line: self.line, column: self.column, mark: self.mark() };
            self.possible_simple_keys.insert(self.flow_level, key);
        }
        Ok(())
    }

    fn remove_possible_simple_key(&mut self) -> R<()> {
        if let Some(key) = self.possible_simple_keys.get(&self.flow_level) {
            if key.required {
                return Err(self.scan_err(Some("while scanning a simple key"), Some(key.mark), "could not find expected ':'".into()));
            }
            self.possible_simple_keys.remove(&self.flow_level);
        }
        Ok(())
    }

    // ── indentation ──

    fn unwind_indent(&mut self, column: i64) {
        if self.flow_level != 0 {
            return;
        }
        while self.indent > column {
            let m = self.mark();
            self.indent = self.indents.pop().unwrap_or(-1);
            self.tokens.push_back(Token { tok: Tok::BlockEnd, start: m, end: m });
        }
    }

    fn add_indent(&mut self, column: i64) -> bool {
        if self.indent < column {
            self.indents.push(self.indent);
            self.indent = column;
            return true;
        }
        false
    }

    // ── fetchers ──

    fn push_simple(&mut self, tok: Tok, len: usize) {
        let start = self.mark();
        self.forward(len);
        let end = self.mark();
        self.tokens.push_back(Token { tok, start, end });
    }

    fn fetch_stream_end(&mut self) -> R<()> {
        self.unwind_indent(-1);
        self.remove_possible_simple_key()?;
        self.allow_simple_key = false;
        self.possible_simple_keys.clear();
        let m = self.mark();
        self.tokens.push_back(Token { tok: Tok::StreamEnd, start: m, end: m });
        self.done = true;
        Ok(())
    }

    fn fetch_directive(&mut self) -> R<()> {
        self.unwind_indent(-1);
        self.remove_possible_simple_key()?;
        self.allow_simple_key = false;
        let t = self.scan_directive()?;
        self.tokens.push_back(t);
        Ok(())
    }

    fn check_document_indicator(&self, ind: &str) -> bool {
        self.column == 0 && self.prefix(3) == ind && is_in(self.peek(3), Z_BLANK)
    }

    fn fetch_document_indicator(&mut self, tok: Tok) -> R<()> {
        self.unwind_indent(-1);
        self.remove_possible_simple_key()?;
        self.allow_simple_key = false;
        self.push_simple(tok, 3);
        Ok(())
    }

    fn fetch_flow_collection_start(&mut self, tok: Tok) -> R<()> {
        self.save_possible_simple_key()?;
        self.flow_level += 1;
        self.allow_simple_key = true;
        self.push_simple(tok, 1);
        Ok(())
    }

    fn fetch_flow_collection_end(&mut self, tok: Tok) -> R<()> {
        self.remove_possible_simple_key()?;
        // Python lets flow_level go negative on a stray ']' / '}'.
        self.flow_level -= 1;
        self.allow_simple_key = false;
        self.push_simple(tok, 1);
        Ok(())
    }

    fn fetch_flow_entry(&mut self) -> R<()> {
        self.allow_simple_key = true;
        self.remove_possible_simple_key()?;
        self.push_simple(Tok::FlowEntry, 1);
        Ok(())
    }

    fn fetch_block_entry(&mut self) -> R<()> {
        if self.flow_level == 0 {
            if !self.allow_simple_key {
                return Err(self.scan_err(None, None, "sequence entries are not allowed here".into()));
            }
            if self.add_indent(self.column as i64) {
                let m = self.mark();
                self.tokens.push_back(Token { tok: Tok::BlockSequenceStart, start: m, end: m });
            }
        }
        self.allow_simple_key = true;
        self.remove_possible_simple_key()?;
        self.push_simple(Tok::BlockEntry, 1);
        Ok(())
    }

    fn fetch_key(&mut self) -> R<()> {
        if self.flow_level == 0 {
            if !self.allow_simple_key {
                return Err(self.scan_err(None, None, "mapping keys are not allowed here".into()));
            }
            if self.add_indent(self.column as i64) {
                let m = self.mark();
                self.tokens.push_back(Token { tok: Tok::BlockMappingStart, start: m, end: m });
            }
        }
        self.allow_simple_key = self.flow_level == 0;
        self.remove_possible_simple_key()?;
        self.push_simple(Tok::Key, 1);
        Ok(())
    }

    fn fetch_value(&mut self) -> R<()> {
        if let Some(key) = self.possible_simple_keys.remove(&self.flow_level) {
            let at = key.token_number - self.tokens_taken;
            self.tokens.insert(at, Token { tok: Tok::Key, start: key.mark, end: key.mark });
            if self.flow_level == 0 && self.add_indent(key.column as i64) {
                self.tokens.insert(at, Token { tok: Tok::BlockMappingStart, start: key.mark, end: key.mark });
            }
            self.allow_simple_key = false;
        } else {
            if self.flow_level == 0 {
                if !self.allow_simple_key {
                    return Err(self.scan_err(None, None, "mapping values are not allowed here".into()));
                }
                if self.add_indent(self.column as i64) {
                    let m = self.mark();
                    self.tokens.push_back(Token { tok: Tok::BlockMappingStart, start: m, end: m });
                }
            }
            self.allow_simple_key = self.flow_level == 0;
            self.remove_possible_simple_key()?;
        }
        self.push_simple(Tok::Value, 1);
        Ok(())
    }

    fn fetch_anchor(&mut self, alias: bool) -> R<()> {
        self.save_possible_simple_key()?;
        self.allow_simple_key = false;
        let t = self.scan_anchor(alias)?;
        self.tokens.push_back(t);
        Ok(())
    }

    fn fetch_tag(&mut self) -> R<()> {
        self.save_possible_simple_key()?;
        self.allow_simple_key = false;
        let t = self.scan_tag()?;
        self.tokens.push_back(t);
        Ok(())
    }

    fn fetch_block_scalar(&mut self, folded: bool) -> R<()> {
        self.allow_simple_key = true;
        self.remove_possible_simple_key()?;
        let t = self.scan_block_scalar(folded)?;
        self.tokens.push_back(t);
        Ok(())
    }

    fn fetch_flow_scalar(&mut self, double: bool) -> R<()> {
        self.save_possible_simple_key()?;
        self.allow_simple_key = false;
        let t = self.scan_flow_scalar(double)?;
        self.tokens.push_back(t);
        Ok(())
    }

    fn fetch_plain(&mut self) -> R<()> {
        self.save_possible_simple_key()?;
        self.allow_simple_key = false;
        let t = self.scan_plain();
        self.tokens.push_back(t);
        Ok(())
    }

    fn check_plain(&self) -> bool {
        let ch = self.ch();
        !is_in(ch, "\0 \t\r\n\u{85}\u{2028}\u{2029}-?:,[]{}#&*!|>'\"%@`") || (!is_in(self.peek(1), Z_BLANK) && (ch == '-' || (self.flow_level == 0 && is_in(ch, "?:"))))
    }

    // ── scanners ──

    fn scan_to_next_token(&mut self) {
        if self.pointer == 0 && self.ch() == '\u{feff}' {
            self.forward(1);
        }
        loop {
            while self.ch() == ' ' {
                self.forward(1);
            }
            if self.ch() == '#' {
                while !is_in(self.ch(), Z_BREAK) {
                    self.forward(1);
                }
            }
            if !self.scan_line_break().is_empty() {
                if self.flow_level == 0 {
                    self.allow_simple_key = true;
                }
            } else {
                break;
            }
        }
    }

    fn scan_directive(&mut self) -> R<Token> {
        let start = self.mark();
        self.forward(1);
        let name = self.scan_directive_name(start)?;
        let value;
        let end;
        if name == "YAML" {
            value = Some(self.scan_yaml_directive_value(start)?);
            end = self.mark();
        } else if name == "TAG" {
            value = Some(self.scan_tag_directive_value(start)?);
            end = self.mark();
        } else {
            value = None;
            end = self.mark();
            while !is_in(self.ch(), Z_BREAK) {
                self.forward(1);
            }
        }
        self.scan_directive_ignored_line(start)?;
        Ok(Token { tok: Tok::Directive(name, value), start, end })
    }

    fn word_len(&self, from: usize) -> usize {
        let mut n = 0;
        loop {
            let c = self.peek(from + n);
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                n += 1;
            } else {
                return n;
            }
        }
    }

    fn scan_directive_name(&mut self, start: Mark) -> R<String> {
        let length = self.word_len(0);
        if length == 0 {
            let ch = self.peek(length);
            return Err(self.scan_err(
                Some("while scanning a directive"),
                Some(start),
                format!("expected alphabetic or numeric character, but found {}", py_repr(&ch.to_string())),
            ));
        }
        let value = self.prefix(length);
        self.forward(length);
        let ch = self.ch();
        if !is_in(ch, Z_SPACE) {
            return Err(self.scan_err(
                Some("while scanning a directive"),
                Some(start),
                format!("expected alphabetic or numeric character, but found {}", py_repr(&ch.to_string())),
            ));
        }
        Ok(value)
    }

    fn scan_yaml_directive_value(&mut self, start: Mark) -> R<DirValue> {
        while self.ch() == ' ' {
            self.forward(1);
        }
        let major = self.scan_yaml_directive_number(start)?;
        if self.ch() != '.' {
            return Err(self.scan_err(Some("while scanning a directive"), Some(start), format!("expected a digit or '.', but found {}", py_repr(&self.ch().to_string()))));
        }
        self.forward(1);
        let minor = self.scan_yaml_directive_number(start)?;
        if !is_in(self.ch(), Z_SPACE) {
            return Err(self.scan_err(Some("while scanning a directive"), Some(start), format!("expected a digit or ' ', but found {}", py_repr(&self.ch().to_string()))));
        }
        Ok(DirValue::Yaml(major, minor))
    }

    fn scan_yaml_directive_number(&mut self, start: Mark) -> R<u128> {
        let ch = self.ch();
        if !ch.is_ascii_digit() {
            return Err(self.scan_err(Some("while scanning a directive"), Some(start), format!("expected a digit, but found {}", py_repr(&ch.to_string()))));
        }
        let mut length = 0;
        while self.peek(length).is_ascii_digit() {
            length += 1;
        }
        let v = self.prefix(length).chars().fold(0u128, |a, c| a.saturating_mul(10).saturating_add(c as u128 - '0' as u128));
        self.forward(length);
        Ok(v)
    }

    fn scan_tag_directive_value(&mut self, start: Mark) -> R<DirValue> {
        while self.ch() == ' ' {
            self.forward(1);
        }
        let handle = self.scan_tag_handle("directive", start)?;
        if self.ch() != ' ' {
            return Err(self.scan_err(Some("while scanning a directive"), Some(start), format!("expected ' ', but found {}", py_repr(&self.ch().to_string()))));
        }
        while self.ch() == ' ' {
            self.forward(1);
        }
        let prefix = self.scan_tag_uri("directive", start)?;
        if !is_in(self.ch(), Z_SPACE) {
            return Err(self.scan_err(Some("while scanning a directive"), Some(start), format!("expected ' ', but found {}", py_repr(&self.ch().to_string()))));
        }
        Ok(DirValue::Tag(handle, prefix))
    }

    fn scan_directive_ignored_line(&mut self, start: Mark) -> R<()> {
        while self.ch() == ' ' {
            self.forward(1);
        }
        if self.ch() == '#' {
            while !is_in(self.ch(), Z_BREAK) {
                self.forward(1);
            }
        }
        let ch = self.ch();
        if !is_in(ch, Z_BREAK) {
            return Err(self.scan_err(Some("while scanning a directive"), Some(start), format!("expected a comment or a line break, but found {}", py_repr(&ch.to_string()))));
        }
        self.scan_line_break();
        Ok(())
    }

    fn scan_anchor(&mut self, alias: bool) -> R<Token> {
        let start = self.mark();
        let name = if alias { "while scanning an alias" } else { "while scanning an anchor" };
        self.forward(1);
        let length = self.word_len(0);
        if length == 0 {
            let ch = self.peek(length);
            return Err(self.scan_err(Some(name), Some(start), format!("expected alphabetic or numeric character, but found {}", py_repr(&ch.to_string()))));
        }
        let value = self.prefix(length);
        self.forward(length);
        let ch = self.ch();
        if !is_in(ch, "\0 \t\r\n\u{85}\u{2028}\u{2029}?:,]}%@`") {
            return Err(self.scan_err(Some(name), Some(start), format!("expected alphabetic or numeric character, but found {}", py_repr(&ch.to_string()))));
        }
        let end = self.mark();
        Ok(Token { tok: if alias { Tok::Alias(value) } else { Tok::Anchor(value) }, start, end })
    }

    fn scan_tag(&mut self) -> R<Token> {
        let start = self.mark();
        let mut ch = self.peek(1);
        let handle;
        let suffix;
        if ch == '<' {
            handle = None;
            self.forward(2);
            suffix = self.scan_tag_uri("tag", start)?;
            if self.ch() != '>' {
                return Err(self.scan_err(Some("while parsing a tag"), Some(start), format!("expected '>', but found {}", py_repr(&self.ch().to_string()))));
            }
            self.forward(1);
        } else if is_in(ch, Z_BLANK) {
            handle = None;
            suffix = "!".to_string();
            self.forward(1);
        } else {
            let mut length = 1;
            let mut use_handle = false;
            while !is_in(ch, Z_SPACE) {
                if ch == '!' {
                    use_handle = true;
                    break;
                }
                length += 1;
                ch = self.peek(length);
            }
            if use_handle {
                handle = Some(self.scan_tag_handle("tag", start)?);
            } else {
                handle = Some("!".to_string());
                self.forward(1);
            }
            suffix = self.scan_tag_uri("tag", start)?;
        }
        let ch = self.ch();
        if !is_in(ch, Z_SPACE) {
            return Err(self.scan_err(Some("while scanning a tag"), Some(start), format!("expected ' ', but found {}", py_repr(&ch.to_string()))));
        }
        let end = self.mark();
        Ok(Token { tok: Tok::Tag(handle, suffix), start, end })
    }

    fn scan_block_scalar(&mut self, folded: bool) -> R<Token> {
        let mut chunks = String::new();
        let start = self.mark();
        self.forward(1);
        let (chomping, increment) = self.scan_block_scalar_indicators(start)?;
        self.scan_block_scalar_ignored_line(start)?;
        let min_indent = (self.indent + 1).max(1);
        let (mut breaks, mut end, indent);
        match increment {
            None => {
                let (b, max_indent, e) = self.scan_block_scalar_indentation();
                breaks = b;
                end = e;
                indent = min_indent.max(max_indent);
            }
            Some(inc) => {
                indent = min_indent + inc - 1;
                let (b, e) = self.scan_block_scalar_breaks(indent);
                breaks = b;
                end = e;
            }
        }
        let mut line_break = String::new();
        while self.column as i64 == indent && self.ch() != '\0' {
            chunks.extend(breaks.iter().map(|s| s.as_str()));
            let leading_non_space = !is_in(self.ch(), " \t");
            let mut length = 0;
            while !is_in(self.peek(length), Z_BREAK) {
                length += 1;
            }
            chunks.push_str(&self.prefix(length));
            self.forward(length);
            line_break = self.scan_line_break();
            let (b, e) = self.scan_block_scalar_breaks(indent);
            breaks = b;
            end = e;
            if self.column as i64 == indent && self.ch() != '\0' {
                if folded && line_break == "\n" && leading_non_space && !is_in(self.ch(), " \t") {
                    if breaks.is_empty() {
                        chunks.push(' ');
                    }
                } else {
                    chunks.push_str(&line_break);
                }
            } else {
                break;
            }
        }
        if chomping != Some(false) {
            chunks.push_str(&line_break);
        }
        if chomping == Some(true) {
            chunks.extend(breaks.iter().map(|s| s.as_str()));
        }
        Ok(Token { tok: Tok::Scalar(chunks, false), start, end })
    }

    fn scan_block_scalar_indicators(&mut self, start: Mark) -> R<(Option<bool>, Option<i64>)> {
        let mut chomping = None;
        let mut increment = None;
        let zero = |l: &Loader| l.scan_err(Some("while scanning a block scalar"), Some(start), "expected indentation indicator in the range 1-9, but found 0".into());
        let mut ch = self.ch();
        if ch == '+' || ch == '-' {
            chomping = Some(ch == '+');
            self.forward(1);
            ch = self.ch();
            if ch.is_ascii_digit() {
                let inc = ch as i64 - '0' as i64;
                if inc == 0 {
                    return Err(zero(self));
                }
                increment = Some(inc);
                self.forward(1);
            }
        } else if ch.is_ascii_digit() {
            let inc = ch as i64 - '0' as i64;
            if inc == 0 {
                return Err(zero(self));
            }
            increment = Some(inc);
            self.forward(1);
            ch = self.ch();
            if ch == '+' || ch == '-' {
                chomping = Some(ch == '+');
                self.forward(1);
            }
        }
        let ch = self.ch();
        if !is_in(ch, Z_SPACE) {
            return Err(self.scan_err(
                Some("while scanning a block scalar"),
                Some(start),
                format!("expected chomping or indentation indicators, but found {}", py_repr(&ch.to_string())),
            ));
        }
        Ok((chomping, increment))
    }

    fn scan_block_scalar_ignored_line(&mut self, start: Mark) -> R<()> {
        while self.ch() == ' ' {
            self.forward(1);
        }
        if self.ch() == '#' {
            while !is_in(self.ch(), Z_BREAK) {
                self.forward(1);
            }
        }
        let ch = self.ch();
        if !is_in(ch, Z_BREAK) {
            return Err(self.scan_err(Some("while scanning a block scalar"), Some(start), format!("expected a comment or a line break, but found {}", py_repr(&ch.to_string()))));
        }
        self.scan_line_break();
        Ok(())
    }

    fn scan_block_scalar_indentation(&mut self) -> (Vec<String>, i64, Mark) {
        let mut chunks = vec![];
        let mut max_indent = 0i64;
        let mut end = self.mark();
        while is_in(self.ch(), " \r\n\u{85}\u{2028}\u{2029}") && self.ch() != '\0' {
            if self.ch() != ' ' {
                chunks.push(self.scan_line_break());
                end = self.mark();
            } else {
                self.forward(1);
                if self.column as i64 > max_indent {
                    max_indent = self.column as i64;
                }
            }
        }
        (chunks, max_indent, end)
    }

    fn scan_block_scalar_breaks(&mut self, indent: i64) -> (Vec<String>, Mark) {
        let mut chunks = vec![];
        let mut end = self.mark();
        while (self.column as i64) < indent && self.ch() == ' ' {
            self.forward(1);
        }
        while is_in(self.ch(), BREAK) && self.ch() != '\0' {
            chunks.push(self.scan_line_break());
            end = self.mark();
            while (self.column as i64) < indent && self.ch() == ' ' {
                self.forward(1);
            }
        }
        (chunks, end)
    }

    fn scan_flow_scalar(&mut self, double: bool) -> R<Token> {
        let mut chunks = String::new();
        let start = self.mark();
        let quote = self.ch();
        self.forward(1);
        self.scan_flow_scalar_non_spaces(double, start, &mut chunks)?;
        while self.ch() != quote {
            self.scan_flow_scalar_spaces(double, start, &mut chunks)?;
            self.scan_flow_scalar_non_spaces(double, start, &mut chunks)?;
        }
        self.forward(1);
        let end = self.mark();
        Ok(Token { tok: Tok::Scalar(chunks, false), start, end })
    }

    fn scan_flow_scalar_non_spaces(&mut self, double: bool, start: Mark, chunks: &mut String) -> R<()> {
        loop {
            let mut length = 0;
            while !is_in(self.peek(length), "'\"\\\0 \t\r\n\u{85}\u{2028}\u{2029}") {
                length += 1;
            }
            if length > 0 {
                chunks.push_str(&self.prefix(length));
                self.forward(length);
            }
            let ch = self.ch();
            if !double && ch == '\'' && self.peek(1) == '\'' {
                chunks.push('\'');
                self.forward(2);
            } else if (double && ch == '\'') || (!double && (ch == '"' || ch == '\\')) {
                chunks.push(ch);
                self.forward(1);
            } else if double && ch == '\\' {
                self.forward(1);
                let ch = self.ch();
                let rep = match ch {
                    '0' => Some('\0'),
                    'a' => Some('\x07'),
                    'b' => Some('\x08'),
                    't' | '\t' => Some('\t'),
                    'n' => Some('\n'),
                    'v' => Some('\x0b'),
                    'f' => Some('\x0c'),
                    'r' => Some('\r'),
                    'e' => Some('\x1b'),
                    ' ' => Some(' '),
                    '"' => Some('"'),
                    '\\' => Some('\\'),
                    '/' => Some('/'),
                    'N' => Some('\u{85}'),
                    '_' => Some('\u{a0}'),
                    'L' => Some('\u{2028}'),
                    'P' => Some('\u{2029}'),
                    _ => None,
                };
                let code_len = match ch {
                    'x' => 2,
                    'u' => 4,
                    'U' => 8,
                    _ => 0,
                };
                if let Some(r) = rep {
                    chunks.push(r);
                    self.forward(1);
                } else if code_len > 0 {
                    self.forward(1);
                    for k in 0..code_len {
                        if !self.peek(k).is_ascii_hexdigit() {
                            return Err(self.scan_err(
                                Some("while scanning a double-quoted scalar"),
                                Some(start),
                                format!("expected escape sequence of {code_len} hexadecimal numbers, but found {}", py_repr(&self.peek(k).to_string())),
                            ));
                        }
                    }
                    let code = u32::from_str_radix(&self.prefix(code_len), 16).unwrap_or(0);
                    if code > 0x10ffff {
                        return Err(LoadError::new("ValueError", "chr() arg not in range(0x110000)"));
                    }
                    // Lone surrogates cannot live in a Rust string.
                    chunks.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    self.forward(code_len);
                } else if is_in(ch, BREAK) && ch != '\0' {
                    self.scan_line_break();
                    self.scan_flow_scalar_breaks(start, chunks)?;
                } else {
                    return Err(self.scan_err(Some("while scanning a double-quoted scalar"), Some(start), format!("found unknown escape character {}", py_repr(&ch.to_string()))));
                }
            } else {
                return Ok(());
            }
        }
    }

    fn scan_flow_scalar_spaces(&mut self, _double: bool, start: Mark, chunks: &mut String) -> R<()> {
        let mut length = 0;
        while is_in(self.peek(length), " \t") && self.peek(length) != '\0' {
            length += 1;
        }
        let whitespaces = self.prefix(length);
        self.forward(length);
        let ch = self.ch();
        if ch == '\0' {
            return Err(self.scan_err(Some("while scanning a quoted scalar"), Some(start), "found unexpected end of stream".into()));
        } else if is_in(ch, BREAK) {
            let line_break = self.scan_line_break();
            let mut breaks = String::new();
            self.scan_flow_scalar_breaks(start, &mut breaks)?;
            if line_break != "\n" {
                chunks.push_str(&line_break);
            } else if breaks.is_empty() {
                chunks.push(' ');
            }
            chunks.push_str(&breaks);
        } else {
            chunks.push_str(&whitespaces);
        }
        Ok(())
    }

    fn scan_flow_scalar_breaks(&mut self, start: Mark, chunks: &mut String) -> R<()> {
        loop {
            let prefix = self.prefix(3);
            if (prefix == "---" || prefix == "...") && is_in(self.peek(3), Z_BLANK) {
                return Err(self.scan_err(Some("while scanning a quoted scalar"), Some(start), "found unexpected document separator".into()));
            }
            while self.ch() == ' ' || self.ch() == '\t' {
                self.forward(1);
            }
            if is_in(self.ch(), BREAK) && self.ch() != '\0' {
                let b = self.scan_line_break();
                chunks.push_str(&b);
            } else {
                return Ok(());
            }
        }
    }

    fn scan_plain(&mut self) -> Token {
        let mut chunks = String::new();
        let start = self.mark();
        let mut end = start;
        let indent = self.indent + 1;
        let mut spaces: Option<String> = Some(String::new());
        loop {
            let mut length = 0;
            if self.ch() == '#' {
                break;
            }
            loop {
                let ch = self.peek(length);
                let flow_stop = if self.flow_level != 0 { ",[]{}" } else { "" };
                if is_in(ch, Z_BLANK)
                    || (ch == ':' && (is_in(self.peek(length + 1), Z_BLANK) || is_in(self.peek(length + 1), flow_stop)))
                    || (self.flow_level != 0 && is_in(ch, ",?[]{}"))
                {
                    break;
                }
                length += 1;
            }
            if length == 0 {
                break;
            }
            self.allow_simple_key = false;
            if let Some(s) = &spaces {
                chunks.push_str(s);
            }
            chunks.push_str(&self.prefix(length));
            self.forward(length);
            end = self.mark();
            spaces = self.scan_plain_spaces();
            match &spaces {
                None => break,
                Some(s) if s.is_empty() => break,
                _ => {}
            }
            if self.ch() == '#' || (self.flow_level == 0 && (self.column as i64) < indent) {
                break;
            }
        }
        Token { tok: Tok::Scalar(chunks, true), start, end }
    }

    /// `None` mirrors Python's bare `return` (document separator ahead).
    fn scan_plain_spaces(&mut self) -> Option<String> {
        let mut chunks = String::new();
        let mut length = 0;
        while self.peek(length) == ' ' {
            length += 1;
        }
        let whitespaces = self.prefix(length);
        self.forward(length);
        let ch = self.ch();
        if is_in(ch, BREAK) && ch != '\0' {
            let line_break = self.scan_line_break();
            self.allow_simple_key = true;
            let sep = |l: &Loader| {
                let p = l.prefix(3);
                (p == "---" || p == "...") && is_in(l.peek(3), Z_BLANK)
            };
            if sep(self) {
                return None;
            }
            let mut breaks = String::new();
            while is_in(self.ch(), " \r\n\u{85}\u{2028}\u{2029}") && self.ch() != '\0' {
                if self.ch() == ' ' {
                    self.forward(1);
                } else {
                    let b = self.scan_line_break();
                    breaks.push_str(&b);
                    if sep(self) {
                        return None;
                    }
                }
            }
            if line_break != "\n" {
                chunks.push_str(&line_break);
            } else if breaks.is_empty() {
                chunks.push(' ');
            }
            chunks.push_str(&breaks);
        } else if !whitespaces.is_empty() {
            chunks.push_str(&whitespaces);
        }
        Some(chunks)
    }

    fn scan_tag_handle(&mut self, name: &str, start: Mark) -> R<String> {
        let ctx = format!("while scanning a {name}");
        let ch = self.ch();
        if ch != '!' {
            return Err(self.scan_err(Some(&ctx), Some(start), format!("expected '!', but found {}", py_repr(&ch.to_string()))));
        }
        let mut length = 1;
        let mut ch = self.peek(length);
        if ch != ' ' {
            while ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                length += 1;
                ch = self.peek(length);
            }
            if ch != '!' {
                self.forward(length);
                return Err(self.scan_err(Some(&ctx), Some(start), format!("expected '!', but found {}", py_repr(&ch.to_string()))));
            }
            length += 1;
        }
        let value = self.prefix(length);
        self.forward(length);
        Ok(value)
    }

    fn scan_tag_uri(&mut self, name: &str, start: Mark) -> R<String> {
        let mut chunks = String::new();
        let mut length = 0;
        let mut ch = self.peek(length);
        while ch.is_ascii_alphanumeric() || (ch != '\0' && is_in(ch, "-;/?:@&=+$,_.!~*'()[]%")) {
            if ch == '%' {
                chunks.push_str(&self.prefix(length));
                self.forward(length);
                length = 0;
                let s = self.scan_uri_escapes(name, start)?;
                chunks.push_str(&s);
            } else {
                length += 1;
            }
            ch = self.peek(length);
        }
        if length > 0 {
            chunks.push_str(&self.prefix(length));
            self.forward(length);
        }
        if chunks.is_empty() {
            return Err(self.scan_err(Some(&format!("while parsing a {name}")), Some(start), format!("expected URI, but found {}", py_repr(&ch.to_string()))));
        }
        Ok(chunks)
    }

    fn scan_uri_escapes(&mut self, name: &str, start: Mark) -> R<String> {
        let mut codes: Vec<u8> = vec![];
        let mark = self.mark();
        while self.ch() == '%' {
            self.forward(1);
            for k in 0..2 {
                if !self.peek(k).is_ascii_hexdigit() {
                    return Err(self.scan_err(
                        Some(&format!("while scanning a {name}")),
                        Some(start),
                        format!("expected URI escape sequence of 2 hexadecimal numbers, but found {}", py_repr(&self.peek(k).to_string())),
                    ));
                }
            }
            codes.push(u8::from_str_radix(&self.prefix(2), 16).unwrap_or(0));
            self.forward(2);
        }
        match String::from_utf8(codes.clone()) {
            Ok(s) => Ok(s),
            Err(e) => {
                let e = e.utf8_error();
                let pos = e.valid_up_to();
                let msg = match e.error_len() {
                    None if codes.len() - pos > 1 => format!("'utf-8' codec can't decode bytes in position {}-{}: unexpected end of data", pos, codes.len() - 1),
                    None => format!("'utf-8' codec can't decode byte 0x{:02x} in position {pos}: unexpected end of data", codes[pos]),
                    Some(_) => {
                        let b = codes[pos];
                        let why = if (0xc2..=0xf4).contains(&b) { "invalid continuation byte" } else { "invalid start byte" };
                        format!("'utf-8' codec can't decode byte 0x{b:02x} in position {pos}: {why}")
                    }
                };
                Err(self.marked("ScannerError", Some(&format!("while scanning a {name}")), Some(start), Some(msg), Some(mark)))
            }
        }
    }

    fn scan_line_break(&mut self) -> String {
        let ch = self.ch();
        if ch == '\r' || ch == '\n' || ch == '\u{85}' {
            if self.prefix(2) == "\r\n" {
                self.forward(2);
            } else {
                self.forward(1);
            }
            return "\n".into();
        } else if ch == '\u{2028}' || ch == '\u{2029}' {
            self.forward(1);
            return ch.to_string();
        }
        String::new()
    }
}

// ── parser ──────────────────────────────────────────────────────────────────

impl Loader {
    fn parse_err(&self, context: Option<&str>, cmark: Option<Mark>, problem: String, pmark: Mark) -> LoadError {
        self.marked("ParserError", context, cmark, Some(problem), Some(pmark))
    }

    fn peek_event(&mut self) -> R<Option<&Event>> {
        if self.current_event.is_none() {
            if let Some(st) = self.state {
                self.current_event = Some(self.step(st)?);
            }
        }
        Ok(self.current_event.as_ref())
    }

    fn get_event(&mut self) -> R<Option<Event>> {
        self.peek_event()?;
        Ok(self.current_event.take())
    }

    fn pop_state(&mut self) {
        self.state = self.states.pop();
    }

    fn ptok_start(&mut self) -> R<Mark> {
        Ok(self.peek_token()?.start)
    }

    fn empty_scalar(mark: Mark) -> Event {
        Event { ev: Ev::Scalar { anchor: None, tag: None, implicit: (true, false), value: String::new() }, start: mark }
    }

    fn step(&mut self, st: St) -> R<Event> {
        match st {
            St::StreamStart => {
                let t = self.get_token()?;
                self.state = Some(St::ImplicitDocumentStart);
                Ok(Event { ev: Ev::StreamStart, start: t.start })
            }
            St::ImplicitDocumentStart => {
                if !self.check_token(&["<directive>", "<document start>", "<stream end>"])? {
                    self.tag_handles = default_tags();
                    let m = self.ptok_start()?;
                    self.states.push(St::DocumentEnd);
                    self.state = Some(St::BlockNode);
                    Ok(Event { ev: Ev::DocumentStart, start: m })
                } else {
                    self.parse_document_start()
                }
            }
            St::DocumentStart => self.parse_document_start(),
            St::DocumentEnd => {
                let m = self.ptok_start()?;
                if self.check_token(&["<document end>"])? {
                    self.get_token()?;
                }
                self.state = Some(St::DocumentStart);
                Ok(Event { ev: Ev::DocumentEnd, start: m })
            }
            St::DocumentContent => {
                if self.check_token(&["<directive>", "<document start>", "<document end>", "<stream end>"])? {
                    let m = self.ptok_start()?;
                    self.pop_state();
                    Ok(Self::empty_scalar(m))
                } else {
                    self.parse_node(true, false)
                }
            }
            St::BlockNode => self.parse_node(true, false),
            St::BlockSequenceFirstEntry => {
                let t = self.get_token()?;
                self.marks.push(t.start);
                self.parse_block_sequence_entry()
            }
            St::BlockSequenceEntry => self.parse_block_sequence_entry(),
            St::IndentlessSequenceEntry => {
                if self.check_token(&["-"])? {
                    let t = self.get_token()?;
                    if !self.check_token(&["-", "?", ":", "<block end>"])? {
                        self.states.push(St::IndentlessSequenceEntry);
                        return self.parse_node(true, false);
                    }
                    self.state = Some(St::IndentlessSequenceEntry);
                    return Ok(Self::empty_scalar(t.end));
                }
                let m = self.ptok_start()?;
                self.pop_state();
                Ok(Event { ev: Ev::SequenceEnd, start: m })
            }
            St::BlockMappingFirstKey => {
                let t = self.get_token()?;
                self.marks.push(t.start);
                self.parse_block_mapping_key()
            }
            St::BlockMappingKey => self.parse_block_mapping_key(),
            St::BlockMappingValue => {
                if self.check_token(&[":"])? {
                    let t = self.get_token()?;
                    if !self.check_token(&["?", ":", "<block end>"])? {
                        self.states.push(St::BlockMappingKey);
                        return self.parse_node(true, true);
                    }
                    self.state = Some(St::BlockMappingKey);
                    return Ok(Self::empty_scalar(t.end));
                }
                self.state = Some(St::BlockMappingKey);
                let m = self.ptok_start()?;
                Ok(Self::empty_scalar(m))
            }
            St::FlowSequenceFirstEntry => {
                let t = self.get_token()?;
                self.marks.push(t.start);
                self.parse_flow_sequence_entry(true)
            }
            St::FlowSequenceEntry => self.parse_flow_sequence_entry(false),
            St::FlowSequenceEntryMappingKey => {
                let t = self.get_token()?;
                if !self.check_token(&[":", ",", "]"])? {
                    self.states.push(St::FlowSequenceEntryMappingValue);
                    return self.parse_node(false, false);
                }
                self.state = Some(St::FlowSequenceEntryMappingValue);
                Ok(Self::empty_scalar(t.end))
            }
            St::FlowSequenceEntryMappingValue => {
                if self.check_token(&[":"])? {
                    let t = self.get_token()?;
                    if !self.check_token(&[",", "]"])? {
                        self.states.push(St::FlowSequenceEntryMappingEnd);
                        return self.parse_node(false, false);
                    }
                    self.state = Some(St::FlowSequenceEntryMappingEnd);
                    return Ok(Self::empty_scalar(t.end));
                }
                self.state = Some(St::FlowSequenceEntryMappingEnd);
                let m = self.ptok_start()?;
                Ok(Self::empty_scalar(m))
            }
            St::FlowSequenceEntryMappingEnd => {
                self.state = Some(St::FlowSequenceEntry);
                let m = self.ptok_start()?;
                Ok(Event { ev: Ev::MappingEnd, start: m })
            }
            St::FlowMappingFirstKey => {
                let t = self.get_token()?;
                self.marks.push(t.start);
                self.parse_flow_mapping_key(true)
            }
            St::FlowMappingKey => self.parse_flow_mapping_key(false),
            St::FlowMappingValue => {
                if self.check_token(&[":"])? {
                    let t = self.get_token()?;
                    if !self.check_token(&[",", "}"])? {
                        self.states.push(St::FlowMappingKey);
                        return self.parse_node(false, false);
                    }
                    self.state = Some(St::FlowMappingKey);
                    return Ok(Self::empty_scalar(t.end));
                }
                self.state = Some(St::FlowMappingKey);
                let m = self.ptok_start()?;
                Ok(Self::empty_scalar(m))
            }
            St::FlowMappingEmptyValue => {
                self.state = Some(St::FlowMappingKey);
                let m = self.ptok_start()?;
                Ok(Self::empty_scalar(m))
            }
        }
    }

    fn parse_document_start(&mut self) -> R<Event> {
        while self.check_token(&["<document end>"])? {
            self.get_token()?;
        }
        if !self.check_token(&["<stream end>"])? {
            let start = self.ptok_start()?;
            self.process_directives()?;
            if !self.check_token(&["<document start>"])? {
                let t = self.peek_token()?;
                let (id, m) = (t.id(), t.start);
                return Err(self.parse_err(None, None, format!("expected '<document start>', but found '{id}'"), m));
            }
            self.get_token()?;
            self.states.push(St::DocumentEnd);
            self.state = Some(St::DocumentContent);
            Ok(Event { ev: Ev::DocumentStart, start })
        } else {
            let t = self.get_token()?;
            self.state = None;
            Ok(Event { ev: Ev::StreamEnd, start: t.start })
        }
    }

    fn process_directives(&mut self) -> R<()> {
        let mut yaml_version: Option<(u128, u128)> = None;
        self.tag_handles = vec![];
        while self.check_token(&["<directive>"])? {
            let t = self.get_token()?;
            let Tok::Directive(name, value) = &t.tok else { unreachable!() };
            if name == "YAML" {
                if yaml_version.is_some() {
                    return Err(self.parse_err(None, None, "found duplicate YAML directive".into(), t.start));
                }
                let Some(DirValue::Yaml(major, minor)) = value else { unreachable!() };
                if *major != 1 {
                    return Err(self.parse_err(None, None, "found incompatible YAML document (version 1.* is required)".into(), t.start));
                }
                yaml_version = Some((*major, *minor));
            } else if name == "TAG" {
                let Some(DirValue::Tag(handle, prefix)) = value else { unreachable!() };
                if self.tag_handles.iter().any(|(h, _)| h == handle) {
                    return Err(self.parse_err(None, None, format!("duplicate tag handle {}", py_repr(handle)), t.start));
                }
                self.tag_handles.push((handle.clone(), prefix.clone()));
            }
        }
        for (k, v) in default_tags() {
            if !self.tag_handles.iter().any(|(h, _)| *h == k) {
                self.tag_handles.push((k, v));
            }
        }
        Ok(())
    }

    fn parse_node(&mut self, block: bool, indentless_sequence: bool) -> R<Event> {
        if self.check_token(&["<alias>"])? {
            let t = self.get_token()?;
            let Tok::Alias(name) = t.tok else { unreachable!() };
            self.pop_state();
            return Ok(Event { ev: Ev::Alias(name), start: t.start });
        }
        let mut anchor: Option<String> = None;
        let mut tag: Option<(Option<String>, String)> = None;
        let mut start_mark: Option<Mark> = None;
        let mut tag_mark: Option<Mark> = None;
        if self.check_token(&["<anchor>"])? {
            let t = self.get_token()?;
            start_mark = Some(t.start);
            if let Tok::Anchor(a) = t.tok {
                anchor = Some(a);
            }
            if self.check_token(&["<tag>"])? {
                let t = self.get_token()?;
                tag_mark = Some(t.start);
                if let Tok::Tag(h, s) = t.tok {
                    tag = Some((h, s));
                }
            }
        } else if self.check_token(&["<tag>"])? {
            let t = self.get_token()?;
            start_mark = Some(t.start);
            tag_mark = Some(t.start);
            if let Tok::Tag(h, s) = t.tok {
                tag = Some((h, s));
            }
            if self.check_token(&["<anchor>"])? {
                let t = self.get_token()?;
                if let Tok::Anchor(a) = t.tok {
                    anchor = Some(a);
                }
            }
        }
        let tag: Option<String> = match tag {
            None => None,
            Some((Some(handle), suffix)) => match self.tag_handles.iter().find(|(h, _)| *h == handle) {
                Some((_, prefix)) => Some(format!("{prefix}{suffix}")),
                None => {
                    return Err(self.parse_err(Some("while parsing a node"), start_mark, format!("found undefined tag handle {}", py_repr(&handle)), tag_mark.unwrap()));
                }
            },
            Some((None, suffix)) => Some(suffix),
        };
        let start = match start_mark {
            Some(m) => m,
            None => self.ptok_start()?,
        };
        let implicit = tag.is_none() || tag.as_deref() == Some("!");
        if indentless_sequence && self.check_token(&["-"])? {
            self.state = Some(St::IndentlessSequenceEntry);
            return Ok(Event { ev: Ev::SequenceStart { anchor, tag }, start });
        }
        if self.check_token(&["<scalar>"])? {
            let t = self.get_token()?;
            let Tok::Scalar(value, plain) = t.tok else { unreachable!() };
            let implicit = if (plain && tag.is_none()) || tag.as_deref() == Some("!") {
                (true, false)
            } else if tag.is_none() {
                (false, true)
            } else {
                (false, false)
            };
            self.pop_state();
            return Ok(Event { ev: Ev::Scalar { anchor, tag, implicit, value }, start });
        }
        if self.check_token(&["["])? {
            self.state = Some(St::FlowSequenceFirstEntry);
            return Ok(Event { ev: Ev::SequenceStart { anchor, tag }, start });
        }
        if self.check_token(&["{"])? {
            self.state = Some(St::FlowMappingFirstKey);
            return Ok(Event { ev: Ev::MappingStart { anchor, tag }, start });
        }
        if block && self.check_token(&["<block sequence start>"])? {
            self.state = Some(St::BlockSequenceFirstEntry);
            return Ok(Event { ev: Ev::SequenceStart { anchor, tag }, start });
        }
        if block && self.check_token(&["<block mapping start>"])? {
            self.state = Some(St::BlockMappingFirstKey);
            return Ok(Event { ev: Ev::MappingStart { anchor, tag }, start });
        }
        if anchor.is_some() || tag.is_some() {
            self.pop_state();
            return Ok(Event { ev: Ev::Scalar { anchor, tag, implicit: (implicit, false), value: String::new() }, start });
        }
        let node = if block { "block" } else { "flow" };
        let t = self.peek_token()?;
        let (id, m) = (t.id(), t.start);
        Err(self.parse_err(Some(&format!("while parsing a {node} node")), Some(start), format!("expected the node content, but found '{id}'"), m))
    }

    fn parse_block_sequence_entry(&mut self) -> R<Event> {
        if self.check_token(&["-"])? {
            let t = self.get_token()?;
            if !self.check_token(&["-", "<block end>"])? {
                self.states.push(St::BlockSequenceEntry);
                return self.parse_node(true, false);
            }
            self.state = Some(St::BlockSequenceEntry);
            return Ok(Self::empty_scalar(t.end));
        }
        if !self.check_token(&["<block end>"])? {
            let t = self.peek_token()?;
            let (id, m) = (t.id(), t.start);
            return Err(self.parse_err(Some("while parsing a block collection"), self.marks.last().copied(), format!("expected <block end>, but found '{id}'"), m));
        }
        let t = self.get_token()?;
        self.pop_state();
        self.marks.pop();
        Ok(Event { ev: Ev::SequenceEnd, start: t.start })
    }

    fn parse_block_mapping_key(&mut self) -> R<Event> {
        if self.check_token(&["?"])? {
            let t = self.get_token()?;
            if !self.check_token(&["?", ":", "<block end>"])? {
                self.states.push(St::BlockMappingValue);
                return self.parse_node(true, true);
            }
            self.state = Some(St::BlockMappingValue);
            return Ok(Self::empty_scalar(t.end));
        }
        if !self.check_token(&["<block end>"])? {
            let t = self.peek_token()?;
            let (id, m) = (t.id(), t.start);
            return Err(self.parse_err(Some("while parsing a block mapping"), self.marks.last().copied(), format!("expected <block end>, but found '{id}'"), m));
        }
        let t = self.get_token()?;
        self.pop_state();
        self.marks.pop();
        Ok(Event { ev: Ev::MappingEnd, start: t.start })
    }

    fn parse_flow_sequence_entry(&mut self, first: bool) -> R<Event> {
        if !self.check_token(&["]"])? {
            if !first {
                if self.check_token(&[","])? {
                    self.get_token()?;
                } else {
                    let t = self.peek_token()?;
                    let (id, m) = (t.id(), t.start);
                    return Err(self.parse_err(Some("while parsing a flow sequence"), self.marks.last().copied(), format!("expected ',' or ']', but got '{id}'"), m));
                }
            }
            if self.check_token(&["?"])? {
                let m = self.ptok_start()?;
                self.state = Some(St::FlowSequenceEntryMappingKey);
                return Ok(Event { ev: Ev::MappingStart { anchor: None, tag: None }, start: m });
            } else if !self.check_token(&["]"])? {
                self.states.push(St::FlowSequenceEntry);
                return self.parse_node(false, false);
            }
        }
        let t = self.get_token()?;
        self.pop_state();
        self.marks.pop();
        Ok(Event { ev: Ev::SequenceEnd, start: t.start })
    }

    fn parse_flow_mapping_key(&mut self, first: bool) -> R<Event> {
        if !self.check_token(&["}"])? {
            if !first {
                if self.check_token(&[","])? {
                    self.get_token()?;
                } else {
                    let t = self.peek_token()?;
                    let (id, m) = (t.id(), t.start);
                    return Err(self.parse_err(Some("while parsing a flow mapping"), self.marks.last().copied(), format!("expected ',' or '}}', but got '{id}'"), m));
                }
            }
            if self.check_token(&["?"])? {
                let t = self.get_token()?;
                if !self.check_token(&[":", ",", "}"])? {
                    self.states.push(St::FlowMappingValue);
                    return self.parse_node(false, false);
                }
                self.state = Some(St::FlowMappingValue);
                return Ok(Self::empty_scalar(t.end));
            } else if !self.check_token(&["}"])? {
                self.states.push(St::FlowMappingEmptyValue);
                return self.parse_node(false, false);
            }
        }
        let t = self.get_token()?;
        self.pop_state();
        self.marks.pop();
        Ok(Event { ev: Ev::MappingEnd, start: t.start })
    }
}

// ── resolver ────────────────────────────────────────────────────────────────

struct Resolver {
    tag: &'static str,
    first: &'static str,
    re: regex::Regex,
}

fn implicit_resolvers() -> &'static [Resolver] {
    static R: OnceLock<Vec<Resolver>> = OnceLock::new();
    R.get_or_init(|| {
        // Python `re.match(...$)`: `$` also matches before one trailing "\n".
        let mk = |tag, first, pat: &str| Resolver { tag, first, re: regex::Regex::new(&format!(r"\A(?:{pat})\n?\z")).unwrap() };
        vec![
            mk("bool", "yYnNtTfFoO", r"yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF"),
            mk(
                "float",
                "-+0123456789.",
                r"[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)",
            ),
            mk("int", "-+0123456789", r"[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+"),
            mk("merge", "<", r"<<"),
            mk("null", "~nN", r"~|null|Null|NULL|"),
            mk(
                "timestamp",
                "0123456789",
                r"[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?",
            ),
            mk("value", "=", r"="),
            mk("yaml", "!&*", r"!|&|\*"),
        ]
    })
}

/// PyYAML `Resolver.resolve(ScalarNode, value, (True, False))` — the short
/// tag name (`bool`, `int`, …) of a plain scalar, or `None` for `str`.
pub(crate) fn resolve_plain(value: &str) -> Option<&'static str> {
    let first = value.chars().next();
    implicit_resolvers()
        .iter()
        .filter(|r| match first {
            None => r.tag == "null",
            Some(c) => r.first.contains(c),
        })
        .find(|r| r.re.is_match(value))
        .map(|r| r.tag)
}

// ── composer ────────────────────────────────────────────────────────────────

impl Loader {
    fn compose_err(&self, context: Option<&str>, cmark: Option<Mark>, problem: String, pmark: Mark) -> LoadError {
        self.marked("ComposerError", context, cmark, Some(problem), Some(pmark))
    }

    fn check_event_end(&mut self) -> R<bool> {
        Ok(matches!(self.peek_event()?.map(|e| &e.ev), Some(Ev::StreamEnd)))
    }

    fn get_single_node(&mut self) -> R<Option<usize>> {
        self.get_event()?;
        let mut document = None;
        if !self.check_event_end()? {
            document = Some(self.compose_document()?);
        }
        if !self.check_event_end()? {
            let ev = self.get_event()?.expect("event");
            let dm = document.map(|d| self.nodes[d].start);
            return Err(self.marked("ComposerError", Some("expected a single document in the stream"), dm, Some("but found another document".into()), Some(ev.start)));
        }
        self.get_event()?;
        Ok(document)
    }

    fn compose_document(&mut self) -> R<usize> {
        self.get_event()?;
        let node = self.compose_node()?;
        self.get_event()?;
        self.anchors.clear();
        Ok(node)
    }

    fn compose_node(&mut self) -> R<usize> {
        let ev = self.peek_event()?.cloned().expect("event");
        if let Ev::Alias(anchor) = &ev.ev {
            self.get_event()?;
            return match self.anchors.get(anchor) {
                Some(&n) => Ok(n),
                None => Err(self.compose_err(None, None, format!("found undefined alias {}", py_repr(anchor)), ev.start)),
            };
        }
        let anchor = match &ev.ev {
            Ev::Scalar { anchor, .. } | Ev::SequenceStart { anchor, .. } | Ev::MappingStart { anchor, .. } => anchor.clone(),
            _ => None,
        };
        if let Some(a) = &anchor {
            if let Some(&prev) = self.anchors.get(a) {
                let pm = self.nodes[prev].start;
                return Err(self.compose_err(Some(&format!("found duplicate anchor {}; first occurrence", py_repr(a))), Some(pm), "second occurrence".into(), ev.start));
            }
        }
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(LoadError::new("RecursionError", "maximum recursion depth exceeded"));
        }
        self.get_event()?;
        let id = match ev.ev {
            Ev::Scalar { tag, implicit, value, .. } => {
                let tag = match tag {
                    Some(t) if t != "!" => t,
                    _ => match implicit.0.then(|| resolve_plain(&value)).flatten() {
                        Some(short) => format!("{TAG_PREFIX}{short}"),
                        None => format!("{TAG_PREFIX}str"),
                    },
                };
                self.push_node(Node { tag, value: NodeValue::Scalar(value), start: ev.start }, anchor)
            }
            Ev::SequenceStart { tag, .. } => {
                let tag = tag.filter(|t| t != "!").unwrap_or_else(|| format!("{TAG_PREFIX}seq"));
                let id = self.push_node(Node { tag, value: NodeValue::Seq(vec![]), start: ev.start }, anchor);
                while !matches!(self.peek_event()?.map(|e| &e.ev), Some(Ev::SequenceEnd)) {
                    let child = self.compose_node()?;
                    if let NodeValue::Seq(v) = &mut self.nodes[id].value {
                        v.push(child);
                    }
                }
                self.get_event()?;
                id
            }
            Ev::MappingStart { tag, .. } => {
                let tag = tag.filter(|t| t != "!").unwrap_or_else(|| format!("{TAG_PREFIX}map"));
                let id = self.push_node(Node { tag, value: NodeValue::Map(vec![]), start: ev.start }, anchor);
                while !matches!(self.peek_event()?.map(|e| &e.ev), Some(Ev::MappingEnd)) {
                    let k = self.compose_node()?;
                    let v = self.compose_node()?;
                    if let NodeValue::Map(m) = &mut self.nodes[id].value {
                        m.push((k, v));
                    }
                }
                self.get_event()?;
                id
            }
            _ => unreachable!("composer saw a non-node event"),
        };
        self.depth -= 1;
        Ok(id)
    }

    fn push_node(&mut self, node: Node, anchor: Option<String>) -> usize {
        self.nodes.push(node);
        let id = self.nodes.len() - 1;
        if let Some(a) = anchor {
            self.anchors.insert(a, id);
        }
        id
    }
}

// ── constructor ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Obj {
    None,
    Bool(bool),
    Int(i128),
    /// `(value, is the shared `SafeConstructor.nan_value` object)`
    Float(f64, bool),
    Str(String),
    Bytes(Vec<u8>),
    Date(i64, i64, i64),
    DateTime(PyDateTime),
    List(Vec<usize>),
    Tuple(usize, usize),
    Set(Vec<usize>),
    Dict(Vec<(usize, usize)>),
}

#[derive(Clone, Copy)]
enum Fill {
    Seq,
    Map,
    Set,
    Omap,
    Pairs,
}

struct Constructor<'a> {
    l: &'a mut Loader,
    objs: Vec<Obj>,
    constructed: HashMap<usize, usize>,
    recursive: std::collections::HashSet<usize>,
    state_generators: Vec<(Fill, usize, usize)>,
}

fn cerr(l: &Loader, context: Option<&str>, cmark: Option<Mark>, problem: String, pmark: Mark) -> LoadError {
    l.marked("ConstructorError", context, cmark, Some(problem), Some(pmark))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

fn check_date(y: i64, m: i64, d: i64) -> Result<(), LoadError> {
    if !(1..=9999).contains(&y) {
        return Err(LoadError::new("ValueError", format!("year must be in 1..9999, not {y}")));
    }
    if !(1..=12).contains(&m) {
        return Err(LoadError::new("ValueError", format!("month must be in 1..12, not {m}")));
    }
    let dim = days_in_month(y, m);
    if !(1..=dim).contains(&d) {
        return Err(LoadError::new("ValueError", format!("day {d} must be in range 1..{dim} for month {m} in year {y}")));
    }
    Ok(())
}

/// `repr(datetime.timedelta(seconds=s))`.
fn timedelta_repr(s: i64) -> String {
    let days = s.div_euclid(86400);
    let secs = s.rem_euclid(86400);
    let mut parts = vec![];
    if days != 0 {
        parts.push(format!("days={days}"));
    }
    if secs != 0 {
        parts.push(format!("seconds={secs}"));
    }
    if parts.is_empty() {
        "datetime.timedelta(0)".into()
    } else {
        format!("datetime.timedelta({})", parts.join(", "))
    }
}

/// Python `str.strip()` whitespace.
fn py_strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c))
}

/// `int(s, base)` (after PyYAML removed underscores).
fn py_int(s: &str, base: u32) -> Result<Option<i128>, LoadError> {
    let bad = || {
        let mut r = py_repr(s);
        if r.chars().count() > 200 {
            r = r.chars().take(200).collect();
        }
        LoadError::new("ValueError", format!("invalid literal for int() with base {base}: {r}"))
    };
    let t = py_strip(s);
    let (neg, t) = match t.chars().next() {
        Some('-') => (true, &t[1..]),
        Some('+') => (false, &t[1..]),
        _ => (false, t),
    };
    let lower = t.to_ascii_lowercase();
    let t = match base {
        16 if lower.starts_with("0x") => &t[2..],
        8 if lower.starts_with("0o") => &t[2..],
        2 if lower.starts_with("0b") => &t[2..],
        _ => t,
    };
    if t.is_empty() {
        return Err(bad());
    }
    let mut v: Option<i128> = Some(0);
    for c in t.chars() {
        let d = c.to_digit(base).ok_or_else(bad)?;
        v = v.and_then(|v| v.checked_mul(base as i128)).and_then(|v| v.checked_add(d as i128));
    }
    Ok(v.map(|v| if neg { -v } else { v }))
}

/// `float(s)`.
fn py_float(s: &str) -> Result<f64, LoadError> {
    let t = py_strip(s);
    let ok = !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
    match t.parse::<f64>() {
        Ok(f) if ok => Ok(f),
        _ => Err(LoadError::new("ValueError", format!("could not convert string to float: {}", py_repr(s)))),
    }
}

/// CPython `binascii.a2b_base64(data)` in non-strict mode.
fn a2b_base64(data: &[u8]) -> Result<Vec<u8>, String> {
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = vec![];
    let (mut quad_pos, mut left, mut pads, mut count) = (0, 0u32, 0, 0usize);
    for &c in data {
        if c == b'=' {
            if quad_pos >= 2 {
                pads += 1;
                if quad_pos + pads >= 4 {
                    return Ok(out);
                }
            }
            continue;
        }
        let Some(v) = val(c) else { continue };
        pads = 0;
        count += 1;
        match quad_pos {
            0 => {
                quad_pos = 1;
                left = v;
            }
            1 => {
                quad_pos = 2;
                out.push(((left << 2) | (v >> 4)) as u8);
                left = v & 0x0f;
            }
            2 => {
                quad_pos = 3;
                out.push(((left << 4) | (v >> 2)) as u8);
                left = v & 0x03;
            }
            _ => {
                quad_pos = 0;
                out.push(((left << 6) | v) as u8);
                left = 0;
            }
        }
    }
    if quad_pos == 1 {
        return Err(format!("Invalid base64-encoded string: number of data characters ({count}) cannot be 1 more than a multiple of 4"));
    }
    if quad_pos != 0 {
        return Err("Incorrect padding".into());
    }
    Ok(out)
}

fn timestamp_re() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| {
        regex::Regex::new(
            r"\A(?P<year>[0-9][0-9][0-9][0-9])-(?P<month>[0-9][0-9]?)-(?P<day>[0-9][0-9]?)(?:(?:[Tt]|[ \t]+)(?P<hour>[0-9][0-9]?):(?P<minute>[0-9][0-9]):(?P<second>[0-9][0-9])(?:\.(?P<fraction>[0-9]*))?(?:[ \t]*(?P<tz>Z|(?P<tz_sign>[-+])(?P<tz_hour>[0-9][0-9]?)(?::(?P<tz_minute>[0-9][0-9]))?))?)?\n?\z",
        )
        .unwrap()
    })
}

impl<'a> Constructor<'a> {
    fn new_obj(&mut self, o: Obj) -> usize {
        self.objs.push(o);
        self.objs.len() - 1
    }

    fn construct_document(&mut self, node: usize) -> R<usize> {
        let data = self.construct_object(node)?;
        while !self.state_generators.is_empty() {
            let gens = std::mem::take(&mut self.state_generators);
            for (fill, node, obj) in gens {
                self.run_fill(fill, node, obj)?;
            }
        }
        Ok(data)
    }

    fn construct_object(&mut self, node: usize) -> R<usize> {
        if let Some(&o) = self.constructed.get(&node) {
            return Ok(o);
        }
        if self.recursive.contains(&node) {
            return Err(cerr(self.l, None, None, "found unconstructable recursive node".into(), self.l.nodes[node].start));
        }
        self.recursive.insert(node);
        let tag = self.l.nodes[node].tag.clone();
        let short = tag.strip_prefix(TAG_PREFIX).unwrap_or("");
        let fill = match short {
            "seq" => Some((Fill::Seq, Obj::List(vec![]))),
            "map" => Some((Fill::Map, Obj::Dict(vec![]))),
            "set" => Some((Fill::Set, Obj::Set(vec![]))),
            "omap" => Some((Fill::Omap, Obj::List(vec![]))),
            "pairs" => Some((Fill::Pairs, Obj::List(vec![]))),
            _ => None,
        };
        let data = match fill {
            Some((f, empty)) if tag.starts_with(TAG_PREFIX) => {
                let o = self.new_obj(empty);
                self.state_generators.push((f, node, o));
                o
            }
            _ => {
                let o = self.construct_scalar_tag(node, &tag)?;
                self.new_obj(o)
            }
        };
        self.constructed.insert(node, data);
        self.recursive.remove(&node);
        Ok(data)
    }

    /// `SafeConstructor.construct_scalar`.
    fn construct_scalar(&self, node: usize) -> R<String> {
        let n = &self.l.nodes[node];
        match &n.value {
            NodeValue::Scalar(s) => Ok(s.clone()),
            NodeValue::Map(pairs) => {
                for &(k, v) in pairs {
                    if self.l.nodes[k].tag == format!("{TAG_PREFIX}value") {
                        return self.construct_scalar(v);
                    }
                }
                Err(cerr(self.l, None, None, format!("expected a scalar node, but found {}", n.id()), n.start))
            }
            NodeValue::Seq(_) => Err(cerr(self.l, None, None, format!("expected a scalar node, but found {}", n.id()), n.start)),
        }
    }

    fn construct_scalar_tag(&mut self, node: usize, tag: &str) -> R<Obj> {
        let short = tag.strip_prefix(TAG_PREFIX);
        match short {
            Some("null") => {
                self.construct_scalar(node)?;
                Ok(Obj::None)
            }
            Some("bool") => {
                let v = self.construct_scalar(node)?.to_lowercase();
                match v.as_str() {
                    "yes" | "true" | "on" => Ok(Obj::Bool(true)),
                    "no" | "false" | "off" => Ok(Obj::Bool(false)),
                    _ => Err(LoadError::new("KeyError", py_repr(&v))),
                }
            }
            Some("int") => {
                let raw = self.construct_scalar(node)?.replace('_', "");
                self.yaml_int(&raw)
            }
            Some("float") => {
                let raw = self.construct_scalar(node)?.replace('_', "").to_lowercase();
                self.yaml_float(&raw)
            }
            Some("binary") => {
                let v = self.construct_scalar(node)?;
                let start = self.l.nodes[node].start;
                let chars: Vec<char> = v.chars().collect();
                if let Some(i) = chars.iter().position(|c| !c.is_ascii()) {
                    // UnicodeEncodeError reports the whole run of unencodable characters.
                    let run = chars[i..].iter().take_while(|c| !c.is_ascii()).count();
                    let what = if run == 1 {
                        let u = chars[i] as u32;
                        let esc = if u < 0x100 {
                            format!("\\x{u:02x}")
                        } else if u < 0x10000 {
                            format!("\\u{u:04x}")
                        } else {
                            format!("\\U{u:08x}")
                        };
                        format!("character '{esc}' in position {i}")
                    } else {
                        format!("characters in position {i}-{}", i + run - 1)
                    };
                    let msg = format!("failed to convert base64 data into ascii: 'ascii' codec can't encode {what}: ordinal not in range(128)");
                    return Err(cerr(self.l, None, None, msg, start));
                }
                a2b_base64(v.as_bytes()).map(Obj::Bytes).map_err(|e| cerr(self.l, None, None, format!("failed to decode base64 data: {e}"), start))
            }
            Some("timestamp") => {
                let v = self.construct_scalar(node)?;
                self.yaml_timestamp(&v)
            }
            Some("str") => Ok(Obj::Str(self.construct_scalar(node)?)),
            _ => {
                let n = &self.l.nodes[node];
                Err(cerr(self.l, None, None, format!("could not determine a constructor for the tag {}", py_repr(tag)), n.start))
            }
        }
    }

    fn yaml_int(&self, value: &str) -> R<Obj> {
        let mut chars = value.chars();
        let Some(first) = chars.next() else { return Err(LoadError::new("IndexError", "string index out of range")) };
        let sign: i128 = if first == '-' { -1 } else { 1 };
        let v = if first == '+' || first == '-' { &value[1..] } else { value };
        let wrap = |r: Option<i128>| -> Obj {
            match r.and_then(|x| x.checked_mul(sign)) {
                Some(x) => Obj::Int(x),
                // Beyond i128: keep the magnitude as a float (Python has bignums).
                None => Obj::Float(f64::INFINITY * sign as f64, false),
            }
        };
        if v == "0" {
            return Ok(Obj::Int(0));
        }
        if let Some(rest) = v.strip_prefix("0b") {
            return Ok(wrap(py_int(rest, 2)?));
        }
        if let Some(rest) = v.strip_prefix("0x") {
            return Ok(wrap(py_int(rest, 16)?));
        }
        if v.is_empty() {
            return Err(LoadError::new("IndexError", "string index out of range"));
        }
        if v.starts_with('0') {
            return Ok(wrap(py_int(v, 8)?));
        }
        if v.contains(':') {
            let mut total: Option<i128> = Some(0);
            let mut base: Option<i128> = Some(1);
            let digits: Vec<Option<i128>> = v.split(':').map(|p| py_int(p, 10)).collect::<Result<_, _>>()?;
            for d in digits.into_iter().rev() {
                total = match (total, d, base) {
                    (Some(t), Some(d), Some(b)) => d.checked_mul(b).and_then(|x| t.checked_add(x)),
                    _ => None,
                };
                base = base.and_then(|b| b.checked_mul(60));
            }
            return Ok(wrap(total));
        }
        Ok(wrap(py_int(v, 10)?))
    }

    fn yaml_float(&self, value: &str) -> R<Obj> {
        let Some(first) = value.chars().next() else { return Err(LoadError::new("IndexError", "string index out of range")) };
        let sign = if first == '-' { -1.0 } else { 1.0 };
        let v = if first == '+' || first == '-' { &value[1..] } else { value };
        if v == ".inf" {
            return Ok(Obj::Float(sign * f64::INFINITY, false));
        }
        if v == ".nan" {
            return Ok(Obj::Float(f64::NAN, true));
        }
        if v.contains(':') {
            let digits: Vec<f64> = v.split(':').map(py_float).collect::<Result<_, _>>()?;
            let mut base = 1.0f64;
            let mut total = 0.0f64;
            for d in digits.into_iter().rev() {
                total += d * base;
                base *= 60.0;
            }
            return Ok(Obj::Float(sign * total, false));
        }
        Ok(Obj::Float(sign * py_float(v)?, false))
    }

    fn yaml_timestamp(&self, value: &str) -> R<Obj> {
        let Some(c) = timestamp_re().captures(value) else {
            return Err(LoadError::new("AttributeError", "'NoneType' object has no attribute 'groupdict'"));
        };
        let num = |k: &str| c.name(k).map(|m| m.as_str().parse::<i64>().unwrap_or(0));
        let (year, month, day) = (num("year").unwrap(), num("month").unwrap(), num("day").unwrap());
        if c.name("hour").is_none_or(|m| m.as_str().is_empty()) {
            check_date(year, month, day)?;
            return Ok(Obj::Date(year, month, day));
        }
        let (hour, minute, second) = (num("hour").unwrap(), num("minute").unwrap(), num("second").unwrap());
        let mut microsecond = 0;
        if let Some(f) = c.name("fraction").map(|m| m.as_str()).filter(|f| !f.is_empty()) {
            let mut f: String = f.chars().take(6).collect();
            while f.len() < 6 {
                f.push('0');
            }
            microsecond = f.parse::<i64>().unwrap_or(0);
        }
        let mut offset = None;
        if let Some(sign) = c.name("tz_sign") {
            let delta = num("tz_hour").unwrap() * 3600 + num("tz_minute").unwrap_or(0) * 60;
            let delta = if sign.as_str() == "-" { -delta } else { delta };
            if delta.abs() >= 86400 {
                return Err(LoadError::new(
                    "ValueError",
                    format!("offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not {}", timedelta_repr(delta)),
                ));
            }
            offset = Some(delta);
        } else if c.name("tz").is_some() {
            offset = Some(0);
        }
        check_date(year, month, day)?;
        for (v, name, hi) in [(hour, "hour", 23), (minute, "minute", 59), (second, "second", 59)] {
            if !(0..=hi).contains(&v) {
                return Err(LoadError::new("ValueError", format!("{name} must be in 0..{hi}, not {v}")));
            }
        }
        Ok(Obj::DateTime(PyDateTime { year, month, day, hour, minute, second, microsecond, offset }))
    }

    fn is_hashable(&self, o: usize) -> bool {
        !matches!(self.objs[o], Obj::List(_) | Obj::Dict(_) | Obj::Set(_))
    }

    /// Python `==` between two hashable objects (dict key lookup).
    fn key_eq(&self, a: usize, b: usize) -> bool {
        if a == b {
            return true;
        }
        let num = |o: &Obj| -> Option<(Option<i128>, f64)> {
            match o {
                Obj::Bool(v) => Some((Some(*v as i128), *v as i128 as f64)),
                Obj::Int(v) => Some((Some(*v), *v as f64)),
                Obj::Float(f, _) => Some((None, *f)),
                _ => None,
            }
        };
        match (&self.objs[a], &self.objs[b]) {
            (Obj::Float(x, true), Obj::Float(y, true)) if x.is_nan() && y.is_nan() => true,
            (x, y) if num(x).is_some() && num(y).is_some() => {
                let (xi, xf) = num(x).unwrap();
                let (yi, yf) = num(y).unwrap();
                match (xi, yi) {
                    (Some(p), Some(q)) => p == q,
                    (Some(i), None) | (None, Some(i)) => {
                        let f = if xi.is_some() { yf } else { xf };
                        f.is_finite() && f.fract() == 0.0 && f.abs() < 1.7e38 && f as i128 == i
                    }
                    (None, None) => xf == yf,
                }
            }
            (Obj::None, Obj::None) => true,
            (Obj::Str(x), Obj::Str(y)) => x == y,
            (Obj::Bytes(x), Obj::Bytes(y)) => x == y,
            (Obj::Date(a1, b1, c1), Obj::Date(a2, b2, c2)) => (a1, b1, c1) == (a2, b2, c2),
            (Obj::DateTime(x), Obj::DateTime(y)) => match (x.offset, y.offset) {
                (None, None) => x == y,
                (Some(_), Some(_)) => x.utc_seconds() == y.utc_seconds() && x.microsecond == y.microsecond,
                _ => false,
            },
            _ => false,
        }
    }

    fn node_pairs(&self, node: usize) -> Vec<(usize, usize)> {
        match &self.l.nodes[node].value {
            NodeValue::Map(p) => p.clone(),
            _ => vec![],
        }
    }

    fn flatten_mapping(&mut self, node: usize) -> R<()> {
        let merge_tag = format!("{TAG_PREFIX}merge");
        let value_tag = format!("{TAG_PREFIX}value");
        let mut merge: Vec<(usize, usize)> = vec![];
        let mut index = 0;
        loop {
            let pairs = self.node_pairs(node);
            if index >= pairs.len() {
                break;
            }
            let (key_node, value_node) = pairs[index];
            if self.l.nodes[key_node].tag == merge_tag {
                if let NodeValue::Map(p) = &mut self.l.nodes[node].value {
                    p.remove(index);
                }
                match &self.l.nodes[value_node].value {
                    NodeValue::Map(_) => {
                        self.flatten_mapping(value_node)?;
                        merge.extend(self.node_pairs(value_node));
                    }
                    NodeValue::Seq(items) => {
                        let items = items.clone();
                        let mut submerge = vec![];
                        for sub in items {
                            if !matches!(self.l.nodes[sub].value, NodeValue::Map(_)) {
                                let (ns, sm, sid) = (self.l.nodes[node].start, self.l.nodes[sub].start, self.l.nodes[sub].id());
                                return Err(cerr(self.l, Some("while constructing a mapping"), Some(ns), format!("expected a mapping for merging, but found {sid}"), sm));
                            }
                            self.flatten_mapping(sub)?;
                            submerge.push(self.node_pairs(sub));
                        }
                        for v in submerge.into_iter().rev() {
                            merge.extend(v);
                        }
                    }
                    NodeValue::Scalar(_) => {
                        let (ns, vm, vid) = (self.l.nodes[node].start, self.l.nodes[value_node].start, self.l.nodes[value_node].id());
                        return Err(cerr(
                            self.l,
                            Some("while constructing a mapping"),
                            Some(ns),
                            format!("expected a mapping or list of mappings for merging, but found {vid}"),
                            vm,
                        ));
                    }
                }
            } else if self.l.nodes[key_node].tag == value_tag {
                self.l.nodes[key_node].tag = format!("{TAG_PREFIX}str");
                index += 1;
            } else {
                index += 1;
            }
        }
        if !merge.is_empty() {
            if let NodeValue::Map(p) = &mut self.l.nodes[node].value {
                merge.extend(p.iter().copied());
                *p = merge;
            }
        }
        Ok(())
    }

    /// `SafeConstructor.construct_mapping` → ordered, de-duplicated pairs.
    fn construct_mapping(&mut self, node: usize) -> R<Vec<(usize, usize)>> {
        if matches!(self.l.nodes[node].value, NodeValue::Map(_)) {
            self.flatten_mapping(node)?;
        }
        let n = &self.l.nodes[node];
        let NodeValue::Map(pairs) = &n.value else {
            return Err(cerr(self.l, None, None, format!("expected a mapping node, but found {}", n.id()), n.start));
        };
        let pairs = pairs.clone();
        let mut mapping: Vec<(usize, usize)> = vec![];
        for (kn, vn) in pairs {
            let key = self.construct_object(kn)?;
            if !self.is_hashable(key) {
                return Err(cerr(self.l, Some("while constructing a mapping"), Some(self.l.nodes[node].start), "found unhashable key".into(), self.l.nodes[kn].start));
            }
            let value = self.construct_object(vn)?;
            match mapping.iter().position(|&(k, _)| self.key_eq(k, key)) {
                Some(i) => mapping[i].1 = value,
                None => mapping.push((key, value)),
            }
        }
        Ok(mapping)
    }

    fn run_fill(&mut self, fill: Fill, node: usize, obj: usize) -> R<()> {
        match fill {
            Fill::Seq => {
                let n = &self.l.nodes[node];
                let NodeValue::Seq(items) = &n.value else {
                    return Err(cerr(self.l, None, None, format!("expected a sequence node, but found {}", n.id()), n.start));
                };
                let items = items.clone();
                let mut out = vec![];
                for c in items {
                    out.push(self.construct_object(c)?);
                }
                self.objs[obj] = Obj::List(out);
            }
            Fill::Map => {
                let m = self.construct_mapping(node)?;
                self.objs[obj] = Obj::Dict(m);
            }
            Fill::Set => {
                let m = self.construct_mapping(node)?;
                self.objs[obj] = Obj::Set(m.into_iter().map(|(k, _)| k).collect());
            }
            Fill::Omap | Fill::Pairs => {
                let ctx = if matches!(fill, Fill::Omap) { "while constructing an ordered map" } else { "while constructing pairs" };
                let n = &self.l.nodes[node];
                let NodeValue::Seq(items) = &n.value else {
                    return Err(cerr(self.l, Some(ctx), Some(n.start), format!("expected a sequence, but found {}", n.id()), n.start));
                };
                let (items, nstart) = (items.clone(), n.start);
                let mut out = vec![];
                for sub in items {
                    let s = &self.l.nodes[sub];
                    let NodeValue::Map(p) = &s.value else {
                        return Err(cerr(self.l, Some(ctx), Some(nstart), format!("expected a mapping of length 1, but found {}", s.id()), s.start));
                    };
                    if p.len() != 1 {
                        return Err(cerr(self.l, Some(ctx), Some(nstart), format!("expected a single mapping item, but found {} items", p.len()), s.start));
                    }
                    let (kn, vn) = p[0];
                    let k = self.construct_object(kn)?;
                    let v = self.construct_object(vn)?;
                    out.push(self.new_obj(Obj::Tuple(k, v)));
                }
                self.objs[obj] = Obj::List(out);
            }
        }
        Ok(())
    }

    fn to_py(&self, o: usize, stack: &mut Vec<usize>) -> R<Py> {
        if stack.contains(&o) || stack.len() > MAX_DEPTH {
            return Err(LoadError::new("ValueError", "Circular reference detected"));
        }
        stack.push(o);
        let r = match &self.objs[o] {
            Obj::None => Py::None,
            Obj::Bool(b) => Py::Bool(*b),
            Obj::Int(i) => Py::Int(*i),
            Obj::Float(f, _) => Py::Float(*f),
            Obj::Str(s) => Py::Str(s.clone()),
            Obj::Bytes(b) => Py::Bytes(b.clone()),
            Obj::Date(y, m, d) => Py::Date(*y, *m, *d),
            Obj::DateTime(dt) => Py::DateTime(*dt),
            Obj::List(v) => Py::List(v.iter().map(|&c| self.to_py(c, stack)).collect::<R<_>>()?),
            Obj::Tuple(k, v) => Py::Tuple(vec![self.to_py(*k, stack)?, self.to_py(*v, stack)?]),
            Obj::Set(v) => Py::Set(v.iter().map(|&c| self.to_py(c, stack)).collect::<R<_>>()?),
            Obj::Dict(v) => Py::Dict(v.iter().map(|&(k, x)| Ok((self.to_py(k, stack)?, self.to_py(x, stack)?))).collect::<R<_>>()?),
        };
        stack.pop();
        Ok(r)
    }
}

/// `yaml.safe_load(text)` as a Python-object tree.
pub fn safe_load_py(text: &str) -> Result<Py, LoadError> {
    let mut l = Loader::new(text)?;
    let Some(root) = l.get_single_node()? else { return Ok(Py::None) };
    let mut c = Constructor { l: &mut l, objs: vec![], constructed: HashMap::new(), recursive: Default::default(), state_generators: vec![] };
    let data = c.construct_document(root)?;
    c.to_py(data, &mut vec![])
}

impl Py {
    /// `d.get(key)` for a dict with a `str` key.
    pub fn get(&self, key: &str) -> Option<&Py> {
        match self {
            Py::Dict(v) => v.iter().find(|(k, _)| matches!(k, Py::Str(s) if s == key)).map(|(_, x)| x),
            _ => None,
        }
    }

    /// `type(x).__name__`.
    pub fn type_name(&self) -> &'static str {
        match self {
            Py::None => "NoneType",
            Py::Bool(_) => "bool",
            Py::Int(_) => "int",
            Py::Float(_) => "float",
            Py::Str(_) => "str",
            Py::Bytes(_) => "bytes",
            Py::Date(..) => "date",
            Py::DateTime(_) => "datetime",
            Py::List(_) => "list",
            Py::Tuple(_) => "tuple",
            Py::Set(_) => "set",
            Py::Dict(_) => "dict",
        }
    }

    /// Python `repr(x)`.
    pub fn repr(&self) -> String {
        let join = |v: &[Py]| v.iter().map(Py::repr).collect::<Vec<_>>().join(", ");
        match self {
            Py::None => "None".into(),
            Py::Bool(b) => if *b { "True" } else { "False" }.into(),
            Py::Int(i) => i.to_string(),
            Py::Float(f) if f.is_nan() => "nan".into(),
            Py::Float(f) if f.is_infinite() => if *f > 0.0 { "inf" } else { "-inf" }.into(),
            Py::Float(f) => crate::pyjson::float_repr(*f),
            Py::Str(s) => py_repr(s),
            Py::Bytes(b) => {
                let q = if b.contains(&b'\'') && !b.contains(&b'"') { '"' } else { '\'' };
                let mut out = format!("b{q}");
                for &c in b {
                    match c {
                        b'\\' => out.push_str("\\\\"),
                        b'\t' => out.push_str("\\t"),
                        b'\n' => out.push_str("\\n"),
                        b'\r' => out.push_str("\\r"),
                        c if c as char == q => {
                            out.push('\\');
                            out.push(q);
                        }
                        0x20..=0x7e => out.push(c as char),
                        c => out.push_str(&format!("\\x{c:02x}")),
                    }
                }
                out.push(q);
                out
            }
            Py::Date(y, m, d) => format!("datetime.date({y}, {m}, {d})"),
            Py::DateTime(dt) => {
                let mut s = format!("datetime.datetime({}, {}, {}, {}, {}", dt.year, dt.month, dt.day, dt.hour, dt.minute);
                if dt.microsecond != 0 {
                    s.push_str(&format!(", {}, {}", dt.second, dt.microsecond));
                } else if dt.second != 0 {
                    s.push_str(&format!(", {}", dt.second));
                }
                match dt.offset {
                    None => {}
                    Some(0) => s.push_str(", tzinfo=datetime.timezone.utc"),
                    Some(o) => s.push_str(&format!(", tzinfo=datetime.timezone({})", timedelta_repr(o))),
                }
                s.push(')');
                s
            }
            Py::List(v) => format!("[{}]", join(v)),
            Py::Tuple(v) if v.len() == 1 => format!("({},)", v[0].repr()),
            Py::Tuple(v) => format!("({})", join(v)),
            Py::Set(v) if v.is_empty() => "set()".into(),
            Py::Set(v) => format!("{{{}}}", join(v)),
            Py::Dict(v) => format!("{{{}}}", v.iter().map(|(k, x)| format!("{}: {}", k.repr(), x.repr())).collect::<Vec<_>>().join(", ")),
        }
    }

    /// Python truthiness (`x or {}`).
    pub fn truthy(&self) -> bool {
        match self {
            Py::None => false,
            Py::Bool(b) => *b,
            Py::Int(i) => *i != 0,
            Py::Float(f) => *f != 0.0,
            Py::Str(s) => !s.is_empty(),
            Py::Bytes(b) => !b.is_empty(),
            Py::Date(..) | Py::DateTime(_) => true,
            Py::List(v) | Py::Tuple(v) | Py::Set(v) => !v.is_empty(),
            Py::Dict(v) => !v.is_empty(),
        }
    }

    /// FastAPI `jsonable_encoder` → JSON: dates become ISO strings, bytes
    /// UTF-8 text, sets/tuples arrays; dict keys follow `json.dumps`
    /// (`true`/`null`/`1.5`). NaN/±inf (not representable) become `null`.
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::Value;
        match self {
            Py::None => Value::Null,
            Py::Bool(b) => Value::Bool(*b),
            Py::Int(i) => {
                if let Ok(v) = i64::try_from(*i) {
                    Value::from(v)
                } else if let Ok(v) = u64::try_from(*i) {
                    Value::from(v)
                } else {
                    serde_json::Number::from_f64(*i as f64).map(Value::Number).unwrap_or(Value::Null)
                }
            }
            Py::Float(f) => serde_json::Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
            Py::Str(s) => Value::String(s.clone()),
            Py::Bytes(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
            Py::Date(y, m, d) => Value::String(format!("{y:04}-{m:02}-{d:02}")),
            Py::DateTime(dt) => Value::String(dt.isoformat()),
            Py::List(v) | Py::Tuple(v) | Py::Set(v) => Value::Array(v.iter().map(Py::to_json).collect()),
            Py::Dict(v) => {
                let mut m = serde_json::Map::new();
                for (k, x) in v {
                    m.insert(k.json_key(), x.to_json());
                }
                Value::Object(m)
            }
        }
    }

    /// `json.dumps` key text.
    pub fn json_key(&self) -> String {
        match self {
            Py::None => "null".into(),
            Py::Bool(b) => if *b { "true" } else { "false" }.into(),
            Py::Int(i) => i.to_string(),
            Py::Float(f) => crate::pyjson::float_repr(*f),
            Py::Str(s) => s.clone(),
            other => match other.to_json() {
                serde_json::Value::String(s) => s,
                v => v.to_string(),
            },
        }
    }
}

/// `yaml.safe_load(text)` → JSON (see [`Py::to_json`]).
pub fn safe_load(text: &str) -> Result<serde_json::Value, LoadError> {
    safe_load_py(text).map(|p| p.to_json())
}
