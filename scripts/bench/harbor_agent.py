"""Harbor adapter: runs OpenAgentd on benchmark tasks such as Terminal-Bench.

Harbor (https://harborframework.com) starts one container per task, calls
``install`` and ``configure`` in it, then ``run`` with the task's instruction.
See ``README.md`` beside this file for the commands.
"""

from __future__ import annotations

import asyncio
import re
import shlex
import tempfile
from pathlib import Path

import certifi
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .command import HAS_CA_COMMAND, run_command
from .release import latest_version, local_binary, release_binary
from .run_log import summarize

_ROOT = "/installed-agent/openagentd"
_BIN = f"{_ROOT}/bin/agentd"
_CONFIG = f"{_ROOT}/config"
_CA = f"{_ROOT}/ca-certificates.pem"
_MODEL = re.compile(r"^([a-z0-9_-]+)/([A-Za-z0-9._:-]+)$")
# Release binaries, kept between trials and jobs.
_CACHE = Path(tempfile.gettempdir()) / "openagentd-bench"
# Trials start several at a time; the first one downloads.
_DOWNLOAD = asyncio.Lock()


class OpenAgentd(BaseInstalledAgent):
    """Puts ``agentd`` (3.61.0 or later) in the task container and runs one
    turn with the task's instruction, unchanged.

    Agent kwargs (``--ak``):
      ``config_dir``  host folder holding the ``credentials.yaml`` to use (required)
      ``thinking``    thinking level passed to ``agentd run --thinking``
      ``version``     release to install (default: the latest)
      ``dist_dir``    use local builds instead of a release:
                      ``<dist_dir>/<target>/agentd``
    """

    def __init__(self, *args, config_dir: str | None = None, thinking: str | None = None, dist_dir: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        match = _MODEL.match(self.model_name or "")
        if not match:
            raise ValueError("pass the model as -m <provider>/<model>, for example -m codex/gpt-5.5")
        self._provider, self._model = match.groups()
        self._credentials = Path(config_dir or "").expanduser() / "credentials.yaml"
        if not config_dir or not self._credentials.is_file():
            raise FileNotFoundError("pass --ak config_dir=<folder holding credentials.yaml>; see scripts/bench/README.md")
        if thinking is not None and not re.fullmatch(r"[a-z]+", str(thinking)):
            raise ValueError(f"thinking level {thinking!r} is not a word")
        self._thinking = thinking
        self._dist_dir = Path(dist_dir).expanduser() if dist_dir else None

    @staticmethod
    def name() -> str:
        return "openagentd"

    def get_version_command(self) -> str | None:
        return f"{_BIN} --version"

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().removeprefix("agentd").strip().removeprefix("v")

    async def install(self, environment: BaseEnvironment) -> None:
        # The binary comes from the host: a task image needs no curl, and
        # some cannot install it.
        machine = (await self.exec_as_root(environment, command="uname -m")).stdout or ""
        async with _DOWNLOAD:
            binary = await asyncio.to_thread(self._binary, machine)
        await self.exec_as_root(environment, command=f"mkdir -p {_ROOT}/bin")
        await environment.upload_file(binary, _BIN)
        await self.exec_as_root(environment, command=f"chmod 755 {_BIN}")
        # A bare image (`ubuntu:24.04`) has no CA certificates, and agentd
        # reads the system's. The bundle goes beside the binary, not into
        # the system, so the task's own tests see the image as it was.
        if "yes" not in ((await self.exec_as_root(environment, command=HAS_CA_COMMAND)).stdout or ""):
            await environment.upload_file(Path(certifi.where()), _CA)
            await self.exec_as_root(environment, command=f"chmod 644 {_CA}")

    def _binary(self, machine: str) -> Path:
        if self._dist_dir:
            return local_binary(self._dist_dir, machine)
        if not self._version:
            self._version = latest_version()
        return release_binary(self._version, machine, _CACHE)

    async def configure(self, environment: BaseEnvironment) -> None:
        # A session title is one more model call per task.
        settings = "title_generation:\n  enabled: false\n"
        await self.exec_as_root(environment, command=f"mkdir -p {_CONFIG}")
        await self._upload_config_text(environment, content=settings, remote_path=f"{_CONFIG}/settings.yaml", filename="settings.yaml")
        await environment.upload_file(self._credentials, f"{_CONFIG}/credentials.yaml")
        owner = f"chown -R {shlex.quote(str(environment.default_user))} {_CONFIG} && " if environment.default_user is not None else ""
        await self.exec_as_root(environment, command=f"{owner}chmod 700 {_CONFIG} && chmod 600 {_CONFIG}/credentials.yaml")

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        await self.exec_as_agent(
            environment,
            command=run_command(
                binary=_BIN,
                model=f"{self._provider}:{self._model}",
                thinking=self._thinking,
                instruction=instruction,
                logs=self.environment_logs_dir.as_posix(),
                ca_file=_CA,
            ),
            env={"OPENAGENTD_CONFIG_DIR": _CONFIG},
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        log = self.logs_dir / "openagentd.jsonl"
        if not log.is_file():
            return
        totals = summarize(log)
        context.n_input_tokens = totals["input_tokens"]
        context.n_cache_tokens = totals["cached_tokens"]
        context.n_output_tokens = totals["output_tokens"]
        context.cost_usd = totals["cost_usd"]
        context.metadata = {"model_calls": totals["model_calls"], "error": totals["error"]}
