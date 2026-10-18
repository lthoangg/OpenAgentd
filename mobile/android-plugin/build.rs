// The plugin exposes no JavaScript commands: only the mobile shell's Rust
// code calls it, so there is nothing to add to the capability file.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
