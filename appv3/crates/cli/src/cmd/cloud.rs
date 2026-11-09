//! `agentd cloud`: this computer's OpenAgentd Cloud account.
//!
//! Optional: local use and LAN pairing never need it. Signing in lets the
//! person's phone reach this computer from anywhere through the end-to-end
//! encrypted relay. A computer joins an account the phone set up: by the
//! invitation link the phone shows (`join`, the default), or by signing in
//! and comparing a 6-digit code on the phone (`login`, the fallback).

use crate::cli::CloudCmd;
use crate::net::{display_host, http_get_with_headers, http_post_with_headers, resolve_addr, server_settings};
use crate::ui::{bold, cyan, dim, field, green, yellow};
use anyhow::{anyhow, Result};
use appv3_api::cloud::{engine, identity_store};
use openagentd_cloud::code;
use openagentd_cloud::endpoints::Endpoints;
use openagentd_cloud::flows::{self, GenesisDraft};
use openagentd_cloud::recovery;
use openagentd_cloud::roster;
use openagentd_cloud::store::{self as idstore, SecretStore};
use serde_json::Value;
use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::time::Duration;

pub fn cloud(cmd: &CloudCmd) -> Result<ExitCode> {
    match cmd {
        CloudCmd::Join => join(),
        CloudCmd::Login { first_device } => login(*first_device),
        CloudCmd::Status => status(),
        CloudCmd::Logout { yes } => logout(*yes),
    }
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread().enable_all().build()?)
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(30)).build().unwrap_or_default()
}

/// The local server, if it runs, and the key it enforces.
fn local_server() -> Option<(String, u16, String)> {
    let cfg = server_settings().ok()?;
    let (host, port) = resolve_addr(None, None, &cfg);
    Some((display_host(&host), port, appv3_core::auth::configured_access_token()))
}

fn call_server(post: bool, path: &str) -> Option<(u16, Value)> {
    let (host, port, key) = local_server()?;
    let bearer = format!("Bearer {key}");
    let headers: Vec<(&str, &str)> = if key.is_empty() { vec![] } else { vec![("Authorization", bearer.as_str())] };
    let f = if post { http_post_with_headers } else { http_get_with_headers };
    let (status, body) = f(&host, port, path, &headers, Duration::from_secs(5))?;
    Some((status, serde_json::from_slice(&body).unwrap_or_default()))
}

/// Tells a running server to pick up the stored identity.
fn notify_server() {
    match call_server(true, "/api/cloud/reload") {
        Some((200, _)) => println!("  {}", dim("The running server connected to your account.")),
        Some(_) | None => println!("  {}", dim("The server connects on its next start, or now if it is running.")),
    }
}

fn prompt(label: &str) -> Result<String> {
    print!("{label}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line)? == 0 {
        return Err(anyhow!("no input"));
    }
    Ok(line.trim().to_string())
}

/// Whether this computer already has an account (and says so).
fn already_signed_in(store: &idstore::FileStore) -> Result<bool> {
    if let Some(id) = idstore::load(store)? {
        if id.account_id.is_some() {
            println!("\n  This computer is already signed in ({}).", bold(&id.keys()?.fingerprint()));
            println!("  {}\n", dim("Run agentd cloud logout first to use another account."));
            return Ok(true);
        }
    }
    Ok(false)
}

/// Joins with the invitation link the phone shows. The link works like a
/// password, so it is read without echo, never from the command line
/// (shell history), and never stored.
fn join() -> Result<ExitCode> {
    let store = identity_store();
    if already_signed_in(&store)? {
        return Ok(ExitCode::SUCCESS);
    }
    println!();
    println!("  Join your account to reach this computer from your devices. {}", dim("(optional; local use needs no account)"));
    println!("  On your phone: OpenAgentd → Settings → Account → Add a device → Can't scan? Use a link.");
    println!();
    let link = zeroize::Zeroizing::new(crate::ui::read_secret("  Invitation link (hidden): ")?);
    if openagentd_cloud::invite::parse_link(&link).is_err() {
        println!("\n  {} That is not an invitation link. Copy it again from your phone.\n", yellow("!"));
        return Ok(ExitCode::FAILURE);
    }
    let rt = runtime()?;
    let outcome = rt.block_on(engine::join_invite(Endpoints::current(), http(), &link, |event| {
        if let engine::Event::Invited { fingerprint, kind } = event {
            println!();
            field("Device", &format!("{}   {}", bold(&fingerprint), dim(kind.unwrap_or("computer"))));
            println!();
            println!("  On your phone, check it shows this device, then tap Add.");
            println!("  {}", dim("Waiting for your phone… (Ctrl-C to cancel)"));
        }
    }));
    drop(link);
    match outcome {
        Ok(engine::Outcome::Joined(identity)) => {
            idstore::save(&store, &identity)?;
            println!("  {} Joined your account. This computer is reachable from your devices.", green("✓"));
            notify_server();
            println!();
            Ok(ExitCode::SUCCESS)
        }
        Ok(engine::Outcome::EmptyAccount { .. }) => Ok(ExitCode::FAILURE),
        Err(e) => {
            let msg = match engine::notice(&e) {
                appv3_api::cloud::Notice::JoinEnded => "The invitation ended: it expired, was cancelled, or was used.\n    Ask your phone for a new one.".to_string(),
                appv3_api::cloud::Notice::ConfirmMismatch => "The account's answer did not match the invitation. Nothing was changed.".to_string(),
                appv3_api::cloud::Notice::InviteInvalid => "That is not an invitation link. Copy it again from your phone.".to_string(),
                _ => problem_message(&e),
            };
            println!("\n  {} {msg}\n", yellow("!"));
            Ok(ExitCode::FAILURE)
        }
    }
}

fn login(first_device: bool) -> Result<ExitCode> {
    let store = identity_store();
    if already_signed_in(&store)? {
        return Ok(ExitCode::SUCCESS);
    }
    println!();
    println!("  Sign in to reach this computer from your devices. {}", dim("(optional; local use needs no account)"));
    println!();
    let rt = runtime()?;
    let outcome = rt.block_on(engine::sign_in(Endpoints::current(), http(), |event| match event {
        engine::Event::Code(c) => {
            field("Open", &cyan(&c.url));
            field("Code", &bold(&c.user_code));
            field("Device", &format!("{}   {}", bold(&c.fingerprint), dim("check the page shows the same")));
            println!();
            println!("  Waiting for approval… {}", dim(&format!("(Ctrl-C to cancel, expires in {} min)", c.expires_in / 60)));
            println!("  {}", dim("If your browser says you are on the waitlist, you can finish once you are approved."));
        }
        engine::Event::Joining { code: None, .. } => {
            println!("  {} Signed in.", green("✓"));
            println!();
            println!("  Approve this computer on your phone: OpenAgentd → Settings → Account.");
            println!("  {}", dim("Waiting for your phone…"));
        }
        engine::Event::Joining { code: Some(c), .. } => {
            field("Code to compare", &bold(&code::display(&c)));
        }
        engine::Event::Invited { .. } => {}
    }));
    match outcome {
        Ok(engine::Outcome::Joined(identity)) => {
            idstore::save(&store, &identity)?;
            println!("  {} Joined your account. This computer is reachable from your devices.", green("✓"));
            notify_server();
            println!();
            Ok(ExitCode::SUCCESS)
        }
        Ok(engine::Outcome::EmptyAccount { mut member, session }) => {
            if !first_device {
                println!();
                println!("  {} This account has no devices yet. Set it up in the OpenAgentd", yellow("!"));
                println!("    app on your phone first, then run agentd cloud login again.");
                println!("    {}", dim("No phone? agentd cloud login --first-device sets it up here."));
                println!();
                return Ok(ExitCode::FAILURE);
            }
            println!();
            println!("  {} This computer will be the account's first device and the only one", yellow("!"));
            println!("    that can approve others. Its signing key is kept in a file only you can read.");
            let draft = GenesisDraft::new();
            if !confirm_recovery_code(&draft)? {
                println!("  Cancelled. Nothing was created.\n");
                return Ok(ExitCode::FAILURE);
            }
            let r = rt.block_on(flows::genesis(&mut member, &session, draft)).map_err(|e| anyhow!("could not create the account: {}", engine::reason(&e)))?;
            idstore::save(&store, &engine::identity_of(&member, &r))?;
            println!("  {} Account set up. This computer is reachable from your devices.", green("✓"));
            notify_server();
            println!();
            Ok(ExitCode::SUCCESS)
        }
        Err(e) => {
            let msg = match engine::notice(&e) {
                appv3_api::cloud::Notice::Denied => "Sign-in was denied on the account page.".to_string(),
                appv3_api::cloud::Notice::Expired => {
                    "The sign-in code expired. If your browser said you are on the waitlist,\n    run agentd cloud login again once you are approved.".to_string()
                }
                appv3_api::cloud::Notice::JoinEnded => "The request to join was cancelled or expired.".to_string(),
                appv3_api::cloud::Notice::CommitMismatch => "The request was cancelled: the codes did not match.".to_string(),
                _ => problem_message(&e),
            };
            println!("\n  {} {msg}\n", yellow("!"));
            Ok(ExitCode::FAILURE)
        }
    }
}

fn problem_message(e: &flows::FlowError) -> String {
    use openagentd_cloud::account_state::AccountProblem as P;
    match e {
        flows::FlowError::Problem(P::Closing { deletes_at }) => format!(
            "Account scheduled for deletion{}. To keep it, sign in at\n    {} and choose Keep account.\n    This server keeps running; only remote access is paused.",
            deletes_at.map(|ms| format!(" on {}", date(ms))).unwrap_or_default(),
            Endpoints::current().account_home()
        ),
        flows::FlowError::Problem(P::Unavailable) => {
            "Account unavailable. Contact OpenAgentd if this continues.\n    This server keeps running; only remote access is paused.".to_string()
        }
        flows::FlowError::Problem(P::Deleted) => "This account was deleted. This server keeps running on its own; signing in again starts a new account.".to_string(),
        flows::FlowError::Problem(P::Revoked) => "This computer was removed from the account. It keeps running on its own; signing in again joins as a new device.".to_string(),
        other => format!("Could not sign in ({}).", engine::reason(other)),
    }
}

fn date(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).map(|d| d.format("%-d %b %Y").to_string()).unwrap_or_default()
}

/// Shows the recovery code once and asks for two of its groups back.
fn confirm_recovery_code(draft: &GenesisDraft) -> Result<bool> {
    println!();
    println!("  {}", bold("Save your recovery code."));
    println!("  If you lose every device that can approve others, this code is the only");
    println!("  way back into your account. OpenAgentd can't recover it for you.");
    println!();
    let groups: Vec<&str> = draft.code.split('-').collect();
    for row in groups.chunks(5) {
        println!("    {}", bold(&row.join("-")));
    }
    println!();
    let (a, b) = draft.check_groups();
    for n in [a, b] {
        let typed = prompt(&format!("  Type group {n}: "))?;
        if !recovery::group_matches(&draft.code, n, &typed) {
            println!("  {} That is not group {n}.", yellow("!"));
            return Ok(false);
        }
    }
    Ok(true)
}

fn status() -> Result<ExitCode> {
    let store = identity_store();
    println!();
    let Some(id) = idstore::load(&store)?.filter(|i| i.account_id.is_some()) else {
        field("Account", "not signed in");
        println!("  {}", dim("Optional: agentd cloud login lets your phone reach this computer from anywhere."));
        println!();
        return Ok(ExitCode::SUCCESS);
    };
    let keys = id.keys()?;
    let signer = id.roster.as_deref().and_then(|b| roster::parse(b).ok()).and_then(|r| r.body.device(&keys.id()).map(|d| d.signer)).unwrap_or(false);
    field("Account", &format!("signed in · {}", if signer { "approves devices" } else { "member" }));
    field("Device", &format!("{}  {}", bold(&keys.fingerprint()), dim(&format!("({})", openagentd_cloud::api::this_kind().unwrap_or("device")))));
    field("Keys", &format!("{} {}", store.kind(), dim(&crate::ui::tilde(store.path()))));
    match call_server(false, "/api/cloud/status") {
        Some((200, v)) => field("Relay", &relay_line(&v)),
        _ => field("Relay", &dim("server not running")),
    }
    println!();
    Ok(ExitCode::SUCCESS)
}

/// The relay line of `agentd cloud status` and `agentd server status`.
pub fn relay_line(v: &Value) -> String {
    match v["state"].as_str() {
        Some("connected") => match v["relay"]["state"].as_str() {
            Some("online") => green("online"),
            Some("paused") => yellow("paused: today's relay allowance is used up"),
            Some("connecting") => dim("connecting"),
            _ => yellow("offline, retrying"),
        },
        Some("closing") => yellow("paused: account scheduled for deletion"),
        Some("unavailable") => yellow("paused: account unavailable"),
        Some(other) => dim(other),
        None => dim("unknown"),
    }
}

/// `Cloud: online · 3F9A 21C4 …` for `agentd server status`, only when
/// this computer is signed in: a guest's status output is unchanged.
pub(crate) fn server_status_line() -> Option<String> {
    let (200, v) = call_server(false, "/api/cloud/status")? else { return None };
    if matches!(v["state"].as_str(), None | Some("guest")) {
        return None;
    }
    let fp = v["fingerprint"].as_str().unwrap_or_default();
    Some(format!("{} · {}", relay_line(&v), bold(fp)))
}

fn logout(yes: bool) -> Result<ExitCode> {
    let store = identity_store();
    if idstore::load(&store)?.filter(|i| i.account_id.is_some()).is_none() {
        println!("\n  Not signed in.\n");
        return Ok(ExitCode::SUCCESS);
    }
    println!();
    println!("  This computer stops being reachable through your account.");
    if !yes {
        let answer = prompt("  Local sessions and settings stay. Continue? [y/N] ")?;
        if !matches!(answer.as_str(), "y" | "Y" | "yes") {
            println!();
            return Ok(ExitCode::FAILURE);
        }
    }
    // A running server does it (and closes its sessions); otherwise here.
    match call_server(true, "/api/cloud/logout") {
        Some((200, _)) => {}
        _ => {
            if let Some(id) = idstore::load(&store)? {
                let cloud = openagentd_cloud::api::Cloud::new(http(), Endpoints::current(), id.keys()?, id.account_id.clone());
                let _ = runtime()?.block_on(cloud.leave());
            }
            store.clear()?;
        }
    }
    println!("  {} Signed out. Keys erased from this computer.\n", green("✓"));
    Ok(ExitCode::SUCCESS)
}
