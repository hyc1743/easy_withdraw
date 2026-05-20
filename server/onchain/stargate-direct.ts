import { ethers } from "ethers";
import type { Request } from "express";
import type { CrosschainOftTaskPayload } from "../tasks/types.js";
import type { SessionManager } from "../security.js";
import { getEvmChain } from "./chains.js";
import { getSigner, resolveOnchainWallet } from "./wallets.js";

const STARGATE_METADATA_URL = "https://mainnet.stargate-api.com/v1/metadata?version=v2";

const STARGATE_ABI = [
  "function quoteOFT(tuple(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) _sendParam) view returns (tuple(uint256 minAmountLD,uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD,string description)[] oftFeeDetails, tuple(uint256 amountSentLD,uint256 amountReceivedLD) oftReceipt)",
  "function quoteSend(tuple(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) _sendParam,bool _payInLzToken) view returns (tuple(uint256 nativeFee,uint256 lzTokenFee) msgFee)",
  "function sendToken(tuple(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) _sendParam,tuple(uint256 nativeFee,uint256 lzTokenFee) _fee,address _refundAddress) payable returns (tuple(bytes32 guid,uint64 nonce,tuple(uint256 nativeFee,uint256 lzTokenFee) fee) msgReceipt,tuple(uint256 amountSentLD,uint256 amountReceivedLD) oftReceipt,tuple(uint72 ticketId,bytes passengerBytes) ticket)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export interface StargateAsset {
  stargateType: string;
  address: string;
  token: {
    address: string;
    decimals: number;
    symbol: string;
  };
  id: string;
  assetId: string;
  chainKey: string;
  chainName: string;
  tokenMessaging: string;
  sharedDecimals: number;
}

export interface StargateRoute {
  src: StargateAsset;
  dst: StargateAsset;
  assetId: string;
}

export class NoStargateRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoStargateRouteError";
  }
}

export function isNoStargateRouteError(error: unknown): boolean {
  return error instanceof NoStargateRouteError;
}

function addressMatches(candidate: string | undefined, address: string | undefined): boolean {
  return Boolean(
    candidate &&
    address &&
    ethers.isAddress(candidate) &&
    ethers.isAddress(address) &&
    candidate.toLowerCase() === address.toLowerCase(),
  );
}

export function findStargateRouteFromMetadata(
  assets: StargateAsset[],
  params: {
    srcChain: string;
    dstChain: string;
    tokenAddress?: string;
    dstTokenAddress?: string;
    symbol?: string;
  },
): StargateRoute {
  const src = assets.find((asset) =>
    asset.chainKey === params.srcChain &&
    (
      addressMatches(asset.token.address, params.tokenAddress) ||
      addressMatches(asset.address, params.tokenAddress) ||
      (!params.tokenAddress && params.symbol && asset.token.symbol.toUpperCase() === params.symbol.toUpperCase())
    )
  );
  if (!src) {
    throw new NoStargateRouteError(`No Stargate V2 source route for ${params.srcChain}`);
  }

  const dst = assets.find((asset) =>
    asset.chainKey === params.dstChain &&
    asset.assetId === src.assetId &&
    (
      !params.dstTokenAddress ||
      addressMatches(asset.token.address, params.dstTokenAddress) ||
      addressMatches(asset.address, params.dstTokenAddress)
    )
  );
  if (!dst) {
    throw new NoStargateRouteError(`No Stargate V2 destination route for ${params.srcChain}->${params.dstChain}`);
  }

  return { src, dst, assetId: src.assetId };
}

async function fetchStargateAssets(): Promise<StargateAsset[]> {
  const response = await fetch(STARGATE_METADATA_URL, {
    headers: { accept: "application/json" },
  });
  const bodyText = await response.text();
  const parsed = bodyText ? JSON.parse(bodyText) as unknown : null;
  if (!response.ok) {
    throw new Error(`Stargate metadata error: ${response.status} ${response.statusText}`);
  }
  const data = parsed && typeof parsed === "object" && "data" in parsed
    ? (parsed as { data?: unknown }).data
    : parsed;
  if (Array.isArray(data)) return data as StargateAsset[];
  if (data && typeof data === "object") {
    return Object.values(data).flat().filter(Boolean) as StargateAsset[];
  }
  return [];
}

async function findStargateRoute(params: {
  srcChain: string;
  dstChain: string;
  tokenAddress?: string;
  dstTokenAddress?: string;
  symbol?: string;
}): Promise<StargateRoute> {
  return findStargateRouteFromMetadata(await fetchStargateAssets(), params);
}

function buildExecutorLzReceiveOption(gasLimit = 65000n): string {
  return ethers.concat([
    "0x0003",
    "0x01",
    "0x0011",
    "0x01",
    ethers.zeroPadValue(ethers.toBeHex(gasLimit), 16),
  ]);
}

function buildSendParam(
  dstEid: number,
  recipient: string,
  amountLD: bigint,
  minAmountLD: bigint,
) {
  return {
    dstEid,
    to: ethers.zeroPadValue(recipient, 32),
    amountLD,
    minAmountLD,
    extraOptions: buildExecutorLzReceiveOption(),
    composeMsg: "0x",
    oftCmd: "0x",
  };
}

function tupleFirst(value: unknown): bigint {
  if (Array.isArray(value)) return value[0] as bigint;
  if (value && typeof value === "object" && "nativeFee" in value) {
    return (value as { nativeFee: bigint }).nativeFee;
  }
  return 0n;
}

function amountReceivedFromQuoteOft(value: unknown, fallback: bigint): bigint {
  const result = value as Array<unknown>;
  const receipt = result[2] as Array<bigint> | { amountReceivedLD?: bigint } | undefined;
  if (Array.isArray(receipt)) return receipt[1] ?? fallback;
  return receipt?.amountReceivedLD ?? fallback;
}

async function buildStargateQuoteContext(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
) {
  const wallet = resolveOnchainWallet(payload.wallet_id, session, req);
  const srcChain = getEvmChain(payload.src_chain);
  const dstChain = getEvmChain(payload.dst_chain);
  const route = await findStargateRoute({
    srcChain: payload.src_chain,
    dstChain: payload.dst_chain,
    tokenAddress: payload.token_address,
    dstTokenAddress: payload.dst_token_address,
    symbol: payload.symbol,
  });
  if (!ethers.isAddress(payload.recipient)) {
    throw new Error("recipient must be an EVM address");
  }
  const amountRaw = ethers.parseUnits(payload.amount, route.src.token.decimals);
  const slippageBps = payload.slippage_bps ?? 50;
  const minAmountRaw = amountRaw - (amountRaw * BigInt(slippageBps)) / 10000n;
  const sendParam = buildSendParam(dstChain.endpointId, payload.recipient, amountRaw, minAmountRaw);
  const signer = await getSigner(wallet, payload.src_chain);
  const provider = signer.provider;
  if (!provider) throw new Error("No provider available");
  const stargate = new ethers.Contract(route.src.address, STARGATE_ABI, signer);
  return { wallet, srcChain, dstChain, route, amountRaw, sendParam, signer, provider, stargate };
}

export async function stargateDirectQuoteForPayload(
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
  const { wallet, srcChain, dstChain, route, amountRaw, sendParam, provider, stargate } =
    await buildStargateQuoteContext(payload, session, req);
  const token = new ethers.Contract(route.src.token.address, ERC20_ABI, provider);
  const [nativeBalance, tokenBalance, allowance, quoteOftResult, msgFee] = await Promise.all([
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address) as Promise<bigint>,
    token.allowance(wallet.address, route.src.address) as Promise<bigint>,
    stargate.quoteOFT(sendParam),
    stargate.quoteSend(sendParam, false),
  ]);
  const nativeFee = tupleFirst(msgFee);
  const amountReceived = amountReceivedFromQuoteOft(quoteOftResult, amountRaw);
  const approvalRequired = allowance < amountRaw;

  return {
    quote: {
      id: `${payload.src_chain}->${payload.dst_chain}:${route.src.address}`,
      srcAmount: amountRaw.toString(),
      dstAmount: ethers.formatUnits(amountReceived, route.src.token.decimals),
      routeSteps: [
        {
          type: "STARGATE_V2",
          srcChainKey: payload.src_chain,
          dstChainKey: payload.dst_chain,
        },
      ],
      userSteps: [
        ...(approvalRequired ? [{
          type: "TRANSACTION",
          chainType: "EVM",
          chainKey: payload.src_chain,
          description: `Approve ${srcChain.label} Stargate`,
        }] : []),
        {
          type: "TRANSACTION",
          chainType: "EVM",
          chainKey: payload.src_chain,
          description: `Send Stargate V2 from ${srcChain.label} to ${dstChain.label}`,
        },
      ],
      raw: {
        protocol: "stargate-v2",
        nativeFee: nativeFee.toString(),
        approvalRequired,
        stargateAddress: route.src.address,
      },
    },
    amountRaw: amountRaw.toString(),
    walletAddress: wallet.address,
    raw: {
      protocol: "stargate-v2",
      nativeFee: nativeFee.toString(),
      nativeBalance: nativeBalance.toString(),
      tokenBalance: tokenBalance.toString(),
      allowance: allowance.toString(),
      approvalRequired,
      stargateAddress: route.src.address,
    },
  };
}

export async function stargateDirectExecuteValueTransfer(
  payload: CrosschainOftTaskPayload,
  session: SessionManager,
  req: Request,
): Promise<{ quote: { id: string }; txHashes: string[] }> {
  const { wallet, route, amountRaw, sendParam, signer, stargate } =
    await buildStargateQuoteContext(payload, session, req);
  const token = new ethers.Contract(route.src.token.address, ERC20_ABI, signer);
  const txHashes: string[] = [];
  const allowance = await token.allowance(wallet.address, route.src.address) as bigint;
  if (allowance < amountRaw) {
    const approvalTx = await token.approve(route.src.address, ethers.MaxUint256);
    const approvalReceipt = await approvalTx.wait();
    if (!approvalReceipt || approvalReceipt.status !== 1) {
      throw new Error(`Approval failed: ${approvalTx.hash}`);
    }
    txHashes.push(approvalTx.hash);
  }

  const msgFee = await stargate.quoteSend(sendParam, false);
  const nativeFee = tupleFirst(msgFee);
  const tx = await stargate.sendToken(sendParam, [nativeFee, 0n], wallet.address, { value: nativeFee });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Stargate send transaction failed: ${tx.hash}`);
  }
  txHashes.push(tx.hash);

  return {
    quote: { id: `${payload.src_chain}->${payload.dst_chain}:${route.src.address}` },
    txHashes,
  };
}
