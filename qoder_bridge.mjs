// qoder_bridge.mjs — Qoder 直连网关 (OpenAI 兼容 API, PAT 账号池)
// 认证: 个人访问令牌 (PAT) → jobToken/exchange → jt/jrt → wasm 签名 → gateway
// 无需 CLI 进程。账号池手动切换, 自动签到, 排队重试, 流式, 多模型。
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const glue = require('./qoder_glue.mjs');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QODER_BRIDGE_PORT || 8100);
const REQUEST_TIMEOUT_MS = 300_000;
const QUEUE_MAX_WAIT_MS = Number(process.env.QODER_QUEUE_MAX_WAIT_MS || 600_000);
const QUEUE_RETRY_MAX = Number(process.env.QODER_QUEUE_RETRY_MAX || 10);
const QUEUE_RETRY_BASE_MS = Number(process.env.QODER_QUEUE_RETRY_BASE_MS || 3_000);
const QUEUE_RETRY_CAP_MS = Number(process.env.QODER_QUEUE_RETRY_CAP_MS || 60_000);
const EXTERNAL_MODEL = 'qoder-model';
const STATE_FILE = process.env.QODER_BRIDGE_STATE || path.join(DIR, 'state.json');
const ACCOUNTS_FILE = process.env.QODER_ACCOUNTS_FILE || path.join(DIR, 'accounts.json');
const HTML_FILE = path.join(DIR, 'ui.html');
const HOME = os.homedir();

const EDITIONS = {
  cn: { id: 'cn', label: '国内版', gateway: 'https://gateway.qoder.com.cn', openapi: 'https://openapi.qoder.com.cn', home: path.join(HOME, '.qoder-cn'), fallbackVersion: '1.1.84' },
  global: { id: 'global', label: '国际版', gateway: 'https://api2.qoder.sh', openapi: 'https://openapi.qoder.sh', home: path.join(HOME, '.qoder'), fallbackVersion: '1.1.77' },
};

glue.initSync({ module: fs.readFileSync(path.join(DIR, 'qoder_auth.wasm')) });

// ---- Machine ID: bridge 自持, 首次从 CLI 目录继承或自动生成 ----
const MID_FILE = path.join(DIR, 'machine_id');
let MACHINE_ID;
try { MACHINE_ID = fs.readFileSync(MID_FILE, 'utf8').trim(); } catch {
  try { MACHINE_ID = fs.readFileSync(path.join(HOME, '.qoder-cn', '.auth', 'machine_id'), 'utf8').trim(); } catch { MACHINE_ID = crypto.randomUUID(); }
  fs.writeFileSync(MID_FILE, MACHINE_ID);
}

// ---- 设备风控身份 (runtime-info / UMID): 生成 Cosy-MachineToken/Code/Type ----
// 国际版服务端只对带真实设备身份的请求下发「每天领 100 Credits」活动。
// 来源优先级: ① 本机 Qoder/Qoder-CN 客户端 resources/umid/runtime-info
//            ② qodercli 解压到 ~/.qoder(.cn)/.bin/runtime-info-* 的组件
// 调用: runtime-info <env>，第一行输出 JSON {machineToken, machineCode, machineType, ...}
// env: 国际版 4(SINGAPORE, qodercli 取值) / 客户端自带用 3; 国内版 0。实测本机 3/4 输出一致。
const RISK_TTL_MS = 50 * 60 * 1000;          // 客户端每 60±5min 刷新, 保守取 50min
const RISK_TIMEOUT_MS = 25_000;
const RUNTIME_INFO_EXE = process.platform === 'win32' ? 'runtime-info.exe' : 'runtime-info';
// 国际版用哪个 env: 优先 qodercli 的 4（SINGAPORE 全球区），客户端自带降级用 3
const RISK_ENV = { global: 4, cn: 0 };

function findRuntimeInfo(ed) {
  // ① 本机客户端自带的 umid/runtime-info
  const clientHomes = ed === 'cn'
    ? ['/opt/Qoder-CN/resources/umid', '/usr/lib/qoder-cn/resources/umid', '/opt/qoder-cn/resources/umid', '/opt/Qoder/resources/umid']
    : ['/opt/Qoder/resources/umid', '/usr/lib/qoder/resources/umid', '/opt/qoder/resources/umid', '/opt/Qoder-CN/resources/umid'];
  for (const dir of clientHomes) {
    const p = path.join(dir, RUNTIME_INFO_EXE);
    if (fs.existsSync(p)) return { exe: p, env: ed === 'cn' ? 0 : 3, source: 'client' };  // 客户端自带国际版用 3
  }
  // ② qodercli 解压的组件 (~/.qoder/.bin 或 ~/.qoder-cn/.bin)
  const cliHome = ed === 'cn' ? path.join(HOME, '.qoder-cn', '.bin') : path.join(HOME, '.qoder', '.bin');
  let dirs = [];
  try { dirs = fs.readdirSync(cliHome).filter((n) => n.startsWith('runtime-info-')); } catch {}
  for (const d of dirs) {
    const p = path.join(cliHome, d);
    if (fs.statSync(p, { throwIfNoEntry: false })?.isFile?.() || (fs.existsSync(p) && fs.statSync(p).isFile())) {
      return { exe: p, env: RISK_ENV[ed], source: 'cli' };   // qodercli 组件用 4(global)/0(cn)
    }
  }
  return null;
}

function runRuntimeInfo(exe, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [String(env)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) { try { child.kill(); } catch {} }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error('runtime-info 超时')), RISK_TIMEOUT_MS);
    const tryParse = () => {
      const nl = out.indexOf('\n');
      if (nl < 0) return false;
      try {
        const j = JSON.parse(out.slice(0, nl));
        const pick = (k) => { const s = typeof j[k] === 'string' ? j[k].trim() : ''; if (!s || s.length > 4096) throw new Error(`runtime-info 输出缺少 ${k}`); return s; };
        done(null, { machineToken: pick('machineToken'), machineCode: pick('machineCode'), machineType: pick('machineType'), vmInfo: j.vmInfo || null });
      } catch (e) { done(e); }
      return true;
    };
    child.stdout.on('data', (d) => { out += d.toString('utf8'); if (out.length > 1024 * 1024) return done(new Error('runtime-info 输出过大')); tryParse(); });
    child.stderr.on('data', () => {});
    child.once('error', (e) => done(new Error(`runtime-info 启动失败：${e.message}`)));
    child.once('close', (code) => { if (!tryParse()) done(new Error(`runtime-info 退出码 ${code}`)); });
  });
}

const riskCache = {};   // ed -> { value, at, inflight }
const riskSource = {};  // ed -> source 名
/** 获取某版本账号的设备风控身份; 无 runtime-info 时返回 null (不影响国内版签到) */
async function getRiskIdentity(ed) {
  const runner = findRuntimeInfo(ed);
  if (!runner) { riskSource[ed] = null; return null; }
  riskSource[ed] = runner.source;
  const hit = riskCache[ed];
  if (hit?.value && Date.now() - hit.at < RISK_TTL_MS) return hit.value;
  if (hit?.inflight) return hit.inflight;
  const promise = runRuntimeInfo(runner.exe, runner.env)
    .then((value) => { riskCache[ed] = { value, at: Date.now(), inflight: null }; return value; })
    .catch((e) => { delete riskCache[ed]; throw e; });
  riskCache[ed] = { inflight: promise };
  return promise;
}
/** 强制刷新设备身份 (面板手动触发用) */
async function refreshRiskIdentity(ed) {
  delete riskCache[ed];
  return getRiskIdentity(ed);
}
function riskInfo(ed) {
  const hit = riskCache[ed];
  const runner = findRuntimeInfo(ed);
  return { source: riskSource[ed] || (runner?.source || null), runner: runner ? { env: runner.env, exe: runner.exe } : null, cached: Boolean(hit?.value), vmInfo: hit?.value?.vmInfo || null, ttlMs: RISK_TTL_MS };
}

// ---- CLI 版本号 (签名用, 服务端拒过旧版本) ----
const verCaches = {};
function cliVersion(ed = 'cn') {
  if (!verCaches[ed]) {
    let v = EDITIONS[ed].fallbackVersion;
    const dir = ed === 'cn' ? 'qoderclicn' : 'qodercli';
    try { v = fs.readFileSync(path.join(EDITIONS[ed].home, 'bin', dir, 'version.txt'), 'utf8').trim() || v; } catch {}
    verCaches[ed] = v;
  }
  return verCaches[ed];
}

// ---- 账号存储 (accounts.json, 0600) ----
let ACCOUNTS = [];
function loadAccounts() {
  try { ACCOUNTS = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { ACCOUNTS = []; }
}
function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(ACCOUNTS, null, 2), { mode: 0o600 });
  try { fs.chmodSync(ACCOUNTS_FILE, 0o600); } catch {}
}
loadAccounts();

// ---- PAT token 管理 (exchange → jt/jrt, TTL 缓存, 自动续期) ----
const accountCaches = {}; // id -> {jt, jrt, expiresAt, uid, name, userInfo, runtimeAuth, creds}
const exchangeInflight = {}; // id -> Promise (防并发)

async function exchangePAT(pat, ed = 'cn') {
  const base = EDITIONS[ed].openapi;
  const r = await fetch(`${base}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ personal_token: pat }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`PAT exchange failed: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchUserInfo(token, ed = 'cn') {
  const r = await fetch(`${EDITIONS[ed].openapi}/api/v1/userinfo`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`userinfo failed: HTTP ${r.status}`);
  return r.json();
}

function buildCredsFromExchange(ex, ui, pat) {
  const now = Math.floor(Date.now() / 1000);
  return {
    uid: ui.id, name: ui.name || '', avatar_url: ui.avatar || '',
    access_token: ex.token, security_oauth_token: ex.token,
    refresh_token: ex.refresh_token, personal_access_token: pat,
    login_method: 'token', login_timestamp: now,
    expire_time: now + Math.floor((ex.expires_in || 86400000) / 1000),
    refresh_token_expire_time: now + Math.floor((ex.refresh_token_expires_in || 172800000) / 1000),
    encrypt_user_info: '', key: '',
    user_type: ui.user_type || 'personal_professional',
    is_personal_version: true, data_policy_agreed: true,
  };
}

async function ensureAccountToken(acc, force = false) {
  const cache = accountCaches[acc.id];
  const margin = 300_000; // 提前 5min 续期
  if (!force && cache && cache.expiresAt - margin > Date.now()) return cache;
  if (exchangeInflight[acc.id]) return exchangeInflight[acc.id];
  exchangeInflight[acc.id] = (async () => {
    try {
      const ex = await exchangePAT(acc.pat, acc.edition);
      const ui = await fetchUserInfo(ex.token, acc.edition);
      const creds = buildCredsFromExchange(ex, ui, acc.pat);
      const gen = JSON.parse(glue.generate_runtime_auth_fields(JSON.stringify(creds)));
      const runtimeAuth = { uid: creds.uid, encrypt_user_info: gen.encrypt_user_info, key: gen.key };
      const entry = {
        jt: ex.token, jrt: ex.refresh_token,
        expiresAt: Date.now() + (ex.expires_in || 86400000),
        uid: ui.id, name: ui.name || '', userInfo: ui,
        runtimeAuth, creds,
      };
      accountCaches[acc.id] = entry;
      console.log(`[account:${acc.alias}] token refreshed uid=${ui.id} expires=${new Date(entry.expiresAt).toISOString()}`);
      return entry;
    } finally { delete exchangeInflight[acc.id]; }
  })();
  return exchangeInflight[acc.id];
}

// ---- 当前账号快捷访问 ----
function activeAccount() { return ACCOUNTS.find((a) => a.id === STATE.activeAccount) || ACCOUNTS[0] || null; }
function activeCache() { const a = activeAccount(); return a ? accountCaches[a.id] || null : null; }
function accessToken() { const c = activeCache(); if (!c) throw new Error('no active account token'); return c.jt; }
function userInfoJson() { const c = activeCache(); if (!c) throw new Error('no active account'); return JSON.stringify(c.runtimeAuth); }
function currentEdition() { return activeAccount()?.edition || 'cn'; }
function gwBase() { return EDITIONS[currentEdition()].gateway; }
function apiBase() { return EDITIONS[currentEdition()].openapi; }

// ---- 状态持久化 ----
const FREE = new Set(['qfmodel', 'dfmodel']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultCheckin() { return { lastDate: null, lastAt: 0, lastError: null, lastResults: [], history: [] }; }
function newState() {
  return {
    activeKey: 'qfmodel', activeSince: Date.now(),
    activeAccount: null,
    activeKeys: {},  // accountId -> model key
    switches: [], usage: {}, today: null,
    checkinByAccount: {},  // accountId -> checkin state
  };
}
let STATE = newState();
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    STATE = { ...newState(), ...s, usage: s.usage || {}, switches: s.switches || [] };
    STATE.activeKeys = s.activeKeys || {};
    STATE.checkinByAccount = s.checkinByAccount || {};
    // 旧版单账号 checkin 迁移到当前账号
    if (s.checkin && STATE.activeAccount && !STATE.checkinByAccount[STATE.activeAccount]) {
      STATE.checkinByAccount[STATE.activeAccount] = { ...defaultCheckin(), ...s.checkin };
    }
    delete STATE.checkin;
  } catch { STATE = newState(); }
}
function checkinFor(id) {
  if (!STATE.checkinByAccount[id]) STATE.checkinByAccount[id] = defaultCheckin();
  return STATE.checkinByAccount[id];
}
function curCheckin() {
  return checkinFor(STATE.activeAccount || '_none');
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE)); } catch (e) { console.error('[state] save failed:', e.message); }
}
function dayKey() { return new Date().toISOString().slice(0, 10); }
function rollDay() { const d = dayKey(); if (STATE.today !== d) { STATE.today = d; STATE.usage = {}; saveState(); } }
function recordUsage(key, { error = false, prompt = 0, completion = 0, credits = 0 } = {}) {
  rollDay();
  const u = STATE.usage[key] = STATE.usage[key] || { requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, credits: 0 };
  if (error) u.errors++;
  else { u.requests++; u.prompt_tokens += prompt; u.completion_tokens += completion; u.credits += credits; }
  saveState();
}
function setActiveKey(key) {
  const acc = activeAccount();
  if (acc) { STATE.activeKeys = STATE.activeKeys || {}; STATE.activeKeys[acc.id] = key; }
  if (key === STATE.activeKey) return false;
  STATE.switches.unshift({ ts: Date.now(), from: STATE.activeKey, to: key });
  STATE.switches = STATE.switches.slice(0, 100);
  STATE.activeKey = key; STATE.activeSince = Date.now();
  saveState();
  console.log(`[active] model → ${key}`);
  return true;
}
loadState();
rollDay();

// ---- 模型目录: 优先网络直拉 (wasm 签名 GET /algo/api/v2/model/list), 本地 catalog-v7 兜底 ----
// 本地文件是 CLI 落盘的加密缓存, 只有 CLI 跑过才更新; 网络直拉已实测 cn/global 均 200。
const catalogCaches = {};
const CATALOG_NET_TTL_MS = 6 * 3600_000; // 网络目录 6h 刷新一次
// chat 段 = CLI 视角; app 段 = 桌面 IDE 视角 (QoDuck/lmodel、Fast 等只在 app 段)
// 合并两段, chat 优先, app 独有的补进来 (实测 lmodel 在服务端可路由, 受每日免费次数限制)
function mergeCatalogSections(parsed) {
  const chat = Array.isArray(parsed.chat) ? parsed.chat : [];
  const app = Array.isArray(parsed.app) ? parsed.app : [];
  const byKey = new Map(chat.filter((m) => m && m.key).map((m) => [m.key, m]));
  for (const m of app) {
    if (m && m.key && !byKey.has(m.key)) { m._surface = 'app'; byKey.set(m.key, m); }
  }
  return [...byKey.values()];
}
function loadCatalog(force = false) {
  const acc = activeAccount();
  const cache = accountCaches[acc?.id];
  const uid = cache?.uid;
  const ed = currentEdition();
  const ck = `${ed}:${uid || 'any'}`;
  const cat = catalogCaches[ck] = catalogCaches[ck] || { mtimeMs: 0, netAt: 0, models: [], byKey: {} };
  if (!uid) return cat;
  try {
    const f = path.join(EDITIONS[ed].home, '.models', uid, 'catalog-v7');
    const st = fs.statSync(f);
    // 网络数据更新鲜时优先网络; 否则(文件比上次网拉还新 = CLI 刚更新过)用文件
    if ((force || st.mtimeMs !== cat.mtimeMs || !cat.models.length) && st.mtimeMs > cat.netAt) {
      const dec = glue.model_cache_decrypt(fs.readFileSync(f, 'utf8'), uid);
      const parsed = JSON.parse(Buffer.from(dec).toString('utf8'));
      const models = mergeCatalogSections(parsed);
      cat.mtimeMs = st.mtimeMs; cat.models = models;
      cat.byKey = Object.fromEntries(models.map((m) => [m.key, m]));
    }
  } catch (e) {
    if (!cat.models.length) {
      // 本地无目录时尝试复用同版本其他 uid 的目录 (模型 key 全局一致)
      try {
        const modelsDir = path.join(EDITIONS[ed].home, '.models');
        for (const d of fs.readdirSync(modelsDir)) {
          const f2 = path.join(modelsDir, d, 'catalog-v7');
          if (!fs.existsSync(f2)) continue;
          const dec = glue.model_cache_decrypt(fs.readFileSync(f2, 'utf8'), d);
          const parsed = JSON.parse(Buffer.from(dec).toString('utf8'));
          const models = mergeCatalogSections(parsed);
          if (models.length) {
            cat.models = models;
            cat.byKey = Object.fromEntries(models.map((m) => [m.key, m]));
            break;
          }
        }
      } catch {}
    }
  }
  return cat;
}

// 网络直拉模型目录 (仅当前激活账号; wasm ctx 绑定激活账号)
async function refreshCatalogNetwork(force = false) {
  const acc = activeAccount();
  const cache = activeCache();
  if (!acc || !cache?.uid) return { ok: false, error: 'no active account' };
  const ck = `${acc.edition}:${cache.uid}`;
  const cat = catalogCaches[ck] = catalogCaches[ck] || { mtimeMs: 0, netAt: 0, models: [], byKey: {} };
  if (!force && cat.models.length && Date.now() - cat.netAt < CATALOG_NET_TTL_MS) return { ok: true, cached: true, count: cat.models.length };
  const ctx = acquireCtx();
  try {
    const res = ctx.prepareRequest(gwBase(), '/algo/api/v2/model/list?Encode=1', 'GET', 'auth', undefined, undefined);
    const url = res.url, headers = Object.fromEntries(res.headers);
    res.free();
    const r = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
    const txt = await r.text();
    if (!r.ok) { console.log(`[catalog] net list http=${r.status}`); return { ok: false, status: r.status }; }
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch { parsed = JSON.parse(Buffer.from(glue.model_cache_decrypt(txt, cache.uid)).toString('utf8')); }
    const models = mergeCatalogSections(parsed);
    if (!models.length) return { ok: false, error: 'empty model list' };
    cat.models = models;
    cat.byKey = Object.fromEntries(models.map((m) => [m.key, m]));
    cat.netAt = Date.now();
    console.log(`[catalog] net refresh ${acc.alias} (${acc.edition}) → ${models.length} models`);
    return { ok: true, count: models.length };
  } catch (e) {
    console.log(`[catalog] net refresh error: ${e.message}`);
    return { ok: false, error: String(e.message || e) };
  } finally { releaseCtx(ctx); }
}

// ---- QoderContext 池 ----
const ctxPool = [];
function buildCtx() {
  return new glue.QoderContext(MACHINE_ID, cliVersion(currentEdition()), userInfoJson(),
    JSON.stringify({ client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' }));
}
function acquireCtx() {
  const c = ctxPool.pop();
  if (!c) return buildCtx();
  try { c.refreshAuthFields(userInfoJson()); return c; }
  catch { try { c.free(); } catch {} return buildCtx(); }
}
function releaseCtx(c) { if (ctxPool.length < 8) ctxPool.push(c); else try { c.free(); } catch {} }
function drainCtxPool() { while (ctxPool.length) { try { ctxPool.pop().free(); } catch {} } }

// ---- 推理 (wasm 签名直连) ----
async function inferOnceWasm(modelKey, messages, stream, extra = {}) {
  const ctx = acquireCtx();
  const businessId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const requestSetId = crypto.randomUUID();
  const inferStart = Date.now();
  try {
    const firstUser = messages.find((m) => m && m.role === 'user');
    const bizName = (() => {
      const c = firstUser?.content;
      if (typeof c === 'string') return c.slice(0, 120);
      if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('').slice(0, 120);
      return '';
    })();
    const body = {
      model: modelKey, messages, stream: !!stream,
      request_id: requestId, request_set_id: requestSetId,
      chat_record_id: requestId, session_id: sessionId,
      // ⚠️ 2026-11-09 修复: qodercli 1.1.85 请求必带 agent_id=agent_common,
      // 缺它服务端 agent_router 报 'flow nodes found for router agent_router' (400)
      agent_id: 'agent_common',
      business: { product: 'cli', version: cliVersion(currentEdition()), type: 'agent', id: businessId, name: bizName, begin_at: inferStart, stage: 'start', model_key: modelKey },
      metadata: { context: { request_id: requestId, request_set_id: requestSetId, session_id: sessionId, client_type: '5' } },
    };
    if (extra.max_tokens) body.max_tokens = extra.max_tokens;
    if (extra.temperature !== undefined) body.temperature = extra.temperature;
    if (Array.isArray(extra.tools) && extra.tools.length) body.tools = extra.tools;
    if (extra.tool_choice !== undefined) body.tool_choice = extra.tool_choice;

    const res = ctx.prepareInferRequest(gwBase(), JSON.stringify(body), modelKey, 'system');
    const url = res.url, headers = Object.fromEntries(res.headers), bodyBytes = Buffer.from(res.body);
    res.free();

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('bridge timeout')), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: bodyBytes, signal: ac.signal });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', sseText = '', terminal = false;
      while (!terminal) {
        let done, value;
        try { ({ done, value } = await reader.read()); } catch { break; }
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const evt = buf.slice(0, idx); buf = buf.slice(idx + 2); sseText += evt + '\n\n';
          if (evt.includes('[DONE]') || /^event:\s*finish\b/m.test(evt)) { terminal = true; break; }
          const m = evt.match(/\\?"code\\?":\\?"(\d+)\\?"/);
          if (m && m[1] !== '0') { terminal = true; break; }
        }
      }
      try { reader.cancel(); } catch {}
      const rep = parseSse(sseText);
      const durationMs = Date.now() - inferStart;
      reportBusinessFinish({ businessId, sessionId, requestSetId, modelKey, timeConsumedMs: durationMs }).catch(() => {});
      reportAgentSummary({ businessId, sessionId, requestSetId, modelKey, durationMs, usage: rep.usage, credits: rep.credits, originalCredits: rep.originalCredits, terminalReason: rep.finish || 'end_turn' }).catch(() => {});
      return { status: resp.status, sseText };
    } finally { clearTimeout(t); }
  } finally { releaseCtx(ctx); }
}

// ---- 业务上报 ----
async function reportBusinessFinish({ businessId, sessionId, requestSetId, modelKey, timeConsumedMs }) {
  const ctx = acquireCtx();
  try {
    const cache = activeCache();
    const uid = cache?.uid || '';
    const finishEvt = {
      event_time: Date.now(), event_type: 'BUSINESS_FINISH', mid: MACHINE_ID,
      aid: '', rid: crypto.randomUUID(), oid: '', yid: '', uid,
      event_data: { session_id: sessionId, business: { product: 'cli', version: cliVersion(currentEdition()), type: 'agent', id: businessId, model_key: modelKey, end_at: Date.now(), stage: 'completed', name: '' } },
    };
    const fBody = JSON.stringify({ payload: JSON.stringify(finishEvt), encodeVersion: '1' });
    const fRes = ctx.prepareRequest(gwBase(), '/algo/api/v2/service/business/finish?Encode=1', 'POST', 'auth', fBody, undefined);
    const fUrl = fRes.url, fHeaders = Object.fromEntries(fRes.headers), fBytes = Buffer.from(fRes.body);
    fRes.free();
    const fResp = await fetch(fUrl, { method: 'POST', headers: fHeaders, body: fBytes, signal: AbortSignal.timeout(10_000) }).catch(() => ({ status: 0 }));
    console.log(`[biz] finish business=${businessId.slice(0, 8)} → HTTP ${fResp.status}`);
    if (requestSetId) {
      const aBody = JSON.stringify({ payload: JSON.stringify({ model_key: modelKey, request_set_id: requestSetId, user_id: uid, time_consumed: Math.max(0, Math.round(timeConsumedMs || 0)) }), encodeVersion: '1' });
      const aRes = ctx.prepareRequest(gwBase(), '/api/v2/service/ask/finish?Encode=1', 'POST', 'auth', aBody, undefined);
      const aUrl = aRes.url, aHeaders = Object.fromEntries(aRes.headers), aBytes = Buffer.from(aRes.body);
      aRes.free();
      const aResp = await fetch(aUrl, { method: 'POST', headers: aHeaders, body: aBytes, signal: AbortSignal.timeout(10_000) }).catch(() => ({ status: 0 }));
      console.log(`[biz] ask/finish set=${requestSetId.slice(0, 8)} → HTTP ${aResp.status}`);
    }
  } catch {} finally { releaseCtx(ctx); }
}

async function reportAgentSummary({ businessId, sessionId, requestSetId, modelKey, durationMs, usage, credits, originalCredits, terminalReason }) {
  const ctx = acquireCtx();
  try {
    const cache = activeCache();
    const uid = cache?.uid || '';
    const reason = terminalReason || 'end_turn';
    const item = {
      schema_version: 2, session_id: sessionId, task_id: businessId, request_set_id: requestSetId,
      prompt_id: sessionId, entry: 'headless', product: 'cli', client_type: '5',
      cli_version: cliVersion(currentEdition()), os_type: 'linux', query_callback: 'end',
      terminal_reason: reason, business_state_final: reason === 'end_turn' ? 'complete' : 'error',
      duration_ms: Math.max(0, Math.round(durationMs || 0)), loop_iteration_count: 1,
      observation_collection_complete: true, observation_truncated: false,
      code_mutation_count: 0, code_lines_added: 0, code_lines_removed: 0,
      verification_attempted_after_change: null, verification_test_attempt_count: 0,
      verification_build_attempt_count: 0, verification_lint_attempt_count: 0,
      verification_typecheck_attempt_count: 0, verification_mixed_attempt_count: 0,
      verification_final_result: 'unknown', cancellation_observed: false, user_cancelled: false,
      plan_enter_count: 0, plan_exit_count: 0, plan_review_approved_count: 0,
      plan_review_rejected_count: 0, plan_final_state: 'unknown', doom_loop_prompt_count: 0,
      permission_check_count: 0, permission_prompt_decision_count: 0,
      permission_prompt_allow_count: 0, permission_prompt_deny_count: 0, permission_prompt_abort_count: 0,
      edit_write_prompt_decision_count: 0, edit_write_accepted_count: 0,
      edit_write_accepted_with_edits_count: 0, edit_write_rejected_count: 0,
      goal_state_change_count: 0, goal_stop_decision_count: 0, goal_stop_continue_count: 0,
      model_request_count: 1, model_request_success_count: 1, model_request_error_count: 0, model_request_abort_count: 0,
      actual_model: modelKey, total_input_tokens: usage?.prompt_tokens || 0, total_output_tokens: usage?.completion_tokens || 0,
      total_cache_read_tokens: 0, total_cache_write_tokens: 0, total_thinking_tokens: 0,
      total_credits: credits ?? 0, total_original_credits: originalCredits ?? 0,
      average_ttft_ms: Math.max(0, Math.round(durationMs || 0)),
      compaction_count: 0, compaction_retry_count: 0, context_window_exceeded_count: 0,
      malformed_tool_use_count: 0, malformed_tool_use_retry_count: 0, tool_source_failed_count: 0,
      delivery_mode: 'best_effort_background',
    };
    const envelope = {
      uuid: crypto.randomUUID(), event_type: 'qodercli-back-flow-agent-query-finish',
      event_time: Date.now(), uid, oid: '', mid: MACHINE_ID, aid: '',
      os_arch: 'x64', os_version: os.release(), ide_type: 'CLI', ide_version: cliVersion(currentEdition()),
      cluster_env: '', business_id: businessId, git_remote: '', event_data: { items: [item] },
    };
    const bodyStr = JSON.stringify([envelope]);
    const res = ctx.prepareRequest(gwBase(), '/api/v1/tracking', 'POST', 'sign', bodyStr, undefined);
    const url = res.url, headers = Object.fromEntries(res.headers), bodyBytes = Buffer.from(res.body);
    res.free();
    const resp = await fetch(url, { method: 'POST', headers, body: bodyBytes, signal: AbortSignal.timeout(10_000) }).catch(() => ({ status: 0 }));
    console.log(`[biz] agent_summary business=${businessId.slice(0, 8)} model=${modelKey} → HTTP ${resp.status}`);
  } catch (e) { console.log(`[biz] agent_summary failed: ${String(e.message || e).slice(0, 120)}`); }
  finally { releaseCtx(ctx); }
}

// ---- 错误分类 ----
function classifyNon200(status, text) {
  const out = { status, code: null, queue: false };
  let t = String(text || '');
  try { const j = JSON.parse(t); t = String(j.message ?? j.body ?? t); } catch {}
  for (let i = 0; i < 4 && t; i++) {
    if (/10605/.test(t)) { out.code = '10605'; out.queue = true; break; }
    let nxt = null;
    try { nxt = JSON.parse(t); } catch { break; }
    if (nxt && typeof nxt === 'object') { const inner = nxt.message ?? nxt.body; t = typeof inner === 'string' ? inner : JSON.stringify(inner); } else break;
  }
  return out;
}
function unwrapQueue(msg, depth = 4) {
  let o = msg;
  for (let i = 0; i < depth; i++) {
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
    else if (o && typeof o === 'object') { if (o.isQueued) return o; o = o.message ?? o.body ?? null; if (o == null) return null; }
    else return null;
  }
  return null;
}
function classifySse(sseText) {
  for (const evt of sseText.split('\n\n')) {
    const line = evt.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      const j = JSON.parse(line.slice(5).trim());
      if (!j.body || typeof j.body !== 'string') continue;
      const inner = JSON.parse(j.body);
      if (inner.code && inner.code !== '0') {
        const msg = String(inner.message || '');
        const queue = msg.includes('isQueued') ? unwrapQueue(msg) : null;
        const auth = msg.includes('Signature invalid') || inner.code === '101' || /login (expired|timeout)/i.test(msg);
        return { code: inner.code, message: msg, queue, auth };
      }
    } catch {}
  }
  return {};
}

// ---- 认证自愈: PAT re-exchange (替代旧 CLI watchdog) ----
async function renewActiveAccount() {
  const acc = activeAccount();
  if (!acc) return;
  try {
    await ensureAccountToken(acc, true);
    drainCtxPool();
    console.log(`[auth] PAT re-exchange OK for ${acc.alias}`);
  } catch (e) { console.error(`[auth] PAT re-exchange failed: ${e.message}`); }
}

// ---- 带重试的推理 ----
async function infer(modelKey, messages, stream, extra = {}) {
  const deadline = Date.now() + QUEUE_MAX_WAIT_MS;
  let authRetried = false, qRetries = 0;
  for (let attempt = 1; ; attempt++) {
    const { status, sseText } = await inferOnceWasm(modelKey, messages, stream, extra);
    if (status === 200) {
      const cls = classifySse(sseText);
      if (cls.queue) {
        const waitS = Math.min((cls.queue.retryAfterSeconds || cls.queue.waitTime || 30) + 2, 150);
        if (Date.now() + waitS * 1000 > deadline) return { status, sseText, queuedOut: cls.queue };
        console.log(`[queue] ${cls.queue.queueType} #${cls.queue.queueCount} → wait ${waitS}s (attempt ${attempt})`);
        await sleep(waitS * 1000); continue;
      }
      if (cls.auth && !authRetried) { authRetried = true; console.log('[auth] signature/login expired → PAT re-exchange'); await renewActiveAccount(); continue; }
      return { status, sseText };
    }
    const nc = classifyNon200(status, sseText);
    if (nc.queue) {
      qRetries++;
      const waitMs = Math.min(QUEUE_RETRY_BASE_MS * 2 ** (qRetries - 1), QUEUE_RETRY_CAP_MS);
      if (qRetries > QUEUE_RETRY_MAX || Date.now() + waitMs > deadline) { console.log(`[queue] 10605 exhausted (${qRetries}/${QUEUE_RETRY_MAX})`); return { status, sseText, queueExhausted: true }; }
      console.log(`[queue] 10605 → backoff ${Math.round(waitMs / 1000)}s (retry ${qRetries}/${QUEUE_RETRY_MAX})`);
      await sleep(waitMs); continue;
    }
    if (status === 401 && !authRetried) { authRetried = true; console.log('[auth] http 401 → PAT re-exchange'); await renewActiveAccount(); continue; }
    return { status, sseText };
  }
}

// ---- SSE 解析聚合 ----
function parseSse(sseText) {
  let content = '', reasoning = '', usage = null, finish = null;
  let credits = null, originalCredits = null, billable = null;
  let serverId = null, modelOut = 'auto', created = Math.floor(Date.now() / 1000);
  const tcMap = new Map();
  for (const evt of sseText.split('\n\n')) {
    const line = evt.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      const j = JSON.parse(line.slice(5).trim());
      if (j.event === 'finish') continue;
      if (!j.body || typeof j.body !== 'string' || j.body === '[DONE]') continue;
      const inner = JSON.parse(j.body);
      if (inner.id) serverId = inner.id;
      if (inner.model) modelOut = inner.model;
      if (inner.code && inner.code !== '0') continue;
      if (inner.usage) {
        usage = { prompt_tokens: inner.usage.prompt_tokens || 0, completion_tokens: inner.usage.completion_tokens || 0, total_tokens: inner.usage.total_tokens || 0 };
        if (typeof inner.usage.credits === 'number') credits = inner.usage.credits;
        if (typeof inner.usage.original_credits === 'number') originalCredits = inner.usage.original_credits;
        if (typeof inner.usage.billable === 'boolean') billable = inner.usage.billable;
      }
      const ch = inner.choices?.[0];
      if (!ch) continue;
      if (ch.delta?.content) content += ch.delta.content;
      if (ch.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (Array.isArray(ch.delta?.tool_calls)) {
        for (const tc of ch.delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!tcMap.has(idx)) tcMap.set(idx, { id: '', type: 'function', function: { name: '', arguments: '' } });
          const acc = tcMap.get(idx);
          if (tc.id) acc.id = tc.id;
          if (tc.type) acc.type = tc.type;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
      if (ch.finish_reason && ch.finish_reason !== 'null') finish = ch.finish_reason;
    } catch {}
  }
  const toolCalls = tcMap.size ? [...tcMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) : undefined;
  return { content, reasoning, usage, finish, toolCalls, serverId, model: modelOut, created, credits, originalCredits, billable };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
const openaiErr = (message, type = 'invalid_request_error', code = 400) => ({ error: { message, type, code } });

// ---- 额度/套餐 (20s 缓存) ----
const QP_TTL_MS = 20_000;
let qpCache = { at: 0, quota: null, plan: null, inflight: null };
async function getQuotaPlan() {
  const now = Date.now();
  const has = qpCache.quota !== null || qpCache.plan !== null;
  if (now - qpCache.at < QP_TTL_MS && has) return { quota: qpCache.quota, plan: qpCache.plan };
  if (!qpCache.inflight) {
    qpCache.inflight = (async () => {
      let quota = null, plan = null;
      try {
        const tok = accessToken();
        for (const [url, key] of [[`${apiBase()}/api/v2/quota/usage`, 'quota'], [`${apiBase()}/api/v2/user/plan`, 'plan']]) {
          try {
            const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            const j = await r.json();
            if (key === 'quota') quota = r.ok ? j : null; else plan = r.ok ? j : null;
          } catch {}
        }
      } catch {}
      qpCache.quota = quota; qpCache.plan = plan; qpCache.at = Date.now(); qpCache.inflight = null;
    })();
  }
  if (has) return { quota: qpCache.quota, plan: qpCache.plan };
  await qpCache.inflight;
  return { quota: qpCache.quota, plan: qpCache.plan };
}

// ---- 签到/权益活动 (sash, 纯 Bearer) ----
// acc 为 null 时用当前激活账号; 否则用指定账号的 jt + edition
async function sashHeaders(acc = null) {
  const ed = acc ? acc.edition : currentEdition();
  const tok = acc ? accountCaches[acc.id]?.jt : accessToken();
  if (!tok) throw new Error(`no token for account ${acc?.alias || '(active)'}`);
  const h = {
    Authorization: `Bearer ${tok}`, Accept: 'application/json',
    // growth campaign（每天领 100 Credits）由服务端按 Cosy-ClientType 过滤：
    // 只有桌面 IDE 的 client_type=10 才返回 CLAIM_BENEFIT 活动，CLI 的 5 会返回空列表。
    // (国际版/国内版均适用, 已实测: jt- token + client_type=10 可列出并领取)
    'Cosy-Version': cliVersion(ed), 'Cosy-ClientType': '10', 'User-Agent': 'qoder-ide',
    'Cosy-MachineOS': 'x86_64_linux', 'Cosy-MachineId': MACHINE_ID,
    'Cosy-MachineHostname': os.hostname().replace(/[^a-zA-Z0-9.-]/g, ''),
  };
  // 国际版: 注入真实设备风控身份 (Cosy-MachineToken/Code/Type) —— 服务端只对带真身份的请求下发每日 100 Credits
  try {
    const risk = await getRiskIdentity(ed);
    if (risk) {
      h['Cosy-MachineToken'] = risk.machineToken;
      h['Cosy-MachineCode'] = risk.machineCode;
      h['Cosy-MachineType'] = risk.machineType;
    }
  } catch (e) {
    console.log(`[risk] ${ed} identity error: ${e.message}`);
  }
  return h;
}
async function sashFetch(pathname, opts = {}, acc = null) {
  const base = acc ? EDITIONS[acc.edition].openapi : apiBase();
  const h = await sashHeaders(acc);
  const r = await fetch(`${base}${pathname}`, { ...opts, headers: { ...h, ...(opts.headers || {}) }, signal: AbortSignal.timeout(10_000) });
  let body = null;
  try { body = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, body };
}

// ---- 活动领取 (OpenApi v2, Bearer + Cosy) ----
async function openapiHeaders(acc = null) {
  const ed = acc ? acc.edition : currentEdition();
  const tok = acc ? accountCaches[acc.id]?.jt : accessToken();
  if (!tok) throw new Error(`no token for account ${acc?.alias || '(active)'}`);
  const h = {
    Authorization: `Bearer ${tok}`, Accept: 'application/json',
    'Cosy-Version': cliVersion(ed),
    'Cosy-MachineType': 'desktop',
    'Cosy-MachineOS': 'linux',
    'Cosy-ClientType': ed === 'global' ? '0' : '5',
    'Accept-Language': 'zh-CN',
  };
  // 替换原来的假 'Cosy-MachineToken': 'bridge' 为真实设备身份 (否则国际版风控不认)
  try {
    const risk = await getRiskIdentity(ed);
    if (risk) {
      h['Cosy-MachineToken'] = risk.machineToken;
      h['Cosy-MachineCode'] = risk.machineCode;
      h['Cosy-MachineType'] = risk.machineType;
    } else {
      h['Cosy-MachineToken'] = 'bridge';   // 兜底: 无 runtime-info 时保留旧行为
    }
  } catch (e) {
    console.log(`[risk] ${ed} identity error: ${e.message}`);
    h['Cosy-MachineToken'] = 'bridge';
  }
  return h;
}
async function openapiFetch(pathname, opts = {}, acc = null) {
  const base = acc ? EDITIONS[acc.edition].openapi : EDITIONS[currentEdition()].openapi;
  const h = await openapiHeaders(acc);
  const r = await fetch(`${base}${pathname}`, { ...opts, headers: { ...h, ...(opts.headers || {}) }, signal: AbortSignal.timeout(10_000) });
  let body = null;
  try { body = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, body };
}
async function fetchClaimEligibility(acc = null) {
  return openapiFetch('/api/v2/activity/claim/eligibility', {}, acc);
}
async function claimActivityApi(activityId, acc = null) {
  return openapiFetch(`/api/v2/activity/claim?activityId=${encodeURIComponent(activityId)}`, { method: 'POST' }, acc);
}
async function fetchActivityQuotaReset(acc = null) {
  return openapiFetch('/api/v2/activity/quota/reset/latest', {}, acc);
}
// 桌面端活动列表的主数据源: 推理网关 GET /algo/api/v2/activity, 需 wasm COSY 签名
// (纯 Bearer / 纯 JS 签名均 403; wasm 用 CLI 版本 + client_type 按版本区分即可 200)
async function fetchActivityListWasm() {
  const ctx = acquireCtx();
  try {
    const res = ctx.prepareRequest(gwBase(), '/algo/api/v2/activity', 'GET', 'auth', undefined, undefined);
    const url = res.url, headers = Object.fromEntries(res.headers);
    res.free();
    const r = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
    let body = null; try { body = await r.json(); } catch {}
    const activities = r.ok && body?.code === 0 ? (body.data?.activities || []) : [];
    return { ok: r.ok, status: r.status, activities };
  } catch (e) {
    console.log(`[activity] list(wasm) error: ${e.message}`);
    return { ok: false, status: 0, activities: [] };
  } finally { releaseCtx(ctx); }
}
const ACTIVITY_TTL_MS = 30_000;
const activityCaches = {}; // accountId -> { at, eligibility, quotaReset, list, inflight }
async function getActivities(force = false, acc = null) {
  const target = acc || activeAccount();
  if (!target) return { eligibility: [], quotaReset: null };
  const id = target.id;
  const ac = activityCaches[id] = activityCaches[id] || { at: 0, eligibility: null, quotaReset: null, list: null, inflight: null };
  const now = Date.now();
  if (!force && ac.eligibility !== null && now - ac.at < ACTIVITY_TTL_MS) {
    return { eligibility: ac.eligibility, quotaReset: ac.quotaReset };
  }
  if (!ac.inflight) {
    ac.inflight = (async () => {
      try {
        await ensureAccountToken(target);
        const isActive = target.id === STATE.activeAccount;
        const [elig, qr, list] = await Promise.all([
          fetchClaimEligibility(target), fetchActivityQuotaReset(target),
          // wasm 活动列表绑定激活账号的签名上下文, 仅激活账号拉取(展示用)
          isActive ? fetchActivityListWasm() : Promise.resolve({ ok: false, status: 0, activities: [] }),
        ]);
        const eligArr = elig.ok && elig.body?.code === 0 ? (elig.body.data || []) : [];
        ac.quotaReset = qr.ok && qr.body?.code === 0 ? qr.body : null;
        ac.list = list.activities;
        // 合并: eligibility 提供领取状态, 活动列表补充展示项 (按 activityId 去重)
        const byId = new Map(eligArr.map(e => [e.activityId, { ...e }]));
        for (const a of list.activities) {
          if (!a || !a.activityId) continue;
          const prev = byId.get(a.activityId) || {};
          byId.set(a.activityId, {
            ...a, ...prev,
            activityId: a.activityId,
            modelName: prev.modelName || a.modelName || a.activityName || a.name || null,
            statusText: prev.statusText || a.statusText || null,
            canClaim: prev.canClaim === true || a.canClaim === true,
            claimed: prev.claimed === true || a.claimed === true,
          });
        }
        ac.eligibility = [...byId.values()];
        ac.at = Date.now();
      } catch (e) {
        console.log(`[activity:${target.alias}] fetch error: ${e.message}`);
        ac.eligibility = [];
        ac.quotaReset = null;
        ac.list = [];
        ac.at = Date.now();
      }
      ac.inflight = null;
    })();
  }
  if (!force && ac.eligibility !== null) {
    return { eligibility: ac.eligibility, quotaReset: ac.quotaReset };
  }
  await ac.inflight;
  return { eligibility: ac.eligibility, quotaReset: ac.quotaReset };
}
function activitySummary(eligibility) {
  if (!Array.isArray(eligibility)) return [];
  return eligibility.map(e => ({
    activityId: e.activityId,
    canClaim: e.canClaim === true,
    claimed: e.claimed === true,
    modelName: e.modelName || null,
    statusText: e.statusText || null,
    tag: e.tag || null,
    tagStyle: e.tagStyle || null,
    activityEndAt: e.activityEndAt || null,
    claimText: e.claimText || null,
    hoverTip: e.hoverTip || null,
    ifShowClaimDisable: e.ifShowClaimDisable === true,
    resetStrategy: e.resetStrategy || null,
    remaining: e.remaining ?? null,
    limit: e.limit ?? null,
  }));
}
function claimableActivities(eligibility) {
  return activitySummary(eligibility).filter(a => a.canClaim && !a.claimed);
}
async function claimCampaignApi(campaignId, acc = null) {
  return sashFetch(`/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, { method: 'POST' }, acc);
}
const CAMP_TTL_MS = 30_000;
const campCaches = {}; // accountId -> { at, data, inflight }
async function getCampaigns(force = false, acc = null) {
  const target = acc || activeAccount();
  if (!target) return null;
  const id = target.id;
  const cc = campCaches[id] = campCaches[id] || { at: 0, data: null, inflight: null };
  const now = Date.now();
  if (!force && cc.data !== null && now - cc.at < CAMP_TTL_MS) return cc.data;
  if (!cc.inflight) {
    cc.inflight = (async () => {
      let out = null;
      try {
        await ensureAccountToken(target);
        const r = await sashFetch('/sash/api/v1/me/campaigns', {}, target);
        if (r.ok) out = r.body; else console.log(`[campaign:${target.alias}] list http=${r.status}`);
      } catch (e) { console.log(`[campaign:${target.alias}] list error: ${e.message}`); }
      cc.data = out; cc.at = Date.now(); cc.inflight = null;
    })();
  }
  if (!force && cc.data !== null) return cc.data;
  await cc.inflight;
  return cc.data;
}
function campaignSummary(list) {
  const arr = Array.isArray(list?.campaigns) ? list.campaigns : [];
  return arr.map((c) => ({
    campaignId: c.campaignId, campaignKey: c.campaignKey, actionType: c.actionType, claimStatus: c.claimStatus,
    benefitKind: c.benefit?.kind || null, benefitAmount: c.benefit?.amount ?? null,
    startAt: c.startAt ?? null, endAt: c.endAt ?? null,
    title: c.placements?.map((p) => p?.content?.zh?.title || p?.content?.en?.title).find(Boolean) || '',
  }));
}
function claimableCampaigns(list) { return campaignSummary(list).filter((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE'); }
function recordCheckinRun(trigger, results, error = null, accId = null) {
  const ck = checkinFor(accId || STATE.activeAccount || '_none');
  ck.lastDate = dayKey(); ck.lastAt = Date.now();
  ck.lastError = error; ck.lastResults = results;
  if (results.length) ck.history = [...results, ...ck.history].slice(0, 50);
  saveState();
}

// ---- 自动签到: 遍历账号池, 每个账号独立检查+领取 ----
// 之前的版本只签当前激活账号, 其余账号的每日 100 Credits 会漏掉。
async function doCheckinForAccount(acc, trigger) {
  const results = [];
  try {
    await ensureAccountToken(acc);
    // 1. sash campaigns (每日 100 Credits, 国内版/国际版同一机制)
    const list = await getCampaigns(true, acc);
    if (list) {
      const targets = claimableCampaigns(list);
      for (const c of targets) {
        const r = await claimCampaignApi(c.campaignId, acc);
        results.push({ source: 'sash', ts: Date.now(), trigger, accountId: acc.id, alias: acc.alias, campaignId: c.campaignId, campaignKey: c.campaignKey, amount: c.benefitAmount, kind: c.benefitKind, status: r.ok ? 'claimed' : `http_${r.status}`, detail: r.body ?? null });
        console.log(`[checkin:${acc.alias}] sash claim ${c.campaignKey || c.campaignId.slice(0, 8)} → ${r.ok ? 'OK' : `HTTP ${r.status}`}`);
      }
      if (campCaches[acc.id]) campCaches[acc.id].at = 0;
    }
    // 2. activity claim API (模型体验金等)
    const { eligibility } = await getActivities(true, acc);
    const actTargets = claimableActivities(eligibility);
    for (const a of actTargets) {
      const r = await claimActivityApi(a.activityId, acc);
      const ok = r.ok && r.body?.code === 0;
      results.push({ source: 'activity', ts: Date.now(), trigger, accountId: acc.id, alias: acc.alias, activityId: a.activityId, modelName: a.modelName, status: ok ? 'claimed' : `http_${r.status}_${r.body?.msg || ''}`, detail: r.body ?? null });
      console.log(`[checkin:${acc.alias}] activity claim ${a.activityId?.slice(0, 8)} → ${ok ? 'OK' : `HTTP ${r.status}`}`);
    }
    if (activityCaches[acc.id]) activityCaches[acc.id].at = 0;
    recordCheckinRun(trigger, results, null, acc.id);
    return { ok: true, results };
  } catch (e) {
    recordCheckinRun(trigger, results, String(e.message || e), acc.id);
    console.log(`[checkin:${acc.alias}] error: ${e.message}`);
    return { ok: false, error: String(e.message || e), results };
  }
}
let checkinInflight = null;
function doCheckin(trigger) {
  if (checkinInflight) return checkinInflight;
  checkinInflight = (async () => {
    const accounts = [];
    const results = [];
    let ok = true;
    for (const acc of ACCOUNTS) {
      const r = await doCheckinForAccount(acc, trigger);
      accounts.push({ accountId: acc.id, alias: acc.alias, edition: acc.edition, ok: r.ok, error: r.error || null, claimed: r.results.filter(x => x.status === 'claimed').length });
      results.push(...r.results);
      if (!r.ok) ok = false;
    }
    const claimed = results.filter(r => r.status === 'claimed').length;
    const note = claimed
      ? `claimed ${claimed} benefit(s) across ${accounts.length} account(s)`
      : `no claimable campaigns or activities (${accounts.length} account(s) checked)`;
    return { ok, trigger, accounts, results, claimed, note };
  })();
  return checkinInflight.finally(() => { checkinInflight = null; });
}
const CHECKIN_INTERVAL_MS = 15 * 60_000;
setTimeout(() => { if (ACCOUNTS.length) doCheckin('startup').catch(() => {}); }, 5_000);
setInterval(() => { if (ACCOUNTS.length) doCheckin('timer').catch(() => {}); }, CHECKIN_INTERVAL_MS);
// 模型目录网络直拉: 启动后拉一次, 之后每小时检查 (内部 6h TTL 闸门)
setTimeout(() => { refreshCatalogNetwork().catch(() => {}); }, 8_000);
setInterval(() => { refreshCatalogNetwork().catch(() => {}); }, 3600_000);

// ---- 账号切换 ----
async function setAccount(id) {
  const acc = ACCOUNTS.find((a) => a.id === id);
  if (!acc) throw new Error(`account '${id}' not found`);
  if (id === STATE.activeAccount) return { ok: true, changed: false, activeAccount: id };
  const prev = STATE.activeAccount;
  if (prev) { STATE.activeKeys = STATE.activeKeys || {}; STATE.activeKeys[prev] = STATE.activeKey; }
  STATE.activeAccount = id;
  drainCtxPool();
  qpCache = { at: 0, quota: null, plan: null, inflight: null };
  delete campCaches[id]; delete activityCaches[id];
  await ensureAccountToken(acc);
  const cat = loadCatalog(true);
  refreshCatalogNetwork().catch(() => {});  // 切换后顺手网拉最新目录 (异步)
  const cand = STATE.activeKeys?.[id];
  if (cand && cat.byKey[cand]?.enable) setActiveKey(cand);
  else { const first = cat.models.find((m) => m.enable); if (first) setActiveKey(first.key); }
  saveState();
  console.log(`[account] ${prev || 'none'} → ${acc.alias} (${acc.edition}) model=${STATE.activeKey}`);
  setTimeout(() => doCheckin('account-switch').catch(() => {}), 1_000);
  return { ok: true, changed: true, activeAccount: id, alias: acc.alias, activeKey: STATE.activeKey };
}

// ---- 账号列表 (UI 安全: 不暴露 PAT) ----
function checkinOverview() {
  return ACCOUNTS.map((a) => {
    const ck = STATE.checkinByAccount[a.id];
    const lastClaim = (ck?.history || []).find((h) => h.status === 'claimed') || null;
    return {
      id: a.id, alias: a.alias, edition: a.edition,
      lastAt: ck?.lastAt || 0, lastError: ck?.lastError || null,
      claimedToday: (ck?.lastResults || []).some((r) => r.status === 'claimed'),
      lastClaim: lastClaim ? { ts: lastClaim.ts, title: lastClaim.campaignKey || lastClaim.modelName || lastClaim.activityId || '', amount: lastClaim.amount ?? null, trigger: lastClaim.trigger || '' } : null,
    };
  });
}
function accountList() {
  return ACCOUNTS.map((a) => {
    const c = accountCaches[a.id];
    return {
      id: a.id, alias: a.alias, edition: a.edition, note: a.note || '',
      createdAt: a.createdAt, active: a.id === STATE.activeAccount,
      uid: c?.uid || null, name: c?.name || null,
      tokenValid: c ? c.expiresAt > Date.now() : false,
      lastKey: STATE.activeKeys?.[a.id] || null,
    };
  });
}

// ---- UI 状态 ----
function uiState() {
  const cat = loadCatalog();
  return (async () => {
    const [{ quota, plan }, { eligibility, quotaReset }] = await Promise.all([getQuotaPlan(), getActivities()]);
    rollDay();
    const cache = activeCache();
    const acc = activeAccount();
    return {
      now: Date.now(),
      edition: currentEdition(), editionLabel: EDITIONS[currentEdition()].label,
      activeAccount: STATE.activeAccount, accounts: accountList(),
      account: { uid: cache?.uid, name: cache?.name, alias: acc?.alias },
      activeKey: STATE.activeKey, activeSince: STATE.activeSince,
      quota, plan,
      models: cat.models.map((m) => ({ key: m.key, display_name: m.display_name, price_factor: m.price_factor, original_price_factor: m.original_price_factor, is_free: !!m.is_free, enable: m.enable, max_input_tokens: m.max_input_tokens, is_reasoning: m.is_reasoning, surface: m._surface || 'chat' })),
      catalogInfo: { count: cat.models.length, source: cat.netAt > cat.mtimeMs ? 'network' : 'file', netAt: cat.netAt || 0, fileAt: cat.mtimeMs || 0 },
      switches: STATE.switches.slice(0, 20),
      usage: STATE.usage, usageDate: STATE.today,
      checkin: { lastDate: curCheckin().lastDate, lastAt: curCheckin().lastAt, lastError: curCheckin().lastError, lastResults: curCheckin().lastResults, history: curCheckin().history.slice(0, 20) },
      checkinAll: checkinOverview(),
      activities: activitySummary(eligibility),
      activityClaimableCount: claimableActivities(eligibility).length,
      activityQuotaReset: quotaReset,
    };
  })();
}

// ---- HTTP 服务 ----
async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
  }
  if (req.method === 'GET' && p === '/') {
    try { const html = fs.readFileSync(HTML_FILE); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length }); return res.end(html); }
    catch (e) { return json(res, 500, openaiErr('ui.html missing: ' + e.message)); }
  }
  if (req.method === 'GET' && p === '/health') {
    return json(res, 200, { status: 'ok', service: 'qoder-bridge', mode: 'pat-pool', endpoint: gwBase(), edition: currentEdition(), active_model: EXTERNAL_MODEL, active_key: STATE.activeKey, active_account: STATE.activeAccount, accounts_count: ACCOUNTS.length, uid: activeCache()?.uid, risk: { cn: riskInfo('cn'), global: riskInfo('global') } });
  }

  // ---- 账号 CRUD ----
  if (req.method === 'GET' && p === '/ui/accounts') return json(res, 200, { accounts: accountList() });
  if (req.method === 'POST' && p === '/ui/accounts') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, openaiErr('invalid JSON')); }
    const pat = String(body.pat || '').trim();
    const alias = String(body.alias || '').trim();
    const ed = String(body.edition || 'cn');
    if (!pat || !pat.startsWith('pt-')) return json(res, 400, openaiErr('pat required (pt-...)'));
    if (!alias) return json(res, 400, openaiErr('alias required'));
    if (!EDITIONS[ed]) return json(res, 400, openaiErr('edition must be cn or global'));
    if (ACCOUNTS.some((a) => a.pat === pat)) return json(res, 409, openaiErr('this PAT already exists'));
    // 校验: exchange + userinfo
    let ex, ui;
    try { ex = await exchangePAT(pat, ed); ui = await fetchUserInfo(ex.token, ed); }
    catch (e) { return json(res, 400, openaiErr('PAT validation failed: ' + e.message)); }
    const acc = { id: crypto.randomUUID(), alias, pat, edition: ed, note: String(body.note || ''), createdAt: Date.now() };
    ACCOUNTS.push(acc); saveAccounts();
    // 预热缓存
    const creds = buildCredsFromExchange(ex, ui, pat);
    const gen = JSON.parse(glue.generate_runtime_auth_fields(JSON.stringify(creds)));
    accountCaches[acc.id] = { jt: ex.token, jrt: ex.refresh_token, expiresAt: Date.now() + (ex.expires_in || 86400000), uid: ui.id, name: ui.name || '', userInfo: ui, runtimeAuth: { uid: ui.id, encrypt_user_info: gen.encrypt_user_info, key: gen.key }, creds };
    // 首个账号自动激活
    if (!STATE.activeAccount) await setAccount(acc.id);
    console.log(`[account] added "${alias}" uid=${ui.id} edition=${ed}`);
    return json(res, 201, { ok: true, account: { id: acc.id, alias, edition: ed, uid: ui.id, name: ui.name } });
  }
  if (req.method === 'PUT' && p.startsWith('/ui/accounts/')) {
    const id = p.slice('/ui/accounts/'.length);
    const acc = ACCOUNTS.find((a) => a.id === id);
    if (!acc) return json(res, 404, openaiErr('account not found'));
    let body; try { body = await readBody(req); } catch { return json(res, 400, openaiErr('invalid JSON')); }
    if (body.alias !== undefined) acc.alias = String(body.alias).trim() || acc.alias;
    if (body.note !== undefined) acc.note = String(body.note);
    saveAccounts();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && p.startsWith('/ui/accounts/')) {
    const id = p.slice('/ui/accounts/'.length);
    const idx = ACCOUNTS.findIndex((a) => a.id === id);
    if (idx < 0) return json(res, 404, openaiErr('account not found'));
    const removed = ACCOUNTS.splice(idx, 1)[0];
    delete accountCaches[id];
    saveAccounts();
    if (STATE.activeAccount === id) {
      STATE.activeAccount = null;
      if (ACCOUNTS.length) await setAccount(ACCOUNTS[0].id);
      else { drainCtxPool(); saveState(); }
    }
    console.log(`[account] removed "${removed.alias}"`);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/ui/account') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, openaiErr('invalid JSON')); }
    try { return json(res, 200, await setAccount(String(body.id || ''))); }
    catch (e) { return json(res, 400, openaiErr(e.message)); }
  }

  // ---- 签到 ----
  if (req.method === 'GET' && p === '/ui/state') return json(res, 200, await uiState());
  if (req.method === 'GET' && p === '/ui/campaigns') {
    const list = await getCampaigns();
    return json(res, 200, {
      now: Date.now(), edition: currentEdition(),
      showCampaign: !!list?.showCampaign, claimable: !!list?.claimable,
      campaigns: campaignSummary(list), claimableCount: claimableCampaigns(list).length,
      checkin: curCheckin(),
      checkinAll: checkinOverview(),
      historyAll: ACCOUNTS.flatMap((a) => (STATE.checkinByAccount[a.id]?.history || []).map((h) => ({ ...h, alias: a.alias })))
        .sort((x, y) => y.ts - x.ts).slice(0, 20),
      apiCheckin: currentEdition() === 'cn',
    });
  }
  if (req.method === 'POST' && p === '/ui/checkin') {
    const r = await doCheckin('manual');
    return json(res, r?.ok ? 200 : 502, r || { ok: false, error: 'checkin failed' });
  }
  if (req.method === 'POST' && p === '/ui/claim') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, openaiErr('invalid JSON')); }
    const id = String(body.campaignId || '');
    if (!id) return json(res, 400, openaiErr('campaignId required'));
    const r = await claimCampaignApi(id);
    if (r.ok) {
      const ck = curCheckin();
      ck.history = [{ ts: Date.now(), trigger: 'manual', campaignId: id, campaignKey: body.campaignKey || '', amount: body.amount ?? null, kind: body.kind || null, status: 'claimed', detail: r.body ?? null }, ...ck.history].slice(0, 50);
      ck.lastAt = Date.now(); saveState(); if (campCaches[STATE.activeAccount]) campCaches[STATE.activeAccount].at = 0;
    }
    return json(res, r.ok ? 200 : 502, { ok: r.ok, status: r.status, body: r.body });
  }
  // ---- 活动领取 (OpenApi v2) ----
  if (req.method === 'GET' && p === '/ui/activities') {
    const { eligibility, quotaReset } = await getActivities();
    return json(res, 200, {
      now: Date.now(), edition: currentEdition(),
      activities: activitySummary(eligibility),
      claimableCount: claimableActivities(eligibility).length,
      quotaReset,
      checkin: curCheckin(),
    });
  }
  if (req.method === 'POST' && p === '/ui/activities/claim') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, openaiErr('invalid JSON')); }
    const id = String(body.activityId || '');
    if (!id) return json(res, 400, openaiErr('activityId required'));
    const r = await claimActivityApi(id);
    const ok = r.ok && r.body?.code === 0;
    if (ok) {
      const ck = curCheckin();
      ck.history = [{ source: 'activity', ts: Date.now(), trigger: 'manual', activityId: id, modelName: body.modelName || '', status: 'claimed', detail: r.body ?? null }, ...ck.history].slice(0, 50);
      ck.lastAt = Date.now(); saveState(); if (activityCaches[STATE.activeAccount]) activityCaches[STATE.activeAccount].at = 0;
    }
    return json(res, ok ? 200 : 502, { ok, status: r.status, body: r.body });
  }

  // ---- 模型切换 ----
  if (req.method === 'POST' && p === '/ui/models/refresh') {
    const r = await refreshCatalogNetwork(true);
    return json(res, r.ok ? 200 : 502, r);
  }
  if (req.method === 'POST' && p === '/ui/active-model') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, openaiErr('invalid JSON')); }
    const key = String(body.key || '');
    const cat = loadCatalog();
    if (!cat.byKey[key] || !cat.byKey[key].enable) return json(res, 400, openaiErr(`unknown or disabled model key '${key}'`));
    setActiveKey(key);
    return json(res, 200, { ok: true, activeKey: STATE.activeKey });
  }
  if (req.method === 'GET' && p === '/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: EXTERNAL_MODEL, object: 'model', owned_by: 'qoder', qoder_key: STATE.activeKey }] });
  }

  // ---- 推理 ----
  if (req.method === 'POST' && p === '/v1/chat/completions') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, openaiErr('invalid JSON body')); }
    const modelIn = body.model || '';
    if (modelIn !== EXTERNAL_MODEL) return json(res, 404, openaiErr(`unknown model '${modelIn}'. only '${EXTERNAL_MODEL}' is exposed (strict mode)`));
    if (!activeAccount()) return json(res, 503, openaiErr('no account configured. add one via UI first.'));
    // 确保 token 有效
    try { await ensureAccountToken(activeAccount()); } catch (e) { return json(res, 503, openaiErr('account token unavailable: ' + e.message)); }
    const modelKey = STATE.activeKey;
    const rawMessages = Array.isArray(body.messages) ? body.messages : null;
    if (!rawMessages?.length) return json(res, 400, openaiErr('messages required'));
    const messages = rawMessages.map((m) => m && m.role === 'assistant' && (m.content === null || m.content === undefined) && Array.isArray(m.tool_calls) ? { ...m, content: '' } : m);
    const t0 = Date.now();
    try {
      const { status, sseText, queuedOut, queueExhausted } = await infer(modelKey, messages, !!body.stream, body);
      if (queuedOut) { recordUsage(modelKey, { error: true }); return json(res, 429, openaiErr(`qoder free queue: #${queuedOut.queueCount} ${queuedOut.queueType}, wait ~${queuedOut.waitTime || queuedOut.retryAfterSeconds}s`, 'rate_limit', 429)); }
      if (queueExhausted) { recordUsage(modelKey, { error: true }); return json(res, 429, openaiErr(`qoder free queue: queuing failed (10605) after ${QUEUE_RETRY_MAX} retries`, 'rate_limit', 429)); }
      if (status !== 200) { recordUsage(modelKey, { error: true }); console.error(`[err] model=${modelKey} http=${status} ${sseText.slice(0, 200)}`); return json(res, 502, openaiErr(`qoder gateway http ${status}: ${sseText.slice(0, 300)}`, 'upstream_error', 502)); }
      const parsed = parseSse(sseText);
      if (parsed.toolCalls && (!parsed.finish || parsed.finish === 'stop')) parsed.finish = 'tool_calls';
      const ms = Date.now() - t0;
      if (!parsed.content && !parsed.reasoning && !parsed.toolCalls) { recordUsage(modelKey, { error: true }); return json(res, 502, openaiErr(`qoder api returned no content: ${sseText.slice(0, 300)}`, 'upstream_error', 502)); }
      recordUsage(modelKey, { prompt: parsed.usage?.prompt_tokens || 0, completion: parsed.usage?.completion_tokens || 0, credits: parsed.billable === false ? 0 : (parsed.credits ?? 0) });
      const id = `chatcmpl-bridge-${parsed.serverId || crypto.randomUUID()}`;
      console.log(`[ok] ${modelKey} ${parsed.usage?.prompt_tokens ?? '?'}+${parsed.usage?.completion_tokens ?? '?'} tok ${ms}ms`);
      if (!body.stream) {
        const message = { role: 'assistant', content: parsed.content || null };
        if (parsed.reasoning) message.reasoning_content = parsed.reasoning;
        if (parsed.toolCalls) message.tool_calls = parsed.toolCalls;
        return json(res, 200, { id, object: 'chat.completion', created: parsed.created, model: EXTERNAL_MODEL, choices: [{ index: 0, message, finish_reason: parsed.finish || 'stop' }], usage: { ...(parsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), credits: parsed.credits, original_credits: parsed.originalCredits, billable: parsed.billable } });
      }
      // 流式
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      let sent = false, lastContentChunk = null;
      for (const evt of sseText.split('\n\n')) {
        const line = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j.event === 'finish') continue;
          if (!j.body || typeof j.body !== 'string') continue;
          if (j.body === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
          const inner = JSON.parse(j.body);
          if (inner.id && !sent) { res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: parsed.created, model: EXTERNAL_MODEL, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`); sent = true; }
          if (inner.usage) {
            const chU = inner.choices?.[0];
            if (chU) {
              const deltaU = {};
              if (chU.delta?.content) deltaU.content = chU.delta.content;
              if (chU.delta?.reasoning_content) deltaU.reasoning_content = chU.delta.reasoning_content;
              if (Array.isArray(chU.delta?.tool_calls)) deltaU.tool_calls = chU.delta.tool_calls;
              const frU = chU.finish_reason && chU.finish_reason !== 'null' ? chU.finish_reason : null;
              if (Object.keys(deltaU).length || frU) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: parsed.created, model: EXTERNAL_MODEL, choices: [{ index: 0, delta: deltaU, finish_reason: frU }] })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: parsed.created, model: EXTERNAL_MODEL, choices: [], usage: { ...(parsed.usage || inner.usage), credits: parsed.credits, original_credits: parsed.originalCredits, billable: parsed.billable } })}\n\n`);
            continue;
          }
          if (inner.code && inner.code !== '0') continue;
          const ch = inner.choices?.[0];
          if (!ch) continue;
          const delta = {};
          if (ch.delta?.content) delta.content = ch.delta.content;
          if (ch.delta?.reasoning_content) delta.reasoning_content = ch.delta.reasoning_content;
          if (Array.isArray(ch.delta?.tool_calls)) delta.tool_calls = ch.delta.tool_calls;
          const fr = ch.finish_reason && ch.finish_reason !== 'null' ? ch.finish_reason : null;
          if (!Object.keys(delta).length && !fr) continue;
          if (Object.keys(delta).length) {
            const chunk = JSON.stringify({ id, object: 'chat.completion.chunk', created: parsed.created, model: EXTERNAL_MODEL, choices: [{ index: 0, delta, finish_reason: fr }] });
            res.write(`data: ${chunk}\n\n`); lastContentChunk = chunk;
          } else if (fr) {
            if (lastContentChunk) { const prev = JSON.parse(lastContentChunk); prev.choices[0].finish_reason = fr; res.write(`data: ${JSON.stringify(prev)}\n\n`); }
            else res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: parsed.created, model: EXTERNAL_MODEL, choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`);
          }
        } catch {}
      }
      return res.end();
    } catch (e) { recordUsage(modelKey, { error: true }); console.error(`[exc] model=${modelKey} ${e.stack || e.message}`); return json(res, 500, openaiErr(String(e.message || e), 'internal_error', 500)); }
  }
  json(res, 404, openaiErr('not found'));
});

// ---- 启动: 自动导入现有 CLI 凭证为首个账号 (迁移) ----
async function migrateFromCli() {
  if (ACCOUNTS.length) return;
  try {
    const mid = fs.readFileSync(path.join(HOME, '.qoder-cn', '.auth', 'machine_id'), 'utf8').trim();
    const enc = fs.readFileSync(path.join(HOME, '.qoder-cn', '.auth', 'user'), 'utf8');
    const creds = JSON.parse(glue.credential_storage_decrypt(enc, mid.slice(0, 16)));
    if (!creds.personal_access_token) { console.log('[migrate] no PAT in CLI creds, skip'); return; }
    const acc = { id: crypto.randomUUID(), alias: creds.name || '默认账号', pat: creds.personal_access_token, edition: 'cn', note: '从 CLI 凭证自动导入', createdAt: Date.now() };
    ACCOUNTS.push(acc); saveAccounts();
    STATE.activeAccount = acc.id; saveState();
    await ensureAccountToken(acc);
    console.log(`[migrate] imported CLI account "${acc.alias}" uid=${accountCaches[acc.id]?.uid}`);
  } catch (e) { console.log('[migrate] skipped:', e.message); }
}

// ---- token 定时续期 (每 10min 检查, 提前 5min 换) ----
setInterval(async () => {
  for (const acc of ACCOUNTS) {
    const c = accountCaches[acc.id];
    if (c && c.expiresAt - 300_000 < Date.now()) {
      try { await ensureAccountToken(acc, true); } catch (e) { console.error(`[renew] ${acc.alias}: ${e.message}`); }
    }
  }
}, 600_000);

(async () => {
  await migrateFromCli();
  if (STATE.activeAccount && !ACCOUNTS.find((a) => a.id === STATE.activeAccount)) STATE.activeAccount = ACCOUNTS[0]?.id || null;
  if (STATE.activeAccount) {
    const acc = activeAccount();
    try { await ensureAccountToken(acc); } catch (e) { console.error(`[startup] token failed for ${acc.alias}: ${e.message}`); }
    const cat = loadCatalog();
    if (cat.models.length && (!cat.byKey[STATE.activeKey] || !cat.byKey[STATE.activeKey].enable)) {
      const cand = STATE.activeKeys?.[STATE.activeAccount];
      const next = cand && cat.byKey[cand]?.enable ? cand : cat.models.find((m) => m.enable)?.key;
      if (next) { STATE.activeKey = next; saveState(); }
    }
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[bridge] listening on 0.0.0.0:${PORT} (pat-pool, ${ACCOUNTS.length} accounts)`);
    console.log(`[bridge] edition=${currentEdition()} endpoint=${gwBase()} account=${activeAccount()?.alias || 'none'} uid=${activeCache()?.uid || 'none'}`);
    console.log(`[bridge] model=${EXTERNAL_MODEL} → ${STATE.activeKey} (UI: http://0.0.0.0:${PORT}/)`);
  });
})();
