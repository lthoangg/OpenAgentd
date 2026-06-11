"""Tests for app/api/routes/mcp.py — MCP server CRUD endpoints."""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agent.mcp.config import HttpServerConfig, MCPConfig, StdioServerConfig
from app.agent.mcp.manager import MCPServerStatus
from app.api.routes.mcp import router
from app.core.db import get_session


def _make_app() -> FastAPI:
    """Create a test FastAPI app with the MCP router."""
    app = FastAPI()
    app.include_router(router, prefix="/api/mcp")
    return app


def _make_app_with_mcp_app(row: object | None) -> FastAPI:
    app = _make_app()

    class _Result:
        def first(self) -> object | None:
            return row

    class _Session:
        async def exec(self, _stmt):  # noqa: ANN001
            return _Result()

    async def fake_session():
        yield _Session()

    app.dependency_overrides[get_session] = fake_session
    return app


def _mcp_app_row(
    session_id: str, tool_call_id: str, server: str = "excalidraw"
) -> SimpleNamespace:
    return SimpleNamespace(
        session_id=session_id,
        role="tool",
        tool_call_id=tool_call_id,
        extra={"mcp_app": {"server": server, "tool": "create_view"}},
    )


class TestListServers:
    """Test GET /api/mcp/servers."""

    def test_list_servers_empty(self) -> None:
        """GET /api/mcp/servers returns 200 with empty list."""
        app = _make_app()
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            mock_manager.list_status.return_value = []
            client = TestClient(app)
            response = client.get("/api/mcp/servers")
            assert response.status_code == 200
            assert response.json() == {"servers": []}

    def test_list_servers_populated(self) -> None:
        """GET /api/mcp/servers returns list of servers."""
        app = _make_app()
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            status1 = MCPServerStatus(
                name="filesystem",
                transport="stdio",
                enabled=True,
                state="ready",
                tool_names=["mcp_filesystem_list"],
            )
            status2 = MCPServerStatus(
                name="github",
                transport="http",
                enabled=False,
                state="stopped",
            )
            mock_manager.list_status.return_value = [status1, status2]
            client = TestClient(app)
            response = client.get("/api/mcp/servers")
            assert response.status_code == 200
            data = response.json()
            assert len(data["servers"]) == 2
            assert data["servers"][0]["name"] == "filesystem"
            assert data["servers"][1]["name"] == "github"


class TestGetServer:
    """Test GET /api/mcp/servers/{name}."""

    def test_get_server_found(self) -> None:
        """GET /api/mcp/servers/{name} returns 200 with status."""
        app = _make_app()
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            status = MCPServerStatus(
                name="filesystem",
                transport="stdio",
                enabled=True,
                state="ready",
                tool_names=["mcp_filesystem_list"],
            )
            mock_manager.get_status.return_value = status
            client = TestClient(app)
            response = client.get("/api/mcp/servers/filesystem")
            assert response.status_code == 200
            data = response.json()
            assert data["name"] == "filesystem"
            assert data["state"] == "ready"

    def test_get_server_not_found(self) -> None:
        """GET /api/mcp/servers/{name} returns 404 when missing."""
        app = _make_app()
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            mock_manager.get_status.return_value = None
            client = TestClient(app)
            response = client.get("/api/mcp/servers/missing")
            assert response.status_code == 404


class TestMCPAppToolCall:
    """Test POST /api/mcp/app-tools/call."""

    def test_bound_artifact_tool_calls_live_server(self) -> None:
        session_id = str(uuid4())
        app = _make_app_with_mcp_app(_mcp_app_row(session_id, "tc1"))
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            mock_manager.call_app_tool = AsyncMock(
                return_value=SimpleNamespace(
                    model_dump=lambda **_kwargs: {
                        "content": [{"type": "text", "text": "saved"}],
                        "structuredContent": {"checkpointId": "cp1"},
                    }
                )
            )
            client = TestClient(app)

            response = client.post(
                "/api/mcp/app-tools/call",
                json={
                    "session_id": session_id,
                    "tool_call_id": "tc1",
                    "server": "excalidraw",
                    "tool": "custom_chart_tool",
                    "arguments": {"chartId": "chart1"},
                },
            )

            assert response.status_code == 200
            assert response.json()["result"]["structuredContent"] == {
                "checkpointId": "cp1"
            }
            mock_manager.call_app_tool.assert_awaited_once_with(
                "excalidraw", "custom_chart_tool", {"chartId": "chart1"}
            )

    def test_rejects_tools_not_advertised_by_server(self) -> None:
        session_id = str(uuid4())
        app = _make_app_with_mcp_app(_mcp_app_row(session_id, "tc1"))
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            mock_manager.call_app_tool = AsyncMock(
                side_effect=ValueError("MCP tool 'missing_tool' is not available.")
            )
            client = TestClient(app)

            response = client.post(
                "/api/mcp/app-tools/call",
                json={
                    "session_id": session_id,
                    "tool_call_id": "tc1",
                    "server": "excalidraw",
                    "tool": "missing_tool",
                    "arguments": {},
                },
            )

        assert response.status_code == 403
        assert "not available" in response.json()["detail"]

    def test_rejects_server_mismatch_against_bound_artifact(self) -> None:
        session_id = str(uuid4())
        app = _make_app_with_mcp_app(
            _mcp_app_row(session_id, "tc1", server="excalidraw")
        )
        client = TestClient(app)

        response = client.post(
            "/api/mcp/app-tools/call",
            json={
                "session_id": session_id,
                "tool_call_id": "tc1",
                "server": "other",
                "tool": "save_checkpoint",
                "arguments": {},
            },
        )

        assert response.status_code == 403

    def test_rejects_missing_artifact_binding(self) -> None:
        app = _make_app_with_mcp_app(None)
        client = TestClient(app)

        response = client.post(
            "/api/mcp/app-tools/call",
            json={
                "session_id": str(uuid4()),
                "tool_call_id": "missing",
                "server": "excalidraw",
                "tool": "save_checkpoint",
                "arguments": {},
            },
        )

        assert response.status_code == 404

    def test_rejects_non_object_arguments(self) -> None:
        app = _make_app_with_mcp_app(_mcp_app_row(str(uuid4()), "tc1"))
        client = TestClient(app)

        response = client.post(
            "/api/mcp/app-tools/call",
            json={
                "session_id": str(uuid4()),
                "tool_call_id": "tc1",
                "server": "excalidraw",
                "tool": "save_checkpoint",
                "arguments": ["not", "object"],
            },
        )

        assert response.status_code == 422

    def test_sanitizes_unexpected_mcp_failure(self) -> None:
        session_id = str(uuid4())
        app = _make_app_with_mcp_app(_mcp_app_row(session_id, "tc1"))
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            mock_manager.call_app_tool = AsyncMock(side_effect=Exception("secret"))
            client = TestClient(app)

            response = client.post(
                "/api/mcp/app-tools/call",
                json={
                    "session_id": session_id,
                    "tool_call_id": "tc1",
                    "server": "excalidraw",
                    "tool": "save_checkpoint",
                    "arguments": {},
                },
            )

        assert response.status_code == 502
        assert response.json()["detail"] == "MCP app tool call failed."


class TestCreateServer:
    """Test POST /api/mcp/servers."""

    def test_create_server_stdio_success(self, tmp_path: Path) -> None:
        """POST /api/mcp/servers creates stdio server, returns 201."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config") as mock_save,
        ):
            mock_load.return_value = MCPConfig()
            status = MCPServerStatus(
                name="filesystem",
                transport="stdio",
                enabled=True,
                state="ready",
            )
            mock_manager.restart_server = AsyncMock(return_value=status)

            client = TestClient(app)
            response = client.post(
                "/api/mcp/servers",
                json={
                    "name": "filesystem",
                    "server": {
                        "transport": "stdio",
                        "command": "npx",
                        "args": [
                            "-y",
                            "@modelcontextprotocol/server-filesystem",
                            "/tmp",
                        ],
                    },
                },
            )
            assert response.status_code == 201
            data = response.json()
            assert data["name"] == "filesystem"
            assert data["state"] == "ready"
            mock_save.assert_called_once()

    def test_create_server_http_success(self) -> None:
        """POST /api/mcp/servers creates http server, returns 201."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config"),
        ):
            mock_load.return_value = MCPConfig()
            status = MCPServerStatus(
                name="github",
                transport="http",
                enabled=True,
                state="ready",
            )
            mock_manager.restart_server = AsyncMock(return_value=status)

            client = TestClient(app)
            response = client.post(
                "/api/mcp/servers",
                json={
                    "name": "github",
                    "server": {
                        "transport": "http",
                        "url": "https://mcp.example.com/v1",
                        "headers": {"Authorization": "Bearer token"},
                    },
                },
            )
            assert response.status_code == 201
            data = response.json()
            assert data["name"] == "github"

    def test_create_server_stores_oauth_values_in_env_file(
        self, tmp_path: Path
    ) -> None:
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config") as mock_save,
            patch("app.api.routes.mcp.settings.OPENAGENTD_CONFIG_DIR", str(tmp_path)),
            patch.dict(os.environ, {}, clear=True),
        ):
            mock_load.return_value = MCPConfig()
            mock_manager.restart_server = AsyncMock(
                return_value=MCPServerStatus(
                    name="slack", transport="http", enabled=True, state="auth_required"
                )
            )

            client = TestClient(app)
            response = client.post(
                "/api/mcp/servers",
                json={
                    "name": "slack",
                    "server": {
                        "transport": "http",
                        "url": "https://mcp.slack.com/mcp",
                        "headers": {},
                        "oauth": {
                            "client_id": "3660753192626.8903469228982",
                            "client_secret": "secret-value",
                        },
                    },
                },
            )

            assert response.status_code == 201
            env_text = (tmp_path / ".env").read_text(encoding="utf-8")
            assert 'SLACK_MCP_CLIENT_ID="3660753192626.8903469228982"' in env_text
            assert 'SLACK_MCP_CLIENT_SECRET="secret-value"' in env_text
            assert os.environ["SLACK_MCP_CLIENT_ID"] == "3660753192626.8903469228982"
            assert os.environ["SLACK_MCP_CLIENT_SECRET"] == "secret-value"
            saved = mock_save.call_args.args[0]
            saved_slack = saved.servers["slack"]
            assert isinstance(saved_slack, HttpServerConfig)
            assert saved_slack.oauth is not None
            assert saved_slack.oauth.client_id == "${SLACK_MCP_CLIENT_ID}"
            assert saved_slack.oauth.client_secret == "${SLACK_MCP_CLIENT_SECRET}"

    def test_create_server_duplicate_name_returns_409(self) -> None:
        """POST /api/mcp/servers with duplicate name returns 409."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager"),
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config"),
        ):
            existing_cfg = MCPConfig(
                servers={"filesystem": StdioServerConfig(command="echo")}
            )
            mock_load.return_value = existing_cfg

            client = TestClient(app)
            response = client.post(
                "/api/mcp/servers",
                json={
                    "name": "filesystem",
                    "server": {
                        "transport": "stdio",
                        "command": "npx",
                    },
                },
            )
            assert response.status_code == 409

    def test_create_server_invalid_name_returns_422(self) -> None:
        """POST /api/mcp/servers with invalid name returns 422."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager"),
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config"),
        ):
            mock_load.return_value = MCPConfig()

            client = TestClient(app)
            response = client.post(
                "/api/mcp/servers",
                json={
                    "name": "bad name",  # Invalid: contains space
                    "server": {
                        "transport": "stdio",
                        "command": "echo",
                    },
                },
            )
            assert response.status_code == 422

    def test_create_server_does_not_reload_team(self) -> None:
        """POST /api/mcp/servers must NOT trigger team_manager.reload().

        Mid-turn reloads tear down in-flight tool execution and rotate
        session IDs.  Agents instead pick up new MCP tools at the start
        of their next turn via the config-stamp drift check.
        """
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config"),
            # If the route accidentally re-introduces a team_manager
            # import, this patch will succeed AND the AsyncMock below
            # will record any reload() calls.  Sentinel-style assertion.
            patch("app.services.team_manager.reload") as mock_reload,
        ):
            mock_load.return_value = MCPConfig()
            status = MCPServerStatus(
                name="test",
                transport="stdio",
                enabled=True,
                state="ready",
            )
            mock_manager.restart_server = AsyncMock(return_value=status)
            mock_reload.return_value = AsyncMock()

            client = TestClient(app)
            response = client.post(
                "/api/mcp/servers",
                json={
                    "name": "test",
                    "server": {
                        "transport": "stdio",
                        "command": "echo",
                    },
                },
            )
            assert response.status_code == 201
            mock_reload.assert_not_called()


class TestUpdateServer:
    """Test PUT /api/mcp/servers/{name}."""

    def test_update_server_success(self) -> None:
        """PUT /api/mcp/servers/{name} updates existing server."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config") as mock_save,
        ):
            existing_cfg = MCPConfig(
                servers={"test": StdioServerConfig(command="echo")}
            )
            mock_load.return_value = existing_cfg
            status = MCPServerStatus(
                name="test",
                transport="stdio",
                enabled=True,
                state="ready",
            )
            mock_manager.restart_server = AsyncMock(return_value=status)

            client = TestClient(app)
            response = client.put(
                "/api/mcp/servers/test",
                json={
                    "server": {
                        "transport": "stdio",
                        "command": "npx",
                        "args": ["new-arg"],
                    },
                },
            )
            assert response.status_code == 200
            data = response.json()
            assert data["name"] == "test"
            mock_save.assert_called_once()

    def test_update_server_not_found_returns_404(self) -> None:
        """PUT /api/mcp/servers/{name} returns 404 when missing."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager"),
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config"),
        ):
            mock_load.return_value = MCPConfig()

            client = TestClient(app)
            response = client.put(
                "/api/mcp/servers/missing",
                json={
                    "server": {
                        "transport": "stdio",
                        "command": "echo",
                    },
                },
            )
            assert response.status_code == 404

    def test_update_server_preserves_masked_http_header(self) -> None:
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config") as mock_save,
        ):
            existing_cfg = MCPConfig(
                servers={
                    "slack": HttpServerConfig(
                        url="https://mcp.slack.com/mcp",
                        headers={"Authorization": "Bearer ${SLACK_MCP_TOKEN}"},
                    )
                }
            )
            mock_load.return_value = existing_cfg
            mock_manager.restart_server = AsyncMock(
                return_value=MCPServerStatus(
                    name="slack", transport="http", enabled=True, state="ready"
                )
            )

            client = TestClient(app)
            response = client.put(
                "/api/mcp/servers/slack",
                json={
                    "server": {
                        "transport": "http",
                        "url": "https://mcp.slack.com/mcp",
                        "headers": {"Authorization": "********"},
                    }
                },
            )

            assert response.status_code == 200
            saved = mock_save.call_args.args[0]
            assert saved.servers["slack"].headers == {
                "Authorization": "Bearer ${SLACK_MCP_TOKEN}"
            }

    def test_update_server_overwrites_existing_oauth_env_values(
        self, tmp_path: Path
    ) -> None:
        app = _make_app()
        (tmp_path / ".env").write_text(
            'SLACK_MCP_CLIENT_ID="old-id"\n'
            'SLACK_MCP_CLIENT_SECRET="old-secret"\n'
            'OTHER_KEY="kept"\n',
            encoding="utf-8",
        )
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config") as mock_save,
            patch("app.api.routes.mcp.settings.OPENAGENTD_CONFIG_DIR", str(tmp_path)),
            patch.dict(
                os.environ,
                {
                    "SLACK_MCP_CLIENT_ID": "old-id",
                    "SLACK_MCP_CLIENT_SECRET": "old-secret",
                },
                clear=True,
            ),
        ):
            mock_load.return_value = MCPConfig(
                servers={
                    "slack": HttpServerConfig(
                        url="https://mcp.slack.com/mcp",
                        oauth={
                            "client_id": "${SLACK_MCP_CLIENT_ID}",
                            "client_secret": "${SLACK_MCP_CLIENT_SECRET}",
                        },
                    )
                }
            )
            mock_manager.restart_server = AsyncMock(
                return_value=MCPServerStatus(
                    name="slack", transport="http", enabled=True, state="auth_required"
                )
            )

            client = TestClient(app)
            response = client.put(
                "/api/mcp/servers/slack",
                json={
                    "server": {
                        "transport": "http",
                        "url": "https://mcp.slack.com/mcp",
                        "headers": {},
                        "oauth": {
                            "client_id": "new-id",
                            "client_secret": "new-secret",
                        },
                    }
                },
            )

            assert response.status_code == 200
            env_text = (tmp_path / ".env").read_text(encoding="utf-8")
            assert 'SLACK_MCP_CLIENT_ID="new-id"' in env_text
            assert 'SLACK_MCP_CLIENT_SECRET="new-secret"' in env_text
            assert 'OTHER_KEY="kept"' in env_text
            assert os.environ["SLACK_MCP_CLIENT_ID"] == "new-id"
            assert os.environ["SLACK_MCP_CLIENT_SECRET"] == "new-secret"
            saved = mock_save.call_args.args[0]
            saved_slack = saved.servers["slack"]
            assert isinstance(saved_slack, HttpServerConfig)
            assert saved_slack.oauth is not None
            assert saved_slack.oauth.client_id == "${SLACK_MCP_CLIENT_ID}"
            assert saved_slack.oauth.client_secret == "${SLACK_MCP_CLIENT_SECRET}"


class TestDeleteServer:
    """Test DELETE /api/mcp/servers/{name}."""

    def test_delete_server_success(self) -> None:
        """DELETE /api/mcp/servers/{name} removes server entry."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config") as mock_save,
        ):
            existing_cfg = MCPConfig(
                servers={"test": StdioServerConfig(command="echo")}
            )
            mock_load.return_value = existing_cfg
            mock_manager.remove_runner = AsyncMock()

            client = TestClient(app)
            response = client.delete("/api/mcp/servers/test")
            assert response.status_code == 200
            data = response.json()
            assert data == {"name": "test"}
            mock_save.assert_called_once()
            mock_manager.remove_runner.assert_called_once_with("test")

    def test_delete_server_not_found_returns_404(self) -> None:
        """DELETE /api/mcp/servers/{name} returns 404 when missing."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager"),
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.save_config"),
        ):
            mock_load.return_value = MCPConfig()

            client = TestClient(app)
            response = client.delete("/api/mcp/servers/missing")
            assert response.status_code == 404


class TestRestartServer:
    """Test POST /api/mcp/servers/{name}/restart."""

    def test_restart_server_success(self) -> None:
        """POST /api/mcp/servers/{name}/restart restarts server."""
        app = _make_app()
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            status = MCPServerStatus(
                name="test",
                transport="stdio",
                enabled=True,
                state="ready",
            )
            mock_manager.restart_server = AsyncMock(return_value=status)

            client = TestClient(app)
            response = client.post("/api/mcp/servers/test/restart")
            assert response.status_code == 200
            data = response.json()
            assert data["name"] == "test"
            mock_manager.restart_server.assert_called_once_with("test")

    def test_restart_server_not_found_returns_404(self) -> None:
        """POST /api/mcp/servers/{name}/restart returns 404 when missing."""
        app = _make_app()
        with patch("app.api.routes.mcp.mcp_manager") as mock_manager:
            mock_manager.restart_server = AsyncMock(side_effect=KeyError("test"))

            client = TestClient(app)
            response = client.post("/api/mcp/servers/missing/restart")
            assert response.status_code == 404


class TestConnectOAuth:
    def test_connect_oauth_restarts_with_interactive_oauth(self) -> None:
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.allow_interactive_oauth") as mock_allow,
            patch("app.api.routes.mcp.clear_cached_oauth") as mock_clear_oauth,
            patch("app.api.routes.mcp.disallow_interactive_oauth") as mock_disallow,
            patch("app.api.routes.mcp.save_config") as mock_save,
        ):
            cfg = MCPConfig(
                servers={
                    "notion": HttpServerConfig(
                        url="https://mcp.notion.com/mcp",
                        oauth={},
                    )
                }
            )
            mock_load.return_value = cfg
            mock_manager.restart_server = AsyncMock(
                return_value=MCPServerStatus(
                    name="notion", transport="http", enabled=True, state="ready"
                )
            )

            client = TestClient(app)
            response = client.post("/api/mcp/servers/notion/oauth/connect")

            assert response.status_code == 200
            mock_allow.assert_called_once_with("notion")
            mock_clear_oauth.assert_called_once_with("notion")
            mock_disallow.assert_called_once_with("notion")
            mock_manager.restart_server.assert_awaited_once_with(
                "notion", ready_timeout=300.0
            )
            mock_save.assert_called_once_with(cfg)

    def test_connect_oauth_rejects_non_oauth_server(self) -> None:
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager"),
            patch("app.api.routes.mcp.load_config") as mock_load,
        ):
            mock_load.return_value = MCPConfig(
                servers={"filesystem": StdioServerConfig(command="echo")}
            )

            client = TestClient(app)
            response = client.post("/api/mcp/servers/filesystem/oauth/connect")

            assert response.status_code == 400

    def test_connect_oauth_returns_conflict_when_auth_still_required(self) -> None:
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.api.routes.mcp.allow_interactive_oauth"),
            patch("app.api.routes.mcp.disallow_interactive_oauth"),
        ):
            cfg = MCPConfig(
                servers={
                    "slack": HttpServerConfig(
                        url="https://mcp.slack.com/mcp",
                        oauth={},
                    )
                }
            )
            mock_load.return_value = cfg
            mock_manager.restart_server = AsyncMock(
                return_value=MCPServerStatus(
                    name="slack",
                    transport="http",
                    enabled=True,
                    state="auth_required",
                    error="MCP server 'slack' requires OAuth app credentials.",
                )
            )

            client = TestClient(app)
            response = client.post("/api/mcp/servers/slack/oauth/connect")

            assert response.status_code == 409
            assert "requires OAuth app credentials" in response.json()["detail"]


class TestApply:
    """POST /api/mcp/apply — re-read mcp.json and reconcile every runner.

    The endpoint is the hook the mcp-installer skill's ``apply`` script
    calls after editing the config file directly. It must:
      1. Validate the file BEFORE tearing anything down (422 on bad file).
      2. Call ``mcp_manager.reload_from_config()`` to reconcile runners.
      3. Return the new server list with saved config payloads attached.

    Crucially it must NOT reload the team — agents pick up new MCP
    tools at the start of their next turn via the config-stamp drift
    check, so reloads don't tear down in-flight tool execution.
    """

    def test_apply_success_returns_server_list(self) -> None:
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
            patch("app.services.team_manager.reload") as mock_reload,
        ):
            cfg = MCPConfig(
                servers={"fs": StdioServerConfig(command="npx", args=["-y", "x"])}
            )
            mock_load.return_value = cfg
            mock_manager.reload_from_config = AsyncMock()
            mock_manager.list_status.return_value = [
                MCPServerStatus(
                    name="fs",
                    transport="stdio",
                    enabled=True,
                    state="ready",
                    tool_names=["mcp_fs_read"],
                )
            ]

            client = TestClient(app)
            response = client.post("/api/mcp/apply")

            assert response.status_code == 200
            data = response.json()
            assert [s["name"] for s in data["servers"]] == ["fs"]
            assert data["servers"][0]["state"] == "ready"
            # Saved config is projected into the response so the caller
            # doesn't need a follow-up GET to see what was applied.
            assert data["servers"][0]["config"]["transport"] == "stdio"
            assert data["servers"][0]["config"]["command"] == "npx"
            mock_manager.reload_from_config.assert_awaited_once()
            # Team must NOT be reloaded — drift detection picks up
            # tool changes on the next turn instead.
            mock_reload.assert_not_called()

    def test_apply_rejects_malformed_config_with_422(self) -> None:
        """A bad mcp.json must NOT trigger reload_from_config."""
        app = _make_app()
        with (
            patch("app.api.routes.mcp.mcp_manager") as mock_manager,
            patch("app.api.routes.mcp.load_config") as mock_load,
        ):
            mock_load.side_effect = ValueError("Invalid JSON in mcp.json")
            mock_manager.reload_from_config = AsyncMock()

            client = TestClient(app)
            response = client.post("/api/mcp/apply")

            assert response.status_code == 422
            assert "Invalid JSON" in response.json()["detail"]
            # Crucially: we must not have torn down healthy runners.
            mock_manager.reload_from_config.assert_not_awaited()
