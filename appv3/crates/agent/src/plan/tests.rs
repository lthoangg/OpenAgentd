use super::*;

const SID: &str = "01a0ecf9-22d0-7665-96c1-611316df61f9";

fn workspace(root: &Path) -> PlanTarget<'_> {
    PlanTarget::Workspace { root, session_id: SID, denied: None }
}

fn edit(old: &str, new: &str) -> PlanEdit {
    PlanEdit { old: old.into(), new: new.into() }
}

#[test]
fn edits_apply_in_order_and_must_match_once() {
    let plan = "## Steps\n1. Build\n2. Test\n";
    assert_eq!(apply_edits(plan, &[edit("1. Build", "1. Build it"), edit("Build it", "Compile")]).unwrap(), "## Steps\n1. Compile\n2. Test\n");
    assert_eq!(apply_edits(plan, &[edit("3. Ship", "x")]), Err(PlanError::EditNotFound(0)));
    assert_eq!(apply_edits(plan, &[edit("Build", "B"), edit("\n", "")]), Err(PlanError::EditAmbiguous(1, 3)));
    assert_eq!(apply_edits(plan, &[edit("", "x")]), Err(PlanError::EditEmpty(0)));
}

#[test]
fn file_names_come_from_the_heading_and_the_end_of_the_session_id() {
    assert_eq!(slug("Intro\n# Plan Review: Loop & UI!\nbody"), "plan-review-loop-ui");
    assert_eq!(slug("no heading"), "plan");
    assert_eq!(slug(&format!("# {}", "x".repeat(80))).len(), 48);
    assert_eq!(id8(SID), "16df61f9");
}

#[test]
fn a_workspace_plan_is_created_in_a_git_ignored_folder() {
    let d = tempfile::tempdir().unwrap();
    let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
    std::fs::create_dir_all(&root).unwrap();
    let out = save_agent(&dir, workspace(&root), PlanChange::Write("# Fix it\n1. a")).unwrap();
    assert_eq!(out.doc.workspace_path().as_deref(), Some(".agents/plans/fix-it-16df61f9.md"));
    assert_eq!(std::fs::read_to_string(&out.doc.path).unwrap(), "# Fix it\n1. a\n");
    let plans = denied::resolve(&root).join(WORKSPACE_PLANS_DIR);
    assert_eq!(std::fs::read_to_string(plans.join(".gitignore")).unwrap(), "*\n");
    assert_eq!((out.doc.revision, out.doc.agent_revision, out.changed), (1, 1, true));

    // A user who deletes the .gitignore to commit plans keeps it deleted.
    std::fs::remove_file(plans.join(".gitignore")).unwrap();
    let other = tempfile::tempdir().unwrap();
    save_agent(other.path(), PlanTarget::Workspace { root: &root, session_id: "aaaaaaaa-0000-0000-0000-000000000001", denied: None }, PlanChange::Write("# Other")).unwrap();
    assert!(!plans.join(".gitignore").exists());
}

#[test]
fn a_taken_file_name_gets_a_suffix() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("ws");
    let plans = root.join(WORKSPACE_PLANS_DIR);
    std::fs::create_dir_all(&plans).unwrap();
    std::fs::write(plans.join("plan-16df61f9.md"), "someone else's").unwrap();
    let out = save_agent(&d.path().join("sid"), workspace(&root), PlanChange::Write("body")).unwrap();
    assert!(out.doc.path.ends_with("plan-16df61f9-2.md"));
    assert_eq!(std::fs::read_to_string(plans.join("plan-16df61f9.md")).unwrap(), "someone else's");
}

#[cfg(unix)]
#[test]
fn a_symlinked_plans_folder_outside_the_workspace_is_refused() {
    let d = tempfile::tempdir().unwrap();
    let (root, outside) = (d.path().join("ws"), d.path().join("outside"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".agents")).unwrap();
    let err = save_agent(&d.path().join("sid"), workspace(&root), PlanChange::Write("# Plan")).unwrap_err();
    assert_eq!(err, PlanError::Escapes);
    assert!(!outside.join("plans").exists(), "nothing is created through the link");
}

#[test]
fn a_chat_plan_stays_in_the_data_dir() {
    let d = tempfile::tempdir().unwrap();
    let out = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("  ## Plan\n1. a\n")).unwrap();
    assert_eq!(out.doc.path, data_plan_path(d.path()));
    assert_eq!(out.doc.workspace_path(), None);
    assert_eq!(std::fs::read_to_string(data_plan_path(d.path())).unwrap(), "## Plan\n1. a\n");
    let again = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. a")).unwrap();
    assert_eq!((again.changed, again.doc.revision), (false, 1), "identical content is not a revision");
}

#[test]
fn a_legacy_data_dir_plan_reads_as_revision_one_and_moves_on_its_next_write() {
    let d = tempfile::tempdir().unwrap();
    let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(data_plan_path(&dir), "## Old plan\n").unwrap();
    let doc = sync(&dir).unwrap();
    assert_eq!((doc.revision, doc.agent_revision, doc.unseen_edits()), (1, 1, false));
    let out = save_agent(&dir, workspace(&root), PlanChange::Edit(&[edit("Old", "New")])).unwrap();
    assert_eq!(out.doc.revision, 2);
    assert!(out.doc.workspace_path().is_some());
    assert!(!data_plan_path(&dir).exists());
}

#[test]
fn outside_edits_bump_the_revision_once_and_are_unseen_until_shown() {
    let d = tempfile::tempdir().unwrap();
    let out = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. a")).unwrap();
    std::fs::write(&out.doc.path, "## Plan\n1. a\n2. b\n").unwrap();
    let doc = sync(d.path()).unwrap();
    assert_eq!((doc.revision, doc.unseen_edits()), (2, true));
    assert_eq!(sync(d.path()).unwrap().revision, 2, "the same edit counts once");
    std::fs::write(&out.doc.path, "## Plan\n1. a\n2. b").unwrap();
    assert_eq!(sync(d.path()).unwrap().revision, 2, "whitespace at the ends is not an edit");
    mark_seen(d.path(), 2);
    assert!(!sync(d.path()).unwrap().unseen_edits());
}

#[test]
fn a_write_over_unseen_edits_is_refused_once_and_an_edit_includes_them() {
    let d = tempfile::tempdir().unwrap();
    let out = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. a")).unwrap();
    std::fs::write(&out.doc.path, "## Plan\n1. a (user)").unwrap();
    let err = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. mine")).unwrap_err();
    assert!(matches!(err, PlanError::UnseenEdits { revision: 2, .. }), "{err:?}");
    let second = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan\n1. mine")).unwrap();
    assert_eq!((second.doc.revision, second.included_user_edits), (3, false));

    std::fs::write(&out.doc.path, "## Plan\n1. mine\n2. theirs").unwrap();
    let edited = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Edit(&[edit("mine", "ours")])).unwrap();
    assert_eq!(edited.doc.content, "## Plan\n1. ours\n2. theirs");
    assert!(edited.included_user_edits);
    assert_eq!((edited.doc.revision, edited.doc.agent_revision), (5, 5));
}

#[test]
fn user_saves_check_the_revision_they_opened() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(save_user(d.path(), "x", 0), Err(PlanError::NoPlan));
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan")).unwrap();
    assert_eq!(save_user(d.path(), "## Mine", 7), Err(PlanError::Conflict));
    assert_eq!(save_user(d.path(), "  ", 1), Err(PlanError::Empty));
    let doc = save_user(d.path(), "## Mine", 1).unwrap();
    assert_eq!((doc.content.as_str(), doc.revision, doc.agent_revision), ("## Mine", 2, 1));
}

#[test]
fn detach_keeps_a_workspace_file() {
    let d = tempfile::tempdir().unwrap();
    let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
    std::fs::create_dir_all(&root).unwrap();
    let out = save_agent(&dir, workspace(&root), PlanChange::Write("# P")).unwrap();
    assert!(detach(&dir).unwrap());
    assert!(sync(&dir).is_none());
    assert!(out.doc.path.exists());
    assert!(!detach(&dir).unwrap());
}

#[test]
fn new_keeps_the_old_workspace_file_and_starts_at_revision_one() {
    let d = tempfile::tempdir().unwrap();
    let (dir, root) = (d.path().join("sid"), d.path().join("ws"));
    std::fs::create_dir_all(&root).unwrap();
    let a = save_agent(&dir, workspace(&root), PlanChange::Write("# Feature A\n1. a")).unwrap();
    save_agent(&dir, workspace(&root), PlanChange::Edit(&[edit("1. a", "1. a done")])).unwrap();
    mark_approved(&dir, 2);

    let b = save_agent(&dir, workspace(&root), PlanChange::New("# Feature B\n1. b")).unwrap();
    assert_eq!(b.closed.as_deref(), Some(".agents/plans/feature-a-16df61f9.md"));
    assert_eq!(b.doc.workspace_path().as_deref(), Some(".agents/plans/feature-b-16df61f9.md"));
    assert_eq!((b.doc.revision, b.doc.agent_revision, b.doc.approved_revision, b.changed), (1, 1, None, true));
    assert_eq!(std::fs::read_to_string(&a.doc.path).unwrap(), "# Feature A\n1. a done\n", "the closed plan is untouched");
    assert_eq!(sync(&dir).unwrap().content, "# Feature B\n1. b");

    let again = save_agent(&dir, workspace(&root), PlanChange::New("# Feature B\n1. b2")).unwrap();
    assert_eq!(again.doc.workspace_path().as_deref(), Some(".agents/plans/feature-b-16df61f9-2.md"), "a repeated title gets a suffix");
}

#[test]
fn new_without_a_plan_writes_the_first_one() {
    let d = tempfile::tempdir().unwrap();
    let out = save_agent(d.path(), PlanTarget::DataDir, PlanChange::New("# P")).unwrap();
    assert_eq!((out.closed, out.doc.revision), (None, 1));
    assert_eq!(save_agent(d.path(), PlanTarget::DataDir, PlanChange::New("  ")).unwrap_err(), PlanError::Empty);
    assert_eq!(sync(d.path()).unwrap().content, "# P", "an empty new plan closes nothing");
}

#[test]
fn new_keeps_a_chat_plan_beside_the_session() {
    let d = tempfile::tempdir().unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# A")).unwrap();
    let b = save_agent(d.path(), PlanTarget::DataDir, PlanChange::New("# B")).unwrap();
    let kept = d.path().join("plan-closed-1.md");
    assert_eq!(b.closed, Some(kept.display().to_string()));
    assert_eq!(std::fs::read_to_string(&kept).unwrap(), "# A\n");
    assert_eq!((b.doc.path.clone(), b.doc.revision), (data_plan_path(d.path()), 1));
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::New("# C")).unwrap();
    assert_eq!(std::fs::read_to_string(d.path().join("plan-closed-2.md")).unwrap(), "# B\n");
}

#[test]
fn new_drops_finished_tasks_only() {
    let d = tempfile::tempdir().unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# A")).unwrap();
    let todos = todo::todos_path(d.path());
    let create = |content: &str, status: &str| json!({"action": "create", "content": content, "status": status});
    todo::apply(&todos, &[create("done", "completed"), create("dropped", "cancelled"), create("open", "pending")]).unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::New("# B")).unwrap();
    let items = todo::load_store(&todos)["items"].as_array().cloned().unwrap();
    assert_eq!(todo::format_items(&items), "[task_3] [pending] open");
}

#[test]
fn carry_note_restates_a_new_plan_after_a_finished_one() {
    let d = tempfile::tempdir().unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# A\n1. Build")).unwrap();
    todo::apply(&todo::todos_path(d.path()), &[json!({"action": "create", "content": "Build", "status": "completed"})]).unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::New("# B\n1. Ship")).unwrap();
    let note = carry_note(d.path()).unwrap();
    assert!(note.contains("\n# B\n1. Ship\n</session_plan>"), "{note}");
    assert!(!note.contains("tasks_finished"));
}

#[test]
fn a_write_over_an_approved_plan_is_refused_once() {
    let d = tempfile::tempdir().unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# A")).unwrap();
    mark_approved(d.path(), 1);
    assert!(save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# A")).is_ok(), "an identical write changes nothing");
    let err = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# B")).unwrap_err();
    assert!(matches!(err, PlanError::ApprovedPlan { revision: 1, .. }), "{err:?}");
    assert!(err.to_string().contains("use action \"new\""));
    assert_eq!(sync(d.path()).unwrap().content, "# A");
    let second = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# B")).unwrap();
    assert_eq!(second.doc.revision, 2);
    assert!(save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("# C")).is_ok(), "only the approved revision is guarded");

    mark_approved(d.path(), 3);
    let edited = save_agent(d.path(), PlanTarget::DataDir, PlanChange::Edit(&[edit("C", "D")])).unwrap();
    assert_eq!(edited.doc.content, "# D", "an edit revises without the guard");
}

#[test]
fn review_answers_parse_to_a_decision() {
    let one = |s: &str| vec![vec![s.to_string()]];
    assert_eq!(review_decision(&one("Approve")), Ok(ReviewDecision::Approve));
    assert_eq!(review_decision(&one("Request changes")), Ok(ReviewDecision::Changes(None)));
    assert_eq!(review_decision(&one(" Drop step 2 ")), Ok(ReviewDecision::Changes(Some("Drop step 2".into()))));
    assert!(review_decision(&one("  ")).is_err());
    assert!(review_decision(&[]).is_err());
    assert!(review_decision(&[vec!["Approve".into(), "x".into()]]).is_err());
    assert!(review_decision(&[vec!["Approve".into()], vec!["x".into()]]).is_err());
}

#[test]
fn review_results_name_the_revision_and_carry_user_edits() {
    let d = tempfile::tempdir().unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Plan")).unwrap();
    let doc = sync(d.path()).unwrap();
    let approved = review_result_text(&ReviewDecision::Approve, Some(&doc), 1, true, false);
    assert!(approved.starts_with("The user approved plan revision 1. The session is now in Code mode"), "{approved}");
    assert!(approved.contains("one `todo` task per milestone"), "{approved}");
    assert!(!approved.contains("update_goal"), "{approved}");
    let approved_code = review_result_text(&ReviewDecision::Approve, Some(&doc), 1, false, false);
    assert!(approved_code.starts_with("The user approved plan revision 1. Implement the plan in"), "{approved_code}");
    assert!(!approved_code.contains("The session is now in Code mode"));
    let kept_going = review_result_text(&ReviewDecision::Approve, Some(&doc), 1, false, true);
    assert!(kept_going.ends_with(KEEP_GOING_NOTE), "{kept_going}");

    let changes = review_result_text(&ReviewDecision::Changes(Some("Split step 2".into())), Some(&doc), 1, true, false);
    assert!(changes.contains("revision 1:\n\nSplit step 2\n\nYou are still in Plan mode."), "{changes}");
    let changes_code = review_result_text(&ReviewDecision::Changes(Some("Split step 2".into())), Some(&doc), 1, false, false);
    assert!(changes_code.contains("revision 1:\n\nSplit step 2\n\nAddress every point,"), "{changes_code}");
    assert!(!changes_code.contains("You are still in Plan mode."));

    assert!(review_result_text(&ReviewDecision::Changes(None), Some(&doc), 1, true, false).contains("without saying what to change"));

    save_user(d.path(), "## Plan\n1. user step", 1).unwrap();
    let edited = review_result_text(&ReviewDecision::Approve, sync(d.path()).as_ref(), 1, true, false);
    assert!(edited.starts_with("The user edited the plan during review; this is revision 2"), "{edited}");
    assert!(edited.contains("<plan>\n## Plan\n1. user step\n</plan>\n\nThe user approved plan revision 2."));
}

#[test]
fn done_when_reads_the_label_paragraph_or_the_section() {
    let label = "# Ship\n\n**Outcome:** x\n\n**Done when:** export works;\n- tests pass\n- tsc clean\n\n## Appendix\nfiles";
    assert_eq!(done_when(label).as_deref(), Some("export works;\n- tests pass\n- tsc clean"));
    let section = "# Ship\n\n## Done when\n\n- a\n- b\n\n### Checks\n`make x`\n\n## Appendix\nfiles";
    assert_eq!(done_when(section).as_deref(), Some("- a\n- b\n\n### Checks\n`make x`"), "subsections belong to it");
    assert_eq!(done_when("# P\n\n## Done when:\n- a").as_deref(), Some("- a"));
    assert_eq!(done_when("# P\n**Done When**: it works").as_deref(), Some("it works"));
    assert_eq!(done_when("# P\n\n**Done when:** a\n**Appendix:** b").as_deref(), Some("a"));
    assert_eq!(done_when("# P\n\n## Approach\n1. a"), None);
    assert_eq!(done_when("# P\n\n## Done when\n\n## Appendix"), None, "an empty section is none");
    let long = format!("# P\n**Done when:** {}", "x".repeat(crate::goal::MAX_OBJECTIVE_CHARS + 10));
    let capped = done_when(&long).unwrap();
    assert_eq!(capped.chars().count(), crate::goal::MAX_OBJECTIVE_CHARS);
    assert!(capped.ends_with('…'));
}

#[test]
fn carry_note_restates_plan_and_board() {
    let d = tempfile::tempdir().unwrap();
    assert!(carry_note(d.path()).is_none());
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Steps\n1. Build\n2. Test")).unwrap();
    let note = carry_note(d.path()).unwrap();
    assert!(note.starts_with(&format!("<session_plan path=\"{}\"", data_plan_path(d.path()).display())));
    assert!(note.contains("\n## Steps\n1. Build\n2. Test\n</session_plan>"));
    assert!(!note.contains("<task_board>"));
    assert!(note.ends_with(CARRY_GUIDANCE));

    let todos = todo::todos_path(d.path());
    todo::apply(&todos, &[json!({"action": "create", "content": "Build", "status": "completed"}), json!({"action": "create", "content": "Test"})]).unwrap();
    let note = carry_note(d.path()).unwrap();
    assert!(note.contains("<task_board>\n[task_1] [completed] Build\n[task_2] [pending] Test\n</task_board>"));
}

#[test]
fn carry_note_only_points_at_a_finished_plan() {
    let d = tempfile::tempdir().unwrap();
    save_agent(d.path(), PlanTarget::DataDir, PlanChange::Write("## Steps\n1. Build")).unwrap();
    todo::apply(&todo::todos_path(d.path()), &[json!({"action": "create", "content": "Build", "status": "completed"})]).unwrap();
    let note = carry_note(d.path()).unwrap();
    assert!(note.contains("status=\"tasks_finished\""));
    assert!(!note.contains("1. Build"));
}
