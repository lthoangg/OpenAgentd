//! Live check of connector sign-in against real services, as far as it goes
//! without a person: discovery, automatic client registration for the relay
//! page, and the sign-in page's address. Prints one line per address.
//!
//!     cargo run -p appv3-mcp --example probe_sign_in -- https://mcp.notion.com/mcp …

use appv3_mcp::client::McpClient;
use appv3_mcp::config::{HttpKind, OAuthConfig};
use appv3_mcp::oauth::{self, build_oauth_provider, Relay};
use std::time::Duration;

async fn probe(i: usize, url: String) -> String {
    let name = format!("probe-{i}");
    let relay = Relay { redirect_uri: "https://account.openagentd.dev/oauth/callback".into(), return_to: "openagentd://mcp-oauth".into() };
    // `PROBE_LOCAL=1`: register for localhost instead, as a browser on the server's machine does.
    let local = std::env::var("PROBE_LOCAL").is_ok_and(|v| v == "1");
    let announced = oauth::allow_client_oauth(&name, (!local).then_some(relay));
    let provider = match build_oauth_provider(&name, &url, Some(&OAuthConfig { client_id: None, client_secret: Option::None })) {
        Ok(p) => p,
        Err(e) => return format!("FAIL {url}  {e}"),
    };
    let client = match McpClient::http(&url, &[], provider, HttpKind::Auto) {
        Ok(c) => c,
        Err(e) => return format!("FAIL {url}  {e}"),
    };
    let init = tokio::spawn(async move { client.initialize().await.map(|_| client) });
    let line = tokio::select! {
        r = announced => match r {
            Ok(auth) => {
                let host = reqwest::Url::parse(&auth).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
                format!("PASS {url}  sign-in page on {host}")
            }
            Err(_) => "FAIL no sign-in page".to_string(),
        },
        r = init => match r {
            Ok(Ok(_)) => format!("PASS {url}  connected without sign-in"),
            Ok(Err(e)) => format!("FAIL {url}  {e}"),
            Err(e) => format!("FAIL {url}  {e}"),
        },
        _ = tokio::time::sleep(Duration::from_secs(30)) => format!("FAIL {url}  timed out"),
    };
    oauth::disallow_interactive_oauth(&name);
    line
}

#[tokio::main]
async fn main() {
    let dir = std::env::temp_dir().join("oad-probe-sign-in");
    std::env::set_var("OPENAGENTD_CACHE_DIR", &dir);
    let urls: Vec<String> = std::env::args().skip(1).collect();
    let tasks: Vec<_> = urls.into_iter().enumerate().map(|(i, u)| tokio::spawn(probe(i, u))).collect();
    for t in tasks {
        println!("{}", t.await.unwrap());
    }
    let _ = std::fs::remove_dir_all(dir);
}
