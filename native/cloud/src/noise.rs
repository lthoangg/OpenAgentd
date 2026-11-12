//! Relay sessions (spec section 5.1 and 5.2):
//! `Noise_IK_25519_AESGCM_SHA256`, the controller as initiator.

use crate::keys::{is_low_order, Seed};
use crate::{lines, Error, Result};

pub const PROTOCOL: &str = "Noise_IK_25519_AESGCM_SHA256";
/// Largest Noise message.
pub const MAX_MESSAGE: usize = 65_535;
/// Largest plaintext in one transport message.
pub const MAX_PLAINTEXT: usize = MAX_MESSAGE - 16;

/// `lines("agentd-tunnel-v1", account_id, session_id, controller id, host id)`.
pub fn prologue(account_id: &str, session_id: &str, controller_id: &str, host_id: &str) -> Vec<u8> {
    lines!["agentd-tunnel-v1", account_id, session_id, controller_id, host_id]
}

/// `lines("agentd-direct-v1", account_id, host id)`: a direct session's
/// prologue (spec section 5.5). There is no offer, so the controller is
/// known only from its static key in message 1.
pub fn direct_prologue(account_id: &str, host_id: &str) -> Vec<u8> {
    lines!["agentd-direct-v1", account_id, host_id]
}

fn builder<'a>(own_box: &'a Seed, prologue: &'a [u8], ephemeral: Option<&'a Seed>) -> snow::Builder<'a> {
    let b =
        snow::Builder::new(PROTOCOL.parse().expect("a valid Noise pattern")).local_private_key(own_box.expose()).expect("a 32-byte key").prologue(prologue).expect("a prologue");
    match ephemeral {
        Some(e) => b.fixed_ephemeral_key_for_testing_only(e.expose()),
        None => b,
    }
}

/// The transport state after the handshake.
pub struct Transport {
    state: snow::TransportState,
    /// The handshake hash.
    pub handshake_hash: Vec<u8>,
}

impl std::fmt::Debug for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Transport([redacted])")
    }
}

impl Transport {
    /// Encrypts one message (at most [`MAX_PLAINTEXT`] bytes).
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(Error::MessageTooLong);
        }
        let mut out = vec![0u8; plaintext.len() + 16];
        let n = self.state.write_message(plaintext, &mut out).map_err(|_| Error::MessageTooLong)?;
        out.truncate(n);
        Ok(out)
    }

    /// Decrypts one message. Any failure must close the session (4002).
    pub fn decrypt(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        if message.len() > MAX_MESSAGE || message.len() < 16 {
            return Err(Error::Decrypt);
        }
        let mut out = vec![0u8; message.len()];
        let n = self.state.read_message(message, &mut out).map_err(|_| Error::Decrypt)?;
        out.truncate(n);
        Ok(out)
    }
}

fn into_transport(hs: snow::HandshakeState) -> Result<Transport> {
    let handshake_hash = hs.get_handshake_hash().to_vec();
    Ok(Transport { state: hs.into_transport_mode().map_err(|_| Error::Handshake)?, handshake_hash })
}

/// The controller's side.
pub struct Initiator {
    hs: snow::HandshakeState,
}

impl Initiator {
    /// `host_box` comes from the controller's verified roster.
    pub fn new(own_box: &Seed, host_box: &[u8; 32], prologue: &[u8], ephemeral: Option<&Seed>) -> Result<Self> {
        if is_low_order(host_box) {
            return Err(Error::Handshake);
        }
        let hs = builder(own_box, prologue, ephemeral).remote_public_key(host_box).map_err(|_| Error::Handshake)?;
        Ok(Initiator { hs: hs.build_initiator().map_err(|_| Error::Handshake)? })
    }

    /// Message 1, with an empty payload.
    pub fn write_message1(&mut self) -> Result<Vec<u8>> {
        let mut out = vec![0u8; 256];
        let n = self.hs.write_message(&[], &mut out).map_err(|_| Error::Handshake)?;
        out.truncate(n);
        Ok(out)
    }

    /// Reads message 2 (empty payload required) and starts the transport.
    pub fn read_message2(mut self, message: &[u8]) -> Result<Transport> {
        if message.len() != 48 || is_low_order(message[..32].try_into().expect("32 bytes")) {
            return Err(Error::Handshake);
        }
        let mut out = vec![0u8; message.len()];
        let n = self.hs.read_message(message, &mut out).map_err(|_| Error::Handshake)?;
        if n != 0 {
            return Err(Error::Handshake);
        }
        into_transport(self.hs)
    }
}

/// The host's side.
pub struct Responder {
    hs: snow::HandshakeState,
}

impl Responder {
    pub fn new(own_box: &Seed, prologue: &[u8], ephemeral: Option<&Seed>) -> Result<Self> {
        Ok(Responder { hs: builder(own_box, prologue, ephemeral).build_responder().map_err(|_| Error::Handshake)? })
    }

    /// Reads message 1 and returns the initiator's static key. The caller
    /// must check it is the `box` key its own roster lists for the offer's
    /// device before writing message 2.
    pub fn read_message1(&mut self, message: &[u8]) -> Result<[u8; 32]> {
        // e (32) + encrypted s (48) + encrypted empty payload (16).
        if message.len() != 96 || is_low_order(message[..32].try_into().expect("32 bytes")) {
            return Err(Error::Handshake);
        }
        let mut out = vec![0u8; message.len()];
        let n = self.hs.read_message(message, &mut out).map_err(|_| Error::Handshake)?;
        if n != 0 {
            return Err(Error::Handshake);
        }
        let rs: [u8; 32] = self.hs.get_remote_static().ok_or(Error::Handshake)?.try_into().map_err(|_| Error::Handshake)?;
        if is_low_order(&rs) {
            return Err(Error::Handshake);
        }
        Ok(rs)
    }

    /// Message 2, with an empty payload, and the transport.
    pub fn write_message2(mut self) -> Result<(Vec<u8>, Transport)> {
        let mut out = vec![0u8; 256];
        let n = self.hs.write_message(&[], &mut out).map_err(|_| Error::Handshake)?;
        out.truncate(n);
        Ok((out, into_transport(self.hs)?))
    }
}
