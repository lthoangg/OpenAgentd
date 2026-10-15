//! UTF-8-safe SSE line reader — port of `app/agent/providers/streaming.py`.
//!
//! Bytes are buffered until a full `\n`-terminated line is available, so a
//! multi-byte character split across network chunks is never corrupted.

use crate::types::{ProviderError, ProviderResult};
use futures::{Stream, StreamExt};
use serde_json::Value;
use std::time::Duration;

/// httpx's default provider timeout: every phase (connect, each read) is
/// bounded separately, so a long stream never hits it while bytes flow.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Yield raw text lines (without the trailing `\r\n`/`\n`) from a byte stream.
pub fn lines(resp: reqwest::Response) -> impl Stream<Item = ProviderResult<String>> + Send {
    lines_idle(resp, Some(DEFAULT_TIMEOUT))
}

/// Splits bytes into `\n`-terminated lines with a trailing `\r` stripped.
/// Remembers how far it has scanned, so a long line that arrives over many
/// chunks is searched once rather than from its start on every chunk.
#[derive(Default)]
pub struct LineBuf {
    buf: Vec<u8>,
    scanned: usize,
}

impl LineBuf {
    /// Append `chunk` and move every completed line into `out`.
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        self.buf.extend_from_slice(chunk);
        let mut start = 0;
        while let Some(rel) = self.buf[self.scanned..].iter().position(|b| *b == b'\n') {
            let end = self.scanned + rel;
            out.push(line_text(&self.buf[start..end]));
            start = end + 1;
            self.scanned = start;
        }
        if start > 0 {
            self.buf.drain(..start);
        }
        self.scanned = self.buf.len();
    }

    /// The unterminated tail left when the stream ends, if any.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        self.scanned = 0;
        (!rest.is_empty()).then(|| line_text(&rest))
    }
}

fn line_text(line: &[u8]) -> String {
    String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line)).into_owned()
}

/// [`lines`] with an httpx-style read timeout between chunks (`None` = none).
pub fn lines_idle(resp: reqwest::Response, idle: Option<Duration>) -> impl Stream<Item = ProviderResult<String>> + Send {
    let mut bytes = resp.bytes_stream();
    async_stream::stream! {
        let mut buf = LineBuf::default();
        let mut ready: Vec<String> = Vec::new();
        loop {
            let next = match idle {
                Some(d) => match tokio::time::timeout(d, bytes.next()).await {
                    Ok(n) => n,
                    Err(_) => { yield Err(ProviderError::Network("ReadTimeout: The read operation timed out".into())); return; }
                },
                None => bytes.next().await,
            };
            match next {
                Some(Ok(chunk)) => {
                    buf.push(&chunk, &mut ready);
                    for line in ready.drain(..) {
                        yield Ok(line);
                    }
                }
                Some(Err(e)) => { yield Err(ProviderError::from_body_read(e)); return; }
                None => {
                    if let Some(line) = buf.finish() {
                        yield Ok(line);
                    }
                    return;
                }
            }
        }
    }
}

/// v2 `iter_sse_data`: parsed JSON for each `data: ` line; stops at sentinel.
pub fn data_json(resp: reqwest::Response, sentinel: Option<&'static str>, require_sentinel: bool) -> impl Stream<Item = ProviderResult<Value>> + Send {
    data_json_idle(resp, sentinel, require_sentinel, Some(DEFAULT_TIMEOUT))
}

pub fn data_json_idle(resp: reqwest::Response, sentinel: Option<&'static str>, require_sentinel: bool, idle: Option<Duration>) -> impl Stream<Item = ProviderResult<Value>> + Send {
    let inner = lines_idle(resp, idle);
    async_stream::stream! {
        futures::pin_mut!(inner);
        let mut got_sentinel = false;
        while let Some(line) = inner.next().await {
            let line = match line { Ok(l) => l, Err(e) => { yield Err(e); return; } };
            let line = line.trim();
            let Some(data) = line.strip_prefix("data: ") else { continue };
            if let Some(s) = sentinel {
                if data == s { got_sentinel = true; break; }
            }
            match serde_json::from_str::<Value>(data) {
                Ok(v) => yield Ok(v),
                Err(_) => { tracing::debug!("sse_invalid_json data={}", &data[..data.len().min(200)]); continue; }
            }
        }
        if require_sentinel && !got_sentinel {
            yield Err(ProviderError::Network(format!("SSE stream ended before terminal {:?} frame", sentinel.unwrap_or(""))));
        }
    }
}

/// Send a request and turn a >=400 status into `ProviderError::Http`.
pub async fn send_checked(req: reqwest::RequestBuilder, label: &str) -> ProviderResult<reqwest::Response> {
    check_status(req.send().await.map_err(ProviderError::from_reqwest)?, label).await
}

/// Send a streaming request: the timeout bounds only the wait for the
/// response head (the body is guarded per read by [`lines_idle`]).
pub async fn send_stream(req: reqwest::RequestBuilder, timeout: Option<Duration>, label: &str) -> ProviderResult<reqwest::Response> {
    check_status(send_head(req, timeout).await?, label).await
}

/// Send a request and wait (bounded by `timeout`) for the response head only;
/// no status check.
pub async fn send_head(req: reqwest::RequestBuilder, timeout: Option<Duration>) -> ProviderResult<reqwest::Response> {
    Ok(match timeout {
        Some(t) => match tokio::time::timeout(t, req.send()).await {
            Ok(r) => r.map_err(ProviderError::from_reqwest)?,
            Err(_) => return Err(ProviderError::Network("ReadTimeout: The read operation timed out".into())),
        },
        None => req.send().await.map_err(ProviderError::from_reqwest)?,
    })
}

pub async fn check_status(resp: reqwest::Response, label: &str) -> ProviderResult<reqwest::Response> {
    let status = resp.status().as_u16();
    if status >= 400 {
        let url = resp.url().to_string();
        let headers: Vec<(String, String)> = resp.headers().iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!("{label}_error status={} body={}", status, &body.chars().take(500).collect::<String>());
        return Err(ProviderError::http(status, &url, body, headers));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(chunks: &[&[u8]]) -> (Vec<String>, Option<String>) {
        let mut lb = LineBuf::default();
        let mut out = Vec::new();
        for c in chunks {
            lb.push(c, &mut out);
        }
        (out, lb.finish())
    }

    #[test]
    fn line_buf_reassembles_a_long_line_from_many_chunks() {
        let line = format!("data: {}", "x".repeat(10_000));
        let bytes = format!("{line}\r\nnext\n");
        let chunks: Vec<&[u8]> = bytes.as_bytes().chunks(7).collect();
        assert_eq!(feed(&chunks), (vec![line, "next".to_string()], None));
    }

    #[test]
    fn line_buf_splits_one_chunk_into_lines_and_keeps_blank_ones() {
        assert_eq!(feed(&[b"event: a\ndata: 1\n\ndata: 2\r\n\r\n"]), (vec!["event: a".into(), "data: 1".into(), "".into(), "data: 2".into(), "".into()], None));
    }

    #[test]
    fn line_buf_returns_an_unterminated_tail_at_the_end() {
        assert_eq!(feed(&[b"data: 1\nda", b"ta: 2\r"]), (vec!["data: 1".to_string()], Some("data: 2".to_string())));
        assert_eq!(feed(&[b"data: 1\n"]), (vec!["data: 1".to_string()], None));
    }

    #[test]
    fn line_buf_keeps_a_multibyte_char_split_across_chunks() {
        assert_eq!(feed(&[b"data: \xC3", b"\xA9\n"]), (vec!["data: é".to_string()], None));
    }

    #[tokio::test]
    async fn utf8_split_across_chunks_is_preserved() {
        // Simulate via a local server: split "é" (0xC3 0xA9) across writes.
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut tmp = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut s, &mut tmp).await;
            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n").await.unwrap();
            let part1: &[u8] = b"data: {\"t\":\"\xC3";
            let part2: &[u8] = b"\xA9\"}\n\ndata: [DONE]\n\n";
            for p in [part1, part2] {
                s.write_all(format!("{:x}\r\n", p.len()).as_bytes()).await.unwrap();
                s.write_all(p).await.unwrap();
                s.write_all(b"\r\n").await.unwrap();
                s.flush().await.unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            s.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let resp = reqwest::get(format!("http://{addr}/")).await.unwrap();
        let items: Vec<_> = data_json(resp, Some("[DONE]"), true).collect().await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].as_ref().unwrap()["t"], "é");
    }

    #[tokio::test]
    async fn connection_dropped_mid_stream_is_a_retryable_network_error() {
        // reqwest reports every body read failure from `bytes_stream` as a
        // "decode" error; a connection cut mid-reply must still be retried.
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut tmp = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut s, &mut tmp).await;
            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n").await.unwrap();
            let part: &[u8] = b"data: {\"t\":1}\n\n";
            s.write_all(format!("{:x}\r\n", part.len()).as_bytes()).await.unwrap();
            s.write_all(part).await.unwrap();
            s.write_all(b"\r\n").await.unwrap();
            // Promise a chunk, then drop the connection before sending it.
            s.write_all(b"40\r\ndata: {\"t\"").await.unwrap();
            s.flush().await.unwrap();
        });
        let resp = reqwest::get(format!("http://{addr}/")).await.unwrap();
        let items: Vec<_> = data_json(resp, None, false).collect().await;
        assert_eq!(items[0].as_ref().unwrap()["t"], 1);
        let err = items.last().unwrap().as_ref().unwrap_err();
        assert!(matches!(err, ProviderError::Network(_)), "expected a retryable Network error, got {err:?}");
    }
}
