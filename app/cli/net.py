"""Network helpers for CLI server address display, resolution, and probes."""

from __future__ import annotations

import socket
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Any

from app.core.server_settings import load_server_settings

_DEFAULT_PORT = 4082


@dataclass(frozen=True)
class ServerAddresses:
    local: str
    lan: list[str]


_NON_LOOPBACK_AUTH_ERROR = (
    "Refusing to bind a non-loopback host without authentication; "
    "configure --key or an access key."
)


def is_loopback_host(host: str) -> bool:
    """Return whether a bind host is limited to this machine."""
    if host.lower() == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def require_loopback_or_auth(*, host: str, has_auth: bool) -> None:
    """Reject unauthenticated network-visible server binds."""
    if not has_auth and not is_loopback_host(host):
        raise SystemExit(_NON_LOOPBACK_AUTH_ERROR)


def display_host(host: str) -> str:
    """Map wildcard bind addresses (0.0.0.0, ::) to loopback for client URLs."""
    return "127.0.0.1" if host in {"0.0.0.0", "::"} else host


def resolve_port(port: int | None = None, configured_port: int | None = None) -> int:
    """Resolve the API port from explicit flag or persisted server settings."""
    if port is not None:
        return port
    if configured_port:
        return configured_port
    return load_server_settings().port or _DEFAULT_PORT


def resolve_host(args: Any, configured_host: str | None = None) -> str:
    """Resolve the bind host from explicit flags or persisted server settings."""
    if getattr(args, "host", None):
        return str(args.host)
    if configured_host is not None:
        return configured_host
    return load_server_settings().host


def _format_url(host: str, port: int) -> str:
    return f"http://{display_host(host)}:{port}"


def _lan_ips() -> list[str]:
    ips: list[str] = []

    def add_ip(ip: str) -> None:
        if not ip.startswith("127.") and ip not in ips:
            ips.append(ip)

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            add_ip(sock.getsockname()[0])
    except OSError:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            add_ip(str(info[4][0]))
    except OSError:
        pass

    return ips


def server_addresses(*, host: str, port: int) -> ServerAddresses:
    lan = [f"http://{ip}:{port}" for ip in _lan_ips()]
    return ServerAddresses(local=_format_url(host, port), lan=lan)


def is_port_reachable(*, host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False
