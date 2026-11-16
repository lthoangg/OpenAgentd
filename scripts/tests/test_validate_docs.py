from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path


def _load_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "validate_docs.py"
    spec = importlib.util.spec_from_file_location("validate_docs", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write_repo(tmp_path: Path) -> list[Path]:
    (tmp_path / "documents" / "docs").mkdir(parents=True)
    (tmp_path / "docs").mkdir()
    (tmp_path / "Makefile").write_text("test:\n\t@true\n\n.PHONY: test\n")
    (tmp_path / "AGENTS.md").write_text("See `docs/AGENTS.md`.\n")
    (tmp_path / "docs" / "AGENTS.md").write_text("# Local instructions\n")
    (tmp_path / "documents" / "docs" / "guide.md").write_text(
        "---\ntitle: Guide\ndescription: A guide\nstatus: stable\nupdated: 2026-07-14\n---\n"
        "[Home](../../README.md) [Section](#section) [URL](https://example.test) "
        "[Mail](mailto:docs@example.test) ![Logo](logo.png) `make test`\n"
    )
    (tmp_path / "README.md").write_text("# Home\n")
    return sorted(tmp_path.rglob("*.md"))


def test_tracked_markdown_files_excludes_removed_worktree_files(tmp_path, monkeypatch):
    module = _load_module()
    existing = tmp_path / "README.md"
    existing.write_text("# Home\n")
    output = b"README.md\0documents/docs/removed.md\0"
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, output, b""),
    )

    assert module.tracked_markdown_files(tmp_path) == [existing]


def test_tracked_markdown_files_skips_vendored_crates(tmp_path, monkeypatch):
    module = _load_module()
    existing = tmp_path / "README.md"
    existing.write_text("# Home\n")
    vendored = tmp_path / "appv3" / "vendor" / "anydoc" / "README.md"
    vendored.parent.mkdir(parents=True)
    vendored.write_text("[Bench](bench/README.md)\n")
    output = b"README.md\0appv3/vendor/anydoc/README.md\0"
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, output, b""),
    )

    assert module.tracked_markdown_files(tmp_path) == [existing]


def test_validate_repository_accepts_coherent_documentation_contract(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)

    assert module.validate_repository(tmp_path, tracked) == []


def test_validate_repository_reports_each_documentation_contract_violation(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "documents" / "docs" / "guide.md").write_text(
        "---\ntitle: Guide\nstatus: stable\nupdated: 2026-07-14\n---\n"
        "[Missing](missing.md) `make missing`\n"
    )
    (tmp_path / "AGENTS.md").write_text("See `docs/missing/AGENTS.md`.\n")
    errors = module.validate_repository(tmp_path, tracked)

    assert errors == sorted(
        [
            "AGENTS.md: referenced AGENTS path does not exist: docs/missing/AGENTS.md",
            "documents/docs/guide.md: missing frontmatter field: description",
            "documents/docs/guide.md: local link target does not exist: missing.md",
            "documents/docs/guide.md: documented Make target does not exist: missing",
        ]
    )


def test_a_feature_area_file_needs_a_title_and_description_but_no_date(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    area = tmp_path / "documents" / "docs" / "features" / "area.md"
    area.parent.mkdir()
    area.write_text('---\ntitle: "Features: Area"\n---\n# Area\n')

    # `status` and `updated` belong to the index, which the release script rewrites.
    assert module.validate_repository(tmp_path, [*tracked, area]) == [
        "documents/docs/features/area.md: missing frontmatter field: description"
    ]


def test_a_markdown_file_over_the_size_limit_is_refused(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "README.md").write_text("# Home\n" + "x" * module.MAX_MARKDOWN_BYTES)

    assert module.validate_repository(tmp_path, tracked) == [
        "README.md: 50,007 bytes is over the 50,000-byte limit for a Markdown file: "
        "split it by topic and link the parts from an index, as documents/docs/features.md does"
    ]


def test_a_guide_may_only_name_paths_that_exist(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "web" / "src").mkdir(parents=True)
    (tmp_path / "web" / "src" / "app.ts").write_text("")
    (tmp_path / "docs" / "scripts").mkdir()
    (tmp_path / "docs" / "scripts" / "run.sh").write_text("")
    (tmp_path / "docs" / "AGENTS.md").write_text(
        "Edit `web/src/app.ts` (see `web/src/app.ts:12`), not `web/src/gone.ts`.\n"
        # From the guide's own folder, a placeholder, a glob, and prose are not checked.
        "Run `scripts/run.sh`. `web/src/<name>.ts`, `web/**`, `web or docs`.\n"
    )
    history = tmp_path / "documents" / "docs" / "features" / "area.md"
    history.parent.mkdir()
    history.write_text('---\ntitle: "A"\ndescription: "B"\n---\nShipped in `web/src/old.ts`.\n')

    assert module.validate_repository(tmp_path, [*tracked, history]) == [
        "docs/AGENTS.md: path does not exist: web/src/gone.ts"
    ]


def test_an_ignored_path_may_be_absent_as_in_a_fresh_clone(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "web").mkdir()
    (tmp_path / ".gitignore").write_text("web/dist/\n")
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "docs" / "AGENTS.md").write_text("Never edit `web/dist/`. Edit `web/src/`.\n")

    assert module.validate_repository(tmp_path, tracked) == [
        "docs/AGENTS.md: path does not exist: web/src/"
    ]


ARROW = "\u2192"
SECTION = "\u00a7"


def _write_design(tmp_path: Path) -> None:
    (tmp_path / "design").mkdir()
    (tmp_path / "DESIGN.md").write_text("# Paper\n\n## Map\n\n[Motion](design/motion.md)\n")
    (tmp_path / "design" / "motion.md").write_text(
        "# Design: motion\n\n## Motion\n\n### Rulebook 4: Icons\n\n"
        "### Panels and management surfaces\n\n- **One name per thing.** Workspace.\n"
    )
    (tmp_path / "appv3").mkdir()
    (tmp_path / "appv3" / "REPORT.md").write_text("# Log\n\n## 1. Parity\n\n## 3. Differences\n")


def test_a_citation_must_name_a_design_rule_or_a_report_section(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    _write_design(tmp_path)
    good = tmp_path / "good.ts"
    good.write_text(
        f"// Fades (DESIGN.md {ARROW} Motion): 150ms.\n"
        f"// One size per role (DESIGN.md {ARROW} Rulebook 4, 5);\n"
        f"/* Shared tokens (DESIGN.md {ARROW} Panels and\n * management surfaces). */\n"
        f"// A bullet's bold name counts (DESIGN.md, \"One name per thing\"): Retry.\n"
        f"// {ARROW} first words are enough: DESIGN.md {ARROW} Panels\nconst x = 1\n"
        f"// Nested: DESIGN.md {ARROW} Motion {ARROW} Rulebook 4.\n"
        f"// Additive key (see REPORT.md {SECTION}3); also REPORT {SECTION}1.\n"
        "// Read DESIGN.md before changing this.\n"
    )
    stale = tmp_path / "stale.css"
    stale.write_text(
        f"/* Phone (DESIGN.md {ARROW} Touch density): 15px. */\n"
        f"/* DESIGN.md {ARROW} Rulebook 40. */\n"
        f"/* see REPORT {SECTION}3b */\n"
    )

    hint = (
        "cite a heading of DESIGN.md or design/*.md "
        "(grep -rn '^#' DESIGN.md design/), and end the name with punctuation"
    )
    assert module.validate_repository(tmp_path, tracked, [good, stale]) == [
        f"stale.css:1: no design rule is named 'touch density': {hint}",
        f"stale.css:2: no design rule is named 'rulebook 40': {hint}",
        f"stale.css:3: appv3/REPORT.md has no section 3b: its sections are {SECTION}1, {SECTION}3",
    ]


def test_a_file_the_report_cites_for_its_tests_holds_tests(tmp_path):
    module = _load_module()
    markdown_files = _write_repo(tmp_path)
    agent = tmp_path / "appv3" / "crates" / "agent"
    (agent / "src" / "goal").mkdir(parents=True)
    (agent / "tests").mkdir()
    (agent / "src" / "goal.rs").write_text("pub fn start() {}\n#[cfg(test)]\nmod tests;\n")
    (agent / "src" / "goal" / "tests.rs").write_text("#[test]\nfn starts() {}\n")
    (agent / "tests" / "goal_loop.rs").write_text("#[tokio::test]\nasync fn loops() {}\n")
    report = tmp_path / "appv3" / "report"
    report.mkdir()
    (report / "runtime.md").write_text(
        "# Runtime\n\n- Goals (`agent/src/goal.rs`).\n  Tests: `agent/tests/goal_loop.rs`, unit tests in\n"
        "  `agent/src/goal.rs`, `agent/src/gone.rs`. More prose about `agent/src/goal.rs`.\n"
    )

    assert module.validate_repository(tmp_path, markdown_files) == [
        "appv3/report/runtime.md:5: agent/src/goal.rs is cited for its tests but holds none: "
        "cite agent/src/goal/tests.rs",
        "appv3/report/runtime.md:5: cited test file does not exist: agent/src/gone.rs",
    ]

    (report / "runtime.md").write_text("# Runtime\n\nTests: `agent/src/goal/tests.rs`.\n")
    assert module.validate_repository(tmp_path, markdown_files) == []


def test_an_index_must_link_every_part_in_its_folder(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    _write_design(tmp_path)
    orphan = tmp_path / "design" / "brand.md"
    orphan.write_text("# Design: brand\n")
    parts = [tmp_path / "DESIGN.md", tmp_path / "design" / "motion.md", orphan]

    assert module.validate_repository(tmp_path, [*tracked, *parts]) == [
        "DESIGN.md: does not link design/brand.md: nobody finds a part its index does not name"
    ]


def _write_tokens(tmp_path: Path, design_card: str) -> None:
    (tmp_path / "web" / "src" / "styles").mkdir(parents=True)
    (tmp_path / "DESIGN.md").write_text(
        "---\nname: Paper\ncolors:\n  # roles\n  primary: \"#3F3429\"   # Bark\n\n"
        f"  bg-card: \"{design_card}\"\n  on-danger: \"#991B1B\"\n  error-container: \"#F5E5DB\"\n"
        "typography:\n  body: 14px\n---\n# Paper\n"
    )
    (tmp_path / "web" / "src" / "styles" / "tokens.css").write_text(
        "/* dark first, and a contrast override last: neither is the light value */\n"
        ":root.dark { --bg-card: #1C1813; --color-accent: #F5EBD8; }\n"
        ":root, :root.light {\n  --bg-card: #fffbf1;\n  --color-accent: #3F3429;\n"
        "  --color-text-on-danger: var(--color-diff-del-text);\n  --color-diff-del-text: #991B1B;\n}\n"
        "@media (prefers-contrast: more) { :root { --bg-card: #FFFFFF; } }\n"
    )
    (tmp_path / "web" / "src" / "index.css").write_text(":root { --focus-outline: #174A73 }\n")


def test_design_colours_must_equal_the_light_theme(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    _write_tokens(tmp_path, "#FFFBF1")
    assert module.validate_repository(tmp_path, tracked) == []

    (tmp_path / "DESIGN.md").write_text(
        (tmp_path / "DESIGN.md").read_text().replace('bg-card: "#FFFBF1"', 'bg-card: "#FFFFFF"\n  bg-new: "#000000"')
    )
    assert module.validate_repository(tmp_path, tracked) == [
        "DESIGN.md: colour bg-card is #FFFFFF, but --bg-card is #fffbf1 in the light theme "
        "(web/src/styles/tokens.css): change one so they agree",
        "DESIGN.md: colour bg-new has no custom property in web/src/styles/tokens.css "
        "(looked for --bg-new, --color-bg-new): name it in DESIGN_COLOR_VARIABLES in "
        "scripts/validate_docs.py, or remove the token",
    ]


def test_the_real_design_tokens_are_compared_and_agree() -> None:
    module = _load_module()
    root = Path(__file__).resolve().parents[2]
    assert module._design_token_errors(root) == []
    # Not vacuous: the light theme and the token block are both being read.
    assert len(module._light_custom_properties((root / "web/src/styles/tokens.css").read_text())) > 60
    assert len(module.re.findall(r'^  [a-z0-9-]+: "#', (root / "DESIGN.md").read_text(), module.re.MULTILINE)) > 60


def test_every_verify_target_is_named_in_the_root_agents_guide(tmp_path):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "Makefile").write_text("test:\n\t@true\nverify: verify-web\nverify-web:\n\t@true\nverify-cloud:\n\t@true\n")
    (tmp_path / "AGENTS.md").write_text("See `docs/AGENTS.md`.\n\n```bash\nmake verify-web  # web checks\n```\n")

    # `make verify-web` does not count as naming `make verify`.
    assert module.validate_repository(tmp_path, tracked) == [
        "AGENTS.md: Make target is not documented: verify",
        "AGENTS.md: Make target is not documented: verify-cloud",
    ]


def test_main_returns_nonzero_and_prints_deterministic_errors(
    tmp_path, monkeypatch, capsys
):
    module = _load_module()
    tracked = _write_repo(tmp_path)
    (tmp_path / "documents" / "docs" / "guide.md").write_text("[Missing](missing.md)\n")
    monkeypatch.setattr(module, "tracked_markdown_files", lambda root: tracked)
    monkeypatch.setattr(module, "tracked_citing_files", lambda root: [])
    monkeypatch.setattr("sys.argv", ["validate_docs.py", "--root", str(tmp_path)])

    assert module.main() == 1
    assert (
        capsys.readouterr().err
        == "documents/docs/guide.md: local link target does not exist: missing.md\n"
    )


def test_tunnel_vector_sections_must_be_named_in_the_spec(tmp_path: Path) -> None:
    module = _load_module()
    contract = tmp_path / "appv3" / "contract"
    contract.mkdir(parents=True)
    (contract / "tunnel_vectors.json").write_text('{"about": "x", "account_id": "a", "roster": [], "noise": []}')
    (contract / "tunnel.md").write_text("| Key | Covers |\n|---|---|\n| `roster` | Rosters |\n")
    errors = module.validate_repository(tmp_path, [])
    assert errors == ["appv3/contract/tunnel.md: vector section not described: noise"]


def test_the_real_tunnel_contract_is_complete() -> None:
    module = _load_module()
    root = Path(__file__).resolve().parents[2]
    assert module._tunnel_contract_errors(root) == []
