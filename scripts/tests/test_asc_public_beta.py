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
    def __init__(self, states: list[str], review_status: int = 201):
        self.states = states
        self.review_status = review_status
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method: str, path: str, body):
        self.calls.append((method, path))
        if path.startswith("/v1/apps?"):
            return 200, {"data": [{"id": "app1"}]}
        if path.startswith("/v1/betaGroups?"):
            return 200, {"data": [{"id": "grp1"}]} if "Public+Beta" in path else {"data": []}
        if path.startswith("/v1/builds?"):
            state = self.states.pop(0) if self.states else "VALID"
            return 200, {"data": [{"id": "b1", "attributes": {"processingState": state}}]}
        if path == "/v1/betaGroups/grp1/relationships/builds":
            assert body == {"data": [{"type": "builds", "id": "b1"}]}
            return 204, None
        if path == "/v1/betaAppReviewSubmissions":
            assert body["data"]["relationships"]["build"]["data"]["id"] == "b1"
            return self.review_status, None
        raise AssertionError(path)


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
