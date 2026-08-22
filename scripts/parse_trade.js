const fs = require('fs');
const path = require('path');

// 1. Read Enclave output from first CLI argument
const enclaveJson = process.argv[2];
if (!enclaveJson) {
  console.error("Usage: node parse_trade.js '<enclave_json>'");
  process.exit(1);
}

try {
  const enclaveResponse = JSON.parse(enclaveJson);
  const allocations = enclaveResponse.allocation;
  if (!allocations) {
    throw new Error("No allocation found in response");
  }

  // Find the highest allocation to buy, and the lowest to sell
  let sellSymbol = null;
  let buySymbol = null;
  let lowestWeight = Infinity;
  let highestWeight = -Infinity;

  for (const [symbol, weight] of Object.entries(allocations)) {
    if (weight < lowestWeight) { lowestWeight = weight; sellSymbol = symbol; }
    if (weight > highestWeight) { highestWeight = weight; buySymbol = symbol; }
  }

  if (!sellSymbol || !buySymbol || sellSymbol === buySymbol) {
    console.log(JSON.stringify({ skip: true, reason: "No trade needed — allocations are equal" }));
    process.exit(0);
  }

  // 2. Read assets.json to map symbols to on-chain addresses
  const assetsPath = path.resolve(__dirname, '../shared/config/assets.json');
  const assetsData = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));

  const sellAsset = assetsData.assets.find(a => a.symbol.toLowerCase() === sellSymbol.toLowerCase());
  const buyAsset = assetsData.assets.find(a => a.symbol.toLowerCase() === buySymbol.toLowerCase());

  if (!sellAsset || !buyAsset) {
    throw new Error(`Could not find assets for ${sellSymbol} or ${buySymbol}`);
  }

  // 3. Get Vault Address from .env
  const envPath = path.resolve(__dirname, '../.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  let vaultAddress = null;
  let alchemyApiKey = null;
  for (const line of envFile.split('\n')) {
    if (line.startsWith('AEGIS_VAULT_ADDRESS=')) {
      vaultAddress = line.split('=')[1].trim();
    }
    if (line.startsWith('ALCHEMY_API_KEY=')) {
      alchemyApiKey = line.split('=')[1].trim();
    }
  }

  if (!vaultAddress) throw new Error("AEGIS_VAULT_ADDRESS not found in .env");

  // 4. Determine RPC URL — use Alchemy if available, else public Sepolia RPC
  const rpcUrl = alchemyApiKey
    ? `https://eth-sepolia.g.alchemy.com/v2/${alchemyApiKey}`
    : "https://ethereum-sepolia-rpc.publicnode.com";

  // 5. Query on-chain balance of the sell token in the Vault
  const execSync = require('child_process').execSync;
  const castBin = process.env.CAST_BIN || `${process.env.HOME}/.foundry/bin/cast`;
  
  let balance = 0n;
  try {
    const balanceHex = execSync(
      `${castBin} call ${sellAsset.address} "balanceOf(address)(uint256)" ${vaultAddress} --rpc-url "${rpcUrl}"`,
      { timeout: 15000 }
    ).toString().trim();
    balance = BigInt(balanceHex);
  } catch (e) {
    // If cast is unavailable or RPC fails, we still emit the trade with a placeholder amount
    console.error(`[parse_trade] Warning: Could not query on-chain balance: ${e.message}`);
    balance = 0n;
  }

  if (balance === 0n) {
    console.log(JSON.stringify({ skip: true, reason: `Vault has 0 balance of ${sellSymbol}` }));
    process.exit(0);
  }

  // 6. Return JSON with the specific params
  const tradeDetails = {
    sellTokenAddress: sellAsset.address,
    buyTokenAddress: buyAsset.address,
    sellAmount: balance.toString(),
    minimumBuyAmount: "1",
  };

  console.log(JSON.stringify(tradeDetails));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
