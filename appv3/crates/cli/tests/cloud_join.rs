//! `agentd server start --cloud` against the fake cloud of
//! `native/cloud/tests/fake_cloud`: the server starts, the computer signs
//! in, a phone that set up the account approves it with the 6-digit code,
//! and the server keeps running, in the account. Throw-away `HOME`/XDG
//! roots and synthetic keys only.
//!
//! Unix only, like serve_shutdown.rs: on Windows the daemon inherits the
//! CLI's captured stdout pipe, so `wait_with_output()` never returns.
#![cfg(unix)]

#[path = "../../../../native/cloud/tests/fake_cloud/mod.rs"]
mod fake_cloud;

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use openagentd_cloud::api::Cloud;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, GenesisDraft, Grant, Member, Pace};
use openagentd_cloud::keys::{DeviceKeys, Roles};

const PACE: Pace = Pace { every: Duration::from_millis(50), timeout: Duration::from_secs(60) };
const ACCOUNT_PAGES: &str = "https://account.openagentd.dev";

struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        Sandbox { root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.path().join(rel)
    }

    fn command(&self, args: &[&str], cloud: &str) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentd"));
        cmd.args(args).current_dir(self.root.path()).stdin(Stdio::null());
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
            ("HOME", "home"),
            ("USERPROFILE", "home"),
        ] {
            cmd.env(k, self.path(d));
        }
        cmd.env("OPENAGENTD_ENV", "production")
            .env("NO_COLOR", "1")
            .env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false")
            .env("OPENAGENTD_SNAPSHOT_MAINTENANCE_ENABLED", "false")
            .env("OPENAGENTD_RELEASES_URL", "http://127.0.0.1:9")
            .env("OPENAGENTD_CLOUD_API", cloud)
            .env("OPENAGENTD_CLOUD_ACCOUNT", ACCOUNT_PAGES);
        for k in
            ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "OPENAGENTD_HANDSHAKE_FILE", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "RUST_LOG", "LOG_LEVEL", "AGENTD_AGENT"]
        {
            cmd.env_remove(k);
        }
        cmd
    }

    fn run(&self, args: &[&str], cloud: &str) -> Output {
        self.command(args, cloud).output().expect("run agentd")
    }
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// A phone that set up `account` (genesis): it approves devices.
async fn phone_with_account(fake: &fake_cloud::Fake, base: &str) -> (Member, String) {
    let account = fake.new_account();
    let mut cloud = Cloud::new(reqwest::Client::new(), Endpoints::custom(base, ACCOUNT_PAGES), DeviceKeys::generate(), None);
    cloud.roles = Roles::CLIENT;
    let code = cloud.device_code().await.unwrap();
    fake.approve(&code.user_code, &account);
    let session = flows::wait_for_session(&cloud, &code).await.unwrap();
    let mut phone = Member::new(cloud, None);
    flows::genesis(&mut phone, &session, GenesisDraft::new()).await.unwrap();
    assert!(phone.is_signer());
    (phone, account)
}

/// The user code a device other than `known` is waiting on.
async fn new_code(fake: &fake_cloud::Fake, known: &[String]) -> String {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let found = fake.0.lock().unwrap().codes.values().find(|r| r.status == fake_cloud::CodeStatus::Pending && !known.contains(&r.user_code)).map(|r| r.user_code.clone());
        if let Some(code) = found {
            return code;
        }
        assert!(Instant::now() < deadline, "the computer never asked for a sign-in code");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[test]
fn start_with_cloud_joins_the_account_and_keeps_serving() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let fake = fake_cloud::Fake::new();
    let base = rt.block_on(fake.serve());
    let (mut phone, account) = rt.block_on(phone_with_account(&fake, &base));
    let known: Vec<String> = fake.0.lock().unwrap().codes.values().map(|r| r.user_code.clone()).collect();

    let sb = Sandbox::new();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port().to_string();
    let start = sb.command(&["server", "start", "--port", &port, "--cloud"], &base).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();

    // The person approves the sign-in on the account page, then on the
    // phone after comparing the 6-digit code (what the phone's sheet does).
    let approved = rt.block_on(async {
        let code = new_code(&fake, &known).await;
        fake.approve(&code, &account);
        let deadline = Instant::now() + Duration::from_secs(60);
        let pending = loop {
            let list = phone.cloud.pending_list().await.unwrap();
            if let Some(p) = list.into_iter().next() {
                break p;
            }
            assert!(Instant::now() < deadline, "the computer never asked to join");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let mut approval = flows::begin_approval(&mut phone, pending).await?;
        let shown = flows::await_reveal(&mut phone, &mut approval, PACE).await?;
        assert_eq!(shown.roles, Roles::SERVER, "`--cloud` asks to serve, as `agentd cloud login` does");
        flows::confirm_approval(&mut phone, approval, Grant { signer: false, roles: Roles::SERVER }).await
    });
    let started = start.wait_with_output().unwrap();
    let cloud_status = sb.run(&["cloud", "status"], &base);
    let server_status = sb.run(&["server", "status", "--port", &port], &base);
    let _ = sb.run(&["server", "stop"], &base);

    let out = stdout(&started);
    approved.unwrap_or_else(|e| panic!("approval failed: {e:?}\n{out}"));
    assert!(out.contains("agentd server stop"), "the server started first:\n{out}");
    assert!(out.contains("Joined your account"), "then joined:\n{out}\n{}", String::from_utf8_lossy(&started.stderr));
    assert_eq!(started.status.code(), Some(0), "{out}");
    let cloud_out = stdout(&cloud_status);
    assert!(cloud_out.contains("signed in"), "{cloud_out}");
    assert_eq!(server_status.status.code(), Some(0), "still running:\n{}", stdout(&server_status));
    assert!(stdout(&server_status).contains("Cloud:"), "the running server is in the account:\n{}", stdout(&server_status));
}
