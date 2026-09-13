export interface WithdrawRequest {
  account_id: string;
  asset: string;
  network: string;
  address: string;
  address_tag?: string | null;
  amount: string;
  client_withdraw_id?: string;
}

export interface WithdrawResponse {
  ok: boolean;
  withdraw_id: string;
  status: string;
  message: string;
  raw: unknown;
}

export interface DecryptedCreds {
  api_key: string;
  api_secret: string;
  passphrase?: string;
}

export interface CurrencyInfo {
  currency: string;
  name_en: string;
  withdraw_disabled: boolean;
}

export interface ChainInfo {
  chain: string;
  name_en: string;
  is_withdraw_disabled: boolean;
  is_deposit_disabled: boolean;
  withdraw_fix: string;
  withdraw_percent: string;
  withdraw_amount_mini: string;
  withdraw_eachtime_limit: string;
  withdraw_day_limit: string;
  decimal: number;
}

export interface AssetBalance {
  currency: string;
  available: string;
  locked: string;
  total: string;
}

export interface SpotSymbolInfo {
  symbol: string;
  status: string;
  base_asset: string;
  quote_asset: string;
  min_qty: string;
  max_qty?: string;
  step_size: string;
  min_quote_amount?: string;
  last_price?: string;
  quote_order_qty_market_allowed?: boolean;
  market_avg_price_mins?: number;
  market_reference_price?: string;
  market_reference_price_source?: "reference_price" | "average_price" | "last_price";
}

export interface MarketSellOrderResult {
  order_id: string;
  symbol: string;
  status: string;
  executed_qty: string;
  quote_qty: string;
  avg_price: string;
  raw: unknown;
}

export interface SpotTrade {
  symbol: string;
  trade_id: string;
  order_id: string;
  price: string;
  quantity: string;
  quote_quantity: string;
  commission: string;
  commission_asset: string;
  commissions?: Array<{ asset: string; amount: string }>;
  time: number;
  is_buyer: boolean;
  is_maker: boolean;
}

export interface ExchangeAdapter {
  validateRequest(req: WithdrawRequest): Promise<void>;
  withdraw(
    req: WithdrawRequest,
    creds: DecryptedCreds,
  ): Promise<WithdrawResponse>;
  queryStatus(
    id: string,
    creds: DecryptedCreds,
  ): Promise<WithdrawResponse>;
  listCurrencies(creds: DecryptedCreds): Promise<CurrencyInfo[]>;
  listChains(currency: string, creds: DecryptedCreds): Promise<ChainInfo[]>;
  getBalance(currency: string, creds: DecryptedCreds): Promise<AssetBalance>;
  listSpotSymbols?(creds: DecryptedCreds): Promise<SpotSymbolInfo[]>;
  getSpotSymbol?(
    symbol: string,
    creds: DecryptedCreds,
  ): Promise<SpotSymbolInfo | null>;
  getSpotBalance?(
    currency: string,
    creds: DecryptedCreds,
  ): Promise<AssetBalance>;
  placeMarketSellOrder?(
    symbol: string,
    quantity: string,
    creds: DecryptedCreds,
  ): Promise<MarketSellOrderResult>;
  placeMarketSellOrderByQuoteAmount?(
    symbol: string,
    quoteAmount: string,
    creds: DecryptedCreds,
  ): Promise<MarketSellOrderResult>;
  getSpotTrades?(
    symbol: string,
    startTime: number,
    endTime: number,
    creds: DecryptedCreds,
  ): Promise<SpotTrade[]>;
}
