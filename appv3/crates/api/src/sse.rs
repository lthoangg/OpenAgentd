//! Server-sent events: `\r\n` framing, a `: ping` comment after 15 s of
//! silence to keep idle connections open, and no-buffering response headers.
//! Events that are ready together go out as one write.

use appv3_agent::WireEvent;
use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub const PING_INTERVAL: Duration = Duration::from_secs(15);

/// Most events joined into one write. Batching never waits for more: it
/// takes what is ready, so it adds no delay.
pub const WRITE_BATCH_MAX: usize = 32;

/// A webview opens at most 6 HTTP/1.1 connections per host, shared by every
/// window. Long-lived streams hold one each, so at this many the next request
/// can queue behind them with no error. Logged as a warning to make that
/// visible in the log.
const NEAR_WEBVIEW_LIMIT: usize = 5;

/// Open SSE responses, for the log only.
#[derive(Default)]
pub struct StreamCounter(AtomicUsize);

static STREAMS: StreamCounter = StreamCounter(AtomicUsize::new(0));

impl StreamCounter {
    fn open(&'static self, stats: Arc<SseStats>) -> StreamGuard {
        let active = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        tracing::info!("sse_stream_open active={}", active);
        if active >= NEAR_WEBVIEW_LIMIT {
            tracing::warn!("sse_streams_near_webview_limit active={}", active);
        }
        StreamGuard { counter: self, stats, opened: Instant::now() }
    }

    pub fn active(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

/// What one SSE response sent, logged by `sse_stream_close`. The response
/// carries it as an extension so a middleware can add the path and peer.
#[derive(Default)]
pub struct SseStats {
    events: AtomicU64,
    writes: AtomicU64,
    pings: AtomicU64,
    bytes: AtomicU64,
    label: OnceLock<String>,
}

impl SseStats {
    /// Names the stream in the close log (first call wins).
    pub fn label(&self, label: String) {
        let _ = self.label.set(label);
    }

    #[cfg(test)]
    pub(crate) fn labelled(&self) -> Option<&str> {
        self.label.get().map(String::as_str)
    }

    fn wrote(&self, events: usize, bytes: usize) {
        self.events.fetch_add(events as u64, Ordering::Relaxed);
        self.writes.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn pinged(&self) {
        self.pings.fetch_add(1, Ordering::Relaxed);
        self.writes.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(PING_FRAME.len() as u64, Ordering::Relaxed);
    }
}

/// Dropped with the response body: on a normal end and on client disconnect.
struct StreamGuard {
    counter: &'static StreamCounter,
    stats: Arc<SseStats>,
    opened: Instant,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let active = self.counter.0.fetch_sub(1, Ordering::SeqCst) - 1;
        let s = &self.stats;
        tracing::info!(
            "sse_stream_close active={} events={} writes={} pings={} bytes={} secs={} {}",
            active,
            s.events.load(Ordering::Relaxed),
            s.writes.load(Ordering::Relaxed),
            s.pings.load(Ordering::Relaxed),
            s.bytes.load(Ordering::Relaxed),
            self.opened.elapsed().as_secs(),
            s.label.get().map(String::as_str).unwrap_or("path=? remote=?"),
        );
    }
}

/// Clients ignore comment lines, so the ping carries nothing.
const PING_FRAME: &[u8] = b": ping\r\n\r\n";

/// Wrap an event stream as an SSE response. The stream ending closes the
/// response (sse-starlette does the same when its generator returns).
pub fn sse_response<S>(events: S) -> Response
where
    S: Stream<Item = Arc<WireEvent>> + Send + 'static,
{
    sse_response_counted(events, &STREAMS)
}

fn sse_response_counted<S>(events: S, counter: &'static StreamCounter) -> Response
where
    S: Stream<Item = Arc<WireEvent>> + Send + 'static,
{
    let stats = Arc::new(SseStats::default());
    let guard = counter.open(stats.clone());
    let body_stats = stats.clone();
    let body = async_stream::stream! {
        let _guard = guard;
        let stats = body_stats;
        let mut batches = Box::pin(events.ready_chunks(WRITE_BATCH_MAX));
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
        loop {
            tokio::select! {
                batch = batches.next() => match batch {
                    Some(batch) => {
                        let mut frame = String::new();
                        for ev in &batch {
                            frame.push_str(&ev.to_sse());
                        }
                        stats.wrote(batch.len(), frame.len());
                        // A ping only fills silence.
                        ticker.reset();
                        yield Ok::<Bytes, std::io::Error>(Bytes::from(frame));
                    }
                    None => break,
                },
                _ = ticker.tick() => {
                    stats.pinged();
                    yield Ok(Bytes::from_static(PING_FRAME));
                }
            }
        }
    };
    let mut resp = Response::new(Body::from_stream(body));
    *resp.status_mut() = StatusCode::OK;
    resp.extensions_mut().insert(stats);
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn idle_streams_get_a_fixed_ping_comment() {
        let resp = sse_response(futures::stream::pending::<Arc<WireEvent>>());
        let mut body = resp.into_body().into_data_stream();
        assert_eq!(&body.next().await.unwrap().unwrap()[..], b": ping\r\n\r\n");
    }

    fn ev(name: &str, data: &str) -> Arc<WireEvent> {
        Arc::new(WireEvent::new(name, data))
    }

    #[tokio::test]
    async fn events_ready_together_go_out_as_one_write() {
        let ready = vec![ev("message", "{\"text\":\"a\"}"), ev("tool_call", "{}"), ev("tool_start", "{}")];
        let expected: String = ready.iter().map(|e| e.to_sse()).collect();
        let events = futures::stream::iter(ready).chain(futures::stream::pending());
        let mut body = sse_response(events).into_body().into_data_stream();
        assert_eq!(std::str::from_utf8(&body.next().await.unwrap().unwrap()).unwrap(), expected);
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_stream_gets_no_ping_until_it_falls_silent() {
        let events = async_stream::stream! {
            for i in 0..3 {
                tokio::time::sleep(Duration::from_secs(10)).await;
                yield ev("message", &format!("{{\"n\":{i}}}"));
            }
            futures::future::pending::<()>().await;
        };
        let mut body = sse_response(events).into_body().into_data_stream();
        for i in 0..3 {
            let frame = body.next().await.unwrap().unwrap();
            assert!(frame.starts_with(b"event: message"), "frame {i} was {:?}", std::str::from_utf8(&frame));
        }
        let started = tokio::time::Instant::now();
        assert_eq!(&body.next().await.unwrap().unwrap()[..], PING_FRAME);
        assert_eq!(started.elapsed(), PING_INTERVAL, "the ping waits a full interval after the last event");
    }

    #[tokio::test]
    async fn the_response_counts_what_it_sent() {
        let resp = sse_response(futures::stream::iter(vec![ev("message", "{}"), ev("done", "{}")]));
        let stats = resp.extensions().get::<Arc<SseStats>>().unwrap().clone();
        let mut body = resp.into_body().into_data_stream();
        let mut bytes = 0;
        while let Some(chunk) = body.next().await {
            bytes += chunk.unwrap().len() as u64;
        }
        assert_eq!((stats.events.load(Ordering::Relaxed), stats.writes.load(Ordering::Relaxed), stats.bytes.load(Ordering::Relaxed)), (2, 1, bytes));
    }

    #[tokio::test]
    async fn open_streams_are_counted_until_the_body_is_dropped() {
        static COUNTER: StreamCounter = StreamCounter(AtomicUsize::new(0));
        assert_eq!(COUNTER.active(), 0);
        let a = sse_response_counted(futures::stream::pending::<Arc<WireEvent>>(), &COUNTER);
        let b = sse_response_counted(futures::stream::pending::<Arc<WireEvent>>(), &COUNTER);
        assert_eq!(COUNTER.active(), 2);
        drop(a);
        assert_eq!(COUNTER.active(), 1);
        // A stream that ends by itself releases its slot too.
        let mut ended = sse_response_counted(futures::stream::empty::<Arc<WireEvent>>(), &COUNTER).into_body().into_data_stream();
        assert!(ended.next().await.is_none());
        drop(ended);
        drop(b);
        assert_eq!(COUNTER.active(), 0);
    }
}
