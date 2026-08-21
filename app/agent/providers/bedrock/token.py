"""Pure-Python AWS Bedrock bearer token generator and credential resolver.

Generates short-lived AWS Bedrock Mantle SigV4 bearer tokens without requiring
``botocore``, ``awscrt``, or external AWS libraries.
"""

from __future__ import annotations

import base64
import configparser
import hashlib
import hmac
import os
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import orjson


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _get_signature_key(
    key: str, date_stamp: str, region_name: str, service_name: str
) -> bytes:
    k_date = _sign(("AWS4" + key).encode("utf-8"), date_stamp)
    k_region = _sign(k_date, region_name)
    k_service = _sign(k_region, service_name)
    return _sign(k_service, "aws4_request")


def _extract_from_section(sec: Any) -> tuple[str, str, str | None] | None:
    ak = sec.get("aws_access_key_id") or sec.get("aws_access_key")
    sk = sec.get("aws_secret_access_key") or sec.get("aws_secret_key")
    st = sec.get("aws_session_token") or sec.get("aws_security_token")
    if ak and sk:
        return ak, sk, st
    return None


def resolve_aws_credentials(
    profile_name: str | None = None,
) -> tuple[str, str, str | None]:
    """Resolve AWS credentials (access_key, secret_key, session_token).

    Checks environment variables, ``~/.aws/credentials``, ``~/.aws/config``,
    and login/SSO caches under ``~/.aws/``.
    """
    profile = profile_name or os.getenv("AWS_PROFILE") or "default"

    # 1. Direct env vars if profile is default or unspecified
    if profile == "default" or not profile_name:
        ak = os.getenv("AWS_ACCESS_KEY_ID")
        sk = os.getenv("AWS_SECRET_ACCESS_KEY")
        st = os.getenv("AWS_SESSION_TOKEN")
        if ak and sk:
            return ak, sk, st

    # 2. Check ~/.aws/credentials
    cred_file = Path.home() / ".aws" / "credentials"
    if cred_file.is_file():
        cfg = configparser.ConfigParser()
        try:
            cfg.read(cred_file, encoding="utf-8")
            for sec_name in (profile, f"profile {profile}"):
                if sec_name in cfg:
                    res = _extract_from_section(cfg[sec_name])
                    if res:
                        return res
        except Exception:
            pass

    # 3. Check ~/.aws/config
    cfg_file = Path.home() / ".aws" / "config"
    if cfg_file.is_file():
        cfg = configparser.ConfigParser()
        try:
            cfg.read(cfg_file, encoding="utf-8")
            for sec_name in (f"profile {profile}", profile):
                if sec_name in cfg:
                    res = _extract_from_section(cfg[sec_name])
                    if res:
                        return res
        except Exception:
            pass

    # 4. Check ~/.aws JSON caches (login, sso, cli)
    for cache_dir in (
        Path.home() / ".aws" / "login" / "cache",
        Path.home() / ".aws" / "sso" / "cache",
        Path.home() / ".aws" / "cli" / "cache",
    ):
        if cache_dir.is_dir():
            for json_file in cache_dir.glob("*.json"):
                try:
                    data = orjson.loads(json_file.read_bytes())
                    acc_tok = data.get("accessToken")
                    if isinstance(acc_tok, dict):
                        ak = acc_tok.get("accessKeyId")
                        sk = acc_tok.get("secretAccessKey")
                        st = acc_tok.get("sessionToken")
                        if ak and sk:
                            return ak, sk, st
                    elif isinstance(acc_tok, str):
                        try:
                            parsed = orjson.loads(acc_tok)
                            if isinstance(parsed, dict):
                                ak = parsed.get("accessKeyId")
                                sk = parsed.get("secretAccessKey")
                                st = parsed.get("sessionToken")
                                if ak and sk:
                                    return ak, sk, st
                        except Exception:
                            pass
                except Exception:
                    pass

    # 5. Fallback to env vars
    ak = os.getenv("AWS_ACCESS_KEY_ID")
    sk = os.getenv("AWS_SECRET_ACCESS_KEY")
    st = os.getenv("AWS_SESSION_TOKEN")
    if ak and sk:
        return ak, sk, st

    raise ValueError(
        f"AWS credentials for profile {profile!r} not found in environment, ~/.aws/config, ~/.aws/credentials, or login cache"
    )


def resolve_aws_region(
    region_name: str | None = None, profile_name: str | None = None
) -> str:
    """Resolve AWS region from arguments, environment, or ~/.aws/config."""
    if region_name:
        return region_name

    env_region = (
        os.getenv("AWS_BEDROCK_REGION")
        or os.getenv("AWS_REGION")
        or os.getenv("AWS_DEFAULT_REGION")
    )
    if env_region:
        return env_region

    profile = profile_name or os.getenv("AWS_PROFILE") or "default"
    cfg_file = Path.home() / ".aws" / "config"
    if cfg_file.is_file():
        cfg = configparser.ConfigParser()
        try:
            cfg.read(cfg_file, encoding="utf-8")
            for sec_name in (
                f"profile {profile}",
                profile,
                "default",
                "profile default",
            ):
                if sec_name in cfg and "region" in cfg[sec_name]:
                    reg = cfg[sec_name]["region"].strip()
                    if reg:
                        return reg
        except Exception:
            pass

    return "us-east-1"


def generate_bedrock_bearer_token(
    region: str = "us-east-1",
    profile_name: str | None = None,
    expires: int = 43200,
) -> str:
    """Generate a presigned AWS Bedrock bearer token using SigV4 HMAC-SHA256."""
    access_key, secret_key, session_token = resolve_aws_credentials(profile_name)

    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    service = "bedrock"
    host = (
        f"bedrock.{region}.amazonaws.com"
        if region != "us-east-1"
        else "bedrock.amazonaws.com"
    )
    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"

    params = {
        "Action": "CallWithBearerToken",
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{credential_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": "host",
    }
    if session_token:
        params["X-Amz-Security-Token"] = session_token

    canonical_querystring = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
        for k, v in sorted(params.items())
    )
    canonical_headers = f"host:{host}\n"
    signed_headers = "host"
    payload_hash = hashlib.sha256(b"").hexdigest()

    canonical_request = f"POST\n/\n{canonical_querystring}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    string_to_sign = (
        f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n"
        f"{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
    )

    signing_key = _get_signature_key(secret_key, date_stamp, region, service)
    signature = hmac.new(
        signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    presigned_url = (
        f"{host}/?{canonical_querystring}&X-Amz-Signature={signature}&Version=1"
    )
    encoded_token = base64.b64encode(presigned_url.encode("utf-8")).decode("utf-8")
    return f"bedrock-api-key-{encoded_token}"
