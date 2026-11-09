//! The desktop app's approval key reaches the server on stdin and nowhere
//! else: after `read_key_from_stdin` the pipe it came through is closed in
//! this process (stdin is `/dev/null`), so no child can inherit it, and a
//! command run the way the agent's shell tool runs it sees neither the key
//! nor the pipe, and carries the agent marker.
//!
//! Separate test binary: it replaces this process's stdin.
#![cfg(unix)]

use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;

use appv3_tools::{shell::ShellTool, DeniedPaths, Tool, ToolContext, ToolOutput};
use openagentd_cloud::approval;

/// `(st_dev, st_ino)` of an open descriptor, or `None` when it is closed.
fn identity(fd: i32) -> Option<(u64, u64)> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::fstat(fd, &mut st) } == 0).then_some((st.st_dev as u64, st.st_ino as u64))
}

fn ctx(dir: &std::path::Path) -> ToolContext {
    ToolContext {
        session_id: None,
        agent_name: "t".into(),
        tool_call_id: "c".into(),
        denied: Arc::new(DeniedPaths::with(dir, None, Some(vec![]), Some(vec![]))),
        workspace: None,
        output: None,
        metadata: Default::default(),
        messages: None,
    }
}

/// Runs `command` the way the agent runs commands.
async fn agent_runs(dir: &std::path::Path, command: &str) -> String {
    let out = ShellTool.run(&ctx(dir), serde_json::json!({ "command": command })).await.unwrap();
    let ToolOutput::Text(text) = out else { panic!("unexpected output {out:?}") };
    text
}

/// The descriptors open in a command the agent runs (after `FDS:`).
async fn child_fds(dir: &std::path::Path) -> std::collections::BTreeSet<u32> {
    let text = agent_runs(dir, "echo FDS:; ls /dev/fd/").await;
    text.rsplit("FDS:").next().unwrap().split_whitespace().filter_map(|w| w.parse().ok()).collect()
}

#[tokio::test]
async fn the_key_comes_over_stdin_and_no_child_can_reach_it() {
    let dir = tempfile::tempdir().unwrap();
    // What a child inherits before the app's pipe exists (the test runner
    // may pass some of its own, such as cargo's jobserver).
    let before = child_fds(dir.path()).await;
    let key = [0x5a_u8; approval::KEY_LEN];
    let line = format!("{}\n", openagentd_cloud::encoding::b64(&key));

    // The app's side: a pipe, the key line written, its end closed.
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let (read_end, write_end) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    let pipe = identity(read_end.as_raw_fd()).unwrap();
    std::fs::File::from(write_end).write_all(line.as_bytes()).unwrap();
    // The server's side: the read end is its stdin, and nothing else.
    assert!(unsafe { libc::dup2(read_end.as_raw_fd(), 0) } == 0);
    drop(read_end);

    let got = appv3_api::cloud::approval::read_key_from_stdin().expect("the key arrived");
    assert_eq!(*got, key);

    // The pipe is closed everywhere in this process: stdin is /dev/null and
    // no descriptor refers to the pipe, so no child can inherit it.
    let null = std::fs::metadata("/dev/null").unwrap();
    let null = {
        use std::os::unix::fs::MetadataExt;
        (null.dev(), null.ino())
    };
    assert_eq!(identity(0), Some(null), "stdin is /dev/null");
    for fd in 0..1024 {
        assert_ne!(identity(fd), Some(pipe), "fd {fd} still holds the key's pipe");
    }

    // A command run the way the agent runs commands.
    let text = agent_runs(dir.path(), "env; echo STDIN:; cat; echo :STDIN").await;
    let encoded = openagentd_cloud::encoding::b64(&key);
    assert!(!text.contains(&encoded), "the key reached the agent's command: {text}");
    assert!(text.contains("STDIN:\n:STDIN"), "stdin gives the agent's command nothing: {text}");
    assert!(text.contains("AGENTD_AGENT=1"), "the agent's command carries the marker: {text}");
    // And it inherits no descriptor it did not inherit before.
    let after = child_fds(dir.path()).await;
    assert!(after.is_subset(&before), "the child inherited more descriptors: {before:?} -> {after:?}");
}
