"""Request and response schemas for ``/api/agents`` endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentDetail(BaseModel):
    name: str
    path: str
    content: str
    config: dict | None = None
    error: str | None = None


class AgentSummary(BaseModel):
    name: str
    role: str = "member"
    description: str | None = None
    model: str | None = None
    tools: list[str] = []
    valid: bool = True
    error: str | None = None


class AgentListResponse(BaseModel):
    agents: list[AgentSummary]


class AgentWriteRequest(BaseModel):
    name: str = Field(description="Agent profile name.")
    content: str = Field(description="Full .md file contents.")


# ── Registry ────────────────────────────────────────────────────────────────


class ToolCatalogEntry(BaseModel):
    name: str
    description: str


class SkillCatalogEntry(BaseModel):
    name: str
    description: str


class MemberProfileCatalogEntry(BaseModel):
    name: str
    description: str | None = None
    tools: list[str] = []
    model: str | None = None


class ModelCatalogEntry(BaseModel):
    id: str
    provider: str
    model: str
    vision: bool
    output_image: bool = False
    output_video: bool = False
    thinking_levels: list[str] = []
    summary_trigger_tokens: int
    fast_mode: bool = False


class RegistryResponse(BaseModel):
    tools: list[ToolCatalogEntry]
    skills: list[SkillCatalogEntry]
    providers: list[str]
    models: list[ModelCatalogEntry]
    member_profiles: list[MemberProfileCatalogEntry] = []
