import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { SessionManager } from "./security.js";
import { ensureConfig, loadConfig } from "./config.js";
import { requestLogger, requireSession } from "./middleware.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/accounts.js";
import { withdrawRoutes } from "./routes/withdraw.js";
import { currencyRoutes } from "./routes/currencies.js";
import { addressRoutes } from "./routes/addresses.js";
import { resolveListenHost } from "./host.js";
import { tradeRoutes } from "./routes/trade.js";
import { taskRoutes } from "./routes/tasks.js";
import { onchainRoutes } from "./routes/onchain.js";
import { crosschainRoutes } from "./routes/crosschain.js";
import { arbitrageRoutes } from "./routes/arbitrage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = ensureConfig();
const { port, session_timeout_min } = config.settings;
const host = resolveListenHost();

const session = new SessionManager(session_timeout_min);
const app = express();

app.use(express.json());
app.use(requestLogger());

// Static files
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Health check
app.get("/api/health", (req, res) => {
  const cfg = loadConfig();
  res.json({
    status: "ok",
    initialized: cfg.security !== null,
    unlocked: session.isUnlocked(req),
  });
});

// Routes
app.use("/api/auth", authRoutes(session));
app.use("/api/accounts", requireSession(session), accountRoutes(session));
app.use("/api/currencies", requireSession(session), currencyRoutes(session));
app.use("/api/addresses", requireSession(session), addressRoutes());
app.use("/api/withdraw", requireSession(session), withdrawRoutes(session));
app.use("/api/trade", requireSession(session), tradeRoutes(session));
app.use("/api/onchain", requireSession(session), onchainRoutes(session));
app.use("/api/crosschain", requireSession(session), crosschainRoutes(session));
app.use("/api/arbitrage", requireSession(session), arbitrageRoutes(session));
app.use("/api/tasks", requireSession(session), taskRoutes(session));

app.listen(port, host, () => {
  console.log(`Easy Withdraw running at http://${host}:${port}`);
});
