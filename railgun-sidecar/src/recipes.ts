/**
 * Cookbook Recipe for the private swap leg.
 *
 * A Cookbook `Recipe` wraps a sequence of internal Steps with an UnshieldStep
 * before and a ShieldStep after. Executed through Railgun's RelayAdapt as a
 * cross-contract call, the whole sequence is one transaction:
 *
 *     unshield WETH  ->  approve router  ->  swap  ->  reshield USDC
 *
 * An observer sees a single interaction with the Railgun contracts. The amounts
 * entering and leaving the shielded pool are not linkable to the 0zk address
 * that owns them, and the swap itself is executed by RelayAdapt rather than by
 * any identifiable party.
 *
 * The two Steps below are custom because Cookbook's shipped swap steps cannot
 * run on Sepolia — see uniswapV3.ts for which ones fail and why.
 *
 * THE FEE, AND WHY THESE STEPS TAKE NO FIXED AMOUNT:
 *
 * Railgun charges an unshield fee, deducted during the unshield step that
 * Cookbook prepends. By the time the first internal step runs, the balance
 * available is `amount - fee`, not `amount`. A step that hardcoded the
 * originally requested amount fails validation with "Specified amount exceeds
 * balance" — which is exactly what happened here before the tests caught it.
 *
 * So both steps consume whatever balance the previous step actually produced,
 * and the swap builds its calldata from that figure. The caller quotes against
 * the post-fee amount (see swap.ts) so `amountOutMinimum` is consistent with
 * what will really be traded.
 */

import { NetworkName } from "@railgun-community/shared-models";
import {
  Recipe,
  RecipeConfig,
  RecipeERC20Info,
  Step,
  StepConfig,
  StepInput,
  UnvalidatedStepOutput,
} from "@railgun-community/cookbook";

import { buildApproveCall, buildSwapCall } from "./uniswapV3";
import { networkConfig } from "./config";

/**
 * Approve the Uniswap router to spend the unshielded token.
 *
 * Cookbook ships `ApproveERC20SpenderStep`, but it resolves the spender through
 * adapter config that has no Sepolia entry. This does the same job with the
 * router address read from network.json.
 */
export class ApproveRouterStep extends Step {
  readonly config: StepConfig = {
    name: "Approve Uniswap V3 Router",
    description: "Approves SwapRouter02 to spend the unshielded input token.",
  };

  constructor(
    private readonly router: string,
    private readonly tokenInfo: RecipeERC20Info,
  ) {
    super();
  }

  protected async getStepOutput(input: StepInput): Promise<UnvalidatedStepOutput> {
    // `undefined` amount = take the whole available balance, whatever the
    // unshield fee left behind.
    const { erc20AmountForStep, unusedERC20Amounts } = this.getValidInputERC20Amount(
      input.erc20Amounts,
      (amount) => amount.tokenAddress.toLowerCase() === this.tokenInfo.tokenAddress.toLowerCase(),
      undefined,
    );

    const approve = buildApproveCall(
      this.tokenInfo.tokenAddress,
      this.router,
      erc20AmountForStep.expectedBalance,
    );

    return {
      crossContractCalls: [approve],
      // Approving does not consume the token; it stays available to the swap
      // step, now carrying the router as its approved spender.
      outputERC20Amounts: [
        { ...erc20AmountForStep, approvedSpender: this.router },
        ...unusedERC20Amounts,
      ],
      outputNFTs: input.nfts,
    };
  }
}

/**
 * Swap the approved token through Uniswap V3.
 *
 * `hasNonDeterministicOutput` is true because the realised output depends on
 * pool state at execution time. Cookbook uses that flag to stop later steps
 * assuming an exact balance, and the reshield settles on the minimum rather
 * than the quote.
 */
export class UniswapV3SwapStep extends Step {
  readonly config: StepConfig = {
    name: "Uniswap V3 Swap",
    description: "Swaps the unshielded input token for the output token via SwapRouter02.",
    hasNonDeterministicOutput: true,
  };

  constructor(
    private readonly sellERC20Info: RecipeERC20Info,
    private readonly buyERC20Info: RecipeERC20Info,
    private readonly feeTier: number,
    private readonly minimumAmountOut: bigint,
    private readonly expectedAmountOut: bigint,
    /** RelayAdapt: the swap output must return here to be reshielded. */
    private readonly recipient: string,
  ) {
    super();
  }

  protected async getStepOutput(input: StepInput): Promise<UnvalidatedStepOutput> {
    const { erc20AmountForStep, unusedERC20Amounts } = this.getValidInputERC20Amount(
      input.erc20Amounts,
      (amount) =>
        amount.tokenAddress.toLowerCase() === this.sellERC20Info.tokenAddress.toLowerCase(),
      undefined,
    );

    const amountIn = erc20AmountForStep.expectedBalance;

    const swap = buildSwapCall(
      this.sellERC20Info.tokenAddress,
      this.buyERC20Info.tokenAddress,
      this.feeTier,
      this.recipient,
      amountIn,
      this.minimumAmountOut,
    );

    return {
      crossContractCalls: [swap],
      outputERC20Amounts: [
        {
          tokenAddress: this.buyERC20Info.tokenAddress,
          decimals: this.buyERC20Info.decimals,
          expectedBalance: this.expectedAmountOut,
          minBalance: this.minimumAmountOut,
          approvedSpender: undefined,
        },
        ...unusedERC20Amounts,
      ],
      // The input token is consumed by the swap and its recipient is the pool.
      // Declaring it spent is what stops Cookbook trying to reshield it.
      spentERC20Amounts: [
        {
          tokenAddress: erc20AmountForStep.tokenAddress,
          decimals: erc20AmountForStep.decimals,
          amount: amountIn,
          recipient: `Uniswap V3 Pool (${this.feeTier / 10_000}%)`,
        },
      ],
      outputNFTs: input.nfts,
    };
  }
}

export interface UniswapV3SwapRecipeParams {
  sellERC20Info: RecipeERC20Info;
  buyERC20Info: RecipeERC20Info;
  feeTier: number;
  /** Quoted against the POST-FEE amount; see the header note. */
  minimumAmountOut: bigint;
  expectedAmountOut: bigint;
  relayAdaptContract: string;
}

/**
 * unshield -> approve -> swap -> reshield.
 *
 * `Recipe.getRecipeOutput` adds the unshield and shield steps around these two,
 * so the class body only describes the middle.
 */
export class UniswapV3SwapRecipe extends Recipe {
  readonly config: RecipeConfig = {
    name: "Uniswap V3 Shielded Swap",
    description:
      "Unshields an ERC-20, swaps it on Uniswap V3, and reshields the proceeds in one transaction.",
    // Covers unshield + approve + swap + shield plus RelayAdapt overhead. The
    // gas estimator refines this; it exists as a floor so a low estimate cannot
    // strand the transaction mid-recipe, which would unshield without
    // reshielding and leave the proceeds public.
    minGasLimit: 2_800_000n,
  };

  constructor(private readonly params: UniswapV3SwapRecipeParams) {
    super();
  }

  protected supportsNetwork(networkName: NetworkName): boolean {
    // Scoped to Sepolia deliberately: the router address in network.json is
    // Sepolia's, and Uniswap V3 router addresses differ across chains.
    return networkName === NetworkName.EthereumSepolia;
  }

  protected async getInternalSteps(): Promise<Step[]> {
    const router = networkConfig().uniswapV3.swapRouter02;

    return [
      new ApproveRouterStep(router, this.params.sellERC20Info),
      new UniswapV3SwapStep(
        this.params.sellERC20Info,
        this.params.buyERC20Info,
        this.params.feeTier,
        this.params.minimumAmountOut,
        this.params.expectedAmountOut,
        this.params.relayAdaptContract,
      ),
    ];
  }
}
