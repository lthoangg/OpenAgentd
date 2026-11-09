//! Every case of `appv3/contract/tunnel_vectors.json`, byte for byte.

use openagentd_cloud::code::{self, CodeInput, Joiner, Signer};
use openagentd_cloud::encoding::{b64, from_b64, from_b64_array};
use openagentd_cloud::invite::{self, Candidate, Confirmation};
use openagentd_cloud::keys::{device_id, fingerprint, parse_pubs, pubs_bytes, Ed25519, Roles, Seed, X25519};
use openagentd_cloud::letter::{self, Context, Kind};
use openagentd_cloud::noise::{self, Initiator, Responder};
use openagentd_cloud::recovery;
use openagentd_cloud::roster::{self, Chain, Roster};
use openagentd_cloud::Error;
use serde_json::Value;
use std::collections::HashMap;

const VECTORS: &str = include_str!("../../../appv3/contract/tunnel_vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} is a string"))
}

fn seed(v: &Value, key: &str) -> Seed {
    Seed::from_b64(s(v, key)).unwrap()
}

fn arr32(v: &Value, key: &str) -> [u8; 32] {
    from_b64_array(s(v, key)).unwrap()
}

/// The seeds of the named devices, by device id.
fn device_seeds(v: &Value) -> HashMap<String, (Seed, Seed, Seed)> {
    v["devices"].as_object().unwrap().values().map(|d| (s(d, "id").to_string(), (seed(d, "auth"), seed(d, "box"), seed(d, "sign")))).collect()
}

#[test]
fn device_ids_and_fingerprints() {
    let v = vectors();
    let cases = v["device_id"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let auth = Ed25519::from_seed(seed(c, "auth_seed"));
        assert_eq!(b64(&auth.public()), s(c, "auth_pub"));
        assert_eq!(device_id(&auth.public()), s(c, "device_id"));
        assert_eq!(fingerprint(s(c, "device_id")).unwrap(), s(c, "fingerprint"));
    }
}

#[test]
fn recovery_codes() {
    let v = vectors();
    for c in v["recovery_code"].as_array().unwrap() {
        let sd = seed(c, "seed");
        assert_eq!(b64(&Ed25519::from_seed(sd.clone()).public()), s(c, "pub"));
        assert_eq!(recovery::encode(&sd).as_str(), s(c, "code"));
        assert_eq!(recovery::decode(s(c, "code")).unwrap(), sd);
        assert_eq!(recovery::decode(&s(c, "code").to_lowercase().replace('-', "  ")).unwrap(), sd);
    }
}

#[test]
fn pubs() {
    let v = vectors();
    for c in v["pubs"].as_array().unwrap() {
        let bx = X25519::from_seed(seed(c, "box_seed"));
        let sg = Ed25519::from_seed(seed(c, "sign_seed"));
        assert_eq!(b64(&bx.public()), s(c, "box_pub"));
        assert_eq!(b64(&sg.public()), s(c, "sign_pub"));
        let roles = Roles { server: c["server"].as_bool().unwrap(), client: c["client"].as_bool().unwrap() };
        let bytes = pubs_bytes(&bx.public(), &sg.public(), roles);
        assert_eq!(String::from_utf8(bytes.clone()).unwrap(), s(c, "json"));
        assert_eq!(b64(&bytes), s(c, "pubs"));
        let parsed = parse_pubs(&bytes).unwrap();
        assert_eq!(parsed.r#box, bx.public());
        assert_eq!(parsed.roles, roles);
    }
}

fn rule_of(name: &str) -> roster::Rule {
    use roster::Rule::*;
    match name {
        "format" => Format,
        "account" => Account,
        "version" => Version,
        "recovery_pub" => RecoveryPub,
        "devices" => Devices,
        "signature" => Signature,
        "untrusted_signer" => UntrustedSigner,
        "prev" => Prev,
        "keys" => Keys,
        "genesis" => Genesis,
        other => panic!("unknown rule {other}"),
    }
}

#[test]
fn rosters_valid_and_invalid() {
    let v = vectors();
    let account = s(&v, "account_id");
    let mut accepted: HashMap<String, Roster> = HashMap::new();
    let cases = v["roster"].as_array().unwrap();
    assert_eq!(cases.len(), 30);
    // Roles (rule 1 types, rule 4 at least one): each case breaks the rule named.
    for (name, rule) in [("no_role", "devices"), ("body_v1", "format"), ("roles_missing", "format"), ("role_not_boolean", "format")] {
        let c = cases.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("vector {name}"));
        assert_eq!(c.get("rule").and_then(|r| r.as_str()), Some(rule), "{name}");
    }
    // Rule 4's bound: ten devices pass, eleven break it.
    for (name, rule) in [("ten_devices", None), ("eleven_devices", Some("devices"))] {
        let c = cases.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("vector {name}"));
        assert_eq!(c.get("rule").and_then(|r| r.as_str()), rule, "{name}");
    }
    let mut rejected = 0;
    for c in cases {
        let name = s(c, "name");
        let known = c["known"].as_str().map(|k| accepted.get(k).unwrap_or_else(|| panic!("{name}: known {k} first")));
        let chain = if c["chain"].as_bool().unwrap() { Chain::Linked } else { Chain::Skip };
        let result = roster::verify(s(c, "blob"), account, known, chain);
        match c.get("rule").and_then(|r| r.as_str()) {
            Some(rule) => {
                assert_eq!(result.err(), Some(Error::Roster(rule_of(rule))), "{name} breaks {rule}");
                rejected += 1;
            }
            None => {
                let r = result.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(String::from_utf8(r.envelope.clone()).unwrap(), s(c, "envelope"), "{name}");
                assert_eq!(serde_json::to_string(&r.body).unwrap(), s(c, "body"), "{name}: body bytes");
                assert_eq!(r.hash, s(c, "hash"), "{name}");
                assert_eq!(r.by, s(c, "by"), "{name}");
                accepted.insert(name.to_string(), r);
            }
        }
    }
    assert_eq!(rejected, 23);
}

/// Signing the valid bodies again with the vector keys gives the same
/// envelopes: our writer produces the reference's bytes.
#[test]
fn rosters_sign_to_the_same_bytes() {
    let v = vectors();
    let account = s(&v, "account_id");
    let seeds = device_seeds(&v);
    let recovery_seed = seed(&v["recovery_code"][0], "seed");
    let mut accepted: HashMap<String, Roster> = HashMap::new();
    for c in v["roster"].as_array().unwrap() {
        if c.get("rule").is_some() {
            continue;
        }
        let known = c["known"].as_str().map(|k| &accepted[k]);
        let chain = if c["chain"].as_bool().unwrap() { Chain::Linked } else { Chain::Skip };
        let r = roster::verify(s(c, "blob"), account, known, chain).unwrap();
        let key = if r.by == roster::RECOVERY { Ed25519::from_seed(recovery_seed.clone()) } else { Ed25519::from_seed(seeds[&r.by].2.clone()) };
        let again = roster::sign(&r.body, &r.by, &key);
        assert_eq!(again.blob, s(c, "blob"), "{}", s(c, "name"));
        accepted.insert(s(c, "name").to_string(), r);
    }
}

#[test]
fn commit_and_six_digit_code_from_both_sides() {
    let v = vectors();
    let seeds = device_seeds(&v);
    for c in v["code"].as_array().unwrap() {
        let pubs = from_b64(s(&c["n"], "pubs")).unwrap();
        let n_a = from_b64(s(c, "n_a")).unwrap();
        let n_n = from_b64(s(c, "n_n")).unwrap();
        assert_eq!(b64(&code::commit(&pubs, &n_n)), s(c, "commit"));
        assert!(code::commit_matches(&from_b64(s(c, "commit")).unwrap(), &pubs, &n_n));
        assert!(!code::commit_matches(&from_b64(s(c, "commit")).unwrap(), &pubs, &n_a));
        let n_id = s(&c["n"], "id");
        let a_id = s(&c["a"], "id");
        let input = CodeInput {
            account_id: s(c, "account_id"),
            enrollment_id: s(c, "enrollment_id"),
            a: Signer { id: a_id, r#box: arr32(&c["a"], "box"), sign: arr32(&c["a"], "sign") },
            n: Joiner { id: n_id, pubs: &pubs, r#box: parse_pubs(&pubs).unwrap().r#box },
            n_a: &n_a,
            n_n: &n_n,
        };
        let a_box = X25519::from_seed(seeds[a_id].1.clone());
        let n_box = X25519::from_seed(seeds[n_id].1.clone());
        assert_eq!(code::six_digit_code(&a_box, &input).unwrap(), s(c, "code"), "A's side");
        assert_eq!(code::six_digit_code(&n_box, &input).unwrap(), s(c, "code"), "N's side");
    }
}

#[test]
fn invitations() {
    let v = vectors();
    for c in v["invite"].as_array().unwrap() {
        let secret = from_b64(s(c, "secret")).unwrap();
        let link = invite::link(s(c, "account_id"), s(c, "slot_id"), &secret);
        assert_eq!(link.as_str(), s(c, "link"));
        let parsed = invite::parse_link(&link).unwrap();
        assert_eq!(parsed.slot_id, s(c, "slot_id"));
        assert_eq!(parsed.secret.as_slice(), secret.as_slice());
        let auth_pub = arr32(c, "auth_pub");
        let pubs = from_b64(s(c, "pubs")).unwrap();
        let cand = Candidate { account_id: s(c, "account_id"), slot_id: s(c, "slot_id"), device_id: s(c, "device_id"), auth_pub: &auth_pub, pubs: &pubs };
        assert_eq!(b64(&invite::candidate_proof(&secret, &cand)), s(c, "proof"));
        assert!(invite::proof_matches(&secret, &cand, &from_b64(s(c, "proof")).unwrap()));
        let conf = Confirmation {
            account_id: s(c, "account_id"),
            slot_id: s(c, "slot_id"),
            device_id: s(c, "device_id"),
            version: c["version"].as_u64().unwrap(),
            roster_hash: s(c, "roster_hash"),
        };
        assert_eq!(b64(&invite::signer_confirm(&secret, &conf)), s(c, "confirm"));
        assert!(invite::confirm_matches(&secret, &conf, &from_b64(s(c, "confirm")).unwrap()));
        // The roster it names is the one the vectors call by that name.
        let named = v["roster"].as_array().unwrap().iter().find(|r| r["name"] == c["roster"]).unwrap();
        assert_eq!(s(named, "hash"), s(c, "roster_hash"));
    }
}

#[test]
fn noise_handshake_and_transport() {
    let v = vectors();
    for c in v["noise"].as_array().unwrap() {
        assert_eq!(s(c, "protocol"), noise::PROTOCOL);
        let ctl = &c["controller"];
        let host = &c["host"];
        let prologue = noise::prologue(s(c, "account_id"), s(c, "session_id"), s(ctl, "id"), s(host, "id"));
        assert_eq!(String::from_utf8(prologue.clone()).unwrap(), s(c, "prologue"));
        let host_box = X25519::from_seed(seed(host, "static_seed")).public();
        let ctl_box = X25519::from_seed(seed(ctl, "static_seed")).public();
        let (ce, he) = (seed(ctl, "ephemeral_seed"), seed(host, "ephemeral_seed"));
        let mut init = Initiator::new(&seed(ctl, "static_seed"), &host_box, &prologue, Some(&ce)).unwrap();
        let m1 = init.write_message1().unwrap();
        assert_eq!(b64(&m1), s(c, "message1"));
        let mut resp = Responder::new(&seed(host, "static_seed"), &prologue, Some(&he)).unwrap();
        assert_eq!(resp.read_message1(&m1).unwrap(), ctl_box);
        let (m2, mut host_t) = resp.write_message2().unwrap();
        assert_eq!(b64(&m2), s(c, "message2"));
        let mut ctl_t = init.read_message2(&m2).unwrap();
        assert_eq!(b64(&ctl_t.handshake_hash), s(c, "handshake_hash"));
        assert_eq!(b64(&host_t.handshake_hash), s(c, "handshake_hash"));
        for t in c["transport"].as_array().unwrap() {
            let plain = s(t, "plaintext").as_bytes();
            let (send, recv) = if s(t, "from") == "controller" { (&mut ctl_t, &mut host_t) } else { (&mut host_t, &mut ctl_t) };
            let msg = send.encrypt(plain).unwrap();
            assert_eq!(b64(&msg), s(t, "message"));
            assert_eq!(recv.decrypt(&msg).unwrap(), plain);
        }
        // A different prologue (another session) does not handshake.
        let other = noise::prologue(s(c, "account_id"), "another-session-id", s(ctl, "id"), s(host, "id"));
        let mut r2 = Responder::new(&seed(host, "static_seed"), &other, Some(&he)).unwrap();
        assert!(r2.read_message1(&m1).is_err());
    }
}

#[test]
fn letters_at_every_size() {
    let v = vectors();
    let seeds = device_seeds(&v);
    let mut sizes = Vec::new();
    for c in v["letter"].as_array().unwrap() {
        let from = s(c, "from");
        let to = s(c, "to");
        let sender = X25519::from_seed(seeds[from].1.clone());
        let recipient = X25519::from_seed(seeds[to].1.clone());
        let ctx = Context { account_id: s(c, "account_id"), sender_id: from, recipient_id: to, kind: Kind::parse(s(c, "kind")).unwrap() };
        let sealed = letter::seal_json(&sender, &recipient.public(), &ctx, s(c, "json").as_bytes(), Some(seed(c, "ephemeral_seed"))).unwrap();
        assert_eq!(sealed.len() as u64, c["size"].as_u64().unwrap());
        assert_eq!(b64(&sealed), s(c, "sealed"));
        let opened = letter::open_json(&recipient, &sender.public(), &ctx, &sealed).unwrap();
        assert_eq!(opened.as_slice(), s(c, "json").as_bytes());
        assert!(letter::open(&recipient, &sender.public(), &ctx, &sealed).is_ok());
        // Another kind, another sender, or one flipped bit: it does not open.
        let other_kind = Context { kind: if ctx.kind == Kind::Done { Kind::Failed } else { Kind::Done }, ..ctx };
        assert!(letter::open_json(&recipient, &sender.public(), &other_kind, &sealed).is_err());
        assert!(letter::open_json(&recipient, &recipient.public(), &ctx, &sealed).is_err());
        let mut flipped = sealed.clone();
        flipped[40] ^= 1;
        assert!(letter::open_json(&recipient, &sender.public(), &ctx, &flipped).is_err());
        sizes.push(sealed.len());
    }
    sizes.sort();
    assert_eq!(sizes, vec![256, 512, 1024, 2048]);
}
