/**
 * Uniswap V3 quoting and calldata for Sepolia.
 *
 * WHY THIS FILE EXISTS AT ALL: Cookbook ships no swap adapter that works on
 * Sepolia.
 *
 *   ZeroXSwapRecipe    builds https://sepolia.api.0x.org/swap/v1/quote — the
 *                      per-chain subdomain form of the retired 0x v1 API.
 *   ZeroXV2SwapRecipe  requires a paid 0x API key.
 *   UniV2Like recipes  explicitly `throw` for NetworkName.EthereumSepolia in
 *                      both getFactoryAddressAndInitCodeHash and
 *                      getRouterContractAddress.
 *
 * Uniswap V3, meanwhile, is deployed on Sepolia with real liquidity in the
 * WETH/USDC pair — the 0.05% pool holds roughly 144 WETH against 3.0M USDC, and
 * QuoterV2 answers. So the swap leg is built directly against SwapRouter02
 * rather than through an adapter that cannot work.
 */

import { Contract, JsonRpcProvider, Interface, ContractTransaction } from "ethers";

import { networkConfig, rpcUrls } from "./config";

export const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

export const SWAP_ROUTER_02_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const FEE_TIERS = [500, 3000, 10000, 100];

export interface SwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  feeTier: number;
  minimumAmountOut: bigint;
  slippageBps: number;
}

function provider(): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrls()[0], networkConfig().chainId);
}

/**
 * Quote a swap, picking the fee tier with the best output.
 *
 * QuoterV2 is not a `view` function — it reverts internally to return its
 * result — so it must be reached with `staticCall`, never a normal call.
 *
 * Every tier is tried because Sepolia liquidity is uneven across tiers: the
 * pool with the best rate is not reliably the 0.05% one, and a tier with no
 * liquidity reverts rather than returning zero.
 */
export async function quoteExactInputSingle(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippageBps: number,
  fixedFeeTier?: number,
): Promise<SwapQuote> {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");

  const net = networkConfig();
  const quoter = new Contract(net.uniswapV3.quoterV2, QUOTER_V2_ABI, provider());

  const tiers = fixedFeeTier ? [fixedFeeTier] : FEE_TIERS;
  const failures: string[] = [];

  let best: { amountOut: bigint; feeTier: number } | undefined;

  for (const feeTier of tiers) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn,
        fee: feeTier,
        sqrtPriceLimitX96: 0n,
      });
      const amountOut = BigInt(result[0]);
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { amountOut, feeTier };
      }
    } catch (error) {
      failures.push(`${feeTier}: ${(error as Error).message.split("\n")[0].slice(0, 80)}`);
    }
  }

  if (!best) {
    throw new Error(
      `No Uniswap V3 pool on Sepolia quoted ${tokenIn} -> ${tokenOut} for ${amountIn}. ` +
        `Tried fee tiers ${tiers.join(", ")}.\n  ${failures.join("\n  ")}`,
    );
  }

  // Slippage is applied to the quote to produce amountOutMinimum. The swap
  // executes inside a Railgun cross-contract call, so it settles some blocks
  // after the quote — without a floor, an adverse move would be silently
  // absorbed instead of reverting.
  const minimumAmountOut = (best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

  return {
    amountIn,
    amountOut: best.amountOut,
    feeTier: best.feeTier,
    minimumAmountOut,
    slippageBps,
  };
}

/**
 * ERC-20 approve calldata for the router.
 *
 * Inside a Railgun cross-contract call the caller is the RelayAdapt contract,
 * which holds the unshielded tokens for the duration of the transaction. The
 * approval is therefore granted by RelayAdapt, not by any EOA.
 */
export function buildApproveCall(token: string, spender: string, amount: bigint): ContractTransaction {
  const iface = new Interface(ERC20_ABI);
  return {
    to: token,
    data: iface.encodeFunctionData("approve", [spender, amount]) as `0x${string}`,
    value: 0n,
  } as ContractTransaction;
}

/**
 * SwapRouter02.exactInputSingle calldata.
 *
 * `recipient` is the RelayAdapt contract: the output must land back with
 * RelayAdapt so the same transaction can reshield it. Sending it anywhere else
 * would leave the proceeds public, which is the entire thing this pipeline
 * exists to avoid.
 *
 * SwapRouter02's struct has no `deadline` field (unlike SwapRouter v1);
 * timeliness is enforced by Railgun's own transaction validity window.
 */
export function buildSwapCall(
  tokenIn: string,
  tokenOut: string,
  feeTier: number,
  recipient: string,
  amountIn: bigint,
  amountOutMinimum: bigint,
): ContractTransaction {
  const net = networkConfig();
  const iface = new Interface(SWAP_ROUTER_02_ABI);

  return {
    to: net.uniswapV3.swapRouter02,
    data: iface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn,
        tokenOut,
        fee: feeTier,
        recipient,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ]) as `0x${string}`,
    value: 0n,
  } as ContractTransaction;
}

/** Public ERC-20 balance, used by the funding and verification scripts. */
export async function erc20Balance(token: string, owner: string): Promise<bigint> {
  const contract = new Contract(token, ERC20_ABI, provider());
  return BigInt(await contract.balanceOf(owner));
}
