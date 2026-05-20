import { ethers } from "ethers";
import type { Request } from "express";
import type { SessionManager } from "../security.js";
import { getTokenDecimals } from "./value-transfer.js";
import { getSigner, resolveOnchainWallet } from "./wallets.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const NATIVE_TOKEN_ADDRESSES = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

export interface TransferAssetBalance {
  raw: bigint;
  formatted: string;
  decimals: number;
}

export interface DepositTransferResult {
  tx_hash: string;
  amount: string;
  amount_raw: string;
  status: string;
}

export function isNativeTransferToken(tokenAddress: string): boolean {
  return NATIVE_TOKEN_ADDRESSES.has(tokenAddress.toLowerCase());
}

export function calculateDepositTransferAmount(params: {
  beforeRaw: bigint;
  currentRaw: bigint;
  decimals: number;
}): TransferAssetBalance {
  const raw = params.currentRaw > params.beforeRaw
    ? params.currentRaw - params.beforeRaw
    : 0n;
  return {
    raw,
    formatted: ethers.formatUnits(raw, params.decimals),
    decimals: params.decimals,
  };
}

export async function getTransferAssetBalance(
  walletId: string,
  chainName: string,
  tokenAddress: string,
  session: SessionManager,
  req: Request,
): Promise<TransferAssetBalance> {
  const wallet = resolveOnchainWallet(walletId, session, req);
  const signer = await getSigner(wallet, chainName);
  const provider = signer.provider;
  if (!provider) throw new Error("No provider available");

  if (isNativeTransferToken(tokenAddress)) {
    const raw = await provider.getBalance(wallet.address);
    return { raw, formatted: ethers.formatEther(raw), decimals: 18 };
  }

  const decimals = await getTokenDecimals(chainName, tokenAddress);
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const raw = await tokenContract.balanceOf(wallet.address) as bigint;
  return { raw, formatted: ethers.formatUnits(raw, decimals), decimals };
}

export async function sendDepositTransfer(params: {
  walletId: string;
  chainName: string;
  tokenAddress: string;
  depositAddress: string;
  amountRaw: bigint;
  decimals: number;
  session: SessionManager;
  req: Request;
}): Promise<DepositTransferResult> {
  if (!ethers.isAddress(params.depositAddress)) {
    throw new Error("deposit_address must be a valid EVM address");
  }
  if (params.amountRaw <= 0n) {
    throw new Error("deposit transfer amount must be greater than 0");
  }

  const wallet = resolveOnchainWallet(params.walletId, params.session, params.req);
  const signer = await getSigner(wallet, params.chainName);
  const amount = ethers.formatUnits(params.amountRaw, params.decimals);

  if (isNativeTransferToken(params.tokenAddress)) {
    const tx = await signer.sendTransaction({
      to: params.depositAddress,
      value: params.amountRaw,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Deposit transfer failed: ${tx.hash}`);
    }
    return {
      tx_hash: tx.hash,
      amount,
      amount_raw: params.amountRaw.toString(),
      status: "confirmed",
    };
  }

  const token = new ethers.Contract(params.tokenAddress, ERC20_ABI, signer);
  const tx = await token.transfer(params.depositAddress, params.amountRaw);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Deposit transfer failed: ${tx.hash}`);
  }
  return {
    tx_hash: tx.hash,
    amount,
    amount_raw: params.amountRaw.toString(),
    status: "confirmed",
  };
}
