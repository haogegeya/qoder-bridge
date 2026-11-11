# mitmproxy addon: 抓 Qoder 桌面端推理流量
# mitmdump -s mitm_capture.py --listen-port 8899 --set confdir=...
import json
import time
from mitmproxy import http

OUT = r"C:\Users\Administrator\Desktop\qoder-bridge\logs\desktop_infer_flows.jsonl"
INTEREST = ("api2.qoder.sh", "gateway.qoder.com.cn", "qoder.com", "qoder.com.cn")


class Capture:
    def response(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        if not any(h in host for h in INTEREST):
            return
        req_headers = {}
        for k, v in flow.request.headers.items():
            lk = k.lower()
            if lk.startswith("cosy-") or lk in ("authorization", "user-agent", "content-type", "login-version"):
                vv = v
                if lk == "authorization":
                    vv = v[:14] + "..." + v[-4:]
                req_headers[k] = vv
        rec = {
            "ts": time.strftime("%H:%M:%S"),
            "method": flow.request.method,
            "url": flow.request.pretty_url[:300],
            "req_headers": req_headers,
            "req_body": flow.request.get_text(strict=False)[:3000] if flow.request.content else "",
            "status": flow.response.status_code if flow.response else None,
            "resp_head": flow.response.get_text(strict=False)[:1500] if flow.response and flow.response.content else "",
        }
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


addons = [Capture()]
