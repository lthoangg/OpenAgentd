"""Probe whether providers continue from a trailing-assistant message list.

Question: if we send a message list whose last item is an AssistantMessage
(no trailing user turn), do OpenAI Chat Completions, OpenAI Responses, and
Google Gemini all keep generating from where the assistant left off?

This decides /continue's implementation: if all three tolerate the bare
trailing-assistant pattern, the endpoint is trivial — just stream the
existing history. If not, we need a per-provider workaround.

Usage:
  uv run python -m manual.try_providers.try_continue_probe

No flags. Hits three configurations:
  1. OpenAI Chat Completions  (model: gpt-5.4-mini)
  2. OpenAI Responses          (model: gpt-5.4-mini)
  3. Gemini                    (model: gemini-3.1-pro-preview)
"""

from __future__ import annotations

import argparse
import asyncio
import time

from app.agent.providers.openai import OpenAIProvider
from app.agent.schemas.chat import AssistantMessage, HumanMessage
from app.core.config import settings


# Me: case A — simple numeric prefill, baseline.
CASE_A_USER = "Count from 1 to 10, separated by commas. Just the numbers."
CASE_A_ASSISTANT = "1, 2, 3, 4,"

# Me: case B — realistic English prose cut mid-sentence. Mirrors the
# real /continue case where the model was streaming prose and Stop was
# pressed.  No "[interrupted]" suffix.
CASE_B_USER = "Write a detailed, ~200 word response describing the history of Python."
CASE_B_ASSISTANT = (
    "Python began in the late 1980s when Guido van Rossum, working at CWI in "
    "the Netherlands, set out to build a language that was easier to read and "
    "use than C, but more practical for real work than shell scripts. He "
    "released Python 0.9.0 in 1991, then Python 1.0 in 1994. The language "
    "grew into web development, automation, education, DevOps, and especially "
    "data science and AI, helped by NumPy, pandas, Django, Flask, PyTorch, and"
)

# Me: case C — same as case B but with the "[interrupted]" suffix the
# checkpointer appends on Stop.  This is the suspected culprit.
CASE_C_ASSISTANT = CASE_B_ASSISTANT + " [interrupted]"


async def probe(
    provider,
    *,
    label: str,
    user_prompt: str,
    assistant_prefix: str,
) -> None:
    """Stream with a trailing-assistant message; print outcome."""
    print(f"\n{'=' * 70}")
    print(f"[{label}] model={provider.model}")
    print(f"  user:      {user_prompt!r}")
    # Truncate long prefixes for display.
    prefix_disp = (
        assistant_prefix
        if len(assistant_prefix) <= 90
        else assistant_prefix[:30] + " … " + assistant_prefix[-50:]
    )
    print(f"  assistant: {prefix_disp!r}")
    print("             <-- last message, no new user turn")
    print(f"{'=' * 70}")

    messages = [
        HumanMessage(content=user_prompt),
        AssistantMessage(content=assistant_prefix),
    ]

    content_chars = 0
    reasoning_chars = 0
    output_buf: list[str] = []
    finish_reason: str | None = None
    start = time.monotonic()

    try:
        async for chunk in provider.stream(messages):
            for choice in chunk.choices:
                delta = choice.delta
                if delta.reasoning_content:
                    reasoning_chars += len(delta.reasoning_content)
                if delta.content:
                    content_chars += len(delta.content)
                    output_buf.append(delta.content)
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
    except Exception as e:
        print(f"  [REJECTED] {type(e).__name__}: {e}")
        return

    elapsed = time.monotonic() - start
    output = "".join(output_buf)
    output_disp = output if len(output) <= 300 else output[:200] + " … " + output[-80:]
    print(f"  [accepted] elapsed={elapsed:.1f}s finish_reason={finish_reason!r}")
    print(f"  [output]   {output_disp!r}")
    print(f"  [counts]   reasoning={reasoning_chars} content={content_chars}")
    # Me: simple heuristic — if output starts with "Python began" or similar
    # opener that mirrors the prefill, the model RESTARTED.  Otherwise it
    # CONTINUED.  For the numeric baseline the marker is " 5".
    stripped = output.lstrip()
    if stripped.startswith("5") or stripped.startswith(", 5"):
        verdict = "CONTINUES (numeric baseline)"
    elif "Python began" in output[:60] or "Python is" in output[:40]:
        verdict = "RESTARTS — model began a fresh response"
    elif stripped[:20].lower().startswith(assistant_prefix[:20].lower()):
        verdict = "RESTARTS — output repeats the prefill"
    else:
        verdict = "CONTINUES (no restart pattern detected)"
    print(f"  [verdict]  {verdict}")


async def main(model: str) -> None:
    openai_key = (
        settings.OPENAI_API_KEY.get_secret_value() if settings.OPENAI_API_KEY else None
    )

    if not openai_key:
        print("SKIP: OPENAI_API_KEY not set — this probe needs OpenAI to repro.")
        return

    # Stick to one provider for clear A/B/C comparison.  The original probe
    # already proved all three providers tolerate trailing assistant; this
    # round is about content shape, not provider compatibility.
    print(f"model: {model}")
    provider = OpenAIProvider(api_key=openai_key, model=model)

    print(f"\n{'#' * 70}")
    print("# CASE A — numeric baseline (control)")
    print(f"{'#' * 70}")
    await probe(
        provider,
        label="A: numeric baseline",
        user_prompt=CASE_A_USER,
        assistant_prefix=CASE_A_ASSISTANT,
    )

    print(f"\n{'#' * 70}")
    print("# CASE B — English prose cut mid-sentence, NO [interrupted] suffix")
    print(f"{'#' * 70}")
    await probe(
        provider,
        label="B: prose, clean",
        user_prompt=CASE_B_USER,
        assistant_prefix=CASE_B_ASSISTANT,
    )

    print(f"\n{'#' * 70}")
    print("# CASE C — same prose + '[interrupted]' suffix (the suspect)")
    print(f"{'#' * 70}")
    await probe(
        provider,
        label="C: prose + [interrupted]",
        user_prompt=CASE_B_USER,
        assistant_prefix=CASE_C_ASSISTANT,
    )

    print(f"\n{'=' * 70}\ndone")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Trailing-assistant continuation probe")
    ap.add_argument(
        "--model", default="gpt-5.4-mini", help="OpenAI model (default: gpt-5.4-mini)"
    )
    args = ap.parse_args()
    asyncio.run(main(args.model))
