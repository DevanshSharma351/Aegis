import { getAccount } from "./createAccount";
import { createSessionKey } from "./createSessionKey";
import { Hex, createWalletClient, http } from "viem";
import { sepolia } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

export async function setVaultSessionKey() {
  const { signer, publicClient } = await getAccount();
  const { sessionKeyAddress } = await createSessionKey();

  const deployedPath = path.resolve(__dirname, "../../../shared/config/deployed.json");
  const deployedConfig = JSON.parse(fs.readFileSync(deployedPath, "utf-8"));
  const vaultAddress = deployedConfig.AegisVault;

  console.log("\n=======================================================");
  console.log("WARNING: You are about to bind a session key to the AegisVault.");
  console.log("This action is IRREVERSIBLE and can only be performed ONCE.");
  console.log(`Vault Address: ${vaultAddress}`);
  console.log(`Session Key Address: ${sessionKeyAddress}`);
  console.log("=======================================================\n");

  rl.question("Do you wish to proceed? (yes/no): ", async (answer) => {
    if (answer.toLowerCase() === "yes" || answer.toLowerCase() === "y") {
      const walletClient = createWalletClient({
        account: signer,
        chain: sepolia,
        transport: http(publicClient.transport.url)
      });

      console.log("Sending transaction...");
      
      const vaultAbi = [
        {
          "type": "function",
          "name": "setSessionKey",
          "inputs": [{"name": "_sessionKey", "type": "address"}],
          "outputs": [],
          "stateMutability": "nonpayable"
        }
      ];

      try {
        const { request } = await publicClient.simulateContract({
          account: signer,
          address: vaultAddress as Hex,
          abi: vaultAbi,
          functionName: "setSessionKey",
          args: [sessionKeyAddress as Hex]
        });

        const txHash = await walletClient.writeContract(request);
        console.log(`Transaction submitted! Hash: ${txHash}`);
        
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(`Transaction mined in block ${receipt.blockNumber}`);
      } catch (err: any) {
        console.error("Failed to set session key. Note: It may have already been set, as this is a one-time operation.");
        console.error(err.shortMessage || err.message);
      }
    } else {
      console.log("Operation cancelled.");
    }
    rl.close();
  });
}

// If run directly
if (require.main === module) {
  setVaultSessionKey();
}
