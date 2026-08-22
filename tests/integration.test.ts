/**
 * Aegis integration tests.
 *
 * Runs the real attestation chain end to end against a local Anvil node:
 *
 *     Python enclave code   computes the decision hash
 *     Python oracle code    verifies a quote and signs the proof
 *     Solidity contracts    verify that proof and record the decision
 *
 * The value is in the seams. Each of those three lives in a different language
 * and reimplements part of the same encoding — keccak domains, ABI packing, the
 * EIP-191 envelope — and a mismatch between any two shows up on-chain as an
 * `UnauthorizedSigner` revert naming a plausible-looking wrong address. These
 * tests fail loudly at the exact seam instead.
 *
 * Anvil rather than Sepolia: fast, free, repeatable, and no faucet dependency.
 * The ERC-4337 leg is deliberately excluded — Pimlico has no Anvil endpoint, so
 * covering it would mean running a local Alto bundler, and what it would prove
 * (that ZeroDev can sign a UserOperation) is not what these tests are for. The
 * account-binding logic it depends on is asserted by scripts/verify_deployment.sh
 * against the live deployment instead.
 *
 * What the previous version of this file did: caught every error, logged a
 * warning, and asserted `expect(true).toBe(true)`. It could not fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import {
  Address,
  Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

const ROOT = path.resolve(__dirname, "..");
const RPC = "http://127.0.0.1:8545";

// Anvil's first deterministic account.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
// Anvil's second, used as the oracle so the two roles are genuinely distinct.
const ORACLE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
// Stands in for the ERC-4337 smart account.
const ACCOUNT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;

const MEASUREMENT = "0x94261f530c8d08cdda5620deecce45120d745a871c9ed96f08ab428de17a1af4" as Hex;

// Custom errors from BOTH contracts are included: a revert raised inside
// AttestationVerifier surfaces through the vault call, and without its error
// definitions viem reports an undecodable selector instead of the actual
// failure. Assertions on revert reasons are only meaningful if the reason can
// be decoded.
const VAULT_ABI = parseAbi([
  "function rebalance(bytes32 decisionHash, bytes attestationProof)",
  "function setSessionKey(address key)",
  "function sessionKey() view returns (address)",
  "function rebalanceCount() view returns (uint256)",
  "function isDecisionExecuted(bytes32) view returns (bool)",
  "event RebalanceExecuted(bytes32 indexed decisionHash, uint256 timestamp, uint256 sequence)",
  "error NotOwner()",
  "error NotSessionKey()",
  "error SessionKeyAlreadySet()",
  "error ZeroAddress()",
  "error NoAssets()",
  "error DecisionAlreadyExecuted(bytes32 decisionHash, uint256 executedAt)",
  "error MalformedProof()",
  "error MalformedSignature()",
  "error AttestationExpired(uint64 expiry, uint256 nowTs)",
  "error MeasurementMismatch(bytes32 expected, bytes32 provided)",
  "error UnauthorizedSigner(address recovered, address expected)",
]);

const python = process.platform === "win32" ? "python" : "python3";

function forge(args: string[]): string {
  return execFileSync("forge", args, {
    cwd: path.join(ROOT, "contracts"),
    encoding: "utf-8",
    env: { ...process.env },
  });
}

function deploy(contract: string, constructorArgs: string[]): Address {
  const out = forge([
    "create",
    contract,
    "--rpc-url",
    RPC,
    "--private-key",
    DEPLOYER_KEY,
    "--broadcast",
    "--constructor-args",
    ...constructorArgs,
  ]);
  const match = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
  if (!match) throw new Error(`Could not parse a deployment address from:\n${out}`);
  return match[1] as Address;
}

/** Compute a decision hash using the enclave's own Python implementation. */
function decisionHashFromPython(decision: object): Hex {
  const script = [
    "import json,sys",
    "sys.path.insert(0, sys.argv[1])",
    "from aegis_tdx import compute_decision_hash",
    "print('0x' + compute_decision_hash(json.loads(sys.argv[2])).hex())",
  ].join("\n");

  return execFileSync(
    python,
    ["-c", script, path.join(ROOT, "shared", "pylib"), JSON.stringify(decision)],
    { encoding: "utf-8" },
  ).trim() as Hex;
}

/** Sign a proof using the oracle's own Python implementation. */
function signProofWithPython(
  decisionHash: Hex,
  measurement: Hex,
  verifier: Address,
  chainId: number,
  validitySeconds = 900,
): Hex {
  const script = [
    "import os,sys",
    "sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])",
    "from signer import sign_attestation",
    "signed = sign_attestation(",
    "  bytes.fromhex(sys.argv[3][2:]), bytes.fromhex(sys.argv[4][2:]),",
    "  int(sys.argv[6]), sys.argv[5], validity_seconds=int(sys.argv[7]))",
    "print('0x' + signed.proof.hex())",
  ].join("\n");

  return execFileSync(
    python,
    [
      "-c",
      script,
      path.join(ROOT, "shared", "pylib"),
      path.join(ROOT, "oracle"),
      decisionHash,
      measurement,
      verifier,
      String(chainId),
      String(validitySeconds),
    ],
    { encoding: "utf-8", env: { ...process.env, AEGIS_ORACLE_PRIVATE_KEY: ORACLE_KEY } },
  ).trim() as Hex;
}

describe("Aegis attestation chain (Anvil)", () => {
  let anvilProcess: ChildProcess;
  let vault: Address;
  let verifier: Address;

  const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) });
  const accountClient = createWalletClient({
    account: privateKeyToAccount(ACCOUNT_KEY),
    chain: anvil,
    transport: http(RPC),
  });
  const deployerClient = createWalletClient({
    account: privateKeyToAccount(DEPLOYER_KEY),
    chain: anvil,
    transport: http(RPC),
  });

  beforeAll(async () => {
    anvilProcess = spawn("anvil", ["--silent", "--port", "8545"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });

    // Poll rather than sleeping a fixed interval.
    for (let i = 0; i < 40; i++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const oracleAddress = privateKeyToAccount(ORACLE_KEY).address;
    verifier = deploy("src/AttestationVerifier.sol:AttestationVerifier", [
      oracleAddress,
      MEASUREMENT,
    ]);

    const weth = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
    const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    vault = deploy("src/AegisVault.sol:AegisVault", [verifier, `[${weth},${usdc}]`]);

    // Bind the SMART ACCOUNT, exactly as the real bootstrap does.
    const hash = await deployerClient.writeContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "setSessionKey",
      args: [privateKeyToAccount(ACCOUNT_KEY).address],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }, 180_000);

  afterAll(() => {
    anvilProcess?.kill();
  });

  it("binds the executing account, not the signing EOA", async () => {
    const bound = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "sessionKey",
    });
    expect(bound.toLowerCase()).toBe(privateKeyToAccount(ACCOUNT_KEY).address.toLowerCase());
  });

  it("accepts a proof signed by the Python oracle", async () => {
    const decision = {
      allocations: { WETH: 0.6, USDC: 0.4 },
      rationale: "WETH momentum positive.",
      confidence: 0.75,
    };

    const decisionHash = decisionHashFromPython(decision);
    expect(decisionHash).toMatch(/^0x[0-9a-f]{64}$/);

    const proof = signProofWithPython(decisionHash, MEASUREMENT, verifier, anvil.id);

    const hash = await accountClient.writeContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "rebalance",
      args: [decisionHash, proof],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe("success");
    expect(
      await publicClient.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "isDecisionExecuted",
        args: [decisionHash],
      }),
    ).toBe(true);
  }, 60_000);

  it("emits only a hash, a timestamp, and a sequence — no amounts", async () => {
    const decision = {
      allocations: { WETH: 0.9, USDC: 0.1 },
      rationale: "Heavy WETH tilt.",
      confidence: 0.9,
    };
    const decisionHash = decisionHashFromPython(decision);
    const proof = signProofWithPython(decisionHash, MEASUREMENT, verifier, anvil.id);

    const hash = await accountClient.writeContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "rebalance",
      args: [decisionHash, proof],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const logs = await publicClient.getContractEvents({
      address: vault,
      abi: VAULT_ABI,
      eventName: "RebalanceExecuted",
      blockHash: receipt.blockHash,
    });

    expect(logs).toHaveLength(1);
    const args = logs[0].args as Record<string, unknown>;

    // The event carries exactly three fields and none of them is an amount.
    expect(Object.keys(args).sort()).toEqual(["decisionHash", "sequence", "timestamp"]);
    expect(args.decisionHash).toBe(decisionHash);

    // The allocation must not be recoverable from the log. 0.9 and 0.1 appear
    // nowhere in the encoded data, in any plausible fixed-point scaling.
    const encoded = (logs[0].data + logs[0].topics.join("")).toLowerCase();
    for (const scaled of [9000n, 1000n, 900n, 100n, 90n, 10n]) {
      expect(encoded).not.toContain(scaled.toString(16).padStart(16, "0"));
    }
  }, 60_000);

  it("rejects a replayed decision", async () => {
    const decision = { allocations: { WETH: 0.5, USDC: 0.5 }, rationale: "Even.", confidence: 0.5 };
    const decisionHash = decisionHashFromPython(decision);
    const proof = signProofWithPython(decisionHash, MEASUREMENT, verifier, anvil.id);

    const first = await accountClient.writeContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "rebalance",
      args: [decisionHash, proof],
    });
    await publicClient.waitForTransactionReceipt({ hash: first });

    // Same proof, still inside its expiry window.
    await expect(
      publicClient.simulateContract({
        account: privateKeyToAccount(ACCOUNT_KEY),
        address: vault,
        abi: VAULT_ABI,
        functionName: "rebalance",
        args: [decisionHash, proof],
      }),
    ).rejects.toThrow(/DecisionAlreadyExecuted/);
  }, 60_000);

  it("rejects a proof naming a different enclave measurement", async () => {
    const decision = { allocations: { WETH: 0.7, USDC: 0.3 }, rationale: "Tilt.", confidence: 0.6 };
    const decisionHash = decisionHashFromPython(decision);

    const rogueMeasurement = ("0x" + "ab".repeat(32)) as Hex;
    const proof = signProofWithPython(decisionHash, rogueMeasurement, verifier, anvil.id);

    await expect(
      publicClient.simulateContract({
        account: privateKeyToAccount(ACCOUNT_KEY),
        address: vault,
        abi: VAULT_ABI,
        functionName: "rebalance",
        args: [decisionHash, proof],
      }),
    ).rejects.toThrow(/MeasurementMismatch/);
  }, 60_000);

  it("rejects a proof minted for a different chain", async () => {
    const decision = { allocations: { WETH: 0.4, USDC: 0.6 }, rationale: "Defensive.", confidence: 0.55 };
    const decisionHash = decisionHashFromPython(decision);

    // Signed as if for Sepolia, submitted on Anvil.
    const proof = signProofWithPython(decisionHash, MEASUREMENT, verifier, 11155111);

    await expect(
      publicClient.simulateContract({
        account: privateKeyToAccount(ACCOUNT_KEY),
        address: vault,
        abi: VAULT_ABI,
        functionName: "rebalance",
        args: [decisionHash, proof],
      }),
    ).rejects.toThrow(/UnauthorizedSigner/);
  }, 60_000);

  it("rejects a caller that is not the bound account", async () => {
    const decision = { allocations: { WETH: 0.3, USDC: 0.7 }, rationale: "Rotate.", confidence: 0.5 };
    const decisionHash = decisionHashFromPython(decision);
    const proof = signProofWithPython(decisionHash, MEASUREMENT, verifier, anvil.id);

    await expect(
      publicClient.simulateContract({
        account: privateKeyToAccount(DEPLOYER_KEY),
        address: vault,
        abi: VAULT_ABI,
        functionName: "rebalance",
        args: [decisionHash, proof],
      }),
    ).rejects.toThrow(/NotSessionKey/);
  }, 60_000);

  it("exposes no function that can move value", async () => {
    // The zero-withdrawal claim, asserted against the deployed bytecode.
    const withdrawalSelectors = [
      "withdraw(uint256)",
      "withdraw(address,uint256)",
      "withdrawAll()",
      "transfer(address,uint256)",
      "transferFrom(address,address,uint256)",
    ];

    for (const signature of withdrawalSelectors) {
      const name = signature.split("(")[0];
      const abi = parseAbi([`function ${signature}`]);

      await expect(
        publicClient.call({
          to: vault,
          data: encodeFunctionData({
            abi,
            functionName: name,
            args: signature.includes(",")
              ? signature.split(",").length === 3
                ? [vault, vault, 1n]
                : [vault, 1n]
              : signature.includes("uint256")
                ? [1n]
                : [],
          } as never),
        }),
      ).rejects.toThrow();
    }

    // And it cannot receive ETH.
    await expect(
      publicClient.call({
        account: privateKeyToAccount(DEPLOYER_KEY),
        to: vault,
        value: 1n,
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("counts every accepted rebalance exactly once", async () => {
    const count = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "rebalanceCount",
    });
    // Three succeeded above; every rejected attempt must have left no trace.
    expect(count).toBe(3n);
  });
});
