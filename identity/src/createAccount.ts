import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { Hex, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env for local development — inside Docker, env vars are injected by compose
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export async function getAccount() {
  const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
  const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY;
  const AEGIS_OWNER_PRIVATE_KEY = process.env.AEGIS_OWNER_PRIVATE_KEY as Hex;

  if (!PIMLICO_API_KEY || !AEGIS_OWNER_PRIVATE_KEY) {
    throw new Error(
      "Missing required environment variables: PIMLICO_API_KEY, AEGIS_OWNER_PRIVATE_KEY"
    );
  }

  const BUNDLER_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;
  const PAYMASTER_URL = BUNDLER_URL; // Pimlico serves both on the same endpoint

  const rpcUrl = ALCHEMY_API_KEY
    ? `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
    : "https://ethereum-sepolia-rpc.publicnode.com";

  // Fallback RPC list — tried in order if the primary fails DNS resolution (common in WSL2 Docker)
  const fallbackRpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";

  console.log(`[identity-debug] rpcUrl: "${rpcUrl}"`);
  console.log(`[identity-debug] BUNDLER_URL: "${BUNDLER_URL}"`);

  // Try primary RPC, fall back to public node on connection error
  async function createPublicClientWithFallback() {
    try {
      const client = createPublicClient({ transport: http(rpcUrl), chain: sepolia });
      await client.getChainId(); // probe
      console.log(`[identity-debug] Connected to primary RPC: ${rpcUrl}`);
      return client;
    } catch (e: any) {
      if (rpcUrl === fallbackRpcUrl) throw e;
      console.warn(`[identity-debug] Primary RPC failed (${e?.cause?.code ?? e?.message}), falling back to public node...`);
      const client = createPublicClient({ transport: http(fallbackRpcUrl), chain: sepolia });
      console.log(`[identity-debug] Connected to fallback RPC: ${fallbackRpcUrl}`);
      return client;
    }
  }

  const publicClient = await createPublicClientWithFallback();

  const signer = privateKeyToAccount(AEGIS_OWNER_PRIVATE_KEY);

  // ZeroDev SDK v5 requires explicit entryPoint + kernelVersion
  const { constants } = await import("@zerodev/sdk");
  const entryPoint = constants.getEntryPoint("0.7");
  const kernelVersion = constants.KERNEL_V3_1;

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer,
    entryPoint,
    kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion,
  });

  const { createZeroDevPaymasterClient } = await import("@zerodev/sdk");
  const { createPimlicoBundlerClient } = await import("permissionless/clients/pimlico");
  
  const pimlicoBundlerClient = createPimlicoBundlerClient({
    transport: http(BUNDLER_URL),
    chain: sepolia,
  });
  
  const paymasterClient = createZeroDevPaymasterClient({
    chain: sepolia,
    transport: http(PAYMASTER_URL),
  });

  const kernelClient = createKernelAccountClient({
    account,
    chain: sepolia,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () => {
        const gasPrice = await pimlicoBundlerClient.getUserOperationGasPrice();
        return {
          maxFeePerGas: gasPrice.fast.maxFeePerGas,
          maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
        };
      },
    },
  });

  return { account, kernelClient, publicClient, signer, PAYMASTER_URL, BUNDLER_URL };
}

// If run directly — print the smart account address
if (require.main === module) {
  getAccount()
    .then(({ account }) => {
      console.log("Kernel Smart Account Address:", account.address);
    })
    .catch(console.error);
}
