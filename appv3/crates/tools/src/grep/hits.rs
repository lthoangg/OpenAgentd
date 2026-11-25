//! What a search keeps and how it reads: each file's matching lines with the
//! lines around them, a count of the matches left out, and the tool's text.

use super::{chunk_cut, normalise_newlines, Matcher, BINARY_SNIFF_BYTES, SCAN_CHUNK_BYTES, SCAN_TIMEOUT_S};
use appv3_core::pystr::thousands;
use std::collections::VecDeque;
use std::io::Read;
use std::path::Path;

/// A line is shown up to this many characters.
const MAX_LINE_CHARS: usize = 200;
/// A result with context lines stops here, as `read` does. One without them
/// is bounded by `max_results` alone, as it always was.
const MAX_CONTEXT_OUTPUT_CHARS: usize = 50_000;
/// How many files the note about left-out matches names.
const NAMED_FILES: usize = 5;

struct Line {
    no: usize,
    hit: bool,
    text: String,
}

/// One file's part of a search.
pub(super) struct FileHits {
    display: String,
    /// The kept matches and the lines around them, in line order.
    lines: Vec<Line>,
    /// Matching lines among `lines`.
    kept: usize,
    /// Matching lines in the whole file.
    total: usize,
}

impl FileHits {
    /// Keep only the first `keep` matches. The lines after the last one stop
    /// before the next match, which would otherwise read as its context.
    fn truncate(&mut self, keep: usize, context: usize) {
        if keep >= self.kept {
            return;
        }
        let (mut seen, mut last, mut end) = (0, 0, 0);
        for (i, line) in self.lines.iter().enumerate() {
            if line.hit {
                if seen == keep {
                    break;
                }
                seen += 1;
                last = line.no;
            } else if seen == keep && (keep == 0 || line.no > last + context) {
                break;
            }
            end = i + 1;
        }
        self.lines.truncate(end);
        self.kept = keep;
    }
}

fn shown(line: &str) -> String {
    line.trim_end().chars().take(MAX_LINE_CHARS).collect()
}

/// Search one file like v2 (`TextIOWrapper(errors="replace")` +
/// `compiled.search(line)`, where `line` keeps its `\n`): the first `keep`
/// matches with `context` lines around each, and a count of all of them.
pub(super) fn scan_file(m: &Matcher, fpath: &Path, display: &str, keep: usize, context: usize) -> FileHits {
    match std::fs::File::open(fpath) {
        Ok(f) => scan_reader(m, f, display, keep, context, SCAN_CHUNK_BYTES),
        Err(_) => FileHits { display: display.to_string(), lines: vec![], kept: 0, total: 0 },
    }
}

/// [`scan_file`] over any reader, `chunk` bytes at a time. Chunks hold whole
/// lines, so the per-chunk prefilter, the line numbers and the context match
/// a scan of the whole file. The file is read to its end, to count.
pub(super) fn scan_reader(m: &Matcher, mut r: impl Read, display: &str, keep: usize, context: usize, chunk: usize) -> FileHits {
    let mut out = FileHits { display: display.to_string(), lines: vec![], kept: 0, total: 0 };
    let mut buf: Vec<u8> = Vec::new();
    let mut line_no = 0usize;
    let mut first = true;
    let mut with_nl = String::new();
    // The lines since the last one shown: the next match's context.
    let mut before: VecDeque<(usize, String)> = VecDeque::new();
    // Lines still owed after the last kept match.
    let mut after = 0usize;
    loop {
        let want = if first { chunk.max(BINARY_SNIFF_BYTES) } else { chunk };
        let n = match r.by_ref().take(want as u64).read_to_end(&mut buf) {
            Ok(n) => n,
            Err(_) => return out,
        };
        if first {
            if buf[..buf.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
                return out;
            }
            first = false;
        }
        let eof = n == 0;
        let Some(cut) = chunk_cut(&buf, eof) else { continue };
        let region = normalise_newlines(&buf[..cut]);
        let may_match = m.may_match_file(&region);
        let wants_before = context > 0 && out.kept < keep;
        if !may_match && after == 0 {
            let lines = memchr::memchr_iter(b'\n', &region).count() + usize::from(eof && !region.is_empty() && !region.ends_with(b"\n"));
            if wants_before {
                // A match in a later chunk shows this one's last lines.
                let body = region.strip_suffix(b"\n").unwrap_or(&region);
                let tail: Vec<&[u8]> = body.rsplit(|b| *b == b'\n').take(context.min(lines)).collect();
                for (back, bytes) in tail.iter().enumerate().rev() {
                    if before.len() == context {
                        before.pop_front();
                    }
                    before.push_back((line_no + lines - back, shown(&String::from_utf8_lossy(bytes))));
                }
            }
            line_no += lines;
        } else {
            let text = String::from_utf8_lossy(&region);
            let ends_with_nl = text.ends_with('\n');
            let mut lines: Vec<&str> = text.split('\n').collect();
            if ends_with_nl || text.is_empty() {
                lines.pop();
            }
            let last = lines.len().saturating_sub(1);
            for (i, line) in lines.iter().enumerate() {
                line_no += 1;
                let has_nl = i < last || ends_with_nl;
                // `$` in Python also matches before the final `\n`; patterns
                // that consume the newline (`\s$`, `\n`) need the line with it.
                let hit = may_match
                    && (m.is_match(line)
                        || (has_nl && m.needs_trailing_newline() && {
                            with_nl.clear();
                            with_nl.push_str(line);
                            with_nl.push('\n');
                            m.is_match(&with_nl)
                        }));
                if hit {
                    out.total += 1;
                    if out.kept < keep {
                        out.lines.extend(before.drain(..).map(|(no, text)| Line { no, hit: false, text }));
                        out.lines.push(Line { no: line_no, hit: true, text: shown(line) });
                        out.kept += 1;
                        after = context;
                    } else {
                        after = 0;
                    }
                } else if after > 0 {
                    out.lines.push(Line { no: line_no, hit: false, text: shown(line) });
                    after -= 1;
                } else if wants_before {
                    if before.len() == context {
                        before.pop_front();
                    }
                    before.push_back((line_no, shown(line)));
                }
            }
        }
        drop(region);
        buf.drain(..cut);
        if eof {
            return out;
        }
    }
}

/// What a search found, in walk order: every file with a match, the ones
/// past the limit as a count only.
#[derive(Default)]
pub(super) struct Found {
    files: Vec<FileHits>,
    /// Matching lines kept to show, at most `max_results`.
    pub(super) kept: usize,
}

impl Found {
    pub(super) fn add(&mut self, mut file: FileHits, max: usize, context: usize) {
        if file.total == 0 {
            return;
        }
        file.truncate(max.saturating_sub(self.kept), context);
        self.kept += file.kept;
        self.files.push(file);
    }

    pub(super) fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// The tool's text: match lines as `file:line: text`, context lines as
/// `file-line- text` with `--` between groups, then a note when matches were
/// left out or the search stopped early (`timed_out`), so a result that
/// fills the limit never reads as complete.
pub(super) fn render(found: &Found, context: usize, max: usize, timed_out: bool) -> String {
    let mut out = String::new();
    let (mut chars, mut shown_matches, mut size_cut) = (0usize, 0usize, false);
    let mut left: Vec<(&str, usize)> = vec![];
    for file in &found.files {
        let mut rendered = 0;
        let mut prev = None;
        for line in &file.lines {
            if size_cut {
                break;
            }
            let new_group = context > 0 && !out.is_empty() && prev != Some(line.no - 1);
            let text = if line.hit { format!("{}:{}: {}", file.display, line.no, line.text) } else { format!("{}-{}- {}", file.display, line.no, line.text) };
            let cost = text.chars().count() + usize::from(!out.is_empty()) + if new_group { 3 } else { 0 };
            if context > 0 && !out.is_empty() && chars + cost > MAX_CONTEXT_OUTPUT_CHARS {
                size_cut = true;
                break;
            }
            if new_group {
                out.push_str("\n--");
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&text);
            chars += cost;
            prev = Some(line.no);
            rendered += usize::from(line.hit);
        }
        shown_matches += rendered;
        if file.total > rendered {
            left.push((&file.display, file.total - rendered));
        }
    }
    let rest: usize = left.iter().map(|(_, n)| n).sum();
    let advice = if size_cut { "Lower context, or narrow the pattern, directory or include." } else { "Narrow the pattern, directory or include, or raise max_results." };
    let note = if rest > 0 {
        // Stable, so files with as many left stay in walk order.
        left.sort_by_key(|a| std::cmp::Reverse(a.1));
        let named = left.iter().take(NAMED_FILES).map(|(f, n)| format!("{f} ({})", thousands(*n))).collect::<Vec<_>>().join(", ");
        let others = thousands(rest);
        let place = match left.len() {
            1 => format!("The other {others} {} in {}.", if rest == 1 { "is" } else { "are" }, left[0].0),
            n if n <= NAMED_FILES => format!("The other {others} are in: {named}."),
            n => format!("The other {others} are in {} files, most in: {named}.", thousands(n)),
        };
        let total = thousands(shown_matches + rest);
        let (total, counting) = if timed_out { (format!("at least {total}"), " Counting stopped early, so there may be more.") } else { (total, "") };
        let why = if size_cut { format!(": output stops at {} characters", thousands(MAX_CONTEXT_OUTPUT_CHARS)) } else { String::new() };
        format!("[{} of {total} matching lines shown{why}. {place}{counting} {advice}]", thousands(shown_matches))
    } else if timed_out && found.kept >= max {
        format!("[{} matching lines shown. Counting the rest stopped early, so there may be more. {advice}]", thousands(shown_matches))
    } else if timed_out {
        format!("[grep stopped after {SCAN_TIMEOUT_S}s: these results are partial. Narrow the directory or include pattern for a complete search.]")
    } else {
        return out;
    };
    out + "\n\n" + &note
}

#[cfg(test)]
mod tests {
    use super::{render, scan_reader, Found};
    use crate::grep::compile_pattern;
    use crate::grep::tests::grep;
    use crate::Tool;
    use serde_json::json;
    use std::path::Path;

    fn write(root: &Path, file: &str, text: &str) {
        let p = root.join(file);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// `n` lines, `hit` on the lines in `at` and `l<number>` elsewhere.
    fn numbered(n: usize, at: &[usize]) -> String {
        (1..=n).map(|i| if at.contains(&i) { "hit\n".to_string() } else { format!("l{i}\n") }).collect()
    }

    /// The result's lines with every path cut to its file name.
    fn names(out: &str) -> Vec<String> {
        out.lines().map(|l| l.rsplit(['/', '\\']).next().unwrap_or(l).to_string()).collect()
    }

    /// A chunk with no match is skipped whole, yet a match in the next chunk
    /// shows its last lines and a match in the one before shows its first.
    #[test]
    fn context_crosses_chunks_that_hold_no_match() {
        let m = compile_pattern("hit").unwrap();
        let text: String = (1..=3000).map(|i| if [1, 700, 701, 1999, 3000].contains(&i) { "hit\n".to_string() } else { format!("line {i}\n") }).collect();
        let show = |chunk: usize| {
            let mut found = Found::default();
            found.add(scan_reader(&m, text.as_bytes(), "f", 100, 4, chunk), 100, 4);
            render(&found, 4, 100, false)
        };
        let whole = show(usize::MAX);
        assert!(whole.starts_with("f:1: hit\nf-2- line 2\n") && whole.contains("\n--\nf-696- line 696\n") && whole.contains("\nf-705- line 705\n--\n"), "{whole}");
        assert_eq!(whole.lines().filter(|l| l.ends_with(": hit")).count(), 5);
        for chunk in [64, 300, 5000, 9000] {
            assert_eq!(show(chunk), whole, "chunk {chunk}");
        }
    }

    #[tokio::test]
    async fn a_cut_result_says_how_many_more_and_where() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", "hit\nhit\nhit\n");
        write(d.path(), "b.txt", "hit\nhit\nhit\nhit\nhit\n");
        write(d.path(), "c.txt", "hit\nhit\n");
        let out = grep(d.path(), json!({"pattern": "hit", "max_results": 4})).await;
        let (shown, note) = out.split_once("\n\n").unwrap_or((&out, ""));
        assert_eq!(names(shown), ["a.txt:1: hit", "a.txt:2: hit", "a.txt:3: hit", "b.txt:1: hit"], "{out}");
        assert_eq!(note, "[4 of 10 matching lines shown. The other 6 are in: b.txt (4), c.txt (2). Narrow the pattern, directory or include, or raise max_results.]");
    }

    #[tokio::test]
    async fn a_result_of_exactly_the_limit_has_no_note() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", "hit\nhit\n");
        write(d.path(), "b.txt", "hit\nhit\nmiss\n");
        let out = grep(d.path(), json!({"pattern": "hit", "max_results": 4})).await;
        assert_eq!(names(&out), ["a.txt:1: hit", "a.txt:2: hit", "b.txt:1: hit", "b.txt:2: hit"]);
    }

    #[tokio::test]
    async fn a_cut_result_names_the_files_with_the_most_left() {
        let d = tempfile::tempdir().unwrap();
        for (file, hits) in [("a.txt", 2), ("b.txt", 1), ("c.txt", 9), ("d.txt", 3), ("e.txt", 1), ("f.txt", 4), ("g.txt", 1), ("h.txt", 1_200)] {
            write(d.path(), file, &"hit\n".repeat(hits));
        }
        let out = grep(d.path(), json!({"pattern": "hit", "max_results": 1})).await;
        let note = out.split_once("\n\n").expect(&out).1;
        assert_eq!(
            note,
            "[1 of 1,221 matching lines shown. The other 1,220 are in 8 files, most in: h.txt (1,200), c.txt (9), f.txt (4), d.txt (3), a.txt (1). Narrow the pattern, directory or include, or raise max_results.]"
        );
    }

    #[tokio::test]
    async fn a_cut_search_of_one_file_names_it() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", &"hit\n".repeat(5));
        let out = grep(d.path(), json!({"pattern": "hit", "directory": "a.txt", "max_results": 2})).await;
        assert_eq!(out, "a.txt:1: hit\na.txt:2: hit\n\n[2 of 5 matching lines shown. The other 3 are in a.txt. Narrow the pattern, directory or include, or raise max_results.]");
        let one_left = grep(d.path(), json!({"pattern": "hit", "directory": "a.txt", "max_results": 4})).await;
        assert!(one_left.ends_with("[4 of 5 matching lines shown. The other 1 is in a.txt. Narrow the pattern, directory or include, or raise max_results.]"), "{one_left}");
    }

    #[tokio::test]
    async fn context_shows_the_lines_around_a_match() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "f.txt", &numbered(10, &[5]));
        let out = grep(d.path(), json!({"pattern": "hit", "context": 2})).await;
        assert_eq!(out, "f.txt-3- l3\nf.txt-4- l4\nf.txt:5: hit\nf.txt-6- l6\nf.txt-7- l7");
    }

    #[tokio::test]
    async fn context_stops_at_the_ends_of_the_file() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "f.txt", &numbered(9, &[1, 9]));
        let out = grep(d.path(), json!({"pattern": "hit", "context": 3})).await;
        assert_eq!(out, "f.txt:1: hit\nf.txt-2- l2\nf.txt-3- l3\nf.txt-4- l4\n--\nf.txt-6- l6\nf.txt-7- l7\nf.txt-8- l8\nf.txt:9: hit");
    }

    #[tokio::test]
    async fn nearby_matches_share_one_group_and_distant_ones_are_separated() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", &numbered(20, &[4, 7, 18]));
        write(d.path(), "b.txt", "hit\n");
        let out = grep(d.path(), json!({"pattern": "hit", "context": 2})).await;
        assert_eq!(
            names(&out),
            [
                "a.txt-2- l2",
                "a.txt-3- l3",
                "a.txt:4: hit",
                "a.txt-5- l5",
                "a.txt-6- l6",
                "a.txt:7: hit",
                "a.txt-8- l8",
                "a.txt-9- l9",
                "--",
                "a.txt-16- l16",
                "a.txt-17- l17",
                "a.txt:18: hit",
                "a.txt-19- l19",
                "a.txt-20- l20",
                "--",
                "b.txt:1: hit",
            ],
            "{out}"
        );
    }

    #[tokio::test]
    async fn no_context_reads_as_it_always_did() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", &numbered(12, &[2, 3, 11]));
        write(d.path(), "b.txt", "hit\n");
        let plain = grep(d.path(), json!({"pattern": "hit"})).await;
        assert_eq!(names(&plain), ["a.txt:2: hit", "a.txt:3: hit", "a.txt:11: hit", "b.txt:1: hit"]);
        assert_eq!(grep(d.path(), json!({"pattern": "hit", "context": 0})).await, plain);
    }

    #[tokio::test]
    async fn the_limit_counts_matches_and_a_later_match_is_not_shown_as_context() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "f.txt", &numbered(10, &[5, 6]));
        let out = grep(d.path(), json!({"pattern": "hit", "context": 2, "max_results": 1})).await;
        assert_eq!(
            out,
            "f.txt-3- l3\nf.txt-4- l4\nf.txt:5: hit\n\n[1 of 2 matching lines shown. The other 1 is in f.txt. Narrow the pattern, directory or include, or raise max_results.]"
        );
    }

    #[tokio::test]
    async fn context_output_stops_at_the_size_limit_and_says_so() {
        let d = tempfile::tempdir().unwrap();
        let filler = "x".repeat(150);
        let text: String = (1..=300 * 120).map(|i| if i % 120 == 60 { "hit\n".to_string() } else { format!("{filler}\n") }).collect();
        write(d.path(), "big.txt", &text);
        let out = grep(d.path(), json!({"pattern": "^hit$", "context": 50, "max_results": 300})).await;
        let (shown, note) = out.split_once("\n\n").expect("a note");
        assert!(shown.chars().count() <= 50_000, "{}", shown.chars().count());
        let matches = shown.lines().filter(|l| l.ends_with(": hit")).count();
        assert!(matches > 0 && matches < 300, "{matches}");
        assert_eq!(
            note,
            format!(
                "[{matches} of 300 matching lines shown: output stops at 50,000 characters. The other {} are in big.txt. Lower context, or narrow the pattern, directory or include.]",
                300 - matches
            )
        );
    }

    #[tokio::test]
    async fn context_must_be_between_0_and_50() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "f.txt", "hit\n");
        for bad in [json!(51), json!(-1), json!("many")] {
            let err = crate::grep::GrepTool.run(&crate::grep::tests::ctx(d.path()), json!({"pattern": "hit", "context": bad})).await.unwrap_err();
            assert!(format!("{err}").contains("context: "), "{err}");
        }
    }
}
