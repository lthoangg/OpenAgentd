"""Core infrastructure — settings, database.

Re-exports are lazy (PEP 562): this package is imported by light CLI paths
(``app.core.version``, ``app.core.paths``) on every ``openagentd``
invocation, and an eager ``app.core.db`` import pulls the SQLAlchemy stack
(~195ms measured) before even ``--version`` can print.
"""

from __future__ import annotations

from typing import Any

_LAZY_EXPORTS: dict[str, str] = {
    "Settings": "app.core.config",
    "settings": "app.core.config",
    "async_session_factory": "app.core.db",
    "get_session": "app.core.db",
}

__all__ = list(_LAZY_EXPORTS)


def __getattr__(name: str) -> Any:
    """Resolve re-exports on first access (PEP 562 module ``__getattr__``)."""
    module_name = _LAZY_EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    value = getattr(import_module(module_name), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_LAZY_EXPORTS))
