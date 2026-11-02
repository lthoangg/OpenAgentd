//! Answering an agent's question from outside the app: the notch island,
//! the desktop pet and OS notifications.
//!
//! The shell asks the server what is open (`GET /api/agent/{id}/question`)
//! and posts the user's pick (`POST …/question/{qid}/answer`), the same two
//! calls the app window makes, so the Rust process keeps the credential and
//! the overlays never see it.
//!
//! Only the simplest shape is answered in place: one plain `ask_user`
//! question, one choice, a few short options. Anything that needs typing,
//! several answers, or a closer look (a plan review, a change to apply) is
//! left to the app: its button says "Open to answer".

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::AppHandle;

use crate::servers::ServerId;

/// Option buttons a surface shows at most; with more, the user opens the app.
pub const MAX_QUICK_CHOICES: usize = 4;
/// A longer label does not fit a button.
const MAX_CHOICE_CHARS: usize = 40;
/// Mirrors the server's cap on one typed answer.
const MAX_ANSWER_CHARS: usize = 2000;
const MAX_ANSWER_GROUPS: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// What became of an answer. Both outcomes clear the question everywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerOutcome {
    /// The server took it and the turn goes on.
    Answered,
    /// The question was not open any more (answered in the app, on another
    /// device, or replaced by a newer one).
    Gone,
}

/// One question of an `ask_user` call.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuestionItem {
    pub text: String,
    /// Option labels; `None` when there are none or one has no usable label.
    options: Option<Vec<String>>,
    multiple: bool,
}

/// The question a session is waiting on.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenQuestion {
    pub id: String,
    /// Set for plan reviews and change confirmations: they need the app.
    kind: Option<String>,
    pub items: Vec<QuestionItem>,
}

impl OpenQuestion {
    /// What to show as the question: the first one's text.
    pub fn text(&self) -> Option<&str> {
        self.items.first().map(|item| item.text.trim()).filter(|text| !text.is_empty())
    }

    /// The option labels a surface offers as buttons: only for one plain,
    /// single-choice question with a few short options. Empty otherwise.
    pub fn quick_choices(&self) -> Vec<String> {
        let [item] = self.items.as_slice() else {
            return Vec::new();
        };
        let Some(options) = item.options.as_ref().filter(|_| self.kind.is_none() && !item.multiple) else {
            return Vec::new();
        };
        let fits = options.len() <= MAX_QUICK_CHOICES
            && options.iter().all(|label| !label.trim().is_empty() && label.chars().count() <= MAX_CHOICE_CHARS);
        let unique = options.iter().enumerate().all(|(i, label)| !options[..i].contains(label));
        if fits && unique {
            options.clone()
        } else {
            Vec::new()
        }
    }
}

/// The open question in a `GET …/question` body (`{"question": {…} | null}`).
pub fn parse_question(body: &serde_json::Value) -> Option<OpenQuestion> {
    let question = body.get("question").filter(|q| q.is_object())?;
    let id = question.get("id")?.as_str()?.to_string();
    let kind = question.get("kind").and_then(|k| k.as_str()).map(str::to_string);
    let items = question
        .get("questions")
        .and_then(|q| q.as_array())
        .map(|list| list.iter().map(parse_item).collect())
        .unwrap_or_default();
    Some(OpenQuestion { id, kind, items })
}

fn parse_item(item: &serde_json::Value) -> QuestionItem {
    let text = item.get("question").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let options = item.get("options").and_then(|o| o.as_array()).and_then(|list| {
        list.iter().map(|option| option.get("label").and_then(|l| l.as_str()).map(str::to_string)).collect::<Option<Vec<String>>>()
    });
    QuestionItem {
        text,
        // No options at all is a question that takes typing; a malformed one is too.
        options: options.filter(|labels| !labels.is_empty()),
        multiple: item.get("multiple").and_then(|m| m.as_bool()).unwrap_or(false),
    }
}

/// Whether `id` can sit in a URL path as a session or question id: the
/// overlays are local pages, but they still do not get to choose the route.
pub fn is_id(id: &str) -> bool {
    (32..=36).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// An id as the API's path wants it: hyphenated. Some events carry it bare.
pub fn api_id(id: &str) -> String {
    let bare = id.len() == 32 && !id.contains('-');
    if bare {
        format!("{}-{}-{}-{}-{}", &id[..8], &id[8..12], &id[12..16], &id[16..20], &id[20..])
    } else {
        id.to_string()
    }
}

fn question_url(base: &str, session_id: &str) -> Result<String> {
    if !is_id(session_id) {
        bail!("Not a session id.");
    }
    Ok(format!("{}/api/agent/{}/question", base.trim_end_matches('/'), api_id(session_id)))
}

fn answer_url(base: &str, session_id: &str, question_id: &str) -> Result<String> {
    if !is_id(question_id) {
        bail!("Not a question id.");
    }
    Ok(format!("{}/{}/answer", question_url(base, session_id)?, api_id(question_id)))
}

/// Whether `answers` is something to post: a few groups of short, non-empty answers.
pub fn check_answers(answers: &[Vec<String>]) -> Result<()> {
    if answers.is_empty() || answers.len() > MAX_ANSWER_GROUPS {
        bail!("Nothing to answer.");
    }
    for group in answers {
        if group.is_empty() || group.iter().any(|answer| answer.trim().is_empty() || answer.chars().count() > MAX_ANSWER_CHARS) {
            bail!("An answer is empty or too long.");
        }
    }
    Ok(())
}

/// What a status code from the answer route means; `None` is a failure.
/// 409 is "not open" (answered elsewhere); 404 is "a different question is
/// open now". Either way the one we hold is gone.
pub fn outcome_for_status(status: u16) -> Option<AnswerOutcome> {
    match status {
        200..=299 => Some(AnswerOutcome::Answered),
        404 | 409 => Some(AnswerOutcome::Gone),
        _ => None,
    }
}

/// The question `session_id` waits on, from the server at `base`.
pub async fn fetch_question_at(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    session_id: &str,
) -> Result<Option<OpenQuestion>> {
    let mut request = client.get(question_url(base, session_id)?).timeout(REQUEST_TIMEOUT);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let body: serde_json::Value = request
        .send()
        .await
        .context("ask for the open question")?
        .error_for_status()
        .context("the open question returned an error status")?
        .json()
        .await
        .context("parse the open question")?;
    Ok(parse_question(&body))
}

/// Post `answers` to `question_id` of `session_id` on the server at `base`.
pub async fn submit_at(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    session_id: &str,
    question_id: &str,
    answers: &[Vec<String>],
) -> Result<AnswerOutcome> {
    check_answers(answers)?;
    let url = answer_url(base, session_id, question_id)?;
    let mut request = client.post(url).timeout(REQUEST_TIMEOUT).json(&serde_json::json!({ "answers": answers }));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.context("send the answer")?;
    let status = response.status().as_u16();
    if let Some(outcome) = outcome_for_status(status) {
        return Ok(outcome);
    }
    if status == 401 || status == 403 {
        bail!("The server rejected the access key (HTTP {status}).");
    }
    let body = response.text().await.unwrap_or_default();
    let detail: String = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
        .unwrap_or(body)
        .chars()
        .take(200)
        .collect();
    bail!("The server refused the answer (HTTP {status}): {detail}")
}

/// The client for `server`: the builtin is plain HTTP on loopback.
fn client_for(server: &ServerId) -> &'static reqwest::Client {
    if *server == ServerId::Bundled {
        crate::usage::loopback_client()
    } else {
        crate::usage::shared_client()
    }
}

/// [`fetch_question_at`] on `server`, with its saved credential.
pub async fn fetch_question(app: &AppHandle, server: &ServerId, session_id: &str) -> Result<Option<OpenQuestion>> {
    let (base, token) = crate::servers::endpoint(app, server).await.context("The server is not available.")?;
    fetch_question_at(client_for(server), &base, token.as_deref(), session_id).await
}

/// [`submit_at`] on `server`, with its saved credential.
pub async fn submit(
    app: &AppHandle,
    server: &ServerId,
    session_id: &str,
    question_id: &str,
    answers: &[Vec<String>],
) -> Result<AnswerOutcome> {
    let (base, token) = crate::servers::endpoint(app, server).await.context("The server is not available.")?;
    submit_at(client_for(server), &base, token.as_deref(), session_id, question_id, answers).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SESSION: &str = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
    const QUESTION: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

    fn open(questions: serde_json::Value) -> OpenQuestion {
        parse_question(&json!({ "question": { "id": QUESTION, "questions": questions } })).unwrap()
    }

    fn single(options: &[&str]) -> OpenQuestion {
        let options: Vec<_> = options.iter().map(|label| json!({ "label": label })).collect();
        open(json!([{ "question": "Which branch?", "options": options }]))
    }

    #[test]
    fn a_closed_session_has_no_question() {
        assert_eq!(parse_question(&json!({ "question": null })), None);
        assert_eq!(parse_question(&json!({})), None);
    }

    #[test]
    fn one_single_choice_question_offers_its_options_as_buttons() {
        let question = single(&["Wait for Work", "Use Auto"]);
        assert_eq!(question.id, QUESTION);
        assert_eq!(question.text(), Some("Which branch?"));
        assert_eq!(question.quick_choices(), ["Wait for Work", "Use Auto"]);
    }

    #[test]
    fn more_than_four_options_or_a_long_label_is_left_to_the_app() {
        assert!(single(&["a", "b", "c", "d", "e"]).quick_choices().is_empty());
        assert_eq!(single(&["a", "b", "c", "d"]).quick_choices().len(), MAX_QUICK_CHOICES);
        assert!(single(&["A label that is far too long to fit on one small button"]).quick_choices().is_empty());
        assert!(single(&["Same", "Same"]).quick_choices().is_empty());
    }

    #[test]
    fn typing_several_questions_or_several_answers_need_the_app() {
        assert!(open(json!([{ "question": "Name it", "options": [] }])).quick_choices().is_empty(), "free text");
        assert!(open(json!([{ "question": "Name it" }])).quick_choices().is_empty(), "no options at all");
        let two = json!([{ "question": "a", "options": [{ "label": "x" }] }, { "question": "b", "options": [{ "label": "y" }] }]);
        assert!(open(two).quick_choices().is_empty());
        let many = json!([{ "question": "a", "multiple": true, "options": [{ "label": "x" }, { "label": "y" }] }]);
        assert!(open(many).quick_choices().is_empty());
        let unlabelled = json!([{ "question": "a", "options": [{ "label": "x" }, { "description": "no label" }] }]);
        assert!(open(unlabelled).quick_choices().is_empty());
    }

    // Approving a plan or applying a change is a decision about what is on
    // screen in the app, not a button on a pill.
    #[test]
    fn a_plan_review_or_confirmation_is_never_answered_in_place() {
        for kind in ["plan_review", "confirm_change"] {
            let body = json!({ "question": {
                "id": QUESTION,
                "kind": kind,
                "questions": [{ "question": "Approve?", "options": [{ "label": "Approve" }, { "label": "Request changes" }] }],
            } });
            let question = parse_question(&body).unwrap();
            assert_eq!(question.text(), Some("Approve?"));
            assert!(question.quick_choices().is_empty(), "{kind}");
        }
    }

    #[test]
    fn ids_are_checked_before_they_reach_a_path() {
        assert!(is_id(SESSION));
        assert!(is_id("5f0c1d2e3a4b4c5d8e6f7a8b9c0d1e2f"));
        for bad in ["", "abc", "../../etc/passwd", "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f/../x", "zzzzzzzz-3a4b-4c5d-8e6f-7a8b9c0d1e2f"] {
            assert!(!is_id(bad), "{bad}");
        }
        assert_eq!(api_id("5f0c1d2e3a4b4c5d8e6f7a8b9c0d1e2f"), SESSION);
        assert_eq!(api_id(SESSION), SESSION);
    }

    #[test]
    fn the_routes_match_the_servers() {
        assert_eq!(question_url("http://127.0.0.1:4082/", SESSION).unwrap(), format!("http://127.0.0.1:4082/api/agent/{SESSION}/question"));
        assert_eq!(
            answer_url("http://127.0.0.1:4082", SESSION, QUESTION).unwrap(),
            format!("http://127.0.0.1:4082/api/agent/{SESSION}/question/{QUESTION}/answer"),
        );
        assert!(question_url("http://x", "../x").is_err());
        assert!(answer_url("http://x", SESSION, "../x").is_err());
    }

    #[test]
    fn only_short_non_empty_answers_are_posted() {
        assert!(check_answers(&[vec!["Use Auto".into()]]).is_ok());
        assert!(check_answers(&[]).is_err());
        assert!(check_answers(&[vec![]]).is_err());
        assert!(check_answers(&[vec!["  ".into()]]).is_err());
        assert!(check_answers(&[vec!["x".repeat(MAX_ANSWER_CHARS + 1)]]).is_err());
        assert!(check_answers(&vec![vec!["a".to_string()]; MAX_ANSWER_GROUPS + 1]).is_err());
    }

    #[test]
    fn a_question_that_is_no_longer_open_counts_as_answered_elsewhere() {
        assert_eq!(outcome_for_status(200), Some(AnswerOutcome::Answered));
        assert_eq!(outcome_for_status(409), Some(AnswerOutcome::Gone));
        assert_eq!(outcome_for_status(404), Some(AnswerOutcome::Gone));
        for failure in [400, 401, 403, 422, 500, 503] {
            assert_eq!(outcome_for_status(failure), None, "{failure}");
        }
        assert_eq!(serde_json::to_value(AnswerOutcome::Gone).unwrap(), "gone");
        assert_eq!(serde_json::to_value(AnswerOutcome::Answered).unwrap(), "answered");
    }
}
