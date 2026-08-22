import { 
  RecipeERC20Info,
} from '@railgun-community/cookbook';
import { ZeroXSwapRecipe } from '@railgun-community/cookbook';

import * as fs from 'fs';
import * as path from 'path';

function getTokenDecimals(tokenAddress: string): bigint {
  const assetsPath = path.resolve(__dirname, '../../../shared/config/assets.json');
  try {
    const assetsData = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
    const asset = assetsData.assets.find((a: any) => a.address.toLowerCase() === tokenAddress.toLowerCase());
    if (asset && asset.decimals) {
      return BigInt(asset.decimals);
    }
  } catch (err) {
    console.warn("Could not read assets.json or find token, falling back to 18 decimals");
  }
  return 18n;
}

/**
 * Builds a Shield Recipe
 */
export function buildShieldRecipe(
  tokenAddress: string,
  amount: bigint,
  toRailgunAddress: string
) {
  return {
    isShield: true,
    erc20Amounts: [{ tokenAddress, amount, isBaseToken: false }]
  };
}

/**
 * Builds an Unshield -> Swap -> Reshield Recipe
 */
export async function buildUnshieldSwapReshieldRecipe(
  sellTokenAddress: string,
  buyTokenAddress: string,
  sellAmount: bigint,
  minimumBuyAmount: bigint,
  toRailgunAddress: string,
  slippageBps: bigint = 100n // default 1% slippage
) {
  const sellERC20Info: RecipeERC20Info = {
    tokenAddress: sellTokenAddress,
    decimals: getTokenDecimals(sellTokenAddress)
  };
  
  const buyERC20Info: RecipeERC20Info = {
    tokenAddress: buyTokenAddress,
    decimals: getTokenDecimals(buyTokenAddress)
  };

  const swapRecipe = new ZeroXSwapRecipe(
    sellERC20Info,
    buyERC20Info,
    slippageBps,
    toRailgunAddress
  );
  
  return { swapRecipe };
}
