//! Server-sent events parser for the backend's `event:` / `data:` framing
//! (`api/src/sse.rs`). Comment lines (`: ping`) are skipped.

use serde_json::Value;

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseParser {
    /// Feed raw bytes; returns every event completed by them. A chunk may end
    /// inside a line or a UTF-8 sequence, so partial lines stay buffered.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<(String, Value)> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if let Some(ev) = self.dispatch() {
                    out.push(ev);
                }
            } else if let Some(v) = line.strip_prefix("event:") {
                self.event = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("data:") {
                self.data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
            }
        }
        out
    }

    fn dispatch(&mut self) -> Option<(String, Value)> {
        let event = std::mem::take(&mut self.event);
        let data = std::mem::take(&mut self.data);
        if data.is_empty() {
            return None;
        }
        let value: Value = serde_json::from_str(&data.join("\n")).unwrap_or(Value::Null);
        let name = if event.is_empty() { value.get("type").and_then(Value::as_str).unwrap_or("").to_string() } else { event };
        Some((name, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_split_frames_and_skips_pings() {
        let mut p = SseParser::default();
        let wire = "event: message\r\ndata: {\"type\":\"message\",\"text\":\"hé\"}\r\n\r\n: ping - now\r\n\r\nevent: done\r\ndata: {}\r\n\r\n";
        let bytes = wire.as_bytes();
        let mut got = vec![];
        // Split inside the two-byte `é` to prove partial UTF-8 is buffered.
        let cut = wire.find('é').unwrap() + 1;
        got.extend(p.feed(&bytes[..cut]));
        got.extend(p.feed(&bytes[cut..]));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "message");
        assert_eq!(got[0].1["text"], "hé");
        assert_eq!(got[1].0, "done");
    }
}
