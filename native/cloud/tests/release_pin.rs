//! A release build ignores every host override.

use std::process::Command;

#[test]
fn release_builds_use_the_production_hosts_whatever_the_environment() {
    let out = Command::new(env!("CARGO"))
        .args(["run", "--quiet", "--release", "--example", "endpoints"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("OPENAGENTD_CLOUD_API", "https://attacker.example")
        .env("OPENAGENTD_CLOUD_ACCOUNT", "https://attacker.example")
        .output()
        .expect("cargo runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "https://api.openagentd.dev https://account.openagentd.dev");
}

#[test]
fn debug_builds_may_use_a_development_cloud() {
    let out = Command::new(env!("CARGO"))
        .args(["run", "--quiet", "--example", "endpoints"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("OPENAGENTD_CLOUD_API", "http://127.0.0.1:9")
        .output()
        .expect("cargo runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("http://127.0.0.1:9 "));
}
