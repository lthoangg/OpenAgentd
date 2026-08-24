"""Code and document outline generator for the read tool."""

from __future__ import annotations

import ast
import re
from pathlib import Path


def _format_py_arg(arg: ast.arg, default: ast.expr | None = None) -> str:
    res = arg.arg
    if arg.annotation:
        try:
            res += f": {ast.unparse(arg.annotation)}"
        except Exception:
            pass
    if default is not None:
        try:
            res += f" = {ast.unparse(default)}"
        except Exception:
            pass
    return res


def _format_py_func_sig(
    node: ast.FunctionDef | ast.AsyncFunctionDef, is_method: bool = False
) -> str:
    prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
    args_list: list[str] = []
    pos_args = node.args.args
    defaults = node.args.defaults
    num_defaults = len(defaults)
    first_default_idx = len(pos_args) - num_defaults

    for i, a in enumerate(pos_args):
        d = defaults[i - first_default_idx] if i >= first_default_idx else None
        args_list.append(_format_py_arg(a, d))

    if node.args.vararg:
        args_list.append(f"*{_format_py_arg(node.args.vararg)}")
    elif node.args.kwonlyargs:
        args_list.append("*")

    for i, a in enumerate(node.args.kwonlyargs):
        d = node.args.kw_defaults[i] if i < len(node.args.kw_defaults) else None
        args_list.append(_format_py_arg(a, d))

    if node.args.kwarg:
        args_list.append(f"**{_format_py_arg(node.args.kwarg)}")

    args_str = ", ".join(args_list)
    ret_str = ""
    if node.returns:
        try:
            ret_str = f" -> {ast.unparse(node.returns)}"
        except Exception:
            pass

    indent = "  " if is_method else ""
    return f"{indent}{prefix}{node.name}({args_str}){ret_str}"


def _extract_py_outline(content: str, total_lines: int) -> list[tuple[int, str]]:
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return []

    entries: list[tuple[int, str]] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            bases = []
            for b in node.bases:
                try:
                    bases.append(ast.unparse(b))
                except Exception:
                    pass
            base_str = f"({', '.join(bases)})" if bases else ""
            entries.append((node.lineno, f"class {node.name}{base_str}:"))
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    sig = _format_py_func_sig(item, is_method=True)
                    entries.append((item.lineno, sig))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            sig = _format_py_func_sig(node, is_method=False)
            entries.append((node.lineno, sig))
    return entries


def _extract_ts_js_outline(lines: list[str]) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    for idx, line in enumerate(lines, start=1):
        line_strip = line.strip()
        if not line_strip or line_strip.startswith(
            ("//", "/*", "*", "import ", "from ")
        ):
            continue
        # Interface, Type, Class, Function, Enum, Export const
        if re.match(r"^(export\s+)?(default\s+)?interface\s+\w+", line_strip):
            sig = line_strip.split("{")[0].strip()
            entries.append((idx, sig))
        elif re.match(r"^(export\s+)?(default\s+)?type\s+\w+\s*=", line_strip):
            entries.append((idx, line_strip.rstrip(";").strip()))
        elif re.match(
            r"^(export\s+)?(default\s+)?(async\s+)?function\s+\w+", line_strip
        ):
            sig = line_strip.split("{")[0].strip()
            entries.append((idx, sig))
        elif re.match(r"^(export\s+)?(default\s+)?class\s+\w+", line_strip):
            sig = line_strip.split("{")[0].strip()
            entries.append((idx, sig))
        elif re.match(r"^(export\s+)?enum\s+\w+", line_strip):
            sig = line_strip.split("{")[0].strip()
            entries.append((idx, sig))
        elif re.match(r"^export\s+const\s+(use\w+|[A-Z]\w+)\s*=", line_strip):
            sig = line_strip.split("=")[0].strip()
            entries.append((idx, sig))
    return entries


def _extract_rust_outline(lines: list[str]) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    for idx, line in enumerate(lines, start=1):
        line_strip = line.strip()
        if not line_strip or line_strip.startswith(("//", "/*", "*", "use ")):
            continue
        if re.match(
            r"^(pub(\(.*\))?\s+)?(struct|enum|trait|type|union)\s+\w+", line_strip
        ):
            sig = line_strip.split("{")[0].split(";")[0].strip()
            entries.append((idx, sig))
        elif re.match(
            r"^(pub(\(.*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+", line_strip
        ):
            sig = line_strip.split("{")[0].split(";")[0].strip()
            entries.append((idx, sig))
        elif re.match(r"^impl(\s+<.*>)?\s+.*", line_strip):
            sig = line_strip.split("{")[0].strip()
            entries.append((idx, sig))
    return entries


def _extract_go_outline(lines: list[str]) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    for idx, line in enumerate(lines, start=1):
        line_strip = line.strip()
        if not line_strip or line_strip.startswith(
            ("//", "/*", "*", "import ", "package ")
        ):
            continue
        if re.match(r"^type\s+\w+\s+(struct|interface)", line_strip):
            sig = line_strip.split("{")[0].strip()
            entries.append((idx, sig))
        elif re.match(r"^func\s+(\(.*\)\s+)?\w+", line_strip):
            sig = line_strip.split("{")[0].strip()
            entries.append((idx, sig))
    return entries


def _extract_markdown_outline(lines: list[str]) -> list[tuple[int, str]]:
    entries: list[tuple[int, str]] = []
    for idx, line in enumerate(lines, start=1):
        line_strip = line.strip()
        if line_strip.startswith("#"):
            entries.append((idx, line_strip))
    return entries


def generate_file_outline(resolved: Path, rel: object) -> str:
    """Extract high-level outline (classes, functions, types, headers) with line numbers."""
    try:
        content = resolved.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = resolved.read_text(encoding="latin-1")

    if not content.strip():
        return f"[Outline of {rel} (empty file)]"

    lines = content.splitlines()
    total_lines = len(lines)
    suffix = resolved.suffix.lower()

    entries: list[tuple[int, str]] = []
    if suffix == ".py":
        entries = _extract_py_outline(content, total_lines)
    elif suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
        entries = _extract_ts_js_outline(lines)
    elif suffix == ".rs":
        entries = _extract_rust_outline(lines)
    elif suffix == ".go":
        entries = _extract_go_outline(lines)
    elif suffix in (".md", ".markdown"):
        entries = _extract_markdown_outline(lines)

    if not entries:
        return f"[Outline of {rel} ({total_lines} lines): no symbol declarations found]"

    num_symbols = len(entries)
    header = f"[Outline of {rel} ({total_lines} lines, {num_symbols} symbols)]\n"
    body = "\n".join(f"Line {lineno}: {text}" for lineno, text in entries)
    return header + body
