use super::*;
use crate::credentials::CredentialsFile;

fn new(f: &mut CredentialsFile, name: &str, value: &str, projects: &[&str]) -> String {
    set(f, name, Change { value: Some(value.into()), projects: Some(projects.iter().map(|s| s.to_string()).collect()), source: "chat".into(), ..Default::default() }).unwrap()
}

fn value<'a>(f: &'a CredentialsFile, name: &str, project: &str) -> Option<&'a str> {
    resolve(f, name, project).map(|s| s.value.as_str())
}

#[test]
fn b1_a_value_for_every_project_is_used_everywhere() {
    let mut f = CredentialsFile::default();
    new(&mut f, "GITHUB_TOKEN", "ghp_all", &["*"]);
    assert_eq!(value(&f, "GITHUB_TOKEN", "/a"), Some("ghp_all"));
    assert_eq!(value(&f, "GITHUB_TOKEN", "/z"), Some("ghp_all"));
}

#[test]
fn b2_a_value_for_chosen_projects_is_used_only_there() {
    let mut f = CredentialsFile::default();
    let id = new(&mut f, "GITHUB_TOKEN", "ghp_1", &["/a"]);
    assert_eq!(value(&f, "GITHUB_TOKEN", "/b"), None);
    add_project(&mut f, "GITHUB_TOKEN", &id, "/b").unwrap();
    assert_eq!(value(&f, "GITHUB_TOKEN", "/b"), Some("ghp_1"));
    assert_eq!(value(&f, "GITHUB_TOKEN", "/a"), Some("ghp_1"));
    assert_eq!(f.agent_secrets["GITHUB_TOKEN"].len(), 1, "one value, two projects");
}

#[test]
fn b3_same_name_different_values_per_project() {
    let mut f = CredentialsFile::default();
    new(&mut f, "STRIPE_SECRET_KEY", "sk_a", &["/client-a"]);
    new(&mut f, "STRIPE_SECRET_KEY", "sk_b", &["/client-b"]);
    assert_eq!(value(&f, "STRIPE_SECRET_KEY", "/client-a"), Some("sk_a"));
    assert_eq!(value(&f, "STRIPE_SECRET_KEY", "/client-b"), Some("sk_b"));
    assert_eq!(value(&f, "STRIPE_SECRET_KEY", "/client-c"), None);
}

#[test]
fn b4_a_project_value_wins_over_the_every_project_value() {
    let mut f = CredentialsFile::default();
    new(&mut f, "OPENWEATHER_API_KEY", "all", &["*"]);
    new(&mut f, "OPENWEATHER_API_KEY", "mine", &["/a"]);
    assert_eq!(value(&f, "OPENWEATHER_API_KEY", "/a"), Some("mine"));
    assert_eq!(value(&f, "OPENWEATHER_API_KEY", "/b"), Some("all"));
}

#[test]
fn a_project_moves_to_the_value_it_is_given_and_an_unused_value_is_dropped() {
    let mut f = CredentialsFile::default();
    let old = new(&mut f, "K", "old-value", &["/a", "/b"]);
    new(&mut f, "K", "new-value", &["/b"]);
    assert_eq!(value(&f, "K", "/a"), Some("old-value"));
    assert_eq!(value(&f, "K", "/b"), Some("new-value"));
    let lone = new(&mut f, "K", "third", &["/a"]);
    assert!(f.agent_secrets["K"].iter().all(|s| s.id != old), "nobody uses the old value any more");
    assert!(f.agent_secrets["K"].iter().any(|s| s.id == lone));
}

#[test]
fn replacing_a_value_changes_it_for_every_project_that_uses_it() {
    let mut f = CredentialsFile::default();
    let id = new(&mut f, "K", "old-value", &["/a", "/b"]);
    set(&mut f, "K", Change { id: Some(id.clone()), value: Some("rotated".into()), ..Default::default() }).unwrap();
    assert_eq!(value(&f, "K", "/a"), Some("rotated"));
    assert_eq!(value(&f, "K", "/b"), Some("rotated"));
}

#[test]
fn only_one_value_may_be_for_every_project() {
    let mut f = CredentialsFile::default();
    new(&mut f, "K", "one", &["*"]);
    let err = set(&mut f, "K", Change { value: Some("two".into()), projects: Some(vec!["*".into()]), ..Default::default() }).unwrap_err();
    assert!(err.contains("already has a value for every project"), "{err}");
    assert_eq!(f.agent_secrets["K"].len(), 1, "the refused value is not saved");
}

#[test]
fn reusing_the_every_project_value_drops_the_projects_own_value() {
    let mut f = CredentialsFile::default();
    let all = new(&mut f, "K", "all-value", &["*"]);
    new(&mut f, "K", "own-value", &["/a"]);
    add_project(&mut f, "K", &all, "/a").unwrap();
    assert_eq!(value(&f, "K", "/a"), Some("all-value"));
    assert_eq!(f.agent_secrets["K"].len(), 1);
}

#[test]
fn deleting_the_last_value_forgets_the_name() {
    let mut f = CredentialsFile::default();
    let id = new(&mut f, "K", "value-one", &["/a"]);
    assert!(remove(&mut f, "K", &id));
    assert!(!f.agent_secrets.contains_key("K"));
    assert!(!remove(&mut f, "K", &id));
}

#[test]
fn e5_names_that_change_how_commands_run_are_refused() {
    for bad in ["PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV", "OPENAGENTD_ACCESS_KEY", "lower", "1ABC", "A-B", ""] {
        assert!(check_name(bad).is_err(), "{bad}");
    }
    for good in ["STRIPE_SECRET_KEY", "AWS_ACCESS_KEY_ID", "_X", "K2"] {
        assert!(check_name(good).is_ok(), "{good}");
    }
}

#[test]
fn usable_names_are_those_the_project_resolves() {
    let mut f = CredentialsFile::default();
    new(&mut f, "A_KEY", "value-a", &["/p"]);
    new(&mut f, "B_KEY", "value-b", &["*"]);
    new(&mut f, "C_KEY", "value-c", &["/other"]);
    assert_eq!(usable_names(&f, "/p"), vec!["A_KEY", "B_KEY"]);
}

#[test]
fn the_store_round_trips_through_yaml_and_debug_hides_values() {
    let mut f = CredentialsFile { version: 1, ..Default::default() };
    new(&mut f, "STRIPE_SECRET_KEY", "sk_live_123456", &["/client-a"]); // gitleaks:allow (synthetic fixture)
    let back = CredentialsFile::parse(&f.to_yaml()).unwrap();
    assert_eq!(back.agent_secrets, f.agent_secrets);
    assert!(!format!("{f:?}").contains("sk_live_123456"));
    assert!(!format!("{:?}", f.agent_secrets["STRIPE_SECRET_KEY"][0]).contains("sk_live_123456"));
}

#[test]
fn b5_worktrees_belong_to_their_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join(".git/worktrees/feat")).unwrap();
    std::fs::create_dir_all(repo.join("src/deep")).unwrap();
    let wt = root.join("wt-feat");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", repo.join(".git/worktrees/feat").display())).unwrap();
    std::fs::write(repo.join(".git/worktrees/feat/commondir"), "../..\n").unwrap();
    let plain = root.join("plain");
    std::fs::create_dir_all(&plain).unwrap();

    let key = repo.display().to_string();
    assert_eq!(project_of(&repo), key);
    assert_eq!(project_of(&repo.join("src/deep")), key, "a folder inside the repository");
    assert_eq!(project_of(&wt), key, "a linked worktree");
    assert_eq!(project_of(&plain), plain.display().to_string(), "a folder without git");
}
