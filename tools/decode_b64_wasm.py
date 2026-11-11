#!/usr/bin/env python3
"""解码二进制里 base64 内联的 wasm, 按导出符号识别, 保存 qoder_auth 模块.

用法: python3 decode_b64_wasm.py <qoderclicn/qodercli 二进制路径>
"""
import base64, sys

if len(sys.argv) < 2:
    print("用法: python3 decode_b64_wasm.py <CLI二进制路径>")
    sys.exit(1)
BIN = sys.argv[1]
data = open(BIN, "rb").read()

B64 = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_")
NEEDLE = b"qodercontext_prepareInferRequest"

# 重新全量搜 base64 wasm magic
p, hits = 0, []
while True:
    p = data.find(b"AGFzbQE", p)   # \0asm\x01 ...
    if p < 0:
        break
    hits.append(p)
    p += 1
print(f"base64 wasm hits: {len(hits)}")

def uleb(buf, pos):
    r = 0; sh = 0
    while True:
        b = buf[pos]; pos += 1
        r |= (b & 0x7F) << sh
        if not (b & 0x80):
            return r, pos
        sh += 7

def walk_end(buf):
    pos = 8
    try:
        while pos < len(buf):
            sid = buf[pos]
            if sid > 12:
                return pos
            sz, q = uleb(buf, pos + 1)
            if q + sz > len(buf):
                return pos
            pos = q + sz
        return pos
    except IndexError:
        return pos

saved = []
for h in hits:
    s = h
    while s > 0 and data[s-1] in B64:
        s -= 1
    e = h
    while e < len(data) and data[e] in B64:
        e += 1
    b64 = data[s:e]
    try:
        raw = base64.b64decode(b64 + b"=" * (-len(b64) % 4))
    except Exception as ex:
        print(f"@{h:#x}: decode FAIL {ex} (b64len={len(b64)})")
        continue
    if raw[:4] != b"\x00asm":
        print(f"@{h:#x}: b64={len(b64)}B raw={len(raw)}B NOT-wasm: {raw[:16]!r}")
        continue
    end = walk_end(raw)
    blob = raw[:end]
    qc = NEEDLE in blob
    tags = []
    for nd, tag in [(b"qodercontext_", "qodercontext"), (b"credential", "credential"),
                    (b"tree_sitter", "tree-sitter"), (b"toml", "toml"),
                    (b"photon", "photon"), (b"markdown", "markdown")]:
        if nd in blob:
            tags.append(tag)
    print(f"@{h:#x}: WASM raw={len(raw)}B trimmed={len(blob)}B qc={qc} tags={tags}")
    name = None
    if qc:
        name = "/tmp/qoder_auth.wasm"
    elif "credential" in tags and b"qodercontext_" not in blob:
        name = "/tmp/credential.wasm"
    if name:
        open(name, "wb").write(blob)
        print(f"   >>> SAVED {name}")
        saved.append(name)

print(f"\nsaved: {saved}")
