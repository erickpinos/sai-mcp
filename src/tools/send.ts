import { ethers } from "ethers";
import { z } from "zod";
import {
  ERC20_ABI,
  getWallet,
  MIN_GAS_PRICE_WEI,
  normalizeEvmAddress,
  normalizeRecipientToEvm,
} from "../chain.js";
import type { Network } from "../client.js";
import { toPlainDecimalString, toTokenAmountString } from "../format.js";

const NetworkSchema = z
  .enum(["mainnet", "testnet"])
  .default("mainnet")
  .describe("Network to use. Defaults to mainnet.");

export const sendSchema = {
  network: NetworkSchema,
  to: z
    .string()
    .min(1)
    .describe(
      "Recipient address. Accepts an EVM 0x... address or a Nibiru nibi1... bech32 address (converted automatically).",
    ),
  token: z
    .string()
    .default("usdc")
    .describe(
      'Which asset to send: "nibi" (native gas token), "usdc" (collateral, shorthand for its contract), or any ERC20 token contract address (0x...) — e.g. stNIBI or another deposited token. Decimals are read from the contract. Defaults to "usdc".',
    ),
  amount: z
    .number()
    .positive()
    .finite()
    .nullable()
    .default(null)
    .describe(
      "Amount to send in human units (e.g. 0.9 = 0.9 tokens). Leave null and set all=true to sweep the entire balance.",
    ),
  all: z
    .boolean()
    .default(false)
    .describe(
      "Send the entire balance of the chosen token (to empty the wallet). For 'nibi' a small gas reserve is kept back so the transfer can pay for itself. Mutually exclusive with amount: set exactly one.",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Required to broadcast. Defaults to false (dry-run: resolve recipient, check balances, estimate gas; sign and send nothing). Set true to actually transfer.",
    ),
};

type SendArgs = {
  network: Network;
  to: string;
  token: string;
  amount: number | null;
  all: boolean;
  confirm: boolean;
};

// Resolve the `token` arg to a transfer mode. "nibi" => native value send;
// "usdc" => the configured collateral ERC20; a 0x... => an arbitrary ERC20
// (stNIBI or anything else a user deposited), so the tool isn't limited to USDC.
function resolveToken(
  tokenArg: string,
  usdcEvm: string,
): { native: true } | { native: false; address: string } {
  const t = tokenArg.trim();
  if (t.toLowerCase() === "nibi") return { native: true };
  if (t.toLowerCase() === "usdc") return { native: false, address: usdcEvm };
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) {
    return { native: false, address: normalizeEvmAddress(t) };
  }
  throw new Error(
    `Unrecognized token "${tokenArg}". Use "nibi", "usdc", or an ERC20 token contract address (0x...).`,
  );
}

// Plain on-chain transfers are NOT routed through the gas-sponsored perp
// contract, so they use the network gas price (currently 0 on Nibiru mainnet).
// The handler resolves the recipient and token, sizes the amount (explicit or
// full-balance sweep), prices gas, and runs a dry-run-by-default flow mirroring
// the trade tools. Works for native NIBI and any ERC20 (USDC, stNIBI, ...).
export async function send(args: SendArgs) {
  const { wallet, provider, evmAddress, bech32Address, cfg } = getWallet(args.network);

  const to = normalizeRecipientToEvm(args.to);
  if (to.toLowerCase() === evmAddress.toLowerCase()) {
    throw new Error("Recipient is the signer's own address; nothing to send.");
  }
  // amount XOR all — reject ambiguous (both) and underspecified (neither) calls.
  if (args.all === (args.amount !== null)) {
    throw new Error(
      "Specify exactly one of: `amount` (a positive number) or `all: true` (sweep the full balance).",
    );
  }

  const resolved = resolveToken(args.token, cfg.usdcEvm);

  const [net, nonce, feeData, nativeBalance] = await Promise.all([
    provider.getNetwork(),
    provider.getTransactionCount(evmAddress, "pending"),
    provider.getFeeData(),
    provider.getBalance(evmAddress),
  ]);

  // A non-sponsored tx needs a concrete gas price up front so the full-balance
  // sweep can reserve exactly what the broadcast will spend. ethers exposes the
  // legacy gasPrice on Nibiru; fall back to maxFeePerGas if only EIP-1559 fields
  // are present. Both report 0 here, but the chain still enforces a nonzero
  // minimum when it deducts gas on broadcast (sponsorship is specific to the
  // perp contract, not plain transfers), so floor to MIN_GAS_PRICE_WEI — a tx
  // signed at 0 reverts with INSUFFICIENT_FUNDS otherwise.
  const reportedGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const gasPrice =
    reportedGasPrice > MIN_GAS_PRICE_WEI ? reportedGasPrice : MIN_GAS_PRICE_WEI;

  let tokenLabel: string;
  let tokenContract: string | undefined;
  let decimals: number;
  let amountRaw: bigint; // on-chain integer amount of the asset being sent
  let humanAmount: string;
  let gasLimit: bigint;
  let buildTx: () => Promise<ethers.TransactionResponse>;
  let balanceHuman: string;

  if (!resolved.native) {
    tokenContract = resolved.address;
    const erc20 = new ethers.Contract(resolved.address, ERC20_ABI, wallet);

    // Read decimals/symbol/balance from the contract so any ERC20 works without
    // hardcoded metadata. symbol() is optional (non-standard tokens omit it).
    const [decRaw, symRaw, tokenBalance] = await Promise.all([
      erc20.decimals() as Promise<bigint>,
      (erc20.symbol() as Promise<string>).catch(() => null),
      erc20.balanceOf(evmAddress) as Promise<bigint>,
    ]);
    decimals = Number(decRaw);
    tokenLabel = symRaw ?? `ERC20 ${resolved.address.slice(0, 6)}…${resolved.address.slice(-4)}`;
    balanceHuman = ethers.formatUnits(tokenBalance, decimals);

    amountRaw = args.all
      ? tokenBalance
      : ethers.parseUnits(toTokenAmountString(args.amount!, decimals), decimals);
    if (amountRaw === 0n) {
      throw new Error(`Nothing to send: ${tokenLabel} balance is 0.`);
    }
    if (tokenBalance < amountRaw) {
      throw new Error(
        `Insufficient ${tokenLabel}: wallet has ${balanceHuman}, tried to send ${ethers.formatUnits(amountRaw, decimals)}.`,
      );
    }
    humanAmount = ethers.formatUnits(amountRaw, decimals);

    const est = await erc20.transfer
      .estimateGas(to, amountRaw)
      .catch(() => null as bigint | null);
    gasLimit = est !== null ? (est * 11n) / 10n : 100_000n;
    buildTx = () => erc20.transfer(to, amountRaw, { gasLimit, gasPrice });
  } else {
    tokenLabel = "NIBI";
    decimals = 18; // native NIBI is exposed as 18-decimal wei on the EVM layer
    balanceHuman = ethers.formatUnits(nativeBalance, 18);

    // Native value transfer (~21k gas). Estimate against a 1-wei probe so the
    // limit reflects the recipient (a contract recipient may cost more).
    const est = await provider
      .estimateGas({ from: evmAddress, to, value: 1n })
      .catch(() => 21_000n);
    gasLimit = (est * 12n) / 10n; // 20% buffer — native sends are cheap, headroom is fine
    const gasCostNative = gasLimit * gasPrice;

    if (args.all) {
      amountRaw = nativeBalance - gasCostNative;
      if (amountRaw <= 0n) {
        throw new Error(
          `Insufficient NIBI to cover gas: balance ${balanceHuman} NIBI is below the estimated gas cost ${ethers.formatUnits(gasCostNative, 18)} NIBI.`,
        );
      }
    } else {
      amountRaw = ethers.parseEther(toPlainDecimalString(args.amount!));
      if (nativeBalance < amountRaw + gasCostNative) {
        throw new Error(
          `Insufficient NIBI: need ${ethers.formatUnits(amountRaw + gasCostNative, 18)} (amount + gas), wallet has ${balanceHuman}.`,
        );
      }
    }
    humanAmount = ethers.formatUnits(amountRaw, 18);
    buildTx = () => wallet.sendTransaction({ to, value: amountRaw, gasLimit, gasPrice });
  }

  const gasCost = gasLimit * gasPrice;
  // For an ERC20 send, gas comes from the native balance and is separate from
  // the amount; flag when it is not covered so the caller knows to fund NIBI.
  const gasFunded = resolved.native
    ? nativeBalance >= amountRaw + gasCost
    : nativeBalance >= gasCost;

  const gasNote =
    "Gas sponsorship (gasPrice 0) applies ONLY to Sai perp-contract calls (open/close/update trade). This is a plain transfer, so it pays the chain's minimum gas price from the wallet's NIBI — the wallet needs native NIBI to send, even to withdraw USDC.";

  const summary = {
    network: args.network,
    action: "send" as const,
    token: tokenLabel,
    tokenContract,
    to,
    toBech32: /^nibi1/i.test(args.to.trim()) ? args.to.trim() : undefined,
    amount: humanAmount,
    decimals,
    sweepAll: args.all,
    wallet: {
      evmAddress,
      bech32Address,
      balanceBefore: balanceHuman,
      nonce,
      chainId: Number(net.chainId),
    },
    gas: {
      limit: gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      estimatedCostNibi: ethers.formatUnits(gasCost, 18),
      funded: gasFunded,
      note: gasNote,
    },
  };

  if (!args.confirm) {
    return {
      ...summary,
      status: "dry-run",
      warning: gasFunded
        ? undefined
        : `Wallet has insufficient NIBI for gas (${ethers.formatUnits(nativeBalance, 18)} NIBI). Fund a small amount of NIBI before broadcasting.`,
      note: "No transaction sent. Pass confirm=true to broadcast.",
    };
  }

  if (!gasFunded) {
    throw new Error(
      `Insufficient NIBI for gas: wallet has ${ethers.formatUnits(nativeBalance, 18)} NIBI, transfer needs ~${ethers.formatUnits(gasCost, 18)} for gas${resolved.native ? " on top of the amount" : ""}. Fund NIBI and retry.`,
    );
  }

  const tx = await buildTx();
  const receipt = await tx.wait();
  const success = receipt?.status === 1;

  return {
    ...summary,
    status: success ? "success" : "reverted",
    tx: {
      hash: tx.hash,
      explorer: cfg.explorerTx(tx.hash),
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
    },
  };
}
