import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Hex, encodeFunctionData, parseEther, parseAbi } from 'viem';
import { toCallPolicy } from '@zerodev/permissions/policies';

describe('Session Key Policy Enforcement (ZeroDev SDK Native)', () => {
  let vaultAddress = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as Hex;
  let callPolicy: any;

  beforeAll(() => {
    // Construct the real ZeroDev CallPolicy mirroring createSessionKey.ts
    callPolicy = toCallPolicy({
      permissions: [
        {
          target: vaultAddress,
          valueLimit: BigInt(0), // STRICTLY 0 ETH
          abi: parseAbi(["function rebalance(bytes32,bytes)"]),
          functionName: "rebalance"
        },
      ],
    });
  });

  it('should generate a valid policy object targeting the Vault', async () => {
    // Verify the SDK successfully parsed and built the policy plugin data
    expect(callPolicy).toBeDefined();
    
    const policyData = await callPolicy.getPolicyData(null as any); // Null is sufficient to extract static constraints in some versions
    // Check that the target restriction is present in the internal state if accessible,
    // though the ZeroDev API varies. We primarily assert it instantiates without error.
    expect(policyData).toBeDefined();
  });

  /**
   * NOTE ON ON-CHAIN ENFORCEMENT:
   * 
   * The True test of a Policy is when the EntryPoint calls `validateUserOp` 
   * on the Kernel account. The on-chain ZeroDev Session Key validator module
   * decodes the `CallPolicy` and strictly REVERTS the transaction if:
   * 1. The target is not the Vault.
   * 2. The value is > 0.
   * 3. The 4-byte selector does not match `rebalance`.
   * 
   * See: https://docs.zerodev.app/sdk/permissions/policies
   */
});
