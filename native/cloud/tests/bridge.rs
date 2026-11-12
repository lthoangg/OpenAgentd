//! The loopback bridge across an app's suspension (fault 1 of the 3.53.1
//! brief): iOS may take a listening socket while the app is suspended, and
//! may not say so. The bridge can listen again on the same origin with the
//! same key, can tell whether it still answers, and never spins on a
//! listener that keeps failing.
#![cfg(feature = "bridge")]

use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use openagentd_cloud::bridge::{Bridge, Io, Opener};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn app_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
}

/// A stand-in computer that answers `ok`, and counts the streams opened
/// into the tunnel.
fn computer(opened: Arc<AtomicUsize>) -> Opener {
    Arc::new(move || {
        opened.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            let (here, there) = tokio::io::duplex(64 * 1024);
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(|_req: Request<hyper::body::Incoming>| async { Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok")))) });
                let _ = hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(there), svc).await;
            });
            Ok(Box::new(here) as Box<dyn Io>)
        })
    })
}

/// A request with `key`; `None` when no answer came within `within`.
async fn get(origin: &str, key: &str, within: Duration) -> Option<String> {
    let addr = origin.trim_start_matches("http://").to_string();
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: tauri://localhost\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n");
    let exchange = async move {
        let mut tcp = tokio::net::TcpStream::connect(addr).await.ok()?;
        tcp.write_all(req.as_bytes()).await.ok()?;
        let mut out = Vec::new();
        tcp.read_to_end(&mut out).await.ok()?;
        Some(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(within, exchange).await.ok().flatten().filter(|s| !s.is_empty())
}

#[tokio::test]
async fn a_bridge_whose_listener_stopped_answers_again_on_the_same_origin_with_the_same_key() {
    let opened = Arc::new(AtomicUsize::new(0));
    let mut b = Bridge::start(computer(opened.clone()), app_origin).await.unwrap();
    let (origin, key) = (b.origin.clone(), b.key().to_string());
    let first = get(&origin, &key, Duration::from_secs(5)).await.expect("an answer");
    assert!(first.starts_with("HTTP/1.1 200"), "{first}");
    // The system takes the listener underneath the bridge: the port still
    // accepts in the kernel, but nobody reads.
    b.stall_for_test();
    assert_eq!(get(&origin, &key, Duration::from_millis(500)).await, None, "a stalled listener answers nothing");
    let moved = b.listen_again().await.unwrap();
    assert!(!moved, "the same port");
    assert_eq!(b.origin, origin);
    assert_eq!(b.key(), key);
    let again = get(&origin, &key, Duration::from_secs(5)).await.expect("an answer after listening again");
    assert!(again.starts_with("HTTP/1.1 200"), "{again}");
}

#[tokio::test]
async fn the_self_check_tells_a_dead_listener_from_a_live_one_without_using_the_tunnel() {
    let opened = Arc::new(AtomicUsize::new(0));
    let mut b = Bridge::start(computer(opened.clone()), app_origin).await.unwrap();
    assert!(b.check(Duration::from_millis(300)).await, "a live bridge answers");
    b.stall_for_test();
    assert!(!b.check(Duration::from_millis(300)).await, "a stalled bridge does not");
    b.listen_again().await.unwrap();
    assert!(b.check(Duration::from_millis(300)).await);
    // Paused for the background: not answering, until it listens again.
    b.pause().await;
    assert!(!b.check(Duration::from_millis(300)).await);
    b.listen_again().await.unwrap();
    assert!(b.check(Duration::from_millis(300)).await);
    assert_eq!(opened.load(Ordering::SeqCst), 0, "a check never enters the tunnel");
}

#[tokio::test]
async fn accept_errors_in_a_row_do_not_spin() {
    let opened = Arc::new(AtomicUsize::new(0));
    let b = Bridge::start(computer(opened), app_origin).await.unwrap();
    let key = b.key().to_string();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let before = b.accepts_for_test();
    b.fail_accepts_for_test(usize::MAX);
    // Wake the accept loop so the faults start now.
    let _ = tokio::net::TcpStream::connect(b.origin.trim_start_matches("http://")).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let tries = b.accepts_for_test() - before;
    assert!(tries <= 10, "{tries} accepts in a second");
    // Once the faults stop, it serves again (after its current wait; a
    // connection queued on a listener it then replaced is refused, so the
    // page's retry is what gets the answer).
    b.fail_accepts_for_test(0);
    let mut back = None;
    for _ in 0..5 {
        back = get(&b.origin, &key, Duration::from_secs(2)).await;
        if back.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let back = back.expect("an answer once accept works again");
    assert!(back.starts_with("HTTP/1.1 200"), "{back}");
}
