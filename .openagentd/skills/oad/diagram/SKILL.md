---
name: oad/diagram
description: Select and create accurate software architecture, workflow, interaction, data, state, and deployment diagrams.
---

# OAD Diagramming

Use this skill to select a diagram type, then read only its reference.

| Request | Reference |
| --- | --- |
| System/runtime architecture, integrations, components | [architecture](references/architecture.md) |
| User, business, or operational process | [workflow](references/workflow.md) |
| Requests, events, streaming, or cross-service interactions | [sequence](references/sequence.md) |
| Lifecycle, retry, cancellation, or status transitions | [state](references/state.md) |
| Persistent records and relationships | [data](references/data.md) |
| Device, process, network, and trust topology | [deployment](references/deployment.md) |

Before drawing, state the one question it answers and verify facts in code,
tests, configuration, docs, and the nearest `AGENTS.md`. Use the smallest
useful diagram; split crowded views. Label relationships and directions, mark
proposals/unknowns, and keep open questions separate from facts. Do not expose
secrets or private data, or add a renderer/dependency unless explicitly asked.
