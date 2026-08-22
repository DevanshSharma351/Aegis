/**
 * Shielding: move a public ERC-20 into the Railgun shielded pool.
 *
 * This is the only leg that does not need a ZK proof — a shield is a public
 * deposit whose *recipient* is hidden, not the deposit itself. Observers see
 * that an address shielded some amount of a token; they do not learn which 0zk
 * address received it, and every later movement of that balance is private.
 */

import { Contract, ContractTransactionReceipt, TransactionRequest } from "ethers";
import {
  gasEstimateForShield,
  getShieldPrivateKeySignatureMessage,
  populateShield,
} from "@railgun-community/wallet";
import { NetworkName, TXIDVersion } from "@railgun-community/shared-models";
import { keccak256 } from "ethers";

import { explorerTxUrl, networkConfig, resolveAsset } from "./config";
import { ERC20_ABI } from "./uniswapV3";
import { get0zkAddress, getSubmitter } from "./wallet";

const TXID_VERSION = TXIDVersion.V2_PoseidonMerkle;
const NETWORK = NetworkName.EthereumSepolia;

/**
 * Derive the shield private key.
 *
 * Railgun requires a per-shield key used to encrypt the note's viewing data.
 * The canonical derivation is keccak256 of the submitter's signature over a
 * fixed SDK-supplied message — that binds the key to the submitting wallet and
 * makes it reproducible without storing anything.
 *
 * The previous code passed AEGIS_OWNER_PRIVATE_KEY directly as the shield
 * private key. That is a different value with a different purpose, and using a
 * long-lived account key as note-encryption material means anyone who ever
 * learns that key can decrypt every note ever shielded with it.
 */
async function deriveShieldPrivateKey(): Promise<string> {
  const submitter = getSubmitter();
  const signature = await submitter.signMessage(getShieldPrivateKeySignatureMessage());
  return keccak256(signature);
}

export interface ShieldResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  token: string;
  symbol: string;
  amount: string;
  recipient0zk: string;
  explorerUrl: string;
  approvalTxHash?: string;
}

/**
 * Shield an ERC-20 into the caller's own 0zk address.
 *
 * Approves the Railgun proxy first if the current allowance is short. The
 * approval is a separate public transaction — unavoidable, since ERC-20 has no
 * way to authorise a pull inside the same transaction without a permit.
 */
export async function shield(tokenReference: string, amount: bigint): Promise<ShieldResult> {
  if (amount <= 0n) throw new Error("shield amount must be positive");

  const asset = resolveAsset(tokenReference);
  const net = networkConfig();
  const submitter = getSubmitter();
  const recipient = get0zkAddress();

  const token = new Contract(asset.address, ERC20_ABI, submitter);

  const balance: bigint = await token.balanceOf(submitter.address);
  if (balance < amount) {
    throw new Error(
      `Submitter ${submitter.address} holds ${balance} ${asset.symbol} but ${amount} is ` +
        `required. Fund it first (scripts/fund_railgun.ts wraps ETH into WETH).`,
    );
  }

  let approvalTxHash: string | undefined;
  const allowance: bigint = await token.allowance(submitter.address, net.railgun.proxyContract);
  if (allowance < amount) {
    console.log(`[railgun] approving Railgun proxy for ${amount} ${asset.symbol}`);
    const approveTx = await token.approve(net.railgun.proxyContract, amount);
    const approveReceipt = await approveTx.wait();
    approvalTxHash = approveReceipt?.hash;
    console.log(`[railgun] approval mined: ${approvalTxHash}`);
  }

  const shieldPrivateKey = await deriveShieldPrivateKey();

  const erc20AmountRecipients = [
    { tokenAddress: asset.address, amount, recipientAddress: recipient },
  ];

  // Estimate first so the populated transaction carries a gas limit the node
  // will accept. Shielding writes a merkle leaf, so it is materially more
  // expensive than a plain transfer and default estimation tends to undershoot.
  const gasEstimate = await gasEstimateForShield(
    TXID_VERSION,
    NETWORK,
    shieldPrivateKey,
    erc20AmountRecipients,
    [],
    submitter.address,
  );

  const feeData = await submitter.provider!.getFeeData();
  const gasDetails = {
    evmGasType: 2 as const,
    gasEstimate: gasEstimate.gasEstimate,
    maxFeePerGas: feeData.maxFeePerGas ?? 2_000_000_000n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000_000n,
  };

  const { transaction } = await populateShield(
    TXID_VERSION,
    NETWORK,
    shieldPrivateKey,
    erc20AmountRecipients,
    [],
    gasDetails,
  );

  console.log(`[railgun] shielding ${amount} ${asset.symbol} to ${recipient}`);

  const sent = await submitter.sendTransaction(transaction as TransactionRequest);
  const receipt = (await sent.wait()) as ContractTransactionReceipt;

  if (receipt.status !== 1) {
    throw new Error(`Shield transaction ${receipt.hash} reverted`);
  }

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    token: asset.address,
    symbol: asset.symbol,
    amount: amount.toString(),
    recipient0zk: recipient,
    explorerUrl: explorerTxUrl(receipt.hash),
    approvalTxHash,
  };
}
