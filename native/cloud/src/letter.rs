//! Mailbox letters (spec section 6), sealed by the sender to the
//! recipient's box key, with the sender's static key mixed in so the cloud
//! cannot forge one.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::encoding::b64;
use crate::keys::{Seed, X25519};
use crate::{lines, Error, Result};

/// The sizes a sealed letter may have.
pub const SIZES: [usize; 4] = [256, 512, 1024, 2048];

/// What a letter is about. The outer `kind` must match the sealed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Done,
    NeedsYou,
    Failed,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Done => "done",
            Kind::NeedsYou => "needs_you",
            Kind::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "done" => Some(Kind::Done),
            "needs_you" => Some(Kind::NeedsYou),
            "failed" => Some(Kind::Failed),
            _ => None,
        }
    }
}

/// `J`: the text a notification shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Text {
    pub v: u8,
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session: Option<String>,
    pub at: u64,
}

pub struct Context<'a> {
    pub account_id: &'a str,
    pub sender_id: &'a str,
    pub recipient_id: &'a str,
    pub kind: Kind,
}

fn key_and_nonce(ikm: &[u8], ctx: &Context<'_>, e_pub: &[u8; 32]) -> Zeroizing<[u8; 44]> {
    let info = lines!["agentd-letter-v1", ctx.account_id, ctx.sender_id, ctx.recipient_id, ctx.kind.as_str(), &b64(e_pub)];
    let mut okm = Zeroizing::new([0u8; 44]);
    Hkdf::<Sha256>::new(Some(&[]), ikm).expand(&info, okm.as_mut()).expect("44 bytes is a valid HKDF length");
    okm
}

/// Seals `json` (the exact bytes of `J`) from `sender` to `recipient_box`.
/// `ephemeral` fixes the ephemeral key (test vectors only).
pub fn seal_json(sender: &X25519, recipient_box: &[u8; 32], ctx: &Context<'_>, json: &[u8], ephemeral: Option<Seed>) -> Result<Vec<u8>> {
    let size = SIZES.into_iter().find(|s| s - 48 >= json.len() + 2).ok_or(Error::LetterTooLong)?;
    let mut plaintext = Zeroizing::new(vec![0u8; size - 48]);
    plaintext[..2].copy_from_slice(&(json.len() as u16).to_be_bytes());
    plaintext[2..2 + json.len()].copy_from_slice(json);
    let e = X25519::from_seed(ephemeral.unwrap_or_else(Seed::random));
    let e_pub = e.public();
    let mut ikm = Zeroizing::new(Vec::with_capacity(64));
    ikm.extend_from_slice(e.exchange(recipient_box)?.as_ref());
    ikm.extend_from_slice(sender.exchange(recipient_box)?.as_ref());
    let okm = key_and_nonce(&ikm, ctx, &e_pub);
    let cipher = Aes256Gcm::new_from_slice(&okm[..32]).expect("a 32-byte key");
    let ct = cipher.encrypt(Nonce::from_slice(&okm[32..44]), Payload { msg: &plaintext, aad: &[] }).map_err(|_| Error::Letter)?;
    let mut out = e_pub.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Seals `text`.
pub fn seal(sender: &X25519, recipient_box: &[u8; 32], ctx: &Context<'_>, text: &Text) -> Result<Vec<u8>> {
    seal_json(sender, recipient_box, ctx, &serde_json::to_vec(text).expect("letter text serializes"), None)
}

/// Opens a letter with the recipient's box key and the sender's box key
/// from the verified roster; returns the exact bytes of `J`.
pub fn open_json(recipient: &X25519, sender_box: &[u8; 32], ctx: &Context<'_>, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if !SIZES.contains(&sealed.len()) {
        return Err(Error::Letter);
    }
    let e_pub: [u8; 32] = sealed[..32].try_into().expect("32 bytes");
    let mut ikm = Zeroizing::new(Vec::with_capacity(64));
    ikm.extend_from_slice(recipient.exchange(&e_pub).map_err(|_| Error::Letter)?.as_ref());
    ikm.extend_from_slice(recipient.exchange(sender_box).map_err(|_| Error::Letter)?.as_ref());
    let okm = key_and_nonce(&ikm, ctx, &e_pub);
    let cipher = Aes256Gcm::new_from_slice(&okm[..32]).expect("a 32-byte key");
    let pt = Zeroizing::new(cipher.decrypt(Nonce::from_slice(&okm[32..44]), Payload { msg: &sealed[32..], aad: &[] }).map_err(|_| Error::Letter)?);
    let len = u16::from_be_bytes([pt[0], pt[1]]) as usize;
    if len + 2 > pt.len() || pt[2 + len..].iter().any(|b| *b != 0) {
        return Err(Error::Letter);
    }
    Ok(Zeroizing::new(pt[2..2 + len].to_vec()))
}

/// Opens a letter and parses `J` (`v` must be 1).
pub fn open(recipient: &X25519, sender_box: &[u8; 32], ctx: &Context<'_>, sealed: &[u8]) -> Result<Text> {
    let json = open_json(recipient, sender_box, ctx, sealed)?;
    let text: Text = serde_json::from_slice(&json).map_err(|_| Error::Letter)?;
    (text.v == 1).then_some(text).ok_or(Error::Letter)
}
