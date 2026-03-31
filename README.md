# Cartesi Test DApp

A C++ Cartesi v2 dapp for exercising all rollup primitives: every deposit type, every withdrawal type (via vouchers), delegate-call vouchers, configurable notice/report generation, exception registration, mixed outputs per advance, and an ERC721 voucher-mint flow. Integration tests cover JSON-RPC pagination, ERC-20 `execLayerData` deposits (Rollups v2 `InputEncoding` packed payload), large vouchers, and multi-voucher L1 ordering.

After changing **`dapp.cpp`**, rebuild the binary before `cartesi build`:

```bash
make    # repo root — produces ./dapp
```

---

## Prerequisites

| Tool | Install |
|---|---|
| cartesi CLI | `npm i -g @cartesi/cli` |
| Foundry | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Node.js ≥ 18 | [nodejs.org](https://nodejs.org) |
| Docker | [docker.com](https://docker.com) |

---

## Addresses (injected by `cartesi run`)

These are stable across all cartesi CLI local devnets (`address-book`):

| Contract | Address |
|---|---|
| InputBox | `0x1b51e2992A2755Ba4D6F7094032DF91991a0Cfac` |
| EtherPortal | `0xA632c5c05812c6a6149B7af5C56117d1D2603828` |
| ERC20Portal | `0xACA6586A0Cf05bD831f2501E7B4aea550dA6562D` |
| ERC721Portal | `0x9E8851dadb2b77103928518846c4678d48b5e371` |
| ERC1155SinglePortal | `0x18558398Dd1a8cE20956287a4Da7B76aE7A96662` |
| ERC1155BatchPortal | `0xe246Abb974B307490d9C6932F48EbE79de72338A` |

Test token contracts are deployed via `forge script Deploy` and their addresses vary per run.

The default Anvil test account used by the tests:

```
address:     0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

**This is the account with funds.** Use this private key for `forge script Deploy`.

---

## Running

### 1 — Build and start the devnet

`cartesi run` in v2 proxies all services through a single port (default `6751`):

| Endpoint | URL |
|---|---|
| Anvil RPC | `http://127.0.0.1:6751/anvil` |
| Node JSON-RPC | `http://127.0.0.1:6751/rpc` |
| Inspect REST | `http://127.0.0.1:6751/inspect/<dapp-name>` |

For suites **00–07** only, the default epoch length is fine:

```bash
cartesi build
cartesi run
```

Suite **08** (L1 proofs + voucher execution) and the **last test block in 09** (`multi_erc20_withdraw` on L1) need a **short epoch** and matching proofs. For **full `npm test`**, use a short `--epoch-length` and set **`EPOCH_LENGTH`** in `.env` to the same value:

```bash
cartesi run --epoch-length 5
```

The app contract address is printed on startup, e.g.:

```
Cartesi application: 0x75135d8ADb7180640D7f915066F5C710B7D9b8F0
```

### 2 — Deploy test token contracts

First, get the app address from `cartesi run` output and set environment variables:

```bash
# Set the app address (printed by cartesi run)
export CARTESI_APP_ADDRESS=0x<from cartesi run output>

# Set the Anvil test account private key (the default Anvil account)
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

**Wait 10+ seconds** for Cartesi to fully initialize Anvil account balances, then deploy:

```bash
# Give Anvil time to initialize (usually ~10 seconds)
sleep 10

cd contracts
forge script script/Deploy.s.sol \
  --rpc-url http://localhost:6751/anvil \
  --broadcast
```

Note the contract addresses printed at the end:

```
=== Deployed ===
TestERC20:              0x...
TestERC721:             0x...
TestERC1155:            0x...
MintableERC721:         0x...
DelegateVoucherLogic:   0x...
```

`Deploy.s.sol` grants the Cartesi app `MINTER_ROLE` on `MintableERC721` so `mint_erc721` vouchers can mint at L1 execution time.

### 3 — Configure the test suite

```bash
cd tests
cp .env.example .env
```

Update `.env` with the addresses from above (see **`.env.example`** for the full list). The key variables are:

| Variable | Description | Source |
|---|---|---|
| `CARTESI_APP_ADDRESS` | App contract from `cartesi run` output | From `cartesi run` |
| `TEST_ERC20_ADDRESS` | TestERC20 | From `forge script Deploy` |
| `TEST_ERC721_ADDRESS` | TestERC721 | From `forge script Deploy` |
| `TEST_ERC1155_ADDRESS` | TestERC1155 | From `forge script Deploy` |
| `MINTABLE_ERC721_ADDRESS` | MintableERC721 | From `forge script Deploy` |
| `DELEGATE_VOUCHER_LOGIC_ADDRESS` | DelegateCall voucher helper | From `forge script Deploy` |
| `RPC_URL` | Anvil RPC | Default: `http://127.0.0.1:6751/anvil` |
| `NODE_RPC_URL` | Cartesi node JSON-RPC | Default: `http://127.0.0.1:6751/rpc` |
| `INSPECT_URL` | Inspect REST — **must include your dapp name**, e.g. `…/inspect/tester` | Default: `http://127.0.0.1:6751/inspect/tester` |
| `PRIVATE_KEY` / `OTHER_PRIVATE_KEY` | Anvil accounts — second key used for targeted delegate-voucher negative tests | See `.env.example` |
| `EPOCH_LENGTH` | Must match `cartesi run --epoch-length` | Default in example: `5`; align with your CLI |

### 4 — Install dependencies and run

```bash
# from the tests/ directory
npm install
npm test
```

To run a single suite:

```bash
npx jest --runInBand tests/01-deposits.test.js
```

---

## Test suites

| File | Description |
|---|---|
| `00-preflight` | Node reachability, Anvil RPC, all contracts deployed |
| `01-deposits` | All 5 portal deposit types — verifies ACCEPTED + notice |
| `02-setup` | `set_mint_contract` — registers MintableERC721 address |
| `03-notices` | Notice size limits: 1 KB, 1 MB, 3×100 KB, ~1.85 MB under 2 MB cap, 2 MB+1 (rejected). See **Troubleshooting** — the ~1.85 MB advance case can be flaky (`EXCEPTION` vs `ACCEPTED`). |
| `04-reports` | Inspect/report size limits: same cases, silently dropped above 2 MB |
| `05-withdrawals` | All 5 withdrawal voucher types + `mint_erc721` + delegate ERC20 vouchers — verifies voucher created on L2 |
| `06-overdrafts` | Withdrawals without matching deposits — advance ACCEPTED, voucher emitted (L1 would revert) |
| `07-errors` | Invalid JSON, unknown cmd, unknown inspect cmd |
| `08-finalization` | **Requires short epoch** (same `--epoch-length` as `EPOCH_LENGTH` in `.env`) — notice proof on L1, voucher execution + balances, delegate vouchers (including targeted executor), overdraft execution reverts |
| `09-rollups-expanded-coverage` | Exceptions, reports during advance, mixed outputs, JSON-RPC listing/filter/count, ERC-20 voucher `valueField` shapes, ERC-20 deposit with `execLayerData`, large vouchers; **last block** runs two ERC-20 vouchers on L1 in order (**needs short epoch**, same as suite 08) |

---

## Dapp API

All advance inputs are **hex-encoded JSON** (the raw bytes of the UTF-8 JSON string, 0x-prefixed, sent via InputBox).  
All inspect inputs follow the same encoding.

The `test.sh` script handles the encoding automatically; the examples below show the JSON before encoding.

### Advance inputs

#### `set_mint_contract`
Register the `MintableERC721` contract address. Must be called before `mint_erc721`.
```json
{"cmd":"set_mint_contract","address":"0x<MintableERC721>"}
```
Emits a notice confirming the address.

---

#### `generate_notices`
Generate N notices of a given byte size. Sizes up to **2,097,152 bytes (2 MB)** are accepted. Larger sizes cause the advance to be **rejected**.
```json
{"cmd":"generate_notices","size":1024,"count":3}
```

---

#### `force_exception`
Registers an **exception** for the current input (HTTP `POST` to the rollup **`/exception`** endpoint). The input finishes with status **`EXCEPTION`** (not `ACCEPTED`).
```json
{"cmd":"force_exception","message":"optional reason"}
```

---

#### `advance_reports`
Emit reports during an advance (same machine cycle), for testing report linkage to the active input.
```json
{"cmd":"advance_reports","size":1024,"count":2}
```

---

#### `mixed_outputs`
Emit a notice, a report, and a voucher in one advance (optional `noticeText`, `reportText`).
```json
{"cmd":"mixed_outputs","token":"0x...","receiver":"0x...","amount":"0x...","noticeText":"hello","reportText":"log"}
```

---

#### `multi_erc20_withdraw`
Emit **two** ERC-20 transfer vouchers in one advance (tests L1 execution order).
```json
{"cmd":"multi_erc20_withdraw","token":"0x...","receiver":"0x...","amountFirst":"0x...","amountSecond":"0x..."}
```

---

#### `large_voucher`
Emit a voucher with a large arbitrary `payload` (tests calldata size limits). May **reject** the advance if the payload exceeds limits.
```json
{"cmd":"large_voucher","destination":"0x...","payloadBytes":204800}
```

---

#### `eth_withdraw`
Emit a voucher calling `EtherPortal.withdrawEther(receiver, amount)`.
```json
{"cmd":"eth_withdraw","receiver":"0x...","amount":"0x<uint256 wei>"}
```

---

#### `erc20_withdraw`
Emit a voucher calling `token.transfer(receiver, amount)`.

Optional **`valueField`** (for encoding experiments): `"omit"` (no `value` field on the voucher) or `"zero_hash"` (`bytes32(0)`).
```json
{"cmd":"erc20_withdraw","token":"0x...","receiver":"0x...","amount":"0x<uint256>"}
```

---

#### `delegate_erc20_transfer` / `delegate_erc20_transfer_targeted`
Emit a **DelegateCallVoucher** that delegate-calls `DelegateVoucherLogic` to perform `transfer` on the ERC-20 token. The **targeted** variant includes `allowedExecutor`; only that address may execute the voucher on L1.

```json
{"cmd":"delegate_erc20_transfer","logic":"0x...","token":"0x...","receiver":"0x...","amount":"0x..."}
```
```json
{"cmd":"delegate_erc20_transfer_targeted","logic":"0x...","token":"0x...","receiver":"0x...","amount":"0x...","allowedExecutor":"0x..."}
```

---

#### `erc721_withdraw`
Emit a voucher calling `token.safeTransferFrom(appAddress, receiver, tokenId)`.
```json
{"cmd":"erc721_withdraw","token":"0x...","receiver":"0x...","tokenId":"0x<uint256>"}
```

---

#### `erc1155_withdraw_single`
Emit a voucher calling `token.safeTransferFrom(appAddress, receiver, id, amount, "")`.
```json
{"cmd":"erc1155_withdraw_single","token":"0x...","receiver":"0x...","id":"0x1","amount":"0x<uint256>"}
```

---

#### `erc1155_withdraw_batch`
Emit a voucher calling `token.safeBatchTransferFrom(appAddress, receiver, ids, amounts, "")`.
```json
{
  "cmd":"erc1155_withdraw_batch",
  "token":"0x...",
  "receiver":"0x...",
  "ids":["0x1","0x2"],
  "amounts":["0x0a","0x14"]
}
```

---

#### `mint_erc721`
Emit a voucher calling `MintableERC721.mint(receiver, tokenId)`. Requires `set_mint_contract` to have been called first.
```json
{"cmd":"mint_erc721","receiver":"0x...","tokenId":"0x<uint256>"}
```

---

### Inspect inputs

#### `generate_reports`
Generate N reports of a given byte size (same 2 MB limit applies; failures do **not** reject the inspect).
```json
{"cmd":"generate_reports","size":1024,"count":2}
```

#### `echo`
Return the raw payload as a single report — useful for verifying encoding round-trips.
```json
{"cmd":"echo"}
```

---

## Deposits

Deposits are triggered on-chain via the portal contracts. The dapp detects them automatically by checking `msg_sender` against known portal addresses. Each deposit type emits an acknowledgement notice.

| Deposit | Notice payload (decoded) |
|---|---|
| ETH | `ETH OK` |
| ERC20 | `ERC20 OK`, or `ERC20 OK exec=0x…` when `execLayerData` is non-empty (hex of raw exec bytes) |
| ERC721 | `ERC721 OK` |
| ERC1155 single | `1155S OK` |
| ERC1155 batch | `1155B OK` |

### ERC-20 payload encoding (Rollups v2)

On-chain, [`InputEncoding.encodeERC20Deposit`](https://github.com/cartesi/rollups-contracts/blob/v2.0.1/src/common/InputEncoding.sol) uses **`abi.encodePacked`**: `token` (20 B) + `sender` (20 B) + `value` (32 B) + **`execLayerData`** (raw bytes). The dapp decodes **`execLayerData`** from byte offset **72** onward — not standard `abi.encode` with a dynamic offset.

### Note on withdrawals and balance tracking

This dapp is a **test tool** — it does not track balances. Every withdrawal command emits a voucher unconditionally. If the application contract does not actually hold the asset on-chain, the voucher will revert when executed on L1. This is the expected, correct Cartesi model: balance enforcement happens at L1 execution time, not at dapp logic time.

The test suite verifies:
- Valid advances are accepted and vouchers are correctly formed (suite 05)
- Attempting a withdrawal without a prior deposit still emits a voucher (suite 06)
- After epoch finalization, vouchers can be executed on L1 and L1 balances change correctly (suite 08)
- Notices can be validated against the on-chain Merkle root (suite 08)

---

## Troubleshooting

### Suite `03-notices`: ~1.85 MB case sometimes returns `EXCEPTION`

The test **“1 notice of 1.85 MB (under 2 MB limit) — accepted”** occasionally sees input status **`EXCEPTION`** instead of **`ACCEPTED`**, while smaller notices and the similar-sized **inspect** report in `04-reports` still pass. This looks like **advance-path** limits or stability, not a wrong assertion in the size math.

Tracked in [jplgarcia/tester#2](https://github.com/jplgarcia/tester/issues/2). Mitigations: fresh `cartesi run`, retry the suite, or align machine/node resources if you control them.

### `forge script` fails with "environment variable not found"

**Error:**
```
vm.envAddress: environment variable "CARTESI_APP_ADDRESS" not found
vm.envUint: environment variable "PRIVATE_KEY" not found
```

**Solution:** Set both environment variables before running forge script:

```bash
export CARTESI_APP_ADDRESS=0x<address from cartesi run>
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge script script/Deploy.s.sol --rpc-url http://localhost:6751/anvil --broadcast
```

### `forge script` fails with "Insufficient funds for gas"

**Error:**
```
error code -32003: Insufficient funds for gas * price + value
```

**Cause:** Cartesi's Anvil takes ~10 seconds to initialize account balances. If you run `forge script Deploy` immediately after starting `cartesi run`, the account will have no funds yet.

**Solution:** Wait before deploying:

```bash
# After running "cartesi run", wait at least 10 seconds
sleep 10

# Then deploy
export CARTESI_APP_ADDRESS=0x...
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cd contracts
forge script script/Deploy.s.sol --rpc-url http://localhost:6751/anvil --broadcast
```

**Alternative:** Verify the account is funded before deploying:

```bash
# Check if account has funds (should be > 0x0)
curl -s http://localhost:6751/anvil -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x260c013192813f80c7ded483454383d45cdbd3b0","latest"],"id":1}'

# If result is "0x0", wait a few more seconds and try again
```

| Output | Max payload |
|---|---|
| Notice | 2,097,152 bytes (2 MB) |
| Report | 2,097,152 bytes (2 MB) |
| Voucher calldata | 2,097,152 bytes (2 MB) |

Exceeding the limit causes the rollup server to reject the `/notice` or `/report` POST, which this dapp propagates as a rejected advance input for notices, and as a silently truncated run (no more reports) for inspect.
