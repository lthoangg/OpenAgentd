//! Hide stored credentials in tool output.
//!
//! Every value in `credentials.yaml` (the agent's secrets, provider keys,
//! connector secrets, OAuth tokens) is replaced with `[secret NAME]` in each
//! tool result and each streamed chunk before the model, the transcript, the
//! event stream or telemetry sees it. This catches accidents (an API error
//! that echoes the key, `env`, `cat`); a value the agent deliberately
//! transforms (base64, split) is not caught, the same limit CI log masking has.

use aho_corasick::{AhoCorasick, MatchKind};
use std::borrow::Cow;
use std::sync::{Arc, Mutex, OnceLock};

use crate::credentials::CredentialsFile;

/// Shorter values are not masked: they would hide ordinary words.
pub const MIN_MASKED_CHARS: usize = 8;

/// The search over every stored value.
#[derive(Default)]
pub struct Masker {
    ac: Option<AhoCorasick>,
    labels: Vec<String>,
    /// Longest pattern, in bytes.
    max_len: usize,
}

fn label(name: &str) -> String {
    format!("[secret {name}]")
}

impl Masker {
    /// Masker over `values` (`(label name, value)`); short values are skipped.
    pub fn new<I: IntoIterator<Item = (String, String)>>(values: I) -> Self {
        let mut pats: Vec<(String, String)> = vec![];
        let mut push = |name: &str, v: &str| {
            if v.chars().count() >= MIN_MASKED_CHARS && !pats.iter().any(|(_, p)| p == v) {
                pats.push((name.to_string(), v.to_string()));
            }
        };
        for (name, value) in values {
            push(&name, &value);
            // Each line of a multi-line value (a PEM key) is masked too, so a
            // tool that prints part of it still hides what it prints.
            if value.contains('\n') {
                for line in value.lines() {
                    push(&name, line.trim());
                }
            }
        }
        if pats.is_empty() {
            return Self::default();
        }
        let ac = AhoCorasick::builder().match_kind(MatchKind::LeftmostLongest).build(pats.iter().map(|(_, v)| v.as_bytes())).ok();
        let max_len = pats.iter().map(|(_, v)| v.len()).max().unwrap_or(0);
        Self { ac, labels: pats.into_iter().map(|(n, _)| label(&n)).collect(), max_len }
    }

    /// Masker over every value in `f`.
    pub fn from_file(f: &CredentialsFile) -> Self {
        let mut values: Vec<(String, String)> = vec![];
        for (name, list) in &f.agent_secrets {
            values.extend(list.iter().map(|s| (name.clone(), s.value.clone())));
        }
        values.extend(f.secrets.iter().map(|(k, v)| (k.clone(), v.clone())));
        for (provider, creds) in &f.providers {
            for c in creds {
                values.extend(c.values.iter().map(|(k, v)| (k.clone(), v.clone())));
                if let Some(doc) = &c.oauth {
                    oauth_tokens(doc, &format!("{provider} token"), &mut values);
                }
            }
        }
        Self::new(values)
    }

    pub fn is_empty(&self) -> bool {
        self.ac.is_none()
    }

    /// `text` with every stored value replaced by `[secret NAME]`.
    pub fn mask<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let Some(ac) = &self.ac else { return Cow::Borrowed(text) };
        if !ac.is_match(text) {
            return Cow::Borrowed(text);
        }
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for m in ac.find_iter(text) {
            out.push_str(&text[last..m.start()]);
            out.push_str(&self.labels[m.pattern().as_usize()]);
            last = m.end();
        }
        out.push_str(&text[last..]);
        Cow::Owned(out)
    }
}

/// The token strings of an OAuth document (keys naming a token, secret or key).
fn oauth_tokens(v: &serde_json::Value, name: &str, out: &mut Vec<(String, String)>) {
    if let Some(o) = v.as_object() {
        for (k, val) in o {
            let k = k.to_ascii_lowercase();
            match val {
                serde_json::Value::String(s) if k.contains("token") || k.contains("secret") || k.contains("key") => out.push((name.to_string(), s.clone())),
                serde_json::Value::Object(_) => oauth_tokens(val, name, out),
                _ => {}
            }
        }
    }
}

/// The snapshot a masker was built from, and the masker.
type Cached = Option<(Arc<CredentialsFile>, Arc<Masker>)>;

/// The masker for the active `credentials.yaml`, rebuilt when it changes.
pub fn current() -> Arc<Masker> {
    // The cached snapshot is held, so its address cannot be reused by a
    // later snapshot while it is compared.
    static CACHE: OnceLock<Mutex<Cached>> = OnceLock::new();
    let f = crate::credentials::snapshot();
    let mut c = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
    match &*c {
        Some((seen, m)) if Arc::ptr_eq(seen, &f) => m.clone(),
        _ => {
            let m = Arc::new(Masker::from_file(&f));
            *c = Some((f, m.clone()));
            m
        }
    }
}

/// [`Masker::mask`] with the active store.
pub fn mask(text: &str) -> Cow<'_, str> {
    let m = current();
    match m.mask(text) {
        Cow::Borrowed(_) => Cow::Borrowed(text),
        Cow::Owned(s) => Cow::Owned(s),
    }
}

/// Masks a stream of chunks: a value split across chunks is still caught,
/// at the cost of holding back the last few bytes until the next chunk or
/// [`StreamMask::finish`].
pub struct StreamMask {
    m: Arc<Masker>,
    held: String,
}

impl StreamMask {
    pub fn new(m: Arc<Masker>) -> Self {
        Self { m, held: String::new() }
    }

    /// What of `chunk` (and what was held) can be shown now.
    pub fn push(&mut self, chunk: &str) -> String {
        if self.m.is_empty() {
            return chunk.to_string();
        }
        self.held.push_str(chunk);
        let masked = self.m.mask(&self.held).into_owned();
        // A value cut off at the end is at most `max_len - 1` bytes long.
        let keep = self.m.max_len.saturating_sub(1).min(masked.len());
        let mut cut = masked.len() - keep;
        while !masked.is_char_boundary(cut) {
            cut -= 1;
        }
        self.held = masked[cut..].to_string();
        masked[..cut].to_string()
    }

    /// The rest, at the end of the stream.
    pub fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.held);
        self.m.mask(&rest).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masker() -> Arc<Masker> {
        let stripe = "sk_live_abcdef123456".to_string(); // gitleaks:allow (synthetic fixture)
        Arc::new(Masker::new([("STRIPE_SECRET_KEY".to_string(), stripe), ("SHORT".to_string(), "abc".to_string())]))
    }

    #[test]
    fn e1_a_value_in_output_is_replaced_by_its_name() {
        let m = masker();
        assert_eq!(m.mask("Invalid API Key provided: sk_live_abcdef123456."), "Invalid API Key provided: [secret STRIPE_SECRET_KEY]."); // gitleaks:allow (synthetic fixture)
        assert!(matches!(m.mask("nothing here"), Cow::Borrowed(_)));
        assert_eq!(m.mask("abc stays"), "abc stays", "values under 8 characters are not masked");
    }

    #[test]
    fn e1_a_value_split_across_stream_chunks_is_still_masked() {
        let mut s = StreamMask::new(masker());
        let mut shown = String::new();
        for chunk in ["key=sk_live_ab", "cdef12", "3456 done\n", "more ", "text"] {
            shown.push_str(&s.push(chunk));
        }
        shown.push_str(&s.finish());
        assert_eq!(shown, "key=[secret STRIPE_SECRET_KEY] done\nmore text");
        assert!(!shown.contains("sk_live"));
    }

    #[test]
    fn stream_holds_back_only_what_could_start_a_value() {
        let mut s = StreamMask::new(masker());
        let first = s.push("hello world, a long line of ordinary output");
        assert!(first.starts_with("hello world"), "{first}");
        assert_eq!(format!("{first}{}", s.finish()), "hello world, a long line of ordinary output");
    }

    #[test]
    fn every_line_of_a_multiline_value_is_masked() {
        let pem = "-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END KEY-----";
        let m = Masker::new([("TLS_KEY".to_string(), pem.to_string())]);
        assert_eq!(m.mask(&format!("got {pem}")), "got [secret TLS_KEY]");
        assert_eq!(m.mask("line: MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"), "line: [secret TLS_KEY]");
    }

    #[test]
    fn provider_keys_named_secrets_and_oauth_tokens_are_masked_too() {
        let mut f = CredentialsFile::default();
        let mut c = crate::credentials::Credential::new("k");
        c.values.insert("OPENAI_API_KEY".into(), "sk-proj-0123456789".into());
        c.oauth = Some(serde_json::json!({"access_token": "oauth-access-123456", "account_id": "acct"}));
        f.provider_mut("openai").push(c);
        f.secrets.insert("GITHUB_MCP_API_KEY".into(), "ghp_named_123456".into());
        let m = Masker::from_file(&f);
        assert_eq!(m.mask("sk-proj-0123456789 ghp_named_123456 oauth-access-123456"), "[secret OPENAI_API_KEY] [secret GITHUB_MCP_API_KEY] [secret openai token]");
    }
}
