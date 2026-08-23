"""
Aegis pipeline orchestrator.

Runs the same sequence as scripts/run_full_pipeline.sh, in-process, so a browser
can drive it. The bash script remains the CLI entry point; this is the same
steps in the same order, reachable over HTTP.

WHY THIS LIVES IN THE ENCLAVE

The enclave is the only service published to the host, and it already sits on
both the internal and egress networks. Orchestrating from here grants it no new
authority: it still cannot sign a UserOperation (the identity service holds the
session key) and cannot move shielded funds (the sidecar holds the mnemonic). It
sequences calls to components that each retain their own secrets and their own
refusals.

NO DUPLICATED LOGIC

Stages 1-3 call the very functions `/rebalance` calls -- `fetch_all_assets`,
`compute_all_signals`, `query_slm`, `attest_decision` -- rather than issuing an
HTTP request to this same process. That is what makes per-stage progress real:
each stage advances only when the underlying call returns, and the code path is
identical to the one the CLI exercises.

NO FABRICATED PROGRESS

A stage moves to `running` when its work starts and to `succeeded` only when the
real call returns a real result. There are no timers. A failure stops the
pipeline: later stages stay `pending` and are never reported as succeeded.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from attestation import attest_decision, get_enclave_identity
from quant.data_feed import DataFeedError, fetch_all_assets
from quant.model import SLMError, query_slm
from quant.signal import compute_all_signals

ORACLE_URL = os.environ.get("AEGIS_ORACLE_URL", "http://oracle:8100")
IDENTITY_URL = os.environ.get("AEGIS_IDENTITY_URL", "http://identity:8200")
RAILGUN_SIDECAR_URL = os.environ.get("RAILGUN_SIDECAR_URL", "http://railgun-sidecar:8080")
DEPLOYED_PATH = os.environ.get("AEGIS_DEPLOYED_PATH", "/app/shared/config/deployed.json")


# ---------------------------------------------------------------------------
# Stage model
# ---------------------------------------------------------------------------

STAGES = [
    ("market-analysis", "Market Analysis"),
    ("ai-decision", "AI Decision"),
    ("tdx-attestation", "TDX Attestation"),
    ("oracle-verification", "Oracle Verification"),
    ("erc4337-execution", "ERC-4337 Execution"),
    ("poi", "Proof of Innocence"),
    ("private-swap", "Private Swap"),
    ("reshield", "Reshield"),
    ("confirmed", "Confirmed"),
]


@dataclass
class Stage:
    key: str
    label: str
    status: str = "pending"  # pending | running | succeeded | failed | skipped
    detail: str = ""
    started_at: Optional[float] = None
    ended_at: Optional[float] = None
    data: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "status": self.status,
            "detail": self.detail,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "durationMs": (
                int((self.ended_at - self.started_at) * 1000)
                if self.started_at and self.ended_at
                else None
            ),
            "data": self.data,
        }


@dataclass
class PipelineJob:
    job_id: str
    stages: list[Stage]
    status: str = "running"  # running | succeeded | failed
    error: Optional[str] = None
    failed_stage: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    result: dict[str, Any] = field(default_factory=dict)

    def stage(self, key: str) -> Stage:
        for s in self.stages:
            if s.key == key:
                return s
        raise KeyError(key)

    def as_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "status": self.status,
            "error": self.error,
            "failedStage": self.failed_stage,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "stages": [s.as_dict() for s in self.stages],
            "result": self.result,
        }


# In-memory job registry. Adequate here because a job is meaningful only while
# the operator is watching it, and every durable artefact it produces (the
# on-chain event, the Railgun transaction) is recoverable from the chain.
_JOBS: dict[str, PipelineJob] = {}
_JOB_LIMIT = 20

# One pipeline at a time. The session key is rate-limited to one execution per
# day on-chain, so a second concurrent run would burn gas only to be rejected by
# the permission validator.
_RUN_LOCK = asyncio.Lock()


def get_job(job_id: str) -> Optional[PipelineJob]:
    return _JOBS.get(job_id)


def _register(job: PipelineJob) -> None:
    _JOBS[job.job_id] = job
    if len(_JOBS) > _JOB_LIMIT:
        oldest = sorted(_JOBS.values(), key=lambda j: j.started_at)[0]
        _JOBS.pop(oldest.job_id, None)


class StageFailure(Exception):
    """Raised to stop the pipeline at a named stage."""

    def __init__(self, stage_key: str, message: str) -> None:
        super().__init__(message)
        self.stage_key = stage_key
        self.message = message


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def _load_deployed() -> dict[str, Any]:
    with open(DEPLOYED_PATH, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


async def _post(client: httpx.AsyncClient, url: str, payload: dict, stage_key: str, what: str):
    try:
        response = await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        raise StageFailure(stage_key, f"{what} unreachable: {exc}")

    if response.status_code != 200:
        try:
            body = response.json()
            detail = body.get("detail") or body.get("error") or json.dumps(body)[:400]
        except Exception:
            detail = response.text[:400]
        raise StageFailure(stage_key, f"{what} failed (HTTP {response.status_code}): {detail}")

    return response.json()



# ---------------------------------------------------------------------------
# Turning an allocation into a trade
# ---------------------------------------------------------------------------

class NothingToRebalance(Exception):
    """The portfolio already matches the target closely enough to leave alone."""


# Below this the trade is not worth a Groth16 proof and two Railgun fees. A
# rebalance that costs more than the drift it corrects is not a rebalance.
MIN_REBALANCE_WEIGHT_DELTA = 0.02

# The asset every trade must have on one side.
#
# The swap recipe is single-hop, so a planned pair needs a direct Uniswap V3
# pool. Probing the Sepolia factory: WETH pairs with all four whitelisted assets
# at every fee tier, while non-WETH pairs are incomplete -- USDC/DAI does not
# exist. Constraining trades to the hub keeps every plan executable.
HUB_SYMBOL = "WETH"


class RebalancePlan:
    """One corrective trade, derived from the attested allocation."""

    def __init__(
        self,
        sell_symbol: str,
        buy_symbol: str,
        sell_amount: int,
        weights: dict[str, float],
        target: dict[str, float],
        portfolio_value_usd: float,
        trade_value_usd: float,
        routed_via_hub: bool = False,
    ) -> None:
        self.sell_symbol = sell_symbol
        self.buy_symbol = buy_symbol
        self.sell_amount = sell_amount
        self.weights = weights
        self.target = target
        self.portfolio_value_usd = portfolio_value_usd
        self.trade_value_usd = trade_value_usd
        self.routed_via_hub = routed_via_hub

    def as_data(self) -> dict[str, Any]:
        return {
            "sellSymbol": self.sell_symbol,
            "buySymbol": self.buy_symbol,
            "sellAmount": str(self.sell_amount),
            "currentWeights": {k: round(v, 4) for k, v in self.weights.items()},
            "targetWeights": {k: round(v, 4) for k, v in self.target.items()},
            "portfolioValueUsd": round(self.portfolio_value_usd, 2),
            "tradeValueUsd": round(self.trade_value_usd, 2),
            # True when the ideal counterparty had no pool and this leg sells
            # into the hub instead, leaving the next run to finish the move.
            "routedViaHub": self.routed_via_hub,
        }


def plan_rebalance(
    allocations: Mapping[str, float],
    balances: list[Mapping[str, Any]],
    signals: Mapping[str, Mapping[str, Any]],
    max_sell_amount: int | None = None,
) -> RebalancePlan:
    """
    Decide which single trade moves the portfolio closest to the attested target.

    WHY A SINGLE TRADE. Reaching the target exactly takes one swap per
    over-weight asset, and each needs its own Groth16 proof plus the engine's
    30-60s post-spend sync, so a full rebalance runs into minutes and a failure
    halfway leaves the portfolio in a state nobody chose. Closing the largest
    gap captures most of the correction for one proof, and the next run picks up
    where this one stopped -- which is how a periodic rebalancer is supposed to
    behave anyway.

    WHY IT USES THE SIGNAL PRICES. The same numbers the model saw. Pricing the
    portfolio from a second source would mean the trade was computed against
    figures the attested decision never referenced.

    Raises:
        NothingToRebalance: drift is under MIN_REBALANCE_WEIGHT_DELTA, or there
            is nothing spendable to sell. Both are legitimate outcomes and the
            caller should skip the swap rather than force one.
    """
    prices: dict[str, float] = {}
    for symbol, signal in signals.items():
        close = signal.get("close")
        if close is None or float(close) <= 0:
            raise StageFailure(
                "private-swap",
                f"No usable price for {symbol} in the signal output, so the portfolio "
                f"cannot be valued and no trade can be derived from the allocation.",
            )
        prices[symbol] = float(close)

    by_symbol = {b["symbol"]: b for b in balances}

    # Value every position with the prices the decision was made against.
    values: dict[str, float] = {}
    for symbol in allocations:
        held = by_symbol.get(symbol)
        if held is None:
            values[symbol] = 0.0
            continue
        units = int(held["balance"]) / (10 ** int(held["decimals"]))
        values[symbol] = units * prices.get(symbol, 0.0)

    portfolio = sum(values.values())
    if portfolio <= 0:
        raise NothingToRebalance("the shielded portfolio is empty, so there is nothing to rebalance")

    weights = {s: v / portfolio for s, v in values.items()}

    # Positive delta means under-weight and wanting to be bought.
    deltas = {s: allocations[s] - weights[s] for s in allocations}

    # Only sell what is actually spendable: a note awaiting POI validation is
    # part of the portfolio's value but cannot be moved yet, so treating it as
    # sellable would plan a trade that fails at proof time.
    def spendable_units(symbol: str) -> float:
        held = by_symbol.get(symbol)
        if held is None:
            return 0.0
        return int(held["spendable"]) / (10 ** int(held["decimals"]))

    sellable = [s for s in allocations if deltas[s] < 0 and spendable_units(s) > 0]
    buyable = [s for s in allocations if deltas[s] > 0]

    if not sellable or not buyable:
        raise NothingToRebalance(
            "no over-weight asset has a POI-validated balance to sell, so no corrective "
            "trade can be made yet"
        )

    sell_symbol = min(sellable, key=lambda s: deltas[s])
    buy_symbol = max(buyable, key=lambda s: deltas[s])

    gap = min(-deltas[sell_symbol], deltas[buy_symbol])
    if gap < MIN_REBALANCE_WEIGHT_DELTA:
        raise NothingToRebalance(
            f"portfolio is within {MIN_REBALANCE_WEIGHT_DELTA:.0%} of the target "
            f"(largest correctable gap {gap:.2%}), so no trade is worth its fees"
        )

    # Route through the hub when the ideal pair has no pool.
    #
    # The recipe performs a single-hop swap, so the pair it is given must have a
    # direct Uniswap V3 pool. On Sepolia only WETH is a complete hub -- every
    # whitelisted asset has a WETH pool at all four fee tiers -- while the
    # non-WETH pairs are patchy and USDC/DAI has no pool at all. A run that
    # planned USDC -> DAI reached the swap stage and failed there, after
    # spending a UserOperation and a rate-limit slot.
    #
    # Selling into WETH instead still closes the sell side of the gap, and the
    # next run moves that WETH into whatever remains under-weight. Two runs
    # rather than one, which is how a periodic rebalancer is meant to converge
    # anyway, and every trade it plans is guaranteed executable.
    routed_via_hub = False
    if sell_symbol != HUB_SYMBOL and buy_symbol != HUB_SYMBOL:
        buy_symbol = HUB_SYMBOL
        routed_via_hub = True

    trade_value = gap * portfolio
    sell_price = prices[sell_symbol]
    sell_decimals = int(by_symbol[sell_symbol]["decimals"])

    sell_amount = int((trade_value / sell_price) * (10 ** sell_decimals))
    sell_amount = min(sell_amount, int(by_symbol[sell_symbol]["spendable"]))
    if max_sell_amount is not None:
        sell_amount = min(sell_amount, max_sell_amount)

    if sell_amount <= 0:
        raise NothingToRebalance(
            f"the corrective {sell_symbol} trade rounds to zero at the current price"
        )

    return RebalancePlan(
        sell_symbol=sell_symbol,
        buy_symbol=buy_symbol,
        sell_amount=sell_amount,
        weights=weights,
        target=dict(allocations),
        portfolio_value_usd=portfolio,
        trade_value_usd=trade_value,
        routed_via_hub=routed_via_hub,
    )

async def _assert_swap_gas_affordable() -> None:
    """Fail the run up front if the submitter cannot fund a RelayAdapt call.

    A preflight that cannot be reached must not silently pass — an unreachable
    sidecar is itself a reason to stop, and pretending otherwise would restore
    exactly the expensive failure this check exists to prevent.
    """
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            response = await client.get(RAILGUN_SIDECAR_URL + "/gas-preflight")
        except httpx.HTTPError as exc:
            raise StageFailure("private-swap", f"Gas preflight unreachable: {exc}")

        if response.status_code != 200:
            raise StageFailure(
                "private-swap",
                f"Gas preflight failed (HTTP {response.status_code}): {response.text[:300]}",
            )

        check = response.json()

    if check["sufficient"]:
        return

    def eth(wei: str) -> str:
        return f"{int(wei) / 1e18:.6f}"

    raise StageFailure(
        "private-swap",
        f"Submitter {check['submitterAddress']} cannot fund the private swap: holds "
        f"{eth(check['balanceWei'])} ETH, needs {eth(check['requiredReserveWei'])} ETH "
        f"({int(check['gasLimit']):,} gas x {int(check['maxFeePerGasWei']) / 1e9:.3f} gwei "
        f"= {eth(check['reserveAtCurrentFeeWei'])} ETH reserved up front by EIP-1559, plus "
        f"{check['headroomPercent']}% headroom for base-fee drift during the run). "
        f"Short by {eth(check['shortfallWei'])} ETH. "
        f"Nothing was executed - fund the submitter and re-run."
    )


async def _assert_poi_spendable() -> None:
    """Fail up front if nothing in the pool can be spent yet.

    Same reasoning as the gas preflight: this is knowable before anything is
    spent, and the stages in between cost a UserOperation and one of the session
    key's rate-limited daily slots. A freshly reshielded note is routinely
    unspendable for a few minutes while the aggregator validates it, so this is
    the common case rather than an edge one.

    DELIBERATELY DIRECTION-AGNOSTIC. This runs before the decision exists, so it
    cannot know which asset will be sold -- that comes from the allocation, and
    the allocation has not been made yet. It previously demanded a fixed amount
    of WETH, which was only meaningful while the trade was hardcoded to
    WETH->USDC; once the direction follows the decision, a WETH check would
    refuse runs that were going to sell something else entirely.

    So it asserts the weaker, still-useful precondition: the aggregator is
    configured and *something* is spendable. The `poi` stage re-checks the
    specific asset once the plan names it.
    """
    async with httpx.AsyncClient(timeout=300) as client:
        try:
            health = (await client.get(RAILGUN_SIDECAR_URL + "/health")).json()
            balances = (await client.get(RAILGUN_SIDECAR_URL + "/balances")).json()
        except httpx.HTTPError as exc:
            raise StageFailure("poi", f"POI preflight unreachable: {exc}")

    poi = health.get("poi", {})
    if poi.get("mode") != "real":
        raise StageFailure(
            "poi",
            f"POI is '{poi.get('mode')}' - {poi.get('note', 'no aggregator configured')}. "
            f"Nothing was executed.",
        )

    held = balances.get("balances", [])
    if any(int(b["spendable"]) > 0 for b in held):
        return

    shielded = sum(int(b["balance"]) for b in held)
    raise StageFailure(
        "poi",
        "No POI-validated balance to trade with: every shielded asset has zero "
        "spendable. "
        + (
            "The balance exists but the aggregator has not validated it yet, which "
            "takes a few minutes after a shield or a reshield - retry shortly."
            if shielded > 0
            else "The shielded pool is empty; deposit first."
        )
        + " Nothing was executed.",
    )


async def run_pipeline(
    job: PipelineJob,
    sell_amount: str,
    slippage_bps: int,
    skip_swap: bool,
) -> None:
    """Execute the full sequence, recording real state at each step."""

    def begin(key: str, detail: str = "") -> Stage:
        s = job.stage(key)
        s.status = "running"
        s.detail = detail
        s.started_at = time.time()
        return s

    def finish(key: str, detail: str = "", **data: Any) -> None:
        s = job.stage(key)
        s.status = "succeeded"
        s.detail = detail
        s.ended_at = time.time()
        s.data.update(data)

    try:
        deployed = _load_deployed()
        verifier = deployed["AttestationVerifier"]
        chain_id = int(deployed.get("chainId", 11155111))
        expected_measurement = deployed.get("expectedMeasurement", "")

        # ---------------------------------------------------------------
        # 0. Gas preflight (read-only, spends nothing)
        # ---------------------------------------------------------------
        # The private swap is the last thing a run pays for but the first thing
        # that can make it unaffordable: EIP-1559 makes the submitter hold
        # `gasLimit * maxFeePerGas` up front, and Railgun's cross-contract gas
        # limit is large.
        #
        # Checking it here rather than at stage 7 matters because everything in
        # between is expensive and non-refundable: the ERC-4337 stage spends a
        # UserOperation and burns one of the session key's rate-limited daily
        # slots, and the swap stage spends minutes building a Groth16 proof.
        # Failing after all that — on a condition knowable up front — wastes
        # funds that, on a testnet, only a faucet can replace.
        #
        # This is a precondition of `private-swap`, so that is the stage named.
        # Every stage stays `pending`: nothing ran, so nothing may claim to have
        # succeeded.
        if not skip_swap:
            await _assert_swap_gas_affordable()
            await _assert_poi_spendable()

        # ---------------------------------------------------------------
        # 1. Market analysis
        # ---------------------------------------------------------------
        begin("market-analysis", "Fetching OHLC data for the whitelisted assets")
        try:
            ohlc = await asyncio.to_thread(fetch_all_assets, 7)
            signals = await asyncio.to_thread(compute_all_signals, ohlc)
        except DataFeedError as exc:
            raise StageFailure("market-analysis", f"Market data unavailable: {exc}")
        except Exception as exc:
            raise StageFailure("market-analysis", f"Signal computation failed: {exc}")

        finish(
            "market-analysis",
            f"Computed signals for {', '.join(signals)}",
            signals=signals,
        )

        # ---------------------------------------------------------------
        # 2. SLM decision
        # ---------------------------------------------------------------
        begin("ai-decision", "Querying the in-enclave SLM over the signal output")
        try:
            decision = await asyncio.to_thread(query_slm, signals)
        except SLMError as exc:
            raise StageFailure("ai-decision", f"SLM produced no valid allocation: {exc}")

        finish(
            "ai-decision",
            decision["rationale"],
            allocations=decision["allocations"],
            rationale=decision["rationale"],
            confidence=decision["confidence"],
        )

        # ---------------------------------------------------------------
        # 3. TDX attestation
        # ---------------------------------------------------------------
        begin("tdx-attestation", "Binding the decision hash into a TDX quote")
        try:
            attestation = await asyncio.to_thread(attest_decision, decision)
        except Exception as exc:
            raise StageFailure("tdx-attestation", f"Attestation failed: {exc}")

        measurement = attestation["measurement"]
        if expected_measurement and measurement.lower() != expected_measurement.lower():
            raise StageFailure(
                "tdx-attestation",
                "Enclave measurement does not match the on-chain constant. "
                f"enclave={measurement} chain={expected_measurement}. "
                "The image changed since deployment; rebuild or rotate the constant.",
            )

        finish(
            "tdx-attestation",
            f"Quote bound to decision hash, source={attestation['source']}",
            decisionHash=attestation["decision_hash"],
            measurement=measurement,
            source=attestation["source"],
            quoteBytes=(len(attestation["quote"]) - 2) // 2,
        )

        async with httpx.AsyncClient(timeout=900) as client:
            # -----------------------------------------------------------
            # 4. Oracle verification
            # -----------------------------------------------------------
            begin("oracle-verification", "Verifying the quote off-chain and signing")
            oracle_response = await _post(
                client,
                ORACLE_URL + "/attest",
                {
                    "quote": attestation["quote"],
                    "decision_hash": attestation["decision_hash"],
                    "event_log": attestation["event_log"],
                    "source": attestation["source"],
                    "verifier_address": verifier,
                    "chain_id": chain_id,
                },
                "oracle-verification",
                "Oracle",
            )

            if oracle_response["measurement"].lower() != measurement.lower():
                raise StageFailure(
                    "oracle-verification",
                    "Oracle derived a different measurement from the quote than the enclave "
                    f"reported: {oracle_response['measurement']} vs {measurement}",
                )

            finish(
                "oracle-verification",
                f"{len(oracle_response['checksPerformed'])} checks passed",
                checksPerformed=oracle_response["checksPerformed"],
                oracleSigner=oracle_response["oracleSigner"],
                expiry=oracle_response["expiry"],
                hardwareVerified=oracle_response["hardwareVerified"],
            )

            # -----------------------------------------------------------
            # 5. ERC-4337 execution
            # -----------------------------------------------------------
            begin("erc4337-execution", "Submitting a UserOperation via the session key")
            submit_response = await _post(
                client,
                IDENTITY_URL + "/submit-rebalance",
                {
                    "decisionHash": attestation["decision_hash"],
                    "attestationProof": oracle_response["proof"],
                },
                "erc4337-execution",
                "Identity service",
            )

            finish(
                "erc4337-execution",
                f"RebalanceExecuted #{submit_response['sequence']} in block {submit_response['blockNumber']}",
                txHash=submit_response["txHash"],
                userOpHash=submit_response.get("userOpHash"),
                blockNumber=submit_response["blockNumber"],
                sequence=submit_response["sequence"],
                smartAccount=submit_response.get("smartAccount"),
                explorerUrl=submit_response["explorerUrl"],
            )

            if skip_swap:
                for key in ("poi", "private-swap", "reshield"):
                    s = job.stage(key)
                    s.status = "skipped"
                    s.detail = "Skipped by request"
                finish("confirmed", "Attestation recorded on-chain; swap skipped")
                job.status = "succeeded"
                job.ended_at = time.time()
                job.result = {"vault": submit_response, "swap": None}
                return

            # -----------------------------------------------------------
            # 6. Proof of Innocence gate
            # -----------------------------------------------------------
            # A real precondition check, not a label: the sidecar must have a POI
            # aggregator configured AND the balance must be POI-validated, or the
            # spend cannot produce a proof.
            begin("poi", "Checking POI configuration and spendable balance")

            health = (await client.get(RAILGUN_SIDECAR_URL + "/health")).json()
            poi = health.get("poi", {})
            if poi.get("mode") != "real":
                raise StageFailure(
                    "poi",
                    f"POI is '{poi.get('mode')}' — {poi.get('note', 'no aggregator configured')}",
                )

            balances = (await client.get(RAILGUN_SIDECAR_URL + "/balances")).json()

            # The trade comes from the attested allocation, not from the caller.
            # `sell_amount` is now only an upper bound, so a demo can cap size
            # without being able to choose the direction -- that is the decision's
            # to make, and it is the decision that was signed and recorded.
            try:
                plan = plan_rebalance(
                    decision["allocations"],
                    balances["balances"],
                    signals,
                    max_sell_amount=int(sell_amount) if sell_amount else None,
                )
            except NothingToRebalance as exc:
                for key in ("private-swap", "reshield"):
                    stage = job.stage(key)
                    stage.status = "skipped"
                    stage.detail = f"No trade needed: {exc}"

                finish(
                    "poi",
                    f"Validated against {', '.join(poi.get('nodeUrls', []))}; no trade needed",
                    mode=poi.get("mode"),
                    nodeUrls=poi.get("nodeUrls", []),
                    requiredList=poi.get("requiredList"),
                )
                plan = None
            else:
                held = next(
                    (b for b in balances["balances"] if b["symbol"] == plan.sell_symbol), None
                )
                spendable = int(held["spendable"]) if held else 0
                if spendable < plan.sell_amount:
                    total = int(held["balance"]) if held else 0
                    raise StageFailure(
                        "poi",
                        f"Insufficient POI-validated {plan.sell_symbol}: need "
                        f"{plan.sell_amount}, spendable {spendable} (total shielded {total}). "
                        + (
                            "The balance exists but is not yet POI-validated; retry shortly."
                            if total >= plan.sell_amount
                            else "Shield more first."
                        ),
                    )

                finish(
                    "poi",
                    f"Validated against {', '.join(poi.get('nodeUrls', []))}",
                    mode=poi.get("mode"),
                    nodeUrls=poi.get("nodeUrls", []),
                    requiredList=poi.get("requiredList"),
                    spendable=str(spendable),
                    plan=plan.as_data(),
                )

            # -----------------------------------------------------------
            # 7. Private swap (atomic unshield -> swap -> reshield)
            # -----------------------------------------------------------
            # Bound before the branch: a run that needs no trade still reports
            # balances, and reading them from the pre-plan snapshot is correct
            # because nothing moved.
            after = balances

            if plan is None:
                swap = None
            else:
                begin(
                    "private-swap",
                    f"Closing the {plan.sell_symbol} -> {plan.buy_symbol} gap: Groth16 proof "
                    f"and RelayAdapt transaction",
                )
                swap = await _post(
                    client,
                    RAILGUN_SIDECAR_URL + "/unshield-swap-reshield",
                    {
                        "sellToken": plan.sell_symbol,
                        "buyToken": plan.buy_symbol,
                        "sellAmount": str(plan.sell_amount),
                        "slippageBps": slippage_bps,
                    },
                    "private-swap",
                    "Railgun sidecar",
                )

                finish(
                    "private-swap",
                    f"Swapped {swap['netSellAmount']} {plan.sell_symbol} for "
                    f"{swap['execution']['actualBuyAmount']} {plan.buy_symbol} "
                    f"({swap['execution']['versusQuoteBps']:+d} bps vs quote, "
                    f"{swap['execution']['otherSwapsOnPoolInBlock']} other swap(s) on this pool in block)",
                    txHash=swap["txHash"],
                    blockNumber=swap["blockNumber"],
                    gasUsed=swap["gasUsed"],
                    proofDurationMs=swap["proofDurationMs"],
                    feeTier=swap["feeTier"],
                    submission=swap["submission"],
                    execution=swap["execution"],
                    explorerUrl=swap["explorerUrl"],
                    plan=plan.as_data(),
                )

                # -------------------------------------------------------
                # 8. Reshield, confirmed by balance delta
                # -------------------------------------------------------
                # The reshield happens inside the same atomic transaction as
                # the swap, so it cannot fail independently. It is verified
                # rather than assumed: the bought asset's balance must actually
                # have increased.
                begin("reshield", "Confirming the proceeds returned to the shielded pool")

                bought_before = next(
                    (
                        int(b["balance"])
                        for b in balances["balances"]
                        if b["symbol"] == plan.buy_symbol
                    ),
                    0,
                )

                # Poll rather than reading once.
                #
                # The reshield lands in the same transaction as the swap, but
                # the engine has to scan the new commitment before the balance
                # reflects it. Reading immediately reported a completed reshield
                # as a failure -- a false negative that is worse than no check,
                # because it contradicts a transaction that actually succeeded.
                bought_after = bought_before
                after = balances
                deadline = time.time() + 90

                while time.time() < deadline:
                    after = (await client.get(RAILGUN_SIDECAR_URL + "/balances")).json()
                    bought_after = next(
                        (
                            int(b["balance"])
                            for b in after["balances"]
                            if b["symbol"] == plan.buy_symbol
                        ),
                        0,
                    )
                    if bought_after > bought_before:
                        break
                    await asyncio.sleep(5)

                gained = bought_after - bought_before

                if gained <= 0:
                    raise StageFailure(
                        "reshield",
                        f"Swap transaction {swap['txHash']} succeeded but the shielded "
                        f"{plan.buy_symbol} balance did not increase "
                        f"({bought_before} -> {bought_after}) within 90s. Either the proceeds "
                        "were not reshielded, or the engine has not finished scanning -- "
                        "check /railgun/balances before assuming the former.",
                    )

                if gained < int(swap["minimumBuyAmount"]):
                    raise StageFailure(
                        "reshield",
                        f"Reshielded {gained} {plan.buy_symbol}, below the "
                        f"{swap['minimumBuyAmount']} slippage floor.",
                    )

                finish(
                    "reshield",
                    f"Reshielded {gained} {plan.buy_symbol} into the 0zk wallet",
                    reshielded=str(gained),
                    balances=after["balances"],
                    railgunAddress=after.get("railgunAddress"),
                )

            # -----------------------------------------------------------
            # 9. Confirmed
            # -----------------------------------------------------------
            begin("confirmed", "Verifying final state")
            finish(
                "confirmed",
                f"Vault log #{submit_response['sequence']}"
                + (f" and Railgun tx {swap['txHash'][:14]}… confirmed" if swap else "; no trade needed"),
            )

            job.status = "succeeded"
            job.ended_at = time.time()
            job.result = {
                "decision": {
                    "allocations": decision["allocations"],
                    "rationale": decision["rationale"],
                    "confidence": decision["confidence"],
                    "decisionHash": attestation["decision_hash"],
                },
                "attestation": {
                    "measurement": measurement,
                    "source": attestation["source"],
                    "hardwareVerified": oracle_response["hardwareVerified"],
                    "checksPerformed": oracle_response["checksPerformed"],
                },
                "vault": submit_response,
                "swap": swap,
                # What the allocation implied, and which gap this run closed.
                # Present even when no trade was needed, because "already on
                # target" is a result rather than an absence of one.
                "rebalance": plan.as_data() if plan else None,
                "balances": after["balances"],
                "railgunAddress": after.get("railgunAddress"),
            }

    except StageFailure as failure:
        stage = job.stage(failure.stage_key)
        stage.status = "failed"
        stage.detail = failure.message
        stage.ended_at = time.time()
        job.status = "failed"
        job.error = failure.message
        job.failed_stage = failure.stage_key
        job.ended_at = time.time()
        # Later stages are deliberately left `pending`: a failed run must never
        # present downstream steps as having completed.

    except Exception as exc:  # noqa: BLE001 - last-resort guard
        traceback.print_exc()
        running = next((s for s in job.stages if s.status == "running"), None)
        if running:
            running.status = "failed"
            running.detail = str(exc)
            running.ended_at = time.time()
            job.failed_stage = running.key
        job.status = "failed"
        job.error = str(exc)
        job.ended_at = time.time()


async def start_pipeline(sell_amount: str, slippage_bps: int, skip_swap: bool) -> PipelineJob:
    """Create a job and run it in the background."""
    if _RUN_LOCK.locked():
        raise RuntimeError(
            "A pipeline run is already in progress. The session key permits one "
            "execution per day on-chain, so concurrent runs would be rejected."
        )

    job = PipelineJob(
        job_id=uuid.uuid4().hex[:16],
        stages=[Stage(key=k, label=label) for k, label in STAGES],
    )
    _register(job)

    async def runner() -> None:
        async with _RUN_LOCK:
            await run_pipeline(job, sell_amount, slippage_bps, skip_swap)

    asyncio.create_task(runner())
    return job
