/**
 * Withdrawal voucher tests — verifies all five withdrawal types and mint_erc721.
 * Relies on deposits made in suite 01 to pre-load the dapp's internal balances.
 *
 * Voucher destinations:
 *   eth_withdraw          → receiver (direct ETH send, v2 pattern)
 *   erc20_withdraw        → ERC20 token contract (transfer to receiver)
 *   erc721_withdraw       → ERC721 token contract (safeTransferFrom)
 *   erc1155_withdraw_*    → ERC1155 token contract (safeTransferFrom / safeBatchTransferFrom)
 *   mint_erc721           → MintableERC721 contract (mint to receiver)
 *   delegate_erc20_transfer → DelegateVoucherLogic (DELEGATECALL voucher; ERC20 transfer)
 *   delegate_erc20_transfer_targeted → same + only allowedExecutor may execute on L1
 */

import { parseEther } from 'viem';

import {
  ADDR, deployer,
  sendAdvance, pollInput,
  noticeCount, voucherCount, voucherDest,
  uint256hex,
} from '../helpers.js';

describe('Withdrawals', () => {
  test('eth_withdraw (0.1 ETH) — ACCEPTED, voucher to receiver', async () => {
    const idx = await sendAdvance({
      cmd:      'eth_withdraw',
      receiver: deployer,
      amount:   uint256hex(parseEther('0.1')),
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(voucherDest(input, 0)).toBe(deployer.toLowerCase());
  });

  test('erc20_withdraw (10 tokens) — ACCEPTED, voucher to ERC20 token', async () => {
    const idx = await sendAdvance({
      cmd:      'erc20_withdraw',
      token:    ADDR.TEST_ERC20(),
      receiver: deployer,
      amount:   uint256hex(parseEther('10')),
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(voucherDest(input, 0)).toBe(ADDR.TEST_ERC20().toLowerCase());
  });

  test('erc721_withdraw (tokenId=1) — ACCEPTED, voucher to ERC721 token', async () => {
    const idx = await sendAdvance({
      cmd:      'erc721_withdraw',
      token:    ADDR.TEST_ERC721(),
      receiver: deployer,
      tokenId:  uint256hex(1n),
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(voucherDest(input, 0)).toBe(ADDR.TEST_ERC721().toLowerCase());
  });

  test('erc1155_withdraw_single (id=1, amount=25) — ACCEPTED, voucher to ERC1155 token', async () => {
    const idx = await sendAdvance({
      cmd:      'erc1155_withdraw_single',
      token:    ADDR.TEST_ERC1155(),
      receiver: deployer,
      id:       uint256hex(1n),
      amount:   uint256hex(25n),
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(voucherDest(input, 0)).toBe(ADDR.TEST_ERC1155().toLowerCase());
  });

  test('erc1155_withdraw_batch (ids=[1,2], amounts=[5,10]) — ACCEPTED, voucher to ERC1155 token', async () => {
    const idx = await sendAdvance({
      cmd:      'erc1155_withdraw_batch',
      token:    ADDR.TEST_ERC1155(),
      receiver: deployer,
      ids:      [uint256hex(1n), uint256hex(2n)],
      amounts:  [uint256hex(5n), uint256hex(10n)],
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(voucherDest(input, 0)).toBe(ADDR.TEST_ERC1155().toLowerCase());
  });

  test('mint_erc721 (tokenId=100) — ACCEPTED, voucher to MintableERC721', async () => {
    const idx = await sendAdvance({
      cmd:      'mint_erc721',
      receiver: deployer,
      tokenId:  uint256hex(100n),
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(voucherDest(input, 0)).toBe(ADDR.MINTABLE_ERC721().toLowerCase());
  });

  test('delegate_erc20_transfer — ACCEPTED, DelegateCallVoucher to logic contract', async () => {
    const idx = await sendAdvance({
      cmd:      'delegate_erc20_transfer',
      logic:    ADDR.DELEGATE_VOUCHER_LOGIC(),
      token:    ADDR.TEST_ERC20(),
      receiver: deployer,
      amount:   uint256hex(parseEther('1')),
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(input.vouchers[0]?.decodedData?.type).toBe('DelegateCallVoucher');
    expect(voucherDest(input, 0)).toBe(ADDR.DELEGATE_VOUCHER_LOGIC().toLowerCase());
  });

  test('delegate_erc20_transfer_targeted — ACCEPTED, DelegateCallVoucher', async () => {
    const idx = await sendAdvance({
      cmd:              'delegate_erc20_transfer_targeted',
      logic:            ADDR.DELEGATE_VOUCHER_LOGIC(),
      token:            ADDR.TEST_ERC20(),
      receiver:         deployer,
      amount:           uint256hex(parseEther('1')),
      allowedExecutor:  deployer,
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
    expect(input.vouchers[0]?.decodedData?.type).toBe('DelegateCallVoucher');
    expect(voucherDest(input, 0)).toBe(ADDR.DELEGATE_VOUCHER_LOGIC().toLowerCase());
  });
});
