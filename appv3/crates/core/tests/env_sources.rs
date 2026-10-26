//! Which `.env` files the server reads. Only the active config dir's
//! `.env` configures the server: a project's `.env` in the working directory
//! names that project's database and ports, and the installed app's `.env`
//! must not configure a development server. A file cannot pick the mode
//! either, since the mode picks the config dir. Separate test binary: it
//! mutates the environment and the working directory.
#![cfg(unix)]

use appv3_core::env::{env_notices, init_env};

#[test]
fn only_the_active_config_dirs_env_file_is_read() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let prod_cfg = home.path().join(".config/openagentd");
    std::fs::create_dir_all(&prod_cfg).unwrap();
    std::fs::write(prod_cfg.join(".env"), "OAD_TEST_PROD_KEY=1\n").unwrap();
    std::fs::write(project.path().join(".env"), "OAD_TEST_CWD_KEY=1\nDATABASE_URL=postgres://project\n").unwrap();
    let dev_cfg = project.path().join(".openagentd/dev/config");
    std::fs::create_dir_all(&dev_cfg).unwrap();
    std::fs::write(dev_cfg.join(".env"), "OAD_TEST_DEV_KEY=1\nOPENAGENTD_ENV=production\nAPP_ENV=production\n").unwrap();

    std::env::set_var("HOME", home.path());
    std::env::remove_var("OPENAGENTD_ENV");
    std::env::remove_var("APP_ENV");
    std::env::remove_var("OPENAGENTD_CONFIG_DIR");
    std::env::remove_var("DATABASE_URL");
    std::env::set_current_dir(project.path()).unwrap();

    // Development (a debug build's default): the checkout's dev config dir.
    init_env();
    assert_eq!(std::env::var("OAD_TEST_DEV_KEY").as_deref(), Ok("1"), "the active config dir's .env loads");
    assert!(std::env::var_os("OAD_TEST_CWD_KEY").is_none(), "the working directory's .env must not load");
    assert!(std::env::var_os("DATABASE_URL").is_none(), "a project's DATABASE_URL must not reach the server");
    assert!(std::env::var_os("OAD_TEST_PROD_KEY").is_none(), "the installed app's .env must not configure a dev server");
    assert!(std::env::var_os("OPENAGENTD_ENV").is_none() && std::env::var_os("APP_ENV").is_none(), "a .env file must not pick the mode");
    let notices = env_notices().join("\n");
    assert!(notices.contains(&project.path().join(".env").display().to_string()), "{notices}");
    assert!(notices.contains("OPENAGENTD_ENV in"), "{notices}");

    // Production: the installed app's config dir.
    std::env::set_var("OPENAGENTD_ENV", "production");
    init_env();
    assert_eq!(std::env::var("OAD_TEST_PROD_KEY").as_deref(), Ok("1"));
    assert!(std::env::var_os("OAD_TEST_CWD_KEY").is_none());
}
