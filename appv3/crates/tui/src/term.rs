//! Inline terminal: finished lines are printed into the normal scrollback,
//! and a small live area under them is redrawn with ratatui.
//!
//! The live area is a fixed ratatui viewport whose top row and height this
//! module tracks, so it can grow, shrink, and move down as lines are added.
//! Every printed line must fit the width (the renderers wrap to it), or the
//! row arithmetic breaks.

use crossterm::cursor::MoveTo;
use crossterm::event::{DisableBracketedPaste, EnableBracketedPaste, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags};
use crossterm::style::{Print, PrintStyledContent, StyledContent};
use crossterm::terminal::{self, BeginSynchronizedUpdate, Clear, ClearType, EndSynchronizedUpdate};
use crossterm::{execute, queue};
use ratatui::backend::{CrosstermBackend, IntoCrossterm};
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::{Frame, Terminal, TerminalOptions, Viewport};
use std::io::{self, Stdout, Write};

pub struct Term {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    top: u16,
    height: u16,
    cols: u16,
    rows: u16,
    /// Widths of the live-area lines above the caret, to find the area
    /// again after a resize reflows them.
    above_caret: Vec<usize>,
}

fn fixed(top: u16, cols: u16, height: u16) -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    Terminal::with_options(CrosstermBackend::new(io::stdout()), TerminalOptions { viewport: Viewport::Fixed(Rect::new(0, top, cols, height)) })
}

/// Put the terminal back the way the shell expects it.
pub fn restore() {
    let mut out = io::stdout();
    let _ = execute!(out, PopKeyboardEnhancementFlags, DisableBracketedPaste, crossterm::cursor::Show);
    let _ = terminal::disable_raw_mode();
}

impl Term {
    pub fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let mut out = io::stdout();
        execute!(out, EnableBracketedPaste)?;
        // Kitty keyboard protocol, so Shift+Enter differs from Enter where the
        // terminal supports it (the same flags Codex uses); others ignore it.
        execute!(out, PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS))?;
        let (cols, rows) = terminal::size()?;
        let (_, y) = crossterm::cursor::position()?;
        let top = y.min(rows.saturating_sub(1));
        Ok(Self { terminal: fixed(top, cols, 1)?, top, height: 1, cols, rows, above_caret: vec![] })
    }

    pub fn width(&self) -> u16 {
        self.cols
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Scroll so a viewport of `height` rows fits under `top`, then rebuild
    /// the ratatui terminal there and clear its rows.
    fn place(&mut self, height: u16) -> io::Result<()> {
        let height = height.clamp(1, self.rows.max(1));
        let mut out = io::stdout();
        if self.top + height > self.rows {
            let n = self.top + height - self.rows;
            queue!(out, MoveTo(0, self.rows - 1))?;
            for _ in 0..n {
                queue!(out, Print("\n"))?;
            }
            self.top -= n;
        }
        queue!(out, MoveTo(0, self.top), Clear(ClearType::FromCursorDown))?;
        self.height = height;
        self.terminal = fixed(self.top, self.cols, height)?;
        Ok(())
    }

    /// Print finished lines above the live area.
    pub fn insert(&mut self, lines: &[Line<'static>]) -> io::Result<()> {
        if lines.is_empty() {
            return Ok(());
        }
        let mut out = io::stdout();
        queue!(out, BeginSynchronizedUpdate, MoveTo(0, self.top), Clear(ClearType::FromCursorDown))?;
        for line in lines {
            for span in &line.spans {
                let style = span.style.into_crossterm();
                queue!(out, PrintStyledContent(StyledContent::new(style, span.content.as_ref())))?;
            }
            queue!(out, Print("\r\n"))?;
        }
        let n = lines.len().min(u16::MAX as usize) as u16;
        self.top = self.top.saturating_add(n).min(self.rows.saturating_sub(1));
        self.place(self.height)?;
        queue!(out, EndSynchronizedUpdate)?;
        out.flush()
    }

    /// Draw the live area with `height` rows. `above_caret` holds the widths
    /// of its lines above the cursor's row.
    pub fn draw(&mut self, height: u16, above_caret: Vec<usize>, f: impl FnOnce(&mut Frame)) -> io::Result<()> {
        self.above_caret = above_caret;
        let mut out = io::stdout();
        queue!(out, BeginSynchronizedUpdate)?;
        if height.clamp(1, self.rows.max(1)) != self.height {
            self.place(height)?;
        }
        self.terminal.draw(f)?;
        execute!(out, EndSynchronizedUpdate)
    }

    /// The window changed size. Terminals reflow and move old lines on
    /// their own, so find the live area again from the cursor, which sits on
    /// the caret row, then redraw it there.
    pub fn resized(&mut self, cols: u16, rows: u16, cursor_row: Option<u16>) -> io::Result<()> {
        self.cols = cols;
        self.rows = rows;
        if let Some(y) = cursor_row {
            // Lines wider than the new width now wrap onto more rows.
            let cols = usize::from(cols.max(1));
            let off: usize = self.above_caret.iter().map(|w| w.div_ceil(cols).max(1)).sum();
            self.top = y.saturating_sub(off.min(usize::from(u16::MAX)) as u16);
        }
        // `place` scrolls when the area no longer fits below `top`.
        self.top = self.top.min(rows.saturating_sub(1));
        let h = self.height;
        self.place(h)?;
        io::stdout().flush()
    }

    /// Clear the live area and leave the cursor where it began.
    pub fn leave(&mut self) -> io::Result<()> {
        execute!(io::stdout(), MoveTo(0, self.top), Clear(ClearType::FromCursorDown))?;
        restore();
        Ok(())
    }
}
