"""mobile/scripts/asc-public-beta.py sends a processed build to the Public Beta."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "mobile" / "scripts" / "asc-public-beta.py"
spec = importlib.util.spec_from_file_location("asc_public_beta", SCRIPT)
asc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asc)


class FakeAsc:
    def __init__(self, states: list[str], review_status: int = 201,
                 add_statuses: list[int] | None = None, review_statuses: list[int] | None = None):
        self.states = states
        self.review_status = review_status
        # Answers to the group and review calls, in order; the last one repeats.
        self.add_statuses = add_statuses or [204]
        self.review_statuses = review_statuses or [review_status]
        # What Apple says about the build itself, when asked.
        self.build_detail: dict | None = None
        self.calls: list[tuple[str, str]] = []

    @staticmethod
    def _next(statuses: list[int]) -> int:
        return statuses.pop(0) if len(statuses) > 1 else statuses[0]

    def __call__(self, method: str, path: str, body):
        self.calls.append((method, path))
        if path.startswith("/v1/apps?"):
            return 200, {"data": [{"id": "app1"}]}
        if path.startswith("/v1/betaGroups?"):
            return 200, {"data": [{"id": "grp1"}]} if "Public+Beta" in path else {"data": []}
        if path.startswith("/v1/builds?"):
            state = self.states.pop(0) if self.states else "VALID"
            return 200, {"data": [{"id": "b1", "attributes": {"processingState": state}}]}
        if path.startswith("/v1/builds/b1?"):
            return (200, self.build_detail) if self.build_detail else (404, None)
        if path == "/v1/betaGroups/grp1/relationships/builds":
            assert body == {"data": [{"type": "builds", "id": "b1"}]}
            status = self._next(self.add_statuses)
            return status, None if status == 204 else {"errors": [{"status": str(status)}]}
        if path == "/v1/betaAppReviewSubmissions":
            assert body["data"]["relationships"]["build"]["data"]["id"] == "b1"
            return self._next(self.review_statuses), None
        raise AssertionError(path)

    def count(self, path: str) -> int:
        return sum(1 for _, p in self.calls if p == path)


ADD = "/v1/betaGroups/grp1/relationships/builds"
REVIEW = "/v1/betaAppReviewSubmissions"


def test_waits_for_processing_then_adds_to_the_group_and_submits():
    fake = FakeAsc(["PROCESSING", "PROCESSING", "VALID"])
    asc.publish(fake, "3.50.0", "123", "Public Beta", sleep=lambda _: None)
    builds = [p for m, p in fake.calls if p.startswith("/v1/builds?")]
    assert len(builds) == 3
    assert "filter%5Bversion%5D=123" in builds[0]
    assert "filter%5BpreReleaseVersion.version%5D=3.50.0" in builds[0]
    assert ("POST", "/v1/betaAppReviewSubmissions") in fake.calls


def test_a_build_already_in_review_is_fine():
    asc.publish(FakeAsc([], review_status=409), "3.50.0", "124", "Public Beta", sleep=lambda _: None)


def test_a_missing_group_fails_clearly():
    with pytest.raises(SystemExit, match='TestFlight group "Beta"'):
        asc.publish(FakeAsc([]), "3.50.0", "1", "Beta", sleep=lambda _: None)


def test_an_invalid_build_fails():
    with pytest.raises(SystemExit, match="INVALID"):
        asc.publish(FakeAsc(["INVALID"]), "3.50.0", "1", "Public Beta", sleep=lambda _: None)


def test_processing_gives_up_after_the_timeout():
    with pytest.raises(SystemExit, match="not processed"):
        asc.publish(FakeAsc(["PROCESSING"] * 10), "3.50.0", "1", "Public Beta", timeout=60, sleep=lambda _: None)


def test_a_processed_build_apple_does_not_know_yet_is_added_once_it_does():
    # Apple lists a build as VALID before its TestFlight calls know it: they
    # answer 404 for the build until then (3.53.1, builds 30 and 31).
    fake = FakeAsc([], add_statuses=[404, 404, 204])
    waits: list[float] = []
    asc.publish(fake, "3.53.1", "31", "Public Beta", sleep=waits.append)
    assert fake.count(ADD) == 3
    assert waits == [30, 30]
    assert fake.count(REVIEW) == 1


def test_adding_gives_up_when_apple_never_knows_the_build():
    fake = FakeAsc([], add_statuses=[404])
    with pytest.raises(SystemExit, match=r"adding the build to Public Beta failed \(HTTP 404\)"):
        asc.publish(fake, "3.53.1", "31", "Public Beta", known_timeout=90, sleep=lambda _: None)
    assert fake.count(ADD) == 4  # at once, then every 30 s for 90 s
    assert fake.count(REVIEW) == 0


def test_another_refusal_to_add_fails_at_once():
    fake = FakeAsc([], add_statuses=[422])
    with pytest.raises(SystemExit, match=r"adding the build to Public Beta failed \(HTTP 422\)"):
        asc.publish(fake, "3.53.1", "31", "Public Beta", sleep=lambda _: None)
    assert fake.count(ADD) == 1


def test_the_review_submission_waits_for_the_build_too():
    fake = FakeAsc([], review_statuses=[404, 201])
    asc.publish(fake, "3.53.1", "31", "Public Beta", sleep=lambda _: None)
    assert fake.count(ADD) == 1
    assert fake.count(REVIEW) == 2


def test_giving_up_says_what_state_apple_has_the_build_in():
    fake = FakeAsc([], add_statuses=[404])
    fake.build_detail = {
        "data": {"id": "b1", "attributes": {"processingState": "VALID", "expired": False}},
        "included": [{"type": "buildBetaDetails", "attributes": {"externalBuildState": "PROCESSING"}}],
    }
    with pytest.raises(SystemExit, match="processingState=VALID.*externalBuildState=PROCESSING"):
        asc.publish(fake, "3.53.1", "31", "Public Beta", known_timeout=0, sleep=lambda _: None)


def test_the_token_is_renewed_before_apple_stops_accepting_it(monkeypatch):
    # A token lives 15 minutes; a slow night at Apple takes longer than that.
    minted: list[float] = []
    monkeypatch.setattr(asc, "token", lambda key_id, issuer, key, now: minted.append(now) or f"token-{len(minted)}")
    clock = iter([0.0, 9 * 60.0, 10 * 60.0, 12 * 60.0])
    bearer = asc.renewed_token("kid", "issuer", "key", clock=lambda: next(clock))
    assert [bearer(), bearer(), bearer(), bearer()] == ["token-1", "token-1", "token-2", "token-2"]
    assert minted == [0.0, 600.0]
