use super::*;

fn dp(ws: &Path) -> DeniedPaths {
    DeniedPaths::with(ws, None, Some(vec![]), Some(vec![]))
}

fn ctx(ws: &Path, mode: &str) -> ToolContext {
    let mut meta = serde_json::Map::new();
    meta.insert("interaction_mode".into(), json!(mode));
    ToolContext {
        session_id: None,
        agent_name: "lead".into(),
        tool_call_id: "c1".into(),
        denied: std::sync::Arc::new(dp(ws)),
        workspace: Some(ws.display().to_string()),
        output: None,
        metadata: std::sync::Arc::new(std::sync::Mutex::new(meta)),
        messages: None,
    }
}

async fn run_patch(ctx: &ToolContext, body: &str) -> Result<String, String> {
    let text = format!("*** Begin Patch\n{body}\n*** End Patch");
    match PatchTool.run(ctx, json!({"patch_text": text})).await {
        Ok(ToolOutput::Text(t)) => Ok(t),
        Ok(other) => Err(format!("{other:?}")),
        Err(e) => Err(e.to_string()),
    }
}

/// The memory rules tell the lead to save in the same turn, in every
/// mode; memory pages live outside the project, so Plan mode's
/// "project files stay unchanged" does not cover them.
#[test]
fn plan_mode_allows_the_global_memory_root_only() {
    let t = tempfile::tempdir().unwrap();
    let ws = t.path().join("ws");
    let memory = t.path().join("config").join("memory");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&memory).unwrap();
    let (ws, memory) = (crate::denied::resolve(&ws), crate::denied::resolve(&memory));

    assert_eq!(plan_mode_refusal(&ws, &memory.join("preferences.md"), &memory), None);
    assert_eq!(plan_mode_refusal(&ws, &memory.join("projects").join("shop.md"), &memory), None);
    // A memory-looking folder inside the project is still a project file.
    let in_project = ws.join(".openagentd").join("memory").join("notes.md");
    assert!(plan_mode_refusal(&ws, &in_project, &memory).is_some());
    assert!(plan_mode_refusal(&ws, &ws.join("src.txt"), &memory).is_some());
}

#[tokio::test]
async fn plan_mode_writes_only_plan_attachments() {
    let t = tempfile::tempdir().unwrap();
    let ws = t.path().join("ws");
    std::fs::create_dir_all(ws.join(".agents/plans")).unwrap();
    std::fs::write(ws.join(".agents/plans/p-1.md"), "# P\n").unwrap();
    std::fs::write(ws.join("src.txt"), "a\n").unwrap();
    let plan = ctx(&ws, "plan");

    run_patch(&plan, "*** Add File: .agents/plans/p-1/mockup.html\n+<p>hi</p>").await.unwrap();
    run_patch(&plan, "*** Update File: .agents/plans/p-1/mockup.html\n@@\n-<p>hi</p>\n+<p>hello</p>").await.unwrap();
    assert_eq!(std::fs::read_to_string(ws.join(".agents/plans/p-1/mockup.html")).unwrap(), "<p>hello</p>\n");

    let outside = run_patch(&plan, "*** Update File: src.txt\n@@\n-a\n+b").await.unwrap_err();
    assert!(outside.starts_with("In Plan mode, patch only writes plan attachments") && outside.contains("'src.txt'"), "{outside}");
    let plan_file = run_patch(&plan, "*** Update File: .agents/plans/p-1.md\n@@\n-# P\n+# Q").await.unwrap_err();
    assert!(plan_file.contains("write the plan itself with the plan tool"), "{plan_file}");
    let ignore = run_patch(&plan, "*** Add File: .agents/plans/.gitignore\n+x").await.unwrap_err();
    assert!(ignore.contains("plan tool"), "{ignore}");
    let escape = run_patch(&plan, "*** Add File: .agents/plans/p-1/../../../x.txt\n+x").await.unwrap_err();
    assert!(escape.contains("is outside it"), "{escape}");
    let moved = run_patch(&plan, "*** Update File: .agents/plans/p-1/mockup.html\n*** Move to: docs/mockup.html\n@@\n-<p>hello</p>\n+<p>moved</p>").await.unwrap_err();
    // The refusal shows the path in the platform's form (`docs\mockup.html` on Windows).
    let shown = std::path::Path::new("docs").join("mockup.html").display().to_string();
    assert!(moved.contains(&format!("'{shown}'")), "{moved}");
    assert_eq!(std::fs::read_to_string(ws.join("src.txt")).unwrap(), "a\n", "nothing outside was written");
    assert!(!ws.join("docs").exists());

    // Code mode is unrestricted.
    run_patch(&ctx(&ws, "code"), "*** Update File: src.txt\n@@\n-a\n+b").await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn plan_mode_refuses_a_symlink_out_of_the_plans_folder() {
    let t = tempfile::tempdir().unwrap();
    let (ws, outside) = (t.path().join("ws"), t.path().join("outside"));
    std::fs::create_dir_all(ws.join(".agents/plans")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, ws.join(".agents/plans/p-1")).unwrap();
    let err = run_patch(&ctx(&ws, "plan"), "*** Add File: .agents/plans/p-1/x.html\n+x").await.unwrap_err();
    assert!(err.contains("is outside it"), "{err}");
    assert!(!outside.join("x.html").exists());

    // A symlinked `.agents` that leaves the workspace is refused too.
    let ws2 = t.path().join("ws2");
    std::fs::create_dir_all(&ws2).unwrap();
    std::fs::create_dir_all(outside.join("plans/p")).unwrap();
    std::os::unix::fs::symlink(&outside, ws2.join(".agents")).unwrap();
    let err = run_patch(&ctx(&ws2, "plan"), "*** Add File: .agents/plans/p/x.html\n+x").await.unwrap_err();
    assert!(err.contains("is outside it"), "{err}");
}

#[test]
fn add_update_delete_move() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    let (out, _) = apply_patch(&d, "*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch").unwrap();
    assert!(out.starts_with("@@ openagentd-diff-meta {\"files\":[{\"path\":\"a.txt\",\"hunks\":[{\"old_start\":1,\"new_start\":1}]}]}\nPatch applied successfully."));
    apply_patch(&d, "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n one\n-two\n+three\n*** End Patch").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("b.txt")).unwrap(), "one\nthree\n");
    assert!(!t.path().join("a.txt").exists());
    let e = apply_patch(&d, "*** Begin Patch\n*** Update File: b.txt\n@@\n one\n*** End Patch").unwrap_err();
    assert!(e.to_string().contains("would change nothing"));
    let e = apply_patch(&d, "*** Begin Patch\n*** Update File: b.txt\n@@\n-missing\n+x\n*** End Patch").unwrap_err();
    assert!(e.to_string().starts_with("Could not find patch context in b.txt."));
    apply_patch(&d, "*** Begin Patch\n*** Delete File: b.txt\n*** End Patch").unwrap();
    assert!(!t.path().join("b.txt").exists());
}

/// A patch without its opening marker says which marker is missing and
/// where the text starts, so the model can resend it whole instead of
/// guessing.
#[test]
fn a_missing_envelope_marker_is_named() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    std::fs::write(t.path().join("a.txt"), "one\n").unwrap();
    let e = apply_patch(&d, "*** Update File: a.txt\n@@\n-one\n+uno\n*** End Patch").unwrap_err().to_string();
    assert!(e.contains("does not start with '*** Begin Patch'"), "{e}");
    assert!(e.contains("it starts with: `*** Update File: a.txt`"), "{e}");
    assert_eq!(std::fs::read_to_string(t.path().join("a.txt")).unwrap(), "one\n", "nothing was written");
}

/// Models sometimes leave out the closing line of an otherwise complete
/// patch. The arguments reached the tool whole (a reply cut at the output
/// limit never does), so the patch applies as written.
#[test]
fn a_patch_without_its_closing_line_applies() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    std::fs::write(t.path().join("a.txt"), "one\ntwo\n").unwrap();
    apply_patch(&d, "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n two").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("a.txt")).unwrap(), "uno\ntwo\n", "the last line is part of the hunk");
    apply_patch(&d, "*** Begin Patch\n*** Add File: b.txt\n+b\n").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("b.txt")).unwrap(), "b\n");
    // Everything else about the patch is still checked.
    let e = apply_patch(&d, "*** Begin Patch\n*** Update File: a.txt\n@@\n-missing\n+x").unwrap_err().to_string();
    assert!(e.starts_with("Could not find patch context in a.txt."), "{e}");
    let e = apply_patch(&d, "*** Begin Patch\n*** Update File: a.txt\n-uno\n+one").unwrap_err().to_string();
    assert!(e.contains("must include an '@@' hunk"), "{e}");
    let e = apply_patch(&d, "*** Begin Patch").unwrap_err().to_string();
    assert!(e.contains("no file operations"), "{e}");
    assert_eq!(std::fs::read_to_string(t.path().join("a.txt")).unwrap(), "uno\ntwo\n", "a refused patch wrote nothing");
}

/// Only a line that starts with the marker closes a patch. Text that
/// mentions it inside a line is content: with the closing line left out,
/// the patch must not be cut short there.
#[test]
fn a_marker_mentioned_inside_a_line_does_not_end_the_patch() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    apply_patch(&d, "*** Begin Patch\n*** Add File: notes.txt\n+a patch ends with *** End Patch on its own line\n+last").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("notes.txt")).unwrap(), "a patch ends with *** End Patch on its own line\nlast\n");
    // With its closing line, text after the patch is still dropped.
    apply_patch(&d, "Here it is:\n*** Begin Patch\n*** Add File: more.txt\n+says *** End Patch here\n*** End Patch\nDone.").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("more.txt")).unwrap(), "says *** End Patch here\n");
}

/// A closing marker written as a hunk line (`+*** End Patch`) is neither
/// a closing line nor, in all likelihood, a line meant for the file: the
/// patch is refused and says which it must be.
#[test]
fn a_closing_marker_behind_a_hunk_prefix_is_refused() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    for last in ["+*** End Patch", "-*** End Patch", "+*** End Patch  "] {
        let e = apply_patch(&d, &format!("*** Begin Patch\n*** Add File: c.txt\n+c\n{last}")).unwrap_err().to_string();
        assert!(e.contains(&format!("its last line is `{}`", last.trim())), "{e}");
        assert!(e.contains("'*** End Patch' on a line of its own"), "{e}");
    }
    assert!(!t.path().join("c.txt").exists(), "nothing was written");
    // Followed by a real closing line, it is a line of the file.
    apply_patch(&d, "*** Begin Patch\n*** Add File: c.txt\n+c\n+*** End Patch\n*** End Patch").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("c.txt")).unwrap(), "c\n*** End Patch\n");
}

/// A patch that stops on a file header changes nothing in that file, so
/// it is refused whole, closing line or not.
#[test]
fn a_patch_that_stops_on_a_file_header_is_refused() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    std::fs::write(t.path().join("a.txt"), "one\n").unwrap();
    std::fs::write(t.path().join("b.txt"), "two\n").unwrap();
    for end in ["", "\n*** End Patch"] {
        let e = apply_patch(&d, &format!("*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n*** Update File: b.txt{end}")).unwrap_err().to_string();
        assert!(e.contains("b.txt"), "{e}");
    }
    assert_eq!(std::fs::read_to_string(t.path().join("a.txt")).unwrap(), "one\n", "nothing was written");
}

#[test]
fn indentation_tolerant_and_crlf() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    std::fs::write(t.path().join("c.py"), "def f():\r\n    return 1\r\n").unwrap();
    apply_patch(&d, "*** Begin Patch\n*** Update File: c.py\n@@ def f():\n-return 1\n+return 2\n*** End Patch").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("c.py")).unwrap(), "def f():\r\n    return 2\r\n");
}

#[test]
fn failing_later_file_leaves_earlier_files_untouched() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    std::fs::write(t.path().join("a.txt"), "one\n").unwrap();
    let e = apply_patch(&d, "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n*** Add File: new/b.txt\n+b\n*** Update File: missing.txt\n@@\n-x\n+y\n*** End Patch")
        .unwrap_err();
    assert!(e.to_string().contains("File not found"), "{e}");
    assert_eq!(std::fs::read_to_string(t.path().join("a.txt")).unwrap(), "one\n");
    assert!(!t.path().join("new").exists());
}

#[test]
fn multi_file_patch_reports_every_changed_path_once() {
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    std::fs::write(t.path().join("a.txt"), "one\ntwo\n").unwrap();
    let (out, changed) =
        apply_patch(&d, "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n*** Update File: a.txt\n@@\n-two\n+dos\n*** Add File: b.txt\n+b\n*** End Patch").unwrap();
    assert_eq!(std::fs::read_to_string(t.path().join("a.txt")).unwrap(), "uno\ndos\n");
    assert_eq!(changed.len(), 2);
    assert!(out.ends_with("Updated paths:\na.txt\nb.txt"), "{out}");
}

#[cfg(unix)]
#[test]
fn update_keeps_file_mode() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempfile::tempdir().unwrap();
    let d = dp(t.path());
    let p = t.path().join("run.sh");
    std::fs::write(&p, "echo 1\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    apply_patch(&d, "*** Begin Patch\n*** Update File: run.sh\n@@\n-echo 1\n+echo 2\n*** End Patch").unwrap();
    assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o7777, 0o755);
}
