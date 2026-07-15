"""Tests for multimodal file handlers — images, documents, and text files.

Tests the new multimodal read feature:
- classify_file() categorizes files by extension
- handle_image() returns ToolResult with ImageDataBlock
- handle_document() converts documents via markitdown (vision-gated PDF fallback)
- read_file tool returns ToolResult for images/documents, str for text
- Vision capability gating: non-vision models get text-only results
"""

from __future__ import annotations

import base64
import io
from pathlib import Path
from unittest.mock import patch

import pytest

from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.schemas.chat import (
    ContentBlock,
    ImageDataBlock,
    TextBlock,
    ToolMessage,
    ToolResult,
)
from app.agent.tools.builtin.filesystem import read_file
from app.agent.tools.builtin.filesystem import read as read_module
from app.agent.tools.builtin.filesystem.handlers import (
    _MAX_IMAGE_BYTES,
    classify_file,
    handle_document,
    handle_image,
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _text_from_parts(parts: list) -> str:
    """Join text from all TextBlock items in *parts*."""
    return " ".join(p.text for p in parts if isinstance(p, TextBlock))


def _make_state(*, vision: bool) -> object:
    """Build an AgentState with the given vision capability."""
    from app.agent.providers.capabilities import (
        ModelCapabilities,
        ModelInputCapabilities,
    )
    from app.agent.state import AgentState

    return AgentState(
        messages=[],
        capabilities=ModelCapabilities(input=ModelInputCapabilities(vision=vision)),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def sandbox(tmp_path):
    sb = SandboxConfig(workspace=str(tmp_path))
    token = set_sandbox(sb)
    yield sb, tmp_path
    from app.agent.sandbox import _sandbox_ctx

    _sandbox_ctx.reset(token)


@pytest.fixture
def workspace(tmp_path):
    sb = SandboxConfig(workspace=str(tmp_path))
    set_sandbox(sb)
    yield tmp_path


# ─────────────────────────────────────────────────────────────────────────────
# classify_file() tests
# ─────────────────────────────────────────────────────────────────────────────


class TestClassifyFile:
    def test_classify_image_extensions(self):
        for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"):
            assert classify_file(Path(f"f{ext}")) == "image", ext

    def test_classify_image_case_insensitive(self):
        assert classify_file(Path("f.PNG")) == "image"
        assert classify_file(Path("f.JPG")) == "image"

    def test_classify_document_extensions(self):
        for ext in (".pdf", ".docx", ".html", ".htm"):
            assert classify_file(Path(f"f{ext}")) == "document", ext

    def test_classify_text_extensions(self):
        for ext in (".py", ".txt", ".md", ".json", ".yaml"):
            assert classify_file(Path(f"f{ext}")) == "text", ext

    def test_classify_unknown(self):
        assert classify_file(Path("f.xyz")) == "text"
        assert classify_file(Path("f")) == "text"


# ─────────────────────────────────────────────────────────────────────────────
# handle_image() tests
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleImage:
    def test_returns_tool_result_with_parts(self, tmp_path):
        img = tmp_path / "test.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)

        result = handle_image(img, Path("test.png"))

        assert isinstance(result, ToolResult)
        assert len(result.parts) == 2
        assert isinstance(result.parts[0], TextBlock)
        assert isinstance(result.parts[1], ImageDataBlock)

    def test_base64_encoding(self, tmp_path):
        raw = b"test_image_data"
        img = tmp_path / "test.png"
        img.write_bytes(raw)

        result = handle_image(img, Path("test.png"))
        assert result.parts[1].data == base64.b64encode(raw).decode("ascii")

    def test_media_type_png(self, tmp_path):
        img = tmp_path / "test.png"
        img.write_bytes(b"\x89PNG" + b"\x00" * 100)

        result = handle_image(img, Path("test.png"))
        assert result.parts[1].media_type == "image/png"

    def test_media_type_jpeg(self, tmp_path):
        img = tmp_path / "test.jpg"
        img.write_bytes(b"\xff\xd8\xff" + b"\x00" * 100)

        result = handle_image(img, Path("test.jpg"))
        assert result.parts[1].media_type == "image/jpeg"

    def test_exceeds_size_limit(self, tmp_path):
        img = tmp_path / "big.png"
        img.write_bytes(b"\x00" * (10_485_760 + 1))

        with pytest.raises(ValueError, match="exceeds the"):
            handle_image(img, Path("big.png"))

    def test_at_size_limit(self, tmp_path):
        img = tmp_path / "ok.png"
        img.write_bytes(b"\x00" * 10_485_760)

        result = handle_image(img, Path("ok.png"))
        assert len(result.parts) == 2

    def test_oversized_image_is_rejected_before_reading(self, tmp_path):
        img = tmp_path / "big.png"
        img.write_bytes(b"\x00" * (_MAX_IMAGE_BYTES + 1))

        with patch.object(Path, "read_bytes", side_effect=AssertionError("read")):
            with pytest.raises(ValueError, match="exceeds the"):
                handle_image(img, Path("big.png"))


# ─────────────────────────────────────────────────────────────────────────────
# handle_document() tests
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleDocument:
    def test_successful_conversion(self, tmp_path):
        pdf = tmp_path / "test.pdf"
        pdf.write_bytes(b"%PDF-1.4" + b"\x00" * 100)

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = "# Title\n\nBody."
            result = handle_document(pdf, Path("test.pdf"))

        text = _text_from_parts(result.parts)
        assert "[Document: test.pdf]" in text
        assert "# Title" in text
        assert len(result.parts) == 1

    def test_pdf_fallback_on_conversion_failure(self, tmp_path):
        """When markitdown fails on a PDF, raw bytes are sent as image fallback."""
        pdf = tmp_path / "test.pdf"
        pdf.write_bytes(b"%PDF-1.4" + b"\x00" * 100)

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = None
            result = handle_document(pdf, Path("test.pdf"))

        assert len(result.parts) == 2
        assert isinstance(result.parts[1], ImageDataBlock)
        assert result.parts[1].media_type == "application/pdf"

    def test_non_pdf_failure(self, tmp_path):
        docx = tmp_path / "test.docx"
        docx.write_bytes(b"PK\x03\x04" + b"\x00" * 100)

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = None
            result = handle_document(docx, Path("test.docx"))

        text = _text_from_parts(result.parts)
        assert "Unable to extract text" in text
        assert len(result.parts) == 1

    def test_pdf_fallback_respects_size_limit(self, tmp_path):
        big = tmp_path / "big.pdf"
        big.write_bytes(b"%PDF-1.4" + b"\x00" * (10_485_760 + 1))

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = None
            result = handle_document(big, Path("big.pdf"))

        # Too large for image fallback — falls through to text error
        assert len(result.parts) == 1

    def test_oversized_document_is_rejected_before_reading_or_conversion(
        self, tmp_path
    ):
        pdf = tmp_path / "big.pdf"
        pdf.write_bytes(b"\x00" * (_MAX_IMAGE_BYTES + 1))

        with (
            patch.object(Path, "read_bytes", side_effect=AssertionError("read")),
            patch(
                "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
            ) as convert,
        ):
            result = handle_document(pdf, Path("big.pdf"))

        assert len(result.parts) == 1
        assert "exceeds the" in result.parts[0].text
        convert.assert_not_called()


# ─────────────────────────────────────────────────────────────────────────────
# read_file integration — vision model
# ─────────────────────────────────────────────────────────────────────────────


class TestReadFileVision:
    """read_file with a vision-capable model."""

    @pytest.mark.asyncio
    async def test_text_file_returns_string(self, workspace):
        (workspace / "test.txt").write_text("hello world")
        result = await read_file.arun(
            _injected={"_state": _make_state(vision=True)}, path="test.txt"
        )
        assert isinstance(result, str)
        assert result == "hello world"

    @pytest.mark.asyncio
    async def test_text_read_requests_at_most_cap_plus_one_bytes(self, workspace):
        path = workspace / "large.txt"
        path.write_bytes(b"x" * (read_module._MAX_READ_BYTES + 2))
        contents = path.read_bytes()
        read_sizes: list[int] = []

        class TrackingReader(io.BytesIO):
            def read(self, size=-1):
                read_sizes.append(size)
                return super().read(size)

        def open_tracking(path_arg, *args, **kwargs):
            return TrackingReader(contents)

        with patch.object(Path, "open", autospec=True, side_effect=open_tracking):
            result = await read_file.arun(
                _injected={"_state": _make_state(vision=True)}, path="large.txt"
            )

        assert isinstance(result, str)
        assert read_sizes == [read_module._MAX_READ_BYTES + 1]

    @pytest.mark.asyncio
    async def test_image_returns_tool_result(self, workspace):
        (workspace / "img.png").write_bytes(b"\x89PNG" + b"\x00" * 100)

        result = await read_file.arun(
            _injected={"_state": _make_state(vision=True)}, path="img.png"
        )

        assert isinstance(result, ToolResult)
        assert len(result.parts) == 2
        assert isinstance(result.parts[1], ImageDataBlock)

    @pytest.mark.asyncio
    async def test_document_returns_tool_result(self, workspace):
        (workspace / "doc.pdf").write_bytes(b"%PDF-1.4" + b"\x00" * 100)

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = "# Content"
            result = await read_file.arun(
                _injected={"_state": _make_state(vision=True)}, path="doc.pdf"
            )

        assert isinstance(result, ToolResult)

    @pytest.mark.asyncio
    async def test_text_pagination(self, workspace):
        (workspace / "paged.txt").write_text(
            "\n".join(f"line{i}" for i in range(1, 11))
        )

        result = await read_file.arun(
            _injected={"_state": _make_state(vision=True)},
            path="paged.txt",
            offset=2,
            limit=3,
        )

        assert isinstance(result, str)
        assert result.startswith("[2-4/10]")

    @pytest.mark.asyncio
    async def test_multiple_image_formats(self, workspace):
        for name, hdr in [
            ("a.jpg", b"\xff\xd8\xff"),
            ("b.gif", b"GIF89a"),
            ("c.webp", b"RIFF"),
        ]:
            (workspace / name).write_bytes(hdr + b"\x00" * 100)
            result = await read_file.arun(
                _injected={"_state": _make_state(vision=True)}, path=name
            )
            assert isinstance(result, ToolResult), name


# ─────────────────────────────────────────────────────────────────────────────
# read_file integration — non-vision model
# ─────────────────────────────────────────────────────────────────────────────


class TestReadFileNoVision:
    """read_file with a model that does NOT support vision."""

    @pytest.mark.asyncio
    async def test_image_returns_tool_result_even_without_vision(self, workspace):
        (workspace / "img.png").write_bytes(b"\x89PNG" + b"\x00" * 100)

        result = await read_file.arun(
            _injected={"_state": _make_state(vision=False)}, path="img.png"
        )

        assert isinstance(result, ToolResult)
        assert len(result.parts) == 2
        assert isinstance(result.parts[1], ImageDataBlock)

    @pytest.mark.asyncio
    async def test_image_without_state_returns_tool_result(self, workspace):
        """When _state is None (e.g. direct call), it returns the image."""
        (workspace / "img.png").write_bytes(b"\x89PNG" + b"\x00" * 100)

        result = await read_file.arun(path="img.png")

        assert isinstance(result, ToolResult)
        assert len(result.parts) == 2
        assert isinstance(result.parts[1], ImageDataBlock)

    @pytest.mark.asyncio
    async def test_text_file_unaffected(self, workspace):
        (workspace / "test.txt").write_text("hello")

        result = await read_file.arun(
            _injected={"_state": _make_state(vision=False)}, path="test.txt"
        )

        assert isinstance(result, str)
        assert result == "hello"

    @pytest.mark.asyncio
    async def test_document_still_converts_text(self, workspace):
        """Documents still get markitdown conversion regardless of vision."""
        (workspace / "doc.pdf").write_bytes(b"%PDF-1.4" + b"\x00" * 100)

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = "# Extracted"
            result = await read_file.arun(
                _injected={"_state": _make_state(vision=False)}, path="doc.pdf"
            )

        assert isinstance(result, ToolResult)
        text = _text_from_parts(result.parts)
        assert "# Extracted" in text

    @pytest.mark.asyncio
    async def test_pdf_image_fallback_regardless_of_vision(self, workspace):
        """PDF conversion failure regardless of vision -> falls back to raw image."""
        (workspace / "doc.pdf").write_bytes(b"%PDF-1.4" + b"\x00" * 100)

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = None
            result = await read_file.arun(
                _injected={"_state": _make_state(vision=False)}, path="doc.pdf"
            )

        assert isinstance(result, ToolResult)
        # Should have an ImageDataBlock for PDF fallback
        image_blocks = [p for p in result.parts if isinstance(p, ImageDataBlock)]
        assert len(image_blocks) == 1


# ─────────────────────────────────────────────────────────────────────────────
# read_file error handling
# ─────────────────────────────────────────────────────────────────────────────


class TestReadFileErrors:
    @pytest.mark.asyncio
    async def test_file_not_found(self, workspace):
        from app.agent.errors import ToolExecutionError

        with pytest.raises(ToolExecutionError):
            await read_file.arun(path="missing.txt")

    @pytest.mark.asyncio
    async def test_is_directory(self, workspace):
        from app.agent.errors import ToolExecutionError

        (workspace / "subdir").mkdir()
        with pytest.raises(ToolExecutionError):
            await read_file.arun(path="subdir")


# ─────────────────────────────────────────────────────────────────────────────
# ToolResult schema tests
# ─────────────────────────────────────────────────────────────────────────────


class TestToolResult:
    def test_parts_only(self):
        result = ToolResult(parts=[TextBlock(text="hello")])
        assert len(result.parts) == 1

    def test_mixed_content_blocks(self):
        parts: list[ContentBlock] = [
            TextBlock(text="Image:"),
            ImageDataBlock(data="base64data", media_type="image/png"),
        ]
        result = ToolResult(parts=parts)
        assert len(result.parts) == 2


# ─────────────────────────────────────────────────────────────────────────────
# ToolMessage.parts tests
# ─────────────────────────────────────────────────────────────────────────────


class TestToolMessageParts:
    def test_parts_default_none(self):
        msg = ToolMessage(content="r", tool_call_id="1")
        assert msg.parts is None

    def test_parts_can_be_set(self):
        parts: list[ContentBlock] = [TextBlock(text="c")]
        msg = ToolMessage(content="r", tool_call_id="1", parts=parts)
        assert msg.parts == parts

    def test_parts_excluded_from_model_dump(self):
        msg = ToolMessage(content="r", tool_call_id="1", parts=[TextBlock(text="c")])
        assert "parts" not in msg.model_dump()

    def test_parts_included_in_model_dump_full(self):
        msg = ToolMessage(content="r", tool_call_id="1", parts=[TextBlock(text="c")])
        assert "parts" in msg.model_dump_full()

    def test_with_image_parts(self):
        parts: list[ContentBlock] = [
            TextBlock(text="label"),
            ImageDataBlock(data="b64", media_type="image/png"),
        ]
        msg = ToolMessage(content="d", tool_call_id="1", parts=parts)
        assert isinstance(msg.parts[1], ImageDataBlock)
