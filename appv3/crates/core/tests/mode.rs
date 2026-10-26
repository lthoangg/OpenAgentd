//! Which mode (production or development) the server runs in. The build
//! decides by default, so the installed app is production and `cargo run`
//! is development whatever the shell inherited; `OPENAGENTD_ENV` overrides
//! it, and the old `APP_ENV` still works for one release. Separate test
//! binary: it mutates the environment.

use appv3_core::env::env_notices;
use appv3_core::settings::{build_default_mode, mode_from_env};

fn clear() {
    std::env::remove_var("OPENAGENTD_ENV");
    std::env::remove_var("APP_ENV");
}

#[test]
fn the_build_picks_the_mode_unless_openagentd_env_overrides_it() {
    clear();
    assert_eq!(build_default_mode(), if cfg!(debug_assertions) { "development" } else { "production" });
    assert_eq!(mode_from_env().unwrap(), build_default_mode());

    std::env::set_var("OPENAGENTD_ENV", "production");
    assert_eq!(mode_from_env().unwrap(), "production");
    std::env::set_var("OPENAGENTD_ENV", "development");
    assert_eq!(mode_from_env().unwrap(), "development");

    std::env::set_var("OPENAGENTD_ENV", "staging");
    let err = mode_from_env().unwrap_err();
    assert!(err.contains("OPENAGENTD_ENV") && err.contains("staging"), "{err}");

    // The old name still works, with a note pointing at the new one.
    clear();
    std::env::set_var("APP_ENV", "production");
    assert_eq!(mode_from_env().unwrap(), "production");
    assert!(env_notices().iter().any(|n| n.contains("APP_ENV") && n.contains("OPENAGENTD_ENV")), "{:?}", env_notices());

    // Another program's APP_ENV (Laravel's `local`, …) is not a mode.
    std::env::set_var("APP_ENV", "local");
    assert_eq!(mode_from_env().unwrap(), build_default_mode());

    // The new name wins over the old one.
    std::env::set_var("APP_ENV", "production");
    std::env::set_var("OPENAGENTD_ENV", "development");
    assert_eq!(mode_from_env().unwrap(), "development");
    clear();
}
