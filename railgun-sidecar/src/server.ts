import express from 'express';
import { initializeRailgunWallet } from './railgunWallet';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'aegis-railgun-sidecar' });
});

app.post('/shield', async (req, res) => {
  try {
    const { tokenAddress, amount } = req.body;
    // Execute shield recipe logic here
    res.status(200).json({ success: true, message: 'Shield recipe queued' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/unshield-swap-reshield', async (req, res) => {
  try {
    const { sellTokenAddress, buyTokenAddress, sellAmount, minBuyAmount } = req.body;
    // Execute unshield-swap-reshield recipe logic here
    res.status(200).json({ success: true, message: 'Swap recipe queued' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
// BIND ONLY TO LOCALHOST/INTERNAL NETWORK
// In Docker, binding to 0.0.0.0 is needed for internal networking, but the
// docker-compose.yml must ensure no ports are exposed to the host machine.
const HOST = '0.0.0.0';

app.listen(PORT as number, HOST, async () => {
  console.log(`Railgun sidecar listening on http://${HOST}:${PORT}`);
  try {
    await initializeRailgunWallet();
  } catch (e: any) {
    console.error("Failed to initialize Railgun Wallet at startup:", e.message);
  }
});
