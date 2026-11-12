# qoder-bridge — Qoder 直连网关（OpenAI 兼容 API）

[![License](https://img.shields.io/github/license/haogegeya/qoder-bridge)](LICENSE)
[![CI](https://github.com/haogegeya/qoder-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/haogegeya/qoder-bridge/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

把 Qoder（国内版 / 国际版）账号变成**本机 OpenAI 兼容 API** 的自托管网关。

逆向官方 CLI 得到的直连方案：不需要启动任何 CLI 进程，直接调用其内嵌签名 WASM
构造加密请求，直连 Qoder 网关，对外暴露标准 OpenAI 兼容 API（`127.0.0.1:8100/v1`）。

> ⚠️ **仅供自用学习。** 多账号薅免费额度、伪造设备身份等行为违反 Qoder 服务条款，
> 有封号风险，请自行评估后使用。

## 原理

```
OpenAI 请求 → qoder_bridge.mjs (Node 常驻)
  → 调用 qoder_auth.wasm 的 prepareInferRequest() 生成签名加密请求（毫秒级）
  → 直发 Qoder 网关 SSE
  → 解析双层 JSON SSE → 转成标准 OpenAI 格式返回
```

三层核心：

1. **签名层** `qoder_auth.wasm`（从官方 CLI 提取，含所有 `Cosy-*` 认证头、加密 body、`Cosy-Key` 签名生成）
2. **凭证层（PAT 账号池，不依赖 CLI 登录态）**
   ```
   PAT(pt-…) → jobToken/exchange → jt-…(24h) → 组装最小 creds → glue.generate_runtime_auth_fields
   ```
   账号存于 `accounts.json`（权限 0600，仅本机），每个账号独立缓存 jobToken，
   到期前 5min 自动用 PAT 续期，**无需 CLI 进程或登录态**。
3. **调用 ABI** `qoder_glue.mjs`（wasm-bindgen 胶水）

## 快速开始

### 1. 获取运行时文件

先按 [EXTRACT.md](EXTRACT.md) 从官方 CLI 提取 `qoder_auth.wasm` 与 `qoder_glue.mjs`，放到本目录。

### 2. 准备账号

复制 `accounts.example.json` 为 `accounts.json`，填入 PAT（`pt-…`，Qoder 网页控制台签发）：

```bash
cp accounts.example.json accounts.json
chmod 600 accounts.json   # 重要：PAT 明文，务必 0600
```

### 3. 启动

```bash
node qoder_bridge.mjs
```

浏览器打开 `http://127.0.0.1:8100/` 进入管理面板（账号录入/切换、额度、签到、模型、用量）。

后台常驻（Linux，systemd user service）：参考 [`qoder-bridge.service.example`](qoder-bridge.service.example)，
改成本机路径后：

```bash
systemctl --user enable --now qoder-bridge
systemctl --user status qoder-bridge
journalctl --user -u qoder-bridge -f
```

### 4. 调用

```bash
curl http://127.0.0.1:8100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qoder-model","messages":[{"role":"user","content":"hi"}]}'
```

对外只暴露单一模型名 `qoder-model`，实际路由到当前账号选中的模型。

## 特性

- **零冷启动**：签名即时生成（旧方案每次 3-6s、819MB → 现在 ~70MB）
- **模型目录网络直拉**：wasm 签名拉取官方模型列表，cn/global 均实测 200
- **排队自动重试**：免费模型高峰 `isQueued` 自动等待重试，最长 10min 可调
- **PAT 账号池**：多账号录入/切换，每账号独立 jobToken 缓存；支持 cn/global 两版本
- **自动签到**：双数据源直连，启动/切换/每 15min 遍历账号池检查并领取可领活动
  - growth campaign（每日 100 Credits）：`/sash/api/v1/me/campaigns`，需 `client_type=10`
  - 活动列表（wasm COSY 签名）：`/algo/api/v2/activity` + 领取资格合并
  - **国际版每日 100 需真实设备身份**（`Cosy-MachineToken/Code/Type`，由 runtime-info 生成），
    伪 client_type 无效；设备身份由本机种子文件决定，可重置
- **签名失效自愈**：`Signature invalid` 时自动用 PAT 重新 exchange 重建 context 重试

## 账号池 API

```
GET    /ui/accounts            # 列表（不含 PAT）
POST   /ui/accounts            # {alias, pat, edition, note} 添加并校验
PUT    /ui/accounts/:id        # {alias?, note?} 编辑
DELETE /ui/accounts/:id        # 删除
POST   /ui/account             # {id} 切换当前账号
POST   /ui/active-model        # {key} 切换当前账号的路由模型
```

环境变量：`QODER_ACCOUNTS_FILE` / `QODER_BRIDGE_STATE` / `QODER_BRIDGE_PORT` / `QODER_QUEUE_MAX_WAIT_MS`

## 上游变更应对

官方 CLI 升级导致签名被拒时：

```bash
python3 tools/decode_b64_wasm.py   # 重新提取 wasm
python3 tools/extract_glue.py      # 重新定位 glue chunk
# 替换 qoder_auth.wasm / qoder_glue.mjs 后重启
```

## 已知边界

- gRPC 传输通道被 WAF 拦，只能走 SSE
- 明文 JSON 直连会 `Signature invalid`（code 101），body 加密是强制的
- 免费模型高峰期排队 30s~几分钟属正常
- `accounts.json` 含 PAT 明文（长期根凭据），务必保持 0600 且勿提交/外传

## 目录

| 文件 | 说明 |
|---|---|
| `qoder_bridge.mjs` | 主服务 |
| `qoder_auth.wasm` | 签名模块（自提取，见 EXTRACT.md）|
| `qoder_glue.mjs` | wasm-bindgen 胶水（自提取）|
| `ui.html` | 管理面板 |
| `accounts.example.json` | 账号池模板 |
| `qoder-bridge.service.example` | systemd user 服务示例 |
| `tools/` | 提取脚本 + 探针 |
| `.github/workflows/ci.yml` | CI：语法检查 + 敏感文件守卫 |
| `EXTRACT.md` | 运行时文件提取说明 |

## License

[MIT](LICENSE)
