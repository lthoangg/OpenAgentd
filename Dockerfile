# ── Stage 1: Build web UI ────────────────────────────────────────────────────
FROM oven/bun:1 AS web-builder

WORKDIR /build/web
COPY web/package.json web/bun.lock* ./
RUN bun install --frozen-lockfile

COPY web/ ./
RUN bun run build


# ── Stage 2: Python runtime ─────────────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS runtime

# System deps for SQLite, SSL, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -r openagentd && useradd -r -g openagentd -s /sbin/nologin openagentd

WORKDIR /app

# Copy everything hatchling needs to build the wheel:
# pyproject.toml, README.md, and the full app/ package (alembic.ini is
# force-included and must exist before `uv sync --no-editable` runs).
COPY pyproject.toml uv.lock* README.md ./
COPY app/ app/

# Copy pre-built web UI into the package (must exist before wheel is built
# so hatchling picks up the artifacts = ["app/_web_dist/**"] entry).
COPY --from=web-builder /build/web/dist/ app/_web_dist/

# Install Python dependencies. ``--no-editable`` builds the wheel in-place
# and installs it + all deps into ``/app/.venv``.
RUN uv sync --no-dev --no-editable

# Put the venv on PATH so ``uvicorn`` resolves directly without a ``uv run``
# wrapper (avoids one extra process layer at PID 1).
ENV PATH="/app/.venv/bin:${PATH}"

# Note: ``APP_ENV`` defaults to ``production`` in app/core/config.py, which
# enables Alembic auto-migrate on startup via the FastAPI lifespan
# (app/api/app.py::lifespan). docker-compose pins it explicitly via
# ``environment:`` to override any ``.env`` mount.

# Data directory — writable by app user. Override the XDG roots so
# everything (DB, config, state, cache, workspace, memory) lives under
# the single mountable volume at /data.
ENV OPENAGENTD_DATA_DIR=/data \
    OPENAGENTD_CONFIG_DIR=/data/config \
    OPENAGENTD_STATE_DIR=/data/state \
    OPENAGENTD_CACHE_DIR=/data/cache \
    OPENAGENTD_WORKSPACE_DIR=/data/workspace \
    OPENAGENTD_WIKI_DIR=/data/wiki
RUN mkdir -p /data && chown openagentd:openagentd /data

EXPOSE 4082

# Drop privileges
USER openagentd

# Health check — fails non-zero if the liveness endpoint is unreachable
# or returns a non-2xx response.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://localhost:4082/api/health/live', timeout=3).status < 400 else 1)"

# Run uvicorn as PID 1 directly. The ``openagentd`` CLI is a process
# manager (PID files, log redirection, detach) intended for a user's
# laptop — in a container we want PID 1 to be the actual server so
# stdout/stderr stream to ``docker logs`` and SIGTERM stops the process
# cleanly.
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "4082"]
