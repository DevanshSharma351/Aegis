// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AegisVault.sol";
import "../src/AttestationVerifier.sol";

contract DeployScript is Script {
    function run() external {
        // Read deployer key from env
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);

        // 1. Read whitelisted assets from shared/config/assets.json
        string memory rootPath = vm.projectRoot();
        string memory assetsPath = string.concat(rootPath, "/../shared/config/assets.json");
        string memory assetsJson = vm.readFile(assetsPath);
        
        // Parse the addresses array from the JSON
        bytes memory rawAddresses = vm.parseJson(assetsJson, ".assets[*].address");
        address[] memory assets = abi.decode(rawAddresses, (address[]));

        // 2. Deploy AttestationVerifier with a mock measurement for now
        // This will be replaced with the real measurement in Workstream A finalization
        bytes32 mockMeasurement = keccak256("MOCK_ENCLAVE_MEASUREMENT");
        AttestationVerifier verifier = new AttestationVerifier(mockMeasurement);
        console.log("Deployed AttestationVerifier at:", address(verifier));

        // 3. Deploy AegisVault
        AegisVault vault = new AegisVault(address(verifier), assets);
        console.log("Deployed AegisVault at:", address(vault));

        vm.stopBroadcast();

        // 4. Write deployed addresses to shared/config/deployed.json
        string memory deployedPath = string.concat(rootPath, "/../shared/config/deployed.json");
        
        string memory obj = "deployed_addresses";
        vm.serializeAddress(obj, "AegisVault", address(vault));
        string memory finalJson = vm.serializeAddress(obj, "AttestationVerifier", address(verifier));
        
        vm.writeJson(finalJson, deployedPath);
        console.log("Wrote deployed addresses to:", deployedPath);
    }
}
