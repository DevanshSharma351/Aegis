# Aegis Enclave

The enclave service is the compute/TEE workstream of Aegis. It runs a quantitative
signal pipeline followed by a small language model (SLM) allocation layer, all inside
a Trusted Execution Environment (dstack/Intel TDX), and produces hardware-backed
attestation proofs for every rebalance decision.

## Architecture

```
CoinGecko OHLC ──▶ signal.py (MA + z-score) ──▶ model.py (Ollama SLM) ──▶ attestation.py (dstack quote)
                                                                              │
                                                                              ▼
                                                                    POST /rebalance response
```

## Running Locally (with dstack simulator)

### Prerequisites

1. **Python 3.11+** installed
2. **Ollama** installed and running (`ollama serve`)
3. **llama3.2:1b** model pulled (`ollama pull llama3.2:1b`)
4. **dstack simulator** running (for attestation)

### Step-by-step

```bash
# 1. Install the dstack TEE simulator
#    See: https://github.com/Dstack-TEE/dstack
#    The simulator provides a local endpoint that mimics TDX quote generation.
docker run -d --name dstack-simulator -p 8090:8090 phalanetwork/dstack-simulator:latest

# 2. Set environment variables
export DSTACK_SIMULATOR_ENDPOINT=http://localhost:8090  # For docker container, or /path/to/tappd.sock if running locally natively
export OLLAMA_HOST=http://localhost:11434
export COINGECKO_API_KEY=your_demo_key_here  # optional, free tier works without

# 3. Install Python dependencies
cd enclave
pip install -r requirements.txt

# 4. Start Ollama (if not already running)
ollama serve &

# 5. Run the enclave
python main.py
# Server starts on http://localhost:8000

# 6. Test health endpoint
curl http://localhost:8000/health

# 7. Trigger a rebalance
curl -X POST http://localhost:8000/rebalance
```

### Using WSL2

If running on Windows via WSL2, ensure:
- Ollama is running inside WSL2 (not the Windows host)
- Docker is accessible from within WSL2
- The dstack simulator container is reachable at `localhost:8090` from WSL2

## Example `/rebalance` Response

```json
{
  "allocation": {
    "WETH": 0.65,
    "USDC": 0.35
  },
  "rationale": "WETH exhibits bullish SMA crossover with positive z-score momentum.",
  "confidence": 0.72,
  "signals": {
    "WETH": {
      "close": 2045.123456,
      "sma_short": 2038.5,
      "sma_long": 2015.2,
      "sma_crossover": "bullish",
      "zscore": 0.6823,
      "momentum": "mild_up",
      "candle_count": 42
    },
    "USDC": {
      "close": 1.0001,
      "sma_short": 1.0,
      "sma_long": 1.0,
      "sma_crossover": "neutral",
      "zscore": 0.012,
      "momentum": "neutral",
      "candle_count": 42
    }
  },
  "attestation": {
    "quote": "a1b2c3d4e5f6...hex-encoded-tdx-quote...",
    "report_data_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "event_log": "attested decision e3b0c44298fc1c14... at TEE"
  }
}
```

## Attestation & Measurement

The TEE attestation is the cryptographic proof that this exact code produced the
rebalance decision. Here's how it works:

**How measurement changes if the image changes:** The TEE hardware computes a
measurement hash (MRTD for TDX, or RTMR registers) over the entire container
image at launch time. This measurement covers every layer of the Docker image —
including the Python code, the Ollama binary, and critically the model weights
(which are pulled at build time and baked into the image, see the Dockerfile).
If *any* file in the image changes — a single line of Python, a dependency
upgrade, or a different model checkpoint — the measurement hash changes. The
on-chain `AttestationVerifier` contract stores the expected measurement; any
quote presenting a different measurement will be rejected. This means there is
no way to modify the trading logic, the model, or any dependency without the
change being cryptographically visible on-chain. Rebuilding the image after a
code change requires updating the `expectedMeasurement` in the verifier contract,
which is itself an on-chain transaction that creates a permanent audit trail.

## Running Tests

```bash
cd enclave
pip install -r requirements.txt

# Run all tests (dstack simulator tests will be skipped if not running)
pytest tests/ -v

# Run with the dstack simulator (using the docker image or native unix socket)
DSTACK_SIMULATOR_ENDPOINT=http://localhost:8090 pytest tests/ -v
# OR if running natively in WSL / tmp:
# DSTACK_SIMULATOR_ENDPOINT=/tmp/dstack_run2/tappd.sock pytest tests/ -v

# Run individual test files
pytest tests/test_signal.py -v
pytest tests/test_model_schema.py -v
pytest tests/test_attestation.py -v
```

## Files

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app: `GET /health`, `POST /rebalance` |
| `quant/data_feed.py` | CoinGecko OHLC data fetcher for whitelisted assets |
| `quant/signal.py` | Deterministic layer: moving averages + z-score |
| `quant/model.py` | SLM layer: Ollama llama3.2:1b allocation + rationale |
| `attestation.py` | dstack TEE quote wrapper |
| `session_key_client.py` | Stub for calling identity/ to submit userOps (Workstream B) |
| `Dockerfile` | TEE-ready image with model weights baked in |
| `requirements.txt` | Pinned Python dependencies |
