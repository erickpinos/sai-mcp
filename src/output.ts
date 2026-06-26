// Tool output schemas (structured content).
//
// The MCP SDK VALIDATES a tool's returned `structuredContent` against its
// `outputSchema` and THROWS (McpError) on any mismatch. For a write tool that
// would be dangerous: a trade that was already broadcast on-chain would come
// back to the caller as an *error*, making a successful trade look failed. So
// these schemas are deliberately lenient — every field optional, rich/nested
// fields typed as `z.any()` — to DOCUMENT the result shape for clients without
// ever rejecting a genuine result. The accompanying human-readable `text`
// content still carries the full, exact payload.
import { z } from "zod";

// Envelope for the read tools, whose payloads are live GraphQL/REST responses
// whose shapes are owned upstream. Mirroring them field-by-field would be both a
// large surface and brittle (every upstream field add/null could fail
// validation), so the read tools advertise this envelope and put the payload
// under `result`.
export const resultEnvelopeSchema = {
  result: z
    .unknown()
    .describe(
      "The tool's result payload — an object, or an array of objects, from the Sai backend. Exact shape varies by tool; see the tool description.",
    ),
};

// sai_get_wallet_info — constructed in-repo, stable shape.
export const walletInfoOutputSchema = {
  network: z.string().optional(),
  evmAddress: z.string().optional().describe("Signer's 0x EVM address."),
  bech32Address: z.string().optional().describe("Signer's nibi1... address."),
  nonce: z.number().optional(),
  balances: z
    .any()
    .optional()
    .describe(
      "nibi { evmNative, bankUnibi } and usdc { erc20, bank, contract, decimals }, human units. NIBI is NOT needed to trade (Sai perp trades are gas-sponsored); it is used only for sai_send withdrawals/transfers, so do not treat a low or zero NIBI balance as blocking a trade. USDC is the collateral that funds trades.",
    ),
  chain: z.any().optional().describe("evmRpc, cosmosRest, evmInterface."),
  signerSource: z
    .string()
    .optional()
    .describe("Which env var supplied the key: SAI_PRIVATE_KEY or SAI_MNEMONIC."),
};

// sai_open_trade.
export const openTradeOutputSchema = {
  status: z
    .string()
    .optional()
    .describe(
      "dry-run = simulated/gas-estimated only, nothing sent; success | reverted = broadcast outcome.",
    ),
  network: z.string().optional(),
  market: z
    .any()
    .optional()
    .describe("Resolved market: marketId, symbol, currentPrice, leverageRange, minPositionSizeUSD."),
  trade: z
    .any()
    .optional()
    .describe("direction, leverage, collateralUsdc, positionSizeUsd, slippagePct, tp, sl."),
  wallet: z.any().optional().describe("evmAddress, bech32Address, usdcBalance, nonce, chainId."),
  gas: z.any().optional().describe("estimate, limit, estimationError, gasPrice (sponsored)."),
  guards: z.any().optional().describe("Operator-set caps in effect."),
  wasmMsg: z.any().optional().describe("The exact CosmWasm open_trade message that was/would be sent."),
  tx: z.any().optional().describe("Present only when broadcast: hash, explorer URL, blockNumber, gasUsed."),
  broadcastWithFallbackGas: z
    .boolean()
    .optional()
    .describe("True when sent without a validated gas estimate (estimation failed; used fallback limit)."),
  note: z.string().optional(),
};

// Shared by sai_close_trade, sai_update_tpsl, sai_update_leverage — same family
// of fields, each tool populating the subset it uses.
export const manageTradeOutputSchema = {
  status: z.string().optional().describe("dry-run | success | reverted."),
  network: z.string().optional(),
  action: z
    .string()
    .optional()
    .describe("close-position | cancel-order | update-tpsl | update-leverage."),
  trade: z.any().optional().describe("Resolved position: index, symbol, direction, leverage, pnl, etc."),
  changes: z.any().optional().describe("update-tpsl only: tp/sl { from, to }."),
  collateral: z
    .any()
    .optional()
    .describe("update-leverage only: deltaUsdc, direction (freed-to / pulled-from wallet), from/to."),
  wallet: z.any().optional().describe("evmAddress, bech32Address, nonce, chainId."),
  guards: z.any().optional(),
  gas: z.any().optional().describe("estimate, limit, estimationError, gasPrice (sponsored)."),
  wasmMsg: z.any().optional().describe("The exact CosmWasm message (close_trade / update_tp)."),
  tx: z.any().optional().describe("Present only when broadcast: hash, explorer URL, blockNumber, gasUsed."),
  note: z.string().optional(),
  warning: z.string().optional().describe("Freshly-opened-position advisory (revert risk within ~1-2 min)."),
  simulationNote: z.string().optional().describe("Interpreted on-chain simulation error, if any."),
};

// sai_send — plain USDC/NIBI transfer out of the signer wallet.
export const sendOutputSchema = {
  status: z.string().optional().describe("dry-run | success | reverted."),
  network: z.string().optional(),
  action: z.string().optional().describe("Always 'send'."),
  token: z.string().optional().describe("Token symbol/label: NIBI, USDC, or an ERC20's symbol."),
  tokenContract: z.string().optional().describe("ERC20 contract address (absent for native NIBI)."),
  to: z.string().optional().describe("Resolved 0x recipient address."),
  toBech32: z.string().optional().describe("Original nibi1... recipient, if one was given."),
  amount: z.string().optional().describe("Human-unit amount sent (full balance when sweepAll)."),
  decimals: z.number().optional().describe("Decimals of the sent asset."),
  sweepAll: z.boolean().optional().describe("True when emptying the full token balance."),
  wallet: z.any().optional().describe("evmAddress, bech32Address, balanceBefore, nonce, chainId."),
  gas: z.any().optional().describe("limit, gasPrice, estimatedCostNibi, funded — transfers are NOT sponsored."),
  tx: z.any().optional().describe("Present only when broadcast: hash, explorer URL, blockNumber, gasUsed."),
  warning: z.string().optional().describe("Surfaced when the wallet lacks NIBI to cover gas."),
  note: z.string().optional(),
};
