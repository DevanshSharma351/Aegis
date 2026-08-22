/**
 * Transaction submission, behind one interface.
 *
 * The Railgun recipe and proof generation are entirely independent of how the
 * resulting transaction reaches a block. Keeping submission behind this
 * boundary means adding or changing a relay is a config change, not a rewrite
 * of the recipe — and it means the *proof* is identical regardless of route,
 * so switching routes cannot alter what was authorised.
 *
 * WHY THIS MATTERS FOR MEV
 *
 * A Railgun cross-contract call unshields, swaps on a public DEX, and reshields
 * atomically. Atomicity means nobody can wedge a transaction *between* those
 * steps. It does NOT mean the whole bundle is invisible: submitted through the
 * public mempool, a searcher sees the pending transaction, reads the swap it
 * will perform, and can sandwich the Uniswap leg by front- and back-running the
 * entire RelayAdapt call.
 *
 * `minimumAmountOut` bounds the damage — a sandwich cannot push execution below
 * the floor without the swap reverting — but bounding loss is not preventing it.
 * Private submission removes the mempool exposure that makes the attack
 * possible in the first place.
 */

import { TransactionRequest, Wallet } from "ethers";

export type SubmissionMode = "public" | "private";

export interface SubmissionResult {
  txHash: string;
  /** The route actually used. Never inferred by the caller. */
  mode: SubmissionMode;
  /** Human-readable description of the route, for logs and the UI. */
  route: string;
  /**
   * Whether this route keeps the transaction out of the public mempool.
   * Reported explicitly so no caller has to assume it from `mode`.
   */
  mempoolExposed: boolean;
}

export interface TransactionSubmitter {
  readonly mode: SubmissionMode;
  readonly route: string;
  readonly mempoolExposed: boolean;
  submit(tx: TransactionRequest): Promise<SubmissionResult>;
}

/**
 * Ordinary submission through the configured RPC.
 *
 * The transaction enters the public mempool, where it is visible before
 * inclusion. Honest about it: `mempoolExposed` is true.
 */
export class PublicSubmitter implements TransactionSubmitter {
  readonly mode = "public" as const;
  readonly route = "public mempool (configured RPC)";
  readonly mempoolExposed = true;

  constructor(private readonly wallet: Wallet) {}

  async submit(tx: TransactionRequest): Promise<SubmissionResult> {
    const sent = await this.wallet.sendTransaction(tx);
    const receipt = await sent.wait();
    if (!receipt) throw new Error(`No receipt for ${sent.hash}`);
    if (receipt.status !== 1) throw new Error(`Transaction ${receipt.hash} reverted`);

    return {
      txHash: receipt.hash,
      mode: this.mode,
      route: this.route,
      mempoolExposed: true,
    };
  }
}

/**
 * Flashbots Protect submission via `eth_sendPrivateTransaction`.
 *
 * The transaction is sent directly to Flashbots builders and never enters the
 * public mempool, so there is no pending transaction for a searcher to observe
 * and sandwich.
 *
 * Verified reachable on Sepolia: `rpc-sepolia.flashbots.net` reports
 * chainId 11155111, accepts `eth_sendRawTransaction`, and exposes
 * `eth_sendPrivateTransaction` (signature-gated).
 *
 * AUTHENTICATION: Flashbots authenticates the *caller*, not the transaction,
 * via an `X-Flashbots-Signature: <address>:<signature>` header, where the
 * signature is over the keccak of the JSON body. The identity key is used only
 * for reputation and carries no funds — it never signs a transaction. It is
 * deliberately separable from the submitter key (`AEGIS_FLASHBOTS_IDENTITY_KEY`)
 * so it can be rotated independently, and falls back to the submitter key when
 * unset.
 *
 * TRADE-OFF: inclusion is best-effort. A private transaction is only included
 * if a Flashbots builder wins the block. On Sepolia, builder coverage is far
 * thinner than mainnet, so this can be slower or fail to land — which is why
 * `AEGIS_SUBMISSION_FALLBACK` exists and why the result reports the route that
 * was actually used.
 */
export class FlashbotsPrivateSubmitter implements TransactionSubmitter {
  readonly mode = "private" as const;
  readonly route: string;
  readonly mempoolExposed = false;

  constructor(
    private readonly wallet: Wallet,
    private readonly relayUrl: string,
    private readonly identity: Wallet,
    private readonly maxBlocks: number = 25,
  ) {
    this.route = `Flashbots Protect (${relayUrl})`;
  }

  async submit(tx: TransactionRequest): Promise<SubmissionResult> {
    // Populate and sign locally: the relay receives an already-signed raw
    // transaction and never holds the key.
    const populated = await this.wallet.populateTransaction(tx);
    const rawTx = await this.wallet.signTransaction(populated);

    const currentBlock = await this.wallet.provider!.getBlockNumber();

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendPrivateTransaction",
      params: [
        {
          tx: rawTx,
          maxBlockNumber: "0x" + (currentBlock + this.maxBlocks).toString(16),
          preferences: {
            // Do not fall back to the public mempool: that would silently
            // reintroduce the exposure this route exists to remove.
            fast: false,
            privacy: { builders: ["flashbots"] },
          },
        },
      ],
    });

    const { hashMessage, getBytes, keccak256, toUtf8Bytes } = await import("ethers");
    const signature = await this.identity.signMessage(
      getBytes(keccak256(toUtf8Bytes(body))),
    );
    void hashMessage;

    const response = await fetch(this.relayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Flashbots-Signature": `${this.identity.address}:${signature}`,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Flashbots relay returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as { result?: string; error?: { message: string } };
    if (payload.error) {
      throw new Error(`Flashbots rejected the transaction: ${payload.error.message}`);
    }
    if (!payload.result) {
      throw new Error("Flashbots returned no transaction hash");
    }

    const txHash = payload.result;

    // Private transactions are not in the mempool, so the usual
    // `waitForTransaction` on a public RPC only resolves once mined. Poll the
    // public provider for the receipt rather than assuming success from the
    // relay's acknowledgement — the relay accepting a transaction is not the
    // same as a builder including it.
    const receipt = await this.waitForInclusion(txHash);

    if (receipt.status !== 1) throw new Error(`Transaction ${txHash} reverted`);

    return {
      txHash,
      mode: this.mode,
      route: this.route,
      mempoolExposed: false,
    };
  }

  private async waitForInclusion(txHash: string, timeoutMs = 240_000) {
    const provider = this.wallet.provider!;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }

    throw new Error(
      `Private transaction ${txHash} was accepted by the relay but not included within ` +
        `${timeoutMs / 1000}s. On Sepolia, Flashbots builder coverage is thin; set ` +
        `AEGIS_SUBMISSION_FALLBACK=true to retry publicly, or resubmit.`,
    );
  }
}

/**
 * Build the submitter named by configuration.
 *
 *   AEGIS_SUBMISSION_MODE      public | private   (default: public)
 *   AEGIS_FLASHBOTS_RELAY_URL  override the relay endpoint
 *   AEGIS_FLASHBOTS_IDENTITY_KEY  reputation key; falls back to the submitter
 *
 * Defaults to `public` deliberately. Private submission on Sepolia is
 * best-effort, and a default that can silently fail to land is a worse default
 * than one that is honest about its exposure.
 */
export function createSubmitter(wallet: Wallet): TransactionSubmitter {
  const mode = (process.env.AEGIS_SUBMISSION_MODE ?? "public").trim().toLowerCase();

  if (mode === "private") {
    const relayUrl =
      process.env.AEGIS_FLASHBOTS_RELAY_URL?.trim() || "https://rpc-sepolia.flashbots.net";

    const identityKey = process.env.AEGIS_FLASHBOTS_IDENTITY_KEY?.trim();
    const identity = identityKey
      ? new Wallet(identityKey.startsWith("0x") ? identityKey : `0x${identityKey}`)
      : wallet;

    return new FlashbotsPrivateSubmitter(wallet, relayUrl, identity);
  }

  if (mode !== "public") {
    throw new Error(
      `AEGIS_SUBMISSION_MODE is "${mode}"; expected "public" or "private". ` +
        `Refusing to guess which route was intended.`,
    );
  }

  return new PublicSubmitter(wallet);
}

/**
 * Submit, optionally retrying publicly if the private route fails to land.
 *
 * The fallback is opt-in and always reports the route actually used, so a
 * transaction that ended up in the public mempool is never presented as having
 * been private.
 */
export async function submitWithOptionalFallback(
  submitter: TransactionSubmitter,
  wallet: Wallet,
  tx: TransactionRequest,
): Promise<SubmissionResult> {
  try {
    return await submitter.submit(tx);
  } catch (error) {
    const fallbackEnabled =
      (process.env.AEGIS_SUBMISSION_FALLBACK ?? "").trim().toLowerCase() === "true";

    if (submitter.mode !== "private" || !fallbackEnabled) throw error;

    console.warn(
      `[railgun] private submission failed (${(error as Error).message}); ` +
        `falling back to the PUBLIC mempool because AEGIS_SUBMISSION_FALLBACK=true`,
    );
    return new PublicSubmitter(wallet).submit(tx);
  }
}
