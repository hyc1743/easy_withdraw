# Easy Withdraw

本地优先的交易所提现工具。单页 HTML 前端 + Express 后端，一个进程搞定。

## 特性

- 仅监听 `127.0.0.1`，不对外网开放
- 主密码加密存储交易所密钥（Argon2id + AES-256-GCM）
- 零前端构建步骤（Tailwind CDN + vanilla JS）
- 会话空闲 15 分钟自动锁定
- 目前支持 Gate 交易所，后续可扩展

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 生产模式
npm start
```

启动后访问 `http://127.0.0.1:4217`。

## 使用流程

1. 首次访问时设置主密码
2. 输入主密码解锁会话
3. 在「账户」页添加交易所 API Key / Secret
4. 在「提现」页填写提现信息，先预校验再执行
5. 在「历史」页查看提现记录

## 安全建议

- 在交易所侧将 API Key 限制为「只允许提现到白名单地址」
- 使用强主密码
- 不要将 `~/.easy_withdraw/config.json` 上传到公开仓库

## 项目结构

```
server/
  index.ts             # Express 入口
  security.ts          # Argon2id KDF + AES-256-GCM + 会话管理
  config.ts            # JSON 配置文件读写
  middleware.ts         # 会话检查 + 请求日志
  routes/auth.ts       # 认证路由
  routes/accounts.ts   # 账户管理路由
  routes/currencies.ts # 币种/链查询路由
  routes/addresses.ts  # 地址簿路由
  routes/templates.ts  # 提现模板路由
  routes/withdraw.ts   # 提现路由
  exchange/types.ts    # 交易所统一接口
  exchange/gate.ts     # Gate 适配器
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
| GET | `/api/addresses` | 列出地址簿 |
| POST | `/api/addresses` | 新增/更新地址 |
| DELETE | `/api/addresses/:label` | 删除地址 |
| GET | `/api/templates` | 列出提现模板 |
| POST | `/api/templates` | 新增/更新模板 |
| DELETE | `/api/templates/:name` | 删除模板 |
| POST | `/api/withdraw/preview` | 预校验 |
| POST | `/api/withdraw/execute` | 执行提现 |
| GET | `/api/withdraw/history` | 提现历史 |
| GET | `/api/withdraw/:id` | 查询提现状态 |

## License

MIT
