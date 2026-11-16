"""Validate repository documentation contracts without third-party dependencies."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

FRONTMATTER_REQUIREMENTS: tuple[tuple[str, frozenset[str]], ...] = (
    # Area files of the feature catalogue: the index alone carries the release
    # line and the `updated:` date that the release script rewrites.
    ("documents/docs/features/", frozenset({"title", "description"})),
    ("documents/docs/", frozenset({"title", "description", "status", "updated"})),
    (".github/ISSUE_TEMPLATE/", frozenset({"name", "about", "labels"})),
)
IMAGE_SUFFIXES = frozenset(
    {".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"}
)
LINK_RE = re.compile(r"(?<!!)\[[^]]*\]\(([^)]+)\)")
MAKE_RE = re.compile(r"^make(?:\s+-C\s+([^\s`]+))?\s+([A-Za-z0-9_.-]+)(?:\s|$)")
AGENTS_PATH_RE = re.compile(r"(?<![\w:/.-])([\w.\-/]+/AGENTS\.md)\b")

# A Markdown file is read whole by an agent with a limited context window.
MAX_MARKDOWN_BYTES = 50_000
# These describe what shipped in a past release, so they name files that are gone.
HISTORY_PREFIXES = ("documents/docs/features/", "appv3/report/")
# An index and the folder of parts it must link, so no part is orphaned.
INDEXED_FOLDERS: tuple[tuple[str, str], ...] = (
    ("DESIGN.md", "design"),
    ("appv3/REPORT.md", "appv3/report"),
    ("documents/docs/features.md", "documents/docs/features"),
)
# `DESIGN.md`, an arrow, a rule's name; or `DESIGN.md`, a comma, the name in quotes.
DESIGN_CITATION_RE = re.compile(r"DESIGN\.md(?:\s*(?:→|->)\s*|,\s*(?=[\"“]))")
REPORT_CITATION_RE = re.compile(r"REPORT(?:\.md)?,?\s+§\s*(\d+[A-Za-z]*)")
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)
BULLET_NAME_RE = re.compile(r"^\s*(?:[-*]|\d+\.)\s+\*\*(.+?)\*\*", re.MULTILINE)
# The comment leader of a citation that wraps onto the next line.
COMMENT_WRAP_RE = re.compile(r"\n[ \t]*(?://[/!]?|\*|#|--)?[ \t]*")

# DESIGN.md's `colors:` block and the app's light theme state the same values.
DESIGN_TOKEN_CSS = ("web/src/styles/tokens.css", "web/src/index.css")
# DESIGN.md names roles the design.md way; the CSS has its own names for them.
DESIGN_COLOR_VARIABLES = {
    "primary": "color-accent",
    "secondary": "color-text-muted",
    "tertiary": "accent-blue",
    "neutral": "bg-page",
    "on-surface": "color-text",
    "on-surface-2": "color-text-2",
    "on-surface-muted": "color-text-muted",
    "on-surface-subtle": "color-text-subtle",
    "marker-violet": "color-violet",
}
# A translucent colour flattened over the page for tools that read DESIGN.md;
# the app composites the original, so no custom property holds this value.
DESIGN_COLORS_WITHOUT_A_VARIABLE = frozenset({"error-container"})


def tracked_markdown_files(root: Path) -> list[Path]:
    """Return tracked Markdown files in stable repository-relative order.

    Vendored third-party crates (any ``vendor/`` directory) keep their
    upstream docs, whose links point into the upstream repository; they are
    not ours to validate.
    """
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--", "*.md"],
        check=False,
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError("could not list tracked Markdown files with git")
    return [
        path
        for name in sorted(filter(None, result.stdout.decode().split("\0")))
        if "vendor" not in Path(name).parts[:-1]
        and (path := root / Path(name)).is_file()
    ]


def tracked_citing_files(root: Path) -> list[Path]:
    """Return tracked text files that cite a design rule or a report section."""
    result = subprocess.run(
        ["git", "-C", str(root), "grep", "-lIz", "-E", "-e", r"DESIGN\.md|REPORT(\.md)?,? +§"],
        check=False,
        capture_output=True,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError("could not search tracked files with git")
    return [
        path
        for name in sorted(filter(None, result.stdout.decode().split("\0")))
        if "vendor" not in Path(name).parts[:-1]
        and (path := root / Path(name)).is_file()
    ]


def _relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _frontmatter_fields(text: str) -> set[str] | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end == -1:
        return set()
    return {
        match.group(1)
        for match in re.finditer(
            r"^([A-Za-z][A-Za-z0-9_-]*):", text[4:end], re.MULTILINE
        )
    }


def _required_frontmatter(relative_path: str) -> frozenset[str]:
    if relative_path.endswith("/SKILL.md"):
        return frozenset({"name", "description"})
    if relative_path.startswith(".agents/commands/") or relative_path.startswith(
        ".agents/snippets/"
    ):
        return frozenset({"description"})
    for prefix, fields in FRONTMATTER_REQUIREMENTS:
        if relative_path.startswith(prefix):
            return fields
    return frozenset()


def _local_link_target(raw_target: str) -> str | None:
    target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
        return None
    if Path(unquote(target)).suffix.lower() in IMAGE_SUFFIXES:
        return None
    return unquote(target)


def _make_targets(makefile: Path) -> set[str]:
    if not makefile.is_file():
        return set()
    return {
        match.group(1)
        for line in makefile.read_text(encoding="utf-8").splitlines()
        if (match := re.match(r"^([A-Za-z0-9_.-]+):", line))
    }


def _repository_path(span: str, top_level: frozenset[str]) -> str | None:
    """The repository path a backticked span names, if it names one."""
    path = re.sub(r"(?::\d+(?:-\d+)?|#[\w-]+)$", "", span.strip())
    if not re.fullmatch(r"[\w.@+-]+(?:/[\w.@+-]+)+/?", path):
        return None
    return path if path.split("/", 1)[0] in top_level else None


def _git_ignored(root: Path, paths: list[str]) -> set[str]:
    """The paths git ignores: build output and local state, absent from a fresh clone."""
    if not paths:
        return set()
    result = subprocess.run(
        ["git", "-C", str(root), "check-ignore", "--no-index", "-z", "--stdin"],
        input="\0".join(paths).encode(),
        check=False,
        capture_output=True,
    )
    return set(filter(None, result.stdout.decode().split("\0"))) if result.returncode == 0 else set()


def _rule_name(text: str) -> str:
    text = re.sub(r"[`*\"“”]", "", text)
    return re.sub(r"\s+", " ", text).strip(" .:").casefold()


def _rule_names(texts: list[str]) -> set[str]:
    """Every name a rule can be cited by: a heading, or the bold lead of a bullet."""
    names: set[str] = set()
    for text in texts:
        names.update(_rule_name(match) for match in HEADING_RE.findall(text))
        names.update(_rule_name(match) for match in BULLET_NAME_RE.findall(text))
    return names - {""}


def _names_a_rule(cited: str, names: set[str]) -> bool:
    """A citation names a rule in full, or its first words up to a word boundary."""
    cited = _rule_name(cited)
    return bool(cited) and any(
        name == cited or (name.startswith(cited) and not name[len(cited)].isalnum())
        for name in names
    )


def _cited_design_rules(text: str) -> list[tuple[int, str]]:
    """(line, name) for each design rule a text cites; ``A → B`` cites both."""
    found: list[tuple[int, str]] = []
    for match in DESIGN_CITATION_RE.finditer(text):
        rest = text[match.end() : match.end() + 200]
        if rest[:1] in "\"“":
            cited = [re.split(r"[\"”]", rest[1:], maxsplit=1)[0]]
        else:
            # The name ends at punctuation. When it wraps, the words on the
            # first line alone are tried too, so a comment needs no full stop.
            rest = re.split(r"[()\[\]:;,`'\"|─]|\.(?:\s|$)|\*/|\n[ \t]*\n", rest, maxsplit=1)[0]
            cited = [COMMENT_WRAP_RE.sub(" ", rest), rest.split("\n", 1)[0]]
        line = text.count("\n", 0, match.start()) + 1
        found.append((line, "\n".join(cited)))
    return found


def _citation_errors(root: Path, citing_files: list[Path]) -> list[str]:
    errors: list[str] = []
    design = [root / "DESIGN.md", *sorted((root / "design").glob("*.md"))]
    names = _rule_names([path.read_text(encoding="utf-8") for path in design if path.is_file()])
    report = root / "appv3" / "REPORT.md"
    sections = (
        set(re.findall(r"^## (\d+)\. ", report.read_text(encoding="utf-8"), re.MULTILINE))
        if report.is_file()
        else set()
    )
    for path in sorted(citing_files, key=lambda item: _relative(root, item)):
        relative = _relative(root, path)
        if relative.startswith(HISTORY_PREFIXES):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if names:
            for line, cited in _cited_design_rules(text):
                candidates = cited.split("\n")
                # Every part of `A → B` must name a rule, in the long or the short reading.
                if not any(
                    all(_names_a_rule(part, names) for part in re.split(r"→|->", candidate))
                    for candidate in candidates
                ):
                    errors.append(
                        f"{relative}:{line}: no design rule is named {_rule_name(candidates[-1])!r}: "
                        "cite a heading of DESIGN.md or design/*.md "
                        "(grep -rn '^#' DESIGN.md design/), and end the name with punctuation"
                    )
        if sections:
            for match in REPORT_CITATION_RE.finditer(text):
                if match.group(1) not in sections:
                    line = text.count("\n", 0, match.start()) + 1
                    errors.append(
                        f"{relative}:{line}: appv3/REPORT.md has no section {match.group(1)}: "
                        f"its sections are {', '.join('§' + n for n in sorted(sections))}"
                    )
    return errors


def validate_repository(
    root: Path, markdown_files: list[Path], citing_files: list[Path] | None = None
) -> list[str]:
    """Return deterministic contract violations for the supplied tracked files."""
    root = root.resolve()
    errors: list[str] = []
    top_level = frozenset(
        item.name
        for item in root.iterdir()
        if item.is_dir() and (not item.name.startswith(".") or item.name in {".agents", ".github"})
    )
    for path in sorted(markdown_files, key=lambda item: _relative(root, item)):
        relative = _relative(root, path)
        size = path.stat().st_size
        if size > MAX_MARKDOWN_BYTES:
            errors.append(
                f"{relative}: {size:,} bytes is over the {MAX_MARKDOWN_BYTES:,}-byte limit "
                "for a Markdown file: split it by topic and link the parts from an index, "
                "as documents/docs/features.md does"
            )
        text = path.read_text(encoding="utf-8")
        fields = _frontmatter_fields(text)
        if fields is not None:
            for field in sorted(_required_frontmatter(relative) - fields):
                errors.append(f"{relative}: missing frontmatter field: {field}")
        for match in LINK_RE.finditer(text):
            target = _local_link_target(match.group(1))
            if (
                target is not None
                and not (path.parent / target).is_file()
                and not (path.parent / target).is_dir()
            ):
                errors.append(f"{relative}: local link target does not exist: {target}")
        for command in re.findall(r"`([^`]+)`", text):
            match = MAKE_RE.match(command.strip())
            if match:
                directory, target = match.groups()
                makefile = (
                    root / directory / "Makefile" if directory else root / "Makefile"
                )
                if target not in _make_targets(makefile):
                    errors.append(
                        f"{relative}: documented Make target does not exist: {target}"
                    )
        if not relative.startswith(HISTORY_PREFIXES):
            missing: list[str] = []
            for span in re.findall(r"`([^`\n]+)`", text):
                named = _repository_path(span, top_level)
                # A guide may name a path from the repository root or from its own folder.
                if named and not (root / named).exists() and not (path.parent / named).exists():
                    if relative == "AGENTS.md" and named.endswith("/AGENTS.md"):
                        continue  # reported below, with or without backticks
                    missing.append(named)
            # An ignored path exists on one machine and not on the next; only tracked ones are held.
            ignored = _git_ignored(root, sorted(set(missing)))
            errors.extend(
                f"{relative}: path does not exist: {named}" for named in missing if named not in ignored
            )

    checked = {item.resolve() for item in markdown_files}
    for index_name, folder_name in INDEXED_FOLDERS:
        index, folder = root / index_name, root / folder_name
        if not index.is_file() or not folder.is_dir():
            continue
        index_text = index.read_text(encoding="utf-8")
        linked = {
            (index.parent / target).resolve()
            for match in LINK_RE.finditer(index_text)
            if (target := _local_link_target(match.group(1))) is not None
        }
        for part in sorted(folder.glob("*.md")):
            if part.resolve() in checked and part.resolve() not in linked:
                errors.append(
                    f"{index_name}: does not link {_relative(root, part)}: "
                    "nobody finds a part its index does not name"
                )

    root_agents = root / "AGENTS.md"
    if root_agents.is_file():
        agents_text = root_agents.read_text(encoding="utf-8")
        for referenced in sorted(set(AGENTS_PATH_RE.findall(agents_text))):
            if not (root / referenced).is_file():
                errors.append(
                    f"AGENTS.md: referenced AGENTS path does not exist: {referenced}"
                )
        # The root guide is where an agent looks up which gate to run.
        for target in _make_targets(root / "Makefile"):
            if target.startswith("verify") and not re.search(
                rf"\bmake {re.escape(target)}(?![\w-])", agents_text
            ):
                errors.append(f"AGENTS.md: Make target is not documented: {target}")
    errors.extend(_tunnel_contract_errors(root))
    errors.extend(_citation_errors(root, citing_files or []))
    errors.extend(_test_citation_errors(root))
    errors.extend(_design_token_errors(root))
    return sorted(errors)


# `Tests: `agent/src/goal.rs`, `api/tests/http_api.rs`.` in the backend report.
TEST_CITATION_RE = re.compile(r"\bTests?:\s(.*?)(?:\.\s|\n\n|\Z)", re.DOTALL)
CITED_RUST_FILE_RE = re.compile(r"`([a-z_]+/(?:src|tests)/[\w/.]+\.rs)`")
RUST_TEST_RE = re.compile(r"#\[(?:tokio::)?test\b")


def _test_citation_errors(root: Path) -> list[str]:
    """A Rust file the backend report cites for its tests exists and holds tests."""
    errors: list[str] = []
    crates = root / "appv3" / "crates"
    for path in sorted((root / "appv3" / "report").glob("*.md")):
        text = path.read_text(encoding="utf-8")
        for sentence in TEST_CITATION_RE.finditer(text):
            for cited in CITED_RUST_FILE_RE.finditer(sentence.group(1)):
                name = cited.group(1)
                source = crates / name
                line = text.count("\n", 0, sentence.start(1) + cited.start()) + 1
                where = f"{_relative(root, path)}:{line}"
                if not source.is_file():
                    errors.append(f"{where}: cited test file does not exist: {name}")
                elif not RUST_TEST_RE.search(source.read_text(encoding="utf-8")):
                    # Inline test modules move to `<module>/tests.rs`, or `tests.rs` beside `lib.rs`.
                    moved = [
                        candidate
                        for candidate in (source.with_suffix("") / "tests.rs", source.parent / "tests.rs")
                        if candidate.is_file()
                    ]
                    hint = f": cite {moved[0].relative_to(crates).as_posix()}" if moved else ""
                    errors.append(f"{where}: {name} is cited for its tests but holds none{hint}")
    return errors


TUNNEL_SPEC = Path("appv3/contract/tunnel.md")
TUNNEL_VECTORS = Path("appv3/contract/tunnel_vectors.json")
# Shared inputs of the vectors file, not sections of their own.
TUNNEL_VECTOR_INPUTS = frozenset({"about", "account_id", "devices"})


def _tunnel_contract_errors(root: Path) -> list[str]:
    """Every section of the tunnel vectors is named in the spec's vector table."""
    spec, vectors = root / TUNNEL_SPEC, root / TUNNEL_VECTORS
    if not spec.is_file() and not vectors.is_file():
        return []
    if not spec.is_file() or not vectors.is_file():
        return [f"{TUNNEL_SPEC}: the spec and {TUNNEL_VECTORS.name} must ship together"]
    try:
        sections = set(json.loads(vectors.read_text(encoding="utf-8"))) - TUNNEL_VECTOR_INPUTS
    except (json.JSONDecodeError, TypeError):
        return [f"{TUNNEL_VECTORS}: not a JSON object"]
    named = set(re.findall(r"^\| `([a-z_]+)` \|", spec.read_text(encoding="utf-8"), re.MULTILINE))
    return [f"{TUNNEL_SPEC}: vector section not described: {name}" for name in sorted(sections - named)]


def _light_custom_properties(css: str) -> dict[str, str]:
    """Custom properties as the light theme first sets them on ``:root``."""
    values: dict[str, str] = {}
    context: list[str] = []
    for text, mark in re.findall(r"([^{};]*)([{};])", re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)):
        if mark == "{":
            context.append(text.strip())
            continue
        declaration = re.fullmatch(r"\s*--([\w-]+)\s*:\s*(.+?)\s*", text, re.DOTALL)
        if (
            declaration
            and context
            and ":root" in context[-1]
            and not any("dark" in rule or rule.startswith("@media") for rule in context)
        ):
            values.setdefault(declaration.group(1), declaration.group(2))
        if mark == "}" and context:
            context.pop()
    return values


def _design_token_errors(root: Path) -> list[str]:
    design, sheets = root / "DESIGN.md", [root / name for name in DESIGN_TOKEN_CSS]
    if not design.is_file() or not all(sheet.is_file() for sheet in sheets):
        return []
    text = design.read_text(encoding="utf-8")
    block = re.search(r"^colors:\n((?:[ \t#].*\n|\n)*)", text, re.MULTILINE)
    colors = re.findall(r'^  ([a-z0-9-]+): "(#[0-9A-Fa-f]{3,8})"', block.group(1) if block else "", re.MULTILINE)
    variables: dict[str, str] = {}
    for sheet in sheets:
        for name, value in _light_custom_properties(sheet.read_text(encoding="utf-8")).items():
            variables.setdefault(name, value)

    def resolved(value: str, depth: int = 0) -> str:
        reference = re.fullmatch(r"var\(--([\w-]+)\)", value)
        if reference and reference.group(1) in variables and depth < 10:
            return resolved(variables[reference.group(1)], depth + 1)
        return value

    errors: list[str] = []
    for token, value in colors:
        if token in DESIGN_COLORS_WITHOUT_A_VARIABLE:
            continue
        candidates = [DESIGN_COLOR_VARIABLES.get(token, token), f"color-{token}"]
        if token.startswith("on-"):
            candidates.append(f"color-text-{token}")
        variable = next((name for name in candidates if name in variables), None)
        if variable is None:
            errors.append(
                f"DESIGN.md: colour {token} has no custom property in {DESIGN_TOKEN_CSS[0]} "
                f"(looked for {', '.join('--' + name for name in candidates)}): "
                "name it in DESIGN_COLOR_VARIABLES in scripts/validate_docs.py, or remove the token"
            )
        elif resolved(variables[variable]).casefold() != value.casefold():
            errors.append(
                f"DESIGN.md: colour {token} is {value}, but --{variable} is "
                f"{resolved(variables[variable])} in the light theme ({DESIGN_TOKEN_CSS[0]}): "
                "change one so they agree"
            )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root",
    )
    args = parser.parse_args()
    try:
        errors = validate_repository(
            args.root, tracked_markdown_files(args.root), tracked_citing_files(args.root)
        )
    except (OSError, RuntimeError) as error:
        print(f"check_docs: {error}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
