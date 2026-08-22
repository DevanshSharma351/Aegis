import { toPermissionValidator } from "@zerodev/permissions";
import { toCallPolicy, toRateLimitPolicy, CallPolicyVersion } from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { constants } from "@zerodev/sdk";
import { Hex, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getAccount } from "./createAccount";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

export type SessionKeyConfiguration = {
  sessionKeyAddress: Hex;
  vaultAddress: Hex;
  permissionId: Hex;
  permissionValidator: Awaited<ReturnType<typeof toPermissionValidator>>;
};

/** Build the validator that restricts the hot key to one zero-value vault call daily. */
export async function createSessionKey(): Promise<SessionKeyConfiguration> {
  const rawPrivateKey = process.env.SESSION_KEY_PRIVATE_KEY as Hex | undefined;
  if (!rawPrivateKey) throw new Error("Missing SESSION_KEY_PRIVATE_KEY");
  const deployedPath = path.resolve(__dirname, "../../../shared/config/deployed.json");
  const { AegisVault: vaultAddress } = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  if (!vaultAddress || !/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
    throw new Error("shared/config/deployed.json does not contain a valid AegisVault address");
  }

  const { publicClient } = await getAccount();
  const sessionAccount = privateKeyToAccount(rawPrivateKey);
  const signer = await toECDSASigner({ signer: sessionAccount });
  const policies = [
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_5,
      permissions: [{
        target: vaultAddress as Hex,
        valueLimit: 0n,
        abi: parseAbi(["function rebalance(bytes32 decisionHash, bytes attestationProof)"]),
        functionName: "rebalance",
      }],
    }),
    toRateLimitPolicy({ count: 1, interval: 86_400 }),
  ];
  const permissionValidator = await toPermissionValidator(publicClient, {
    signer, policies, entryPoint: constants.getEntryPoint("0.7"), kernelVersion: constants.KERNEL_V3_1,
  });
  return { sessionKeyAddress: sessionAccount.address, vaultAddress: vaultAddress as Hex,
    permissionId: permissionValidator.getIdentifier(), permissionValidator };
}

if (require.main === module) {
  createSessionKey().then(({ sessionKeyAddress, vaultAddress, permissionId }) =>
    console.log(JSON.stringify({ sessionKeyAddress, vaultAddress, permissionId }, null, 2)))
    .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
