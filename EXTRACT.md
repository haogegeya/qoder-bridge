# 提取 qoder_auth.wasm 与 qoder_glue.mjs

`qoder_auth.wasm`（签名模块）和 `qoder_glue.mjs`（wasm-bindgen 胶水）是从 Qoder 官方 CLI
二进制中提取的运行时文件。**因含官方签名逻辑与用户身份数据，不随本仓库分发**，需自行从
本机安装的官方 CLI 提取。tools/ 目录提供完整脚本。

## 前置

需要一份 Qoder 官方 CLI 二进制（`qoderclicn` / `qodercli`）。通常随 Qoder / Qoder CN
客户端安装，或通过官方 npm 包 `@qoder-ai/qodercli` 获得。

## 提取步骤

```bash
# 1. 提取签名 WASM（按导出符号 qodercontext_prepareInferRequest 识别）
python3 tools/decode_b64_wasm.py
#   输出: /tmp/qoder_auth.wasm

# 2. 提取 wasm-bindgen 胶水 JS chunk
python3 tools/extract_glue.py
#   输出: 定位到 glue chunk（需手工裁剪出 // @bun 开头的那一段）

# 3. 将提取结果放到本目录
cp /tmp/qoder_auth.wasm ./
# 将裁剪好的 glue 存为 qoder_glue.mjs
```

> 脚本内的 `BIN` 路径需按本机 CLI 实际路径修改（见脚本头部注释）。

## 说明

- WASM 以 base64 内联在 CLI 的 JS chunk 里，靠 `\0asm` 的 base64 前缀 `AGFzbQE` 定位。
- glue 通过包装方法 `prepareInferRequest(e,t,r,_){` 定位。
- 这两个文件是运行时必需的；缺一个 bridge 都无法启动。它们是官方二进制的子集，
  请仅用于自用学习，勿滥用或违反官方服务条款。
