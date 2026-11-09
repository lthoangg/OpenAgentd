//! `agentd lsp status|install`.

use crate::cli::{LspCmd, LspComponent};
use crate::ui::{self, dim, Table};
use anyhow::{anyhow, Result};

/// `(mark, word)` for a language server state.
fn state_cell(state: &str) -> (String, String) {
    match state {
        "ready" => (ui::ok_mark(), "ready".into()),
        "installing" => (ui::idle_mark(), "installing".into()),
        "error" => (ui::fail_mark(), "failed".into()),
        _ => (ui::fail_mark(), "missing".into()),
    }
}

fn print_status(st: &appv3_tools::lsp::ManagedLspStatus) {
    use appv3_tools::lsp::managed::{TYPESCRIPT_LANGUAGE_SERVER_VERSION, TYPESCRIPT_VERSION};
    let m = appv3_tools::lsp::managed_lsp_tools();
    ui::header("Language servers", "managed by OpenAgentd");
    let mut table = Table::new();
    let (mark, word) = state_cell(st.state);
    let ts_detail = if st.state == "ready" {
        dim(&format!("language-server {TYPESCRIPT_LANGUAGE_SERVER_VERSION} · typescript {TYPESCRIPT_VERSION}"))
    } else {
        "agentd lsp install typescript".to_string()
    };
    table.row([mark, "TypeScript".into(), word, ts_detail]);
    for (name, available) in [("ty", st.ty_available), ("ruff", st.ruff_available)] {
        let (mark, word) = state_cell(if available { "ready" } else { "missing" });
        let detail = if available { m.python_tool_version(name).map(|v| dim(&format!("managed {v}"))).unwrap_or_default() } else { format!("agentd lsp install python {name}") };
        table.row([mark, format!("Python {name}"), word, detail]);
    }
    table.print();
    if let Some(d) = st.detail.as_deref().filter(|d| !d.is_empty()) {
        println!();
        ui::mark_line(&ui::warn_mark(), d);
    }
    if !st.downloads_enabled {
        println!();
        ui::hint("Downloads are off (OPENAGENTD_DISABLE_LSP_DOWNLOAD), so missing servers stay missing.");
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
            println!();
            ui::mark_line(&ui::ok_mark(), &format!("Installed {tool}  {}", dim(&cmd.join(" "))));
            print_status(&m.status());
        }
    }
    Ok(())
}
