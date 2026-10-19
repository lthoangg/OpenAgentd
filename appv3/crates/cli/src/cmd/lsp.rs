//! `agentd lsp status|install`.

use crate::cli::{LspCmd, LspComponent};
use anyhow::{anyhow, Result};

fn print_status(st: &appv3_tools::lsp::ManagedLspStatus) {
    use appv3_tools::lsp::managed::{TYPESCRIPT_LANGUAGE_SERVER_VERSION, TYPESCRIPT_VERSION};
    let m = appv3_tools::lsp::managed_lsp_tools();
    println!("\n  OpenAgentd LSP tools\n");
    for (name, available) in [("ty", st.ty_available), ("ruff", st.ruff_available)] {
        let suffix = m.python_tool_version(name).map(|v| format!(" (managed {v})")).unwrap_or_default();
        println!("  Python {name:<4}: {}{suffix}", if available { "ready" } else { "missing" });
    }
    println!("  TypeScript:    {} (language-server {TYPESCRIPT_LANGUAGE_SERVER_VERSION}, typescript {TYPESCRIPT_VERSION})", st.state);
    if let Some(d) = st.detail.as_deref().filter(|d| !d.is_empty()) {
        println!("  Detail:        {d}");
    }
    if !st.downloads_enabled {
        println!("  Downloads:     disabled by OPENAGENTD_DISABLE_LSP_DOWNLOAD");
    }
    println!();
}

pub fn lsp(cmd: &LspCmd) -> Result<()> {
    let m = appv3_tools::lsp::managed_lsp_tools();
    let LspCmd::Install(a) = cmd else {
        print_status(&m.status());
        return Ok(());
    };
    let rt = tokio::runtime::Runtime::new()?;
    match a.component {
        LspComponent::Typescript => {
            let st = rt.block_on(m.install_typescript()).map_err(|e| anyhow!("TypeScript LSP installation failed: {e}"))?;
            print_status(&st);
        }
        LspComponent::Python => {
            let tool = a.tool.ok_or_else(|| anyhow!("choose a Python tool: ruff or ty"))?.name();
            let cmd = rt.block_on(m.install_python_tool(tool, a.version.as_deref(), a.force)).map_err(|e| anyhow!("Python LSP installation failed: {e}"))?;
            println!("Installed {tool} -> {}", cmd.join(" "));
            print_status(&m.status());
        }
    }
    Ok(())
}
