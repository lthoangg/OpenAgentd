"""Backoff/jitter behaviour for provider retries.

Production logs show five 529 retries firing in exact lockstep
(1s, 3s, 9s, 27s) against an overloaded Anthropic upstream.  Deterministic
backoff means every concurrent agent retries at the same instants, which is
the worst pattern against a capacity-limited provider.  Jitter de-correlates
them — without ever overriding a server-specified ``Retry-After`` or
weakening the "rate limit too long" bail-out.
"""

from __future__ import annotations

from app.agent.agent_loop.retry import (
    _BASE_DELAY,
    _MAX_DELAY,
    _backoff_delay,
)


def test_backoff_grows_exponentially_within_jitter_band():
    """Each attempt's delay stays inside [base/2, base] for base = 1,3,9,27."""
    for attempt in range(4):
        base = _BASE_DELAY * (3**attempt)
        samples = [_backoff_delay(attempt) for _ in range(200)]
        assert all(base / 2 <= d <= base for d in samples), (
            f"attempt {attempt} escaped the jitter band [{base / 2}, {base}]"
        )


def test_backoff_is_not_deterministic():
    """The whole point: two callers must not retry at the same instant."""
    samples = {_backoff_delay(3) for _ in range(200)}
    assert len(samples) > 50, "delay must be jittered, not a fixed value"


def test_backoff_never_exceeds_the_previous_deterministic_delay():
    """Jitter must not make turns slower than before — only earlier or equal."""
    for attempt in range(5):
        previous_behaviour = min(_BASE_DELAY * (3**attempt), _MAX_DELAY)
        assert all(_backoff_delay(attempt) <= previous_behaviour for _ in range(200)), (
            f"attempt {attempt} waited longer than the old fixed backoff"
        )


def test_backoff_is_capped():
    """Large attempt counts stay under the ceiling."""
    assert all(_backoff_delay(10) <= _MAX_DELAY for _ in range(100))


def test_retry_after_is_honoured_verbatim_without_jitter():
    """A server directive is not a suggestion — never wait less than asked."""
    for _ in range(50):
        assert _backoff_delay(0, retry_after=11) == 11.0
        assert _backoff_delay(3, retry_after=2) == 2.0


def test_retry_after_is_still_capped():
    """An absurd Retry-After is clamped to the ceiling."""
    assert _backoff_delay(0, retry_after=99_999) == _MAX_DELAY
