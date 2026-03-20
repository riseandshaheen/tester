import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createPublicClient, createWalletClient, http, hexToString, toHex, parseAbi } from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createCartesiPublicClient, walletActionsL1, publicActionsL1, getInputsAdded } from '@cartesi/viem';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

// =============================================================================
// ENV
// =============================================================================
const e = (key) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
};

const RPC_URL      = process.env.RPC_URL      || 'http://127.0.0.1:6751/anvil';
const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://127.0.0.1:6751/rpc';
const INSPECT_URL  = process.env.INSPECT_URL  || 'http://127.0.0.1:6751/inspect/tester';
const PRIVATE_KEY  = process.env.PRIVATE_KEY  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Contract addresses — stable for cartesi CLI local devnets
const ADDR = {
  APP:                  () => e('CARTESI_APP_ADDRESS'),
  INPUT_BOX:            process.env.INPUT_BOX_ADDRESS    || '0x1b51e2992A2755Ba4D6F7094032DF91991a0Cfac',
  ETH_PORTAL:           process.env.ETH_PORTAL_ADDRESS   || '0xA632c5c05812c6a6149B7af5C56117d1D2603828',
  ERC20_PORTAL:         process.env.ERC20_PORTAL_ADDRESS || '0xACA6586A0Cf05bD831f2501E7B4aea550dA6562D',
  ERC721_PORTAL:        process.env.ERC721_PORTAL_ADDRESS|| '0x9E8851dadb2b77103928518846c4678d48b5e371',
  ERC1155_SINGLE_PORTAL:process.env.ERC1155_SINGLE_PORTAL|| '0x18558398Dd1a8cE20956287a4Da7B76aE7A96662',
  ERC1155_BATCH_PORTAL: process.env.ERC1155_BATCH_PORTAL || '0xe246Abb974B307490d9C6932F48EbE79de72338A',
  TEST_ERC20:           () => e('TEST_ERC20_ADDRESS'),
  TEST_ERC721:          () => e('TEST_ERC721_ADDRESS'),
  TEST_ERC1155:         () => e('TEST_ERC1155_ADDRESS'),
  MINTABLE_ERC721:      () => e('MINTABLE_ERC721_ADDRESS'),
};

// =============================================================================
// CLIENTS
// =============================================================================
const account = privateKeyToAccount(PRIVATE_KEY);

// L1 public client — getCode, getBlockNumber, waitForTransactionReceipt, validateOutput, etc.
const publicClient = createPublicClient({
  chain: foundry,
  transport: http(RPC_URL),
}).extend(publicActionsL1());

// L1 wallet client — addInput, depositXxx, writeContract (approvals)
const walletClient = createWalletClient({
  chain: foundry,
  account,
  transport: http(RPC_URL),
}).extend(walletActionsL1());

// L2 Cartesi node client — waitForInput, listOutputs, listReports, getNodeVersion
const publicClientL2 = createCartesiPublicClient({
  transport: http(NODE_RPC_URL),
});

const deployer = account.address;

// =============================================================================
// ADVANCE INPUT — send JSON as hex-encoded payload
// =============================================================================
/**
 * Send a JSON object as an advance input.
 * @param {object} json
 * @returns {Promise<bigint>} input index
 */
async function sendAdvance(json) {
  const payload = toHex(JSON.stringify(json));
  const hash    = await walletClient.addInput({ application: ADDR.APP(), payload });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [inputAdded] = getInputsAdded(receipt);
  return BigInt(inputAdded.index);
}

/**
 * Send a raw string (not JSON-serialized) as an advance input.
 * Useful for testing invalid-JSON rejection.
 * @param {string} rawString  — will be UTF-8 encoded to bytes
 * @returns {Promise<bigint>} input index
 */
async function sendRawInput(rawString) {
  const payload = toHex(rawString);
  const hash    = await walletClient.addInput({ application: ADDR.APP(), payload });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [inputAdded] = getInputsAdded(receipt);
  return BigInt(inputAdded.index);
}

// =============================================================================
// L2 INPUT POLLING — polls getInput until terminal status, then fetches outputs
// =============================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the Cartesi node until the input reaches a terminal status,
 * then return { status, notices, reports, vouchers }.
 * @param {bigint|number} index
 * @param {number} timeoutMs
 */
async function pollInput(index, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const app      = ADDR.APP();
  const bigIdx   = BigInt(index);

  let inputResult;
  while (Date.now() < deadline) {
    try {
      inputResult = await publicClientL2.getInput({ application: app, inputIndex: bigIdx });
    } catch (err) {
      // Node throws ResourceNotFoundRpcError while the input is still being
      // indexed — treat it the same as status 'NONE' and keep polling.
      if (err?.name === 'ResourceNotFoundRpcError' ||
          (err?.cause?.message ?? err?.message ?? '').includes('not found')) {
        await sleep(1000);
        continue;
      }
      throw err;
    }
    const st = inputResult?.status;
    if (st && st !== 'NONE') break;
    await sleep(1000);
  }
  if (!inputResult || inputResult.status === 'NONE') {
    throw new Error(`Input ${index} timed out after ${timeoutMs}ms`);
  }

  const [outputsResult, reportsResult] = await Promise.all([
    publicClientL2.listOutputs({ application: app, inputIndex: bigIdx }),
    publicClientL2.listReports({ application: app, inputIndex: bigIdx }),
  ]);

  const allOutputs = outputsResult.data || [];
  const notices  = allOutputs.filter(o => o.decodedData?.type === 'Notice');
  const vouchers = allOutputs.filter(o =>
    o.decodedData?.type === 'Voucher' || o.decodedData?.type === 'DelegateCallVoucher'
  );

  return {
    status:   inputResult.status,
    notices,
    reports:  reportsResult.data || [],
    vouchers,
  };
}

// =============================================================================
// OUTPUT ACCESSORS
// =============================================================================

/** Number of notices emitted by the input. */
const noticeCount  = (input) => input.notices.length;
/** Number of reports emitted by the input. */
const reportCount  = (input) => input.reports.length;
/** Number of vouchers emitted by the input. */
const voucherCount = (input) => input.vouchers.length;

/** Decode the Nth notice payload as a UTF-8 string. */
const noticeText = (input, n = 0) => {
  const payload = input.notices[n]?.decodedData?.payload;
  return payload ? hexToString(payload) : '';
};

/** Return the byte length of the Nth notice's raw binary payload. */
const noticeBytes = (input, n = 0) => {
  const payload = input.notices[n]?.decodedData?.payload;
  return payload ? (payload.length - 2) / 2 : 0;
};

/** Decode the Nth report rawData as a UTF-8 string. */
const reportText = (input, n = 0) => {
  const rawData = input.reports[n]?.rawData;
  return rawData ? hexToString(rawData) : '';
};

/** Return the destination address (lowercase) of the Nth voucher. */
const voucherDest = (input, n = 0) =>
  (input.vouchers[n]?.decodedData?.destination ?? '').toLowerCase();

// =============================================================================
// INSPECT — REST GET endpoint on the Cartesi node
// =============================================================================
/**
 * Send an inspect request with a JSON payload.
 * Returns { status, reports: [{ payload }] }
 * @param {object} json
 */
async function sendInspect(json) {
  // Cartesi v2: POST /inspect/{app_address}  body: {"payload":"0x{hex}"}
  // Use the app address directly — INSPECT_URL may contain an app name which
  // must NOT be combined with the address (node accepts one or the other).
  const hexPayload = '0x' + Buffer.from(JSON.stringify(json)).toString('hex');
  const nodeBase = NODE_RPC_URL.replace(/\/rpc\/?$/, '');
  const url = `${nodeBase}/inspect/${ADDR.APP()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: hexPayload }),
  });
  if (!res.ok) throw new Error(`Inspect HTTP ${res.status}`);
  return res.json();
}

/** Number of reports in an inspect response. */
const inspectReportCount = (resp) => resp?.reports?.length ?? 0;

/** Byte length of the Nth report payload in an inspect response (REST format: .payload). */
const inspectReportBytes = (resp, n = 0) => {
  const payload = resp?.reports?.[n]?.payload;
  return payload ? (payload.length - 2) / 2 : 0;
};

// =============================================================================
// DEPOSIT HELPERS
// =============================================================================
const ERC20_ABI   = parseAbi(['function approve(address spender, uint256 amount) external returns (bool)']);
const ERC721_ABI  = parseAbi(['function approve(address to, uint256 tokenId) external']);
const ERC1155_ABI = parseAbi(['function setApprovalForAll(address operator, bool approved) external']);

async function depositEth(weiAmount) {
  const hash = await walletClient.depositEther({
    application:   ADDR.APP(),
    execLayerData: '0x',
    value:         weiAmount,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [inputAdded] = getInputsAdded(receipt);
  return BigInt(inputAdded.index);
}

async function depositERC20(tokenAddr, amount) {
  const approveHash = await walletClient.writeContract({
    address:      tokenAddr,
    abi:          ERC20_ABI,
    functionName: 'approve',
    args:         [ADDR.ERC20_PORTAL, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const hash = await walletClient.depositERC20Tokens({
    application:   ADDR.APP(),
    token:         tokenAddr,
    amount,
    execLayerData: '0x',
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [inputAdded] = getInputsAdded(receipt);
  return BigInt(inputAdded.index);
}

async function depositERC721(tokenAddr, tokenId) {
  const approveHash = await walletClient.writeContract({
    address:      tokenAddr,
    abi:          ERC721_ABI,
    functionName: 'approve',
    args:         [ADDR.ERC721_PORTAL, tokenId],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const hash = await walletClient.depositERC721Token({
    application:    ADDR.APP(),
    token:          tokenAddr,
    tokenId,
    baseLayerData:  '0x',
    execLayerData:  '0x',
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [inputAdded] = getInputsAdded(receipt);
  return BigInt(inputAdded.index);
}

async function depositERC1155Single(tokenAddr, id, amount) {
  const approveHash = await walletClient.writeContract({
    address:      tokenAddr,
    abi:          ERC1155_ABI,
    functionName: 'setApprovalForAll',
    args:         [ADDR.ERC1155_SINGLE_PORTAL, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const hash = await walletClient.depositSingleERC1155Token({
    application:    ADDR.APP(),
    token:          tokenAddr,
    tokenId:        id,
    value:          amount,
    baseLayerData:  '0x',
    execLayerData:  '0x',
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [inputAdded] = getInputsAdded(receipt);
  return BigInt(inputAdded.index);
}

async function depositERC1155Batch(tokenAddr, ids, amounts) {
  const approveHash = await walletClient.writeContract({
    address:      tokenAddr,
    abi:          ERC1155_ABI,
    functionName: 'setApprovalForAll',
    args:         [ADDR.ERC1155_BATCH_PORTAL, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const hash = await walletClient.depositBatchERC1155Token({
    application:    ADDR.APP(),
    token:          tokenAddr,
    tokenIds:       ids,
    values:         amounts,
    baseLayerData:  '0x',
    execLayerData:  '0x',
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [inputAdded] = getInputsAdded(receipt);
  return BigInt(inputAdded.index);
}

// =============================================================================
// ANVIL UTILITIES
// =============================================================================

/**
 * Mine `n` blocks on the local Anvil devnet (advances epoch progression).
 * @param {number} n
 */
async function mineBlocks(n) {
  // anvil_mine(hexCount, hexIntervalSeconds)
  await publicClient.request({ method: 'anvil_mine', params: [`0x${n.toString(16)}`, '0x1'] });
}

// =============================================================================
// VOUCHER EXECUTION
// =============================================================================

/**
 * Poll publicClientL2.getOutput() until outputHashesSiblings is populated
 * (meaning the epoch has been finalized and the proof is ready).
 * @param {bigint} outputIndex  — the global output index in the application
 * @param {number} timeoutMs
 */
async function waitForOutputProof(outputIndex, timeoutMs = 300_000) {
  const app      = ADDR.APP();
  const deadline = Date.now() + timeoutMs;
  const bigIdx   = BigInt(outputIndex);
  let ticks = 0;
  while (Date.now() < deadline) {
    const output = await publicClientL2.getOutput({ application: app, outputIndex: bigIdx });
    if (output && output.outputHashesSiblings !== null) return output;
    // Mine 2 fresh blocks every ~10s so the node keeps seeing new blocks and is
    // guaranteed to cross the epoch boundary even if the initial mineBlocks()
    // call was not picked up immediately by the node's polling loop.
    if (++ticks % 5 === 0) {
      await mineBlocks(2).catch(() => {});
    }
    await sleep(2000);
  }
  throw new Error(`Output ${outputIndex} proof not available after ${timeoutMs}ms`);
}

/**
 * Execute a voucher on L1 (calls the application's executeOutput).
 * Returns the transaction receipt.
 * @param {object} output  — full Output object with proof
 */
async function executeVoucher(output) {
  const hash    = await walletClient.executeOutput({ application: ADDR.APP(), output });
  return publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Validate a notice on L1 (read-only, no gas cost).
 * Returns true if the Merkle proof is valid.
 * @param {object} output  — full Output object for a Notice, with proof
 */
async function validateNotice(output) {
  return publicClient.validateOutput({ application: ADDR.APP(), output });
}

// =============================================================================
// MISC
// =============================================================================

/** Encode a JS bigint/number as a 0x-prefixed 32-byte hex string for JSON args. */
const uint256hex = (v) => toHex(BigInt(v), { size: 32 });

export {
  ADDR,
  deployer,
  publicClient,
  publicClientL2,
  walletClient,
  sendAdvance,
  sendRawInput,
  pollInput,
  mineBlocks,
  waitForOutputProof,
  executeVoucher,
  validateNotice,
  noticeCount, reportCount, voucherCount,
  noticeText, noticeBytes,
  reportText,
  voucherDest,
  sendInspect,
  inspectReportCount, inspectReportBytes,
  depositEth, depositERC20, depositERC721,
  depositERC1155Single, depositERC1155Batch,
  uint256hex,
  sleep,
};

