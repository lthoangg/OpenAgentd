import asyncio
import json
import os
from pathlib import Path
from typing import Any, Mapping

from loguru import logger


class LspClient:
    def __init__(
        self,
        command: list[str],
        workspace_root: Path,
        init_options: dict | None = None,
        env: Mapping[str, str] | None = None,
    ):
        self.command = command
        self.workspace_root = workspace_root
        self._init_options = init_options
        self._env = dict(env) if env is not None else None
        self.process: asyncio.subprocess.Process | None = None
        self._id = 0
        self._pending_requests: dict[int, asyncio.Future] = {}
        # Latest diagnostics published per URI, plus an Event that fires on each
        # new publish so a consumer can debounce-and-settle rather than grabbing
        # the first (often empty) publish a server emits on didOpen.
        self._latest_diagnostics: dict[str, list[dict]] = {}
        self._diagnostics_events: dict[str, asyncio.Event] = {}
        # A diagnostic cycle resets per-URI state, so concurrent checks for the
        # same document must run one at a time. Different documents remain
        # fully concurrent.
        self._diagnostics_locks: dict[str, asyncio.Lock] = {}
        self._read_task: asyncio.Task | None = None
        self.last_used_at = 0.0
        # Track open document URIs -> last version sent, so re-checking a file
        # uses didChange (correct per LSP spec) instead of a second didOpen,
        # which some servers reject for an already-open document.
        self._open_docs: dict[str, int] = {}

    async def start(self):
        logger.info("Starting LSP server: {} in {}", self.command, self.workspace_root)
        self.process = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=str(self.workspace_root),
            env=self._env,
        )
        self._read_task = asyncio.create_task(self._read_loop())
        self.last_used_at = asyncio.get_running_loop().time()

        # Initialize the server
        try:
            await self._initialize()
        except Exception as e:
            logger.error("Failed to initialize LSP server {}: {}", self.command, e)
            await self.stop()
            raise

    async def _initialize(self):
        params: dict = {
            "processId": os.getpid(),
            "rootPath": str(self.workspace_root),
            "rootUri": self.workspace_root.as_uri(),
            # workspaceFolders lets servers (e.g. tsserver) handle monorepo
            # sub-projects: the server sees the correct project root rather than
            # treating every file as belonging to one flat workspace.
            "workspaceFolders": [
                {
                    "uri": self.workspace_root.as_uri(),
                    "name": self.workspace_root.name,
                }
            ],
            "capabilities": {
                "workspace": {
                    # Advertise support so servers that gate on capability
                    # actually send workspaceFolders-aware responses.
                    "workspaceFolders": True,
                },
                "textDocument": {
                    "publishDiagnostics": {
                        "relatedInformation": True,
                        "versionSupport": False,
                        "tagSupport": {"valueSet": [1, 2]},
                        "codeDescriptionSupport": True,
                        "dataSupport": True,
                    }
                },
            },
        }
        if self._init_options:
            params["initializationOptions"] = self._init_options
        await self.send_request("initialize", params)
        await self.send_message(
            {"jsonrpc": "2.0", "method": "initialized", "params": {}}
        )

    def reset_diagnostics(self, uri: str) -> asyncio.Event:
        """Prepare to collect diagnostics for *uri*.

        Clears any stale diagnostics and returns a fresh Event that fires on
        every subsequent ``publishDiagnostics`` for this URI. Call this BEFORE
        opening the document so no publish is missed.
        """
        self._latest_diagnostics.pop(uri, None)
        event = asyncio.Event()
        self._diagnostics_events[uri] = event
        return event

    def get_diagnostics(self, uri: str) -> list[dict]:
        """Return the most recent diagnostics seen for *uri* (empty if none)."""
        return self._latest_diagnostics.get(uri, [])

    def diagnostics_lock(self, uri: str) -> asyncio.Lock:
        """Return the lock protecting a complete diagnostics cycle for *uri*."""
        return self._diagnostics_locks.setdefault(uri, asyncio.Lock())

    async def open_or_update_document(
        self, uri: str, language_id: str, text: str
    ) -> None:
        """Open a document, or send didChange if it is already open.

        Per the LSP spec a server may reject a second ``didOpen`` for a
        document it already considers open.  We track open URIs and switch to
        ``didChange`` (with an incrementing version) on subsequent checks.
        """
        if uri in self._open_docs:
            version = self._open_docs[uri] + 1
            self._open_docs[uri] = version
            await self.send_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/didChange",
                    "params": {
                        "textDocument": {"uri": uri, "version": version},
                        "contentChanges": [{"text": text}],
                    },
                }
            )
        else:
            self._open_docs[uri] = 1
            await self.send_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/didOpen",
                    "params": {
                        "textDocument": {
                            "uri": uri,
                            "languageId": language_id,
                            "version": 1,
                            "text": text,
                        }
                    },
                }
            )

    async def close_document(self, uri: str) -> None:
        """Send textDocument/didClose for a tracked document (best-effort).

        We intentionally do NOT clear _latest_diagnostics or
        _diagnostics_events here.  reset_diagnostics() owns that lifecycle and
        is always called at the start of the next check cycle.  Clearing here
        races with servers that send a final publishDiagnostics on didClose
        (spec-compliant behaviour), which would silently overwrite state that
        the next check cycle has already claimed via reset_diagnostics.
        """
        if uri not in self._open_docs:
            return
        self._open_docs.pop(uri, None)
        await self.send_message(
            {
                "jsonrpc": "2.0",
                "method": "textDocument/didClose",
                "params": {"textDocument": {"uri": uri}},
            }
        )

    async def send_message(self, msg: dict):
        if not self.process or not self.process.stdin:
            raise RuntimeError("LSP server not running")
        body = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
        self.process.stdin.write(header + body)
        await self.process.stdin.drain()
        self.last_used_at = asyncio.get_running_loop().time()

    async def send_request(self, method: str, params: dict | None = None) -> Any:
        self._id += 1
        req_id = self._id
        msg: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
        }
        if params is not None:
            msg["params"] = params

        fut = asyncio.get_running_loop().create_future()
        self._pending_requests[req_id] = fut
        try:
            await self.send_message(msg)
            return await fut
        finally:
            self._pending_requests.pop(req_id, None)

    async def _read_loop(self):
        try:
            while self.process and self.process.returncode is None:
                stdout = self.process.stdout
                if stdout is None:
                    return
                # Read headers
                content_length = None
                while True:
                    line = await stdout.readline()
                    if not line:
                        # EOF
                        return
                    line_str = line.decode("utf-8", errors="replace").strip()
                    if not line_str:
                        # Empty line marks end of headers
                        break
                    if ":" in line_str:
                        key, val = line_str.split(":", 1)
                        if key.strip().lower() == "content-length":
                            content_length = int(val.strip())

                if content_length is None:
                    continue

                # Read body
                body = await stdout.readexactly(content_length)
                if not body:
                    return

                message = json.loads(body.decode("utf-8"))
                self._handle_message(message)
        except asyncio.IncompleteReadError:
            logger.debug("LspClient stdout EOF or incomplete read")
        except Exception as e:
            logger.error("Error in LspClient read loop: {}", e)
        finally:
            # Clean up futures if the loop exits
            for fut in list(self._pending_requests.values()):
                if not fut.done():
                    fut.set_exception(RuntimeError("LSP server stopped"))
            # Unblock any diagnostics waiters so they stop waiting.
            for event in list(self._diagnostics_events.values()):
                event.set()

    def _handle_message(self, message: dict):
        # Check if it's a response
        if "id" in message and "method" not in message:
            req_id = message["id"]
            fut = self._pending_requests.get(req_id)
            if fut and not fut.done():
                if "error" in message:
                    fut.set_exception(
                        RuntimeError(message["error"].get("message", "LSP error"))
                    )
                else:
                    fut.set_result(message.get("result"))
        # Check if it's a notification
        elif "method" in message:
            method = message["method"]
            params = message.get("params", {})
            if method == "textDocument/publishDiagnostics":
                uri = params.get("uri")
                diagnostics = params.get("diagnostics", [])
                if uri:
                    self._latest_diagnostics[uri] = diagnostics
                    event = self._diagnostics_events.get(uri)
                    if event is not None:
                        event.set()

    async def stop(self):
        read_task = self._read_task

        if self.process:
            # Try shutdown and exit gracefully
            try:
                if self.process.returncode is None:
                    await asyncio.wait_for(self.send_request("shutdown"), timeout=1.0)
                    await self.send_message(
                        {"jsonrpc": "2.0", "method": "exit", "params": {}}
                    )
            except Exception as exc:
                # Graceful shutdown is best-effort; terminate() below is the
                # real stop.
                logger.debug("lsp_graceful_shutdown_failed error={!r}", exc)

            # Terminate if still running
            try:
                if self.process.returncode is None:
                    self.process.terminate()
                    await self.process.wait()
            except (OSError, ProcessLookupError) as exc:
                logger.debug("lsp_terminate_failed error={!r}", exc)
            self.process = None

        if read_task:
            read_task.cancel()
            try:
                await read_task
            except asyncio.CancelledError:
                pass
            if self._read_task is read_task:
                self._read_task = None

        # Resolve any remaining request futures and unblock diagnostics waiters.
        for fut in list(self._pending_requests.values()):
            if not fut.done():
                fut.set_exception(RuntimeError("LSP server stopped"))
        for event in list(self._diagnostics_events.values()):
            event.set()
        self._diagnostics_locks.clear()
