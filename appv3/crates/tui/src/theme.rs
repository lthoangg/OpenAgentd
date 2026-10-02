//! Dark and light palettes. `auto` asks the terminal for its background
//! color and falls back to dark when it does not answer.

use ratatui::style::{Color, Modifier, Style};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeChoice {
    Dark,
    Light,
    Auto,
}

impl std::str::FromStr for ThemeChoice {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "dark" => Ok(Self::Dark),
            "light" => Ok(Self::Light),
            "auto" | "" => Ok(Self::Auto),
            other => Err(format!("unknown theme {other:?}; use dark, light, or auto")),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub text: Color,
    pub dim: Color,
    pub accent: Color,
    pub user: Color,
    pub tool: Color,
    pub warn: Color,
    pub error: Color,
    pub code: Color,
    pub heading: Color,
    pub link: Color,
    pub border: Color,
}

impl Theme {
    pub fn resolve(choice: ThemeChoice) -> Self {
        match choice {
            ThemeChoice::Dark => Self::dark(),
            ThemeChoice::Light => Self::light(),
            ThemeChoice::Auto => match terminal_colorsaurus::theme_mode(terminal_colorsaurus::QueryOptions::default()) {
                Ok(terminal_colorsaurus::ThemeMode::Light) => Self::light(),
                _ => Self::dark(),
            },
        }
    }

    pub fn dark() -> Self {
        Self {
            text: Color::Reset,
            dim: Color::Rgb(140, 140, 150),
            accent: Color::Rgb(215, 119, 87),
            user: Color::Rgb(130, 170, 255),
            tool: Color::Rgb(120, 200, 160),
            warn: Color::Rgb(230, 190, 90),
            error: Color::Rgb(240, 100, 100),
            code: Color::Rgb(220, 170, 240),
            heading: Color::Rgb(240, 200, 120),
            link: Color::Rgb(110, 180, 255),
            border: Color::Rgb(90, 90, 100),
        }
    }

    pub fn light() -> Self {
        Self {
            text: Color::Reset,
            dim: Color::Rgb(110, 110, 120),
            accent: Color::Rgb(185, 85, 50),
            user: Color::Rgb(40, 90, 200),
            tool: Color::Rgb(20, 130, 90),
            warn: Color::Rgb(160, 110, 0),
            error: Color::Rgb(200, 40, 40),
            code: Color::Rgb(140, 50, 160),
            heading: Color::Rgb(150, 90, 0),
            link: Color::Rgb(20, 100, 200),
            border: Color::Rgb(180, 180, 190),
        }
    }

    pub fn fg(&self, c: Color) -> Style {
        Style::default().fg(c)
    }

    pub fn dim(&self) -> Style {
        Style::default().fg(self.dim)
    }

    pub fn dim_italic(&self) -> Style {
        self.dim().add_modifier(Modifier::ITALIC)
    }
}
