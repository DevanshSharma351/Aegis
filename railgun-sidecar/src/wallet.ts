/**
 * Railgun 0zk wallet and the public submitter EOA.
 *
 * Two distinct identities live here and must not be confused:
 *
 *   the 0zk wallet   holds shielded balances; addressed as 0zk1..., has no
 *                    on-chain presence, and spends by proving rather than by
 *                    signing a transaction.
 *   the submitter    a normal EOA that pays gas and broadcasts the transaction
 *                    that carries the proof. It learns nothing about the
 *                    shielded balances it is broadcasting for.
 */

import { createHash } from "crypto";
import { Wallet, JsonRpcProvider } from "ethers";
import {
  balanceForERC20Token,
  createRailgunWallet,
  getRailgunAddress,
  refreshBalances,
  walletForID,
} from "@railgun-community/wallet";
import { TXIDVersion } from "@railgun-community/shared-models";

import { CHAIN, NETWORK_NAME } from "./engine";
import { networkConfig, requireEnv, resolveAsset, rpcUrls } from "./config";

let walletId: string | undefined;
let railgunAddress: string | undefined;

/**
 * Derive the LevelDB encryption key from the mnemonic.
 *
 * The engine encrypts wallet state at rest with this key, and it must be a
 * 32-byte hex string. The previous code passed the literal string
 * "aegis_engine", which is neither 32 bytes nor secret.
 *
 * Deriving it from the mnemonic means the on-disk database is readable only by
 * a process that already holds the mnemonic — so the volume adds no new place
 * for the secret to leak. The domain separator keeps this value from colliding
 * with any other key derived from the same mnemonic.
 */
function encryptionKey(mnemonic: string): string {
  return createHash("sha256").update(`aegis-railgun-db-v1:${mnemonic}`).digest("hex");
}

export async function initWallet(): Promise<{ id: string; railgunAddress: string }> {
  if (walletId && railgunAddress) return { id: walletId, railgunAddress };

  const mnemonic = requireEnv(
    "RAILGUN_WALLET_MNEMONIC",
    "it derives the 0zk wallet that holds the shielded balance",
  );
  const net = networkConfig();

  // Starting the scan at the Railgun deployment block rather than 0 is the
  // difference between a scan that completes and one that never does: the
  // shielded pool did not exist before this block, so there is nothing to find.
  const creationBlockNumbers = { [NETWORK_NAME]: net.railgun.deploymentBlock };

  const info = await createRailgunWallet(
    encryptionKey(mnemonic),
    mnemonic,
    creationBlockNumbers,
  );

  walletId = info.id;
  railgunAddress = info.railgunAddress;

  console.log(`[railgun] wallet ready, 0zk address ${railgunAddress}`);
  return { id: walletId, railgunAddress };
}

export function getWalletId(): string {
  if (!walletId) throw new Error("Railgun wallet is not initialised; call initWallet() first.");
  return walletId;
}

export function getEncryptionKey(): string {
  return encryptionKey(
    requireEnv("RAILGUN_WALLET_MNEMONIC", "it derives the wallet database encryption key"),
  );
}

export function get0zkAddress(): string {
  if (!railgunAddress) throw new Error("Railgun wallet is not initialised.");
  return railgunAddress;
}

/**
 * The public EOA that broadcasts transactions and pays gas.
 *
 * THE SEAM. Workstream B's session-key account replaces this when the vault's
 * policy is widened to cover Railgun's RelayAdapt contract. It is deliberately
 * one function so the swap is a single edit.
 *
 * It is NOT swapped today, and that is a design decision rather than an
 * omission: the session key is scoped to exactly one selector on exactly one
 * contract, and AegisVault has no function that can move a token. Letting it
 * also call RelayAdapt would widen it from "can write to the execution log" to
 * "can move shielded funds", which is the single largest authority increase
 * available anywhere in this system. It should be a deliberate, separately
 * reviewed change, not a side effect of wiring the pipeline together.
 */
export function getSubmitter(): Wallet {
  const key = requireEnv(
    "RAILGUN_TEST_SIGNER_KEY",
    "it broadcasts shield and cross-contract transactions and pays their gas",
  );
  const normalised = key.startsWith("0x") ? key : `0x${key}`;
  const provider = new JsonRpcProvider(rpcUrls()[0], networkConfig().chainId);
  return new Wallet(normalised, provider);
}

export async function scanBalances(): Promise<void> {
  await refreshBalances(CHAIN, [getWalletId()]);
}

export interface ShieldedBalance {
  symbol: string;
  address: string;
  decimals: number;
  /** Total shielded balance, including notes not yet POI-validated. */
  balance: string;
  /** Subset that can actually be spent right now. */
  spendable: string;
}

/**
 * Read shielded balances for every whitelisted asset.
 *
 * `spendable` is reported separately from `balance` because they diverge in a
 * way that matters: a freshly shielded note is in the tree immediately but is
 * not spendable until POI validation completes. Reporting only the total would
 * make "I have the balance but the spend fails" look like a bug.
 */
export async function getShieldedBalances(): Promise<ShieldedBalance[]> {
  const wallet = walletForID(getWalletId());
  const { assets } = await import("./config");

  const results: ShieldedBalance[] = [];
  for (const asset of assets()) {
    const [total, spendable] = await Promise.all([
      balanceForERC20Token(TXIDVersion.V2_PoseidonMerkle, wallet, NETWORK_NAME, asset.address, false),
      balanceForERC20Token(TXIDVersion.V2_PoseidonMerkle, wallet, NETWORK_NAME, asset.address, true),
    ]);

    results.push({
      symbol: asset.symbol,
      address: asset.address,
      decimals: asset.decimals,
      balance: total.toString(),
      spendable: spendable.toString(),
    });
  }
  return results;
}

export async function getShieldedBalance(reference: string, onlySpendable = false): Promise<bigint> {
  const asset = resolveAsset(reference);
  const wallet = walletForID(getWalletId());
  return balanceForERC20Token(
    TXIDVersion.V2_PoseidonMerkle,
    wallet,
    NETWORK_NAME,
    asset.address,
    onlySpendable,
  );
}

export function railgunAddressForWallet(): string {
  const address = getRailgunAddress(getWalletId());
  if (!address) throw new Error("Could not read the 0zk address for the loaded wallet.");
  return address;
}
