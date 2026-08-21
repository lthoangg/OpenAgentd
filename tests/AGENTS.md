# Backend Test Guide

Pytest tests mirror `app/` with the redundant `app/` prefix removed, for
example `app/services/chat_service.py` ->
`tests/services/test_chat_service.py`.

## Environment and fixtures

- `pytest.ini` redirects data/config/state/cache into `.tests/`; xdist workers
  receive isolated suffixes.
- `tests/conftest.py` uses one temporary, file-backed SQLite database for the
  session and clears rows between tests. Do not create a second `:memory:`
  engine: separate connections would see an empty schema.
- Shared fixtures redirect `app.core.db`, restore `os.environ`, seed provider
  metadata without network access, and clear inherited desktop/access-key
  auth.
- Prefer real async session factories and FastAPI dependency overrides over
  mocked context managers or patched route internals.
- Patch sleeps/timeouts instead of waiting. CLI tests that reach `os.execvp`
  replace it with a terminating fake.

## Commands

```bash
uv run pytest tests/path/test_file.py -q
uv run pytest tests/path/test_file.py::test_name -q
uv run pytest -n 4 -q
make coverage
make verify-backend
```

The final backend target also runs Ruff and `ty`. Add focused regression tests
for changed behavior, then run the relevant subtree plus the full target.
Windows process/sidecar behavior also has a focused CI smoke subset in
`.github/workflows/core.yml`; keep those tests portable when changing shell or
process handling.
