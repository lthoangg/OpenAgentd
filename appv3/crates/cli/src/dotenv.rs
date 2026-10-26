//! The config dir's `.env`, on its way out (deprecated in v3.32.0). Its
//! server settings move into `server.yaml`; anything else in it is still
//! read this release, with a notice naming the keys.

/// Move the server keys and name what is left (provider keys are reported
/// by the credentials migration instead). Logs a failure rather than
/// stopping the command.
pub fn migrate() {
    let s = appv3_core::settings();
    match appv3_core::runtime_settings::migrate_dotenv_server_keys(&s.config_dir) {
        Ok(left) => {
            let left: Vec<String> = left.into_iter().filter(|k| appv3_providers::credentials_migration::owner_of(k).is_none()).collect();
            if !left.is_empty() {
                appv3_core::env::notice(format!(
                    "{} is deprecated and a later release stops reading it; set {} in the environment instead",
                    s.env_file().display(),
                    left.join(", ")
                ));
            }
        }
        Err(e) => tracing::error!("dotenv_server_keys_migration_failed error={e:#}"),
    }
}
