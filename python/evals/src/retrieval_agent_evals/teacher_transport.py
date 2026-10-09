"""Bounded teacher HTTP transport. Credentials, endpoints and bodies never enter diagnostics."""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit
from uuid import UUID, uuid4, uuid5

import httpx

_ACTIVE = contextvars.ContextVar("private_teacher_http", default=False)


class _PrivateRequestFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not _ACTIVE.get()


# HTTPX logs request URLs at INFO; httpcore debug traces may include connection details.
for _name in ("httpx", "httpcore", "httpcore.connection", "httpcore.http11",
              "httpcore.http2", "httpcore.proxy", "httpcore.socks"):
    logging.getLogger(_name).addFilter(_PrivateRequestFilter())


class TeacherConfigurationError(ValueError):
    pass


class TeacherOutputError(ValueError):
    def __init__(self, code: str):
        self.code = code if code in {"JSON_OUTPUT_MISSING", "LABEL_SCHEMA_INVALID", "JSON_RESPONSE_INVALID"} else "OUTPUT_SCHEMA_INVALID"
        super().__init__(self.code)


def safe_model_name(value: Any) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", value) else None


def safe_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    keys = ("prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens",
            "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "cache_read_input_tokens",
            "cache_creation_input_tokens")
    result = {k: value[k] for k in keys if type(value.get(k)) is int and value[k] >= 0}
    for key, prefix in (("completion_tokens_details", "completion"), ("prompt_tokens_details", "prompt")):
        details = value.get(key)
        if isinstance(details, dict):
            for name in ("reasoning_tokens", "cached_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"):
                if type(details.get(name)) is int and details[name] >= 0:
                    result[f"{prefix}_{name}"] = details[name]
    return result or None


LABEL_PAIR_SCORER_VERSION = "label-pair-sentinel-v1"
LOGPROB_UNAVAILABLE_SENTINEL = -9999


def label_pair_evidence(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Consume reported Y/N answer-position scores, never unavailable sentinels.

    The normalized pair is a reported conditional score. It is neither a verified
    raw distribution nor calibrated correctness or a human quality measurement.
    """
    result = {"available": False, "score": None, "label": None,
              "score_kind": "unavailable", "unavailable_reason": "answer_position_invalid",
              "reported_uncalibrated": True, "is_probability": False,
              "yes_label_present": False, "no_label_present": False,
              "both_labels_at_answer_position": False, "single_tokens_observed": False,
              "sentinel_seen": False, "raw_distribution_verified": False,
              "tokenizer_independently_verified": False, "scorer_version": LABEL_PAIR_SCORER_VERSION}
    try:
        choice = payload["choices"][0]
        answer = choice["message"]["content"]
        positions = choice["logprobs"]["content"]
        if answer not in {"Y", "N"} or not isinstance(positions, list) or len(positions) != 1:
            return result
        position = positions[0]
        if not isinstance(position, dict) or position.get("token") != answer:
            return result
        entries = position.get("top_logprobs")
        if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
            return result
        labels = {e.get("token") for e in entries if isinstance(e.get("token"), str)}
        result.update(yes_label_present="Y" in labels, no_label_present="N" in labels,
                      both_labels_at_answer_position={"Y", "N"} <= labels)
        reported_values = [e.get("logprob") for e in entries]
        if "logprob" in position:
            reported_values.append(position["logprob"])
        if any(type(v) in (int, float) and v == LOGPROB_UNAVAILABLE_SENTINEL for v in reported_values):
            result.update(sentinel_seen=True, unavailable_reason="unavailable_sentinel")
            return result
        if "logprob" in position and (type(position["logprob"]) not in (int, float)
                or not math.isfinite(position["logprob"]) or position["logprob"] > 0):
            result["unavailable_reason"] = "answer_logprob_invalid"
            return result
        scores = {}
        for item in entries:
            token = item.get("token")
            if token not in {"Y", "N"}:
                continue
            score = item.get("logprob")
            if token in scores:
                result["unavailable_reason"] = "duplicate_label"
                return result
            if type(score) not in (int, float) or not math.isfinite(score) or score > 0:
                result["unavailable_reason"] = "label_logprob_invalid"
                return result
            if item.get("bytes") not in (None, [ord(token)]):
                result["unavailable_reason"] = "label_token_bytes_invalid"
                return result
            scores[token] = float(score)
        if set(scores) != {"Y", "N"}:
            result["unavailable_reason"] = "missing_label"
            return result
        maximum = max(scores.values())
        yes, no = math.exp(scores["Y"] - maximum), math.exp(scores["N"] - maximum)
        result.update(available=True, score=yes / (yes + no), label=answer,
                      score_kind="reported_top_logprobs_label_pair_conditional_score",
                      unavailable_reason=None, single_tokens_observed=True)
        return result
    except (KeyError, IndexError, TypeError, ValueError, OverflowError):
        return result


def _validated_endpoint(endpoint: str) -> str:
    try:
        url = urlsplit(endpoint)
        valid = (url.scheme in {"http", "https"} and url.hostname and not url.username
                 and not url.password and not url.query and not url.fragment)
        _ = url.port
    except Exception:
        valid = False
    if not valid:
        raise TeacherConfigurationError("ENDPOINT_CONFIG_INVALID")
    return endpoint


def safe_provider_error(payload: Any) -> dict[str, str] | None:
    """Only fixed protocol enums can escape an untrusted provider error; never messages."""
    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return None
    allowed = {
        "code": {"invalid_request", "invalid_request_error", "bad_request", "unsupported_parameter",
                 "unsupported_value", "model_not_found", "authentication_error", "permission_denied",
                 "rate_limit_exceeded", "context_length_exceeded", "invalid_api_key", "insufficient_quota",
                 "not_found", "validation_error"},
        "type": {"invalid_request_error", "authentication_error", "permission_error", "rate_limit_error",
                 "server_error", "not_found_error", "validation_error", "api_error"},
        "param": {"model", "messages", "max_tokens", "stream", "response_format", "thinking", "logprobs",
                  "top_logprobs", "temperature", "top_p"},
    }
    result = {key: error[key] for key, values in allowed.items()
              if isinstance(error.get(key), str) and error[key] in values}
    return result or None


def open_code_session_id(session_id: str) -> str:
    """Mirror packages/dsh-compat/src/opencode-pi-ai.ts openCodeSessionId."""
    match = re.fullmatch(r"(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})", session_id, re.I)
    if match:
        return match.group(1).lower()
    return str(uuid5(UUID("4e7f6455-086e-4a38-92cb-aace799f8ad1"), session_id))


def new_routing_session_id() -> str:
    return open_code_session_id("teacher-" + str(uuid4()))


@dataclass(frozen=True)
class TeacherConfig:
    endpoint: str = field(repr=False)
    model: str
    api_key: str = field(repr=False)
    session_id: str | None = field(default_factory=new_routing_session_id, repr=False)
    protocol: str = "openai-completions"

    def __post_init__(self) -> None:
        if self.session_id is None or self.session_id == "":
            object.__setattr__(self, "session_id", new_routing_session_id())
        elif not isinstance(self.session_id, str) or any(c in self.session_id for c in "\r\n"):
            raise TeacherConfigurationError("session_invalid")

    def headers(self) -> dict[str, str]:
        values = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json", "Accept": "application/json"}
        if self.session_id:
            values["x-opencode-session"] = self.session_id
        return values

    def public_identity(self) -> dict[str, Any]:
        host = urlsplit(self.endpoint).hostname or ""
        if host.casefold() == "localhost":
            category = "local"
        else:
            try:
                ip = ipaddress.ip_address(host)
                category = "local" if ip.is_loopback else "private_network" if ip.is_private else "public_network"
            except ValueError:
                category = "dns_unverified"
        return {"configured_model": self.model, "protocol": self.protocol,
                "endpoint_category": category, "endpoint_fingerprint": hashlib.sha256(self.endpoint.encode()).hexdigest(),
                "dns_resolved": False, "teacher_model_authorized": True}


def load_teacher_config(env_file: Path, values: Mapping[str, str] | None = None) -> TeacherConfig:
    # Reuse only an existing file / process environment; never create credential configuration.
    if values is None:
        values = {}
        try:
            if env_file.is_file():
                for line in env_file.read_text(encoding="utf-8-sig").splitlines():
                    if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                        key, value = line.split("=", 1)
                        values[key.strip()] = value.strip().strip('"').strip("'")
        except Exception:
            raise TeacherConfigurationError("ENV_CONFIG_UNREADABLE") from None
    env = {**values, **os.environ}
    model = env.get("RETRIEVAL_AGENT_BROWSER_LLM_MODEL", "")
    compact = re.sub(r"[^a-z0-9]", "", model.casefold())
    if not safe_model_name(model) or not ("v41" in compact and "flash" in compact
                                         and ("deepseek" in compact or compact.startswith("ds"))):
        raise TeacherConfigurationError("MODEL_NOT_AUTHORIZED")
    base = env.get("RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL", "").rstrip("/")
    protocol = env.get("RETRIEVAL_AGENT_BROWSER_LLM_API", "") or "openai-completions"
    if protocol not in {"openai-completions", "openai-chat-completions"}:
        raise TeacherConfigurationError("PROTOCOL_NOT_AUTHORIZED")
    endpoint = _validated_endpoint(base + "/chat/completions")
    key_name = env.get("RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV", "")
    key = env.get(key_name, "") if key_name else ""
    if not key or any(c in key for c in "\r\n"):
        raise TeacherConfigurationError("CREDENTIAL_UNAVAILABLE")
    session = env.get("RETRIEVAL_AGENT_BROWSER_LLM_SESSION_ID") or None
    if session and any(c in session for c in "\r\n"):
        raise TeacherConfigurationError("SESSION_CONFIG_INVALID")
    return TeacherConfig(endpoint, model, key, session, protocol)


@dataclass(frozen=True)
class TransportPolicy:
    connect_seconds: float = 10.0
    read_seconds: float = 60.0
    write_seconds: float = 10.0
    pool_seconds: float = 5.0
    total_seconds: float = 180.0
    max_attempts: int = 3
    max_response_bytes: int = 1_000_000

    def __post_init__(self):
        times = (self.connect_seconds, self.read_seconds, self.write_seconds, self.pool_seconds, self.total_seconds)
        if any(not math.isfinite(v) or v <= 0 for v in times) or not 1 <= self.max_attempts <= 3 or self.max_response_bytes < 1:
            raise ValueError("TRANSPORT_POLICY_INVALID")


@dataclass
class TransportResult:
    payload: dict[str, Any] | None = field(default=None, repr=False)
    value: Any = field(default=None, repr=False)
    attempts: list[dict[str, Any]] = field(default_factory=list)
    error_code: str | None = None
    elapsed_ms: float = 0.0

    def metrics(self) -> dict[str, Any]:
        return {"calls": len(self.attempts), "attempts": self.attempts,
                "error_code": self.error_code, "latency_ms": self.elapsed_ms}


def _retry_after(value: str | None, attempt: int) -> float:
    try:
        seconds = float(value or "")
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value or "") - datetime.now(timezone.utc)).total_seconds()
        except Exception:
            seconds = 2 ** attempt
    return min(30.0, max(0.0, seconds)) if math.isfinite(seconds) else min(30.0, 2 ** attempt)


def _error_code(error: Exception) -> tuple[str, bool]:
    if isinstance(error, TeacherOutputError):
        return error.code, True
    for cls, code in ((httpx.ConnectTimeout, "CONNECT_TIMEOUT"), (httpx.ReadTimeout, "READ_TIMEOUT"),
                      (httpx.WriteTimeout, "WRITE_TIMEOUT"), (httpx.PoolTimeout, "POOL_TIMEOUT"),
                      (httpx.ConnectError, "CONNECTION_FAILED"), (httpx.ReadError, "READ_FAILED"),
                      (httpx.RemoteProtocolError, "PROTOCOL_FAILED"), (httpx.RequestError, "TRANSPORT_FAILED")):
        if isinstance(error, cls):
            return code, True
    return "CLIENT_ERROR", False


async def _request_json(endpoint: str, headers: Mapping[str, str], body: Mapping[str, Any], *,
                        policy: TransportPolicy, validator: Callable[[dict[str, Any]], Any] | None,
                        http_transport: httpx.AsyncBaseTransport | None, diagnose_errors: bool) -> TransportResult:
    result = TransportResult()
    started = time.perf_counter()
    deadline = started + policy.total_seconds
    context = _ACTIVE.set(True)
    try:
        async with httpx.AsyncClient(transport=http_transport, follow_redirects=False, trust_env=False) as client:
            for attempt in range(policy.max_attempts):
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    result.error_code = "TOTAL_TIMEOUT"
                    break
                record: dict[str, Any] = {"http_status": None, "error_code": None, "latency_ms": 0.0, "usage": None}
                result.attempts.append(record)
                attempt_started = time.perf_counter()
                retryable = False
                delay = min(30.0, 2 ** attempt)
                try:
                    timeout = httpx.Timeout(connect=min(policy.connect_seconds, remaining),
                                            read=min(policy.read_seconds, remaining),
                                            write=min(policy.write_seconds, remaining),
                                            pool=min(policy.pool_seconds, remaining))
                    async with asyncio.timeout(remaining):
                        async with client.stream("POST", endpoint, headers=dict(headers), json=dict(body), timeout=timeout) as response:
                            record["http_status"] = response.status_code
                            if not 200 <= response.status_code < 300:
                                result.error_code = f"HTTP_{response.status_code}"
                                retryable = response.status_code in {408, 429} or response.status_code >= 500
                                delay = _retry_after(response.headers.get("Retry-After"), attempt)
                                if diagnose_errors:
                                    try:
                                        chunks, size = [], 0
                                        async for chunk in response.aiter_bytes():
                                            size += len(chunk)
                                            if size > min(16_384, policy.max_response_bytes):
                                                chunks = []
                                                break
                                            chunks.append(chunk)
                                        diagnostic = safe_provider_error(json.loads(b"".join(chunks)))
                                    except Exception:
                                        diagnostic = None
                                    record["provider_error"] = diagnostic
                            else:
                                chunks, size = [], 0
                                async for chunk in response.aiter_bytes():
                                    size += len(chunk)
                                    if size > policy.max_response_bytes:
                                        raise TeacherOutputError("JSON_RESPONSE_INVALID")
                                    chunks.append(chunk)
                                try:
                                    payload = json.loads(b"".join(chunks))
                                except Exception:
                                    raise TeacherOutputError("JSON_RESPONSE_INVALID") from None
                                if not isinstance(payload, dict):
                                    raise TeacherOutputError("JSON_RESPONSE_INVALID")
                                record["usage"] = safe_usage(payload.get("usage"))
                                value = validator(payload) if validator else payload
                                result.payload, result.value, result.error_code = payload, value, None
                except TimeoutError:
                    result.error_code = "TOTAL_TIMEOUT"
                except Exception as error:
                    result.error_code, retryable = _error_code(error)
                finally:
                    record["latency_ms"] = round((time.perf_counter() - attempt_started) * 1000, 3)
                    record["error_code"] = result.error_code
                if result.error_code is None or not retryable or attempt + 1 >= policy.max_attempts:
                    break
                remaining = deadline - time.perf_counter()
                if remaining <= delay:
                    result.error_code = "TOTAL_TIMEOUT"
                    break
                await asyncio.sleep(delay)
    except Exception:
        result.error_code = result.error_code or "CLIENT_ERROR"
    finally:
        _ACTIVE.reset(context)
        result.elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    return result


def request_json(endpoint: str, headers: Mapping[str, str], body: Mapping[str, Any], *,
                 policy: TransportPolicy | None = None, validator: Callable[[dict[str, Any]], Any] | None = None,
                 http_transport: httpx.AsyncBaseTransport | None = None, diagnose_errors: bool = False) -> TransportResult:
    try:
        _validated_endpoint(endpoint)
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            return TransportResult(error_code="CLIENT_ERROR")
        return asyncio.run(_request_json(endpoint, headers, body, policy=policy or TransportPolicy(),
                                         validator=validator, http_transport=http_transport, diagnose_errors=diagnose_errors))
    except TeacherConfigurationError:
        return TransportResult(error_code="ENDPOINT_CONFIG_INVALID")
    except Exception:
        return TransportResult(error_code="CLIENT_ERROR")
