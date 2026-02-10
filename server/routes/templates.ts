import { Router } from "express";
import { loadConfig, saveConfig } from "../config.js";

export function templateRoutes(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const config = loadConfig();
    res.json({ ok: true, templates: config.templates });
  });

  router.post("/", (req, res) => {
    const { name, account_id, asset, network, address, amount } = req.body;
    if (!name) {
      res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "name is required",
      });
      return;
    }
    const config = loadConfig();
    const entry = { name, account_id, asset, network, address, amount };
    const idx = config.templates.findIndex((t) => t.name === name);
    if (idx >= 0) {
      config.templates[idx] = entry;
    } else {
      config.templates.push(entry);
    }
    saveConfig(config);
    res.json({ ok: true });
  });

  router.delete("/:name", (req, res) => {
    const config = loadConfig();
    const idx = config.templates.findIndex(
      (t) => t.name === req.params.name,
    );
    if (idx < 0) {
      res.status(404).json({
        ok: false,
        error: "NOT_FOUND",
        message: "Template not found",
      });
      return;
    }
    config.templates.splice(idx, 1);
    saveConfig(config);
    res.json({ ok: true });
  });

  return router;
}
