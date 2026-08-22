/**
 * Print the live on-chain state of the deployment as JSON.
 *
 * Backs scripts/verify_deployment.sh, which needs the same values the identity
 * service reports and should not reimplement the reads in bash + cast.
 *
 *   npm run state
 */

import { deployedConfig, networkConfig } from "./config";
import { loadSessionKeyAccount } from "./sessionKey";
import { readVaultState, readVerifierState } from "./vault";

export async function collectState() {
  const [vault, verifier] = await Promise.all([readVaultState(), readVerifierState()]);

  let smartAccount: string | null = null;
  let approvalError: string | null = null;
  try {
    smartAccount = (await loadSessionKeyAccount()).account.address;
  } catch (error) {
    approvalError = (error as Error).message;
  }

  const deployed = deployedConfig();

  return {
    network: networkConfig().network,
    chainId: networkConfig().chainId,
    smartAccount,
    approvalError,
    vault: {
      address: vault.address,
      owner: vault.owner,
      attestationVerifier: vault.attestationVerifier,
      sessionKey: vault.sessionKey,
      sessionKeySet: vault.sessionKeySet,
      rebalanceCount: vault.rebalanceCount.toString(),
      lastRebalanceAt: vault.lastRebalanceAt.toString(),
      whitelistedAssets: vault.whitelistedAssets,
    },
    verifier: {
      address: verifier.address,
      owner: verifier.owner,
      oracleSigner: verifier.oracleSigner,
      expectedMeasurement: verifier.expectedMeasurement,
    },
    checks: {
      // Each of these is a way the deployment can be subtly wrong while every
      // individual component looks healthy.
      sessionKeyBound: vault.sessionKeySet,
      sessionKeyMatchesSmartAccount:
        smartAccount !== null &&
        vault.sessionKey.toLowerCase() === smartAccount.toLowerCase(),
      vaultPointsAtVerifier:
        vault.attestationVerifier.toLowerCase() === verifier.address.toLowerCase(),
      deployedJsonMatchesChain:
        (deployed.AegisVault ?? "").toLowerCase() === vault.address.toLowerCase() &&
        (deployed.AttestationVerifier ?? "").toLowerCase() === verifier.address.toLowerCase(),
      oracleMatchesDeployedJson:
        (deployed.oracleSigner ?? "").toLowerCase() === verifier.oracleSigner.toLowerCase(),
      measurementMatchesDeployedJson:
        (deployed.expectedMeasurement ?? "").toLowerCase() ===
        verifier.expectedMeasurement.toLowerCase(),
    },
  };
}

if (require.main === module) {
  collectState()
    .then((state) => {
      console.log(JSON.stringify(state, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message }, null, 2));
      process.exit(1);
    });
}
