//! Logic shared by the desktop and mobile Tauri shells.
//!
//! Everything here is `tauri`-free and takes plain paths / clients, so the
//! shells stay thin adapters (`AppHandle` → path, `#[tauri::command]`
//! wrappers) and the behaviour is unit-tested exactly once. Before this
//! crate the two shells carried byte-for-byte copies of these functions and
//! drifted — see the trimmed-access-key bug recorded on
//! [`access_key::set_access_key`].

pub mod access_key;
pub mod backend_config;
pub mod download;

pub use access_key::{delete_access_key, get_access_key, set_access_key};
pub use backend_config::{
    apply_backend_config_update, load_backend_config_from, normalize_base_url,
    normalize_server_name, remove_backend_server_at, save_backend_config_to, AppBackendConfig,
    SavedAppServer,
};
pub use download::{
    decode_base64, ensure_content_length_limit, ensure_max_download_size, resolve_download_bytes,
    safe_download_filename, unique_cache_path, DownloadSource, MAX_DOWNLOAD_BYTES,
};
