"""Подпись и проверка вебхуков: отправитель на Python."""
import hashlib
import hmac
import json
import time

TOLERANCE = 300


class VerifyError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def canonical(payload):
    return json.dumps(payload, sort_keys=True).encode()


def _mac(secret, ts, body):
    return hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


def sign(payload, secret, timestamp=None):
    ts = int(time.time()) if timestamp is None else timestamp
    body = canonical(payload)
    return body, f"t={ts},v1={_mac(secret, ts, body)}"


def verify(body, header, secrets, now=None, tolerance=TOLERANCE):
    if isinstance(body, str):
        body = body.encode()
    if isinstance(secrets, str):
        secrets = [secrets]
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        ts = int(parts["t"])
        sig = parts["v1"]
    except (ValueError, KeyError):
        raise VerifyError("BAD_HEADER")
    now = int(time.time()) if now is None else now
    if now - ts > tolerance:
        raise VerifyError("STALE")
    if not any(hmac.compare_digest(sig, _mac(s, ts, body)) for s in secrets):
        raise VerifyError("BAD_SIGNATURE")
    return json.loads(body)
