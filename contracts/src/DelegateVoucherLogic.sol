// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC20 interface for delegate-call voucher tests.
interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Stateless logic for DELEGATECALL vouchers: code runs in the Application
/// context, so `token.transfer` uses the app's balance with `msg.sender == application`.
/// No storage variables — avoids storage layout collisions with the real Application.
contract DelegateVoucherLogic {
    error TargetedVoucherNotAllowed();

    function transferERC20(address token, address to, uint256 amount) external {
        IERC20Transfer(token).transfer(to, amount);
    }

    /// @notice Only `allowedExecutor` may trigger execution (checked against `msg.sender` in the
    /// delegate frame — i.e. whoever submits `executeOutput` on L1). Calldata commits the allowed
    /// address; no extra storage in the Application.
    function transferERC20Targeted(
        address token,
        address to,
        uint256 amount,
        address allowedExecutor
    ) external {
        if (msg.sender != allowedExecutor) revert TargetedVoucherNotAllowed();
        IERC20Transfer(token).transfer(to, amount);
    }
}
