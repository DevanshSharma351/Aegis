"""
Aegis Enclave — SLM Allocation Layer

Calls a local Ollama instance running llama3.2:1b to produce portfolio
allocation decisions based on the deterministic signal layer's output.

The SLM receives structured signal data (not raw prices) and must return
a strict JSON schema. Includes retry logic for malformed output (max 3).
"""

import json
import os
from typing import Any

import ollama

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_MODEL = "llama3.2:1b"
_MAX_RETRIES = 3
_OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

# The system prompt is specified exactly by the Aegis spec — do not deviate.
SYSTEM_PROMPT = (
    "You are a quantitative portfolio rebalancing engine. You will receive JSON "
    "market data for a fixed set of whitelisted assets. Respond ONLY with valid "
    "JSON matching this schema: "
    '{ "allocations": { "<asset_symbol>": <float 0-1, sums to 1.0> }, '
    '"rationale": "<one sentence>", "confidence": <float 0-1> } '
    "Do not include any text outside the JSON object."
)

# JSON schema for structured output enforcement via Ollama's format parameter.
_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "allocations": {
            "type": "object",
            "additionalProperties": {"type": "number"},
        },
        "rationale": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["allocations", "rationale", "confidence"],
}


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

def validate_allocation(
    result: dict[str, Any],
    expected_symbols: list[str],
) -> tuple[bool, str]:
    """
    Validate that the SLM output conforms to the expected schema.

    Checks:
    - Required keys exist (allocations, rationale, confidence)
    - All expected asset symbols are present in allocations
    - Allocation values are floats in [0, 1]
    - Allocations sum to ~1.0 (tolerance: 0.05)
    - Confidence is a float in [0, 1]
    - Rationale is a non-empty string
    """
    # Check required keys
    for key in ("allocations", "rationale", "confidence"):
        if key not in result:
            return False, f"Missing required key: {key}"

    allocations = result["allocations"]
    if not isinstance(allocations, dict):
        return False, "allocations must be a dict"

    # Check all expected symbols are present
    for sym in expected_symbols:
        if sym not in allocations:
            return False, f"Missing allocation for symbol: {sym}"

    # Check allocation values
    for sym, val in allocations.items():
        if not isinstance(val, (int, float)):
            return False, f"Allocation for {sym} is not a number: {val}"
        if val < 0.0 or val > 1.0:
            return False, f"Allocation for {sym} out of range [0,1]: {val}"

    # Check sum ≈ 1.0
    total = sum(allocations.values())
    if abs(total - 1.0) > 0.05:
        return False, f"Allocations sum to {total}, expected ~1.0"

    # Check confidence
    confidence = result["confidence"]
    if not isinstance(confidence, (int, float)):
        return False, f"confidence is not a number: {confidence}"
    if confidence < 0.0 or confidence > 1.0:
        return False, f"confidence out of range [0,1]: {confidence}"

    # Check rationale
    rationale = result["rationale"]
    if not isinstance(rationale, str) or len(rationale.strip()) == 0:
        return False, "rationale must be a non-empty string"

    return True, "valid"


# ---------------------------------------------------------------------------
# SLM inference
# ---------------------------------------------------------------------------

def query_slm(
    signals: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """
    Send deterministic signal data to the local Ollama SLM and parse the response.

    The SLM receives the signal.py output as structured JSON input, NOT raw prices.
    Retries up to 3 times on malformed output, then raises.

    Args:
        signals: Dict mapping symbol → signal summary (from signal.compute_all_signals).

    Returns:
        Validated allocation dict: { allocations, rationale, confidence }

    Raises:
        ValueError: If all retries are exhausted without valid output.
    """
    expected_symbols = list(signals.keys())
    user_message = json.dumps(signals, indent=2, default=str)

    last_error = ""
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            client = ollama.Client(host=_OLLAMA_HOST)
            response = client.chat(
                model=_MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                format=_OUTPUT_SCHEMA,
                options={"temperature": 0.2},
            )

            raw_content = response.message.content.strip()

            # Parse JSON
            result = json.loads(raw_content)

            # Validate schema
            valid, reason = validate_allocation(result, expected_symbols)
            if valid:
                return result
            else:
                last_error = f"Attempt {attempt}: schema validation failed — {reason}"
                print(f"[model] WARNING: {last_error}")

        except json.JSONDecodeError as exc:
            last_error = f"Attempt {attempt}: JSON parse error — {exc}"
            print(f"[model] WARNING: {last_error}")
        except Exception as exc:
            import traceback
            traceback.print_exc()
            last_error = f"Attempt {attempt}: Ollama error — {exc}"
            print(f"[model] WARNING: {last_error}")

    raise ValueError(
        f"SLM failed to produce valid output after {_MAX_RETRIES} retries. "
        f"Last error: {last_error}"
    )
