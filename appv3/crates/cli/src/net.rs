//! Server address resolution, LAN discovery, and a tiny HTTP GET for health
//! checks. The GET is hand-rolled on purpose: a proxy-aware client would
//! send `localhost` checks through `HTTP_PROXY`.

use anyhow::{bail, Context, Result};
use appv3_core::runtime_settings::{load_server_settings, ServerYaml};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 4082;

pub struct ServerAddresses {
    pub local: String,
    pub lan: Vec<String>,
}

/// `localhost`, or a loopback IP (an IPv6 zone suffix is allowed).
pub fn is_loopback_host(host: &str) -> bool {
    if host.to_lowercase() == "localhost" {
        return true;
    }
    let bare = host.split_once('%').map(|(h, _)| h).unwrap_or(host);
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) if host.contains('%') => v6.is_loopback(),
        Ok(ip) if !host.contains('%') => ip.is_loopback(),
        _ => false,
    }
}

pub fn require_loopback_or_auth(host: &str, has_auth: bool) -> Result<()> {
    if !has_auth && !is_loopback_host(host) {
        bail!("refusing to listen on {host} without authentication; pass --key or configure an access key");
    }
    Ok(())
}

pub fn display_host(host: &str) -> String {
    if host == "0.0.0.0" || host == "::" {
        "127.0.0.1".into()
    } else {
        host.into()
    }
}

pub fn server_settings() -> Result<ServerYaml> {
    load_server_settings().context("read server.yaml")
}

/// `(host, port)` from the flags, else `server.yaml`, else the defaults.
pub fn resolve_addr(host: Option<&str>, port: Option<u16>, cfg: &ServerYaml) -> (String, u16) {
    let host = host.filter(|h| !h.is_empty()).map(String::from).unwrap_or_else(|| cfg.host.clone());
    let port = port.or_else(|| u16::try_from(cfg.port).ok().filter(|&p| p != 0)).unwrap_or(DEFAULT_PORT);
    (host, port)
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

/// Windows `socket.gethostname()`: the DNS host name.
#[cfg(windows)]
fn hostname() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) } == 0 {
        return std::env::var("COMPUTERNAME").ok();
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

pub fn lan_ips() -> Vec<String> {
    let mut ips: Vec<String> = vec![];
    let mut add = |ip: String| {
        if !ip.starts_with("127.") && !ips.contains(&ip) {
            ips.push(ip);
        }
    };
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                add(addr.ip().to_string());
            }
        }
    }
    if let Some(h) = hostname() {
        if let Ok(addrs) = (h.as_str(), 0).to_socket_addrs() {
            for a in addrs {
                if let SocketAddr::V4(v4) = a {
                    add(v4.ip().to_string());
                }
            }
        }
    }
    ips
}

pub fn server_addresses(host: &str, port: u16) -> ServerAddresses {
    let lan = lan_ips().into_iter().map(|ip| format!("http://{ip}:{port}")).collect();
    ServerAddresses { local: format!("http://{}:{port}", display_host(host)), lan }
}

/// The first address of `host:port` that accepts a connection.
pub fn connect(host: &str, port: u16, timeout: Duration) -> Option<TcpStream> {
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs().map(|a| a.collect()).unwrap_or_default();
    for a in addrs {
        if let Ok(s) = TcpStream::connect_timeout(&a, timeout) {
            return Some(s);
        }
    }
    None
}

pub fn is_port_reachable(host: &str, port: u16) -> bool {
    connect(host, port, Duration::from_secs(1)).is_some()
}

/// `GET path` → `(status, body)`; `None` on connection or protocol errors.
pub fn http_get(host: &str, port: u16, path: &str, timeout: Duration) -> Option<(u16, Vec<u8>)> {
    http_get_with_headers(host, port, path, &[], timeout)
}

/// [`http_get`] that also sends `headers` as `(name, value)` pairs, e.g. an
/// `Authorization` bearer key. `None`, before connecting, when a header holds
/// a line break: a value must not add headers or a second request.
pub fn http_get_with_headers(host: &str, port: u16, path: &str, headers: &[(&str, &str)], timeout: Duration) -> Option<(u16, Vec<u8>)> {
    http_request("GET", host, port, path, headers, timeout)
}

fn http_request(method: &str, host: &str, port: u16, path: &str, headers: &[(&str, &str)], timeout: Duration) -> Option<(u16, Vec<u8>)> {
    use std::io::{Read, Write};
    if path.contains(['\r', '\n', ' ']) || headers.iter().any(|(name, value)| name.contains(['\r', '\n']) || value.contains(['\r', '\n'])) {
        return None;
    }
    let mut s = connect(host, port, timeout)?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let ua = format!("openagentd/{}", appv3_core::VERSION);
    let extra: String = headers.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect();
    let length = if method == "POST" { "Content-Length: 0\r\n" } else { "" };
    let req = format!("{method} {path} HTTP/1.1\r\nAccept-Encoding: identity\r\nHost: {host}:{port}\r\nUser-Agent: {ua}\r\n{extra}{length}Connection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = vec![];
    s.read_to_end(&mut buf).ok()?;
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..split]).into_owned();
    let mut body = buf[split + 4..].to_vec();
    let status: u16 = head.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if chunked {
        let mut out = vec![];
        let mut rest = &body[..];
        loop {
            let nl = rest.windows(2).position(|w| w == b"\r\n")?;
            let size_s = String::from_utf8_lossy(&rest[..nl]).into_owned();
            let size = usize::from_str_radix(size_s.split(';').next()?.trim(), 16).ok()?;
            rest = &rest[nl + 2..];
            if size == 0 {
                break;
            }
            out.extend_from_slice(rest.get(..size)?);
            rest = rest.get(size + 2..).unwrap_or(&[]);
        }
        body = out;
    }
    Some((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const WAIT: Duration = Duration::from_secs(5);

    /// A one-request server: answers with `reply`, then hands back the
    /// request head it saw.
    fn serve_once(reply: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut head = vec![];
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && s.read(&mut byte).unwrap() == 1 {
                head.push(byte[0]);
            }
            s.write_all(reply.as_bytes()).unwrap();
            String::from_utf8(head).unwrap()
        });
        (port, seen)
    }

    #[test]
    fn http_get_with_headers_sends_each_header() {
        let (port, seen) = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
        let got = http_get_with_headers("127.0.0.1", port, "/api/modules", &[("Authorization", "Bearer k-1"), ("X-Probe", "1")], WAIT);
        assert_eq!(got, Some((200, b"hi".to_vec())));
        let head = seen.join().unwrap();
        assert!(head.starts_with("GET /api/modules HTTP/1.1\r\n"), "{head}");
        assert!(head.contains("\r\nAuthorization: Bearer k-1\r\nX-Probe: 1\r\nConnection: close\r\n\r\n"), "{head}");
    }

    #[test]
    fn http_get_sends_no_extra_headers_and_decodes_chunked_bodies() {
        let (port, seen) = serve_once("HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nhi\r\n4\r\n you\r\n0\r\n\r\n");
        assert_eq!(http_get("127.0.0.1", port, "/x", WAIT), Some((404, b"hi you".to_vec())));
        let head = seen.join().unwrap();
        assert!(head.contains(&format!("\r\nUser-Agent: openagentd/{}\r\nConnection: close\r\n\r\n", appv3_core::VERSION)), "{head}");
        assert!(!head.to_ascii_lowercase().contains("authorization"), "{head}");
    }

    #[test]
    fn http_get_with_headers_refuses_a_line_break_before_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        for bad in [("X-A", "b\r\nX-Evil: 1"), ("X-A\n", "b"), ("X-A", "b\n")] {
            assert_eq!(http_get_with_headers("127.0.0.1", port, "/", &[bad], WAIT), None);
        }
        // The request line is protected the same way.
        for path in ["/a b", "/a\r\nX-Evil: 1", "/a\n"] {
            assert_eq!(http_get_with_headers("127.0.0.1", port, path, &[], WAIT), None, "{path:?}");
        }
        // A connection would be waiting in the backlog by now.
        listener.set_nonblocking(true).unwrap();
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock, "nothing may connect");
    }

    #[test]
    fn http_get_never_sends_a_content_length() {
        let (port, seen) = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(http_get("127.0.0.1", port, "/x", WAIT), Some((200, vec![])));
        assert!(!seen.join().unwrap().to_ascii_lowercase().contains("content-length"));
    }
}
