"""
The step that turns an attested allocation into an actual trade.

This exists because the allocation used to go nowhere: the SLM's output was
hashed into the TDX quote, signed, and recorded on-chain, and then the executor
sold a hardcoded WETH->USDC amount that the HTTP caller had chosen. The decision
and the trade were unrelated, so "the agent rebalanced" was not a claim the
system could support.
"""

import pytest

from pipeline import (
    MIN_REBALANCE_WEIGHT_DELTA,
    NothingToRebalance,
    plan_rebalance,
)

PRICES = {
    "WETH": {"close": 4000.0},
    "USDC": {"close": 1.0},
    "DAI": {"close": 1.0},
    "LINK": {"close": 11.4},
    "UNI": {"close": 4.1},
}

EQUAL = {"WETH": 0.2, "USDC": 0.2, "DAI": 0.2, "LINK": 0.2, "UNI": 0.2}


def balances(**held: int):
    """Shielded balances in base units; anything unnamed is zero."""
    decimals = {"WETH": 18, "USDC": 6, "DAI": 18, "LINK": 18, "UNI": 18}
    return [
        {
            "symbol": s,
            "balance": str(held.get(s, 0)),
            "spendable": str(held.get(s, 0)),
            "decimals": d,
        }
        for s, d in decimals.items()
    ]


class TestDirection:
    def test_sells_the_most_overweight_and_buys_the_most_underweight(self):
        # All value in WETH, target wants it spread five ways.
        plan = plan_rebalance(EQUAL, balances(WETH=10**18), PRICES)

        assert plan.sell_symbol == "WETH"
        assert plan.buy_symbol in ("USDC", "DAI", "LINK", "UNI")
        assert plan.sell_amount > 0

    def test_direction_follows_the_allocation_not_a_hardcoded_pair(self):
        """The regression that motivated this module: WETH->USDC was fixed in
        code, so the trade never reflected what the model decided."""
        # Everything in USDC, and the target asks for WETH.
        plan = plan_rebalance(
            {"WETH": 1.0, "USDC": 0.0, "DAI": 0.0, "LINK": 0.0, "UNI": 0.0},
            balances(USDC=1_000_000_000),
            PRICES,
        )

        assert plan.sell_symbol == "USDC"
        assert plan.buy_symbol == "WETH"


class TestRouting:
    """Every planned pair must have a Uniswap V3 pool, or the run dies at the
    swap stage having already spent a UserOperation and a rate-limit slot --
    which is exactly what a USDC -> DAI plan did."""

    def test_routes_through_the_hub_when_neither_side_is_weth(self):
        # USDC heavily over-weight, DAI heavily under, WETH near target.
        # USDC/DAI has no pool on Sepolia.
        held = balances(
            USDC=800 * 10**6,
            WETH=int(200 / 4000 * 10**18),
        )
        target = {"WETH": 0.2, "USDC": 0.2, "DAI": 0.6, "LINK": 0.0, "UNI": 0.0}

        plan = plan_rebalance(target, held, PRICES)

        assert plan.sell_symbol == "USDC"
        assert plan.buy_symbol == "WETH", "must sell into the hub, not to an unroutable pair"
        assert plan.routed_via_hub is True

    def test_keeps_the_direct_pair_when_one_side_is_already_weth(self):
        plan = plan_rebalance(EQUAL, balances(WETH=10**18), PRICES)

        assert plan.sell_symbol == "WETH"
        assert plan.routed_via_hub is False


class TestSizing:
    def test_trade_closes_the_smaller_of_the_two_gaps(self):
        # 100% WETH against equal weights: each target is 0.2, so the buy side
        # can absorb 0.2 while the sell side has 0.8 to give. The trade is the
        # smaller, 20% of the portfolio.
        plan = plan_rebalance(EQUAL, balances(WETH=10**18), PRICES)

        assert plan.portfolio_value_usd == pytest.approx(4000.0)
        assert plan.trade_value_usd == pytest.approx(800.0)
        assert plan.sell_amount == pytest.approx(2 * 10**17, rel=1e-6)

    def test_never_sells_more_than_is_poi_spendable(self):
        held = balances(WETH=10**18)
        for b in held:
            if b["symbol"] == "WETH":
                b["spendable"] = str(10**16)  # only 1% has cleared POI

        plan = plan_rebalance(EQUAL, held, PRICES)
        assert plan.sell_amount <= 10**16

    def test_caller_supplied_amount_is_an_upper_bound_only(self):
        """A demo may cap the size. It may not choose the direction -- that
        belongs to the decision that was signed."""
        plan = plan_rebalance(EQUAL, balances(WETH=10**18), PRICES, max_sell_amount=10**15)

        assert plan.sell_amount == 10**15
        assert plan.sell_symbol == "WETH"


class TestRefusals:
    def test_skips_when_already_within_tolerance(self):
        # Two assets a hair off target: below the threshold, not worth a proof.
        drift = MIN_REBALANCE_WEIGHT_DELTA / 4
        target = dict(EQUAL)
        target["WETH"] = 0.2 + drift
        target["USDC"] = 0.2 - drift

        # $200 of each, so every weight is 0.2 and only the target drifts.
        held = balances(
            WETH=int(200 / 4000 * 10**18),
            USDC=200 * 10**6,
            DAI=200 * 10**18,
            LINK=int(200 / 11.4 * 10**18),
            UNI=int(200 / 4.1 * 10**18),
        )
        with pytest.raises(NothingToRebalance):
            plan_rebalance(target, held, PRICES)

    def test_skips_an_empty_portfolio_rather_than_dividing_by_zero(self):
        with pytest.raises(NothingToRebalance):
            plan_rebalance(EQUAL, balances(), PRICES)

    def test_skips_when_the_overweight_asset_is_not_yet_spendable(self):
        held = balances(WETH=10**18)
        for b in held:
            if b["symbol"] == "WETH":
                b["spendable"] = "0"  # shielded, still awaiting POI

        with pytest.raises(NothingToRebalance):
            plan_rebalance(EQUAL, held, PRICES)


class TestPricing:
    def test_uses_the_prices_the_model_was_shown(self):
        """Valuing the portfolio from a second source would mean trading against
        figures the attested decision never referenced."""
        cheap = dict(PRICES, WETH={"close": 100.0})
        dear = dict(PRICES, WETH={"close": 8000.0})

        a = plan_rebalance(EQUAL, balances(WETH=10**18, USDC=1_000_000), cheap)
        b = plan_rebalance(EQUAL, balances(WETH=10**18, USDC=1_000_000), dear)

        assert a.portfolio_value_usd != b.portfolio_value_usd
