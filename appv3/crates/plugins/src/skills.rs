//! Skill discovery and `SKILL.md` frontmatter.
//!
//! A skill is a folder holding a file named exactly `SKILL.md`. Folders are
//! only ever looked at one level below a container (`skills/`); nothing is
//! searched deeper.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::util::{display_rel, has_entry, read_head, resolve_inside, shorten};
use crate::Skill;

const SKILL_FILE: &str = "SKILL.md";

/// How much of a `SKILL.md` is read; the frontmatter is at the top.
const HEAD_BYTES: u64 = 128 * 1024;

/// Collects skills, the warnings about them, and the `SKILL.md` files read
/// (the fingerprint covers those).
pub(crate) struct Scan<'a> {
    root: &'a Path,
    skills: Vec<Skill>,
    warnings: &'a mut Vec<String>,
    files: &'a mut Vec<PathBuf>,
}

impl<'a> Scan<'a> {
    /// `root` must be the canonical bundle root.
    pub(crate) fn new(root: &'a Path, warnings: &'a mut Vec<String>, files: &'a mut Vec<PathBuf>) -> Self {
        Scan { root, skills: Vec::new(), warnings, files }
    }

    pub(crate) fn finish(self) -> Vec<Skill> {
        self.skills
    }

    fn warn(&mut self, message: String) {
        self.warnings.push(message);
    }

    /// Reads one skill per immediate child folder of `dir` that holds a
    /// `SKILL.md` (the `skills/` scan). An absent `dir` is not an error; one
    /// that is not a folder, or resolves outside the root, is reported.
    pub(crate) fn container(&mut self, dir: &Path) {
        let label = display_rel(self.root, dir);
        match fs::symlink_metadata(dir) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(e) => {
                self.warn(format!("{label}: cannot be read ({e}); skills ignored"));
                return;
            }
        }
        let real = match resolve_inside(self.root, dir) {
            Ok(real) => real,
            Err(why) => {
                self.warn(format!("{label}: {why}; skills ignored"));
                return;
            }
        };
        if !real.is_dir() {
            self.warn(format!("{label}: not a directory; skills ignored"));
            return;
        }
        let mut names: Vec<OsString> = match fs::read_dir(&real) {
            Ok(entries) => entries.flatten().map(|entry| entry.file_name()).collect(),
            Err(e) => {
                self.warn(format!("{label}: cannot be read ({e}); skills ignored"));
                return;
            }
        };
        names.sort();
        for name in names {
            let child = dir.join(&name);
            let is_skill_folder = fs::metadata(&child).map(|m| m.is_dir()).unwrap_or(false) && has_entry(&child, SKILL_FILE);
            if !is_skill_folder {
                continue;
            }
            match name.to_str() {
                Some(name) => self.folder(&child, name),
                None => self.warn(format!("{label}: a skill folder name is not valid UTF-8; skipped")),
            }
        }
    }

    /// Reads the skill in `folder` (which holds a `SKILL.md`), called `name`.
    pub(crate) fn folder(&mut self, folder: &Path, name: &str) {
        let file = folder.join(SKILL_FILE);
        let label = display_rel(self.root, &file);
        if name.chars().any(char::is_control) {
            self.warn(format!("{label}: the folder name has control characters; skipped"));
            return;
        }
        // The folder and the file must both resolve inside the root: a folder
        // that escapes would let its `scripts/` and `references/` escape too.
        let dir = match resolve_inside(self.root, folder) {
            Ok(dir) => dir,
            Err(why) => {
                self.warn(format!("{label}: the folder {why}; skipped"));
                return;
            }
        };
        let real_file = match resolve_inside(self.root, &file) {
            Ok(real) => real,
            Err(why) => {
                self.warn(format!("{label}: {why}; skipped"));
                return;
            }
        };
        if !real_file.is_file() {
            self.warn(format!("{label}: not a regular file; skipped"));
            return;
        }
        self.files.push(real_file.clone());
        let text = match read_head(&real_file, HEAD_BYTES) {
            Ok(text) => text,
            Err(e) => {
                self.warn(format!("{label}: cannot be read ({e}); skipped"));
                return;
            }
        };
        let frontmatter = parse_frontmatter(&text);
        let Some(description) = frontmatter.description.filter(|d| !d.is_empty()) else {
            self.warn(format!("{label}: missing description; skipped"));
            return;
        };
        if let Some(declared) = frontmatter.name.filter(|declared| declared != name) {
            self.warn(format!("{label}: name '{}' differs from the folder name '{name}'; using '{name}'", shorten(&declared, 64)));
        }
        self.skills.push(Skill { name: name.to_string(), dir, description });
    }
}

/// The two frontmatter keys that matter.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// Reads `name` and `description` from the `---` block at the top of a
/// `SKILL.md`. This is a small YAML subset, lenient where real files are:
/// plain, `"…"` and `'…'` scalars (a plain value may contain `: `), values
/// continued on indented lines, and `>` / `|` block scalars (lines joined by
/// one space; a description is one paragraph). Other keys are skipped.
pub(crate) fn parse_frontmatter(text: &str) -> Frontmatter {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Frontmatter::default();
    }
    let mut block: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            closed = true;
            break;
        }
        block.push(line);
    }
    if !closed {
        return Frontmatter::default();
    }

    let mut frontmatter = Frontmatter::default();
    let mut index = 0;
    while index < block.len() {
        let Some((key, first)) = split_key(block[index]) else {
            index += 1;
            continue;
        };
        let mut end = index + 1;
        while end < block.len() && (block[end].trim().is_empty() || block[end].starts_with([' ', '\t'])) {
            end += 1;
        }
        let value = scalar(first, &block[index + 1..end]);
        match key {
            "name" => frontmatter.name = Some(value),
            "description" => frontmatter.description = Some(value),
            _ => {}
        }
        index = end;
    }
    frontmatter
}

/// Splits a top-level `key: rest` line. The colon must end the line or be
/// followed by a space, as in YAML.
fn split_key(line: &str) -> Option<(&str, &str)> {
    if line.starts_with([' ', '\t', '#', '-']) {
        return None;
    }
    let (key, rest) = line.split_once(':')?;
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    Some((key.trim_end(), rest))
}

/// The value of a key: `first` is the text after the colon, `rest` the
/// indented lines that follow.
fn scalar(first: &str, rest: &[&str]) -> String {
    let first = first.trim();
    let continuation = rest.iter().map(|line| line.trim()).filter(|line| !line.is_empty() && !line.starts_with('#'));
    if is_block_header(first) {
        return continuation.collect::<Vec<_>>().join(" ");
    }
    let mut text = first.to_string();
    for line in continuation {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(line);
    }
    let value = match text.chars().next() {
        Some('"') => unquote_double(&text),
        Some('\'') => unquote_single(&text),
        _ => strip_comment(&text),
    };
    value.trim().to_string()
}

/// `>`, `|`, optionally with chomping/indent indicators (`>-`, `|2`) and a
/// comment.
fn is_block_header(text: &str) -> bool {
    let Some(rest) = text.strip_prefix(['>', '|']) else {
        return false;
    };
    let rest = rest.trim_start_matches(|c: char| c == '+' || c == '-' || c.is_ascii_digit()).trim();
    rest.is_empty() || rest.starts_with('#')
}

/// Drops a trailing ` # comment` from a plain scalar.
fn strip_comment(text: &str) -> String {
    let mut after_space = true;
    for (index, c) in text.char_indices() {
        if c == '#' && after_space {
            return text[..index].to_string();
        }
        after_space = c.is_whitespace();
    }
    text.to_string()
}

/// The content of a `"…"` scalar. An unterminated quote leaves the text as
/// written, rather than losing the description.
fn unquote_double(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text[1..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return out,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some(escaped @ ('"' | '\\' | '/')) => out.push(escaped),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            },
            other => out.push(other),
        }
    }
    text.to_string()
}

/// The content of a `'…'` scalar (`''` is a quote).
fn unquote_single(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text[1..].chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\'' {
            out.push(c);
        } else if chars.peek() == Some(&'\'') {
            chars.next();
            out.push('\'');
        } else {
            return out;
        }
    }
    text.to_string()
}
