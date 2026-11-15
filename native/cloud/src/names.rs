//! Device names: what the account calls each device (`PUT
//! /v1/devices/{id}/name`), and what a computer calls itself. Plain text a
//! device says about itself or another: shown, never used to decide trust
//! (the device key is).

/// The longest name kept, in characters (code points), as in the cloud.
pub const NAME_MAX_CHARS: usize = 40;

/// Characters that change the direction of the text after them. An app
/// shows a key right after a name, and a name must not reorder it.
fn is_direction_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// One line of plain text: no control or text-direction characters, single
/// spaces, at most [`NAME_MAX_CHARS`]. `None` when nothing is left. What it
/// returns is always a name the cloud accepts.
pub fn clean(raw: &str) -> Option<String> {
    let raw: String = raw.chars().filter(|c| !is_direction_control(*c)).collect();
    let words: Vec<&str> = raw.split(|c: char| c.is_whitespace() || c.is_control()).filter(|w| !w.is_empty()).collect();
    let name: String = words.join(" ").chars().take(NAME_MAX_CHARS).collect();
    let name = name.trim_end().to_string();
    (!name.is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_one_short_line_of_plain_text() {
        assert_eq!(clean("  Work  ").as_deref(), Some("Work"));
        assert_eq!(clean("Work\n\tMac\u{7}mini").as_deref(), Some("Work Mac mini"));
        assert_eq!(clean("\u{202e}evil\u{2066}").as_deref(), Some("evil"), "a name cannot reorder the key shown after it");
        assert_eq!(clean("\u{200f}\u{202a}"), None);
        assert_eq!(clean("مكتب").as_deref(), Some("مكتب"), "right-to-left text itself is a name");
        assert_eq!(clean(" \n "), None);
        assert_eq!(clean(&"é".repeat(100)).unwrap().chars().count(), NAME_MAX_CHARS);
        assert_eq!(clean(&format!("{} tail", "x".repeat(39))).as_deref(), Some("x".repeat(39).as_str()), "no trailing space after the cut");
    }
}
