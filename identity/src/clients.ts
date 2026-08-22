/**
 * viem / ZeroDev client construction.
 *
 * Two things live here that used to be copy-pasted (and drift) across four
 * files: RPC failover, and the entryPoint/kernelVersion pair that every ZeroDev
 * call needs to agree on.
 */

import {
  Address,
  Chain,
  PublicClient,
  Transport,
  createPublicClient,
  http,
} from "viem";
import { PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { constants, createKernelAccountClient } from "@zerodev/sdk";
import { createPaymasterClient } from "viem/account-abstraction";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount } from "@zerodev/sdk";

import { bundlerUrl, chain, requirePrivateKey, rpcUrls } from "./config";

/**
 * EntryPoint 0.7 with Kernel v3.1.
 *
 * Pinned in one place because the account address is derived from these values:
 * changing either produces a *different* smart account, which would silently
 * orphan the vault's bound session key.
 */
export const ENTRY_POINT = constants.getEntryPoint("0.7");
export const KERNEL_VERSION = constants.KERNEL_V3_1;

let cachedPublicClient: PublicClient<Transport, Chain> | undefined;

/**
 * Build a public client, trying each configured RPC until one answers.
 *
 * Probes with eth_chainId and checks the answer matches the configured chain —
 * a wrong-network RPC otherwise fails much later, as a nonsensical revert.
 */
export async function getPublicClient(): Promise<PublicClient<Transport, Chain>> {
  if (cachedPublicClient) return cachedPublicClient;

  const targetChain = chain();
  const urls = rpcUrls();
  const failures: string[] = [];

  for (const url of urls) {
    try {
      const client = createPublicClient({
        chain: targetChain,
        transport: http(url, { timeout: 20_000, retryCount: 2 }),
      }) as PublicClient<Transport, Chain>;

      const chainId = await client.getChainId();
      if (chainId !== targetChain.id) {
        failures.push(`${redact(url)} served chain ${chainId}, expected ${targetChain.id}`);
        continue;
      }

      cachedPublicClient = client;
      // stderr, not stdout: callers parse stdout as JSON.
      console.error(`[identity] RPC connected: ${redact(url)}`);
      return client;
    } catch (error) {
      failures.push(`${redact(url)}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  throw new Error(
    `No usable RPC endpoint for chain ${targetChain.id}. Tried ${urls.length}:\n  ` +
      failures.join("\n  "),
  );
}

/** Hide API keys embedded in RPC URLs before they reach a log line. */
export function redact(url: string): string {
  return url.replace(/(\/v2\/|apikey=|api_key=)[^/&?]+/gi, "$1***");
}

export function ownerAccount(): PrivateKeyAccount {
  return privateKeyToAccount(
    requirePrivateKey(
      "AEGIS_OWNER_PRIVATE_KEY",
      "it owns the smart account and authorises the session key",
    ),
  );
}

/**
 * Session key private key.
 *
 * PRODUCTION UPGRADE PATH: this key should be derived inside the TEE via the
 * dstack key-derivation API (`DstackClient.get_key`), so it exists only in
 * enclave memory and is reproducible from the enclave's identity — meaning a
 * different enclave build derives a different key and cannot inherit this one's
 * authority. Injecting it as a plaintext environment variable, as here, means
 * anyone who can read the container environment can sign as the session key.
 *
 * The blast radius is bounded by design rather than by this secret: the key can
 * only call `rebalance` on the vault, with zero value, once a day, and the
 * vault has no function that moves funds. A leak lets an attacker write junk to
 * the execution log. It does not let them take anything.
 */
export function sessionKeyAccount(): PrivateKeyAccount {
  return privateKeyToAccount(
    requirePrivateKey(
      "SESSION_KEY_PRIVATE_KEY",
      "it signs the rebalance UserOperation; see clients.ts for the TEE-derivation upgrade path",
    ),
  );
}

/** The owner's sudo (ECDSA) validator plugin. */
export async function getEcdsaValidator() {
  const publicClient = await getPublicClient();
  return signerToEcdsaValidator(publicClient, {
    signer: ownerAccount(),
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
}

/**
 * The owner-controlled Kernel account.
 *
 * This is the address the vault binds as its `sessionKey`, because a
 * UserOperation executes with `msg.sender == account`. It is deterministic in
 * (owner, entryPoint, kernelVersion, index).
 */
export async function getOwnerKernelAccount() {
  const publicClient = await getPublicClient();
  const ecdsaValidator = await getEcdsaValidator();

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });

  return { account, ecdsaValidator, publicClient };
}

/** Predicted smart-account address, without deploying anything. */
export async function getSmartAccountAddress(): Promise<Address> {
  const { account } = await getOwnerKernelAccount();
  return account.address;
}

/**
 * Gas prices for a UserOperation.
 *
 * A UserOperation is priced by the bundler, not by `eth_gasPrice`, so the
 * bundler's own oracle is the correct source. Pimlico exposes
 * `pimlico_getUserOperationGasPrice`.
 *
 * ZeroDev's client defaults to `zd_getUserOperationGasPrice`, which is a
 * ZeroDev-specific method that Pimlico does not implement — pointing the
 * default client at Pimlico fails with "method does not exist". Supplying
 * `estimateFeesPerGas` explicitly is what keeps the ZeroDev account layer
 * working against a non-ZeroDev bundler.
 */
async function pimlicoFeesPerGas(
  transport: ReturnType<typeof http>,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const client = createPublicClient({ chain: chain(), transport });

  const prices = (await client.request({
    method: "pimlico_getUserOperationGasPrice" as any,
    params: [] as any,
  })) as {
    fast: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
  };

  return {
    maxFeePerGas: BigInt(prices.fast.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(prices.fast.maxPriorityFeePerGas),
  };
}

/**
 * Kernel client wired to the Pimlico bundler.
 *
 * GAS SPONSORSHIP is opt-in via PIMLICO_SPONSORSHIP_POLICY_ID. When set, an
 * ERC-7677 paymaster client is attached and the smart account needs no ETH.
 * When unset, the account pays its own gas and must hold a balance.
 *
 * It is opt-in rather than always-on because Pimlico only sponsors under a
 * policy configured on their dashboard; attaching a paymaster without one makes
 * every submission fail inside the paymaster round-trip, which is a much more
 * confusing failure than "this account has no ETH".
 *
 * viem's `createPaymasterClient` speaks ERC-7677 (`pm_getPaymasterStubData` /
 * `pm_getPaymasterData`), which Pimlico implements. ZeroDev's own paymaster
 * client speaks `zd_` methods and would fail here for the same reason the gas
 * price call did.
 */
export async function buildKernelClient(account: any) {
  const url = bundlerUrl();
  const targetChain = chain();
  const transport = http(url, { timeout: 60_000 });

  const sponsorshipPolicyId = process.env.PIMLICO_SPONSORSHIP_POLICY_ID?.trim();

  const paymaster = sponsorshipPolicyId
    ? createPaymasterClient({ transport })
    : undefined;

  if (sponsorshipPolicyId) {
    console.error(`[identity] gas sponsored via Pimlico policy ${sponsorshipPolicyId}`);
  } else {
    const balance = await (await getPublicClient()).getBalance({ address: account.address });
    console.error(
      `[identity] self-funded: account balance ${balance} wei ` +
        `(set PIMLICO_SPONSORSHIP_POLICY_ID to sponsor instead)`,
    );
    if (balance === 0n) {
      throw new Error(
        `Smart account ${account.address} holds no ETH and no sponsorship policy is ` +
          `configured, so the UserOperation cannot be paid for. Either fund the account, ` +
          `or set PIMLICO_SPONSORSHIP_POLICY_ID.`,
      );
    }
  }

  return createKernelAccountClient({
    account,
    chain: targetChain,
    bundlerTransport: transport,
    client: await getPublicClient(),
    ...(paymaster
      ? { paymaster, paymasterContext: { sponsorshipPolicyId } }
      : {}),
    userOperation: {
      estimateFeesPerGas: () => pimlicoFeesPerGas(transport),
    },
  });
}
