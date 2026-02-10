import { Router } from "express";
import { loadConfig, saveConfig } from "../config.js";

export function addressRoutes(): Router {
  const router = Router();

  // GET /api/addresses
  router.get("/", (_req, res) => {
    const config = loadConfig();
    res.json({ ok: true, addresses: config.address_book });
  });

  // POST /api/addresses — upsert by label
  router.post("/", (req, res) => {
    const { label, address } = req.body;
    if (!label || !address) {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "label, address are required",
      });
      return;
    }
    const config = loadConfig();
    const entry = { label, address };
    const idx = config.address_book.findIndex((a) => a.label === label);
    if (idx >= 0) {
      config.address_book[idx] = entry;
    } else {
      config.address_book.push(entry);
    }
    saveConfig(config);
    res.json({ ok: true });
  });

  // DELETE /api/addresses/:label
  router.delete("/:label", (req, res) => {
    const config = loadConfig();
    const idx = config.address_book.findIndex((a) => a.label === req.params.label);
    if (idx < 0) {
      res.status(404).json({
        ok: false,
        error: "NOT_FOUND",
        message: "Address not found",
      });
      return;
    }
    config.address_book.splice(idx, 1);
    saveConfig(config);
    res.json({ ok: true });
  });

  return router;
}
