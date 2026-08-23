"""
Aegis Enclave — SLM allocation layer.

Calls a local Ollama instance (qwen2.5:3b, baked into the image at build time
so the weights are covered by the TEE measurement) to turn deterministic signal
output into a portfolio allocation.

The model sees the signal layer's output, never raw prices. That keeps the
prompt small and stable, and it means the non-deterministic component operates
on an already-audited summary rather than on unbounded market data.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping

import ollama

_MODEL = os.environ.get("AEGIS_SLM_MODEL", "qwen2.5:3b")
_MAX_RETRIES = int(os.environ.get("AEGIS_SLM_MAX_RETRIES", "3"))
_OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
_TEMPERATURE = float(os.environ.get("AEGIS_SLM_TEMPERATURE", "0.2"))

# Allocations are normalised when they sum to within this of 1.0; beyond it the
# response is rejected as a schema violation rather than silently rescaled.
_SUM_TOLERANCE = 0.05

# Specified exactly by the Aegis design. Do not reword: the TEE measurement
# covers this file, so any edit changes the enclave identity and invalidates the
# deployed on-chain measurement until it is rotated.
SYSTEM_PROMPT = (
    "You are a quantitative portfolio rebalancing engine. You will receive JSON "
    "market data for a fixed set of whitelisted assets. Respond ONLY with valid "
    "JSON matching this schema: "
    '{ "allocations": { "<asset_symbol>": <float 0-1, sums to 1.0> }, '
    '"rationale": "<one sentence>", "confidence": <float 0-1> } '
    "Do not include any text outside the JSON object."
)

_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "allocations": {"type": "object", "additionalProperties": {"type": "number"}},
        "rationale": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["allocations", "rationale", "confidence"],
}


class SLMError(ValueError):
    """Raised when the model cannot produce a schema-valid allocation."""


def validate_allocation(
    result: Mapping[str, Any],
    expected_symbols: list[str],
) -> tuple[bool, str]:
    """
    Check an SLM response against the allocation schema.

    Returns (ok, reason). The reason is fed back to the model on retry, which
    turns a blind resample into a corrective one.
    """
    for key in ("allocations", "rationale", "confidence"):
        if key not in result:
            return False, "Missing required key: " + key

    allocations = result["allocations"]
    if not isinstance(allocations, dict):
        return False, "allocations must be an object"

    for symbol in expected_symbols:
        if symbol not in allocations:
            return False, "Missing allocation for symbol: " + symbol

    # An allocation to something outside the whitelist is a hard failure, not a
    # rounding issue: the vault can only ever hold whitelisted assets, so acting
    # on it would be impossible and dropping it would silently change the split.
    unexpected = [s for s in allocations if s not in expected_symbols]
    if unexpected:
        return False, "Allocation names non-whitelisted assets: " + ", ".join(sorted(unexpected))

    for symbol, value in allocations.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False, "Allocation for " + symbol + " is not a number: " + repr(value)
        if value < 0.0 or value > 1.0:
            return False, "Allocation for " + symbol + " out of range [0,1]: " + repr(value)

    total = sum(float(v) for v in allocations.values())
    if abs(total - 1.0) > _SUM_TOLERANCE:
        return False, "Allocations sum to " + repr(round(total, 6)) + ", expected ~1.0"

    confidence = result["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return False, "confidence is not a number: " + repr(confidence)
    if confidence < 0.0 or confidence > 1.0:
        return False, "confidence out of range [0,1]: " + repr(confidence)

    rationale = result["rationale"]
    if not isinstance(rationale, str) or not rationale.strip():
        return False, "rationale must be a non-empty string"

    return True, "valid"


def normalise_allocations(result: Mapping[str, Any]) -> dict[str, Any]:
    """
    Rescale allocations to sum to exactly 1.0.

    Only ever called on a response that already validated, so the sum is already
    within _SUM_TOLERANCE of 1.0. This exists so the decision hash covers an
    exact split rather than one carrying the model's rounding, which keeps the
    attested decision reproducible.
    """
    allocations = result["allocations"]
    total = sum(float(v) for v in allocations.values())
    if total <= 0:
        raise SLMError("allocations sum to zero after validation, which is impossible")

    normalised = dict(result)
    normalised["allocations"] = {
        symbol: round(float(value) / total, 6) for symbol, value in allocations.items()
    }
    normalised["confidence"] = round(float(result["confidence"]), 6)
    return normalised


def _chat(messages: list[dict[str, str]]) -> str:
    """
    One round-trip to the local Ollama server.

    Isolated into its own function so tests can replace the transport without
    reaching into the ollama package internals, and so the retry loop has
    exactly one failure point to reason about.
    """
    client = ollama.Client(host=_OLLAMA_HOST)
    response = client.chat(
        model=_MODEL,
        messages=messages,
        format=_OUTPUT_SCHEMA,
        options={"temperature": _TEMPERATURE},
    )
    return response["message"]["content"].strip()


def _build_user_message(
    signals: Mapping[str, Mapping[str, Any]],
    expected_symbols: list[str],
) -> str:
    """
    The signal payload, plus the budget constraint stated so the model can act on it.

    The asset names and the sum rule are here rather than only in the system
    prompt because the system prompt alone was not enough: shown five assets,
    the model would name four, or return values that did not form a
    distribution.

    WHAT IS DELIBERATELY ABSENT: an example of what equal weights would be.
    An earlier version ended with "if you weight them equally, each must be 0.2,
    because 5 x 0.2 = 1.0". It fixed the arithmetic and destroyed the decision.
    Measured over three trials per case, WETH allocation against strongly
    bullish and strongly bearish signals:

        with the equal-weight example    bull 0.20   bear 0.20   (no response)
        constraint stated alone          bull 0.51   bear 0.20   (responds)

    Every run was schema-valid either way, so validation could not have caught
    it -- the model was quietly copying the worked example instead of reading
    the signals, and the rationale then asserted that all assets were neutral
    when one had a z-score of 2.4. An arithmetic aid that doubles as an answer
    is not an aid.

    So this states the constraint and stops. The model chooses the weights.
    """
    count = len(expected_symbols)
    names = ", ".join(expected_symbols)

    lines = [
        json.dumps(signals, indent=2, default=str),
        "",
        f"Allocate across exactly these {count} assets: {names}.",
        f"Every value must be between 0 and 1, and the {count} values MUST sum "
        f"to exactly 1.0.",
    ]
    return "\n".join(lines)


def query_slm(signals: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """
    Ask the SLM for an allocation over the whitelisted assets.

    Retries up to _MAX_RETRIES times, appending the previous invalid output and
    the specific validation failure to the conversation each time, then raises.

    Raises:
        SLMError: if no schema-valid allocation was produced. The caller must
            surface this rather than substituting a default allocation — an
            attested decision the model never made would defeat the entire point
            of the attestation chain.
    """
    if not signals:
        raise SLMError("no signals supplied; refusing to request an allocation")

    expected_symbols = list(signals.keys())
    messages: list[dict[str, str]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": _build_user_message(signals, expected_symbols)},
    ]

    last_error = "no attempts were made"

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            raw_content = _chat(messages)
        except Exception as exc:  # transport error, model missing, server down
            last_error = "attempt " + str(attempt) + ": Ollama call failed: " + str(exc)
            print("[model] " + last_error)
            continue

        try:
            result = json.loads(raw_content)
        except json.JSONDecodeError as exc:
            last_error = "attempt " + str(attempt) + ": response was not JSON: " + str(exc)
            print("[model] " + last_error)
            messages.append({"role": "assistant", "content": raw_content})
            messages.append(
                {
                    "role": "user",
                    "content": "That was not valid JSON. Respond with the JSON object only.",
                }
            )
            continue

        valid, reason = validate_allocation(result, expected_symbols)
        if valid:
            return normalise_allocations(result)

        last_error = "attempt " + str(attempt) + ": schema validation failed: " + reason
        print("[model] " + last_error)
        messages.append({"role": "assistant", "content": raw_content})
        messages.append(
            {
                "role": "user",
                "content": (
                    "That response was rejected: " + reason + ". Return corrected JSON "
                    "for exactly these assets: " + ", ".join(expected_symbols) + "."
                ),
            }
        )

    raise SLMError(
        "SLM produced no valid allocation in "
        + str(_MAX_RETRIES)
        + " attempts. Last error: "
        + last_error
    )
