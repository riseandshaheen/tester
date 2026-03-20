// =============================================================================
// Cartesi v2.0 Test DApp
//
// Advance commands (hex-encoded JSON payload):
//   {"cmd":"set_mint_contract","address":"0x..."}
//   {"cmd":"generate_notices","size":<bytes>,"count":<n>}
//   {"cmd":"eth_withdraw","receiver":"0x...","amount":"0x<uint256>"}
//   {"cmd":"erc20_withdraw","token":"0x...","receiver":"0x...","amount":"0x<uint256>"}
//   {"cmd":"erc721_withdraw","token":"0x...","receiver":"0x...","tokenId":"0x<uint256>"}
//   {"cmd":"erc1155_withdraw_single","token":"0x...","receiver":"0x...","id":"0x<uint256>","amount":"0x<uint256>"}
//   {"cmd":"erc1155_withdraw_batch","token":"0x...","receiver":"0x...","ids":["0x..."],"amounts":["0x..."]}
//   {"cmd":"mint_erc721","receiver":"0x...","tokenId":"0x<uint256>"}
//
// Deposits are auto-detected by msg_sender matching portal addresses.
//
// Inspect commands (hex-encoded JSON payload):
//   {"cmd":"generate_reports","size":<bytes>,"count":<n>}
//   {"cmd":"echo"}  → reports back the raw payload as a report
//
// =============================================================================

#include <stdio.h>
#include <iostream>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <algorithm>
#include <cstring>
#include <cstdint>
#include <stdexcept>

#include "3rdparty/cpp-httplib/httplib.h"
#include "3rdparty/picojson/picojson.h"

// =============================================================================
// PORTAL ADDRESSES  (Cartesi v2.0 — from `cartesi address-book`)
// =============================================================================
static const std::string ADDR_ETH_PORTAL           = "0xa632c5c05812c6a6149b7af5c56117d1d2603828";
static const std::string ADDR_ERC20_PORTAL          = "0xaca6586a0cf05bd831f2501e7b4aea550da6562d";
static const std::string ADDR_ERC721_PORTAL         = "0x9e8851dadb2b77103928518846c4678d48b5e371";
static const std::string ADDR_ERC1155_SINGLE_PORTAL = "0x18558398dd1a8ce20956287a4da7b76ae7a96662";
static const std::string ADDR_ERC1155_BATCH_PORTAL  = "0xe246abb974b307490d9c6932f48ebe79de72338a";

// =============================================================================
// ABI FUNCTION SELECTORS  (keccak256 of canonical signature, first 4 bytes)
// =============================================================================
// transfer(address,uint256)
static const uint8_t SEL_ERC20_TRANSFER[4]        = {0xa9, 0x05, 0x9c, 0xbb};
// safeTransferFrom(address,address,uint256)
static const uint8_t SEL_ERC721_SAFE_TRANSFER[4]  = {0x42, 0x84, 0x2e, 0x0e};
// safeTransferFrom(address,address,uint256,uint256,bytes)
static const uint8_t SEL_ERC1155_SAFE_TRANSFER[4] = {0xf2, 0x42, 0x43, 0x2a};
// safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
static const uint8_t SEL_ERC1155_SAFE_BATCH[4]    = {0x2e, 0xb2, 0xc2, 0xd6};
// mint(address,uint256)
static const uint8_t SEL_MINT[4]                  = {0x40, 0xc1, 0x0f, 0x19};
// withdrawEther(address,uint256)  — EtherPortal v2 withdrawal
static const uint8_t SEL_WITHDRAW_ETHER[4]        = {0x52, 0x2f, 0x68, 0x15};

// =============================================================================
// GLOBAL STATE
// =============================================================================
static std::string g_mint_contract; // address of MintableERC721 (set via advance)
static std::string g_app_address;   // self address (from advance metadata)

// =============================================================================
// HEX UTILITIES
// =============================================================================
static uint8_t hex_nibble(char c) {
    if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
    if (c >= 'a' && c <= 'f') return (uint8_t)(c - 'a' + 10);
    if (c >= 'A' && c <= 'F') return (uint8_t)(c - 'A' + 10);
    return 0;
}

static std::vector<uint8_t> hex_to_bytes(const std::string &hex) {
    std::string h = hex;
    if (h.size() >= 2 && h[0] == '0' && (h[1] == 'x' || h[1] == 'X'))
        h = h.substr(2);
    if (h.size() % 2 != 0) h = "0" + h;
    std::vector<uint8_t> bytes;
    bytes.reserve(h.size() / 2);
    for (size_t i = 0; i + 1 < h.size(); i += 2)
        bytes.push_back((uint8_t)((hex_nibble(h[i]) << 4) | hex_nibble(h[i + 1])));
    return bytes;
}

static std::string bytes_to_hex(const std::vector<uint8_t> &bytes, bool prefix = true) {
    static const char *hc = "0123456789abcdef";
    std::string r = prefix ? "0x" : "";
    r.reserve(r.size() + bytes.size() * 2);
    for (uint8_t b : bytes) {
        r += hc[(b >> 4) & 0xf];
        r += hc[b & 0xf];
    }
    return r;
}

static std::string to_lower(const std::string &s) {
    std::string r = s;
    std::transform(r.begin(), r.end(), r.begin(), ::tolower);
    return r;
}

// =============================================================================
// ABI ENCODING
// =============================================================================

// Left-pad val into a 32-byte ABI word
static std::vector<uint8_t> abi_word(const std::vector<uint8_t> &val) {
    std::vector<uint8_t> w(32, 0);
    size_t offset = (val.size() < 32) ? (32 - val.size()) : 0;
    for (size_t i = 0; i < val.size() && (offset + i) < 32; i++)
        w[offset + i] = val[i];
    return w;
}

static std::vector<uint8_t> abi_encode_address(const std::string &addr) {
    return abi_word(hex_to_bytes(addr));
}

static std::vector<uint8_t> abi_encode_uint256(const std::string &hex_val) {
    return abi_word(hex_to_bytes(hex_val));
}

static std::vector<uint8_t> abi_encode_uint64(uint64_t v) {
    std::vector<uint8_t> w(32, 0);
    for (int i = 0; i < 8; i++)
        w[31 - i] = (uint8_t)((v >> (8 * i)) & 0xff);
    return w;
}

static void append(std::vector<uint8_t> &dst, const std::vector<uint8_t> &src) {
    dst.insert(dst.end(), src.begin(), src.end());
}

static void append_sel(std::vector<uint8_t> &dst, const uint8_t sel[4]) {
    dst.insert(dst.end(), sel, sel + 4);
}

// Encode `bytes memory` (length word + data padded to 32-byte boundary)
static std::vector<uint8_t> abi_encode_bytes_value(const std::vector<uint8_t> &data) {
    std::vector<uint8_t> r;
    append(r, abi_encode_uint64((uint64_t)data.size()));
    append(r, data);
    size_t rem = data.size() % 32;
    if (rem != 0) {
        std::vector<uint8_t> pad(32 - rem, 0);
        append(r, pad);
    }
    return r;
}

// Encode uint256[] (length word + elements)
static std::vector<uint8_t> abi_encode_uint256_array_value(const std::vector<std::string> &vals) {
    std::vector<uint8_t> r;
    append(r, abi_encode_uint64((uint64_t)vals.size()));
    for (const auto &v : vals)
        append(r, abi_encode_uint256(v));
    return r;
}

// ── Voucher payload builders ─────────────────────────────────────────────────

// ERC20: transfer(address to, uint256 amount)
static std::vector<uint8_t> build_erc20_transfer(
    const std::string &to, const std::string &amount)
{
    std::vector<uint8_t> r;
    append_sel(r, SEL_ERC20_TRANSFER);
    append(r, abi_encode_address(to));
    append(r, abi_encode_uint256(amount));
    return r;
}

// ERC721: safeTransferFrom(address from, address to, uint256 tokenId)
static std::vector<uint8_t> build_erc721_safe_transfer(
    const std::string &from, const std::string &to, const std::string &token_id)
{
    std::vector<uint8_t> r;
    append_sel(r, SEL_ERC721_SAFE_TRANSFER);
    append(r, abi_encode_address(from));
    append(r, abi_encode_address(to));
    append(r, abi_encode_uint256(token_id));
    return r;
}

// ERC1155 single: safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)
static std::vector<uint8_t> build_erc1155_safe_transfer(
    const std::string &from, const std::string &to,
    const std::string &id, const std::string &amount)
{
    // Static: from(32) to(32) id(32) amount(32) bytes_offset(32) = 160
    // Dynamic: bytes value at offset 160
    std::vector<uint8_t> r;
    append_sel(r, SEL_ERC1155_SAFE_TRANSFER);
    append(r, abi_encode_address(from));
    append(r, abi_encode_address(to));
    append(r, abi_encode_uint256(id));
    append(r, abi_encode_uint256(amount));
    append(r, abi_encode_uint64(160));       // offset = 5 * 32
    append(r, abi_encode_bytes_value({}));   // empty bytes
    return r;
}

// ERC1155 batch: safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)
static std::vector<uint8_t> build_erc1155_safe_batch(
    const std::string &from, const std::string &to,
    const std::vector<std::string> &ids,
    const std::vector<std::string> &amounts)
{
    size_t N = ids.size();
    //  Head (5 static words at 32 bytes each = 160 bytes):
    //    [0]  from
    //    [1]  to
    //    [2]  offset→ids   = 5*32 = 160
    //    [3]  offset→amts  = 160 + 32 + N*32
    //    [4]  offset→data  = 160 + 2*(32 + N*32)
    uint64_t off_ids  = 5 * 32;
    uint64_t off_amts = off_ids  + 32 + (uint64_t)N * 32;
    uint64_t off_data = off_amts + 32 + (uint64_t)N * 32;

    std::vector<uint8_t> r;
    append_sel(r, SEL_ERC1155_SAFE_BATCH);
    append(r, abi_encode_address(from));
    append(r, abi_encode_address(to));
    append(r, abi_encode_uint64(off_ids));
    append(r, abi_encode_uint64(off_amts));
    append(r, abi_encode_uint64(off_data));
    append(r, abi_encode_uint256_array_value(ids));
    append(r, abi_encode_uint256_array_value(amounts));
    append(r, abi_encode_bytes_value({}));
    return r;
}

// MintableERC721: mint(address to, uint256 tokenId)
static std::vector<uint8_t> build_erc721_mint(
    const std::string &to, const std::string &token_id)
{
    std::vector<uint8_t> r;
    append_sel(r, SEL_MINT);
    append(r, abi_encode_address(to));
    append(r, abi_encode_uint256(token_id));
    return r;
}

// EtherPortal: withdrawEther(address receiver, uint256 amount)
static std::vector<uint8_t> build_eth_withdraw(
    const std::string &receiver, const std::string &amount)
{
    std::vector<uint8_t> r;
    append_sel(r, SEL_WITHDRAW_ETHER);
    append(r, abi_encode_address(receiver));
    append(r, abi_encode_uint256(amount));
    return r;
}

// =============================================================================
// ROLLUP HTTP HELPERS
// =============================================================================
// Returns true on success, false if the rollup server rejected the payload
// (e.g. payload exceeds the 2 MB per-output limit).
static bool emit_notice(httplib::Client &cli, const std::string &payload_hex) {
    std::string body = "{\"payload\":\"" + payload_hex + "\"}";
    auto res = cli.Post("/notice", body, "application/json");
    if (!res || res->status >= 400) {
        std::cerr << "[notice] emit failed (status="
                  << (res ? std::to_string(res->status) : "no response") << ")\n";
        return false;
    }
    return true;
}

static bool emit_report(httplib::Client &cli, const std::string &payload_hex) {
    std::string body = "{\"payload\":\"" + payload_hex + "\"}";
    auto res = cli.Post("/report", body, "application/json");
    if (!res || res->status >= 400) {
        std::cerr << "[report] emit failed (status="
                  << (res ? std::to_string(res->status) : "no response") << ")\n";
        return false;
    }
    return true;
}

static void emit_voucher(httplib::Client &cli,
                         const std::string &destination,
                         const std::string &payload_hex,
                         const std::string &value_hex = "")
{
    std::string body;
    if (value_hex.empty()) {
        body = "{\"destination\":\"" + destination
              + "\",\"payload\":\"" + payload_hex + "\"}";
    } else {
        // value_hex must be 64 hex chars (32 bytes); rollup server requires 0x prefix
        body = "{\"destination\":\"" + destination
              + "\",\"payload\":\"" + payload_hex
              + "\",\"value\":\"0x" + value_hex + "\"}";  
    }
    auto res = cli.Post("/voucher", body, "application/json");
    if (!res || res->status >= 400)
        std::cerr << "[voucher] emit failed\n";
}

// =============================================================================
// DEPOSIT PARSERS
// Portals encode their payloads with abi.encode(), producing 32-byte aligned words.
// Each parser reads at fixed word offsets and logs the decoded fields.
// =============================================================================

static std::vector<uint8_t> abi_word_at(const std::vector<uint8_t> &data, size_t offset) {
    if (offset + 32 > data.size()) return std::vector<uint8_t>(32, 0);
    return std::vector<uint8_t>(data.begin() + (ptrdiff_t)offset,
                                data.begin() + (ptrdiff_t)(offset + 32));
}

static std::string word_to_addr(const std::vector<uint8_t> &word) {
    // last 20 bytes of a 32-byte ABI address word
    std::vector<uint8_t> addr(word.begin() + 12, word.end());
    return bytes_to_hex(addr);
}

static std::string word_to_uint256(const std::vector<uint8_t> &word) {
    return bytes_to_hex(word);
}

static uint64_t word_to_uint64(const std::vector<uint8_t> &word) {
    uint64_t v = 0;
    for (int i = 24; i < 32; i++) v = (v << 8) | word[(size_t)i];
    return v;
}

// ETH: abi.encode(address depositor, uint256 value, bytes execLayerData)
static void parse_eth_deposit(const std::vector<uint8_t> &p) {
    if (p.size() < 96) { std::cerr << "[ETH deposit] payload too short\n"; return; }
    std::cout << "[ETH deposit]"
              << " depositor=" << word_to_addr(abi_word_at(p, 0))
              << " value="     << word_to_uint256(abi_word_at(p, 32)) << std::endl;
}

// ERC20: abi.encode(bool success, address token, address depositor, uint256 amount, bytes execLayerData)
static void parse_erc20_deposit(const std::vector<uint8_t> &p) {
    if (p.size() < 128) { std::cerr << "[ERC20 deposit] payload too short\n"; return; }
    std::cout << "[ERC20 deposit]"
              << " success="  << (p[31] ? "true" : "false")
              << " token="    << word_to_addr(abi_word_at(p, 32))
              << " depositor="<< word_to_addr(abi_word_at(p, 64))
              << " amount="   << word_to_uint256(abi_word_at(p, 96)) << std::endl;
}

// ERC721: abi.encode(address token, address sender, uint256 tokenId, bytes baseLayerData, bytes execLayerData)
static void parse_erc721_deposit(const std::vector<uint8_t> &p) {
    if (p.size() < 96) { std::cerr << "[ERC721 deposit] payload too short\n"; return; }
    std::cout << "[ERC721 deposit]"
              << " token="   << word_to_addr(abi_word_at(p, 0))
              << " sender="  << word_to_addr(abi_word_at(p, 32))
              << " tokenId=" << word_to_uint256(abi_word_at(p, 64)) << std::endl;
}

// ERC1155 single: abi.encode(address token, address sender, uint256 id, uint256 amount, bytes baseLayerData, bytes execLayerData)
static void parse_erc1155_single_deposit(const std::vector<uint8_t> &p) {
    if (p.size() < 128) { std::cerr << "[ERC1155 single] payload too short\n"; return; }
    std::cout << "[ERC1155 single deposit]"
              << " token="  << word_to_addr(abi_word_at(p, 0))
              << " sender=" << word_to_addr(abi_word_at(p, 32))
              << " id="     << word_to_uint256(abi_word_at(p, 64))
              << " amount=" << word_to_uint256(abi_word_at(p, 96)) << std::endl;
}

// ERC1155 batch: abi.encode(address token, address sender, uint256[] ids, uint256[] amounts, bytes baseLayerData, bytes execLayerData)
static void parse_erc1155_batch_deposit(const std::vector<uint8_t> &p) {
    // Payload format (InputEncoding.sol encodeBatchERC1155Deposit):
    //   abi.encodePacked(token[20B], sender[20B],
    //       abi.encode(tokenIds[], values[], baseLayerData, execLayerData))
    // Addresses are 20-byte packed (NOT 32-byte ABI-padded).
    // ABI sub-encoding starts at byte 40; its offsets are relative to byte 40.
    if (p.size() < 40 + 64) { std::cerr << "[ERC1155 batch] payload too short\n"; return; }
    std::string token  = bytes_to_hex(std::vector<uint8_t>(p.begin(), p.begin() + 20));
    std::string sender = bytes_to_hex(std::vector<uint8_t>(p.begin() + 20, p.begin() + 40));
    const size_t base = 40;  // sub-encoding starts here
    // Offsets in sub-encoding are relative to base
    uint64_t ids_rel  = word_to_uint64(abi_word_at(p, base +  0));
    uint64_t amts_rel = word_to_uint64(abi_word_at(p, base + 32));
    uint64_t ids_off  = base + ids_rel;
    uint64_t amts_off = base + amts_rel;
    uint64_t ids_len  = 0, amts_len = 0;
    if (ids_off  + 32 <= p.size()) ids_len  = word_to_uint64(abi_word_at(p, (size_t)ids_off));
    if (amts_off + 32 <= p.size()) amts_len = word_to_uint64(abi_word_at(p, (size_t)amts_off));
    std::cout << "[ERC1155 batch deposit]"
              << " token=" << token << " sender=" << sender
              << " ids_count=" << ids_len << std::endl;
    for (uint64_t i = 0; i < ids_len; i++) {
        std::string id  = word_to_uint256(abi_word_at(p, (size_t)(ids_off  + 32 + i * 32)));
        std::string amt = (i < amts_len)
            ? word_to_uint256(abi_word_at(p, (size_t)(amts_off + 32 + i * 32))) : "?";
        std::cout << "  [" << i << "] id=" << id << " amount=" << amt << std::endl;
    }
}

// =============================================================================
// PAYLOAD HELPERS
// =============================================================================

// Generate a test payload of exactly `size` bytes (repeating pattern)
static std::string make_payload(size_t size_bytes) {
    std::vector<uint8_t> data(size_bytes);
    for (size_t i = 0; i < size_bytes; i++)
        data[i] = (uint8_t)(i & 0xff);
    return bytes_to_hex(data);
}

// Decode hex payload into a UTF-8 string (for JSON parsing)
static std::string hex_payload_to_string(const std::string &hex_payload) {
    std::vector<uint8_t> bytes = hex_to_bytes(hex_payload);
    return std::string(bytes.begin(), bytes.end());
}

// =============================================================================
// ADVANCE HANDLER
// =============================================================================
static std::string handle_advance(httplib::Client &cli, picojson::value data) {
    picojson::value metadata  = data.get("metadata");
    std::string msg_sender    = to_lower(metadata.get("msg_sender").get<std::string>());
    std::string payload_hex   = data.get("payload").get<std::string>();

    // Record the app's own address the first time we see it
    if (g_app_address.empty() && metadata.contains("app_contract")) {
        g_app_address = to_lower(metadata.get("app_contract").get<std::string>());
        std::cout << "[advance] app_address=" << g_app_address << std::endl;
    }

    std::cout << "[advance] msg_sender=" << msg_sender << std::endl;

    // ── Detect deposits by msg_sender matching a portal address ───────────
    std::vector<uint8_t> raw = hex_to_bytes(payload_hex);

    if (msg_sender == ADDR_ETH_PORTAL) {
        parse_eth_deposit(raw);
        emit_notice(cli, bytes_to_hex(std::vector<uint8_t>({'E','T','H',' ','O','K'})));
        return "accept";
    }
    if (msg_sender == ADDR_ERC20_PORTAL) {
        parse_erc20_deposit(raw);
        emit_notice(cli, bytes_to_hex(std::vector<uint8_t>({'E','R','C','2','0',' ','O','K'})));
        return "accept";
    }
    if (msg_sender == ADDR_ERC721_PORTAL) {
        parse_erc721_deposit(raw);
        emit_notice(cli, bytes_to_hex(std::vector<uint8_t>({'E','R','C','7','2','1',' ','O','K'})));
        return "accept";
    }
    if (msg_sender == ADDR_ERC1155_SINGLE_PORTAL) {
        parse_erc1155_single_deposit(raw);
        emit_notice(cli, bytes_to_hex(std::vector<uint8_t>({'1','1','5','5','S',' ','O','K'})));
        return "accept";
    }
    if (msg_sender == ADDR_ERC1155_BATCH_PORTAL) {
        parse_erc1155_batch_deposit(raw);
        emit_notice(cli, bytes_to_hex(std::vector<uint8_t>({'1','1','5','5','B',' ','O','K'})));
        return "accept";
    }

    // ── Regular JSON input ─────────────────────────────────────────────────
    std::string json_str = hex_payload_to_string(payload_hex);
    picojson::value input;
    std::string parse_err = picojson::parse(input, json_str);
    if (!parse_err.empty() || !input.is<picojson::object>()) {
        std::cerr << "[advance] cannot parse JSON payload: " << parse_err << std::endl;
        return "reject";
    }

    if (!input.contains("cmd")) {
        std::cerr << "[advance] missing 'cmd' field in JSON\n";
        return "reject";
    }

    std::string cmd = input.get("cmd").get<std::string>();
    std::cout << "[advance] cmd=" << cmd << std::endl;

    // set_mint_contract ──────────────────────────────────────────────────────
    if (cmd == "set_mint_contract") {
        g_mint_contract = to_lower(input.get("address").get<std::string>());
        std::cout << "[advance] mint_contract=" << g_mint_contract << std::endl;
        std::string msg = "mint_contract=" + g_mint_contract;
        emit_notice(cli, bytes_to_hex(std::vector<uint8_t>(msg.begin(), msg.end())));
        return "accept";
    }

    // generate_notices ───────────────────────────────────────────────────────
    if (cmd == "generate_notices") {
        size_t sz    = (size_t)input.get("size").get<double>();
        size_t count = (size_t)input.get("count").get<double>();
        std::string payload = make_payload(sz);
        std::cout << "[advance] generating " << count
                  << " notices of " << sz << " bytes" << std::endl;
        for (size_t i = 0; i < count; i++) {
            if (!emit_notice(cli, payload)) {
                std::cerr << "[advance] notice " << i << " rejected (too large?)\n";
                return "reject";
            }
        }
        return "accept";
    }

    // eth_withdraw ───────────────────────────────────────────────────────────
    // v2: destination=receiver, payload=0x (empty), value=amount as 64-char hex
    if (cmd == "eth_withdraw") {
        std::string receiver = input.get("receiver").get<std::string>();
        std::string amount   = input.get("amount").get<std::string>();
        // Strip 0x prefix and left-pad to 64 hex chars (32 bytes)
        std::string amt_hex = amount;
        if (amt_hex.size() >= 2 && amt_hex[0] == '0' && (amt_hex[1] == 'x' || amt_hex[1] == 'X'))
            amt_hex = amt_hex.substr(2);
        while (amt_hex.size() < 64) amt_hex = "0" + amt_hex;
        emit_voucher(cli, receiver, "0x", amt_hex);
        std::cout << "[advance] voucher: eth_withdraw to=" << receiver
                  << " value=" << amt_hex << std::endl;
        return "accept";
    }

    // erc20_withdraw ─────────────────────────────────────────────────────────
    if (cmd == "erc20_withdraw") {
        std::string token    = input.get("token").get<std::string>();
        std::string receiver = input.get("receiver").get<std::string>();
        std::string amount   = input.get("amount").get<std::string>();
        auto calldata = build_erc20_transfer(receiver, amount);
        emit_voucher(cli, token, bytes_to_hex(calldata));
        std::cout << "[advance] voucher: erc20_withdraw token=" << token
                  << " to=" << receiver << std::endl;
        return "accept";
    }

    // erc721_withdraw ────────────────────────────────────────────────────────
    if (cmd == "erc721_withdraw") {
        if (g_app_address.empty()) {
            std::cerr << "[advance] app_address unknown; send at least one advance first\n";
            return "reject";
        }
        std::string token    = input.get("token").get<std::string>();
        std::string receiver = input.get("receiver").get<std::string>();
        std::string token_id = input.get("tokenId").get<std::string>();
        auto calldata = build_erc721_safe_transfer(g_app_address, receiver, token_id);
        emit_voucher(cli, token, bytes_to_hex(calldata));
        std::cout << "[advance] voucher: erc721_withdraw to=" << receiver
                  << " tokenId=" << token_id << std::endl;
        return "accept";
    }

    // erc1155_withdraw_single ────────────────────────────────────────────────
    if (cmd == "erc1155_withdraw_single") {
        if (g_app_address.empty()) { std::cerr << "[advance] app_address unknown\n"; return "reject"; }
        std::string token    = input.get("token").get<std::string>();
        std::string receiver = input.get("receiver").get<std::string>();
        std::string id       = input.get("id").get<std::string>();
        std::string amount   = input.get("amount").get<std::string>();
        auto calldata = build_erc1155_safe_transfer(g_app_address, receiver, id, amount);
        emit_voucher(cli, token, bytes_to_hex(calldata));
        std::cout << "[advance] voucher: erc1155_withdraw_single to=" << receiver << std::endl;
        return "accept";
    }

    // erc1155_withdraw_batch ─────────────────────────────────────────────────
    if (cmd == "erc1155_withdraw_batch") {
        if (g_app_address.empty()) { std::cerr << "[advance] app_address unknown\n"; return "reject"; }
        std::string token    = input.get("token").get<std::string>();
        std::string receiver = input.get("receiver").get<std::string>();
        picojson::array ids_arr    = input.get("ids").get<picojson::array>();
        picojson::array amounts_arr= input.get("amounts").get<picojson::array>();
        std::vector<std::string> ids, amounts;
        for (auto &v : ids_arr)     ids.push_back(v.get<std::string>());
        for (auto &v : amounts_arr) amounts.push_back(v.get<std::string>());
        auto calldata = build_erc1155_safe_batch(g_app_address, receiver, ids, amounts);
        emit_voucher(cli, token, bytes_to_hex(calldata));
        std::cout << "[advance] voucher: erc1155_withdraw_batch ids=" << ids.size()
                  << " to=" << receiver << std::endl;
        return "accept";
    }

    // mint_erc721 ────────────────────────────────────────────────────────────
    if (cmd == "mint_erc721") {
        if (g_mint_contract.empty()) {
            std::cerr << "[advance] mint_contract not set; send set_mint_contract first\n";
            return "reject";
        }
        std::string receiver = input.get("receiver").get<std::string>();
        std::string token_id = input.get("tokenId").get<std::string>();
        auto calldata = build_erc721_mint(receiver, token_id);
        emit_voucher(cli, g_mint_contract, bytes_to_hex(calldata));
        std::cout << "[advance] voucher: mint_erc721 to=" << receiver
                  << " tokenId=" << token_id << std::endl;
        return "accept";
    }

    std::cerr << "[advance] unknown cmd: " << cmd << std::endl;
    return "reject";
}

// =============================================================================
// INSPECT HANDLER
// =============================================================================
static std::string handle_inspect(httplib::Client &cli, picojson::value data) {
    if (!data.contains("payload")) {
        std::cerr << "[inspect] missing 'payload' field\n";
        return "reject";
    }
    
    std::string payload_hex = data.get("payload").get<std::string>();
    std::string json_str    = hex_payload_to_string(payload_hex);
    std::cout << "[inspect] raw payload: " << json_str << std::endl;

    // Cartesi v2: the inspect REST endpoint wraps the client body in an outer
    // {"payload":"0x..."} before passing it to the dapp.  Unwrap it so the
    // dapp sees the actual JSON command the client sent.
    {
        picojson::value outer;
        std::string outer_err = picojson::parse(outer, json_str);
        if (outer_err.empty() && outer.is<picojson::object>() &&
            outer.contains("payload") && !outer.contains("cmd")) {
            std::string inner_hex = outer.get("payload").get<std::string>();
            payload_hex = inner_hex;
            json_str    = hex_payload_to_string(inner_hex);
            std::cout << "[inspect] unwrapped v2 envelope, inner payload: " << json_str << std::endl;
        }
    }
    std::cout << "[inspect] decoded payload: " << json_str << std::endl;

    picojson::value input;
    std::string parse_err = picojson::parse(input, json_str);
    if (!parse_err.empty()) {
        std::cerr << "[inspect] parse error: " << parse_err << std::endl;
        std::cout << "[inspect] echoing payload due to parse error\n";
        emit_report(cli, payload_hex);
        return "accept";
    }
    if (!input.is<picojson::object>()) {
        std::cerr << "[inspect] input is not an object\n";
        std::cout << "[inspect] echoing payload (not object)\n";
        emit_report(cli, payload_hex);
        return "accept";
    }

    if (!input.contains("cmd")) {
        std::cerr << "[inspect] missing 'cmd' field\n";
        emit_report(cli, payload_hex);
        return "accept";
    }

    std::string cmd = input.get("cmd").get<std::string>();
    std::cout << "[inspect] cmd=" << cmd << std::endl;

    // generate_reports ───────────────────────────────────────────────────────
    if (cmd == "generate_reports") {
        if (!input.contains("size") || !input.contains("count")) {
            std::cerr << "[inspect] missing 'size' or 'count' fields\n";
            return "accept";
        }
        size_t sz    = (size_t)input.get("size").get<double>();
        size_t count = (size_t)input.get("count").get<double>();
        std::string payload = make_payload(sz);
        std::cout << "[inspect] generated payload of " << payload.length() << " bytes (hex)\n";
        std::cout << "[inspect] generating " << count
                  << " reports of " << sz << " bytes each" << std::endl;
        for (size_t i = 0; i < count; i++) {
            std::cout << "[inspect] emitting report " << i << "...\n";
            if (!emit_report(cli, payload)) {
                std::cerr << "[inspect] report " << i << " rejected (too large?)\n";
                return "accept"; // inspect always returns accept, but no more reports
            }
            std::cout << "[inspect] report " << i << " emitted successfully\n";
        }
        std::cout << "[inspect] done emitting " << count << " reports\n";
        return "accept";
    }

    // echo ───────────────────────────────────────────────────────────────────
    if (cmd == "echo") {
        emit_report(cli, payload_hex);
        return "accept";
    }

    std::string err = "unknown inspect cmd: " + cmd;
    emit_report(cli, bytes_to_hex(std::vector<uint8_t>(err.begin(), err.end())));
    return "accept";
}

// =============================================================================
// MAIN
// =============================================================================
int main(int argc, char **argv) {
    const char *rollup_url = getenv("ROLLUP_HTTP_SERVER_URL");
    if (!rollup_url) {
        std::cerr << "[main] ROLLUP_HTTP_SERVER_URL not set\n";
        return 1;
    }

    httplib::Client cli(rollup_url);
    cli.set_read_timeout(60, 0); // generous for large payloads
    cli.set_write_timeout(60, 0); // allow time to send large reports
    cli.set_connection_timeout(30, 0); // connection timeout

    std::map<std::string,
             std::string(*)(httplib::Client &, picojson::value)> handlers = {
        {"advance_state", &handle_advance},
        {"inspect_state", &handle_inspect},
    };

    std::string status = "accept";
    while (true) {
        std::cout << "[main] /finish status=" << status << std::endl;
        std::string body = "{\"status\":\"" + status + "\"}";
        auto r = cli.Post("/finish", body, "application/json");
        if (!r) {
            std::cerr << "[main] connection error on /finish, retrying...\n";
            continue;
        }
        if (r->status == 202) {
            std::cout << "[main] no pending request\n";
            continue;
        }

        picojson::value req;
        std::string err = picojson::parse(req, r->body);
        if (!err.empty()) {
            std::cerr << "[main] failed to parse rollup request: " << err << "\n";
            status = "reject";
            continue;
        }

        std::string request_type = req.get("request_type").get<std::string>();
        auto it = handlers.find(request_type);
        if (it == handlers.end()) {
            std::cerr << "[main] unknown request_type: " << request_type << "\n";
            status = "reject";
            continue;
        }

        try {
            status = it->second(cli, req.get("data"));
        } catch (const std::exception &e) {
            std::cerr << "[main] exception: " << e.what() << "\n";
            status = "reject";
        }
    }
    return 0;
}
