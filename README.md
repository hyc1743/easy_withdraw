# Easy Withdraw

本地优先的交易所提现和自动卖出工具。单页 HTML 前端 + Express 后端，一个进程搞定。

## 特性

- 默认监听 `127.0.0.1`（localhost）
- 主密码加密存储交易所密钥（Argon2id + AES-256-GCM）
- 基于 SQLite 持久化配置、提现历史、定时任务与日志
- 支持 Binance / OKX / Bybit / Gate / Bitget / MEXC 现货按秒间隔自动市价卖出，直到余额卖完
- 任务完成后，重新进入对应页面仍可查看最近一次任务和执行日志
- 零前端构建步骤（Tailwind CDN + vanilla JS）
- 会话空闲 15 分钟自动锁定
- 目前支持 Gate / Binance / OKX / Bybit / Bitget / MEXC

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 启动（交互选择监听方式：localhost / tailscale ip）
npm start
```

启动后访问 `http://127.0.0.1:4217`。

- `npm start` 会提示选择监听方式：
  - `1` localhost（`127.0.0.1`）
  - `2` tailscale ip（自动检测本机 Tailscale IPv4）
- 也可通过 `EW_HOST` 直接指定监听地址（会跳过交互）

### Tailscale 直连（不使用 serve）

如果你通过 Tailscale 访问并希望使用 `IP:端口` 方式（不做 `tailscale serve` 端口转发）：

1. 关闭 serve（如已开启）：

```bash
tailscale serve --https=443 off
```

2. 启动服务并在交互菜单选择 `2`（tailscale ip）：

```bash
npm start
```

3. 查询本机 Tailscale IP（用于确认访问地址）：

```bash
tailscale ip -4
```

4. 在 tailnet 设备访问（将 `<TAILSCALE_IP>` 替换为上一步结果）：

```text
http://<TAILSCALE_IP>:4217
```

## 使用流程

1. 首次访问时设置主密码
2. 输入主密码解锁会话
3. 在「账户」页添加交易所 API Key / Secret（OKX、Bitget 还需 Passphrase）
4. 在「提现」页填写提现信息，先预校验再执行，或启动定时提现
5. 在「卖出」页选择支持现货卖出的账户和交易对，预校验后启动自动卖出
6. 任务运行期间可关闭前端页面；重新进入后会自动回显当前任务或最近一次同类型任务日志
6. 在「历史」页查看提现记录

## 定时任务行为

- 定时提现和自动卖出任务都由后端执行，关闭浏览器不影响执行。
- 会话锁定后，已启动任务会继续执行（直到完成或手动停止）。
- 任务状态持久化到 SQLite；服务重启后，重新解锁会话后会自动恢复运行中的任务。
- 任务执行日志持久化到 SQLite；任务已完成后，重新进入「提现」或「卖出」页仍可查看最近一次任务日志。

## 自动卖出说明

- 当前支持 Binance / OKX / Bybit / Gate / Bitget / MEXC 现货 `MARKET SELL`
- 输入交易对后，系统会自动识别卖出币种和目标币种，无需单独填写
- “预校验”会检查交易对是否存在、当前余额、最小下单量、步进以及本轮可执行数量
- 若剩余余额小于单次数量，最后一轮会按剩余余额卖出
- 任一执行错误会立即停止任务

## 安全建议

- 在交易所侧将 API Key 限制为「只允许提现到白名单地址」
- 自动卖出需要 API Key 具备现货交易权限
- 使用强主密码
- 不要将 `~/.easy_withdraw/` 下的数据库与配置文件上传到公开仓库

## 项目结构

```
server/
  start.ts             # 启动入口（交互选择监听地址）
  index.ts             # Express 入口
  security.ts          # Argon2id KDF + AES-256-GCM + 会话管理
  config.ts            # 应用配置读写（SQLite）
  db.ts                # SQLite 初始化与旧数据迁移
  middleware.ts         # 会话检查 + 请求日志
  routes/auth.ts       # 认证路由
  routes/accounts.ts   # 账户管理路由
  routes/currencies.ts # 币种/链查询路由
  routes/addresses.ts  # 地址簿路由
  routes/templates.ts  # 提现模板路由
  routes/tasks.ts      # 通用任务路由
  routes/trade.ts      # 现货自动卖出路由
  routes/withdraw.ts   # 提现路由
  exchange/types.ts    # 交易所统一接口
  exchange/gate.ts     # Gate 适配器
  exchange/binance.ts  # Binance 适配器
  exchange/okx.ts      # OKX 适配器
  exchange/bybit.ts    # Bybit 适配器
  exchange/bitget.ts   # Bitget 适配器
  exchange/mexc.ts     # MEXC 适配器
  exchange/adapters.ts # 交易所适配器注册表
public/
  index.html           # 单页 UI
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/auth/init` | 初始化主密码 |
| POST | `/api/auth/unlock` | 解锁会话 |
| POST | `/api/auth/lock` | 锁定会话 |
| GET | `/api/auth/status` | 查询状态 |
| POST | `/api/accounts` | 新增/更新账户 |
| GET | `/api/accounts` | 列出账户 |
| DELETE | `/api/accounts/:id` | 删除账户 |
| GET | `/api/currencies` | 列出币种 |
| GET | `/api/currencies/:currency/chains` | 查询链列表 |
| GET | `/api/currencies/:currency/balance` | 查询币种余额 |
| GET | `/api/addresses` | 列出地址簿 |
| POST | `/api/addresses` | 新增/更新地址 |
| DELETE | `/api/addresses/:label` | 删除地址 |
| GET | `/api/templates` | 列出提现模板 |
| POST | `/api/templates` | 新增/更新模板 |
| DELETE | `/api/templates/:name` | 删除模板 |
| POST | `/api/withdraw/preview` | 预校验 |
| POST | `/api/withdraw/execute` | 执行提现 |
| POST | `/api/withdraw/schedule/start` | 启动后端定时提现 |
| POST | `/api/withdraw/schedule/:id/stop` | 停止定时提现 |
| GET | `/api/withdraw/schedule/active` | 获取当前运行任务 |
| GET | `/api/withdraw/schedule/:id` | 查询指定定时任务 |
| GET | `/api/withdraw/history` | 提现历史 |
| GET | `/api/withdraw/:id` | 查询提现状态 |
| GET | `/api/trade/binance/symbols` | 列出现货交易对（兼容旧 Binance 路径） |
| GET | `/api/trade/binance/symbol/:symbol` | 查询单个现货交易对规则（兼容旧 Binance 路径） |
| GET | `/api/trade/binance/balance` | 查询卖出币种余额（兼容旧 Binance 路径） |
| POST | `/api/trade/sell/preview` | 自动卖出预校验 |
| POST | `/api/trade/sell/schedule/start` | 启动自动卖出 |
| GET | `/api/tasks/active` | 获取当前运行任务 |
| GET | `/api/tasks/latest` | 获取最近一条任务，可按类型过滤 |
| GET | `/api/tasks/:id` | 查询指定任务 |
| POST | `/api/tasks/:id/stop` | 停止任务 |
| POST | `/api/tasks/:id/resume` | 继续已停止任务 |

## License

MIT
