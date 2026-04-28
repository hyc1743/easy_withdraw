import { BinanceAdapter } from "./binance.js";
import { BitgetAdapter } from "./bitget.js";
import { BybitAdapter } from "./bybit.js";
import { GateAdapter } from "./gate.js";
import { MexcAdapter } from "./mexc.js";
import { OkxAdapter } from "./okx.js";
import type { ExchangeAdapter } from "./types.js";

export const adapters: Record<string, ExchangeAdapter> = {
  gate: new GateAdapter(),
  binance: new BinanceAdapter(),
  okx: new OkxAdapter(),
  bybit: new BybitAdapter(),
  bitget: new BitgetAdapter(),
  mexc: new MexcAdapter(),
};

export const supportedExchanges = Object.keys(adapters);
