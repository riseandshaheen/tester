// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {TestERC20}      from "../src/TestERC20.sol";
import {TestERC721}     from "../src/TestERC721.sol";
import {TestERC1155}    from "../src/TestERC1155.sol";
import {MintableERC721}      from "../src/MintableERC721.sol";
import {DelegateVoucherLogic} from "../src/DelegateVoucherLogic.sol";

/// @notice Deploys the three test-specific token contracts and wires up roles.
///
/// `cartesi run` already provides TestToken (ERC20), TestNFT (ERC721), and
/// TestMultiToken (ERC1155) — this script only deploys what those don't cover:
///   • TestERC721    — mintable ERC721 we fully control (token IDs 1-5 pre-minted)
///   • TestERC1155   — mintable ERC1155 with TOKEN_A/B/C/D pre-minted
///   • MintableERC721      — ERC721 gated by MINTER_ROLE (for voucher-mint tests)
///   • DelegateVoucherLogic — no-storage helper for DELEGATECALL voucher tests
///
/// Required env vars:
///   CARTESI_APP_ADDRESS  — shown by `cartesi run` or `cartesi address-book`
///   PRIVATE_KEY          — Anvil default: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// Usage (while `cartesi run` is running):
///   forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast -vv
contract Deploy is Script {
    function run() external {
        address cartesiApp  = vm.envAddress("CARTESI_APP_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        TestERC20      erc20   = new TestERC20();
        TestERC721     nft721  = new TestERC721();
        TestERC1155    nft1155 = new TestERC1155();
        MintableERC721      mintNft   = new MintableERC721();
        DelegateVoucherLogic delLogic = new DelegateVoucherLogic();

        // Grant the Cartesi app the right to call mintNft.mint() via vouchers
        mintNft.grantMinterRole(cartesiApp);

        // Pre-mint tokens so tests can deposit immediately
        erc20.mint(deployer, 100_000 ether);
        for (uint256 i = 1; i <= 5; i++) nft721.mint(deployer, i);
        nft1155.mintAll(deployer, 1000, 1000, 1000, 1000);

        vm.stopBroadcast();

        console.log("=== Deployed ===");
        console.log("TestERC20:     ", address(erc20));
        console.log("TestERC721:    ", address(nft721));
        console.log("TestERC1155:   ", address(nft1155));
        console.log("MintableERC721:      ", address(mintNft));
        console.log("DelegateVoucherLogic:", address(delLogic));
        console.log("Cartesi app:         ", cartesiApp);
    }
}
