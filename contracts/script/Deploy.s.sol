// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AegisVault.sol";
import "../src/AttestationVerifier.sol";

/**
 * @title DeployScript
 * @notice Deploys AttestationVerifier + AegisVault and records the result in
 *         shared/config/deployed.json, which every other workstream reads.
 *
 * Required environment:
 *   DEPLOYER_PRIVATE_KEY   — funded EOA; becomes owner of both contracts.
 *   AEGIS_ORACLE_ADDRESS   — attestation oracle's signing address.
 *   AEGIS_ENCLAVE_MEASUREMENT — bytes32 measurement of the frozen enclave build,
 *                            as printed by `GET /measurement` on the enclave.
 *
 * The measurement is a required input rather than a placeholder constant on
 * purpose: deploying against a measurement nobody has verified is exactly the
 * failure mode this contract exists to prevent. Use scripts/deploy_sepolia.sh,
 * which reads the live value off the enclave before invoking forge.
 */
contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address oracleSigner = vm.envAddress("AEGIS_ORACLE_ADDRESS");
        bytes32 measurement = vm.envBytes32("AEGIS_ENCLAVE_MEASUREMENT");

        address deployer = vm.addr(deployerPrivateKey);

        require(oracleSigner != address(0), "AEGIS_ORACLE_ADDRESS must not be zero");
        require(measurement != bytes32(0), "AEGIS_ENCLAVE_MEASUREMENT must not be zero");

        // --- Read the whitelisted assets from the single source of truth -----
        string memory rootPath = vm.projectRoot();
        string memory assetsPath = string.concat(rootPath, "/../shared/config/assets.json");
        string memory assetsJson = vm.readFile(assetsPath);

        address[] memory assets = abi.decode(vm.parseJson(assetsJson, ".assets[*].address"), (address[]));
        require(assets.length > 0, "assets.json contained no assets");

        console.log("Deployer:        ", deployer);
        console.log("Oracle signer:   ", oracleSigner);
        console.log("Asset count:     ", assets.length);
        console.logBytes32(measurement);

        // --- Deploy ----------------------------------------------------------
        vm.startBroadcast(deployerPrivateKey);

        AttestationVerifier verifier = new AttestationVerifier(oracleSigner, measurement);
        AegisVault vault = new AegisVault(address(verifier), assets);

        vm.stopBroadcast();

        console.log("AttestationVerifier:", address(verifier));
        console.log("AegisVault:         ", address(vault));

        // --- Record for every downstream workstream --------------------------
        // `sessionKey` is intentionally left as the zero address here. It is
        // filled in by identity/src/setVaultSessionKey.ts once the ERC-4337
        // smart account exists — see the bootstrap sequence in identity/README.md.
        string memory obj = "aegis_deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "AegisVault", address(vault));
        vm.serializeAddress(obj, "AttestationVerifier", address(verifier));
        vm.serializeAddress(obj, "oracleSigner", oracleSigner);
        vm.serializeAddress(obj, "sessionKey", address(0));
        vm.serializeString(obj, "attestationSource", vm.envOr("AEGIS_ATTESTATION_SOURCE", string("simulator")));
        string memory finalJson = vm.serializeBytes32(obj, "expectedMeasurement", measurement);

        string memory deployedPath = string.concat(rootPath, "/../shared/config/deployed.json");
        vm.writeJson(finalJson, deployedPath);
        console.log("Wrote", deployedPath);
    }
}
