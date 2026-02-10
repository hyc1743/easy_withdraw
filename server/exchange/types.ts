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
}
