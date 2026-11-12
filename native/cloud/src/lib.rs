//! OpenAgentd Cloud accounts, client side.
//!
//! The protocol is `appv3/contract/tunnel.md`; this crate reproduces its
//! test vectors (`appv3/contract/tunnel_vectors.json`) byte for byte. The
//! cloud is untrusted: everything a device relies on comes from a roster it
//! verified itself ([`roster::verify`]). The client threat model is
//! `appv3/contract/tunnel-threats.md`.
//!
//! Modules, from the bottom up:
//! - [`encoding`]: strict base64url and the `lines(...)` convention.
//! - [`keys`]: device keys, device ids, fingerprints, `pubs`.
//! - [`recovery`]: the recovery code.
//! - [`roster`]: building, signing, parsing and verifying rosters.
//! - [`code`]: commit-reveal and the 6-digit code.
//! - [`invite`]: invitation links and MACs.
//! - [`letter`]: sealed mailbox letters.
//! - [`noise`]: the Noise IK handshake and transport of relay sessions.
//! - [`account_state`]: what the cloud's account errors mean for a device.
//! - [`relay`]: relay sockets, the send rule, and tunnels.
//! - [`link`]: one self-healing link per computer, on top of [`relay`].

pub mod account_state;
pub mod address_book;
pub mod api;
pub mod approval;
pub mod code;
pub mod direct;
pub mod encoding;
pub mod endpoints;
pub mod flows;
pub mod invite;
pub mod keys;
pub mod letter;
pub mod link;
pub mod mux;
pub mod noise;
pub mod recovery;
pub mod relay;
pub mod roster;
pub mod store;

/// Every way a protocol operation fails. Messages never carry key material.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid encoding")]
    Encoding,
    #[error("invalid key")]
    Key,
    #[error("invalid roster: {0}")]
    Roster(roster::Rule),
    #[error("invalid recovery code")]
    RecoveryCode,
    #[error("invalid invitation")]
    Invite,
    #[error("letter does not open")]
    Letter,
    #[error("letter too long")]
    LetterTooLong,
    #[error("relay handshake failed")]
    Handshake,
    #[error("relay message failed to decrypt")]
    Decrypt,
    #[error("relay message too long")]
    MessageTooLong,
}

pub type Result<T> = std::result::Result<T, Error>;
