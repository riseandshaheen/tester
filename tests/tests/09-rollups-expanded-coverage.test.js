/**
 * Tier 1 & 2 (ROLLUPS_V2_TEST_COVERAGE_ROADMAP): exception, advance reports,
 * mixed outputs, JSON-RPC pagination / filters / processed count, voucher value
 * shapes, multi-voucher + L1 order, execLayerData deposits, large voucher payload.
 *
 * Requires a freshly built dapp (`cartesi build` / restart) so new advance
 * commands and ERC20 execLayer decoding in dapp.cpp are loaded.
 */

import { parseAbi, parseEther } from 'viem';

import {
  ADDR, deployer,
  publicClient, publicClientL2,
  sendAdvance, pollInput,
  mineBlocks, waitForEpochClaimAccepted, getOutputWithProof,
  executeVoucher,
  noticeCount, reportCount, voucherCount,
  noticeText, reportText,
  depositERC20, depositERC20WithExecLayer,
  uint256hex,
} from '../helpers.js';

const EPOCH_LENGTH = Number(process.env.EPOCH_LENGTH ?? 5);

const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

// =============================================================================
// Tier 1 — exception, advance reports, mixed outputs, JSON-RPC
// =============================================================================

describe('Exception path (/exception)', () => {
  test('force_exception — input status EXCEPTION', async () => {
    const idx = await sendAdvance({ cmd: 'force_exception', message: 'tier1_exception' });
    const input = await pollInput(idx);
    expect(input.status).toBe('EXCEPTION');
    expect(noticeCount(input)).toBe(0);
    const raw = await publicClientL2.getInput({
      application: ADDR.APP(),
      inputIndex:  BigInt(idx),
    });
    expect(raw.status).toBe('EXCEPTION');
  });
});

describe('Reports during advance', () => {
  test('advance_reports — ACCEPTED with reports linked to input', async () => {
    const idx = await sendAdvance({ cmd: 'advance_reports', size: 64, count: 2 });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(reportCount(input)).toBe(2);
    expect(reportText(input, 0).length).toBeGreaterThan(0);
  });
});

describe('Mixed outputs (one advance)', () => {
  test('mixed_outputs — notice + report + voucher', async () => {
    const idx = await sendAdvance({
      cmd:         'mixed_outputs',
      token:       ADDR.TEST_ERC20(),
      receiver:    deployer,
      amount:      uint256hex(parseEther('0.01')),
      noticeText:  'MIXED_TIER1',
      reportText:  'mixed_rep',
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(noticeCount(input)).toBe(1);
    expect(reportCount(input)).toBe(1);
    expect(voucherCount(input)).toBe(1);
    expect(noticeText(input, 0)).toBe('MIXED_TIER1');
    expect(reportText(input, 0)).toBe('mixed_rep');
  });
});

describe('JSON-RPC — pagination, filter, processed input count', () => {
  test('cartesi_getProcessedInputCount increases with new advances', async () => {
    const before = await publicClientL2.getProcessedInputCount({ application: ADDR.APP() });
    const i1 = await sendAdvance({ cmd: 'generate_notices', size: 8, count: 1 });
    const i2 = await sendAdvance({ cmd: 'generate_notices', size: 8, count: 1 });
    await Promise.all([pollInput(i1), pollInput(i2)]);
    const after = await publicClientL2.getProcessedInputCount({ application: ADDR.APP() });
    expect(after - before).toBe(2n);
  });

  test('cartesi_listOutputs pagination — totalCount vs page', async () => {
    const idx = await sendAdvance({ cmd: 'generate_notices', size: 16, count: 3 });
    await pollInput(idx);
    const bigIdx = BigInt(idx);
    const p0 = await publicClientL2.listOutputs({
      application: ADDR.APP(),
      inputIndex:  bigIdx,
      limit:       1,
      offset:      0,
    });
    const pAll = await publicClientL2.listOutputs({
      application: ADDR.APP(),
      inputIndex:  bigIdx,
      limit:       10,
      offset:      0,
    });
    expect(p0.data.length).toBe(1);
    expect(pAll.pagination.totalCount).toBe(p0.pagination.totalCount);
    expect(pAll.data.length).toBe(3);
  });

  test('cartesi_listOutputs filter by outputType Notice', async () => {
    const idx = await sendAdvance({ cmd: 'generate_notices', size: 8, count: 2 });
    await pollInput(idx);
    const bigIdx = BigInt(idx);
    const filtered = await publicClientL2.listOutputs({
      application: ADDR.APP(),
      inputIndex:  bigIdx,
      outputType:  'Notice',
      limit:       20,
      offset:      0,
    });
    expect(filtered.data.length).toBe(2);
    expect(filtered.data.every((o) => o.decodedData?.type === 'Notice')).toBe(true);
  });
});

// =============================================================================
// Tier 2 — voucher value shapes, multi-voucher, execLayerData, large voucher
// =============================================================================

describe('ERC-20 voucher value field shapes', () => {
  test('valueField omit — ACCEPTED', async () => {
    const idx = await sendAdvance({
      cmd:      'erc20_withdraw',
      token:    ADDR.TEST_ERC20(),
      receiver: deployer,
      amount:   uint256hex(parseEther('1')),
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
  });

  test('valueField zero_hash — ACCEPTED', async () => {
    const idx = await sendAdvance({
      cmd:        'erc20_withdraw',
      token:      ADDR.TEST_ERC20(),
      receiver:   deployer,
      amount:     uint256hex(parseEther('1')),
      valueField: 'zero_hash',
    });
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
  });
});

describe('ERC-20 deposit with execLayerData', () => {
  test('notice echoes non-empty exec payload', async () => {
    const execData = '0xbeef';
    const idx = await depositERC20WithExecLayer(ADDR.TEST_ERC20(), parseEther('5'), execData);
    const input = await pollInput(idx);
    expect(input.status).toBe('ACCEPTED');
    expect(noticeText(input, 0)).toContain('exec=');
    expect(noticeText(input, 0)).toContain('beef');
  });
});

describe('Large voucher near output size limit', () => {
  test('large_voucher payload ~200 KB — ACCEPTED', async () => {
    const idx = await sendAdvance({
      cmd:           'large_voucher',
      destination:   ADDR.TEST_ERC20(),
      payloadBytes:  200_000,
    });
    const input = await pollInput(idx, 180_000);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
  }, 200_000);

  test('large_voucher payload ~1 MB — ACCEPTED', async () => {
    const idx = await sendAdvance({
      cmd:           'large_voucher',
      destination:   ADDR.TEST_ERC20(),
      payloadBytes:  1_000_000,
    });
    const input = await pollInput(idx, 300_000);
    expect(input.status).toBe('ACCEPTED');
    expect(voucherCount(input)).toBe(1);
  }, 400_000);
});

describe('multi_erc20_withdraw — two vouchers in order on L1', () => {
  const ctx = { outA: null, outB: null };

  beforeAll(async () => {
    await depositERC20(ADDR.TEST_ERC20(), parseEther('80'));
    const idx = await sendAdvance({
      cmd:          'multi_erc20_withdraw',
      token:        ADDR.TEST_ERC20(),
      receiver:     deployer,
      amountFirst:  uint256hex(parseEther('4')),
      amountSecond: uint256hex(parseEther('6')),
    });
    const input = await pollInput(idx);
    if (input.status !== 'ACCEPTED') throw new Error('multi_erc20_withdraw not ACCEPTED');
    if (voucherCount(input) !== 2) throw new Error('expected 2 vouchers');

    await mineBlocks(EPOCH_LENGTH + 2);
    await waitForEpochClaimAccepted(input.epochIndex);

    const raw0 = input.vouchers[0];
    const raw1 = input.vouchers[1];
    ctx.outA = await getOutputWithProof(raw0.index);
    ctx.outB = await getOutputWithProof(raw1.index);
  }, 600_000);

  test('execute first voucher (+4 tokens), then second (+6 tokens)', async () => {
    const before = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    await executeVoucher(ctx.outA);
    const mid = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    expect(mid - before).toBe(parseEther('4'));
    await executeVoucher(ctx.outB);
    const after = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    expect(after - mid).toBe(parseEther('6'));
  },
  120_000);
});
