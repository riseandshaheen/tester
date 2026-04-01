/**
 * Epoch finalization tests — voucher execution + notice validation on L1.
 *
 * These tests require cartesi to be started with a short epoch:
 *   cartesi run --epoch-length 5
 * and EPOCH_LENGTH=5 in .env (must match the flag value).
 *
 * Flow:
 *   1. Deposit fresh assets for each withdrawal type
 *   2. Send withdrawal + notice commands (incl. delegate_erc20_transfer) — capture output indices
 *   3. Mine EPOCH_LENGTH+1 blocks to close the epoch
 *   4. Wait until the node's epoch is CLAIM_ACCEPTED, then fetch outputs (proofs attached)
 *   5. Execute vouchers → assert L1 balances changed
 *   6. Validate notices → assert true
 */

import { parseAbi, parseEther } from 'viem';

import {
  ADDR, deployer, otherUser,
  publicClient, publicClientL2,
  sendAdvance, pollInput,
  mineBlocks, waitForEpochClaimAccepted, getOutputWithProof,
  executeVoucher, validateNotice,
  depositEth, depositERC20, depositERC721,
  depositERC1155Single, depositERC1155Batch,
  walletClientOther,
  uint256hex,
} from '../helpers.js';

const EPOCH_LENGTH = Number(process.env.EPOCH_LENGTH ?? 5);

// Minimal ABIs for L1 balance reads
const ERC20_ABI   = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ERC721_ABI  = parseAbi(['function ownerOf(uint256) view returns (address)']);
const ERC1155_ABI = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
]);

// Shared state populated in beforeAll
const ctx = {
  noticeOutput:   null, // Output (Notice) with proof
  ethOutput:      null, // Voucher outputs with proofs
  erc20Output:    null,
  delegateOutput: null,
  erc721Output:   null,
  erc1155SOutput: null,
  erc1155BOutput: null,
  mintOutput:     null,
  // balances before execution
  ethBefore:    null,
  erc20Before:  null,
  erc1155Before: null,
};

beforeAll(async () => {
  // ── 1. Deposits ────────────────────────────────────────────────────────────
  await depositEth(parseEther('0.5'));
  await depositERC20(ADDR.TEST_ERC20(), parseEther('100'));
  await depositERC721(ADDR.TEST_ERC721(), 2n);        // tokenId=2 (1 may be transferred already)
  await depositERC1155Single(ADDR.TEST_ERC1155(), 1n, 100n);
  await depositERC1155Batch(ADDR.TEST_ERC1155(), [1n, 2n], [50n, 50n]);

  // ── 2. Advance commands — notice + withdrawals (incl. delegate ERC-20) ─────
  // Must be sequential to avoid nonce collisions on Anvil
  const noticeIdx    = await sendAdvance({ cmd: 'generate_notices', size: 32, count: 1 });
  const ethIdx       = await sendAdvance({ cmd: 'eth_withdraw',        receiver: deployer, amount: uint256hex(parseEther('0.1')) });
  const erc20Idx     = await sendAdvance({ cmd: 'erc20_withdraw',      token: ADDR.TEST_ERC20(),   receiver: deployer, amount: uint256hex(parseEther('10')) });
  const delegateIdx  = await sendAdvance({
    cmd:      'delegate_erc20_transfer',
    logic:    ADDR.DELEGATE_VOUCHER_LOGIC(),
    token:    ADDR.TEST_ERC20(),
    receiver: deployer,
    amount:   uint256hex(parseEther('5')),
  });
  const erc721Idx    = await sendAdvance({ cmd: 'erc721_withdraw',     token: ADDR.TEST_ERC721(),  receiver: deployer, tokenId: uint256hex(2n) });
  const erc1155SIdx  = await sendAdvance({ cmd: 'erc1155_withdraw_single', token: ADDR.TEST_ERC1155(), receiver: deployer, id: uint256hex(1n), amount: uint256hex(25n) });
  const erc1155BIdx  = await sendAdvance({ cmd: 'erc1155_withdraw_batch',  token: ADDR.TEST_ERC1155(), receiver: deployer, ids: [uint256hex(1n), uint256hex(2n)], amounts: [uint256hex(5n), uint256hex(10n)] });
  const mintIdx      = await sendAdvance({ cmd: 'mint_erc721',         receiver: deployer, tokenId: uint256hex(200n) });

  // Confirm all accepted and capture output objects
  const [
    noticeInput,
    ethInput,
    erc20Input,
    delegateInput,
    erc721Input,
    erc1155SInput,
    erc1155BInput,
    mintInput,
  ] = await Promise.all([
    pollInput(noticeIdx),
    pollInput(ethIdx),
    pollInput(erc20Idx),
    pollInput(delegateIdx),
    pollInput(erc721Idx),
    pollInput(erc1155SIdx),
    pollInput(erc1155BIdx),
    pollInput(mintIdx),
  ]);

  if (noticeInput.status !== 'ACCEPTED')   throw new Error('notice generate not ACCEPTED');
  if (ethInput.status !== 'ACCEPTED')      throw new Error('eth_withdraw not ACCEPTED');
  if (erc20Input.status !== 'ACCEPTED')    throw new Error('erc20_withdraw not ACCEPTED');
  if (delegateInput.status !== 'ACCEPTED') throw new Error('delegate_erc20_transfer not ACCEPTED');
  if (erc721Input.status !== 'ACCEPTED')   throw new Error('erc721_withdraw not ACCEPTED');
  if (erc1155SInput.status !== 'ACCEPTED') throw new Error('erc1155_withdraw_single not ACCEPTED');
  if (erc1155BInput.status !== 'ACCEPTED') throw new Error('erc1155_withdraw_batch not ACCEPTED');
  if (mintInput.status !== 'ACCEPTED')     throw new Error('mint_erc721 not ACCEPTED');

  // ── 3. Mine blocks to close the epoch ──────────────────────────────────────
  await mineBlocks(EPOCH_LENGTH + 2);

  // ── 4. Hard gate: epoch CLAIM_ACCEPTED, then fetch outputs with proofs ─────
  const noticeRaw   = noticeInput.notices[0];
  const ethRaw      = ethInput.vouchers[0];
  const erc20Raw    = erc20Input.vouchers[0];
  const delegateRaw = delegateInput.vouchers[0];
  const erc721Raw   = erc721Input.vouchers[0];
  const erc1155SRaw = erc1155SInput.vouchers[0];
  const erc1155BRaw = erc1155BInput.vouchers[0];
  const mintRaw     = mintInput.vouchers[0];

  const maxEpoch = [
    noticeInput.epochIndex,
    ethInput.epochIndex,
    erc20Input.epochIndex,
    delegateInput.epochIndex,
    erc721Input.epochIndex,
    erc1155SInput.epochIndex,
    erc1155BInput.epochIndex,
    mintInput.epochIndex,
  ].reduce((a, b) => (a > b ? a : b));

  await waitForEpochClaimAccepted(maxEpoch);

  [
    ctx.noticeOutput,
    ctx.ethOutput,
    ctx.erc20Output,
    ctx.delegateOutput,
    ctx.erc721Output,
    ctx.erc1155SOutput,
    ctx.erc1155BOutput,
    ctx.mintOutput,
  ] = await Promise.all([
    getOutputWithProof(noticeRaw.index),
    getOutputWithProof(ethRaw.index),
    getOutputWithProof(erc20Raw.index),
    getOutputWithProof(delegateRaw.index),
    getOutputWithProof(erc721Raw.index),
    getOutputWithProof(erc1155SRaw.index),
    getOutputWithProof(erc1155BRaw.index),
    getOutputWithProof(mintRaw.index),
  ]);

  // ── 5. Snapshot L1 balances before execution ────────────────────────────────
  ctx.ethBefore    = await publicClient.getBalance({ address: deployer });
  ctx.erc20Before  = await publicClient.readContract({ address: ADDR.TEST_ERC20(),   abi: ERC20_ABI,   functionName: 'balanceOf', args: [deployer] });
  ctx.erc1155Before = await publicClient.readContract({ address: ADDR.TEST_ERC1155(), abi: ERC1155_ABI, functionName: 'balanceOf', args: [deployer, 1n] });
}, 600_000);

// =============================================================================
// Notice validation
// =============================================================================
describe('Notice validation (L1 Merkle proof)', () => {
  test('validateOutput returns true for a notice after epoch finalization', async () => {
    const valid = await validateNotice(ctx.noticeOutput);
    expect(valid).toBe(true);
  });
});

// =============================================================================
// Voucher execution + L1 balance checks
// =============================================================================
describe('Voucher execution (L1 balance checks)', () => {
  test('eth_withdraw — balance increases by 0.1 ETH after execution', async () => {
    await executeVoucher(ctx.ethOutput);
    const after = await publicClient.getBalance({ address: deployer });
    // after > before (net of gas)
    expect(after).toBeGreaterThan(ctx.ethBefore);
  });

  test('erc20_withdraw — ERC20 balance increases by 10 tokens after execution', async () => {
    await executeVoucher(ctx.erc20Output);
    const after = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    expect(after - ctx.erc20Before).toBe(parseEther('10'));
  });

  test('delegate_erc20_transfer — ERC20 balance increases by 5 tokens after execution', async () => {
    const before = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    await executeVoucher(ctx.delegateOutput);
    const after = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    expect(after - before).toBe(parseEther('5'));
  });

  test('erc721_withdraw — tokenId=2 ownerOf is deployer after execution', async () => {
    await executeVoucher(ctx.erc721Output);
    const owner = await publicClient.readContract({
      address: ADDR.TEST_ERC721(), abi: ERC721_ABI, functionName: 'ownerOf', args: [2n],
    });
    expect(owner.toLowerCase()).toBe(deployer.toLowerCase());
  });

  test('erc1155_withdraw_single — id=1 balance increases by 25 after execution', async () => {
    await executeVoucher(ctx.erc1155SOutput);
    const after = await publicClient.readContract({
      address: ADDR.TEST_ERC1155(), abi: ERC1155_ABI, functionName: 'balanceOf', args: [deployer, 1n],
    });
    expect(after - ctx.erc1155Before).toBe(25n);
  });

  test('erc1155_withdraw_batch — ids [1,2] balances increase after execution', async () => {
    const before = await publicClient.readContract({
      address: ADDR.TEST_ERC1155(), abi: ERC1155_ABI,
      functionName: 'balanceOfBatch',
      args: [[deployer, deployer], [1n, 2n]],
    });
    await executeVoucher(ctx.erc1155BOutput);
    const after = await publicClient.readContract({
      address: ADDR.TEST_ERC1155(), abi: ERC1155_ABI,
      functionName: 'balanceOfBatch',
      args: [[deployer, deployer], [1n, 2n]],
    });
    expect(after[0] - before[0]).toBe(5n);
    expect(after[1] - before[1]).toBe(10n);
  });

  test('mint_erc721 — tokenId=200 is minted to deployer after execution', async () => {
    await executeVoucher(ctx.mintOutput);
    const owner = await publicClient.readContract({
      address: ADDR.MINTABLE_ERC721(), abi: ERC721_ABI, functionName: 'ownerOf', args: [200n],
    });
    expect(owner.toLowerCase()).toBe(deployer.toLowerCase());
  });
});

// =============================================================================
// Targeted delegate voucher — only `allowedExecutor` may call executeOutput
// =============================================================================
const ctxTargeted = { output: null };

describe('Targeted delegate voucher (executor must match allowedExecutor)', () => {
  beforeAll(async () => {
    await depositERC20(ADDR.TEST_ERC20(), parseEther('10'));
    const idx = await sendAdvance({
      cmd:              'delegate_erc20_transfer_targeted',
      logic:            ADDR.DELEGATE_VOUCHER_LOGIC(),
      token:            ADDR.TEST_ERC20(),
      receiver:         deployer,
      amount:           uint256hex(parseEther('3')),
      allowedExecutor:  deployer,
    });
    const input = await pollInput(idx);
    if (input.status !== 'ACCEPTED') throw new Error('delegate_erc20_transfer_targeted not ACCEPTED');
    await mineBlocks(EPOCH_LENGTH + 2);
    await waitForEpochClaimAccepted(input.epochIndex);
    ctxTargeted.output = await getOutputWithProof(input.vouchers[0].index);
  }, 600_000);

  test('non-targeted account — executeOutput reverts', async () => {
    expect(otherUser.toLowerCase()).not.toBe(deployer.toLowerCase());
    const execution = executeVoucher(ctxTargeted.output, { walletClient: walletClientOther });
    await expect(execution).rejects.toThrow();
  });

  test('allowedExecutor — executeOutput succeeds and transfers ERC20', async () => {
    const before = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    await executeVoucher(ctxTargeted.output);
    const after = await publicClient.readContract({
      address: ADDR.TEST_ERC20(), abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer],
    });
    expect(after - before).toBe(parseEther('3'));
  });
});

// =============================================================================
// Overdraft voucher execution (should revert on L1)
// =============================================================================
const ctxOverdraft = {
  ethOverdraftOutput:    null,
  erc20OverdraftOutput:  null,
  erc721OverdraftOutput: null,
};

describe('Overdraft voucher execution (L1 execution should revert)', () => {
  beforeAll(async () => {
    // Create overdraft withdrawal vouchers (without sufficient deposits)
    // No new deposits — just send overdraft commands
    const ethOverdraftIdx   = await sendAdvance({ cmd: 'eth_withdraw',        receiver: deployer, amount: uint256hex(parseEther('1000')) });
    const erc20OverdraftIdx = await sendAdvance({ cmd: 'erc20_withdraw',      token: ADDR.TEST_ERC20(),  receiver: deployer, amount: uint256hex(10n ** 30n) });
    const erc721OverdraftIdx = await sendAdvance({ cmd: 'erc721_withdraw',    token: ADDR.TEST_ERC721(), receiver: deployer, tokenId: uint256hex(999n) });

    // Confirm all ACCEPTED (dapp creates vouchers unconditionally)
    const [ethOdInput, erc20OdInput, erc721OdInput] = await Promise.all([
      pollInput(ethOverdraftIdx),
      pollInput(erc20OverdraftIdx),
      pollInput(erc721OverdraftIdx),
    ]);

    if (ethOdInput.status !== 'ACCEPTED')   throw new Error('eth overdraft not ACCEPTED');
    if (erc20OdInput.status !== 'ACCEPTED') throw new Error('erc20 overdraft not ACCEPTED');
    if (erc721OdInput.status !== 'ACCEPTED') throw new Error('erc721 overdraft not ACCEPTED');

    await mineBlocks(EPOCH_LENGTH + 2);

    const ethOdRaw   = ethOdInput.vouchers[0];
    const erc20OdRaw = erc20OdInput.vouchers[0];
    const erc721OdRaw = erc721OdInput.vouchers[0];

    const maxOdEpoch = [ethOdInput.epochIndex, erc20OdInput.epochIndex, erc721OdInput.epochIndex]
      .reduce((a, b) => (a > b ? a : b));
    await waitForEpochClaimAccepted(maxOdEpoch);

    [
      ctxOverdraft.ethOverdraftOutput,
      ctxOverdraft.erc20OverdraftOutput,
      ctxOverdraft.erc721OverdraftOutput,
    ] = await Promise.all([
      getOutputWithProof(ethOdRaw.index),
      getOutputWithProof(erc20OdRaw.index),
      getOutputWithProof(erc721OdRaw.index),
    ]);
  }, 600_000);

  test('eth_withdraw overdraft (1000 ETH) — execution reverts', async () => {
    const execution = executeVoucher(ctxOverdraft.ethOverdraftOutput);
    await expect(execution).rejects.toThrow();
  });

  test('erc20_withdraw overdraft (10^30 tokens) — execution reverts', async () => {
    const execution = executeVoucher(ctxOverdraft.erc20OverdraftOutput);
    await expect(execution).rejects.toThrow();
  });

  test('erc721_withdraw overdraft (tokenId=999, never deposited) — execution reverts', async () => {
    const execution = executeVoucher(ctxOverdraft.erc721OverdraftOutput);
    await expect(execution).rejects.toThrow();
  });
});
