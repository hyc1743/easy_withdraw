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
}
