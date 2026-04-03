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
  step_size: string;
  min_quote_amount?: string;
  last_price?: string;
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
  placeMarketSellOrder?(
    symbol: string,
    quantity: string,
    creds: DecryptedCreds,
  ): Promise<MarketSellOrderResult>;
}
