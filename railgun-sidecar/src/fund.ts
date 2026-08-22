/**
 * Fund the Railgun submitter and shield a starting balance.
 *
 * Sepolia WETH has a `deposit()` function, so ETH can be wrapped directly
 * rather than sourced from a faucet. USDC cannot be minted this way — but the
 * pipeline only ever *sells* WETH and *buys* USDC, so WETH is the only asset
 * that needs seeding.
 *
 *   cd railgun-sidecar
 *   npm run fund -- wrap 0.02        wrap ETH into WETH
 *   npm run fund -- balances         show public and shielded balances
 *   npm run fund -- shield 0.005     print the shield call for the sidecar
 */

import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, parseEther } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

const ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, "")) as T;
}

const network = readJson<any>(path.join(ROOT, "shared/config/network.json"));
const assets = readJson<any>(path.join(ROOT, "shared/config/assets.json")).assets;

const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];

function rpcUrl(): string {
  if (process.env.AEGIS_RPC_URL) return process.env.AEGIS_RPC_URL;
  if (process.env.ALCHEMY_API_KEY) {
    return network.rpc.alchemyUrlTemplate.replace("{key}", process.env.ALCHEMY_API_KEY);
  }
  return network.rpc.fallbackUrls[0];
}

function signer(): Wallet {
  const key = process.env.RAILGUN_TEST_SIGNER_KEY;
  if (!key) throw new Error("RAILGUN_TEST_SIGNER_KEY is not set");
  return new Wallet(
    key.startsWith("0x") ? key : `0x${key}`,
    new JsonRpcProvider(rpcUrl(), network.chainId),
  );
}

function asset(symbol: string) {
  const found = assets.find((a: any) => a.symbol === symbol);
  if (!found) throw new Error(`${symbol} is not whitelisted`);
  return found;
}

async function showBalances() {
  const wallet = signer();
  const eth = await wallet.provider!.getBalance(wallet.address);

  console.log(`submitter ${wallet.address}`);
  console.log(`  ETH  ${formatEther(eth)}`);

  for (const a of assets) {
    const token = new Contract(a.address, ERC20_ABI, wallet);
    const balance: bigint = await token.balanceOf(wallet.address);
    console.log(`  ${a.symbol.padEnd(4)} ${formatUnits(balance, a.decimals)}`);
  }

  // Shielded balances live in the sidecar, which is internal-only. Reaching it
  // requires going through a container on the internal network, so this is a
  // pointer rather than a live read.
  console.log("\nShielded balances (sidecar is internal-only):");
  console.log("  docker compose exec -T enclave curl -s http://railgun-sidecar:8080/balances");
}

async function wrap(amountEth: string) {
  const wallet = signer();
  const weth = asset("WETH");
  const amount = parseEther(amountEth);

  const balance = await wallet.provider!.getBalance(wallet.address);

  // Leave headroom for gas: wrapping the entire balance leaves nothing to pay
  // for the shield transaction that follows, and the failure would only appear
  // one step later.
  const reserve = parseEther("0.01");
  if (balance < amount + reserve) {
    throw new Error(
      `Balance ${formatEther(balance)} ETH is too low to wrap ${amountEth} and keep ` +
        `${formatEther(reserve)} for gas. Top up at https://sepoliafaucet.com`,
    );
  }

  console.log(`Wrapping ${amountEth} ETH into WETH...`);
  const contract = new Contract(weth.address, WETH_ABI, wallet);
  const tx = await contract.deposit({ value: amount });
  console.log(`  tx ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`  mined in block ${receipt?.blockNumber}`);

  const wethBalance: bigint = await contract.balanceOf(wallet.address);
  console.log(`  WETH balance now ${formatUnits(wethBalance, 18)}`);
  console.log(`  ${network.blockExplorer}/tx/${tx.hash}`);
}

async function shield(amountEth: string) {
  const amount = parseEther(amountEth);
  console.log(
    `Shielding ${amountEth} WETH (${amount} base units).\n` +
      `The sidecar is internal-only, so this runs through the enclave container:\n`,
  );
  console.log(
    `  docker compose exec -T enclave curl -s -X POST http://railgun-sidecar:8080/shield \\\n` +
      `    -H 'Content-Type: application/json' \\\n` +
      `    -d '{"token":"WETH","amount":"${amount}"}'\n`,
  );
}

async function main() {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case "balances":
      return showBalances();
    case "wrap":
      if (!argument) throw new Error("usage: wrap <amountEth>");
      return wrap(argument);
    case "shield":
      if (!argument) throw new Error("usage: shield <amountEth>");
      return shield(argument);
    default:
      console.log("usage: npm run fund -- <balances|wrap <eth>|shield <eth>>");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("error:", error.message);
  process.exit(1);
});
