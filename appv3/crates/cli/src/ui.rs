//! Terminal output, one style for every command: a header line, sections,
//! aligned fields and tables, ✓/⚠/✗ marks, dim hints, wrapped warnings,
//! errors with an optional `hint:` line, the start banner, and the
//! hidden-input prompt for secrets.
//!
//! Piped output (or `NO_COLOR`, `TERM=dumb`) gets the same text without
//! colour, so it stays readable in logs and greppable in scripts.

use std::io::IsTerminal;
use std::path::Path;
use std::sync::OnceLock;

/// Colour is off with `NO_COLOR` or `TERM=dumb`, and when not on a terminal.
fn color_allowed() -> bool {
    std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty()) && std::env::var("TERM").map_or(true, |t| t != "dumb")
}

/// Whether stdout gets ANSI colours.
pub fn color() -> bool {
    static C: OnceLock<bool> = OnceLock::new();
    *C.get_or_init(|| color_allowed() && std::io::stdout().is_terminal())
}

fn paint(code: &str, t: &str) -> String {
    if color() {
        format!("\x1b[{code}m{t}\x1b[0m")
    } else {
        t.to_string()
    }
}

pub fn dim(t: &str) -> String {
    paint("2", t)
}
pub fn bold(t: &str) -> String {
    paint("1", t)
}
pub fn cyan(t: &str) -> String {
    paint("36", t)
}
pub fn green(t: &str) -> String {
    paint("32", t)
}
pub fn red(t: &str) -> String {
    paint("31", t)
}
pub fn yellow(t: &str) -> String {
    paint("33", t)
}

/// How wide `s` shows: ANSI colour codes take no room, every char one cell.
pub fn width(s: &str) -> usize {
    let mut n = 0;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for e in chars.by_ref() {
                if e.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            n += 1;
        }
    }
    n
}

/// `s` padded with spaces to `w` visible cells.
pub fn pad(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(width(s))))
}

/// Terminal columns: `COLUMNS`, the tty's size, else 100 (60–160).
pub fn term_width() -> usize {
    let from_env = std::env::var("COLUMNS").ok().and_then(|c| c.trim().parse::<usize>().ok());
    #[cfg(unix)]
    let from_tty = || {
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        (unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0).then_some(ws.ws_col as usize)
    };
    #[cfg(not(unix))]
    let from_tty = || None::<usize>;
    from_env.or_else(from_tty).unwrap_or(100).clamp(60, 160)
}

/// `text` broken at spaces into lines of at most `max` cells.
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let mut lines = vec![];
    let mut line = String::new();
    for word in text.split(' ').filter(|w| !w.is_empty()) {
        if !line.is_empty() && width(&line) + 1 + width(word) > max {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

/// The opening line of a report: blank, `  Title  note`, blank.
pub fn header(title: &str, note: &str) {
    println!();
    if note.is_empty() {
        println!("  {}", bold(title));
    } else {
        println!("  {}  {}", bold(title), dim(note));
    }
    println!();
}

/// A sub-heading inside a report, after a blank line.
pub fn section(title: &str) {
    println!();
    println!("  {}", bold(title));
}

/// A dim line saying what to do next.
pub fn hint(text: &str) {
    println!("  {}", dim(text));
}

/// `  label  command`: a next step with the command in bold.
pub fn next(label: &str, command: &str) {
    println!("  {}  {}", dim(label), bold(command));
}

pub fn ok_mark() -> String {
    green("✓")
}
pub fn warn_mark() -> String {
    yellow("⚠")
}
pub fn fail_mark() -> String {
    red("✗")
}
/// Neither good nor bad (off, skipped, informational).
pub fn idle_mark() -> String {
    dim("·")
}

/// A mark line (`  ✓  msg`) whose message wraps under itself.
pub fn mark_line(mark: &str, msg: &str) {
    let max = term_width().saturating_sub(7).max(30);
    for (i, line) in wrap(msg, max).iter().enumerate() {
        if i == 0 {
            println!("  {mark}  {line}");
        } else {
            println!("     {line}");
        }
    }
}

/// Rows of cells printed in aligned columns (two spaces apart, indented two).
/// The last column is not padded, so lines carry no trailing spaces.
#[derive(Default)]
pub struct Table {
    rows: Vec<Vec<String>>,
}

impl Table {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn row<I, S>(&mut self, cells: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.rows.push(cells.into_iter().map(Into::into).collect());
        self
    }
    /// The table as lines, without the trailing newline.
    pub fn render(&self) -> Vec<String> {
        let cols = self.rows.iter().map(Vec::len).max().unwrap_or(0);
        let widths: Vec<usize> = (0..cols).map(|c| self.rows.iter().filter_map(|r| r.get(c)).map(|s| width(s)).max().unwrap_or(0)).collect();
        self.rows
            .iter()
            .map(|r| {
                let last = r.iter().rposition(|c| !c.is_empty()).map_or(0, |i| i + 1);
                let cells: Vec<String> = r[..last].iter().enumerate().map(|(i, c)| if i + 1 == last { c.clone() } else { pad(c, widths[i]) }).collect();
                format!("  {}", cells.join("  "))
            })
            .collect()
    }
    pub fn print(&self) {
        for line in self.render() {
            println!("{line}");
        }
    }
}

/// An error that carries what to try next; `main` prints it as `hint:`.
#[derive(Debug)]
pub struct Hinted {
    pub message: String,
    pub hint: String,
}

impl std::fmt::Display for Hinted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Hinted {}

pub fn hinted(message: impl Into<String>, hint: impl Into<String>) -> anyhow::Error {
    Hinted { message: message.into(), hint: hint.into() }.into()
}

/// `  Label:  value` with labels padded to one column.
pub fn field(label: &str, value: &str) {
    println!("  {}{value}", dim(&format!("{label:<9}")));
}

pub fn color_allowed_on_stderr() -> bool {
    color_allowed() && std::io::stderr().is_terminal()
}

/// `error: msg` on stderr (red on a terminal).
pub fn print_error(msg: &str) {
    let prefix = if color_allowed_on_stderr() { "\x1b[1;31merror:\x1b[0m" } else { "error:" };
    eprintln!("{prefix} {msg}");
}

/// `hint: msg` on stderr, under an error.
pub fn print_hint(msg: &str) {
    let prefix = if color_allowed_on_stderr() { "\x1b[1;36mhint:\x1b[0m" } else { "hint:" };
    eprintln!("{prefix}  {msg}");
}

/// Print an error from a command, with its `hint:` when it has one.
pub fn report_error(e: &anyhow::Error) {
    print_error(&format!("{e:#}"));
    if let Some(h) = e.chain().find_map(|c| c.downcast_ref::<Hinted>()) {
        print_hint(&h.hint);
    }
}

/// A path with the home directory shown as `~`.
pub fn tilde(p: &Path) -> String {
    let s = p.display().to_string();
    match appv3_core::home::home_dir_opt().map(|h| h.display().to_string()).filter(|h| !h.is_empty() && s.starts_with(h.as_str())) {
        Some(h) => format!("~{}", &s[h.len()..]),
        None => s,
    }
}

/// `text` with every mention of the home directory shown as `~`.
pub fn tilde_text(text: &str) -> String {
    match appv3_core::home::home_dir_opt().map(|h| h.display().to_string()).filter(|h| h.len() > 1) {
        Some(h) => text.replace(&format!("{h}/"), "~/").replace(&format!("{h}\\"), "~\\"),
        None => text.to_string(),
    }
}

/// ✓ / ⚠ / ✗ lines with a summary (`doctor`, `server status`).
#[derive(Default)]
pub struct Checks {
    pub passed: usize,
    pub warnings: usize,
    pub failures: usize,
}

impl Checks {
    pub fn ok(&mut self, msg: &str) {
        self.passed += 1;
        mark_line(&ok_mark(), msg);
    }
    pub fn warn(&mut self, msg: &str) {
        self.warnings += 1;
        mark_line(&warn_mark(), msg);
    }
    pub fn fail(&mut self, msg: &str) {
        self.failures += 1;
        mark_line(&fail_mark(), msg);
    }
    /// `3 passed, 1 warning, 2 failed`.
    pub fn summary(&self) -> String {
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        let mut parts = vec![green(&format!("{} passed", self.passed))];
        if self.warnings > 0 {
            parts.push(yellow(&format!("{} warning{}", self.warnings, plural(self.warnings))));
        }
        if self.failures > 0 {
            parts.push(red(&format!("{} failed", self.failures)));
        }
        parts.join(", ")
    }
}

const WORDMARK: &str = concat!(
    " _____             _____             _     _ \n",
    "|     |___ ___ ___|  _  |___ ___ ___| |_ _| |\n",
    "|  |  | . | -_|   |     | . | -_|   |  _| . |\n",
    "|_____|  _|___|_|_|__|__|_  |___|_|_|_| |___|\n",
    "      |_|               |___|"
);

/// The `server start` banner. The server is API-only, so the URL is what the
/// desktop or mobile app connects to.
pub fn print_banner(host: &str, port: u16) {
    if color() {
        println!();
        for line in WORDMARK.lines() {
            println!("  {}", cyan(line));
        }
        println!();
        println!("  {}", dim(&format!("v{}", appv3_core::VERSION)));
    } else {
        header("OpenAgentd server", &format!("v{}", appv3_core::VERSION));
    }
    field("Server:", &bold(&format!("http://{host}:{port}")));
}

/// Read a line from the terminal without echo (stdin if there is none).
pub fn read_secret(prompt: &str) -> anyhow::Result<String> {
    use std::io::{BufRead, Write};
    let eof = || anyhow::anyhow!("no input");
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if let Ok(tty) = std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty") {
            let fd = tty.as_raw_fd();
            let mut old: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(fd, &mut old) } == 0 {
                let mut quiet = old;
                quiet.c_lflag &= !libc::ECHO;
                let mut w = &tty;
                unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &quiet) };
                let _ = w.write_all(prompt.as_bytes());
                let _ = w.flush();
                let mut line = String::new();
                let n = std::io::BufReader::new(&tty).read_line(&mut line);
                unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &old) };
                let _ = w.write_all(b"\n");
                if matches!(n, Ok(0) | Err(_)) {
                    return Err(eof());
                }
                return Ok(line.trim_end_matches(['\r', '\n']).to_string());
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Console::{GetConsoleMode, SetConsoleMode, ENABLE_ECHO_INPUT};
        if let Ok(con) = std::fs::OpenOptions::new().read(true).write(true).open("CONIN$") {
            let h = con.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
            let mut old = 0u32;
            if unsafe { GetConsoleMode(h, &mut old) } != 0 {
                unsafe { SetConsoleMode(h, old & !ENABLE_ECHO_INPUT) };
                eprint!("{prompt}");
                let _ = std::io::stderr().flush();
                let mut line = String::new();
                let n = std::io::BufReader::new(&con).read_line(&mut line);
                unsafe { SetConsoleMode(h, old) };
                eprintln!();
                if matches!(n, Ok(0) | Err(_)) {
                    return Err(eof());
                }
                return Ok(line.trim_end_matches(['\r', '\n']).to_string());
            }
        }
    }
    eprintln!("warning: no terminal; the input may be echoed");
    eprint!("{prompt}");
    let mut line = String::new();
    if matches!(std::io::stdin().lock().read_line(&mut line), Ok(0) | Err(_)) {
        return Err(eof());
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}
