"""Document conversion for the `read` tool, backed by anydoc.

Fixtures are built in-process so the suite carries no binary files: a minimal
but structurally valid PDF (xref table and all) and a minimal DOCX package.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from unittest.mock import patch


from app.agent.schemas.chat import ImageDataBlock, TextBlock
from app.agent.tools.builtin.filesystem.handlers import handle_document


def _minimal_pdf(text: bytes = b"Hello Anydoc World") -> bytes:
    """Return a valid single-page PDF. Offsets in the xref must be exact."""
    objs: list[bytes | None] = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R"
        b"/Resources<</Font<</F1 5 0 R>>>>>>",
        None,
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    stream = b"BT /F1 24 Tf 72 700 Td (" + text + b") Tj ET"
    objs[3] = (
        b"<</Length "
        + str(len(stream)).encode()
        + b">>stream\n"
        + stream
        + b"\nendstream"
    )

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for index, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += str(index).encode() + b" 0 obj\n" + body + b"\nendobj\n"

    xref_at = len(out)
    size = len(objs) + 1
    out += b"xref\n0 " + str(size).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets:
        out += ("%010d 00000 n \n" % offset).encode()
    out += (
        b"trailer<</Size "
        + str(size).encode()
        + b"/Root 1 0 R>>\nstartxref\n"
        + str(xref_at).encode()
        + b"\n%%EOF\n"
    )
    return bytes(out)


def _minimal_docx(text: str = "Hello from DOCX") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            "<?xml version='1.0'?><Types xmlns='http://schemas.openxmlformats.org"
            "/package/2006/content-types'><Default Extension='xml' ContentType="
            "'application/xml'/><Override PartName='/word/document.xml' ContentType="
            "'application/vnd.openxmlformats-officedocument.wordprocessingml."
            "document.main+xml'/></Types>",
        )
        archive.writestr(
            "_rels/.rels",
            "<?xml version='1.0'?><Relationships xmlns='http://schemas."
            "openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' "
            "Type='http://schemas.openxmlformats.org/officeDocument/2006/"
            "relationships/officeDocument' Target='word/document.xml'/></Relationships>",
        )
        archive.writestr(
            "word/document.xml",
            "<?xml version='1.0'?><w:document xmlns:w='http://schemas."
            "openxmlformats.org/wordprocessingml/2006/main'><w:body><w:p><w:r><w:t>"
            f"{text}</w:t></w:r></w:p></w:body></w:document>",
        )
    return buffer.getvalue()


def _text_of(result) -> str:
    return "\n".join(p.text for p in result.parts if isinstance(p, TextBlock))


def test_pdf_is_converted_to_text(tmp_path: Path):
    pdf = tmp_path / "report.pdf"
    pdf.write_bytes(_minimal_pdf())

    result = handle_document(pdf, "report.pdf")

    assert "Hello Anydoc World" in _text_of(result)
    # Text extraction succeeded, so the raw bytes must not also be sent.
    assert not any(isinstance(p, ImageDataBlock) for p in result.parts)


def test_docx_is_converted_to_text(tmp_path: Path):
    docx = tmp_path / "notes.docx"
    docx.write_bytes(_minimal_docx())

    result = handle_document(docx, "notes.docx")

    assert "Hello from DOCX" in _text_of(result)


def test_pdf_without_extractable_text_falls_back_to_vision(tmp_path: Path):
    """A scanned/image-only PDF has no text layer; anydoc reports it as
    unsupported and the raw bytes go to a vision model instead."""
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(_minimal_pdf())

    import anydoc

    with patch(
        "anydoc.to_markdown_bytes",
        side_effect=anydoc.UnsupportedError("image-only PDF"),
    ):
        result = handle_document(pdf, "scan.pdf")

    images = [p for p in result.parts if isinstance(p, ImageDataBlock)]
    assert len(images) == 1
    assert images[0].media_type == "application/pdf"


def test_encrypted_document_says_it_is_password_protected(tmp_path: Path):
    """`Encrypted` is not a conversion bug — retrying or sending the bytes to a
    vision model cannot help, so the user needs to be told the actual reason."""
    docx = tmp_path / "payroll.docx"
    docx.write_bytes(_minimal_docx())

    import anydoc

    with patch(
        "anydoc.to_markdown_bytes",
        side_effect=anydoc.EncryptedError("password required"),
    ):
        result = handle_document(docx, "payroll.docx")

    text = _text_of(result).lower()
    assert "password" in text or "encrypted" in text
    assert not any(isinstance(p, ImageDataBlock) for p in result.parts)


def test_pdf_yielding_only_whitespace_falls_back_to_vision(tmp_path: Path):
    """A conversion that "succeeds" with no real text is still a failure."""
    pdf = tmp_path / "blank.pdf"
    pdf.write_bytes(_minimal_pdf())

    with patch("anydoc.to_markdown_bytes", return_value="   \n\t  "):
        result = handle_document(pdf, "blank.pdf")

    assert any(isinstance(p, ImageDataBlock) for p in result.parts)


def test_unconvertible_non_pdf_reports_failure(tmp_path: Path):
    docx = tmp_path / "broken.docx"
    docx.write_bytes(b"this is not a docx at all")

    result = handle_document(docx, "broken.docx")

    assert "Unable to extract text" in _text_of(result)
    assert not any(isinstance(p, ImageDataBlock) for p in result.parts)
