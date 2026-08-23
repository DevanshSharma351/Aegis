/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by scripts/sync_frontend_config.py from shared/config and shared/abi.
 * Re-run that script after any deployment or contract change.
 *
 * Snapshotting rather than importing across the repo boundary keeps shared/ as
 * the single source of truth while letting the frontend build on its own.
 */

export const CHAIN_ID = 11155111 as const;
export const BLOCK_EXPLORER = "https://sepolia.etherscan.io" as const;

/**
 * Block the contracts were deployed in. Bounds every log query.
 *
 * `BigInt("...")` rather than a `123n` literal: the literal form requires a
 * compile target of ES2020+, and this file is consumed by a Next.js app whose
 * tsconfig is not ours to depend on.
 */
export const DEPLOYED_AT_BLOCK = BigInt("11547873");

export const ADDRESSES = {
  aegisVault: "0x518D2de68f1088a04a1F3a5Ea6360f357f80878d",
  attestationVerifier: "0xCEe775680Ca45192F00181643DAba9A18150059B",
  oracleSigner: "0x0212AdAc560383416B4973Ded96c35Dcb912531A",
  smartAccount: "0x61e7eDBD1C14C7F0B14513958e94d9f58770E662",
  sessionKey: "0x61e7eDBD1C14C7F0B14513958e94d9f58770E662",
} as const;

/**
 * The enclave measurement this deployment was built against.
 *
 * Compared client-side against AttestationVerifier.expectedMeasurement() read
 * live from chain. A mismatch means the enclave was rebuilt without rotating the
 * on-chain constant, and the UI says so rather than showing a green tick.
 */
export const EXPECTED_MEASUREMENT = "0x94261f530c8d08cdda5620deecce45120d745a871c9ed96f08ab428de17a1af4" as const;

/**
 * Whether the recorded attestation came from real TDX hardware or the dstack
 * simulator. Surfaced verbatim in the UI: a simulator quote exercises every code
 * path but proves nothing about hardware, and presenting it as hardware
 * attestation would be a lie.
 */
export const ATTESTATION_SOURCE = "simulator" as const;

export const ASSETS = [
  {
    "symbol": "WETH",
    "name": "Wrapped Ether",
    "address": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    "decimals": 18
  },
  {
    "symbol": "USDC",
    "name": "USD Coin",
    "address": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    "decimals": 6
  },
  {
    "symbol": "DAI",
    "name": "Dai Stablecoin",
    "address": "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",
    "decimals": 18
  },
  {
    "symbol": "LINK",
    "name": "Chainlink",
    "address": "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    "decimals": 18
  },
  {
    "symbol": "UNI",
    "name": "Uniswap",
    "address": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    "decimals": 18
  }
] as const;

export const SESSION_KEY_POLICY = {
  "maxExecutionsPerDay": 10,
  "rateLimitIntervalSeconds": 86400,
  "valueLimitWei": "0",
  "withdrawalPermissions": "NONE",
  "allowedSelectors": [
    {
      "selector": "0xe7ef57de",
      "signature": "rebalance(bytes32,bytes)",
      "target": "AegisVault",
      "note": "The only function the session key may call, on the only contract it may call."
    }
  ]
} as const;

export const AEGIS_VAULT_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "_verifier",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "attestationVerifier",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract AttestationVerifier"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "executedAt",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isDecisionExecuted",
    "inputs": [
      {
        "name": "decisionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "lastRebalanceAt",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rebalance",
    "inputs": [
      {
        "name": "decisionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "attestationProof",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "rebalanceCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sessionKey",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sessionKeySet",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setSessionKey",
    "inputs": [
      {
        "name": "_sessionKey",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "whitelistedAssetAt",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "whitelistedAssets",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "whitelistedAssetsLength",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "RebalanceExecuted",
    "inputs": [
      {
        "name": "decisionHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "timestamp",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "sequence",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "hardwareVerified",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SessionKeyBound",
    "inputs": [
      {
        "name": "sessionKey",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "DecisionAlreadyExecuted",
    "inputs": [
      {
        "name": "decisionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "executedAt",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoAssets",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSessionKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SessionKeyAlreadySet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;

export const ATTESTATION_VERIFIER_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "_oracleSigner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_expectedMeasurement",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ATTESTATION_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "attestationDigest",
    "inputs": [
      {
        "name": "decisionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "measurement",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "hardwareVerified",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "expectedMeasurement",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "oracleSigner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "requireHardware",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setExpectedMeasurement",
    "inputs": [
      {
        "name": "_measurement",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setRequireHardware",
    "inputs": [
      {
        "name": "value",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "verify",
    "inputs": [
      {
        "name": "decisionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "attestationProof",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "hardwareVerified",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ExpectedMeasurementUpdated",
    "inputs": [
      {
        "name": "previous",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "current",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previous",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "current",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RequireHardwareUpdated",
    "inputs": [
      {
        "name": "previous",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "current",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AttestationExpired",
    "inputs": [
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "nowTs",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "HardwareAttestationRequired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MalformedProof",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MalformedSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MeasurementMismatch",
    "inputs": [
      {
        "name": "expected",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "provided",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnauthorizedSigner",
    "inputs": [
      {
        "name": "recovered",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expected",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
