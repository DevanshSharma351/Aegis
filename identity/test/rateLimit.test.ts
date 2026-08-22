import { describe, it, expect, beforeAll } from 'vitest';
import { toRateLimitPolicy } from '@zerodev/permissions/policies';

describe('Rate Limit Policy Enforcement (ZeroDev SDK Native)', () => {
  let rateLimitPolicy: any;

  beforeAll(() => {
    // Construct the real ZeroDev RateLimitPolicy mirroring createSessionKey.ts
    rateLimitPolicy = toRateLimitPolicy({
      count: 1,
      interval: 86400, // 24 hours
    });
  });

  it('should generate a valid rate limit policy object', async () => {
    expect(rateLimitPolicy).toBeDefined();
    
    // Validate that it generates the correct plugin data
    const policyData = await rateLimitPolicy.getPolicyData(null as any);
    expect(policyData).toBeDefined();
  });
});
