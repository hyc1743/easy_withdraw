# Easy Withdraw - 任务拆分与进度

## Phase 1: 项目初始化

- [x] 初始化 `package.json`，配置 TypeScript + 依赖
- [x] 配置 `tsconfig.json`
- [x] 添加 `.gitignore`

## Phase 2: 核心安全模块 (`server/security.ts`)

- [x] Argon2id 密钥派生（KDF）
- [x] AES-256-GCM 加密/解密
- [x] verify_tag 生成与校验
- [x] 会话管理（解锁/锁定/空闲超时）

## Phase 3: 配置管理 (`server/config.ts`)

- [x] 配置文件路径解析（跨平台）
- [x] JSON 配置文件读写
- [x] 首次运行自动创建默认配置

## Phase 4: 中间件 (`server/middleware.ts`)

- [x] 会话检查中间件（保护需认证的路由）
- [x] 请求日志中间件（脱敏记录）

## Phase 5: 认证路由 (`server/routes/auth.ts`)

- [x] `POST /api/auth/init` — 初始化主密码
- [x] `POST /api/auth/unlock` — 解锁会话
- [x] `POST /api/auth/lock` — 锁定会话
- [x] `GET /api/auth/status` — 查询状态

## Phase 6: 账户管理路由 (`server/routes/accounts.ts`)

- [x] `POST /api/accounts` — 新增/更新账户（Upsert）
- [x] `GET /api/accounts` — 列出账户（脱敏）
- [x] `DELETE /api/accounts/:id` — 删除账户

## Phase 7: 交易所适配器 (`server/exchange/`)

- [x] 定义统一接口 `types.ts`
- [x] 实现 Gate 适配器 `gate.ts`（签名 + 提现 + 查询）

## Phase 8: 提现路由 (`server/routes/withdraw.ts`)

- [x] `POST /api/withdraw/preview` — 预校验
- [x] `POST /api/withdraw/execute` — 执行提现
- [x] `GET /api/withdraw/:id` — 查询提现状态
- [x] `GET /api/withdraw/history` — 本地历史记录

## Phase 9: 服务入口 (`server/index.ts`)

- [x] Express 应用创建 + 路由注册
- [x] 静态文件托管 `public/`
- [x] 仅绑定 `127.0.0.1` + 健康检查 `/api/health`

## Phase 10: 前端 UI (`public/index.html`)

- [x] Unlock 视图 — 初始化/解锁主密码
- [x] Accounts 视图 — 管理交易所账户
- [x] Withdraw 视图 — 提现表单 + preview + execute
- [x] History 视图 — 查看提现记录

## Phase 11: 收尾

- [x] 编写 `README.md`
- [x] 端到端手动测试
- [x] 代码审查与安全检查
