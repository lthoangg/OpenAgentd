from __future__ import annotations

import re
import unicodedata


def slugify(text: str) -> str:
    """Generate a URL-friendly slug from a text string.

    Aligned byte-for-byte with the frontend's slugify logic.
    """
    # normalize('NFD') and remove diacritics
    text = "".join(
        c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn"
    )
    # convert to lower
    slug = text.lower()
    # replace spaces & symbols with dashes
    slug = re.sub(r"[^a-z0-9._-]", "-", slug)
    # collapse multiple dashes
    slug = re.sub(r"-+", "-", slug)
    # trim leading/trailing dots, underscores, and dashes
    slug = re.sub(r"^[._-]+|[._-]+$", "", slug)
    # if it doesn't start with a-z0-9, trim that prefix
    if slug and not re.match(r"^[a-z0-9]", slug):
        slug = re.sub(r"^[^a-z0-9]+", "", slug)
    return slug[:64]
