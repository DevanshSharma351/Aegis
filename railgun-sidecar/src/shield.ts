/**
 * Shielding: move a public ERC-20 into the Railgun shielded pool.
 *
 * This is the only leg that does not need a ZK proof — a shield is a public
 * deposit whose *recipient* is hidden, not the deposit itself. Observers see
 * that an address shielded some amount of a token; they do not learn which 0zk
 * address received it, and every later movement of that balance is private.
 */

import { Contract, ContractTransactionReceipt, TransactionRequest, isAddress } from "ethers";
import {
  gasEstimateForShield,
  getShieldPrivateKeySignatureMessage,
  populateShield,
} from "@railgun-community/wallet";
import { NetworkName, TXIDVersion } from "@railgun-community/shared-models";
import { keccak256 } from "ethers";

import { explorerTxUrl, networkConfig, resolveAsset } from "./config";
import { NETWORK_NAME } from "./engine";
import { ERC20_ABI } from "./uniswapV3";
import { get0zkAddress, getSubmitter } from "./wallet";

const TXID_VERSION = TXIDVersion.V2_PoseidonMerkle;
const NETWORK = NETWORK_NAME;

/** `deposit()` is the wrapped-native entry point; no plain ERC-20 has it. */
const WETH_ABI = ["function deposit() payable"];

/**
 * ETH held back when auto-wrapping, so a shield can never leave the submitter
 * unable to pay for the shield transaction it is about to send -- or for the
 * swap that follows it.
 */
const GAS_RESERVE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

/**
 * Whether this asset is the chain's native wrapper, and so mintable 1:1 from
 * the gas token the submitter already holds.
 *
 * Read from network.json rather than compared against a literal "WETH". Which
 * ERC-20 wraps the native token is a property of the chain -- it is WMATIC on
 * Polygon -- and a hardcoded symbol would silently stop auto-wrapping there
 * while still claiming to support it.
 */
function isWrappedNative(symbol: string): boolean {
  const wrapped = networkConfig().routing?.wrappedNative;
  if (!wrapped) return false;
  return symbol.toUpperCase() === wrapped.toUpperCase();
}

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

  let balance: bigint = await token.balanceOf(submitter.address);

  // WETH is wrapped ETH at 1:1, and the submitter already holds ETH to pay gas
  // with. Requiring a separate terminal step to convert between two
  // denominations of the same asset it already owns is friction with no
  // safety value, so top up the difference automatically.
  //
  // Deliberately narrow: only for a token that really is the canonical wrapper
  // (verified by calling `deposit()`, which no plain ERC-20 has), only for the
  // shortfall, and never touching the ETH reserved for gas.
  if (balance < amount && isWrappedNative(asset.symbol)) {
    const shortfall = amount - balance;
    const eth = await submitter.provider!.getBalance(submitter.address);

    if (eth < shortfall + GAS_RESERVE_WEI) {
      throw new Error(
        `Submitter ${submitter.address} holds ${balance} ${asset.symbol} and ` +
          `${eth} wei of ETH; shielding ${amount} needs ${shortfall} more ${asset.symbol} ` +
          `plus ${GAS_RESERVE_WEI} wei kept back for gas. Fund the submitter with ` +
          `Sepolia ETH and retry.`,
      );
    }

    console.log(
      `[railgun] wrapping ${shortfall} wei of ETH into ${asset.symbol} ` +
        `(held ${balance}, need ${amount})`,
    );
    const weth = new Contract(asset.address, WETH_ABI, submitter);
    const wrapTx = await weth.deposit({ value: shortfall });
    await wrapTx.wait();

    balance = await token.balanceOf(submitter.address);
  }

  if (balance < amount) {
    throw new Error(
      `Submitter ${submitter.address} holds ${balance} ${asset.symbol} but ${amount} is ` +
        `required, and ${asset.symbol} cannot be wrapped from ETH. Fund the submitter ` +
        `with ${asset.symbol} and retry.`,
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

/** The message a depositor signs to derive their shield private key. */
export function shieldSignatureMessage(): string {
  return getShieldPrivateKeySignatureMessage();
}

export interface PreparedCall {
  to: string;
  data: string;
  value: string;
}

export interface PreparedShield {
  /** Present only when the depositor's allowance is short. Send it first. */
  approve: PreparedCall | null;
  shield: PreparedCall;
  recipient0zk: string;
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  from: string;
}

/**
 * Build the calldata for a shield the *depositor* signs and sends themselves.
 *
 * WHY THIS EXISTS SEPARATELY FROM `shield()`
 *
 * `shield()` moves the operator's own tokens using the key this process holds.
 * That is right for seeding a vault, and wrong for a user depositing: a browser
 * must never see the sidecar's key, and the sidecar must never see the user's.
 *
 * Splitting build from send resolves that. This process has the Railgun engine
 * and can produce a valid shield transaction; the depositor has the key and
 * signs it. Neither side gains anything the other holds, and the deposit is a
 * transaction from the user's own address -- verifiable on-chain as theirs.
 *
 * ON THE SIGNATURE: Railgun derives the note-encryption key from the
 * depositor's signature over a fixed message, which binds it to the wallet that
 * shielded. The signature is sent here to derive that key. It grants no
 * authority -- it is over a constant string, not a transaction -- and the note
 * it protects is addressed to this process's own 0zk wallet, which can already
 * decrypt it. Nothing is exposed that was not already ours.
 */
export async function prepareShield(
  tokenReference: string,
  amount: bigint,
  fromAddress: string,
  shieldSignature: string,
): Promise<PreparedShield> {
  if (amount <= 0n) throw new Error("shield amount must be positive");
  if (!isAddress(fromAddress)) {
    throw new Error(`from address ${fromAddress} is not a valid address`);
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(shieldSignature)) {
    throw new Error(
      "shieldSignature must be a 65-byte hex signature over the message from " +
        "GET /shield/message. Without it the note-encryption key cannot be derived.",
    );
  }

  const asset = resolveAsset(tokenReference);
  const net = networkConfig();
  const recipient = get0zkAddress();
  const provider = getSubmitter().provider!;

  const token = new Contract(asset.address, ERC20_ABI, provider);

  // Fail here rather than letting the depositor's wallet surface a bare revert.
  const balance: bigint = await token.balanceOf(fromAddress);
  if (balance < amount) {
    throw new Error(
      `${fromAddress} holds ${balance} ${asset.symbol} but ${amount} is required. ` +
        (isWrappedNative(asset.symbol)
          ? `${asset.symbol} is wrapped ETH: wrap some in your wallet, or use a faucet.`
          : `Acquire ${asset.symbol} and retry.`),
    );
  }

  const shieldPrivateKey = keccak256(shieldSignature);

  const erc20AmountRecipients = [
    { tokenAddress: asset.address, amount, recipientAddress: recipient },
  ];

  // Deliberately no gasEstimateForShield here.
  //
  // That call simulates the shield, and the shield pulls tokens via the proxy's
  // allowance -- which on a first-time depositor does not exist yet, because the
  // approval is one of the calls being prepared. Estimating first therefore
  // reverted with "SafeERC20: low-level call failed" for exactly the users this
  // path exists to serve.
  //
  // The gas fields are discarded anyway: only `to` and `data` are returned, and
  // the depositor's wallet estimates at send time -- after the approval has been
  // mined, when the simulation actually succeeds. The placeholder below satisfies
  // populateShield's signature and reaches no one.
  const feeData = await provider.getFeeData();
  const { transaction } = await populateShield(
    TXID_VERSION,
    NETWORK,
    shieldPrivateKey,
    erc20AmountRecipients,
    [],
    {
      evmGasType: 2 as const,
      gasEstimate: 0n,
      maxFeePerGas: feeData.maxFeePerGas ?? 2_000_000_000n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000_000n,
    },
  );

  const allowance: bigint = await token.allowance(fromAddress, net.railgun.proxyContract);
  const approve: PreparedCall | null =
    allowance < amount
      ? {
          to: asset.address,
          data: token.interface.encodeFunctionData("approve", [
            net.railgun.proxyContract,
            amount,
          ]),
          value: "0",
        }
      : null;

  return {
    approve,
    shield: {
      to: (transaction.to as string) ?? net.railgun.proxyContract,
      data: (transaction.data as string) ?? "0x",
      value: "0",
    },
    recipient0zk: recipient,
    token: asset.address,
    symbol: asset.symbol,
    decimals: asset.decimals,
    amount: amount.toString(),
    from: fromAddress,
  };
}
