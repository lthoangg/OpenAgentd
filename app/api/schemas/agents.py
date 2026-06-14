"""Request and response schemas for ``/api/agents`` endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentSummary(BaseModel):
    name: str
    role: str
    description: str | None = None
    model: str | None = None
    tools: list[str] = []
    mcp: list[str] = []
    skills: list[str] = []
    valid: bool
    error: str | None = None


class AgentDetail(BaseModel):
    name: str
    path: str
    content: str
    config: dict | None = None
    error: str | None = None


class AgentWriteRequest(BaseModel):
    name: str = Field(description="Agent name (filename stem).")
    content: str = Field(description="Full .md file contents.")


class AgentDeleteResponse(BaseModel):
    name: str


class AgentListResponse(BaseModel):
    agents: list[AgentSummary]


# ── Registry ────────────────────────────────────────────────────────────────


class ToolCatalogEntry(BaseModel):
    name: str
    description: str


class SkillCatalogEntry(BaseModel):
    name: str
    description: str


class ModelCatalogEntry(BaseModel):
    id: str
    provider: str
    model: str
    vision: bool
    output_image: bool = False
    output_video: bool = False
    summary_trigger_tokens: int


class RegistryResponse(BaseModel):
    tools: list[ToolCatalogEntry]
    skills: list[SkillCatalogEntry]
    providers: list[str]
    models: list[ModelCatalogEntry]
