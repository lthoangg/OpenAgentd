"""Deterministic memory wiki linter."""

from __future__ import annotations

import re

import yaml

from app.services.memory.models import LintFinding, MemoryScope
from app.services.memory.store import MAX_MEMORY_PAGE_BYTES

_WIKILINK_PATTERN = re.compile(r"\[\[([^\]]+)\]\]")


def _strip_fenced_code_blocks(text: str) -> str:
    """Strip fenced code blocks (``` ... ``` or ~~~ ... ~~~) from text."""
    lines = text.splitlines(keepends=True)
    in_fence = False
    fence_char = ""
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_char = marker
                continue
            elif marker == fence_char:
                in_fence = False
                fence_char = ""
                continue
        if not in_fence:
            out.append(line)
    return "".join(out)


def lint_memory_scope(
    scope: MemoryScope,
    global_scope: MemoryScope | None = None,
) -> list[LintFinding]:
    """Run deterministic structural lint over a single memory scope."""
    findings: list[LintFinding] = []
    if not scope.root.is_dir():
        return findings

    g_root = (global_scope.root if global_scope else scope.root).resolve()

    for path in sorted(scope.root.rglob("*.md"), key=lambda p: p.as_posix()):
        if not path.is_file():
            continue
        rel_posix = path.relative_to(scope.root).as_posix()

        # 1. Size check
        try:
            size = path.stat().st_size
            if size > MAX_MEMORY_PAGE_BYTES:
                findings.append(
                    LintFinding(
                        code="PAGE_TOO_LARGE",
                        path=f"{scope.kind}:{rel_posix}",
                        message=f"Memory page size ({size} bytes) exceeds limit ({MAX_MEMORY_PAGE_BYTES} bytes)",
                    )
                )
                continue
        except OSError as exc:
            findings.append(
                LintFinding(
                    code="INVALID_PAGE",
                    path=f"{scope.kind}:{rel_posix}",
                    message=f"Could not stat page: {exc}",
                )
            )
            continue

        # 2. Read and parse frontmatter
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as exc:
            findings.append(
                LintFinding(
                    code="INVALID_PAGE",
                    path=f"{scope.kind}:{rel_posix}",
                    message=f"Could not read page: {exc}",
                )
            )
            continue

        if content.startswith("---"):
            lines = content.splitlines(keepends=True)
            end_idx = -1
            for i in range(1, len(lines)):
                if lines[i].strip() == "---":
                    end_idx = i
                    break
            if end_idx != -1:
                yaml_str = "".join(lines[1:end_idx])
                try:
                    parsed = yaml.safe_load(yaml_str)
                    if parsed is not None and not isinstance(parsed, dict):
                        findings.append(
                            LintFinding(
                                code="INVALID_FRONTMATTER",
                                path=f"{scope.kind}:{rel_posix}",
                                message="Frontmatter must be a YAML mapping",
                            )
                        )
                except Exception as exc:
                    findings.append(
                        LintFinding(
                            code="INVALID_FRONTMATTER",
                            path=f"{scope.kind}:{rel_posix}",
                            message=f"Malformed YAML frontmatter: {exc}",
                        )
                    )

        # 3. Wikilinks check (skipping code fences)
        body_without_fences = _strip_fenced_code_blocks(content)
        for match in _WIKILINK_PATTERN.finditer(body_without_fences):
            raw_target = match.group(1).strip()
            if not raw_target:
                continue

            # Check directionality & target
            if raw_target.startswith("workspace:"):
                if scope.kind == "global":
                    findings.append(
                        LintFinding(
                            code="INVALID_WIKILINK_TARGET",
                            path=f"{scope.kind}:{rel_posix}",
                            message=f"Global page cannot link to workspace memory: [[{raw_target}]]",
                        )
                    )
                    continue
                target_subpath = raw_target[len("workspace:") :].strip()
                target_file = scope.root / (
                    target_subpath
                    if target_subpath.endswith(".md")
                    else f"{target_subpath}.md"
                )
            elif raw_target.startswith("global:"):
                target_subpath = raw_target[len("global:") :].strip()
                target_file = g_root / (
                    target_subpath
                    if target_subpath.endswith(".md")
                    else f"{target_subpath}.md"
                )
            else:
                target_subpath = raw_target
                target_file = scope.root / (
                    target_subpath
                    if target_subpath.endswith(".md")
                    else f"{target_subpath}.md"
                )

            if not target_file.is_file():
                findings.append(
                    LintFinding(
                        code="BROKEN_LINK",
                        path=f"{scope.kind}:{rel_posix}",
                        message=f"Broken wikilink target not found: [[{raw_target}]]",
                    )
                )

    return findings
