//! How fast a relay session is, and how many relay messages the app's
//! usual flows cost, through the fake relay behind a proxy that adds a
//! round trip like Vietnam to Cloudflare in Singapore (63 ms) to every
//! connection, phone and computer alike. Run by hand:
//!
//! ```text
//! cargo test --test speed -- --ignored --nocapture --test-threads 1
//! ```
//!
//! `SPEED_RTT_MS` changes the round trip, `SPEED_REPLY_SECS` (default 60)
//! the length of the streamed reply, `SPEED_TOKEN_MS` (default 200) the
//! relay token's own server time.

mod fake_cloud;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fake_cloud::Fake;
use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, GenesisDraft, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};
use openagentd_cloud::mux::Stream;
use openagentd_cloud::relay::{self, HostHandler, Join, Sessions, Tunnel};
use openagentd_cloud::roster::Roster;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const FAST: Pace = Pace { every: Duration::from_millis(20), timeout: Duration::from_secs(10) };

fn env_ms(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn cloud(base: &str) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), None)
}

fn cloud_via(member: &Member, base: &str) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), member.cloud.keys.clone(), member.cloud.account_id.clone())
}

async fn sign_in(fake: &Fake, c: &Cloud, account: &str) -> flows::Session {
    let code = c.device_code().await.unwrap();
    fake.approve(&code.user_code, account);
    flows::wait_for_session(c, &code).await.unwrap()
}

async fn account(fake: &Fake, base: &str) -> (Member, Member) {
    let account = fake.new_account();
    let mut phone = Member::new(cloud(base), None);
    phone.cloud.roles = Roles::CLIENT;
    let s = sign_in(fake, &phone.cloud, &account).await;
    flows::genesis(&mut phone, &s, GenesisDraft::new()).await.unwrap();
    let mut server = Member::new(cloud(base), None);
    server.cloud.roles = Roles::SERVER;
    let s = sign_in(fake, &server.cloud, &account).await;
    let req = flows::request_to_join(&mut server, &s).await.unwrap();
    let p = phone.cloud.pending_list().await.unwrap().remove(0);
    let mut a = flows::begin_approval(&mut phone, p).await.unwrap();
    let jc = flows::await_signer(&mut server, &req, FAST).await.unwrap();
    flows::await_reveal(&mut phone, &mut a, FAST).await.unwrap();
    let (r1, r2) = tokio::join!(flows::confirm_approval(&mut phone, a, flows::Grant { signer: false, roles: Roles::SERVER }), flows::await_added(&mut server, jc, &req, FAST));
    r1.unwrap();
    r2.unwrap();
    (phone, server)
}

/// A stand-in computer. A stream's request is one line:
/// `E <bytes>` answers that many bytes at once; `S <count> <every_ms>
/// <bytes>` writes `count` chunks of `bytes`, one every `every_ms`, like an
/// event stream.
struct Bench {
    roster: Mutex<Roster>,
    me: String,
}

impl HostHandler for Bench {
    fn controller_box(&self, id: &str) -> Option<[u8; 32]> {
        (id != self.me).then(|| self.roster.lock().unwrap().body.client(id).map(|d| d.box_key())).flatten()
    }
    fn serve(&self, mut stream: Stream, _from: String) {
        tokio::spawn(async move {
            let mut got = Vec::new();
            let _ = stream.read_to_end(&mut got).await;
            let text = String::from_utf8_lossy(&got);
            let line = text.lines().next().unwrap_or_default().to_string();
            let words: Vec<u64> = line.split_whitespace().skip(1).filter_map(|w| w.parse().ok()).collect();
            match (line.chars().next(), words.as_slice()) {
                (Some('E'), [n]) => {
                    let _ = stream.write_all(&vec![b'a'; *n as usize]).await;
                }
                (Some('S'), [count, every, n]) => {
                    for _ in 0..*count {
                        if stream.write_all(&vec![b'e'; *n as usize]).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(*every)).await;
                    }
                }
                _ => {}
            }
            let _ = stream.shutdown().await;
        });
    }
    fn on_roster(&self, _: u64, _: Vec<String>) {}
}

async fn ask(tunnel: &Tunnel, line: &str, body: usize) -> usize {
    let mut s = tunnel.session.open().unwrap();
    let mut req = format!("{line}\n").into_bytes();
    req.extend(vec![b'q'; body]);
    s.write_all(&req).await.unwrap();
    s.shutdown().await.unwrap();
    let mut back = Vec::new();
    s.read_to_end(&mut back).await.unwrap_or_else(|e| panic!("{line}: {e} {:?}", *tunnel.ended.borrow()));
    back.len()
}

/// Binary relay messages sent so far: (controller, host).
fn sent(fake: &Fake) -> (usize, usize) {
    let r = fake.1.lock().unwrap();
    (r.controller_frames.len(), r.host_frames.len())
}

fn since(fake: &Fake, before: (usize, usize)) -> String {
    let now = sent(fake);
    let (c, h) = (now.0 - before.0, now.1 - before.1);
    format!("{} (phone {c}, computer {h})", c + h)
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a measurement, run by hand"]
async fn speed() {
    let rtt = Duration::from_millis(env_ms("SPEED_RTT_MS", 63));
    let reply = Duration::from_secs(env_ms("SPEED_REPLY_SECS", 60));
    let fake = Fake::new();
    let base = fake.serve().await;
    let (phone, server) = account(&fake, &base).await;
    fake.0.lock().unwrap().relay_token_delay = Some(Duration::from_millis(env_ms("SPEED_TOKEN_MS", 200)));
    let via = fake_cloud::proxy::with_latency(&base, rtt / 2).await;

    let handler = Arc::new(Bench { roster: Mutex::new(server.roster.clone().unwrap()), me: server.cloud.device_id() });
    let (_stop, stop_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(relay::host(Arc::new(cloud_via(&server, &via)), relay::http1_client(), handler, Sessions::default(), Join::default(), stop_rx));
    tokio::time::sleep(Duration::from_millis(500)).await;

    let host_id = server.cloud.device_id();
    let host_box = phone.box_of(&host_id).unwrap();
    let tokens_before = fake.0.lock().unwrap().relay_tokens_issued;
    let phone_cloud = cloud_via(&phone, &via);
    let http1 = relay::http1_client();

    // Open a session (a fresh app: no nonce, no token), then its first answer.
    let before = sent(&fake);
    let t = Instant::now();
    let tunnel = relay::connect(&phone_cloud, &http1, &host_id, &host_box, Join::default()).await.unwrap();
    let opened = t.elapsed();
    ask(&tunnel, "E 100", 0).await;
    let first = t.elapsed();
    let open_msgs = since(&fake, before);

    // A second session from the same app (a reconnect).
    let t = Instant::now();
    let again = relay::connect(&phone_cloud, &http1, &host_id, &host_box, Join::default()).await.unwrap();
    let reopened = t.elapsed();
    again.end(1000);
    drop(again);

    // Open the app: eight requests at once.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = sent(&fake);
    let t = Instant::now();
    let mut all = Vec::new();
    for _ in 0..8 {
        all.push(ask(&tunnel, "E 2048", 300));
    }
    futures_util::future::join_all(all).await;
    let app_time = t.elapsed();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let app_msgs = since(&fake, before);

    // A small request, 100 times in a row.
    let mut rtts = Vec::new();
    for _ in 0..100 {
        let t = Instant::now();
        ask(&tunnel, "E 300", 200).await;
        rtts.push(t.elapsed());
    }
    rtts.sort();

    // Send a message: the POST, and five events on the open event stream.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = sent(&fake);
    let (_, _) = tokio::join!(ask(&tunnel, "E 200", 1000), ask(&tunnel, "S 5 10 150", 0));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let send_msgs = since(&fake, before);

    // A streamed reply as the server sends one stream: it joins a stream's
    // deltas for up to `DELTA_FLUSH_WINDOW` (50 ms, appv3/crates/agent/src/
    // stream_store.rs) before fan-out, so with the wait for the next provider
    // chunk one reply reaches the connector as an event every 50 to 60 ms.
    let before = sent(&fake);
    let count = reply.as_millis() as u64 / 60;
    ask(&tunnel, &format!("S {count} 60 200"), 0).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let one_stream_msgs = since(&fake, before);

    // Two streams at once (a reply and a tool's output, or two agents): an
    // event of 200 bytes every 40 ms.
    let before = sent(&fake);
    let count = reply.as_millis() as u64 / 40;
    ask(&tunnel, &format!("S {count} 40 200"), 0).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let two_streams_msgs = since(&fake, before);
    let tokens = fake.0.lock().unwrap().relay_tokens_issued - tokens_before;

    let ms = |d: Duration| format!("{:.0} ms", d.as_secs_f64() * 1000.0);
    println!("round trip to the relay: {}", ms(rtt));
    println!("open a session (fresh app): {} to open, {} to the first answer", ms(opened), ms(first));
    println!("open a second session: {}", ms(reopened));
    println!("small request x100: median {}, p95 {}", ms(percentile(&rtts, 0.5)), ms(percentile(&rtts, 0.95)));
    println!("open the app (8 requests at once): {} in {}", app_msgs, ms(app_time));
    println!("relay messages, open a session: {open_msgs}");
    println!("relay messages, send a message: {send_msgs}");
    println!("relay messages, streamed reply of {} s, one stream (an event every 60 ms): {one_stream_msgs}", reply.as_secs());
    println!("relay messages, streamed reply of {} s, two streams at once (an event every 40 ms): {two_streams_msgs}", reply.as_secs());
    println!("relay tokens fetched while the phone opened two sessions (phone and computer): {tokens}");
}
