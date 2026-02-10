# Easy Withdraw - 架构说明 (v1 轻量版)

## 1. 目标

构建一个 **本地优先（local-first）** 的开源提现工具：
- 单页 HTML 前端 + Express 后端，一个进程搞定
- 不依赖云端后台，无默认遥测
- 零前端构建步骤（无 React / Vite / Webpack）
- 从 **Gate 交易所提现** 起步，后续扩展到其他交易所

---

## 2. 整体架构

- **UI**：单个 HTML 文件（Tailwind CDN + vanilla JS），由 Express 静态托管
- **后端**：Express REST API，仅监听 `127.0.0.1`
- **存储**：本地 JSON 配置文件
- **敏感信息**：主密码加密存储（Argon2id + AES-256-GCM）

数据流（典型提现流程）：

1. 用户访问 `http://127.0.0.1:4217`，加载单页 HTML
2. 页面内 JS 调用后端 REST API
3. 后端通过主密码在内存中解密交易所密钥
4. 后端使用解密后的密钥与交易所 API 通信，发起提现
5. 后端将标准化结果返回给页面展示

---

## 3. 本地安全模型（v1）

- 后端仅绑定 `127.0.0.1`，不对外网开放
- 需要通过「主密码」解锁会话后才能使用敏感功能
- `api_secret` / `passphrase` 等敏感字段加密后写入配置文件
- `api_key` 明文存储（仅用于账户识别/展示，单独无法执行操作）
- 后端永远不向前端返回明文 secrets
- 签名完成后清理内存中的敏感数据缓冲区
- 会话空闲 15 分钟自动锁定，支持手动锁定
- 配置文件中存储 `verify_tag`（用派生密钥加密的已知明文），用于快速验证主密码正确性
- 建议在交易所侧将 API Key 限制为「只允许提现到白名单地址」

---

## 4. 项目目录结构

```txt
easy_withdraw/
  ARCHITECTURE.md        # 本文件
  task.md                # 任务拆分/进度
  README.md              # 项目说明
  package.json           # 项目依赖

  server/                # Node.js 后端（Express）
    index.ts             # 入口：创建 Express 应用 + 路由注册 + 静态托管
    security.ts          # Argon2id KDF + AES-256-GCM 加解密 + 会话管理
    config.ts            # JSON 配置文件读写 + 路径管理
    routes/              # 路由层（扁平化，不再拆 domain/services）
      auth.ts            # /api/auth/* 路由
      accounts.ts        # /api/accounts/* 路由
      withdraw.ts        # /api/withdraw/* 路由
    exchange/            # 交易所适配
      types.ts           # 统一接口定义
      gate.ts            # Gate 交易所实现
    middleware.ts        # 会话检查 + 请求日志

  public/                # 静态前端
    index.html           # 单页面 UI（Tailwind CDN + vanilla JS）
```

> 相比原架构：去掉了 `web/` 独立前端项目、`domain/`、`services/` 层，
> 路由文件直接包含业务逻辑，大幅减少文件数量和层级。

---

## 5. 配置文件（JSON）

配置文件路径：

- macOS/Linux: `~/.easy_withdraw/config.json`
- Windows: `%USERPROFILE%/.easy_withdraw/config.json`

示例：

```json
{
  "version": 1,
  "security": {
    "kdf": "argon2id",
    "salt_b64": "BASE64_SALT",
    "verify_tag": "BASE64_ENCRYPTED_KNOWN_PLAINTEXT",
    "kdf_params": { "m_cost": 47104, "t_cost": 2, "p": 1 }
  },
  "accounts": [
    {
      "id": "gate_main",
      "exchange": "gate",
      "api_key": "GATE_API_KEY",
      "api_secret_enc": "BASE64_NONCE_CIPHERTEXT",
      "passphrase_enc": null
    }
  ],
  "settings": {
    "host": "127.0.0.1",
    "port": 4217,
    "session_timeout_min": 15
  }
}
```

说明：
- `security.verify_tag`：用于验证主密码正确性，无需等到解密 secret 时才发现错误
- `security.kdf_params.m_cost`：47104（约 46MB），符合 OWASP 推荐
- `accounts` 中只有 `api_key` 明文，secret 类字段均为加密后的字符串
- `settings.session_timeout_min`：会话空闲超时时间（分钟）

---

## 6. 后端 API 设计（MVP）

所有 API 为 JSON REST 风格，前缀 `/api`。

### 统一错误响应格式

```json
{
  "ok": false,
  "error": "UNAUTHORIZED",
  "message": "Session not unlocked"
}
```

常见错误码：`NOT_INITIALIZED`、`ALREADY_INITIALIZED`、`UNAUTHORIZED`、`BAD_REQUEST`、`EXCHANGE_ERROR`

### 中间件

- **会话检查**：`/api/accounts/*` 和 `/api/withdraw/*` 需要已解锁会话
- **请求日志**：记录请求方法、路径、耗时（不记录请求体中的敏感字段）

---

### 6.1 认证相关

#### `POST /api/auth/init`

首次运行时初始化主密码：
- 请求体：`{ "masterPassword": "string" }`
- 行为：
  - 若未初始化：生成盐 → Argon2id 派生密钥 → 生成 verify_tag → 写入配置
  - 若已初始化：返回 `ALREADY_INITIALIZED` 错误

#### `POST /api/auth/unlock`

解锁当前运行时会话：
- 请求体：`{ "masterPassword": "string" }`
- 行为：
  - 派生密钥 → 用 verify_tag 验证密码正确性
  - 正确则缓存密钥到内存，设置会话为已解锁
  - 启动/重置空闲超时计时器
- 响应：`{ "ok": true }`

#### `POST /api/auth/lock`

手动锁定会话：
- 行为：清除内存中的派生密钥，设置会话为已锁定
- 响应：`{ "ok": true }`

#### `GET /api/auth/status`

查询当前会话状态：
- 响应：`{ "initialized": true, "unlocked": false }`

---

### 6.2 账户管理

#### `POST /api/accounts`（Upsert 语义）

新增或更新交易所账户：
- 请求体：

```json
{
  "id": "gate_main",
  "exchange": "gate",
  "api_key": "xxxx",
  "api_secret": "yyyy"
}
```

- 行为：若 `id` 已存在则更新，否则新增。加密 `api_secret` 后写入配置。

#### `GET /api/accounts`

列出账户（仅返回脱敏数据）：

```json
{
  "accounts": [
    { "id": "gate_main", "exchange": "gate", "has_secret": true }
  ]
}
```

#### `DELETE /api/accounts/:id`

删除指定账户：
- 行为：从配置中移除该账户，写回配置文件
- 响应：`{ "ok": true }`

---

### 6.3 提现相关

统一提现请求结构：

```json
{
  "account_id": "gate_main",
  "asset": "USDT",
  "network": "ETH",
  "address": "0x...",
  "address_tag": null,
  "amount": "100.0",
  "client_withdraw_id": "optional-idempotency-key"
}
```

> 注：`exchange` 字段由后端根据 `account_id` 自动查找，无需前端传递。

统一提现响应结构：

```json
{
  "ok": true,
  "withdraw_id": "gate-xxx",
  "status": "pending",
  "message": "created",
  "raw": {}
}
```

#### `POST /api/withdraw/preview`

预校验提现请求（不真正发起）：
- 检查必填字段、金额格式
- 校验资产/网络是否在支持列表

#### `POST /api/withdraw/execute`

执行提现：
1. 检查会话是否解锁
2. 根据 `account_id` 读取账户配置
3. 解密 `api_secret_enc`
4. 通过交易所适配器调用提现接口
5. 写入本地历史日志（`~/.easy_withdraw/history.json`）

#### `GET /api/withdraw/:id`

查询提现状态（由交易所适配器实现）。

#### `GET /api/withdraw/history`

查询本地提现历史记录：
- 支持分页参数：`?limit=20&offset=0`
- 响应：`{ "records": [...], "total": 42 }`

---

### 6.4 健康检查

#### `GET /api/health`

```json
{
  "status": "ok",
  "initialized": true,
  "unlocked": false
}
```

---

## 7. 交易所适配器

统一接口定义（TypeScript）：

```ts
interface ExchangeAdapter {
  validateRequest(req: WithdrawRequest): Promise<void>;
  withdraw(req: WithdrawRequest, creds: DecryptedCreds): Promise<WithdrawResponse>;
  queryStatus(id: string, creds: DecryptedCreds): Promise<WithdrawResponse>;
}
```

- `DecryptedCreds`：解密后的凭证，仅存在于后端内存
- v1 只实现 `GateAdapter`
- v2+ 扩展到 Binance / OKX / Bitget 等

---

## 8. 前端 UI（单页 HTML）

单个 `public/index.html` 文件，使用 Tailwind CDN 样式 + vanilla JS，通过 `fetch()` 调用后端 API。

页面内通过 JS 控制视图切换（无需前端路由库）：

1. **Unlock 视图** — 初始化/解锁主密码
2. **Accounts 视图** — 管理交易所账户（增/删/改）
3. **Withdraw 视图** — 填写提现表单 → preview → execute
4. **History 视图** — 查看本地提现记录

> 后续如需升级为 React/Vue，API 层无需改动。

---

## 9. v1 非目标

以下内容不在 v1 范围内：

- 多用户登录/权限系统
- 云端同步
- 自动更新机制
- 复杂任务队列与重试策略
- 插件市场或脚本扩展系统
- 移动端 App
- 前端构建工具链（React / Vite / Webpack）

v1 的核心原则：**简单、可审计、可用**。以最小可行集合打通本地提现闭环，再逐步演进。
