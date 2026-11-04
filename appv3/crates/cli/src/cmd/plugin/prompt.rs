//! Asking the user before a plugin is installed or removed.

use anyhow::{Context, Result};
use std::io::{BufRead, IsTerminal, Write};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Consent {
    Yes,
    No,
    /// Not told yes, and nobody to ask.
    NeedsFlag,
}

/// `--yes` says yes; without it a terminal is asked, and anything else
/// (an agent, a script) is told to pass `--yes`.
fn consent(yes: bool, interactive: bool, question: &str, input: &mut impl BufRead, out: &mut impl Write) -> std::io::Result<Consent> {
    if yes {
        return Ok(Consent::Yes);
    }
    if !interactive {
        return Ok(Consent::NeedsFlag);
    }
    write!(out, "\n  {question} [y/N] ")?;
    out.flush()?;
    let mut answer = String::new();
    input.read_line(&mut answer)?;
    Ok(if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") { Consent::Yes } else { Consent::No })
}

pub(super) fn ask(yes: bool, question: &str) -> Result<Consent> {
    consent(yes, std::io::stdin().is_terminal(), question, &mut std::io::stdin().lock(), &mut std::io::stdout()).context("read the answer")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_needs_yes_or_a_person_to_ask() {
        let ask = |yes: bool, interactive: bool, typed: &str| {
            let (mut input, mut out) = (typed.as_bytes(), Vec::new());
            let got = consent(yes, interactive, "Install demo?", &mut input, &mut out).unwrap();
            (got, String::from_utf8(out).unwrap())
        };
        assert_eq!(ask(true, false, ""), (Consent::Yes, String::new()));
        assert_eq!(ask(true, true, "n\n"), (Consent::Yes, String::new()));
        assert_eq!(ask(false, false, "y\n"), (Consent::NeedsFlag, String::new()), "nobody to ask: the answer is not read");
        for typed in ["y\n", "Y\n", "yes\n", " YES \r\n"] {
            assert_eq!(ask(false, true, typed), (Consent::Yes, "\n  Install demo? [y/N] ".to_string()), "{typed:?}");
        }
        for typed in ["\n", "n\n", "no\n", "yep\n", "y please\n", ""] {
            assert_eq!(ask(false, true, typed).0, Consent::No, "{typed:?}");
        }
    }
}
