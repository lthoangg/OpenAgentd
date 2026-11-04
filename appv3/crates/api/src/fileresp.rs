//! Starlette `FileResponse` (1.x): stat headers (content-length,
//! last-modified, md5 etag), `accept-ranges`, `content-disposition`, and
//! single/multi `Range` handling. Unlike Starlette it answers a matching
//! `If-None-Match` / `If-Modified-Since` with 304, so a reopened session
//! does not download its images again.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use md5::{Digest, Md5};
use std::path::Path;

/// `urllib.parse.quote(s)` (safe='/').
pub fn py_quote(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "_.-~/".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Starlette media type header value (`text/*` gets `; charset=utf-8`).
pub fn content_type(media: &str) -> String {
    if media.starts_with("text/") && !media.contains("charset=") {
        format!("{media}; charset=utf-8")
    } else {
        media.to_string()
    }
}

pub struct FileOpts<'a> {
    pub media_type: &'a str,
    pub filename: Option<&'a str>,
    pub disposition: &'a str,
    pub extra_headers: &'a [(&'static str, &'static str)],
}

fn plain(status: StatusCode, body: &str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body.to_string()).into_response()
}

/// Whether the client's copy is current (RFC 9110 §13.2.2): `If-None-Match`
/// decides when sent (weak comparison, `*` matches), else `If-Modified-Since`.
fn not_modified(req: &HeaderMap, etag: &str, mtime_secs: u64) -> bool {
    if let Some(tags) = req.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
        return tags.split(',').map(str::trim).any(|t| t == "*" || t.trim_start_matches("W/") == etag);
    }
    req.get(header::IF_MODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| httpdate::parse_http_date(v).ok())
        .and_then(|since| since.duration_since(std::time::UNIX_EPOCH).ok())
        .is_some_and(|since| mtime_secs <= since.as_secs())
}

enum RangeErr {
    Malformed(&'static str),
    Unsatisfiable,
}

fn parse_ranges(raw: &str, size: u64) -> Result<Vec<(u64, u64)>, RangeErr> {
    let Some((units, spec)) = raw.split_once('=') else { return Err(RangeErr::Malformed("Malformed range header.")) };
    if units.trim().to_lowercase() != "bytes" {
        return Err(RangeErr::Malformed("Only support bytes range"));
    }
    if spec.matches(',').count() + 1 > 100 {
        return Ok(vec![]);
    }
    let mut ranges = vec![];
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() || part == "-" || !part.contains('-') {
            continue;
        }
        let (s, e) = part.split_once('-').unwrap();
        let (s, e) = (s.trim(), e.trim());
        let parsed: Option<(u64, u64)> = (|| {
            let start = if s.is_empty() { size.saturating_sub(e.parse::<u64>().ok()?) } else { s.parse::<u64>().ok()? };
            let end = if !s.is_empty() && !e.is_empty() && e.parse::<u64>().ok()? < size { e.parse::<u64>().ok()? + 1 } else { size };
            Some((start, end))
        })();
        if let Some(r) = parsed {
            ranges.push(r);
        }
    }
    if ranges.is_empty() {
        return Err(RangeErr::Malformed("Range header: range must be requested"));
    }
    if ranges.iter().any(|(s, _)| *s >= size) {
        return Err(RangeErr::Unsatisfiable);
    }
    if ranges.iter().any(|(s, e)| s >= e) {
        return Err(RangeErr::Malformed("Range header: start must be less than end"));
    }
    if ranges.len() == 1 {
        return Ok(ranges);
    }
    ranges.sort();
    let mut merged = vec![ranges[0]];
    for (s, e) in ranges.into_iter().skip(1) {
        let last = merged.last_mut().unwrap();
        if s <= last.1 {
            last.1 = last.1.max(e);
        } else {
            merged.push((s, e));
        }
    }
    Ok(merged)
}

pub async fn file_response(path: &Path, req_headers: &HeaderMap, o: FileOpts<'_>) -> Response {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => m,
        _ => return crate::error::ApiError::internal(format!("File at path {} does not exist.", path.display())).into_response(),
    };
    let size = meta.len();
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).unwrap_or_default();
    let mtime_f = mtime.as_secs() as f64 + mtime.subsec_nanos() as f64 * 1e-9;
    let last_modified = httpdate::fmt_http_date(std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime.as_secs()));
    let etag_base = format!("{}-{}", appv3_core::pyjson::float_repr(mtime_f), size);
    let etag = format!("\"{:x}\"", Md5::digest(etag_base.as_bytes()));
    let ct = content_type(o.media_type);

    let mut h = HeaderMap::new();
    for (k, v) in o.extra_headers {
        h.insert(*k, HeaderValue::from_static(v));
    }
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&ct).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(name) = o.filename {
        let q = py_quote(name);
        let cd = if q != name { format!("{}; filename*=utf-8''{q}", o.disposition) } else { format!("{}; filename=\"{name}\"", o.disposition) };
        if let Ok(v) = HeaderValue::from_str(&cd) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
    }
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    h.insert(header::LAST_MODIFIED, HeaderValue::from_str(&last_modified).unwrap());
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());

    if not_modified(req_headers, &etag, mtime.as_secs()) {
        let mut r = StatusCode::NOT_MODIFIED.into_response();
        for k in [header::ETAG, header::LAST_MODIFIED, header::CACHE_CONTROL] {
            if let Some(v) = h.get(&k) {
                r.headers_mut().insert(k, v.clone());
            }
        }
        return r;
    }

    let range = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
    let if_range = req_headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).map(String::from);
    let use_range = match (&range, &if_range) {
        (None, _) => false,
        (Some(_), Some(ir)) => *ir == last_modified || *ir == etag,
        (Some(_), None) => true,
    };
    let simple = |h: HeaderMap| async move {
        let f = match tokio::fs::File::open(path).await {
            Ok(f) => f,
            Err(e) => return crate::error::ApiError::internal(e).into_response(),
        };
        let mut r = Response::new(Body::from_stream(tokio_util::io::ReaderStream::with_capacity(f, 64 * 1024)));
        *r.headers_mut() = h;
        r
    };
    if !use_range {
        return simple(h).await;
    }
    let ranges = match parse_ranges(range.as_deref().unwrap(), size) {
        Ok(r) => r,
        Err(RangeErr::Malformed(m)) => return plain(StatusCode::BAD_REQUEST, m),
        Err(RangeErr::Unsatisfiable) => {
            let mut r = plain(StatusCode::RANGE_NOT_SATISFIABLE, "");
            r.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
            return r;
        }
    };
    if ranges.is_empty() {
        return simple(h).await;
    }
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let read_range = |s: u64, e: u64| async move {
        let mut f = tokio::fs::File::open(path).await?;
        f.seek(std::io::SeekFrom::Start(s)).await?;
        let mut buf = vec![0u8; (e - s) as usize];
        f.read_exact(&mut buf).await?;
        Ok::<Vec<u8>, std::io::Error>(buf)
    };
    if ranges.len() == 1 {
        let (s, e) = ranges[0];
        h.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {}-{}/{size}", s, e - 1)).unwrap());
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(e - s));
        // Stream the slice: browsers open media with `bytes=0-`, which
        // would otherwise read the whole file into memory first.
        let opened = async {
            let mut f = tokio::fs::File::open(path).await?;
            f.seek(std::io::SeekFrom::Start(s)).await?;
            Ok::<_, std::io::Error>(f.take(e - s))
        };
        let slice = match opened.await {
            Ok(f) => f,
            Err(err) => return crate::error::ApiError::internal(err).into_response(),
        };
        let mut r = Response::new(Body::from_stream(tokio_util::io::ReaderStream::with_capacity(slice, 64 * 1024)));
        *r.status_mut() = StatusCode::PARTIAL_CONTENT;
        *r.headers_mut() = h;
        return r;
    }
    let boundary: String = (0..13).map(|_| format!("{:02x}", rand_byte())).collect();
    let mut body: Vec<u8> = vec![];
    for (s, e) in &ranges {
        body.extend(format!("--{boundary}\r\nContent-Type: {ct}\r\nContent-Range: bytes {s}-{}/{size}\r\n\r\n", e - 1).as_bytes());
        match read_range(*s, *e).await {
            Ok(d) => body.extend(d),
            Err(err) => return crate::error::ApiError::internal(err).into_response(),
        }
        body.extend(b"\r\n");
    }
    body.extend(format!("--{boundary}--").as_bytes());
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&format!("multipart/byteranges; boundary={boundary}")).unwrap());
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = StatusCode::PARTIAL_CONTENT;
    *r.headers_mut() = h;
    r
}

fn rand_byte() -> u8 {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let c = uuid::Uuid::new_v4();
    c.as_bytes()[(n % 16) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    const OPTS: FileOpts<'static> = FileOpts { media_type: "video/mp4", filename: None, disposition: "inline", extra_headers: &[] };

    fn fixture(len: usize) -> (tempfile::TempDir, std::path::PathBuf, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        let path = dir.path().join("clip.mp4");
        std::fs::write(&path, &data).unwrap();
        (dir, path, data)
    }

    async fn get(path: &Path, range: &str) -> Response {
        let mut h = HeaderMap::new();
        h.insert(header::RANGE, HeaderValue::from_str(range).unwrap());
        file_response(path, &h, OPTS).await
    }

    async fn bytes(r: Response) -> Vec<u8> {
        r.into_body().collect().await.unwrap().to_bytes().to_vec()
    }

    #[tokio::test]
    async fn single_ranges_return_the_requested_slice() {
        let (_d, path, data) = fixture(10_000);
        for (range, s, e) in [("bytes=2-5", 2usize, 6usize), ("bytes=9000-", 9000, 10_000), ("bytes=-3", 9997, 10_000), ("bytes=0-99999", 0, 10_000)] {
            let r = get(&path, range).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(r.headers()[header::CONTENT_RANGE], format!("bytes {}-{}/10000", s, e - 1), "{range}");
            assert_eq!(r.headers()[header::CONTENT_LENGTH], (e - s).to_string(), "{range}");
            assert_eq!(bytes(r).await, data[s..e], "{range}");
        }
    }

    #[tokio::test]
    async fn an_open_ended_range_is_streamed_not_read_into_memory() {
        // `Range: bytes=0-` is how browsers open every <video>. A buffered
        // body knows its exact size up front; a streamed one does not.
        let (_d, path, data) = fixture(3 << 20);
        let r = get(&path, "bytes=0-").await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(axum::body::HttpBody::size_hint(r.body()).exact(), None);
        assert_eq!(bytes(r).await, data);
    }

    #[tokio::test]
    async fn multi_ranges_and_bad_ranges_keep_their_responses() {
        let (_d, path, data) = fixture(100);
        let r = get(&path, "bytes=0-1,10-11").await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert!(r.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("multipart/byteranges; boundary="));
        let body = bytes(r).await;
        assert!(body.windows(2).any(|w| w == &data[10..12]));
        let r = get(&path, "bytes=500-").await;
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes */100");
    }

    /// A client that holds the file already gets 304 and no body; the
    /// entity tag decides when it is sent, the date otherwise.
    #[tokio::test]
    async fn a_matching_validator_answers_not_modified() {
        let (_d, path, _) = fixture(100);
        let first = file_response(&path, &HeaderMap::new(), OPTS).await;
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_string();
        let date = first.headers()[header::LAST_MODIFIED].to_str().unwrap().to_string();
        let ask = |pairs: Vec<(header::HeaderName, String)>| {
            let path = path.clone();
            async move {
                let mut h = HeaderMap::new();
                for (k, v) in pairs {
                    h.insert(k, HeaderValue::from_str(&v).unwrap());
                }
                file_response(&path, &h, OPTS).await
            }
        };
        for pairs in [
            vec![(header::IF_NONE_MATCH, etag.clone())],
            vec![(header::IF_NONE_MATCH, format!("\"other\", W/{etag}"))],
            vec![(header::IF_NONE_MATCH, "*".to_string())],
            vec![(header::IF_MODIFIED_SINCE, date.clone())],
            vec![(header::IF_NONE_MATCH, etag.clone()), (header::RANGE, "bytes=0-1".to_string())],
        ] {
            let r = ask(pairs.clone()).await;
            assert_eq!(r.status(), StatusCode::NOT_MODIFIED, "{pairs:?}");
            assert_eq!(r.headers()[header::ETAG], etag.as_str());
            assert!(bytes(r).await.is_empty());
        }
        let r = ask(vec![(header::IF_NONE_MATCH, "\"other\"".into()), (header::IF_MODIFIED_SINCE, date.clone())]).await;
        assert_eq!(r.status(), StatusCode::OK, "the entity tag wins over the date");
        let r = ask(vec![(header::IF_MODIFIED_SINCE, "Thu, 01 Jan 1970 00:00:00 GMT".into())]).await;
        assert_eq!(r.status(), StatusCode::OK);
    }
}
