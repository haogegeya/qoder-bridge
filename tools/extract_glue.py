#!/usr/bin/env python3
"""从二进制提取 qoder_auth wasm 的 wasm-bindgen glue JS chunk.

用法: python3 extract_glue.py <CLI二进制路径>
定位: 类包装方法 'prepareInferRequest(e,t,r,_)' 所在的连续文本块.
"""
import sys

if len(sys.argv) < 2:
    print("用法: python3 extract_glue.py <CLI二进制路径>")
    sys.exit(1)
BIN = sys.argv[1]
data = open(BIN, "rb").read()

def printable(b):
    return 32 <= b < 127 or b in (9, 10, 13)

# 找包装方法文本
needles = [b"prepareInferRequest(e,t,r,_){", b"qodercontext_prepareInferRequest(w,this.__wbg_ptr"]
hit = None
for nd in needles:
    p = data.find(nd)
    if p > 0:
        hit = p
        print(f"glue marker {nd[:40]!r} @ {p:#x}")
        break
if hit is None:
    raise SystemExit("glue not found")

# 向前后扩展: 允许 <=12 连续不可打印字节, 累计不可打印超过则停
def expand(p, step):
    pos = p
    bad = 0
    limit = 6_000_000
    n = 0
    while 0 < pos < len(data) and n < limit:
        b = data[pos]
        if printable(b):
            bad = 0
        else:
            bad += 1
            if bad > 12:
                return pos - bad + 1
        pos += step
        n += 1
    return pos

start = expand(hit, -1)
end = expand(hit, +1)
chunk = data[start:end]
print(f"chunk span: {start:#x}..{end:#x} = {len(chunk)} bytes")
print("head 200:", chunk[:200])
print("tail 200:", chunk[-200:])
open("/tmp/qoder_glue.js", "wb").write(chunk)
print("saved -> /tmp/qoder_glue.js")

# 关键信息: wasm 模块变量名 & init 函数
text = chunk.decode("utf-8", "replace")
import re
m = re.findall(r"\blet (n|[a-zA-Z_$]{1,3})[,;=]", text[:2000])
print("\nhead identifiers sample:", m[:20])
# 查找 qodercontext_new 的包装
for name in ["qodercontext_new(", "qodercontext_prepareRequest(", "generate_runtime_auth_fields",
             "credential_storage_decrypt(", "__wbg_init", "async function __wbg"]:
    idx = text.find(name)
    print(f"{name!r}: {'FOUND @'+str(idx) if idx>=0 else 'not in chunk'}")
