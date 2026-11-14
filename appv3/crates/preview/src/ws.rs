//! WebSocket passthrough, mostly for dev-server hot reload (Vite's
//! `vite-hmr`, Next.js `/_next/webpack-hmr`).
//!
//! An `https` dev server speaks `wss`, nearly always behind a certificate
//! no authority signed. Its certificate is accepted as it is, as the page
//! requests in `proxy.rs` accept it: a target is a loopback address only
//! (`target.rs`), so there is no network path on which to impersonate it.

use crate::manager::Entry;
use crate::proxy::plain;
use crate::target::UrlTarget;
use axum::extract::ws::{CloseFrame as ACloseFrame, Message as AMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;
use tokio_rustls::rustls;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as TCloseFrame;
use tokio_tungstenite::tungstenite::Message as TMsg;
use tokio_tungstenite::WebSocketStream;

/// The dev server's side of the socket: plain TCP, or TLS over it.
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

type Upstream = WebSocketStream<Box<dyn Io>>;

/// Accepts whatever certificate a loopback dev server presents; handshake
/// signatures are still checked, so the peer holds that certificate's key.
#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn tls() -> Option<tokio_rustls::TlsConnector> {
    static TLS: std::sync::OnceLock<Option<tokio_rustls::TlsConnector>> = std::sync::OnceLock::new();
    TLS.get_or_init(|| {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .ok()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
            .with_no_client_auth();
        // A WebSocket upgrade is HTTP/1.1; a server that also offers h2 must not pick it.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Some(tokio_rustls::TlsConnector::from(Arc::new(config)))
    })
    .clone()
}

/// The name sent in the TLS handshake: `localhost`, or the loopback address.
fn server_name(target: &UrlTarget) -> Option<rustls::pki_types::ServerName<'static>> {
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    rustls::pki_types::ServerName::try_from(host.to_string()).ok()
}

/// A byte stream to the dev server, with TLS when it serves `https`.
async fn connect(target: &UrlTarget) -> Result<Box<dyn Io>, String> {
    let tcp = tokio::net::TcpStream::connect(target.authority()).await.map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    if target.scheme != "https" {
        return Ok(Box::new(tcp));
    }
    let (Some(tls), Some(name)) = (tls(), server_name(target)) else { return Err("TLS is unavailable".to_string()) };
    Ok(Box::new(tls.connect(name, tcp).await.map_err(|e| e.to_string())?))
}

pub(crate) async fn proxy(entry: Arc<Entry>, target: &UrlTarget, req: Request) -> Response {
    let (mut parts, _body) = req.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    let path = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("{}://{}{}", if target.scheme == "https" { "wss" } else { "ws" }, target.authority(), path);
    let mut up_req = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("Invalid upstream WebSocket URL: {e}")),
    };
    let h = up_req.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&target.origin()) {
        h.insert(header::ORIGIN, v);
    }
    for name in [header::SEC_WEBSOCKET_PROTOCOL, header::COOKIE, header::USER_AGENT] {
        if let Some(v) = parts.headers.get(&name) {
            h.insert(name, v.clone());
        }
    }
    let opened = match connect(target).await {
        Ok(io) => tokio_tungstenite::client_async(up_req, io).await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    let (upstream, resp) = match opened {
        Ok(pair) => pair,
        Err(e) => {
            if let Some(skipped) = crate::log_throttle::upstream_error(&target.authority()) {
                tracing::debug!("preview_ws_upstream_error url={} err={} skipped_since_last={}", url, e, skipped);
            }
            return plain(StatusCode::BAD_GATEWAY, &format!("Could not open a WebSocket to {}.", target.authority()));
        }
    };
    let upgrade = match resp.headers().get(header::SEC_WEBSOCKET_PROTOCOL).and_then(|v| v.to_str().ok()) {
        Some(p) => upgrade.protocols([p.to_string()]),
        None => upgrade,
    };
    let guard = entry.begin();
    let stop = entry.stop_rx();
    upgrade.on_upgrade(move |client| async move {
        let _guard = guard;
        pump(client, upstream, stop).await;
    })
}

fn to_upstream(m: AMsg) -> TMsg {
    match m {
        AMsg::Text(t) => TMsg::text(t.as_str().to_owned()),
        AMsg::Binary(b) => TMsg::Binary(b),
        AMsg::Ping(b) => TMsg::Ping(b),
        AMsg::Pong(b) => TMsg::Pong(b),
        AMsg::Close(f) => TMsg::Close(f.map(|f| TCloseFrame { code: f.code.into(), reason: f.reason.as_str().to_owned().into() })),
    }
}

fn to_client(m: TMsg) -> Option<AMsg> {
    Some(match m {
        TMsg::Text(t) => AMsg::Text(t.as_str().to_owned().into()),
        TMsg::Binary(b) => AMsg::Binary(b),
        TMsg::Ping(b) => AMsg::Ping(b),
        TMsg::Pong(b) => AMsg::Pong(b),
        TMsg::Close(f) => AMsg::Close(f.map(|f| ACloseFrame { code: f.code.into(), reason: f.reason.as_str().to_owned().into() })),
        TMsg::Frame(_) => return None,
    })
}

async fn pump(client: WebSocket, upstream: Upstream, mut stop: watch::Receiver<bool>) {
    let (mut c_tx, mut c_rx) = client.split();
    let (mut u_tx, mut u_rx) = upstream.split();
    loop {
        tokio::select! {
            m = c_rx.next() => match m {
                Some(Ok(m)) => {
                    let close = matches!(m, AMsg::Close(_));
                    if u_tx.send(to_upstream(m)).await.is_err() || close { break }
                }
                _ => break,
            },
            m = u_rx.next() => match m {
                Some(Ok(m)) => {
                    let close = matches!(m, TMsg::Close(_));
                    if let Some(m) = to_client(m) {
                        if c_tx.send(m).await.is_err() || close { break }
                    }
                }
                _ => break,
            },
            _ = async { stop.wait_for(|v| *v).await.map(|_| ()) } => break,
        }
    }
    let _ = u_tx.close().await;
    let _ = c_tx.close().await;
}
