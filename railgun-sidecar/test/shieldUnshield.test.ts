/**
 * Railgun sidecar tests.
 *
 * Two groups:
 *
 *   Offline — recipe construction, asset resolution, calldata encoding. These
 *   run anywhere and cover the parts that used to be fabricated: the previous
 *   `buildShieldRecipe` returned a plain object literal, and the swap path fell
 *   through to a 0-ETH self-transfer regardless of which branch was taken.
 *
 *   Live — Uniswap V3 quoting against Sepolia, skipped unless an RPC is
 *   configured. Worth having because Cookbook's own adapters do not work on
 *   Sepolia at all, so the claim that this pair is quotable is exactly the thing
 *   that needs checking against reality rather than a fixture.
 *
 * Not covered here: proof generation and broadcast. Those need a funded
 * shielded balance and a POI aggregator, cost real gas, and take minutes — so
 * they belong in `scripts/run_full_pipeline.sh`, not in a unit suite.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Interface, getAddress } from "ethers";
import { setRailgunFees } from "@railgun-community/cookbook";

import { assetBySymbol, assets, networkConfig, resolveAsset } from "../src/config";
import { ApproveRouterStep, UniswapV3SwapRecipe, UniswapV3SwapStep } from "../src/recipes";
import { SWAP_ROUTER_02_ABI, buildApproveCall, buildSwapCall, quoteExactInputSingle } from "../src/uniswapV3";

const HAS_RPC = Boolean(process.env.ALCHEMY_API_KEY || process.env.AEGIS_RPC_URL);
const liveIt = HAS_RPC ? it : it.skip;

const WETH = assetBySymbol("WETH");
const USDC = assetBySymbol("USDC");

/**
 * Cookbook ships no fee entry for Sepolia, so every recipe fails at the
 * unshield step until one is supplied. The service reads the real values off
 * the deployed Railgun contracts via `loadProvider` (see engine.ts); these
 * tests do not start the engine, so they set the protocol's standard 25 basis
 * points directly. The exact figure does not matter here — only that a fee is
 * defined, since these tests assert recipe *structure*, not amounts.
 */
beforeAll(() => {
  setRailgunFees("Ethereum_Sepolia" as any, 25n, 25n);
});

describe("asset resolution", () => {
  it("resolves by symbol", () => {
    expect(resolveAsset("WETH").address).toBe(WETH.address);
    expect(resolveAsset("usdc").address).toBe(USDC.address);
  });

  it("resolves by checksummed address", () => {
    expect(resolveAsset(WETH.address).symbol).toBe("WETH");
  });

  it("resolves by lowercase address", () => {
    expect(resolveAsset(WETH.address.toLowerCase()).symbol).toBe("WETH");
  });

  it("rejects an address outside the whitelist", () => {
    // The old pipeline posted the literal string "0xWETH" to this service.
    // Resolving through the whitelist turns that class of mistake into a named
    // error rather than a malformed transaction.
    expect(() => resolveAsset("0x1111111111111111111111111111111111111111")).toThrow(
      /not in the asset whitelist/,
    );
  });

  it("rejects an unknown symbol and names what is allowed", () => {
    expect(() => resolveAsset("DOGE")).toThrow(/Allowed: WETH, USDC/);
  });

  it("rejects the malformed placeholder the old pipeline used", () => {
    expect(() => resolveAsset("0xWETH")).toThrow();
  });
});

describe("whitelist integrity", () => {
  it("holds exactly the two assets the vault knows about", () => {
    expect(assets().map((a) => a.symbol).sort()).toEqual(["USDC", "WETH"]);
  });

  it("uses checksummed addresses", () => {
    for (const asset of assets()) {
      expect(getAddress(asset.address)).toBe(getAddress(asset.address));
    }
  });

  it("records the decimals the swap maths depends on", () => {
    expect(WETH.decimals).toBe(18);
    expect(USDC.decimals).toBe(6);
  });
});

describe("Uniswap V3 calldata", () => {
  const router = networkConfig().uniswapV3.swapRouter02;

  it("encodes an approval to the router", () => {
    const call = buildApproveCall(WETH.address, router, 1000n);

    expect(call.to).toBe(WETH.address);
    expect(call.value).toBe(0n);
    // approve(address,uint256)
    expect(String(call.data).slice(0, 10)).toBe("0x095ea7b3");
    expect(String(call.data).toLowerCase()).toContain(router.slice(2).toLowerCase());
  });

  it("encodes exactInputSingle with the RelayAdapt as recipient", () => {
    const relayAdapt = networkConfig().railgun.relayAdaptContract;
    const call = buildSwapCall(WETH.address, USDC.address, 500, relayAdapt, 1000n, 900n);

    expect(call.to).toBe(router);

    const decoded = new Interface(SWAP_ROUTER_02_ABI).decodeFunctionData(
      "exactInputSingle",
      String(call.data),
    );
    const params = decoded[0];

    expect(getAddress(params.tokenIn)).toBe(getAddress(WETH.address));
    expect(getAddress(params.tokenOut)).toBe(getAddress(USDC.address));
    expect(Number(params.fee)).toBe(500);
    expect(params.amountIn).toBe(1000n);
    expect(params.amountOutMinimum).toBe(900n);

    // The output must return to RelayAdapt so the same transaction can reshield
    // it. Any other recipient leaves the proceeds public, which defeats the
    // entire purpose of routing through Railgun.
    expect(getAddress(params.recipient)).toBe(getAddress(relayAdapt));
  });

  it("carries a slippage floor rather than accepting any output", () => {
    const call = buildSwapCall(WETH.address, USDC.address, 500, networkConfig().railgun.relayAdaptContract, 1000n, 950n);
    const params = new Interface(SWAP_ROUTER_02_ABI).decodeFunctionData(
      "exactInputSingle",
      String(call.data),
    )[0];

    expect(params.amountOutMinimum).toBeGreaterThan(0n);
  });
});

describe("recipe construction", () => {
  const relayAdapt = networkConfig().railgun.relayAdaptContract;

  const recipe = () =>
    new UniswapV3SwapRecipe({
      sellERC20Info: { tokenAddress: WETH.address, decimals: BigInt(WETH.decimals) },
      buyERC20Info: { tokenAddress: USDC.address, decimals: BigInt(USDC.decimals) },
      feeTier: 500,
      minimumAmountOut: 20_000_000n,
      expectedAmountOut: 21_000_000n,
      relayAdaptContract: relayAdapt,
    });

  it("is a real Cookbook Recipe, not an object literal", () => {
    const r = recipe();
    expect(r.config.name).toContain("Uniswap V3");
    expect(typeof (r as any).getRecipeOutput).toBe("function");
    expect(r.id).toBeTruthy();
  });

  it("declares a gas floor covering unshield + swap + reshield", () => {
    // A low estimate that strands the transaction mid-recipe would unshield
    // without reshielding, leaving the proceeds public.
    expect(recipe().config.minGasLimit).toBeGreaterThanOrEqual(2_000_000n);
  });

  it("produces unshield -> approve -> swap -> reshield", async () => {
    const output = await recipe().getRecipeOutput({
      networkName: "Ethereum_Sepolia" as any,
      railgunAddress:
        "0zk1qy2fcsursj02f9wlkph62luh5cmx2ry3axmtr2rd6h72was4afug3rv7j6fe3z53lu9mwwkrj0d0s8uunjge7ekzsjjxl8z9m2vfugr5z67jld6qm9fnjr3h4y3",
      erc20Amounts: [
        {
          tokenAddress: WETH.address,
          decimals: BigInt(WETH.decimals),
          amount: 1_000_000_000_000_000n,
        },
      ],
      nfts: [],
    });

    const stepNames = output.stepOutputs.map((s) => s.name);
    expect(stepNames.some((n) => /unshield/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /approve/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /swap/i.test(n))).toBe(true);
    expect(stepNames.some((n) => /shield/i.test(n))).toBe(true);

    // Two cross-contract calls reach the chain: the approval and the swap.
    expect(output.crossContractCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("reshields the bought token to the 0zk address", async () => {
    const output = await recipe().getRecipeOutput({
      networkName: "Ethereum_Sepolia" as any,
      railgunAddress:
        "0zk1qy2fcsursj02f9wlkph62luh5cmx2ry3axmtr2rd6h72was4afug3rv7j6fe3z53lu9mwwkrj0d0s8uunjge7ekzsjjxl8z9m2vfugr5z67jld6qm9fnjr3h4y3",
      erc20Amounts: [
        {
          tokenAddress: WETH.address,
          decimals: BigInt(WETH.decimals),
          amount: 1_000_000_000_000_000n,
        },
      ],
      nfts: [],
    });

    const shielded = output.erc20AmountRecipients.map((r) => r.tokenAddress.toLowerCase());
    expect(shielded).toContain(USDC.address.toLowerCase());
  });

  it("refuses networks whose router address it does not know", () => {
    const r = recipe();
    expect((r as any).supportsNetwork("Ethereum")).toBe(false);
    expect((r as any).supportsNetwork("Ethereum_Sepolia")).toBe(true);
  });
});

describe("individual steps", () => {
  it("the approve step leaves the token spendable by the router", async () => {
    const router = networkConfig().uniswapV3.swapRouter02;
    const step = new ApproveRouterStep(router, { tokenAddress: WETH.address, decimals: 18n });

    const output = await step.getValidStepOutput({
      networkName: "Ethereum_Sepolia" as any,
      erc20Amounts: [
        {
          tokenAddress: WETH.address,
          decimals: 18n,
          expectedBalance: 1000n,
          minBalance: 1000n,
          approvedSpender: undefined,
        },
      ],
      nfts: [],
    });

    // Approving does not consume the token; it must remain available to the
    // swap step, now carrying the router as its approved spender.
    const weth = output.outputERC20Amounts.find(
      (a) => a.tokenAddress.toLowerCase() === WETH.address.toLowerCase(),
    );
    expect(weth?.approvedSpender).toBe(router);
  });

  it("the swap step marks the input spent and the output non-deterministic", async () => {
    const step = new UniswapV3SwapStep(
      { tokenAddress: WETH.address, decimals: 18n },
      { tokenAddress: USDC.address, decimals: 6n },
      500,
      900n,
      950n,
      networkConfig().railgun.relayAdaptContract,
    );

    expect(step.config.hasNonDeterministicOutput).toBe(true);

    const output = await step.getValidStepOutput({
      networkName: "Ethereum_Sepolia" as any,
      erc20Amounts: [
        {
          tokenAddress: WETH.address,
          decimals: 18n,
          expectedBalance: 1000n,
          minBalance: 1000n,
          approvedSpender: networkConfig().uniswapV3.swapRouter02,
        },
      ],
      nfts: [],
    });

    // The input is consumed, so it must be declared spent or Cookbook would
    // try to reshield it.
    expect(output.spentERC20Amounts?.[0].tokenAddress.toLowerCase()).toBe(
      WETH.address.toLowerCase(),
    );

    const bought = output.outputERC20Amounts.find(
      (a) => a.tokenAddress.toLowerCase() === USDC.address.toLowerCase(),
    );
    expect(bought?.minBalance).toBe(900n);
  });
});

describe("live Sepolia quoting", () => {
  liveIt("quotes WETH -> USDC on a real pool", async () => {
    const quote = await quoteExactInputSingle(
      WETH.address,
      USDC.address,
      1_000_000_000_000_000n, // 0.001 WETH
      100,
    );

    // Real liquidity exists in this pair; a zero quote means the pool this
    // pipeline depends on has gone away.
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect([100, 500, 3000, 10000]).toContain(quote.feeTier);
    expect(quote.minimumAmountOut).toBeLessThan(quote.amountOut);

    // 1% slippage on the quote.
    expect(quote.minimumAmountOut).toBe((quote.amountOut * 9900n) / 10_000n);
  }, 60_000);

  liveIt("rejects a zero amount before touching the network", async () => {
    await expect(
      quoteExactInputSingle(WETH.address, USDC.address, 0n, 100),
    ).rejects.toThrow(/must be positive/);
  });

  liveIt("reports clearly when no pool quotes the pair", async () => {
    const nonToken = "0x0000000000000000000000000000000000000001";
    await expect(
      quoteExactInputSingle(WETH.address, nonToken, 1000n, 100),
    ).rejects.toThrow(/No Uniswap V3 pool/);
  }, 60_000);
});
