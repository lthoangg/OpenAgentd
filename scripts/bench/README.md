# Harness benchmark

Runs OpenAgentd on [Terminal-Bench 2.1](https://www.tbench.ai/news/terminal-bench-2-1)
with [Harbor](https://harborframework.com), the benchmark's runner. Harbor
starts one container per task. The adapter puts a released `agentd` (3.61.0
or later) in it and runs one turn with the task's instruction, unchanged;
Harbor then runs the task's own tests.

2.1 is the revision of 2.0 that fixes 28 of its 89 tasks; use it, not
`terminal-bench-2`. The current leaderboard is Terminal-Bench 4.1
(`terminal-bench/terminal-bench@4.1.0`), which this setup cannot run yet: see
Known limits.

- `harbor_agent.py`: the Harbor adapter (install, credentials, run).
- `release.py`: gets the Linux binary for a container: a release archive
  downloaded once on the host and checked against its `.sha256`, or a local
  build. The adapter uploads it, so a task image needs no `curl`.
- `command.py`: the `agentd run` line a container runs.
- `run_log.py`: totals the tokens and estimated cost of a run from its
  `agentd run --json` log.

Everything a run writes goes under the git-ignored `.openagentd/bench/`.

## Prerequisites

- Docker, running. Most tasks need 1 CPU and 2 GB of memory; 13 need 4 GB and
  8 need 8 GB, and 6 need 2 or 4 CPUs.
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
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2-1 \
  --include-task-name terminal-bench/fix-git \
  -a scripts.bench.harbor_agent:OpenAgentd -m codex/gpt-5.5 \
  --ak config_dir="$PWD/.openagentd/bench/config" \
  -o .openagentd/bench/jobs -n 1 -y

# the whole benchmark, 5 attempts per task
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2-1 -k 5 \
  -a scripts.bench.harbor_agent:OpenAgentd -m codex/gpt-5.5 \
  --ak config_dir="$PWD/.openagentd/bench/config" \
  -o .openagentd/bench/jobs -n 1 -y
```

Other agent options: `--ak version=3.61.0` pins the release to install, and
`--ak thinking=high` sets the thinking level. `--ak dist_dir=<folder>` runs
local builds instead of a release: `<folder>/<target>/agentd` for
`x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu`, built as
`.github/workflows/release.yml` builds them. `-n` is how many tasks run at
once, and `-x terminal-bench/<task>` leaves a task out.

Harbor runs attempt 1 of every task before attempt 2. A trial where `agentd`
exits with an error is recorded as `NonZeroAgentExitCodeError`;
`harbor job resume -p <job folder> -f NonZeroAgentExitCodeError` runs those
trials again.

When a usage limit runs out and resets more than 15 minutes later, `agentd
run` ends with an error that names the wait (in `agent/openagentd.stderr`),
so every trial from then on fails within seconds as
`NonZeroAgentExitCodeError`. Those trials are not results. Stop the run
(`pkill -TERM -f "bin/harbor"`), and after the reset run the resume command
above with `-f CancelledError` added; it also reruns trials that failed for
another reason, such as a provider's refusal.

Leave the machine idle while a job runs. Tasks and their tests have fixed
time limits, and a build on the host made one task's tests time out
(`VerifierTimeoutError`). Delete the folder of a trial that such load
affected, resume the job, and say so with the result.

`harbor view .openagentd/bench/jobs` opens the results. Each trial folder
holds `result.json` (reward, tokens, timing) and `agent/openagentd.jsonl`
(every event of the run).

## What a published number must state

The OpenAgentd version, the model and thinking level, the date, the dataset
version, attempts per task, the machine, and every task left out with the
reason. Report every attempt of the chosen configuration. Cost is an estimate
at the provider's list prices; a subscription sign-in is not billed per token.

## Known limits

- Most task images are x86_64. On Apple Silicon, Docker runs them under
  emulation, so the agent and the tasks' own commands are slower than on an
  x86_64 host while the task time limits stay the same. A few tasks build
  their image for the host instead and run as arm64.
- The agent runs with its default tools, which include web search and fetch.
- Some task images (`ubuntu:24.04`) have no CA certificates, and `agentd`
  needs the system's to reach a provider. The adapter uploads Mozilla's
  bundle (from `certifi`) beside the binary in such a container and points
  `agentd` at it with `SSL_CERT_FILE`. Commands the agent runs inherit that
  variable; the task's tests do not.
- A provider may refuse a security task outright (on 2.0 and 2.1:
  `break-filter-js-from-html`, `vulnerable-secret`), answering that the
  request was flagged. The trial ends with a provider error on the first
  request. Leave such tasks out of further attempts and list them.
- Terminal-Bench 4.1 (66 tasks) needs more than this setup has: 3 tasks need
  an H100 GPU, tasks ask for up to 16 CPUs, 32 GB of memory and an 8-hour
  limit, and 14 tasks declare MCP servers and 1 a skills folder that the
  adapter does not pass to `agentd`. Leaderboard entries used 1 to 19 billion
  tokens per run.
