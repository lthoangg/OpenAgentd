#!/usr/bin/env python3
"""Send an uploaded iOS build to the TestFlight Public Beta.

Run by ``release-ios.yml`` (channel ``public``) after ``altool`` uploads the
build. It waits until App Store Connect has processed the build, adds it to
the external TestFlight group (default "Public Beta"), and submits it for
Beta App Review. A build already in review or approved is not an error.
``publish-ios-beta.yml`` runs it alone for a build that is already uploaded.

Usage:
  asc-public-beta.py --key-file AuthKey_<id>.p8 --version 3.50.0 --build 123

Environment: ASC_API_KEY (key id) and ASC_API_ISSUER (issuer id).
Needs ``pyjwt[crypto]`` for the ES256 token.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

API = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = "com.openagentd.mobile"
# Apple can list a build as processed minutes before its TestFlight calls
# know it; until then they answer 404 for the build.
KNOWN_TIMEOUT = 15 * 60

Request = Callable[[str, str, Any], tuple[int, Any]]


def token(key_id: str, issuer: str, private_key: str, now: float | None = None) -> str:
    import jwt  # pyjwt[crypto]; imported here so the tests need no key

    issued = int(now if now is not None else time.time())
    claims = {"iss": issuer, "iat": issued, "exp": issued + 15 * 60, "aud": "appstoreconnect-v1"}
    return jwt.encode(claims, private_key, algorithm="ES256", headers={"kid": key_id, "typ": "JWT"})


def renewed_token(key_id: str, issuer: str, pem: str,
                  clock: Callable[[], float] = time.time) -> Callable[[], str]:
    """A token for each request, made anew every 10 minutes: one lives 15,
    and Apple can take longer than that to process a build."""
    held: dict[str, Any] = {"token": None, "at": 0.0}

    def bearer() -> str:
        now = clock()
        if held["token"] is None or now - held["at"] >= 10 * 60:
            held["token"], held["at"] = token(key_id, issuer, pem, now), now
        return held["token"]

    return bearer


def http(bearer: Callable[[], str]) -> Request:
    def request(method: str, path: str, body: Any = None) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {bearer()}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raw = error.read()
            return error.code, json.loads(raw) if raw else None

    return request


def query(path: str, **params: str) -> str:
    return f"{path}?{urllib.parse.urlencode(params)}"


def first_id(status: int, body: Any, what: str) -> str:
    if status != 200 or not body or not body.get("data"):
        raise SystemExit(f"asc-public-beta: error: {what} not found (HTTP {status}): {body}")
    return body["data"][0]["id"]


def wait_for_build(request: Request, app_id: str, version: str, build: str,
                   timeout: float, sleep: Callable[[float], None] = time.sleep) -> str:
    """Id of the processed build; Apple takes minutes to process an upload."""
    path = query("/v1/builds", **{"filter[app]": app_id, "filter[version]": build,
                                   "filter[preReleaseVersion.version]": version})
    waited = 0.0
    while True:
        status, body = request("GET", path, None)
        builds = (body or {}).get("data") or [] if status == 200 else []
        if builds:
            state = builds[0]["attributes"].get("processingState")
            if state == "VALID":
                return builds[0]["id"]
            if state in ("FAILED", "INVALID"):
                raise SystemExit(f"asc-public-beta: error: build {version} ({build}) is {state}")
        if waited >= timeout:
            raise SystemExit(f"asc-public-beta: error: build {version} ({build}) not processed after {int(timeout)}s")
        sleep(30)
        waited += 30


def when_known(send: Callable[[], tuple[int, Any]], timeout: float,
                sleep: Callable[[float], None]) -> tuple[int, Any]:
    """The answer to ``send``, sent again every 30 s while Apple answers 404."""
    waited = 0.0
    while True:
        status, body = send()
        if status != 404 or waited >= timeout:
            return status, body
        print("asc-public-beta: Apple does not know the build yet (HTTP 404); again in 30s", flush=True)
        sleep(30)
        waited += 30


def build_state(request: Request, build_id: str) -> str:
    """What Apple says about the build, for an error message; empty if it does not say."""
    status, body = request("GET", query(f"/v1/builds/{build_id}", **{
        "include": "buildBetaDetail",
        "fields[builds]": "processingState,expired,buildAudienceType",
        "fields[buildBetaDetails]": "internalBuildState,externalBuildState",
    }), None)
    if status != 200 or not body:
        return ""
    parts = [(body.get("data") or {}).get("attributes") or {}]
    parts += [item.get("attributes") or {} for item in body.get("included") or []]
    return ", ".join(f"{key}={value}" for part in parts for key, value in part.items())


def publish(request: Request, version: str, build: str, group: str,
            timeout: float = 45 * 60, sleep: Callable[[float], None] = time.sleep,
            known_timeout: float = KNOWN_TIMEOUT) -> None:
    app_id = first_id(*request("GET", query("/v1/apps", **{"filter[bundleId]": BUNDLE_ID}), None), f"app {BUNDLE_ID}")
    group_id = first_id(*request("GET", query("/v1/betaGroups", **{"filter[app]": app_id, "filter[name]": group}), None),
                        f'TestFlight group "{group}"')
    build_id = wait_for_build(request, app_id, version, build, timeout, sleep)

    build_ref = {"type": "builds", "id": build_id}
    add = f"/v1/betaGroups/{group_id}/relationships/builds"
    status, body = when_known(lambda: request("POST", add, {"data": [build_ref]}), known_timeout, sleep)
    if status not in (200, 201, 204):
        state = build_state(request, build_id)
        raise SystemExit(f"asc-public-beta: error: adding the build to {group} failed (HTTP {status}): {body}"
                         + (f"; Apple has the build as: {state}" if state else ""))
    print(f"asc-public-beta: build {version} ({build}) added to {group}", flush=True)

    submission = {"data": {"type": "betaAppReviewSubmissions", "relationships": {"build": {"data": build_ref}}}}
    status, body = when_known(lambda: request("POST", "/v1/betaAppReviewSubmissions", submission), known_timeout, sleep)
    if status in (200, 201):
        print("asc-public-beta: submitted for Beta App Review")
    elif status == 409:
        # Already submitted, or a later build of an approved version.
        print("asc-public-beta: Beta App Review already has this build or its version")
    else:
        raise SystemExit(f"asc-public-beta: error: Beta App Review submission failed (HTTP {status}): {body}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Send an uploaded iOS build to the TestFlight Public Beta.")
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--version", required=True, help="CFBundleShortVersionString, e.g. 3.50.0")
    parser.add_argument("--build", required=True, help="CFBundleVersion (the CI run number)")
    parser.add_argument("--group", default="Public Beta")
    args = parser.parse_args(argv)
    key_id, issuer = os.environ.get("ASC_API_KEY"), os.environ.get("ASC_API_ISSUER")
    if not key_id or not issuer:
        raise SystemExit("asc-public-beta: error: ASC_API_KEY and ASC_API_ISSUER are required")
    with open(args.key_file) as handle:
        bearer = renewed_token(key_id, issuer, handle.read())
    publish(http(bearer), args.version, args.build, args.group)
    return 0


if __name__ == "__main__":
    sys.exit(main())
