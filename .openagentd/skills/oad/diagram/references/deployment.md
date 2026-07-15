# Deployment diagrams

Use for where software executes and how runtime boundaries connect.

Show device, process, storage, network, and trust boundaries relevant to the
question. Label protocols and persistence. Distinguish browser, Tauri shell,
and Python sidecar when applicable; do not imply a browser-only deployment
passes through Tauri.

## Example

```mermaid
flowchart TB
  subgraph device[User device]
    shell[Tauri shell] --> ui[React UI]
    ui --> api[Python sidecar]
    api --> db[(SQLite)]
  end
  api -->|MCP| server[Local MCP server]
```
