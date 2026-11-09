//! A cloud that answers out of spec: oversized bodies, and ids or nonces
//! that would break `lines(...)` or a URL path. The client returns an
//! error and never panics.

use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use openagentd_cloud::api::{Cloud, MAX_BODY};
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, FlowError, Member};
use openagentd_cloud::keys::DeviceKeys;
use openagentd_cloud::relay::{self, RelayError};
use serde_json::json;

const VALID_ID: &str = "abcdefghijklmnop0123";

fn huge() -> String {
    format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_BODY + 1))
}

/// Serves the hostile cloud; `nonce` is what `/v1/auth/nonce` hands out.
async fn serve(nonce: &'static str) -> String {
    let app = Router::new()
        // Too large, with a Content-Length.
        .route("/v1/device/code", post(|| async { huge() }))
        // Too large, streamed in chunks without one.
        .route(
            "/v1/device/token",
            post(|| async {
                let chunks = (0..20).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![b' '; 64 * 1024])));
                Response::new(Body::from_stream(futures_util::stream::iter(chunks)))
            }),
        )
        .route("/v1/auth/nonce", post(move || async move { Json(json!({ "nonce": nonce, "expires_in": 120 })) }))
        .route("/v1/roster", get(|| async { Json(json!({ "version": 1, "blob": "", "revocation_floor": null })) }))
        .route(
            "/v1/enroll/pending",
            get(|| async {
                let p = |id: &str| json!({ "enrollment_id": id, "device_id": "d", "pubs": "", "auth_pub": null, "commit": null, "n_a": null, "n_a_by": null, "n_n": null, "country": null, "created_at": null, "expires_at": null, "invite_slot": null, "proof": null });
                Json(json!({ "pending": [p("bad\nid"), p("../../v1/roster"), p(VALID_ID)] }))
            })
            .post(|| async { (StatusCode::CREATED, Json(json!({ "enrollment_id": "two\nlines", "expires_at": 0 }))) }),
        )
        .route("/v1/relay/token", post(|| async { Json(json!({ "token": "t", "expires_in": 60, "roster_version": 1 })) }))
        .route("/big", get(|| async { (StatusCode::FORBIDDEN, huge()).into_response() }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn cloud(base: &str, account: Option<&str>) -> Cloud {
    Cloud::new(reqwest::Client::new(), Endpoints::custom(base, "https://account.openagentd.dev"), DeviceKeys::generate(), account.map(String::from))
}

#[tokio::test]
async fn bodies_over_one_mib_are_refused() {
    let base = serve("n1.abc.def").await;
    let c = cloud(&base, None);
    let e = c.device_code().await.unwrap_err();
    assert_eq!(e.code, "bad_response");
    let code = openagentd_cloud::api::DeviceCode {
        device_code: openagentd_cloud::api::Secret::new("d"),
        user_code: "ABCD-EFGH".into(),
        url: String::new(),
        fingerprint: String::new(),
        expires_in: 60,
        interval: 1,
    };
    assert_eq!(c.device_token(&code).await.unwrap_err().code, "bad_response");
    // A refused relay upgrade with a huge error body: refused, code unknown.
    let c = cloud(&base, Some("acct"));
    match relay::open_socket(&c, &relay::http1_client(), "/big").await {
        Err(RelayError::Refused(e)) => assert_eq!((e.status, e.code.as_str(), e.body.is_none()), (403, "unknown", true)),
        other => panic!("expected a refusal, got {:?}", other.err()),
    }
}

#[tokio::test]
async fn a_nonce_with_a_newline_is_an_error_not_a_panic() {
    let base = serve("n1.abc\n.def").await;
    let c = cloud(&base, Some("acct"));
    assert_eq!(c.roster().await.unwrap_err().code, "bad_response");
}

#[tokio::test]
async fn enrollment_ids_that_break_the_id_rule_are_refused() {
    let base = serve("n1.abc.def").await;
    let c = cloud(&base, Some("acct"));
    // Out of the list; never sent back in a path.
    let list = c.pending_list().await.unwrap();
    assert_eq!(list.iter().map(|p| p.enrollment_id.as_str()).collect::<Vec<_>>(), vec![VALID_ID]);
    // Checked before a URL is built: no request goes out.
    for bad in ["bad\nid", "../roster", "", "a/b"] {
        assert_eq!(c.pending(bad).await.unwrap_err().code, "bad_response");
        assert_eq!(c.cancel_pending(bad).await.unwrap_err().code, "bad_response");
        assert_eq!(c.post_n_a(bad, &[0; 32]).await.unwrap_err().code, "bad_response");
    }
    // A joining device given an id with a newline stops with an error.
    let mut m = Member::new(cloud(&base, None), None);
    let session = flows::Session { session: openagentd_cloud::api::Secret::new("s"), account_id: "acct".into() };
    match flows::request_to_join(&mut m, &session).await {
        Err(FlowError::Api(e)) => assert_eq!(e.code, "bad_response"),
        other => panic!("expected bad_response, got {other:?}"),
    }
}
