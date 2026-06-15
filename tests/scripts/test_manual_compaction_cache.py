from __future__ import annotations

import pytest

from manual import compaction_cache


def test_cache_ratio_handles_missing_and_present_usage() -> None:
    assert compaction_cache.cache_ratio({}) == 0.0
    assert compaction_cache.cache_ratio({"gen_ai.usage.input_tokens": 100}) == 0.0
    assert (
        compaction_cache.cache_ratio(
            {
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.cache_read.input_tokens": 25,
            }
        )
        == 0.25
    )


def test_summarization_cache_rows_filters_to_summarization_usage() -> None:
    rows = [
        ("chat codex:gpt-5.5", {"gen_ai.usage.input_tokens": 100}),
        ("summarization", {"gen_ai.usage.input_tokens": 0}),
        (
            "summarization_llm_call",
            {
                "gen_ai.usage.input_tokens": 200,
                "gen_ai.usage.cache_read.input_tokens": 50,
            },
        ),
    ]

    result = compaction_cache.summarization_cache_rows(rows)

    assert len(result) == 1
    assert result[0][0] == "summarization_llm_call"
    assert result[0][2] == 0.25


@pytest.mark.asyncio
async def test_direct_smoke_verifies_prefix_shape_and_skill_inclusion() -> None:
    result = await compaction_cache.run_direct()

    assert result == {
        "shared_prefix_messages": 4,
        "skill_included": True,
        "final_system_prompt_chars": 89,
        "summary_forwarded": True,
    }
