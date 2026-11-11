# 逆向提取工具

官方 CLI（Bun SEA 单文件）把签名 WASM 以 base64 内联进 JS chunk。
CLI 升级后若 bridge 报 Signature invalid，重新提取：

```bash
# 1. 提取 WASM（搜 AGFzbQE = \0asm\x01 的 base64，按导出符号识别 qoder_auth 模块）
python3 tools/decode_b64_wasm.py /path/to/qodercli
#    → /tmp/qoder_auth.wasm，复制到项目根目录

# 2. 提取 wasm-bindgen glue（按 qodercontext_new 包装类定位，chunk 以 // @bun 开头）
python3 tools/extract_glue.py /path/to/qodercli
#    → 定位到 glue chunk，裁剪后保存为 qoder_glue.mjs

# 3. 替换 qoder_auth.wasm / qoder_glue.mjs 后重启 bridge
```

## runtime auth fields（重要）

服务端要求每次客户端会话现算认证字段。WASM 直连签名流程：

```js
const creds = JSON.parse(glue.credential_storage_decrypt(用户文件, machine_id前16字符));
const gen = JSON.parse(glue.generate_runtime_auth_fields(JSON.stringify(creds))); // ⚠️ 必须传全量 creds
const ctx = new glue.QoderContext(machineId, cliVersion,   // cliVersion 从 CLI version.txt 读
  JSON.stringify({ uid: creds.uid, encrypt_user_info: gen.encrypt_user_info, key: gen.key }),
  JSON.stringify({ client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' }));
```

- 用凭证文件里的旧 encrypt_user_info/key → 105 Login expired
- generate_runtime_auth_fields 传 access_token 裸串 → 生成的值不对（101）
- gen 原始串缺 uid，不能直接当 userInfoJson
- token 过期/签名被拒 → 重新跑 generate_runtime_auth_fields 而不是只重载凭证

## mitm_capture.py

MITM 抓包辅助脚本（需要自备代理环境）。仅供学习协议用。
