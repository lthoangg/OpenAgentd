//! Windows version resource for `agentd.exe` and `openagentd.exe`: product
//! name and version show in Explorer's Details tab, and code signing checks
//! them against the release. The version comes from `CARGO_PKG_VERSION`.

fn main() -> std::io::Result<()> {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return Ok(());
    }
    winresource::WindowsResource::new().set("ProductName", "OpenAgentd").set("FileDescription", "OpenAgentd backend").set("CompanyName", "openagentd").compile()
}
