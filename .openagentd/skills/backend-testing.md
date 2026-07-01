# Backend Testing Skill

Patterns, fixtures, and conventions for the OpenAgentd Python/FastAPI test suite.
Load this skill whenever writing, reviewing, or fixing backend tests.

---

## Stack

| Tool | Role |
|---|---|
| `pytest` + `pytest-asyncio` (`asyncio_mode = auto`) | Test runner — all async tests run automatically, no `@pytest.mark.asyncio` needed |
| `pytest-randomly` | Randomised order — tests must be order-independent |
| `pytest-xdist` | Parallel workers — no shared mutable module state between tests |
| `respx` | HTTP mock for `httpx`-based provider calls |
| `unittest.mock` (`MagicMock`, `AsyncMock`, `patch`) | In-process mocking |
| `uv run pytest --no-cov -q` | Fast local run (skip coverage) |

---

## Project layout

Tests mirror `app/` with the `app/` prefix dropped:

```
app/services/chat_service.py  →  tests/services/test_chat_service.py
app/agent/hooks/lsp.py        →  tests/agent/hooks/test_lsp.py
app/api/routes/settings.py    →  tests/api/test_settings_routes.py
```

---

## Global fixtures (`tests/conftest.py`)

Always active — do not re-declare.

### `setup_db` (session-scoped, autouse)
Redirects `app.core.db.engine` + `async_session_factory` to a file-backed SQLite test DB. Schema is created once per session. Use `async_session_factory` from `app.core.db` in production code — it points at the test DB automatically.

### `clean_db` (function-scoped, autouse)
`DELETE` from every table between tests. Keeps the schema; clears all rows. No manual teardown needed.

### `_restore_os_environ` (autouse)
Snapshots `os.environ` before every test and restores it after. Any test that mutates env vars (e.g. provider key injection) is automatically cleaned up.

### `_disable_desktop_token_auth` (autouse)
Removes `OPENAGENTD_DESKTOP_TOKEN` so API tests aren't gated by a desktop launcher token.

---

## XDG isolation

`pytest.ini` pins the four dirs to `.tests/{data,config,state,cache}`.
For tests that need a fully isolated filesystem, use:

```python
from tests.conftest import set_openagentd_dirs

def test_something(tmp_path, monkeypatch):
    set_openagentd_dirs(monkeypatch, tmp_path)
    ...
```

---

## Database patterns

### Inline engine (isolated, no global DB)
Use when the test needs its own schema with no interference:

```python
@pytest_asyncio.fixture
async def engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    yield engine
    await engine.dispose()

@pytest_asyncio.fixture
async def session(engine):
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        yield s
```

### Global test DB (shared session)
The global `setup_db` + `clean_db` fixtures handle this — just inject `AsyncSession` from `app.core.db.async_session_factory()` in production code and it lands in the test DB automatically.

### Never use `:memory:` with multiple connections
`:memory:` is per-connection — a second `async_sessionmaker` open sees an empty DB. Use a file-backed path (`tmp_path / "test.sqlite"`) when the engine outlives a single connection.

---

## Async patterns

`asyncio_mode = auto` — no decorator needed:

```python
# ✅ correct
async def test_something():
    result = await some_coroutine()
    assert result == "expected"

# ❌ wrong — redundant in this project
@pytest.mark.asyncio
async def test_something():
    ...
```

Async fixtures use `@pytest_asyncio.fixture`:

```python
@pytest_asyncio.fixture
async def my_fixture():
    obj = await build_something()
    yield obj
    await obj.cleanup()
```

---

## Mocking patterns

### Patch a module-level import
```python
with patch("app.services.lsp.manager.lsp_manager", my_fake_manager):
    ...
```

### AsyncMock for coroutines
```python
handler = AsyncMock(return_value="tool result")
result = await hook.wrap_tool_call(ctx, state, tc, handler)
```

### MagicMock for sync objects / ctx / state
```python
ctx = MagicMock()
state = MagicMock()
```

### stream_store — always patch in team/hook tests
The stream store is a singleton. Patch all four methods:
```python
with (
    patch("app.services.memory_stream_store.push_event", new_callable=AsyncMock) as push,
    patch("app.services.memory_stream_store.mark_done", new_callable=AsyncMock),
    patch("app.services.memory_stream_store.clear", new_callable=AsyncMock),
    patch("app.services.memory_stream_store.init_turn", new_callable=AsyncMock),
):
    yield push
```
The team conftest does this automatically via `mock_stream_store` (autouse).

---

## Hook test patterns

All hooks share the same three objects. Build them with helpers, not inline:

```python
def make_ctx(session_id: str = "s", agent_name: str = "bot") -> RunContext:
    return RunContext(session_id=session_id, run_id="r", agent_name=agent_name)

def make_state() -> AgentState:
    return AgentState(messages=[], system_prompt="")

def make_tool_call(name: str = "write", id: str = "tc_1") -> ToolCall:
    return ToolCall(id=id, function=FunctionCall(name=name, arguments="{}"))
```

### wrap_tool_call
```python
async def test_hook_intercepts_write(tmp_path):
    hook = MyHook()
    handler = AsyncMock(return_value="Written 10 bytes")
    result = await hook.wrap_tool_call(make_ctx(), make_state(), make_tool_call("write"), handler)
    assert "Written 10 bytes" in result
```

### wrap_model_call — use ModelRequest.override
```python
async def _noop_handler(request: ModelRequest) -> AssistantMessage:
    return AssistantMessage(content="done")

async def test_prompt_mutation():
    hook = MyPromptHook()
    req = ModelRequest(messages=(), system_prompt="base")
    result = await hook.wrap_model_call(make_ctx(), make_state(), req, _noop_handler)
    assert "extra text" in result.content
```

---

## Provider mock patterns

### MockProvider — minimal LLMProviderBase
```python
from app.agent.providers.base import LLMProviderBase

class MockProvider(LLMProviderBase):
    model = "mock-model"

    def __init__(self, response: str = "OK"):
        super().__init__()
        self.response = response
        self.call_count = 0

    def stream(self, messages, tools=None, **kw):
        self.call_count += 1
        async def _gen():
            yield make_text_chunk(self.response)
        return _gen()

    async def chat(self, messages, tools=None, **kw):
        return AssistantMessage(content=self.response)
```

### make_text_chunk helper
```python
def make_text_chunk(text: str) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="c1", created=1_000_000, model="mock",
        choices=[ChatCompletionChunkChoice(
            index=0,
            delta=ChatCompletionDelta(content=text),
            finish_reason="stop",
        )],
    )
```

---

## API route test patterns

Build a minimal FastAPI app rather than importing the full server:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api/...")
    return app

def test_route():
    client = TestClient(_make_app())
    resp = client.get("/api/.../something")
    assert resp.status_code == 200
```

Async routes that need a DB session use dependency overrides:

```python
from app.core.db import get_session

async def _override_session():
    async with test_session_factory() as s:
        yield s

app.dependency_overrides[get_session] = _override_session
```

---

## Sandbox context (for tools / LSP / file hooks)

Some production code reads the active sandbox via `get_sandbox()`. Set it before and reset it after:

```python
from app.agent.sandbox import SandboxConfig, set_sandbox

def test_something(tmp_path):
    sandbox = SandboxConfig(workspace=str(tmp_path))
    token = set_sandbox(sandbox)
    try:
        ...
    finally:
        from app.agent.sandbox import _sandbox_ctx
        _sandbox_ctx.reset(token)
```

Or use `pytest.fixture` to scope it cleanly:

```python
@pytest.fixture
def sandbox(tmp_path):
    from app.agent.sandbox import SandboxConfig, set_sandbox, _sandbox_ctx
    token = set_sandbox(SandboxConfig(workspace=str(tmp_path)))
    yield tmp_path
    _sandbox_ctx.reset(token)
```

---

## Team test patterns

Use the fixtures from `tests/agent/mode/team/conftest.py`:

```python
# basic_team: AgentTeam with lead + member_a + member_b
# lead_member, member_a, member_b: individual TeamMember fixtures
# mock_stream_store: autouse — patches all stream_store calls, yields push mock

async def test_team_lifecycle(basic_team):
    await basic_team.start()
    await basic_team.stop()
```

For custom provider responses, build a `MockTeamProvider(response_text="...")`.

---

## InMemoryCheckpointer (stateless / unit tests)

Use instead of `SQLiteCheckpointer` when you don't need DB persistence:

```python
from app.agent.checkpointer import InMemoryCheckpointer

cp = InMemoryCheckpointer()
await cp.sync(ctx, state)
loaded = await cp.load(ctx.session_id)
```

---

## Grouping with classes

Group related tests in a class for better organisation — no `__init__`, no pytest fixture injection via `self`:

```python
class TestMyFeature:
    async def test_happy_path(self, tmp_path):
        ...

    async def test_error_case(self):
        ...
```

---

## What NOT to do

- **Never `await asyncio.sleep(n)` for real delays** — patch `asyncio.sleep` or use `asyncio.Event`.
- **Never import from `app.server`** in unit tests — instantiate routers directly.
- **Never share mutable state between tests** — module-level dicts, singletons, caches must be reset in a fixture.
- **Never use `@pytest.mark.asyncio`** — `asyncio_mode = auto` makes it redundant and noisy.
- **Never open a second `:memory:` engine** in a test that uses the global `setup_db` — it will see an empty schema.
- **Never patch at the definition site** — patch at the import site used by the code under test: `patch("app.services.lsp.manager.lsp_manager", ...)` not `patch("app.services.lsp.client.lsp_manager", ...)`.

---

## Run commands

```bash
# Full suite
uv run pytest --no-cov -q

# Single file
uv run pytest --no-cov tests/services/test_lsp.py -q

# Single test
uv run pytest --no-cov tests/services/test_lsp.py::test_lsp_client_lifecycle -q

# With coverage for a module
uv run pytest tests/services/test_lsp.py -q

# Lint + format check
uv run ruff check app/ tests/
uv run ruff format --check app/ tests/
```
