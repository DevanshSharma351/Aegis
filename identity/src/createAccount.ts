/**
 * Step 1 of the bootstrap: derive the ERC-4337 smart account address.
 *
 * The address is counterfactual — deterministic in (owner, entryPoint,
 * kernelVersion, index) and known before any transaction. That is what lets the
 * vault be deployed, then the account bound, without a chicken-and-egg problem:
 * the account need not exist on-chain to be authorised.
 *
 *   npm run account
 */

import { getOwnerKernelAccount, ownerAccount } from "./clients";
import { ENTRY_POINT, KERNEL_VERSION } from "./clients";
import { networkConfig, updateDeployedConfig } from "./config";

export async function describeAccount() {
  const { account, publicClient } = await getOwnerKernelAccount();
  const owner = ownerAccount();

  const [code, ownerBalance] = await Promise.all([
    publicClient.getCode({ address: account.address }),
    publicClient.getBalance({ address: owner.address }),
  ]);

  const deployed = Boolean(code && code !== "0x");

  return {
    network: networkConfig().network,
    chainId: networkConfig().chainId,
    owner: owner.address,
    ownerBalanceWei: ownerBalance.toString(),
    smartAccount: account.address,
    deployed,
    entryPoint: ENTRY_POINT.address,
    entryPointVersion: ENTRY_POINT.version,
    kernelVersion: KERNEL_VERSION,
  };
}

if (require.main === module) {
  describeAccount()
    .then((info) => {
      console.log("Owner EOA            :", info.owner);
      console.log("Owner balance (wei)  :", info.ownerBalanceWei);
      console.log("Kernel smart account :", info.smartAccount);
      console.log("Deployed on-chain    :", info.deployed);
      console.log("EntryPoint           :", info.entryPoint, `(v${info.entryPointVersion})`);
      console.log("Kernel version       :", info.kernelVersion);

      if (!info.deployed) {
        console.log(
          "\nThe account is counterfactual until its first UserOperation. The address\n" +
            "above is final regardless, so it is safe to bind to the vault now.",
        );
      }

      // Recorded so the deploy script and the pipeline read one value rather
      // than each re-deriving it.
      updateDeployedConfig({ smartAccount: info.smartAccount as `0x${string}` });
      process.exit(0);
    })
    .catch((error) => {
      console.error("[identity] createAccount failed:", error.message);
      process.exit(1);
    });
}
