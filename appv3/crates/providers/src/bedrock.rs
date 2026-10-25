//! AWS Bedrock Mantle — port of `providers/bedrock/{bedrock,token}.py`.
//!
//! Mantle exposes Bedrock models through Anthropic Messages or
//! OpenAI-compatible surfaces. Bearer tokens are supplied directly or
//! generated (SigV4 presign) from the AWS credential chain per request.

use crate::anthropic::AnthropicProvider;
use crate::openai::{CompletionsDialect, OpenAiProvider};
use crate::registry::{get_model_limits, get_model_transport_full};
use crate::types::*;
use appv3_core::env::os_environ;
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn home() -> PathBuf {
    appv3_core::home::home_dir_opt().unwrap_or_default()
}

fn env(name: &str) -> Option<String> {
    os_environ(name).filter(|v| !v.is_empty())
}

// ── configparser subset ─────────────────────────────────────────────────────

type Ini = HashMap<String, HashMap<String, String>>;

/// Minimal `configparser.ConfigParser.read`: sections, `key = value` /
/// `key: value`, lower-cased keys, `#`/`;` comment lines, continuation lines,
/// `[DEFAULT]` inheritance. Duplicate sections/keys fail like configparser.
fn parse_ini(text: &str) -> Option<Ini> {
    let mut ini: Ini = HashMap::new();
    let mut defaults: HashMap<String, String> = HashMap::new();
    let mut cur: Option<String> = None;
    let mut last_key: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim_end();
        let stripped = line.trim_start();
        if stripped.is_empty() || stripped.starts_with('#') || stripped.starts_with(';') {
            continue;
        }
        let indented = line.len() != stripped.len();
        if indented {
            if let (Some(sec), Some(k)) = (&cur, &last_key) {
                let map = if sec == "DEFAULT" { &mut defaults } else { ini.get_mut(sec)? };
                if let Some(v) = map.get_mut(k) {
                    v.push('\n');
                    v.push_str(stripped);
                }
                continue;
            }
        }
        if stripped.starts_with('[') && stripped.ends_with(']') {
            let name = stripped[1..stripped.len() - 1].to_string();
            if name != "DEFAULT" {
                if ini.contains_key(&name) {
                    return None;
                }
                ini.insert(name.clone(), HashMap::new());
            }
            cur = Some(name);
            last_key = None;
            continue;
        }
        let sec = cur.clone()?;
        let pos = stripped.find(['=', ':'])?;
        let key = stripped[..pos].trim().to_lowercase();
        let val = stripped[pos + 1..].trim().to_string();
        let map = if sec == "DEFAULT" { &mut defaults } else { ini.get_mut(&sec)? };
        if map.contains_key(&key) {
            return None;
        }
        map.insert(key.clone(), val);
        last_key = Some(key);
    }
    for sec in ini.values_mut() {
        for (k, v) in &defaults {
            sec.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    Some(ini)
}

fn read_ini(path: &Path) -> Option<Ini> {
    if !path.is_file() {
        return None;
    }
    parse_ini(&std::fs::read_to_string(path).ok()?)
}

type Creds = (String, String, Option<String>);

fn from_section(sec: &HashMap<String, String>) -> Option<Creds> {
    let get = |a: &str, b: &str| sec.get(a).filter(|v| !v.is_empty()).or_else(|| sec.get(b)).filter(|v| !v.is_empty()).cloned();
    let ak = get("aws_access_key_id", "aws_access_key")?;
    let sk = get("aws_secret_access_key", "aws_secret_key")?;
    Some((ak, sk, get("aws_session_token", "aws_security_token")))
}

fn env_creds() -> Option<Creds> {
    Some((env("AWS_ACCESS_KEY_ID")?, env("AWS_SECRET_ACCESS_KEY")?, env("AWS_SESSION_TOKEN")))
}

fn creds_from_json(v: &Value) -> Option<Creds> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
    Some((s("accessKeyId")?, s("secretAccessKey")?, s("sessionToken")))
}

/// `resolve_aws_credentials(profile_name)`.
pub fn resolve_aws_credentials(profile_name: Option<&str>) -> Result<Creds, String> {
    let profile_name = profile_name.filter(|p| !p.is_empty());
    let profile = profile_name.map(String::from).or_else(|| env("AWS_PROFILE")).unwrap_or_else(|| "default".into());
    if profile == "default" || profile_name.is_none() {
        if let Some(c) = env_creds() {
            return Ok(c);
        }
    }
    let aws = home().join(".aws");
    if let Some(ini) = read_ini(&aws.join("credentials")) {
        for name in [profile.clone(), format!("profile {profile}")] {
            if let Some(c) = ini.get(&name).and_then(from_section) {
                return Ok(c);
            }
        }
    }
    if let Some(ini) = read_ini(&aws.join("config")) {
        for name in [format!("profile {profile}"), profile.clone()] {
            if let Some(c) = ini.get(&name).and_then(from_section) {
                return Ok(c);
            }
        }
    }
    for dir in [aws.join("login").join("cache"), aws.join("sso").join("cache"), aws.join("cli").join("cache")] {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json")).collect();
        files.sort();
        for f in files {
            let Some(data) = std::fs::read(&f).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
            let found = match data.get("accessToken") {
                Some(v @ Value::Object(_)) => creds_from_json(v),
                Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok().filter(|p| p.is_object()).and_then(|p| creds_from_json(&p)),
                _ => None,
            };
            if let Some(c) = found {
                return Ok(c);
            }
        }
    }
    if let Some(c) = env_creds() {
        return Ok(c);
    }
    Err(format!("AWS credentials for profile {} not found in environment, ~/.aws/config, ~/.aws/credentials, or login cache", crate::plugin::py_repr_str(&profile)))
}

/// `resolve_aws_region(region_name, profile_name)`.
pub fn resolve_aws_region(region_name: Option<&str>, profile_name: Option<&str>) -> String {
    if let Some(r) = region_name.filter(|r| !r.is_empty()) {
        return r.to_string();
    }
    if let Some(r) = env("AWS_BEDROCK_REGION").or_else(|| env("AWS_REGION")).or_else(|| env("AWS_DEFAULT_REGION")) {
        return r;
    }
    let profile = profile_name.filter(|p| !p.is_empty()).map(String::from).or_else(|| env("AWS_PROFILE")).unwrap_or_else(|| "default".into());
    if let Some(ini) = read_ini(&home().join(".aws").join("config")) {
        for name in [format!("profile {profile}"), profile.clone(), "default".into(), "profile default".into()] {
            if let Some(r) = ini.get(&name).and_then(|s| s.get("region")) {
                let r = r.trim();
                if !r.is_empty() {
                    return r.to_string();
                }
            }
        }
    }
    "us-east-1".into()
}

/// `resolve_bedrock_region` — validated so it can build the Mantle host.
pub fn resolve_bedrock_region(region_name: Option<&str>) -> Result<String, String> {
    let region = resolve_aws_region(region_name, None);
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"^[a-z]{2}(?:-[a-z0-9]+)+-\d$").unwrap());
    if !re.is_match(&region) {
        return Err(format!("Invalid AWS Bedrock region: {}", crate::plugin::py_repr_str(&region)));
    }
    Ok(region)
}

// ── SigV4 bearer token ──────────────────────────────────────────────────────

fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    const B: usize = 64;
    let mut k = if key.len() > B { Sha256::digest(key).to_vec() } else { key.to_vec() };
    k.resize(B, 0);
    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    let inner = Sha256::new().chain_update(&ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(&opad).chain_update(inner).finalize().to_vec()
}

/// `urllib.parse.quote(s, safe='')`.
fn quote(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Presigned token body for fixed inputs (split out for tests).
pub fn sign_bearer_token(creds: &Creds, region: &str, now: chrono::DateTime<chrono::Utc>, expires: u64) -> String {
    let (ak, sk, st) = creds;
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let service = "bedrock";
    let host = if region != "us-east-1" { format!("bedrock.{region}.amazonaws.com") } else { "bedrock.amazonaws.com".to_string() };
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let mut params: Vec<(String, String)> = vec![
        ("Action".into(), "CallWithBearerToken".into()),
        ("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()),
        ("X-Amz-Credential".into(), format!("{ak}/{scope}")),
        ("X-Amz-Date".into(), amz_date.clone()),
        ("X-Amz-Expires".into(), expires.to_string()),
        ("X-Amz-SignedHeaders".into(), "host".into()),
    ];
    if let Some(t) = st.as_ref().filter(|t| !t.is_empty()) {
        params.push(("X-Amz-Security-Token".into(), t.clone()));
    }
    params.sort();
    let cq = params.iter().map(|(k, v)| format!("{}={}", quote(k), quote(v))).collect::<Vec<_>>().join("&");
    let payload_hash = hex::encode(Sha256::digest(b""));
    let canonical = format!("POST\n/\n{cq}\nhost:{host}\n\nhost\n{payload_hash}");
    let sts = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex::encode(Sha256::digest(canonical.as_bytes())));
    let k_date = hmac_sha256(format!("AWS4{sk}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_sign = hmac_sha256(&k_service, b"aws4_request");
    let sig = hex::encode(hmac_sha256(&k_sign, sts.as_bytes()));
    let url = format!("{host}/?{cq}&X-Amz-Signature={sig}&Version=1");
    use base64::Engine;
    format!("bedrock-api-key-{}", base64::engine::general_purpose::STANDARD.encode(url.as_bytes()))
}

/// `generate_bedrock_bearer_token(region, profile_name)`.
pub fn generate_bearer_token(region: &str, profile_name: Option<&str>) -> Result<String, String> {
    let creds = resolve_aws_credentials(profile_name)?;
    Ok(sign_bearer_token(&creds, region, chrono::Utc::now(), 43200))
}

// ── provider ────────────────────────────────────────────────────────────────

pub struct BedrockProvider {
    model: String,
    region: String,
    profile: Option<String>,
    bearer: Option<String>,
    kw: Kwargs,
    pub provider_name: Option<String>,
}

fn is_anthropic_model(m: &str) -> bool {
    m.starts_with("anthropic.") || m.contains(".anthropic.")
}

/// Factory entry: token → named profile → default chain; region from
/// settings / env.
pub fn build(model: &str, model_kwargs: Kwargs, creds: &crate::creds::CredentialStore) -> ProviderResult<Arc<dyn LlmProvider>> {
    let setting = |n: &str| Some(creds.get(n)).filter(|v| !v.is_empty());
    let region = resolve_bedrock_region(setting("AWS_BEDROCK_REGION").as_deref()).map_err(ProviderError::Invalid)?;
    Ok(Arc::new(BedrockProvider {
        model: model.into(),
        region,
        profile: setting("AWS_BEDROCK_PROFILE"),
        bearer: setting("AWS_BEARER_TOKEN_BEDROCK"),
        kw: model_kwargs,
        provider_name: Some("bedrock".into()),
    }))
}

impl BedrockProvider {
    fn fresh_token(&self) -> ProviderResult<String> {
        if let Some(t) = self.bearer.as_ref().filter(|t| !t.is_empty()) {
            return Ok(t.clone());
        }
        generate_bearer_token(&self.region, self.profile.as_deref()).map_err(|_| {
            ProviderError::Other(
                "Bedrock bearer token generation failed. Reauthenticate the configured AWS profile with `aws login` or `aws sso login`, or configure AWS_BEARER_TOKEN_BEDROCK."
                    .into(),
            )
        })
    }

    fn delegate(&self) -> ProviderResult<Arc<dyn LlmProvider>> {
        let token = self.fresh_token()?;
        let model_id = format!("bedrock:{}", self.model);
        if is_anthropic_model(&self.model) {
            let mut kw = self.kw.clone();
            if !kw.contains_key("max_tokens") {
                if let Some(m) = get_model_limits(Some(&model_id)).max_completion_tokens {
                    kw.insert("max_tokens".into(), json!(m));
                }
            }
            let p = AnthropicProvider::new(&token, &self.model, &format!("https://bedrock-mantle.{}.api.aws/anthropic", self.region), kw)?;
            return Ok(Arc::new(p));
        }
        let transport = get_model_transport_full(Some(&model_id));
        let suffix = if transport.as_ref().map(|t| t.0.as_str()) == Some("openai") { "/openai/v1" } else { "/v1" };
        let mut kw = self.kw.clone();
        if let Some((_, family)) = &transport {
            if !kw.contains_key("responses_api") {
                kw.insert("responses_api".into(), json!(family == "responses"));
            }
        }
        let mut p = OpenAiProvider::new(&token, &self.model, &format!("https://bedrock-mantle.{}.api.aws{suffix}", self.region), kw, CompletionsDialect::OpenAi, true)?;
        p.responses.preserve_stateless_reasoning = true;
        Ok(Arc::new(p))
    }
}

#[async_trait]
impl LlmProvider for BedrockProvider {
    fn model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> Option<&str> {
        self.provider_name.as_deref()
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        self.delegate()?.chat(messages, tools, kwargs).await
    }
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        self.delegate()?.stream(messages, tools, kwargs).await
    }
}

/// `model_discovery._bedrock_models(overrides)`.
pub async fn discover_models(overrides: &HashMap<String, String>) -> Result<Vec<String>, String> {
    let creds = crate::creds::CredentialStore::for_provider("bedrock", overrides.clone());
    let resolve = |n: &str| Some(creds.get(n)).filter(|v| !v.is_empty());
    let region = resolve_bedrock_region(resolve("AWS_BEDROCK_REGION").or_else(|| env("AWS_DEFAULT_REGION")).as_deref())?;
    let token = match resolve("AWS_BEARER_TOKEN_BEDROCK") {
        Some(t) => t,
        None => generate_bearer_token(&region, resolve("AWS_BEDROCK_PROFILE").as_deref())?,
    };
    let url = format!("https://bedrock-mantle.{region}.api.aws/v1/models");
    let r = crate::openai::shared_client()
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    if st >= 400 {
        return Err(crate::plugin::http_status_message(st, &url));
    }
    let data: Value = r.json().await.map_err(|e| e.to_string())?;
    let mut out: Vec<String> = data.get("data").and_then(|d| d.as_array()).into_iter().flatten().filter_map(|i| i.get("id").and_then(|x| x.as_str()).map(String::from)).collect();
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_known_vector() {
        // RFC 4231 test case 2.
        assert_eq!(hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn ini_parsing() {
        let ini = parse_ini("[default]\naws_access_key_id = AK\nAWS_SECRET_ACCESS_KEY: SK\n\n[profile dev]\nregion = eu-west-1\n").unwrap();
        assert_eq!(from_section(&ini["default"]).unwrap(), ("AK".into(), "SK".into(), None));
        assert_eq!(ini["profile dev"]["region"], "eu-west-1");
        assert!(parse_ini("[a]\nx=1\n[a]\n").is_none());
    }

    #[test]
    fn region_validation() {
        assert!(resolve_bedrock_region(Some("us-west-2")).is_ok());
        assert_eq!(resolve_bedrock_region(Some("bad")).unwrap_err(), "Invalid AWS Bedrock region: 'bad'");
    }

    #[test]
    fn bearer_token_matches_v2() {
        use chrono::TimeZone;
        let now = chrono::Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        // Expected values generated by v2 `generate_bedrock_bearer_token` with the same inputs.
        let a = sign_bearer_token(&("AKIDEXAMPLE".into(), "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(), Some("tok/en+=".into())), "eu-west-1", now, 43200);
        assert_eq!(a, "bedrock-api-key-YmVkcm9jay5ldS13ZXN0LTEuYW1hem9uYXdzLmNvbS8/QWN0aW9uPUNhbGxXaXRoQmVhcmVyVG9rZW4mWC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lERVhBTVBMRSUyRjIwMjYwMTAyJTJGZXUtd2VzdC0xJTJGYmVkcm9jayUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjYwMTAyVDAzMDQwNVomWC1BbXotRXhwaXJlcz00MzIwMCZYLUFtei1TZWN1cml0eS1Ub2tlbj10b2slMkZlbiUyQiUzRCZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmWC1BbXotU2lnbmF0dXJlPWJlZThkMGU1NmQyODE0YWE2NmEyMzk1ZWVhNzc4MTYwNTU1YzVhNTZiZGY3ZDgwMTM5MmZlNjUyMDI0NzM0OGUmVmVyc2lvbj0x");
        let b = sign_bearer_token(&("AKID".into(), "SK".into(), None), "us-east-1", now, 900);
        assert_eq!(b, "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUQlMkYyMDI2MDEwMiUyRnVzLWVhc3QtMSUyRmJlZHJvY2slMkZhd3M0X3JlcXVlc3QmWC1BbXotRGF0ZT0yMDI2MDEwMlQwMzA0MDVaJlgtQW16LUV4cGlyZXM9OTAwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZYLUFtei1TaWduYXR1cmU9MGVlNDFkZjQ0ZTU0MDk3MTgwNTVmZGIzYmJiNDNmMjZiOGEzYmZjMjVlMTgzMjVhZTViZjIyOTEyNDQ3NTFlNCZWZXJzaW9uPTE=");
    }
}
