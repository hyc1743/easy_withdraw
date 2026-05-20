import { ethers } from "ethers";
import { loadConfig } from "../config.js";
import { decrypt, type SessionManager } from "../security.js";
import { getEvmChain } from "./chains.js";

export interface ResolvedOnchainWallet {
  id: string;
  address: string;
  privateKey: string;
}

export function resolveOnchainWallet(
  walletId: string,
  session: SessionManager,
  req: Parameters<SessionManager["getKey"]>[0],
): ResolvedOnchainWallet {
  const key = session.getKey(req);
  if (!key) throw new Error("Session not unlocked");

  const config = loadConfig();
  const wallet = config.onchain_wallets.find((item) => item.id === walletId);
  if (!wallet) throw new Error("On-chain wallet not found");

  return {
    id: wallet.id,
    address: wallet.address,
    privateKey: decrypt(wallet.private_key_enc, key),
  };
}

export async function getSigner(
  wallet: ResolvedOnchainWallet,
  chainName: string,
): Promise<ethers.Wallet> {
  const chain = getEvmChain(chainName);
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chain.chainId) {
    throw new Error(`RPC chain id mismatch for ${chainName}`);
  }
  return new ethers.Wallet(wallet.privateKey, provider);
}
