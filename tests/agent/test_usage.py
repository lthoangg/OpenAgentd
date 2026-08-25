from __future__ import annotations

import pytest

from app.agent import usage as usage_module
from app.agent.providers.model_metadata import ModelCost
from app.agent.schemas.chat import Usage


def _patch_cost(monkeypatch: pytest.MonkeyPatch, cost: ModelCost) -> None:
    """Pin the time-aware cost lookup to a fixed price for the test."""
    monkeypatch.setattr(usage_module, "get_cost_at", lambda model_id, at: cost)


def test_usage_to_dict_estimates_input_output_and_cache_read_cost(
    monkeypatch,
) -> None:
    _patch_cost(monkeypatch, ModelCost(input=2.0, output=10.0, cache_read=0.5))

    result = usage_module.usage_to_dict(
        Usage(
            prompt_tokens=1_000,
            completion_tokens=200,
            total_tokens=1_200,
            cached_tokens=250,
        ),
        "openai:gpt-test",
    )

    assert result["input"] == 1_000
    assert result["output"] == 200
    assert result["cache"] == 250
    assert result["cost"] == {
        "estimated_usd": 0.003625,
        "cache_read_usd": 0.000125,
        "input_usd": 0.0015,
        "output_usd": 0.002,
    }


def test_usage_to_dict_prices_cache_writes_at_the_cache_write_rate(
    monkeypatch,
) -> None:
    """Cache creation is billed above the input rate, not at it.

    Anthropic charges a premium to *write* the cache (models.dev reports
    ``cache_write`` at 1.25x ``input`` for every Claude model). Folding those
    tokens into plain input silently under-reports the cost of every turn that
    warms or extends the cache.
    """
    _patch_cost(
        monkeypatch,
        ModelCost(input=3.0, output=15.0, cache_read=0.3, cache_write=3.75),
    )

    result = usage_module.usage_to_dict(
        Usage(
            prompt_tokens=10_000,
            completion_tokens=100,
            total_tokens=10_100,
            cached_tokens=8_000,
            cache_write_tokens=1_500,
        ),
        "anthropic:claude-sonnet-4-6",
    )

    assert result["cache"] == 8_000
    assert result["cache_write"] == 1_500
    # 500 fresh input, 8000 cache reads, 1500 cache writes, 100 output.
    cost = result["cost"]
    assert cost["cache_read_usd"] == 0.0024
    assert cost["cache_write_usd"] == 0.005625
    assert cost["input_usd"] == 0.0015
    assert cost["output_usd"] == 0.0015
    assert cost["estimated_usd"] == pytest.approx(0.011025)
    # Billing the writes as plain input would have charged 3.0 instead of 3.75
    # on 1500 tokens — the exact gap this fix closes.
    billed_as_plain_input = 0.0024 + (2_000 * 3.0 / 1e6) + 0.0015
    assert cost["estimated_usd"] - billed_as_plain_input == pytest.approx(
        1_500 * (3.75 - 3.0) / 1e6
    )


def test_usage_to_dict_charges_cache_writes_as_input_when_no_write_price(
    monkeypatch,
) -> None:
    """Without a cache_write price the tokens stay billable input — the old
    behaviour, kept so models lacking the field are never under-charged."""
    _patch_cost(monkeypatch, ModelCost(input=2.0, output=None, cache_read=0.5))

    result = usage_module.usage_to_dict(
        Usage(
            prompt_tokens=1_000,
            completion_tokens=0,
            total_tokens=1_000,
            cached_tokens=250,
            cache_write_tokens=100,
        ),
        "openai:gpt-test",
    )

    # 750 tokens (650 fresh + 100 writes) at the input rate.
    cost = result["cost"]
    assert set(cost) == {"estimated_usd", "cache_read_usd", "input_usd"}
    assert cost["cache_read_usd"] == 0.000125
    assert cost["input_usd"] == 0.0015
    assert cost["estimated_usd"] == pytest.approx(0.001625)


def test_usage_to_dict_charges_all_input_when_cache_price_unknown(monkeypatch) -> None:
    _patch_cost(monkeypatch, ModelCost(input=2.0, output=None, cache_read=None))

    result = usage_module.usage_to_dict(
        Usage(
            prompt_tokens=1_000,
            completion_tokens=0,
            total_tokens=1_000,
            cached_tokens=250,
        ),
        "openai:gpt-test",
    )

    assert result["cost"] == {
        "estimated_usd": 0.002,
        "input_usd": 0.002,
    }


def test_usage_to_dict_omits_cost_when_registry_has_no_prices(monkeypatch) -> None:
    _patch_cost(monkeypatch, ModelCost())

    result = usage_module.usage_to_dict(
        Usage(prompt_tokens=1_000, completion_tokens=200, total_tokens=1_200),
        "unknown:model",
    )

    assert result == {"input": 1_000, "output": 200}


def test_provider_cost_model_id_qualifies_the_bare_model() -> None:
    """Providers carry a bare ``.model`` (it builds the request URL); cost
    lookups need the ``provider:model`` form or the registry's suffix fallback
    may resolve to another provider's entry (or a price-less reseller stub).
    """

    class _Provider:
        provider_name = "anthropic"
        model = "claude-sonnet-4-5"

    assert (
        usage_module.provider_cost_model_id(_Provider())
        == "anthropic:claude-sonnet-4-5"
    )

    # Direct construction (unit tests) has no provider_name — fall back to the
    # bare id rather than crashing.
    class _BareProvider:
        model = "gpt-test"

    assert usage_module.provider_cost_model_id(_BareProvider()) == "gpt-test"
    assert usage_module.provider_cost_model_id(None) is None
