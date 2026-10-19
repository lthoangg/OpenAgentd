//! The plugin `regex` module: patterns compiled and matched natively.
//!
//! QuickJS's backtracking `RegExp` is slow on the patterns plugins port from
//! v2 Python (`\b`/`\s`/`\w` must be emulated with Unicode lookarounds, which
//! also defeats literal-prefix scanning). Rust `regex` speaks that dialect
//! natively and runs in linear time; `fancy-regex` takes over only when a
//! pattern needs lookaround or back-references. Only match spans cross back
//! to JS, as UTF-16 offsets so `String.prototype.slice` can use them directly.
//!
//! Two constructs are slow even natively: Unicode `\b` (the lazy DFA gives up
//! on the first non-ASCII byte and the PikeVM scans instead) and anything
//! that needs fancy-regex's backtracker. For those patterns a *superset*
//! prefilter is compiled — the same pattern with assertions and lookarounds
//! dropped and back-references widened to `.*?`. It matches wherever the
//! real pattern can, runs on the DFA, and when it finds nothing (the common
//! case for scanners over tool output) the slow engine is skipped.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Distinct `(pattern, flags)` pairs one plugin may compile.
const MAX_PATTERNS: usize = 4096;

enum Matcher {
    Fast(regex::Regex),
    Fancy(fancy_regex::Regex),
}

struct Compiled {
    matcher: Matcher,
    /// Superset of `matcher` that the DFA can run; `None` = not needed/possible.
    prefilter: Option<regex::Regex>,
}

#[derive(Default)]
pub struct Regexes {
    compiled: Vec<Compiled>,
    ids: HashMap<(String, String), usize>,
}

fn inline_flags(flags: &str) -> Result<String, String> {
    let mut out = String::new();
    for f in flags.chars() {
        if !"imsx".contains(f) {
            return Err(format!("unknown regex flag '{f}' (supported: i, m, s, x)"));
        }
        if !out.contains(f) {
            out.push(f);
        }
    }
    Ok(if out.is_empty() { out } else { format!("(?{out})") })
}

/// Relax `e` into an expression matching a superset of its strings, or
/// `None` when a construct has no safe relaxation. `changed` reports whether
/// anything slow was removed (otherwise no prefilter is worth having).
///
/// Leaves are allow-listed: anything not named here returns `None`, because
/// `Expr::to_str` panics on constructs the `regex` crate cannot express.
fn relax(e: fancy_regex::Expr, changed: &mut bool) -> Option<fancy_regex::Expr> {
    use fancy_regex::{Assertion as A, Expr as E};
    Some(match e {
        E::Assertion(
            A::WordBoundary
            | A::NotWordBoundary
            | A::LeftWordBoundary
            | A::RightWordBoundary
            | A::LeftWordHalfBoundary
            | A::RightWordHalfBoundary
            | A::EndTextIgnoreTrailingNewlines { .. },
        )
        | E::LookAround(..)
        | E::KeepOut
        | E::ContinueFromPreviousMatchEnd => {
            *changed = true;
            E::Empty
        }
        E::Backref { .. } | E::BackrefWithRelativeRecursionLevel { .. } => {
            *changed = true;
            E::Repeat { child: Box::new(E::Any { newline: true, crlf: false }), lo: 0, hi: usize::MAX, greedy: false }
        }
        E::AtomicGroup(inner) => {
            *changed = true;
            relax(*inner, changed)?
        }
        E::Concat(v) => E::Concat(v.into_iter().map(|x| relax(x, changed)).collect::<Option<_>>()?),
        E::Alt(v) => E::Alt(v.into_iter().map(|x| relax(x, changed)).collect::<Option<_>>()?),
        E::Group(inner) => E::Group(std::sync::Arc::new(relax(std::sync::Arc::unwrap_or_clone(inner), changed)?)),
        E::Repeat { child, lo, hi, greedy } => E::Repeat { child: Box::new(relax(*child, changed)?), lo, hi, greedy },
        // `DefineGroup` matches nothing and formats as empty.
        leaf @ (E::Empty | E::Any { .. } | E::Literal { .. } | E::Delegate { .. } | E::DefineGroup { .. }) => leaf,
        leaf @ E::Assertion(A::StartText | A::EndText | A::StartLine { .. } | A::StartLineOniguruma { .. } | A::EndLine { .. }) => leaf,
        _ => return None,
    })
}

fn superset_prefilter(full: &str) -> Option<regex::Regex> {
    let tree = fancy_regex::Expr::parse_tree(full).ok()?;
    let mut changed = false;
    let relaxed = relax(tree.expr, &mut changed)?;
    if !changed {
        return None;
    }
    let mut s = String::new();
    relaxed.to_str(&mut s, 0);
    regex::Regex::new(&s).ok()
}

fn group_names<'a>(names: impl Iterator<Item = Option<&'a str>>) -> Value {
    let m: Map<String, Value> = names.enumerate().filter_map(|(i, n)| n.map(|n| (n.to_string(), json!(i)))).collect();
    Value::Object(m)
}

impl Regexes {
    /// → `{"id", "names": {name: group index}}`; `Err` is a syntax message.
    pub fn compile(&mut self, pattern: &str, flags: &str) -> Result<Value, String> {
        let key = (pattern.to_string(), flags.to_string());
        let id = match self.ids.get(&key) {
            Some(id) => *id,
            None => {
                if self.compiled.len() >= MAX_PATTERNS {
                    return Err(format!("too many distinct regex patterns (limit {MAX_PATTERNS}); compile patterns once and reuse them"));
                }
                let full = format!("{}{pattern}", inline_flags(flags)?);
                let matcher = match regex::Regex::new(&full) {
                    Ok(r) => Matcher::Fast(r),
                    // Lookaround / back-references: only fancy-regex parses them.
                    Err(fast_err) => Matcher::Fancy(fancy_regex::Regex::new(&full).map_err(|e| format!("{e} ({fast_err})"))?),
                };
                self.compiled.push(Compiled { matcher, prefilter: superset_prefilter(&full) });
                self.ids.insert(key, self.compiled.len() - 1);
                self.compiled.len() - 1
            }
        };
        let names = match &self.compiled[id].matcher {
            Matcher::Fast(r) => group_names(r.capture_names()),
            Matcher::Fancy(r) => group_names(r.capture_names()),
        };
        Ok(json!({"id": id, "names": names}))
    }

    /// The matcher, or `None` when the prefilter proves there is no match.
    fn get(&self, id: u64, text: &str) -> Result<Option<&Matcher>, String> {
        let c = self.compiled.get(id as usize).ok_or_else(|| "invalid regex handle".to_string())?;
        Ok(match &c.prefilter {
            Some(p) if !p.is_match(text) => None,
            _ => Some(&c.matcher),
        })
    }

    pub fn test(&self, id: u64, text: &str) -> Result<bool, String> {
        match self.get(id, text)? {
            None => Ok(false),
            Some(Matcher::Fast(r)) => Ok(r.is_match(text)),
            Some(Matcher::Fancy(r)) => r.is_match(text).map_err(|e| e.to_string()),
        }
    }

    /// Matches as flat UTF-16 span arrays `[start, end, g1s, g1e, …]`
    /// (`-1` for a group that did not participate).
    pub fn exec(&self, id: u64, text: &str, all: bool) -> Result<Value, String> {
        let mut spans: Vec<Vec<Option<(usize, usize)>>> = vec![];
        match self.get(id, text)? {
            None => {}
            Some(Matcher::Fast(r)) => {
                for c in r.captures_iter(text) {
                    spans.push(c.iter().map(|g| g.map(|m| (m.start(), m.end()))).collect());
                    if !all {
                        break;
                    }
                }
            }
            Some(Matcher::Fancy(r)) => {
                for c in r.captures_iter(text) {
                    let c = c.map_err(|e| e.to_string())?;
                    spans.push(c.iter().map(|g| g.map(|m| (m.start(), m.end()))).collect());
                    if !all {
                        break;
                    }
                }
            }
        }
        Ok(Value::Array(to_utf16(text, spans)))
    }
}

/// Byte spans → UTF-16 spans. Matches are non-overlapping and ordered, so a
/// cursor walks the text once; groups are measured from their match start.
fn to_utf16(text: &str, matches: Vec<Vec<Option<(usize, usize)>>>) -> Vec<Value> {
    let u16_len = |s: &str| s.chars().map(char::len_utf16).sum::<usize>();
    let (mut byte, mut unit) = (0usize, 0usize);
    let mut out = Vec::with_capacity(matches.len());
    for groups in matches {
        let Some(Some((start, _))) = groups.first().copied() else { continue };
        unit += u16_len(&text[byte..start]);
        byte = start;
        let at = |b: usize| (unit + u16_len(&text[start..b])) as i64;
        let flat: Vec<i64> = groups
            .iter()
            .flat_map(|g| match g {
                Some((s, e)) => [at(*s), at(*e)],
                None => [-1, -1],
            })
            .collect();
        out.push(json!(flat));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(p: &str, f: &str, text: &str) -> Value {
        let mut r = Regexes::default();
        let id = r.compile(p, f).unwrap()["id"].as_u64().unwrap();
        r.exec(id, text, true).unwrap()
    }

    #[test]
    fn spans_are_utf16() {
        // "é" is 1 unit, "😀" is 2 units (4 bytes).
        assert_eq!(run(r"(b)(x)?", "", "é😀b-😀b"), json!([[3, 4, 3, 4, -1, -1], [7, 8, 7, 8, -1, -1]]));
    }

    #[test]
    fn python_dialect_and_fallback() {
        // Unicode `\b`/`\w` natively (fast engine).
        assert_eq!(run(r"\bsk-\w+\b", "", "x sk-abc éy"), json!([[2, 8]]));
        // Case-insensitive flag, named groups.
        let mut r = Regexes::default();
        let c = r.compile(r"(?P<k>key)=(\d+)", "i").unwrap();
        assert_eq!(c["names"], json!({"k": 1}));
        // Back-reference and lookbehind fall back to fancy-regex.
        assert_eq!(run(r"-(?P<l>A|B)-.*?-(?P=l)-", "s", "-A-\nx-B--A-"), json!([[0, 11, 1, 2]]));
        assert_eq!(run(r"(?<=\$)\d+", "", "a $12 34"), json!([[3, 5]]));
        // Same pattern+flags reuses the handle.
        let a = r.compile("x", "").unwrap()["id"].clone();
        assert_eq!(r.compile("x", "").unwrap()["id"], a);
        assert!(r.compile("(", "").is_err());
        assert!(r.compile("x", "g").is_err());
    }

    /// The superset prefilter only ever skips work; results are identical.
    #[test]
    fn prefilter_never_changes_results() {
        let patterns = [
            (r"\bsk-[A-Za-z0-9_-]{4,}\b", ""),
            (r#"((?:["']?)\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|password|secret)(?:["']?)\s*[:=]\s*)(["']?)([^\s"',;]+)(["']?)"#, "i"),
            (r"-----BEGIN (?P<l>(?:RSA )?PRIVATE KEY)-----.*?-----END (?P=l)-----", "s"),
            (r"(?<=\$)\d+\b", ""),
            (r"\Bfoo\B", ""),
            (r"(?>a+)b", ""),
        ];
        let texts = [
            "",
            "plain ascii with no candidates at all",
            "ésk-abcd sk-abcdé xsk-abcd sk-abcd! é sk-abcd",
            "PASSWORD = 'hunter22' api-key:\"x1\" é_secret=abc Ésecret=é1 secret=changeme",
            "-----BEGIN RSA PRIVATE KEY-----\n1\n-----END PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\n2\n-----END PRIVATE KEY-----",
            "$12 $3é 4 é$56",
            "xfoox foo éfooé aaab",
            "line\nsecond éword\n😀",
        ];
        let mut r = Regexes::default();
        for (p, f) in patterns {
            let id = r.compile(p, f).unwrap()["id"].as_u64().unwrap();
            assert!(r.compiled[id as usize].prefilter.is_some(), "expected a prefilter for {p}");
            for t in texts {
                let with = (r.exec(id, t, true).unwrap(), r.test(id, t).unwrap());
                let pf = r.compiled[id as usize].prefilter.take();
                let without = (r.exec(id, t, true).unwrap(), r.test(id, t).unwrap());
                r.compiled[id as usize].prefilter = pf;
                assert_eq!(with, without, "{p} on {t:?}");
            }
        }
        // Nothing slow to remove → no prefilter.
        for (p, f) in [(r"sk-[a-z]+", "i"), (r"^\w+$", "m")] {
            let id = r.compile(p, f).unwrap()["id"].as_u64().unwrap();
            assert!(r.compiled[id as usize].prefilter.is_none(), "{p}");
        }
    }

    /// Constructs `Expr::to_str` cannot format must skip the prefilter, not panic.
    #[test]
    fn unformattable_constructs_skip_prefilter() {
        let mut r = Regexes::default();
        for p in [r"\R\bx", r"(?<a>x)\g<a>\b", r"(?<a>x)?(?(a)y|z)\b"] {
            let Ok(c) = r.compile(p, "") else { continue };
            let id = c["id"].as_u64().unwrap() as usize;
            assert!(r.compiled[id].prefilter.is_none(), "{p}");
        }
        assert_eq!(run(r"x\Z", "", "ax\n"), json!([[1, 2]]));
    }
}
