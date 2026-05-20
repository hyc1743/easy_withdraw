import { Router } from "express";
import { ethers } from "ethers";
import { decrypt, encrypt, type SessionManager } from "../security.js";
import { loadConfig, saveConfig } from "../config.js";
import { evmChains } from "../onchain/chains.js";
import { listOkxWeb3TokenBalances } from "../onchain/okx-web3.js";

export function onchainRoutes(session: SessionManager): Router {
  const router = Router();

  router.get("/settings", (_req, res) => {
    const config = loadConfig();
    res.json({
      ok: true,
      settings: {
        has_layerzero_api_key: Boolean(config.layerzero_api_key_enc),
        has_okx_web3_key: Boolean(config.okx_web3),
        chains: Object.values(evmChains),
      },
    });
  });

  router.put("/settings", (req, res) => {
    const layerzeroApiKey = String(req.body.layerzero_api_key ?? "").trim();
    const okxWeb3ApiKey = String(req.body.okx_web3_api_key ?? "").trim();
    if (!layerzeroApiKey && !okxWeb3ApiKey) {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "layerzero_api_key or okx_web3_api_key is required",
      });
      return;
    }
    const key = session.getKey(req);
    if (!key) {
      res.status(401).json({ ok: false, error: "UNAUTHORIZED", message: "Session not unlocked" });
      return;
    }
    const config = loadConfig();
    if (layerzeroApiKey) {
      config.layerzero_api_key_enc = encrypt(layerzeroApiKey, key);
    }
    if (okxWeb3ApiKey) {
      const apiSecret = String(req.body.okx_web3_api_secret ?? "").trim();
      const passphrase = String(req.body.okx_web3_passphrase ?? "").trim();
      if (!apiSecret || !passphrase) {
        res.status(400).json({
          ok: false,
          error: "BAD_REQUEST",
          message: "okx_web3_api_secret and okx_web3_passphrase are required",
        });
        return;
      }
      config.okx_web3 = {
        api_key: okxWeb3ApiKey,
        api_secret_enc: encrypt(apiSecret, key),
        passphrase_enc: encrypt(passphrase, key),
      };
    }
    saveConfig(config);
    res.json({ ok: true });
  });

  router.get("/okx-web3/balances", async (req, res) => {
    try {
      const walletId = String(req.query.wallet_id ?? "").trim();
      const chainName = String(req.query.chain ?? "").trim();
      if (!walletId || !chainName) {
        throw new Error("wallet_id and chain are required");
      }
      const config = loadConfig();
      const wallet = config.onchain_wallets.find((item) => item.id === walletId);
      const chain = evmChains[chainName];
      if (!wallet) throw new Error("Wallet not found");
      if (!chain) throw new Error("Unsupported chain");
      const tokens = await listOkxWeb3TokenBalances({
        address: wallet.address,
        chainId: chain.chainId,
        session,
        req,
      });
      res.json({ ok: true, tokens });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.get("/wallets", (_req, res) => {
    const config = loadConfig();
    res.json({
      ok: true,
      wallets: config.onchain_wallets.map((wallet) => ({
        id: wallet.id,
        address: wallet.address,
        has_private_key: Boolean(wallet.private_key_enc),
      })),
    });
  });

  router.post("/wallets", (req, res) => {
    const id = String(req.body.id ?? "").trim();
    const privateKey = String(req.body.private_key ?? "").trim();
    if (!id || !privateKey) {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "id and private_key are required",
      });
      return;
    }
    const key = session.getKey(req);
    if (!key) {
      res.status(401).json({ ok: false, error: "UNAUTHORIZED", message: "Session not unlocked" });
      return;
    }

    try {
      const wallet = new ethers.Wallet(privateKey);
      const config = loadConfig();
      const entry = {
        id,
        address: wallet.address,
        private_key_enc: encrypt(privateKey, key),
      };
      const idx = config.onchain_wallets.findIndex((item) => item.id === id);
      if (idx >= 0) {
        config.onchain_wallets[idx] = entry;
      } else {
        config.onchain_wallets.push(entry);
      }
      saveConfig(config);
      res.json({ ok: true, wallet: { id, address: wallet.address } });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.put("/wallets/:id", (req, res) => {
    const key = session.getKey(req);
    if (!key) {
      res.status(401).json({ ok: false, error: "UNAUTHORIZED", message: "Session not unlocked" });
      return;
    }
    const config = loadConfig();
    const idx = config.onchain_wallets.findIndex((wallet) => wallet.id === req.params.id);
    if (idx < 0) {
      res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Wallet not found" });
      return;
    }

    const current = config.onchain_wallets[idx];
    const nextId = String(req.body.id ?? current.id).trim();
    const privateKey = String(req.body.private_key ?? "").trim();
    if (nextId !== current.id && config.onchain_wallets.some((wallet) => wallet.id === nextId)) {
      res.status(409).json({ ok: false, error: "CONFLICT", message: "Wallet id already exists" });
      return;
    }

    try {
      if (privateKey) {
        const wallet = new ethers.Wallet(privateKey);
        config.onchain_wallets[idx] = {
          id: nextId,
          address: wallet.address,
          private_key_enc: encrypt(privateKey, key),
        };
      } else {
        const decrypted = decrypt(current.private_key_enc, key);
        const wallet = new ethers.Wallet(decrypted);
        config.onchain_wallets[idx] = {
          ...current,
          id: nextId,
          address: wallet.address,
        };
      }
      saveConfig(config);
      res.json({
        ok: true,
        wallet: {
          id: config.onchain_wallets[idx].id,
          address: config.onchain_wallets[idx].address,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message });
    }
  });

  router.delete("/wallets/:id", (req, res) => {
    const config = loadConfig();
    const idx = config.onchain_wallets.findIndex((wallet) => wallet.id === req.params.id);
    if (idx < 0) {
      res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Wallet not found" });
      return;
    }
    config.onchain_wallets.splice(idx, 1);
    saveConfig(config);
    res.json({ ok: true });
  });

  return router;
}
