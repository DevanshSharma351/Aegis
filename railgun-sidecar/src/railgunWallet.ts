import { 
  startRailgunEngine, 
  loadProvider,
  createRailgunWallet,
  setLoggers
} from '@railgun-community/wallet';
import { FallbackProviderJsonConfig, NetworkName } from '@railgun-community/shared-models';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load env from root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export async function initializeRailgunWallet() {
  const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
  if (!ALCHEMY_API_KEY) throw new Error("Missing ALCHEMY_API_KEY");

  // 1. Initialize Engine
  // LevelDB local storage
  const dbPath = path.resolve(__dirname, '../engine.db');
  if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });

  setLoggers(
    (msg: string) => {}, // Suppress verbose Engine logs
    (err: string) => console.error("Railgun Engine Error:", err)
  );

  const shouldDebug = false;
  const artifactStore: any = undefined; // Will use default memory store
  const useNativeArtifacts = false; // Set to true if using downloaded circuits
  const skipMerkletreeScans = false;

  await startRailgunEngine(
    dbPath,
    dbPath, // fsDb (can be same)
    shouldDebug,
    artifactStore,
    useNativeArtifacts,
    skipMerkletreeScans
  );

  console.log("Railgun Engine Initialized.");

  // 2. Load Provider (Sepolia)
  const fallbackProviderConfig: FallbackProviderJsonConfig = {
    chainId: 11155111, // Sepolia
    providers: [
      {
        provider: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        priority: 1,
        weight: 1,
      }
    ]
  };

  await loadProvider(
    fallbackProviderConfig,
    NetworkName.EthereumSepolia
  );

  // 3. Initialize Wallet
  const mnemonic = process.env.RAILGUN_WALLET_MNEMONIC;
  if (!mnemonic) {
    throw new Error("Missing RAILGUN_WALLET_MNEMONIC in environment.");
  }

  const creationBlockNumberMap = {
    [NetworkName.EthereumSepolia]: 0 // Best to use the actual block the wallet was funded if known
  };

  const walletInfo = await createRailgunWallet(
    'aegis_engine', // encryption key
    mnemonic,
    creationBlockNumberMap
  );

  console.log(`Railgun Wallet Initialized.`);
  console.log(`0zk Address: ${walletInfo.railgunAddress}`);

  return { walletInfo };
}
