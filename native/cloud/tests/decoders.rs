//! Property tests: decoders never panic, and a changed roster never verifies.

use openagentd_cloud::encoding::{b64, from_b64};
use openagentd_cloud::keys::{parse_pubs, Seed, X25519};
use openagentd_cloud::letter::{self, Context, Kind};
use openagentd_cloud::noise::Responder;
use openagentd_cloud::roster::{self, Chain};
use openagentd_cloud::{invite, recovery};
use proptest::prelude::*;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../appv3/contract/tunnel_vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn roster_case(name: &str) -> (String, String) {
    let v = vectors();
    let c = v["roster"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
    (c["blob"].as_str().unwrap().to_string(), v["account_id"].as_str().unwrap().to_string())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn decoders_never_panic(text in ".{0,200}", bytes in proptest::collection::vec(any::<u8>(), 0..400)) {
        let _ = from_b64(&text);
        let _ = roster::parse(&text);
        let _ = roster::parse(&b64(&bytes));
        let _ = parse_pubs(&bytes);
        let _ = recovery::decode(&text);
        let _ = invite::parse_link(&text);
        let me = X25519::from_seed(Seed::from_bytes([4; 32]));
        let ctx = Context { account_id: "a", sender_id: "s", recipient_id: "r", kind: Kind::Done };
        let _ = letter::open_json(&me, &[9; 32], &ctx, &bytes);
        let mut r = Responder::new(&Seed::from_bytes([5; 32]), b"p", None).unwrap();
        let _ = r.read_message1(&bytes);
    }

    /// Flipping any bit of the genesis envelope, or of any valid roster
    /// after its known roster, leaves nothing that verifies with changed
    /// bytes.
    #[test]
    fn a_changed_genesis_never_verifies(at in any::<prop::sample::Index>(), bit in 0u8..8) {
        let (blob, account) = roster_case("genesis");
        let mut env = from_b64(&blob).unwrap();
        let i = at.index(env.len());
        env[i] ^= 1 << bit;
        prop_assert!(roster::verify(&b64(&env), &account, None, Chain::Linked).is_err());
    }

    #[test]
    fn a_changed_add_never_verifies(at in any::<prop::sample::Index>(), bit in 0u8..8) {
        let (genesis, account) = roster_case("genesis");
        let known = roster::verify(&genesis, &account, None, Chain::Linked).unwrap();
        let (blob, _) = roster_case("add_member");
        let mut env = from_b64(&blob).unwrap();
        let i = at.index(env.len());
        env[i] ^= 1 << bit;
        prop_assert!(roster::verify(&b64(&env), &account, Some(&known), Chain::Linked).is_err());
    }
}
