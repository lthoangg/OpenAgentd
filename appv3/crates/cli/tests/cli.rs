//! `agentd` commands against the real binary in throw-away `HOME`/XDG
//! roots. Nothing here touches real user data.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

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

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let p = self.path(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        p
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_bin(env!("CARGO_BIN_EXE_agentd"), args)
    }

    fn run_bin(&self, bin: &str, args: &[&str]) -> Output {
        let mut cmd = Command::new(bin);
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
        cmd.env("APP_ENV", "production").env("NO_COLOR", "1").env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false").env("SNAPSHOT_MAINTENANCE_ENABLED", "false");
        for k in [
            "OPENAGENTD_DESKTOP_TOKEN",
            "OPENAGENTD_ACCESS_KEY",
            "OPENAGENTD_HANDSHAKE_FILE",
            "DATABASE_URL",
            "AGENTS_DIR",
            "SKILLS_DIR",
            "RUST_LOG",
            "LOG_LEVEL",
            "OPENAI_API_KEY",
        ] {
            cmd.env_remove(k);
        }
        cmd.output().expect("run agentd")
    }
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap_or(-1)
}

#[test]
fn version_prints_the_release_string() {
    let o = Sandbox::new().run(&["--version"]);
    assert_eq!(code(&o), 0);
    assert_eq!(stdout(&o), format!("agentd v{}\n", env!("CARGO_PKG_VERSION")));
}

#[test]
fn openagentd_alias_forwards_to_agentd() {
    let sb = Sandbox::new();
    let o = sb.run_bin(env!("CARGO_BIN_EXE_openagentd"), &["--version"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(stdout(&o), format!("agentd v{}\n", env!("CARGO_PKG_VERSION")));
    assert_eq!(stderr(&o), "", "no deprecation note off a terminal");
    let o = sb.run_bin(env!("CARGO_BIN_EXE_openagentd"), &["bogus"]);
    assert_eq!(code(&o), 2, "exit codes are forwarded");
}

#[test]
fn bare_agentd_prints_help_without_starting_a_server() {
    let sb = Sandbox::new();
    let o = sb.run(&[]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    let out = stdout(&o);
    assert!(out.contains("Usage: agentd") && out.contains("server"), "{out}");
    assert!(!sb.path("state/openagentd.pid").exists(), "no daemon may start");
}

#[test]
fn unknown_commands_are_usage_errors() {
    let o = Sandbox::new().run(&["bogus"]);
    assert_eq!(code(&o), 2);
    assert!(stderr(&o).contains("error:"), "{}", stderr(&o));
}

#[test]
fn status_of_a_stopped_server_fails_and_health_is_the_same_command() {
    let sb = Sandbox::new();
    for cmd in ["status", "health"] {
        let o = sb.run(&["server", cmd]);
        assert_eq!(code(&o), 1, "server {cmd}");
        assert!(stdout(&o).contains("stopped"), "{}", stdout(&o));
    }
    let o = sb.run(&["server", "logs"]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("no server log"), "{}", stderr(&o));
    let o = sb.run(&["server", "status", "--qr"]);
    assert_eq!(code(&o), 1);
    assert!(stdout(&o).contains("stopped") && !stdout(&o).contains('█'), "{}", stdout(&o));
}

#[test]
fn public_needs_an_access_key_and_conflicts_with_host() {
    let sb = Sandbox::new();
    let o = sb.run(&["server", "start", "--public", "--qr"]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("refusing to listen on 0.0.0.0"), "{}", stderr(&o));
    assert!(!sb.path("state/openagentd.pid").exists(), "no daemon may start");
    let o = sb.run(&["server", "start", "--public", "--host", "1.2.3.4"]);
    assert_eq!(code(&o), 2);
    assert!(stderr(&o).contains("cannot be used with"), "{}", stderr(&o));
}

fn provider_line(out: &str, id: &str) -> String {
    out.lines().find(|l| l.trim_start().starts_with(id)).unwrap_or_else(|| panic!("no {id} line in:\n{out}")).to_string()
}

#[test]
fn auth_list_shows_logins_and_logout_removes_them() {
    let sb = Sandbox::new();
    let out = stdout(&sb.run(&["auth", "list"]));
    for id in ["codex", "copilot", "grok"] {
        assert!(provider_line(&out, id).contains("not logged in"), "{out}");
    }
    let token = sb.write("cache/codex_oauth.json", "{}");
    let out = stdout(&sb.run(&["auth"]));
    assert!(!provider_line(&out, "codex").contains("not logged in"), "{out}");

    let o = sb.run(&["auth", "logout", "codex"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stdout(&o).contains("Logged out of codex"), "{}", stdout(&o));
    assert!(!token.exists());
    assert!(stdout(&sb.run(&["auth", "logout", "codex"])).contains("was not logged in"));
}

#[test]
fn doctor_reads_provider_keys_from_the_config_env() {
    let sb = Sandbox::new();
    sb.write("config/.env", "OPENAI_API_KEY=test-key\n");
    sb.write("config/agents/code.md", "---\nname: code\nmodel: openai:gpt-5.5\n---\n\nYou write code.\n");
    let o = sb.run(&["doctor"]);
    let out = stdout(&o);
    assert_eq!(code(&o), 0, "{out}");
    assert!(out.contains("API key: OPENAI_API_KEY"), "{out}");
    assert!(out.contains("Lead agent key is set: OPENAI_API_KEY"), "{out}");
}

#[test]
fn doctor_fails_an_oauth_lead_provider_without_a_login() {
    let sb = Sandbox::new();
    sb.write("config/agents/code.md", "---\nname: code\nmodel: codex:gpt-5.5\n---\n");
    let o = sb.run(&["doctor"]);
    assert_eq!(code(&o), 1);
    assert!(stdout(&o).contains("run `agentd auth codex`"), "{}", stdout(&o));
    sb.write("cache/codex_oauth.json", "{}");
    let o = sb.run(&["doctor"]);
    assert_eq!(code(&o), 0, "{}", stdout(&o));
    assert!(stdout(&o).contains("Lead agent provider 'codex' is logged in"));
}

#[test]
fn cleanup_without_a_database_skips_and_creates_nothing() {
    let sb = Sandbox::new();
    let o = sb.run(&["cleanup"]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert!(stdout(&o).contains("dry run") && stdout(&o).contains("Database not initialized"), "{}", stdout(&o));
    assert!(!sb.path("data/openagentd.db").exists());
}

#[test]
fn transfer_round_trip_redacts_secrets() {
    let sb = Sandbox::new();
    sb.write("config/agents/code.md", "---\nname: code\n---\nbody\n");
    sb.write("config/.env", "OPENAI_API_KEY=sk-secret\nLOG_LEVEL=INFO\n");
    let archive = sb.path("out/a.tar.gz");
    std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
    let o = sb.run(&["transfer", "export", "-o", archive.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));

    let other = sb.path("other");
    let o = sb.run(&["transfer", "import", archive.to_str().unwrap(), "--config-dir", other.to_str().unwrap()]);
    assert_eq!(code(&o), 0, "{}", stderr(&o));
    assert_eq!(std::fs::read_to_string(other.join("agents/code.md")).unwrap(), "---\nname: code\n---\nbody\n");
    assert_eq!(std::fs::read_to_string(other.join(".env")).unwrap(), "OPENAI_API_KEY=\nLOG_LEVEL=INFO\n");

    let o = sb.run(&["transfer", "import", archive.to_str().unwrap(), "--config-dir", other.to_str().unwrap()]);
    assert!(stdout(&o).contains("Skipped 2 existing file(s)"), "{}", stdout(&o));

    let bad = sb.write("bad.tar.gz", "not an archive");
    let o = sb.run(&["transfer", "import", bad.to_str().unwrap(), "--config-dir", other.to_str().unwrap()]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("not a valid tar.gz archive"), "{}", stderr(&o));
}

#[test]
fn run_rejects_unknown_sessions_and_missing_workspaces() {
    let sb = Sandbox::new();
    let o = sb.run(&["run", "--prompt", "hi", "--session", "01900000-0000-7000-8000-000000000000"]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("session not found"), "{}", stderr(&o));

    let o = sb.run(&["run", "--prompt", "hi", "-C", sb.path("missing").to_str().unwrap()]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("does not exist"), "{}", stderr(&o));

    let o = sb.run(&["run", "--prompt", "  "]);
    assert_eq!(code(&o), 1);
    assert!(stderr(&o).contains("must not be blank"), "{}", stderr(&o));
}
