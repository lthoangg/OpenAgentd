# Harness benchmark

Runs OpenAgentd on [Terminal-Bench 2.0](https://www.tbench.ai) with
[Harbor](https://harborframework.com), the benchmark's runner. Harbor starts
one container per task, installs a released `agentd` in it, runs one
unattended turn with the task's instruction, then runs the task's own tests.

- `harbor_agent.py`: the Harbor adapter (install, credentials, run).
- `run_log.py`: totals the tokens and estimated cost of a run from its
  `agentd run --json` log.

Everything a run writes goes under the git-ignored `.openagentd/bench/`.

## Prerequisites

- Docker, running. Most tasks need 1 CPU and 2 GB of memory; 16 need 4 GB and
  2 need 8 GB.
- Harbor: `uv tool install harbor` (written against 0.26.0).

## Sign in once

The adapter copies one `credentials.yaml` into each task container, so give
the benchmark its own: a folder that holds only the sign-in or key the run
needs, never the one your installed app uses. From the repository root:

```bash
export OPENAGENTD_CONFIG_DIR="$PWD/.openagentd/bench/config" OPENAGENTD_DATA_DIR="$PWD/.openagentd/bench/data" OPENAGENTD_STATE_DIR="$PWD/.openagentd/bench/state" OPENAGENTD_CACHE_DIR="$PWD/.openagentd/bench/cache"
agentd auth codex                        # a subscription sign-in, or:
agentd credentials import path/to/.env   # API keys
```

Task containers run code from the benchmark next to that file. Use a
credential you can revoke, and keep `.openagentd/bench/` out of anything you
share.

## Run

From the repository root, with the provider and model as `-m <provider>/<model>`:

```bash
# one task
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 \
  --include-task-name terminal-bench/fix-git \
  -a scripts.bench.harbor_agent:OpenAgentd -m codex/gpt-5.5 \
  --ak config_dir="$PWD/.openagentd/bench/config" \
  -o .openagentd/bench/jobs -n 1 -y

# the whole benchmark, 5 attempts per task
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 -k 5 \
  -a scripts.bench.harbor_agent:OpenAgentd -m codex/gpt-5.5 \
  --ak config_dir="$PWD/.openagentd/bench/config" \
  -o .openagentd/bench/jobs -n 1 -y
```

Other agent options: `--ak version=3.60.0` pins the release to install, and
`--ak thinking=high` sets the thinking level. `-n` is how many tasks run at
once.

`harbor view .openagentd/bench/jobs` opens the results. Each trial folder
holds `result.json` (reward, tokens, timing) and `agent/openagentd.jsonl`
(every event of the run).

## What a published number must state

The OpenAgentd version, the model and thinking level, the date, the dataset
version, attempts per task, and the machine. Report every attempt of the
chosen configuration. Cost is an estimate at the provider's list prices; a
subscription sign-in is not billed per token.

## Known limits

- The task images are x86_64. On Apple Silicon, Docker runs them under
  emulation, so the agent and the tasks' own commands are slower than on an
  x86_64 host while the task time limits stay the same.
- The released Linux binary needs glibc 2.35. Two tasks (`qemu-alpine-ssh`,
  `qemu-startup`) use Debian 11 (glibc 2.31), where it does not start.
- The adapter prepends a short note to each instruction telling the agent not
  to ask questions: `agentd run` ends the turn with an error when it does.
- The agent runs with its default tools, which include web search and fetch.
