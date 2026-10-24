//! Text for `desktop_notification` events. A native notification is read at
//! a glance, so the title is a short status plus the workspace name and the
//! body is a single clamped line.

use std::path::Path;

/// Longest body, in characters, before it is cut with an ellipsis.
const MAX_BODY_CHARS: usize = 100;

/// `"<status> · <workspace dir name>"`, or just the status without a workspace.
pub fn title(status: &str, workspace: Option<&str>) -> String {
    let name = workspace.and_then(|w| Path::new(w).file_name()).map(|n| n.to_string_lossy()).filter(|n| !n.trim().is_empty());
    match name {
        Some(n) => format!("{status} · {n}"),
        None => status.to_string(),
    }
}

/// `text` on one line: whitespace runs collapse to a space, and anything past
/// `MAX_BODY_CHARS` is replaced by `…`. `None` when nothing is left.
pub fn body(text: &str) -> Option<String> {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= MAX_BODY_CHARS {
        return Some(line);
    }
    let head = crate::util::head_chars(&line, MAX_BODY_CHARS - 1).trim_end();
    Some(format!("{head}…"))
}

/// What became of a `/goal` whose last turn just ended (`achieved`,
/// `blocked` or `paused`), from the goal's `status` and `pause_reason`;
/// `None` while it still runs (or was cleared), so the turn's own status is
/// used. It goes on the notification as `goal`, for clients that mark it
/// (the macOS notch).
pub fn goal_outcome(status: &str, pause_reason: Option<&str>) -> Option<&'static str> {
    match (status, pause_reason) {
        ("achieved", _) => Some("achieved"),
        ("paused", Some("blocked")) => Some("blocked"),
        ("paused", _) => Some("paused"),
        _ => None,
    }
}

/// The notification status for a goal `outcome` (see [`goal_outcome`]).
pub fn goal_status(outcome: &str) -> &'static str {
    match outcome {
        "achieved" => "Goal achieved",
        "blocked" => "Goal blocked",
        _ => "Goal paused",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_goal_turn_names_what_became_of_the_goal() {
        let status = |s, r| goal_outcome(s, r).map(|o| (o, goal_status(o)));
        assert_eq!(status("achieved", None), Some(("achieved", "Goal achieved")));
        assert_eq!(status("paused", Some("blocked")), Some(("blocked", "Goal blocked")));
        assert_eq!(status("paused", Some("turn_limit")), Some(("paused", "Goal paused")));
        assert_eq!(status("active", None), None, "a goal still running says nothing new");
        assert_eq!(status("cleared", None), None);
    }

    #[test]
    fn title_appends_the_workspace_directory_name() {
        assert_eq!(title("Done", Some("/Users/me/code/openagentd")), "Done · openagentd");
        assert_eq!(title("Done", Some("/Users/me/code/openagentd/")), "Done · openagentd");
    }

    #[test]
    fn title_is_the_bare_status_without_a_workspace() {
        assert_eq!(title("Needs input", None), "Needs input");
        assert_eq!(title("Needs input", Some("")), "Needs input");
        assert_eq!(title("Needs input", Some("/")), "Needs input");
    }

    #[test]
    fn body_collapses_whitespace_onto_one_line() {
        assert_eq!(body("  Which\n\ndatabase\tshould I use?  ").as_deref(), Some("Which database should I use?"));
    }

    #[test]
    fn body_is_none_when_blank() {
        assert_eq!(body(" \n\t "), None);
    }

    #[test]
    fn body_keeps_text_at_the_limit() {
        let text = "a".repeat(MAX_BODY_CHARS);
        assert_eq!(body(&text), Some(text));
    }

    #[test]
    fn body_clamps_long_text_with_an_ellipsis() {
        let text = format!("{} tail", "é".repeat(MAX_BODY_CHARS));
        let out = body(&text).unwrap();
        assert_eq!(out.chars().count(), MAX_BODY_CHARS);
        assert!(out.ends_with('…'), "{out}");
    }

    #[test]
    fn body_does_not_leave_a_space_before_the_ellipsis() {
        let text = format!("{} {}", "a".repeat(MAX_BODY_CHARS - 2), "b".repeat(20));
        assert_eq!(body(&text).unwrap(), format!("{}…", "a".repeat(MAX_BODY_CHARS - 2)));
    }
}
