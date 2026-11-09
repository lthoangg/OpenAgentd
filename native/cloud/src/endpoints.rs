//! The cloud's hosts. Release builds pin them: there is no way to point a
//! release build at another server, so nobody can be talked into one.

/// The device API and relay.
pub const API: &str = "https://api.openagentd.dev";
/// The account pages people open in a browser.
pub const ACCOUNT: &str = "https://account.openagentd.dev";

/// Where this build talks to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub api: String,
    pub account: String,
}

impl Endpoints {
    /// The production hosts.
    pub fn production() -> Self {
        Endpoints { api: API.to_string(), account: ACCOUNT.to_string() }
    }

    /// The hosts this build uses. Debug builds may point at a development
    /// cloud through `OPENAGENTD_CLOUD_API` and `OPENAGENTD_CLOUD_ACCOUNT`;
    /// release builds compile that code out.
    pub fn current() -> Self {
        #[cfg(debug_assertions)]
        {
            let api = std::env::var("OPENAGENTD_CLOUD_API").ok().filter(|v| !v.is_empty());
            let account = std::env::var("OPENAGENTD_CLOUD_ACCOUNT").ok().filter(|v| !v.is_empty());
            if api.is_some() || account.is_some() {
                return Endpoints { api: api.unwrap_or_else(|| API.to_string()), account: account.unwrap_or_else(|| ACCOUNT.to_string()) };
            }
        }
        Self::production()
    }

    /// Any hosts, for tests against a local fake cloud. Debug builds only.
    #[cfg(debug_assertions)]
    pub fn custom(api: &str, account: &str) -> Self {
        Endpoints { api: api.trim_end_matches('/').to_string(), account: account.trim_end_matches('/').to_string() }
    }

    /// The page a person opens to approve a device code. Built from the
    /// pinned account host and a checked user code, never from a URL in a
    /// response.
    pub fn device_page(&self, user_code: &str) -> Option<String> {
        valid_user_code(user_code).then(|| format!("{}/device?code={}", self.account, user_code))
    }

    /// The account pages' home, for "Keep account" while an account is
    /// closing.
    pub fn account_home(&self) -> String {
        format!("{}/", self.account)
    }

    /// The relay's WebSocket base (`wss://` for `https://`).
    pub fn relay_base(&self) -> String {
        if let Some(rest) = self.api.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.api.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.api.clone()
        }
    }
}

/// RFC 8628 user codes as the cloud issues them: `XXXX-XXXX` from
/// `BCDFGHJKLMNPQRSTVWXZ`.
pub fn valid_user_code(code: &str) -> bool {
    const ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
    let b = code.as_bytes();
    b.len() == 9 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || ALPHABET.contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_page_is_on_the_account_host_with_a_checked_code() {
        let e = Endpoints::production();
        assert_eq!(e.device_page("BCDF-GHJK").unwrap(), "https://account.openagentd.dev/device?code=BCDF-GHJK");
        assert_eq!(e.device_page("BCDF-GHJA"), None, "A is not in the alphabet");
        assert_eq!(e.device_page("BCDF-GHJK&next=https://evil.example"), None);
        assert_eq!(e.relay_base(), "wss://api.openagentd.dev");
    }
}
