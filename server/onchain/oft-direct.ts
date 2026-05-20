import { ethers } from "ethers";
import type { Request } from "express";
import type { SessionManager } from "../security.js";
import type { CrosschainOftTaskPayload } from "../tasks/types.js";
import { getEvmChain } from "./chains.js";
import {
  findOftRoute,
  getLayerZeroMessage,
  type OftRoute,
} from "./layerzero.js";
import { getSigner, resolveOnchainWallet } from "./wallets.js";

// OFT v2 ABI variants. Some adapters (including PEAQ) expose the standard
// overloads without a separate _extraOptions argument.
const OFT_V2_ABI = [
  "function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bool _payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) msgFee)",
  "function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bytes _extraOptions, bool _payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) msgFee, tuple(uint256 amountReceivedLD, uint256 amountSentLD, bytes32 oftReceipt) oftReceipt)",
  "function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) _msgFee, address _refundAddress) payable returns (tuple(bytes32 guid, uint64 nonce, tuple(uint256 nativeFee, uint256 lzTokenFee) fee) msgReceipt, tuple(uint256 amountReceivedLD, uint256 amountSentLD, bytes32 oftReceipt) oftReceipt)",
  "function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bytes _extraOptions, tuple(uint256 nativeFee, uint256 lzTokenFee) _msgFee, address _refundAddress) payable returns (tuple(bytes32 guid, uint64 nonce, tuple(uint256 nativeFee, uint256 lzTokenFee) fee) msgReceipt, tuple(uint256 amountReceivedLD, uint256 amountSentLD, bytes32 oftReceipt) oftReceipt)",
  "function token() view returns (address)",
];

const QUOTE_SEND_STANDARD =
  "quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)";
const QUOTE_SEND_EXTRA_OPTIONS =
  "quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bytes,bool)";
const SEND_STANDARD =
  "send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)";
const SEND_EXTRA_OPTIONS =
  "send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bytes,(uint256,uint256),address)";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const NATIVE_TOKEN_ADDRESSES = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000809",
]);

type OftCallable = (...args: unknown[]) => Promise<any>;
type OftContractWithFunctions = {
  getFunction(signature: string): OftCallable;
};

function isNativeTokenAddress(address: string | undefined): boolean {
  return Boolean(address && NATIVE_TOKEN_ADDRESSES.has(address.toLowerCase()));
}

function buildSendParam(
  dstEid: number,
  recipient: string,
  amountLD: bigint,
  minAmountLD: bigint,
  composeMsg: string,
  oftCmd: string,
) {
  return {
    dstEid,
    to: ethers.zeroPadValue(recipient, 32),
    amountLD,
    minAmountLD,
    extraOptions: "0x",
    composeMsg: composeMsg || "0x",
    oftCmd: oftCmd || "0x",
  };
}

export function isNativeDepositRequiredError(error: unknown): boolean {
  const reason =
    error && typeof error === "object" && "reason" in error
      ? String((error as { reason?: unknown }).reason ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${reason} ${message}`.includes("deposited amount must be non-zero");
}

function isUnsupportedDirectQuoteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("require(false)") ||
    message.includes("missing revert data") ||
    message.includes("no data present") ||
    message.includes("could not decode result data")
  );
}

function unsupportedDirectQuoteError(route: OftRoute): Error {
  return new Error(
    `直连模式不支持当前 OFT 合约的 quoteSend: ${route.symbol} ${route.srcChain}->${route.dstChain}。请改用 API 模式或更换支持 direct quoteSend 的路线。`,
  );
}

export function getNativeDepositValue(
  requiresNativeDeposit: boolean,
  requiresApproval: boolean,
  amountRaw: bigint,
): bigint {
  return requiresNativeDeposit && !requiresApproval ? amountRaw : 0n;
}

export function resolveDirectOftContext(route: OftRoute): {
  oftAddress: string;
  amountDecimals: number;
  requiresNativeDeposit: boolean;
  requiresApproval: boolean;
  underlyingTokenAddress?: string;
} {
  const underlyingTokenAddress = route.srcDeployment.innerTokenAddress;
  return {
    oftAddress: route.srcDeployment.address,
    amountDecimals: route.srcDeployment.localDecimals,
    requiresNativeDeposit: isNativeTokenAddress(route.srcDeployment.innerTokenAddress),
    requiresApproval: Boolean(route.srcDeployment.approvalRequired && underlyingTokenAddress),
    underlyingTokenAddress,
  };
}

async function resolvePayloadRoute(payload: CrosschainOftTaskPayload): Promise<OftRoute> {
  return findOftRoute({
    srcChain: payload.src_chain,
    dstChain: payload.dst_chain,
    tokenAddress: payload.token_address,
    dstTokenAddress: payload.dst_token_address,
    symbol: payload.symbol,
  });
}

function getOftFunction(
  oftContract: OftContractWithFunctions,
  signature: string,
) {
  return oftContract.getFunction(signature);
}

export async function quoteSend(
  oftContract: OftContractWithFunctions,
  sendParam: ReturnType<typeof buildSendParam>,
  amountRaw: bigint,
  requiresNativeDeposit: boolean,
): Promise<{
  msgFee: unknown;
  requiresNativeDeposit: boolean;
  overload: "standard" | "extraOptions";
}> {
  const standardQuoteSend = getOftFunction(oftContract, QUOTE_SEND_STANDARD);
  try {
    const msgFee = requiresNativeDeposit
      ? await standardQuoteSend(sendParam, false, { value: amountRaw })
      : await standardQuoteSend(sendParam, false);
    return {
      msgFee,
      requiresNativeDeposit,
      overload: "standard",
    };
  } catch (error) {
    if (!isUnsupportedDirectQuoteError(error) && !isNativeDepositRequiredError(error)) {
      throw error;
    }
  }

  const extraOptionsQuoteSend = getOftFunction(oftContract, QUOTE_SEND_EXTRA_OPTIONS);
  if (requiresNativeDeposit) {
    const [msgFee] = await extraOptionsQuoteSend(
      sendParam,
      "0x",
      false,
      { value: amountRaw },
    );
    return { msgFee, requiresNativeDeposit: true, overload: "extraOptions" };
  }

  try {
    const [msgFee] = await extraOptionsQuoteSend(sendParam, "0x", false);
    return { msgFee, requiresNativeDeposit: false, overload: "extraOptions" };
  } catch (error) {
    if (!isNativeDepositRequiredError(error)) throw error;
    const [msgFee] = await extraOptionsQuoteSend(
      sendParam,
      "0x",
      false,
      { value: amountRaw },
    );
    return { msgFee, requiresNativeDeposit: true, overload: "extraOptions" };
  }
}

async function sendOft(
  oftContract: ethers.Contract,
  overload: "standard" | "extraOptions",
  sendParam: ReturnType<typeof buildSendParam>,
  msgFee: [bigint, bigint],
  refundAddress: string,
  value: bigint,
) {
  if (overload === "standard") {
    return getOftFunction(oftContract, SEND_STANDARD)(
      sendParam,
      msgFee,
      refundAddress,
      { value },
    );
  }
  return getOftFunction(oftContract, SEND_EXTRA_OPTIONS)(
    sendParam,
    "0x",
    msgFee,
    refundAddress,
    { value },
  );
}

/**
 * Get a LayerZero OFT transfer quote by calling `quoteSend` on the OFT contract directly.
 * No LayerZero API key required.
 */
export async function directQuoteForPayload(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
): Promise<{
  quote: {
    id: string;
    dstAmount?: string;
    srcAmount: string;
    routeSteps?: Array<Record<string, unknown>>;
    userSteps?: Array<Record<string, unknown>>;
    raw: unknown;
  };
  amountRaw: string;
  walletAddress: string;
  raw: unknown;
}> {
  const wallet = resolveOnchainWallet(payload.wallet_id, session, req);
  const srcChain = getEvmChain(payload.src_chain);
  const dstChain = getEvmChain(payload.dst_chain);

  if (!payload.token_address) throw new Error("source token address is required");
  if (!ethers.isAddress(payload.token_address))
    throw new Error("source token address must be a valid EVM address");
  if (!ethers.isAddress(payload.recipient))
    throw new Error("recipient must be a valid EVM address");

  const route = await resolvePayloadRoute(payload);
  const {
    oftAddress,
    amountDecimals,
    requiresNativeDeposit,
    requiresApproval,
    underlyingTokenAddress,
  } = resolveDirectOftContext(route);
  const amountRaw = ethers.parseUnits(payload.amount, amountDecimals);
  const slippageBps = payload.slippage_bps ?? 50;
  const minAmountRaw = amountRaw - (amountRaw * BigInt(slippageBps)) / 10000n;

  const signer = await getSigner(wallet, payload.src_chain);
  const provider = signer.provider;
  if (!provider) throw new Error("No provider available");

  const oftContract = new ethers.Contract(oftAddress, OFT_V2_ABI, signer);

  const sendParam = buildSendParam(
    dstChain.endpointId,
    payload.recipient,
    amountRaw,
    minAmountRaw,
    payload.compose_msg ?? "",
    payload.oft_cmd ?? "",
  );

  // Check balances
  const nativeBalance = await provider.getBalance(wallet.address);
  let tokenBalance: bigint | undefined;
  let allowance: bigint | undefined;

  if (requiresApproval && underlyingTokenAddress) {
    const tokenContract = new ethers.Contract(underlyingTokenAddress, ERC20_ABI, provider);
    tokenBalance = await tokenContract.balanceOf(wallet.address);
    allowance = await tokenContract.allowance(wallet.address, oftAddress);
  } else {
    const tokenContract = new ethers.Contract(oftAddress, ERC20_ABI, provider);
    tokenBalance = await tokenContract.balanceOf(wallet.address);
  }

  const nativeDepositValue = getNativeDepositValue(
    requiresNativeDeposit,
    requiresApproval,
    amountRaw,
  );
  if (requiresApproval && (allowance ?? 0n) < amountRaw) {
    return {
      quote: {
        id: `${payload.src_chain}->${payload.dst_chain}:${oftAddress}`,
        srcAmount: amountRaw.toString(),
        dstAmount: payload.amount,
        routeSteps: [
          {
            type: "OFT",
            srcChainKey: payload.src_chain,
            dstChainKey: payload.dst_chain,
          },
        ],
        userSteps: [
          {
            type: "TRANSACTION",
            chainType: "EVM",
            chainKey: payload.src_chain,
            description: `Approve ${srcChain.label} OFT adapter`,
          },
        ],
        raw: {
          nativeFee: "0",
          approvalRequired: true,
          nativeDepositValue: nativeDepositValue.toString(),
          approvalInsufficient: true,
        },
      },
      amountRaw: amountRaw.toString(),
      walletAddress: wallet.address,
      raw: {
        nativeFee: "0",
        nativeBalance: nativeBalance.toString(),
        tokenBalance: tokenBalance?.toString(),
        allowance: allowance?.toString(),
        approvalRequired: true,
        nativeDepositValue: nativeDepositValue.toString(),
        approvalInsufficient: true,
      },
    };
  }

  let nativeFee: bigint;
  try {
    const { msgFee } = await quoteSend(
      oftContract,
      sendParam,
      amountRaw,
      nativeDepositValue > 0n,
    );
    nativeFee = (msgFee as Array<bigint>)[0] as bigint;
  } catch (error) {
    if (isUnsupportedDirectQuoteError(error)) throw unsupportedDirectQuoteError(route);
    throw error;
  }

  return {
    quote: {
      id: `${payload.src_chain}->${payload.dst_chain}:${oftAddress}`,
      srcAmount: amountRaw.toString(),
      dstAmount: payload.amount,
      routeSteps: [
        {
          type: "OFT",
          srcChainKey: payload.src_chain,
          dstChainKey: payload.dst_chain,
        },
      ],
      userSteps: [
        {
          type: "TRANSACTION",
          chainType: "EVM",
          chainKey: payload.src_chain,
          description: `Send OFT on ${srcChain.label} to ${dstChain.label}`,
        },
      ],
      raw: {
        nativeFee: nativeFee.toString(),
        approvalRequired: requiresApproval,
        nativeDepositValue: nativeDepositValue.toString(),
      },
    },
    amountRaw: amountRaw.toString(),
    walletAddress: wallet.address,
    raw: {
      nativeFee: nativeFee.toString(),
      nativeBalance: nativeBalance.toString(),
      tokenBalance: tokenBalance?.toString(),
      allowance: allowance?.toString(),
      approvalRequired: requiresApproval,
      nativeDepositValue: nativeDepositValue.toString(),
    },
  };
}

/**
 * Execute an OFT transfer by calling `send` on the OFT contract directly.
 * No LayerZero API key required.
 */
export async function directExecuteValueTransfer(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
): Promise<{ quote: { id: string }; txHashes: string[] }> {
  const wallet = resolveOnchainWallet(payload.wallet_id, session, req);
  const dstChain = getEvmChain(payload.dst_chain);

  if (!payload.token_address) throw new Error("source token address is required");

  const route = await resolvePayloadRoute(payload);
  const {
    oftAddress,
    amountDecimals,
    requiresNativeDeposit,
    requiresApproval,
    underlyingTokenAddress,
  } = resolveDirectOftContext(route);
  const amountRaw = ethers.parseUnits(payload.amount, amountDecimals);
  const slippageBps = payload.slippage_bps ?? 50;
  const minAmountRaw = amountRaw - (amountRaw * BigInt(slippageBps)) / 10000n;

  const signer = await getSigner(wallet, payload.src_chain);
  const oftContract = new ethers.Contract(oftAddress, OFT_V2_ABI, signer);

  const sendParam = buildSendParam(
    dstChain.endpointId,
    payload.recipient,
    amountRaw,
    minAmountRaw,
    payload.compose_msg ?? "",
    payload.oft_cmd ?? "",
  );

  // Handle approval if token() exists (OFTAdapter pattern)
  const txHashes: string[] = [];
  if (requiresApproval && underlyingTokenAddress) {
    const tokenContract = new ethers.Contract(underlyingTokenAddress, ERC20_ABI, signer);
    const allowance = await tokenContract.allowance(wallet.address, oftAddress);
    if (allowance < amountRaw) {
      const approvalTx = await tokenContract.approve(
        oftAddress,
        ethers.MaxUint256,
      );
      const receipt = await approvalTx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Approval failed: ${approvalTx.hash}`);
      }
      txHashes.push(approvalTx.hash);
    }
  } else {
    try {
      const tokenAddr: string = await oftContract.token();
      if (tokenAddr.toLowerCase() !== oftAddress.toLowerCase()) {
        const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
        const allowance = await tokenContract.allowance(
          wallet.address,
          oftAddress,
        );
        if (allowance < amountRaw) {
          const approvalTx = await tokenContract.approve(
            oftAddress,
            ethers.MaxUint256,
          );
          const receipt = await approvalTx.wait();
          if (!receipt || receipt.status !== 1) {
            throw new Error(`Approval failed: ${approvalTx.hash}`);
          }
          txHashes.push(approvalTx.hash);
        }
      }
    } catch {
      // No token() method or not an adapter — skip approval
    }
  }

  const nativeDepositValue = getNativeDepositValue(
    requiresNativeDeposit,
    requiresApproval,
    amountRaw,
  );
  let nativeFee: bigint;
  let overload: "standard" | "extraOptions";
  try {
    const quote = await quoteSend(
      oftContract,
      sendParam,
      amountRaw,
      nativeDepositValue > 0n,
    );
    const { msgFee } = quote;
    overload = quote.overload;
    nativeFee = (msgFee as Array<bigint>)[0] as bigint;
  } catch (error) {
    if (isUnsupportedDirectQuoteError(error)) throw unsupportedDirectQuoteError(route);
    throw error;
  }
  // Execute OFT send with the same overload that quoteSend accepted.
  const tx = await sendOft(
    oftContract,
    overload,
    sendParam,
    [nativeFee, 0n],
    wallet.address,
    nativeFee + nativeDepositValue,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`OFT send transaction failed: ${tx.hash}`);
  }
  txHashes.push(tx.hash);

  return {
    quote: { id: `${payload.src_chain}->${payload.dst_chain}:${oftAddress}` },
    txHashes,
  };
}

/**
 * Poll OFT delivery status using the public LayerZero Scan API.
 * No API key required.
 */
export async function directGetValueTransferStatus(
  sourceTxHash: string,
): Promise<{
  status: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  raw: unknown;
}> {
  try {
    const msg = await getLayerZeroMessage(sourceTxHash);
    if (!msg) {
      return {
        status: "SUBMITTED",
        sourceTxHash,
        raw: null,
      };
    }
    return {
      status: msg.status?.name ?? "SUBMITTED",
      sourceTxHash,
      destinationTxHash: msg.destination?.tx?.txHash,
      raw: msg,
    };
  } catch {
    return {
      status: "SUBMITTED",
      sourceTxHash,
      raw: null,
    };
  }
}
