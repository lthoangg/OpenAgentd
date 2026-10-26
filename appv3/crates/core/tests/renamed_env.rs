//! Settings variables moved to the `OPENAGENTD_` prefix in v3.32.0, so a
//! project's `API_PORT` or `DATABASE_URL` is not read as the app's. The old
//! names still work for one release, with a note naming the new one.
//! Separate test binary: it mutates the environment.

use appv3_core::env::env_notices;
use appv3_core::settings::{env_var, Settings};

#[test]
fn old_names_still_work_with_a_note_and_new_names_win() {
    std::env::remove_var("OPENAGENTD_PORT");
    std::env::set_var("API_PORT", "9123");
    assert_eq!(Settings::from_env().api_port, 9123);
    assert!(env_notices().iter().any(|n| n.contains("API_PORT") && n.contains("OPENAGENTD_PORT")), "{:?}", env_notices());

    std::env::set_var("OPENAGENTD_PORT", "9124");
    assert_eq!(Settings::from_env().api_port, 9124);

    std::env::remove_var("OPENAGENTD_DATABASE_URL");
    std::env::set_var("DATABASE_URL", "sqlite:////tmp/oad-old.db");
    assert_eq!(Settings::from_env().database_path, std::path::PathBuf::from("/tmp/oad-old.db"));
    std::env::set_var("OPENAGENTD_DATABASE_URL", "/tmp/oad-new.db");
    assert_eq!(Settings::from_env().database_path, std::path::PathBuf::from("/tmp/oad-new.db"));

    std::env::set_var("OTEL_SLOW_SPAN_MS", "5");
    assert_eq!(env_var("OPENAGENTD_OTEL_SLOW_SPAN_MS").as_deref(), Some("5"));
    // A standard OpenTelemetry variable keeps its name.
    assert_eq!(env_var("OTEL_EXPORTER_OTLP_ENDPOINT"), std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok().filter(|v| !v.is_empty()));
}
