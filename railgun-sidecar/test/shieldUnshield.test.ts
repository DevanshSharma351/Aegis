import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { Hex } from 'viem';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { buildShieldRecipe, buildUnshieldSwapReshieldRecipe } from '../src/recipes';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function getSubmitter() {
  const pk = process.env.RAILGUN_TEST_SIGNER_KEY as Hex;
  if (!pk) {
    throw new Error("Missing RAILGUN_TEST_SIGNER_KEY for testing.");
  }
  return privateKeyToAccount(pk);
}

describe('Railgun E2E: Shield -> Unshield-Swap-Reshield', () => {
  it('should initialize the submitter', () => {
    const submitter = getSubmitter();
    expect(submitter.address).toBeDefined();
    console.log(`Test Submitter Address: ${submitter.address}`);
  });

  it('should construct a structurally valid shield recipe', async () => {
    const mockToken = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // USDC
    const mockRailgunAddress = '0zk1qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const amount = BigInt(1000000);

    const recipe = buildShieldRecipe(mockToken, amount, mockRailgunAddress);
    
    expect(recipe.isShield).toBe(true);
    expect(recipe.erc20Amounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tokenAddress: mockToken,
        amount: amount,
      })
    ]));
  });

  it('should construct a structurally valid unshield-swap-reshield pipeline', async () => {
    const mockSellToken = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // USDC
    const mockBuyToken = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'; // WETH
    const mockRailgunAddress = '0zk1qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const sellAmount = BigInt(1000000);
    const minBuyAmount = BigInt(100);

    const { swapRecipe } = await buildUnshieldSwapReshieldRecipe(
      mockSellToken,
      mockBuyToken,
      sellAmount,
      minBuyAmount,
      mockRailgunAddress
    );
    
    // Check if the recipe was created and the destination address is correctly mapped
    // In ZeroXSwapRecipe, the isRailgunDestinationAddress is computed
    expect(swapRecipe).toBeDefined();
    expect(swapRecipe.config.name).toContain('Shield'); // Verifies it recognized the 0zk address and upgraded to reshield
    expect(swapRecipe.config.name).toContain('0x Exchange');
  });
});
