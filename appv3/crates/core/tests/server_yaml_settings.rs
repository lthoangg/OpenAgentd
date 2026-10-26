//! `server.yaml` holds the server settings that used to live in `.env`
//! (CORS origins, LAN opt-out, log levels); the real environment still
//! overrides it. Separate test binary: it mutates the environment.

use appv3_core::settings::Settings;

#[test]
fn server_yaml_settings_apply_and_the_environment_overrides_them() {
    let cfg = tempfile::tempdir().unwrap();
    std::fs::write(cfg.path().join("server.yaml"), "log_level: WARNING\nfile_log_level: INFO\nallow_insecure_lan: true\ncors_origins:\n- https://a.example\n").unwrap();
    std::env::set_var("OPENAGENTD_CONFIG_DIR", cfg.path());
    for k in [
        "OPENAGENTD_LOG_LEVEL",
        "LOG_LEVEL",
        "OPENAGENTD_FILE_LOG_LEVEL",
        "FILE_LOG_LEVEL",
        "OPENAGENTD_ALLOW_INSECURE_LAN",
        "API_ALLOW_INSECURE_LAN",
        "OPENAGENTD_CORS_ORIGINS",
        "CORS_ORIGINS",
    ] {
        std::env::remove_var(k);
    }

    let s = Settings::from_env();
    assert_eq!((s.log_level.as_str(), s.file_log_level.as_str()), ("WARNING", "INFO"));
    assert!(s.api_allow_insecure_lan);
    assert_eq!(s.cors_origins, Some(vec!["https://a.example".to_string()]));

    std::env::set_var("OPENAGENTD_LOG_LEVEL", "ERROR");
    std::env::set_var("OPENAGENTD_ALLOW_INSECURE_LAN", "false");
    let s = Settings::from_env();
    assert_eq!(s.log_level, "ERROR");
    assert!(!s.api_allow_insecure_lan);

    // A broken file falls back to the defaults instead of stopping the server.
    std::env::remove_var("OPENAGENTD_LOG_LEVEL");
    std::fs::write(cfg.path().join("server.yaml"), "log_level: [\n").unwrap();
    assert_eq!(Settings::from_env().log_level, "INFO");
}
