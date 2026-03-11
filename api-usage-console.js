#!/usr/bin/env node
/**
 * OpenClaw API 调用监控控制台
 * 解析 session JSONL 日志，展示 API 调用情况
 * 
 * 使用: node api-usage-console.js
 * 访问: http://127.0.0.1:18790
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const os = require('os');
const http = require('http');
const { exec, execSync, spawn, spawnSync } = require('child_process');
const { promisify } = require('util');

const PORT = 18790;
// 数据目录：优先 OPENCLAW_STATE_DIR/OPENCLAW_HOME，否则使用脚本所在项目的根目录
const OPENCLAW_HOME = (() => {
  if (process.env.OPENCLAW_STATE_DIR) return path.resolve(process.env.OPENCLAW_STATE_DIR);
  if (process.env.OPENCLAW_HOME) return path.resolve(process.env.OPENCLAW_HOME);
  const scriptParent = path.resolve(__dirname, '..');
  const configPath = path.join(scriptParent, 'openclaw.json');
  if (fs.existsSync(configPath)) return scriptParent;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return path.join(home, '.openclaw');
  return scriptParent;
})();
const SESSIONS_DIR = path.join(OPENCLAW_HOME, 'agents', 'main', 'sessions');
const SESSIONS_JSON = path.join(OPENCLAW_HOME, 'agents', 'main', 'sessions', 'sessions.json');
const CRON_JOBS = path.join(OPENCLAW_HOME, 'cron', 'jobs.json');
const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const LOGS_DIR = path.join(OPENCLAW_HOME, 'logs');
const GATEWAY_LOG = path.join(LOGS_DIR, 'gateway.log');
const GATEWAY_ERR_LOG = path.join(LOGS_DIR, 'gateway.err.log');

// 网关端口，用于从 http://127.0.0.1:18789 获取 usage 数据（via openclaw gateway call）
function getGatewayPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const p = cfg?.gateway?.port;
    return typeof p === 'number' && p > 0 ? p : 18789;
  } catch (_) { return 18789; }
}
const GATEWAY_PORT = getGatewayPort();

// 工作空间路径，来自 openclaw.json agents.defaults.workspace
function getWorkspacePath() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const wp = cfg?.agents?.defaults?.workspace || cfg?.agents?.workspace;
    if (typeof wp === 'string' && wp && fs.existsSync(wp)) return wp;
  } catch (_) {}
  return null;
}

// 扫描工作空间，统计项目（目录）与 memory 目录
function loadProjectSummary() {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return { projects: [], projectCount: 0, memoryCount: 0, workspacePath: null };
  const skipNames = new Set(['.git', 'node_modules', '.openclaw', '__pycache__', '.venv', 'venv', '.cache']);
  let projects = [];
  let memoryCount = 0;
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (e.name === 'memory') {
          try {
            const memFiles = fs.readdirSync(path.join(workspacePath, 'memory'));
            memoryCount = memFiles.filter(f => !f.startsWith('.')).length;
          } catch (_) {}
          continue;
        }
        if (!skipNames.has(e.name)) projects.push(e.name);
      }
    }
    projects.sort();
  } catch (_) {}
  return { projects, projectCount: projects.length, memoryCount, workspacePath };
}

function getSystemInfo() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const memUsagePct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
  let disk = { total: 0, used: 0, free: 0, usagePct: 0, mount: '-' };
  try {
    const out = execSync('df -k . 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 2000 });
    const parts = out.trim().split(/\s+/);
    if (parts.length >= 4) {
      const totalK = parseInt(parts[1], 10) || 0;
      const usedK = parseInt(parts[2], 10) || 0;
      const availK = parseInt(parts[3], 10) || 0;
      disk = {
        total: totalK * 1024,
        used: usedK * 1024,
        free: availK * 1024,
        usagePct: totalK > 0 ? Math.round((usedK / totalK) * 100) : 0,
        mount: parts.length >= 6 ? parts[5] : '-'
      };
    }
  } catch (_) {}
  const ifaces = [];
  try {
    const nics = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(nics)) {
      if (!addrs || addrs.length === 0) continue;
      for (const a of addrs) {
        if (a.internal || a.family !== 'IPv4') continue;
        ifaces.push({ name, address: a.address, mac: a.mac || '-' });
        break;
      }
    }
  } catch (_) {}
  const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 0;
  const loadavg = typeof os.loadavg === 'function' ? os.loadavg() : [0, 0, 0];
  const cpus = typeof os.cpus === 'function' ? os.cpus() : [];
  const cpuModel = cpus && cpus[0] ? cpus[0].model : '';
  return {
    memory: { total: memTotal, free: memFree, used: memUsed, usagePct: memUsagePct },
    disk,
    network: { interfaces: ifaces },
    cpu: { count: cpuCount, loadavg, model: cpuModel },
    platform: os.platform(),
    hostname: os.hostname(),
    uptime: os.uptime(),
    nodeVersion: process.version,
    arch: process.arch
  };
}

// Pricing (USD per 1M tokens) — official docs
const MODEL_PRICING = {
  'openai/gpt-5.4': { inputCache: 0.25, inputMiss: 2.50, output: 15.00, name: 'GPT-5.4' },
  'openai/gpt-4o': { inputCache: 0.25, inputMiss: 2.50, output: 10.00, name: 'GPT-4o' },
  'openai/gpt-4o-mini': { inputCache: 0.025, inputMiss: 0.15, output: 0.60, name: 'GPT-4o Mini' },
  'deepseek/deepseek-chat': { inputCache: 0.07, inputMiss: 0.27, output: 1.10, name: 'DeepSeek Chat' },
  'deepseek/deepseek-reasoner': { inputCache: 0.14, inputMiss: 0.55, output: 2.19, name: 'DeepSeek Reasoner' },
  'google/gemini-2.5-flash': { inputCache: 0.01875, inputMiss: 0.075, output: 0.30, name: 'Gemini 2.5 Flash' },
  'google/gemini-2.5-pro': { inputCache: 0.125, inputMiss: 1.25, output: 5.00, name: 'Gemini 2.5 Pro' }
};

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const modelCfg = cfg?.agents?.defaults?.model;
    const primary = (typeof modelCfg === 'string' ? modelCfg : modelCfg?.primary) || null;
    const models = cfg?.agents?.defaults?.models ? Object.keys(cfg.agents.defaults.models) : [];
    return { primary, models };
  } catch (_) { return { primary: null, models: [] }; }
}

function calcCost(c) {
  if (c.cost > 0) return c.cost;
  const key = `${(c.provider || '').toLowerCase()}/${(c.model || '').toLowerCase()}`;
  const p = MODEL_PRICING[key];
  if (!p) return 0;
  const inputMiss = Math.max(0, (c.input || 0) - (c.cacheRead || 0));
  const cacheRead = c.cacheRead || 0;
  const output = c.output || 0;
  return (inputMiss * p.inputMiss + cacheRead * p.inputCache + output * p.output) / 1e6;
}

function parseSessionContent(content) {
  const lines = (content || '').split('\n').filter(Boolean);
  const calls = [];
  let userMessages = 0, toolCalls = 0, sessionId = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'session') sessionId = obj.id;

      if (obj.type === 'message') {
        const m = obj.message;
        if (m?.role === 'user') userMessages++;
        if (m?.role === 'toolResult') toolCalls++;
        if (m?.role === 'assistant') {
          const provider = m.provider, model = m.model;
          const usage = m.usage || {}, cost = usage.cost || {};
          if (m.content?.some(c => c.type === 'toolCall')) toolCalls += m.content.filter(c => c.type === 'toolCall').length;
          if (provider && model && provider !== 'openclaw') {
            calls.push({
              sessionId, timestamp: obj.timestamp || m.timestamp, provider, model,
              api: m.api || '-', input: usage.input || 0, output: usage.output || 0,
              cacheRead: usage.cacheRead || 0, cacheWrite: usage.cacheWrite || 0,
              totalTokens: usage.totalTokens || 0, cost: cost.total ?? 0,
              stopReason: m.stopReason, hasError: !!m.errorMessage
            });
          }
        }
      }
    } catch (_) {}
  }
  return { calls, userMessages, toolCalls };
}

function parseSessionFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseSessionContent(content);
}

const MAX_SESSION_FILES_READ = 80;

async function loadAllCallsAsync() {
  const calls = [];
  let userQuestions = 0, toolCallCount = 0;
  if (!fs.existsSync(SESSIONS_DIR)) return { calls, userQuestions, toolCallCount, sessionCount: 0 };

  const allFiles = fs.readdirSync(SESSIONS_DIR).filter(f =>
    (f.endsWith('.jsonl') || f.includes('.jsonl.reset.')) && f !== 'sessions.json' && !f.endsWith('.lock')
  );
  const sessionCount = allFiles.length;
  if (allFiles.length === 0) return { calls, userQuestions, toolCallCount, sessionCount };

  const toRead = allFiles.length <= MAX_SESSION_FILES_READ
    ? allFiles
    : allFiles
        .map(f => {
          try { return { f, m: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }; } catch { return { f, m: 0 }; }
        })
        .sort((a, b) => b.m - a.m)
        .slice(0, MAX_SESSION_FILES_READ)
        .map(x => x.f);

  const readPromises = toRead.map(f =>
    fsPromises.readFile(path.join(SESSIONS_DIR, f), 'utf8').then(
      content => parseSessionContent(content),
      () => ({ calls: [], userMessages: 0, toolCalls: 0 })
    )
  );
  const results = await Promise.all(readPromises);
  for (const r of results) {
    calls.push(...(r && r.calls) || []);
    userQuestions += (r && r.userMessages) || 0;
    toolCallCount += (r && r.toolCalls) || 0;
  }
  calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { calls, userQuestions, toolCallCount, sessionCount };
}

function loadAllCalls() {
  const calls = [];
  let userQuestions = 0, toolCallCount = 0;
  if (!fs.existsSync(SESSIONS_DIR)) return { calls, userQuestions, toolCallCount, sessionCount: 0 };

  const files = fs.readdirSync(SESSIONS_DIR).filter(f =>
    (f.endsWith('.jsonl') || f.includes('.jsonl.reset.')) && f !== 'sessions.json' && !f.endsWith('.lock')
  );
  for (const f of files) {
    try {
      const r = parseSessionFile(path.join(SESSIONS_DIR, f));
      calls.push(...r.calls);
      userQuestions += r.userMessages;
      toolCallCount += r.toolCalls;
    } catch (_) {}
  }
  calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { calls, userQuestions, toolCallCount, sessionCount: files.length };
}

function getSessionFileCount() {
  if (!fs.existsSync(SESSIONS_DIR)) return 0;
  return fs.readdirSync(SESSIONS_DIR).filter(f =>
    (f.endsWith('.jsonl') || f.includes('.jsonl.reset.')) && f !== 'sessions.json' && !f.endsWith('.lock')
  ).length;
}

function loadCronJobs() {
  try {
    const data = JSON.parse(fs.readFileSync(CRON_JOBS, 'utf8'));
    return data.jobs || [];
  } catch (_) { return []; }
}

const execAsync = promisify(exec);
const SKILLS_CACHE_TTL_MS = 60 * 1000;
let skillsCache = { data: null, ts: 0 };

function loadSkillsRaw() {
  const now = Date.now();
  if (skillsCache.data !== null && now - skillsCache.ts < SKILLS_CACHE_TTL_MS) {
    return Promise.resolve(skillsCache.data);
  }
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: CONFIG_PATH, OPENCLAW_HOME: OPENCLAW_HOME };
  const pathExtras = '/opt/homebrew/bin:/usr/local/bin';
  env.PATH = pathExtras + (env.PATH ? ':' + env.PATH : '');
  return execAsync('openclaw skills list --json', { encoding: 'utf8', timeout: 12000, cwd: OPENCLAW_HOME, env })
    .then(({ stdout }) => {
      const data = JSON.parse(stdout);
      const skills = data.skills || [];
      skillsCache = { data: skills, ts: Date.now() };
      return skills;
    });
}
function loadSkillsAsync() {
  return loadSkillsRaw().catch((err) => {
    console.error('[api-console] loadSkills failed:', err?.message || err);
    return [];
  });
}

function loadRunningTasksAsync() {
  return execAsync('openclaw status --json', { encoding: 'utf8', timeout: 2000 })
    .then(({ stdout }) => {
      const data = JSON.parse(stdout);
      const sessions = data.sessions?.recent || [];
      const queue = data.queuedSystemEvents || [];
      const rt = {
        sessions: sessions.map(s => ({
          key: s.key,
          sessionId: s.sessionId,
          channel: s.kind || s.channel || '-',
          age: s.age,
          model: s.model || '-',
          label: (s.flags && s.flags.find(f => f.startsWith('id:'))) ? s.key : (s.sessionId || s.key)
        })),
        queueCount: queue.length,
        gatewayReachable: data.gateway?.reachable === true
      };
      return enrichRunningSessions(rt);
    })
    .catch(() => ({ sessions: [], queueCount: 0, gatewayReachable: false }));
}

function enrichRunningSessions(rt) {
  const sessions = rt.sessions || [];
  if (sessions.length === 0) return rt;
  let sessionIndex = {};
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
    for (const [key, s] of Object.entries(data)) {
      if (s.sessionId) sessionIndex[s.sessionId] = { key, sessionFile: s.sessionFile, origin: s.origin };
    }
  } catch (_) {}
  for (const s of sessions) {
    const sid = s.sessionId || s.key;
    const meta = sessionIndex[sid];
    let project = '-';
    let progress = '-';
    if (meta && meta.sessionFile && fs.existsSync(meta.sessionFile)) {
      try {
        const lines = fs.readFileSync(meta.sessionFile, 'utf8').split('\n').filter(Boolean);
        let cwd = null;
        let lastProgress = null;
        for (let i = 0; i < lines.length; i++) {
          try {
            const obj = JSON.parse(lines[i]);
            if (obj.type === 'session' && obj.cwd) cwd = obj.cwd;
            if (obj.type === 'message' && obj.message) {
              const m = obj.message;
              if (m.role === 'toolResult') {
                const det = m.details || {};
                if (det.status === 'running') {
                  const name = det.name || m.toolName || '';
                  const tail = (det.tail || det.aggregated || '').replace(/\s+/g, ' ').trim().slice(0, 80);
                  lastProgress = name ? (tail ? name + ' · ' + tail : name) : tail || '运行中';
                } else {
                  lastProgress = (m.toolName || '') + (m.content?.[0]?.text ? ': ' + String(m.content[0].text).replace(/\s+/g, ' ').trim().slice(0, 60) : '');
                }
              } else if (m.role === 'assistant') {
                const tc = (m.content || []).find(c => c.type === 'toolCall');
                if (tc) lastProgress = '调用: ' + (tc.name || '');
              }
            }
          } catch (_) {}
        }
        if (cwd) project = path.basename(cwd);
        if (lastProgress) progress = lastProgress.length > 100 ? lastProgress.slice(0, 97) + '…' : lastProgress;
      } catch (_) {}
    }
    s.project = project;
    s.progress = progress;
  }
  return rt;
}

function maskOrigin(origin) {
  if (!origin || typeof origin !== 'string') return '-';
  const m = origin.match(/id:\s*(\d+)/i);
  return m ? 'id:' + m[1] : '-';
}

function loadActiveSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
    return Object.entries(data).filter(([k]) => !k.startsWith('_')).map(([key, s]) => {
      const raw = s.origin?.label || s.origin?.from || '-';
      return {
        key, channel: s.lastChannel || s.deliveryContext?.channel || '-',
        updatedAt: s.updatedAt, origin: maskOrigin(raw)
      };
    });
  } catch (_) { return []; }
}


function loadConversation(sessionIdOrFile) {
  if (!sessionIdOrFile) return { sessionId: null, messages: [] };
  let filePath;
  if (sessionIdOrFile.includes('/')) {
    filePath = sessionIdOrFile;
  } else {
    const candidates = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : [];
    const match = candidates.find(f => f === sessionIdOrFile + '.jsonl') || candidates.find(f => f.startsWith(sessionIdOrFile + '.jsonl.reset.'));
    if (match) filePath = path.join(SESSIONS_DIR, match);
  }
  if (!filePath || !fs.existsSync(filePath)) return { sessionId: sessionIdOrFile, messages: [] };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const messages = [];
  let sessionId = sessionIdOrFile;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'session') sessionId = obj.id;
      if (obj.type !== 'message') continue;
      const m = obj.message;
      const ts = obj.timestamp || m?.timestamp;
      const role = m?.role;
      if (role === 'user') {
        const text = (m.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n');
        const clean = text.replace(/\n*Sender \(untrusted metadata\):[\s\S]*?```\s*\n?/g, '').replace(/\n*Conversation info \(untrusted metadata\):[\s\S]*?```\s*\n?/g, '').replace(/\[Queued messages[^]*?---\n/g, '').replace(/Queued #\d+\n/g, '').replace(/\n*---\nQueued #\d+\n/g, '').replace(/\[.*?\]\s*/g, '').trim();
        if (clean) messages.push({ role: 'user', timestamp: ts, text: clean.slice(0, 2000) });
      } else if (role === 'assistant') {
        const parts = (m.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('');
        const toolCalls = (m.content || []).filter(c => c.type === 'toolCall').length;
        const suffix = toolCalls > 0 ? ' [调用 ' + toolCalls + ' 个工具]' : '';
        const model = m.provider && m.model ? m.provider + '/' + m.model : '';
        if (parts || suffix) messages.push({ role: 'assistant', timestamp: ts, text: (parts || '(无文本)') + suffix, model });
      } else if (role === 'toolResult') {
        const brief = m.toolName ? '↳ ' + m.toolName + ': ' + ((m.content && m.content[0] && m.content[0].text) ? String(m.content[0].text).slice(0, 120).replace(/\s+/g, ' ') + (m.content[0].text.length > 120 ? '…' : '') : '') : '';
        if (brief) messages.push({ role: 'tool', timestamp: ts, text: brief, isError: m.isError });
      }
    } catch (_) {}
  }
  return { sessionId, messages };
}

function getCurrentSession() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
    const entries = Object.entries(data).filter(([k]) => !k.startsWith('_'));
    if (entries.length === 0) return null;
    const sorted = entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    const s = sorted[0][1];
    const sessionId = s.sessionId || (s.sessionFile ? path.basename(s.sessionFile).replace(/\.jsonl.*$/, '') : null);
    return { sessionId, sessionFile: s.sessionFile, key: sorted[0][0] };
  } catch (_) { return null; }
}

function abortSession(sessionId) {
  try {
    const cmd = sessionId
      ? `openclaw agent --session-id "${sessionId}" -m "/stop"`
      : 'openclaw agent -m "/stop"';
    execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.stderr) ? String(e.stderr).slice(0, 200) : (e?.message || 'abort failed') };
  }
}

/**
 * 单次 gateway call 的 Promise 包装（2.5s 超时，避免阻塞首屏）
 */
function gatewayCall(method, params) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.OPENCLAW_CONFIG_PATH = CONFIG_PATH;
    if (process.env.OPENCLAW_STATE_DIR) env.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
    const args = ['gateway', 'call', '--json', '--timeout', '2500', method, '--params', JSON.stringify(params)];
    const child = spawn('openclaw', args, { encoding: 'utf8', timeout: 3500, env });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse((stdout || '').trim() || '{}')); } catch (e) { resolve({}); }
      } else { reject(new Error('gateway ' + method + ' failed')); }
    });
    child.on('error', reject);
  });
}

/**
 * 从网关获取 usage 数据，usage.cost 与 sessions.usage 并行请求
 * @param {string} timeRange - 'today' | '7d' | 'all'
 * @returns {Promise<{ cost: object, sessions: object } | null>}
 */
function fetchUsageFromGateway(timeRange) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let startDate, endDate;
  if (timeRange === 'today') {
    startDate = endDate = today;
  } else if (timeRange === '7d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    startDate = d.toISOString().slice(0, 10);
    endDate = today;
  } else {
    const d = new Date(now);
    d.setDate(d.getDate() - 90);
    startDate = d.toISOString().slice(0, 10);
    endDate = today;
  }
  const costParams = { startDate, endDate };
  const sessParams = { startDate, endDate, limit: 1000, includeContextWeight: false };
  const timeoutMs = 3000;
  const timeout = () => new Promise((_, rej) => setTimeout(() => rej(new Error('gateway timeout')), timeoutMs));
  return Promise.race([
    Promise.all([
      gatewayCall('usage.cost', costParams),
      gatewayCall('sessions.usage', sessParams)
    ]).then(([cost, sessions]) => ({ cost, sessions })),
    timeout
  ]).catch(() => null);
}

/**
 * 将网关返回的 usage 数据转换为前端期望的 aggregated 格式
 * timeRange 用于按日期筛选：today=今日, 7d=近7天, all=全部
 */
function gatewayToAggregated(gw, timeRange) {
  const c = gw?.cost?.totals || {};
  const sessList = gw?.sessions?.sessions || [];
  const dailyCost = gw?.cost?.daily || [];
  const oneDay = 24 * 60 * 60 * 1000;
  const sevenDays = 7 * oneDay;
  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const inRange = (dateStr) => {
    if (!timeRange || timeRange === 'all') return true;
    if (timeRange === 'today') return dateStr === todayStr;
    if (timeRange === '7d') return (now - new Date(dateStr).getTime()) < sevenDays;
    return true;
  };
  const todayDaily = dailyCost.find(d => d.date === todayStr);
  let todayCalls = 0;
  for (const s of sessList) {
    for (const dm of (s.usage?.dailyMessageCounts || [])) {
      if (dm.date === todayStr) todayCalls += (dm.assistant || 0);
    }
  }
  if (todayCalls === 0 && todayDaily) todayCalls = Math.max(1, Math.round((todayDaily.input + todayDaily.output) / 1000));
  const todayCost = todayDaily?.totalCost ?? 0;
  const todayInput = todayDaily?.input ?? 0;
  const todayOutput = todayDaily?.output ?? 0;
  let weekCalls = 0, weekCost = 0;
  for (const d of dailyCost) {
    const dMs = new Date(d.date).getTime();
    if (now - dMs < sevenDays) {
      weekCalls += (d.input || 0) + (d.output || 0);
      weekCost += d.totalCost || 0;
    }
  }
  let totalInput = 0, totalOutput = 0, totalCost = 0, totalCacheRead = 0;
  if (timeRange === 'all' || dailyCost.length === 0) {
    totalInput = c.input ?? 0;
    totalOutput = c.output ?? 0;
    totalCacheRead = c.cacheRead ?? 0;
    totalCost = c.totalCost ?? 0;
  } else {
    for (const d of dailyCost) {
      if (!inRange(d.date)) continue;
      totalInput += d.input ?? 0;
      totalOutput += d.output ?? 0;
      totalCost += d.totalCost ?? 0;
      totalCacheRead += d.cacheRead ?? 0;
    }
  }
  const totalTokens = totalInput + totalOutput;
  const byProvider = {};
  const byModel = {};
  for (const s of sessList) {
    for (const du of (s.usage?.dailyModelUsage || [])) {
      const dateStr = du.date || du.day || s.startedAt?.slice?.(0, 10);
      if (dateStr && !inRange(dateStr)) continue;
      const pk = du.provider || 'unknown';
      const mk = `${pk}/${du.model || 'unknown'}`;
      const cnt = du.count || 0;
      const costVal = du.cost || 0;
      if (!byProvider[pk]) byProvider[pk] = { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
      byProvider[pk].calls += cnt;
      byProvider[pk].cost += costVal;
      if (!byModel[mk]) byModel[mk] = { provider: pk, model: du.model || 'unknown', calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
      byModel[mk].calls += cnt;
      byModel[mk].cost += costVal;
    }
  }
  if (Object.keys(byProvider).length === 0 && totalTokens > 0) {
    byProvider.unknown = { calls: 1, input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cost: totalCost };
    byModel['unknown/unknown'] = { provider: 'unknown', model: 'unknown', calls: 1, input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cost: totalCost };
  }
  const totalCalls = Object.values(byProvider).reduce((a, p) => a + (p.calls || 0), 0) || (totalTokens > 0 ? 1 : 0);
  const topModel = Object.entries(byModel).sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0))[0];
  const topProvider = Object.entries(byProvider).sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0))[0];
  let userQuestions = 0, toolCallCount = 0, errorCount = 0;
  for (const s of sessList) {
    for (const dm of (s.usage?.dailyMessageCounts || [])) {
      if (dm.date && !inRange(dm.date)) continue;
      userQuestions += dm.user || 0;
      toolCallCount += (dm.toolCalls || 0) + (dm.toolResults || 0);
      errorCount += dm.errors || 0;
    }
  }
  return {
    totalCalls, totalInput, totalOutput, totalCacheRead, totalCost,
    errorCount, errorRate: totalCalls > 0 ? (errorCount / totalCalls * 100) : 0,
    todayCalls, todayCost, todayInput, todayOutput, weekCalls, weekCost,
    totalTokens, cacheHitRate: totalInput > 0 ? (totalCacheRead / totalInput * 100) : 0,
    avgTokensPerCall: totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0,
    topModel: topModel ? topModel[0] : null, topProvider: topProvider ? topProvider[0] : null,
    byProvider, byModel,
    userQuestions, toolCallCount, sessionCount: sessList.length
  };
}

function aggregate(calls, timeRange) {
  const byProvider = {};
  const byModel = {};
  let totalCalls = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCost = 0;
  let errorCount = 0;
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const sevenDays = 7 * oneDay;
  let todayCalls = 0, todayCost = 0, todayInput = 0, todayOutput = 0;
  let weekCalls = 0, weekCost = 0;

  const filterByRange = (ts) => {
    if (!timeRange || timeRange === 'all') return true;
    const age = now - ts;
    if (timeRange === 'today') return age < oneDay;
    if (timeRange === '7d') return age < sevenDays;
    return true;
  };

  for (const c of calls) {
    const cost = c.cost > 0 ? c.cost : calcCost(c);
    const ts = new Date(c.timestamp).getTime();
    const inRange = filterByRange(ts);
    if (now - ts < oneDay) { todayCalls++; todayCost += cost; todayInput += c.input; todayOutput += c.output; }
    if (now - ts < sevenDays) { weekCalls++; weekCost += cost; }
    if (!inRange) continue;

    totalCalls++;
    totalInput += c.input;
    totalOutput += c.output;
    totalCacheRead += c.cacheRead;
    totalCost += cost;
    if (c.hasError) errorCount++;

    const pk = c.provider;
    if (!byProvider[pk]) byProvider[pk] = { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    byProvider[pk].calls++;
    byProvider[pk].input += c.input;
    byProvider[pk].output += c.output;
    byProvider[pk].cacheRead += c.cacheRead;
    byProvider[pk].cost += cost;

    const mk = `${c.provider}/${c.model}`;
    if (!byModel[mk]) byModel[mk] = { provider: c.provider, model: c.model, calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    byModel[mk].calls++;
    byModel[mk].input += c.input;
    byModel[mk].output += c.output;
    byModel[mk].cacheRead += c.cacheRead;
    byModel[mk].cost += cost;
  }

  const totalTokens = totalInput + totalOutput;
  const cacheHitRate = totalInput > 0 ? (totalCacheRead / totalInput * 100) : 0;
  const avgTokensPerCall = totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0;
  const errorRate = totalCalls > 0 ? (errorCount / totalCalls * 100) : 0;
  const topModel = Object.entries(byModel).sort((a, b) => b[1].calls - a[1].calls)[0];
  const topProvider = Object.entries(byProvider).sort((a, b) => b[1].calls - a[1].calls)[0];

  return {
    totalCalls, totalInput, totalOutput, totalCacheRead, totalCost,
    errorCount, errorRate, todayCalls, todayCost, todayInput, todayOutput,
    weekCalls, weekCost,
    totalTokens, cacheHitRate, avgTokensPerCall,
    topModel: topModel ? topModel[0] : null, topProvider: topProvider ? topProvider[0] : null,
    byProvider, byModel
  };
}

const i18n = {
  zh: {
    title: 'OpenClaw控制台',
    sub: '数据来自网关 · 自动刷新 30s',
    navLabel1: '概览', navLabel2: '管理',
    overview: '数据概览', conversationNav: '当前对话', sessionsNav: '会话管理', costsNav: '费用分析', cronNav: '定时任务', recentNav: '调用记录',
    tabToday: '今日', tab7d: '近7天', tabAll: '全部',
    alertCostHigh: '今日费用较高', alertErrors: '存在调用错误',
    questions: '提问次数', apiCalls: 'API 调用', toolCalls: '工具调用', sessions: '会话数', sessionCount: '会话数',
    inputTokens: '输入 Token', outputTokens: '输出 Token', cacheRead: '缓存读取', cost: '预估费用', costDist: '费用分布',
    todayCalls: '今日调用', todayCost: '今日费用', totalTokens: '总 Token',
    cacheHitRate: '缓存命中率', avgPerCall: '均次 Token', errorCount: '错误次数', errorRate: '错误率',
    topModel: '最常用模型', topProvider: '主 Provider',
    currentModels: '当前模型与定价',
    primaryModel: '主模型',
    modelsInUse: '使用中的模型',
    pricingRef: '官方定价 (USD/百万Token)',
    inputCache: '输入(缓存命中)', inputMiss: '输入(缓存未命中)', outputPrice: '输出',
    cron: '运营任务 · Cron', cronId: '任务 ID', schedule: '调度', status: '状态',
    activeSessions: '活跃会话', session: '会话', channel: '渠道', source: '来源', updatedAt: '更新时间',
    providerStats: 'Provider 统计', modelStats: '模型统计', recentCalls: '最近调用',
    calls: '调用', input: '输入', output: '输出', cache: '缓存', time: '时间', model: '模型',
    noCron: '暂无定时任务', noSessions: '暂无活跃会话', noData: '暂无数据',
    disabled: '已禁用', active: '活跃', error: '错误', ok: 'OK', refresh: '刷新',
    lastUpdate: '上次更新',
    runningTasks: '运行中任务', abortBtn: '中止', noRunningTasks: '暂无运行中任务', queuePending: '待处理',
    queue: '排队', processingNow: '当前正在处理', projects: '项目情况', projectsSub: '{n} 个项目 · memory {m} 条', sysInfo: '系统信息', memory: '内存', disk: '硬盘', cpuLoad: 'CPU / 负载', cpuUsageInfo: 'CPU 使用率', runtimeInfo: '运行环境', uptime: '运行时长', hostInfo: '主机信息', sessionFilesInfo: '会话文件', activeSessionsInfo: '活跃会话', queueCronInfo: '队列 / Cron', dataStatusInfo: '数据状态', gatewayStatusInfo: '服务状态',
    used: '已用', rootPartition: '根分区', loading: '数据加载中', retry: '刷新重试', debug: '调试', logs: '日志',
    dataSource: '数据源', data: '数据', time: '时间', cost: '费用', status: '状态', action: '操作', duration: '运行时长',
    projectCol: '项目', progressCol: '进度',
    exportCsv: '导出 CSV', filterProvider: 'Provider', filterAll: '全部', filterErrorsOnly: '仅错误',
    pagePrev: '上一页', pageNext: '下一页', pageOf: '第', refreshInterval: '刷新间隔', intervalOff: '关闭', intervalLabel: '刷新',
    convUser: '用户', convAssistant: '助手', convTool: '工具', convNoMessages: '暂无对话记录',
    noRunningWithQueue: '暂无运行中任务 · 排队 {n} 个', update: '更新', connError: '无法连接服务器',
    backToHome: '← 返回首页',
    noDataHint: '未读取到数据。请确保控制台已启动', costHigh: '今日费用较高', retryLink: '刷新重试',
    fileProtocol: '请通过',
    noCacheReads: '暂无缓存读取', waitingForSysData: '等待系统数据', coresLabel: '核心数 ', noCpuInfo: '暂无 CPU 核心信息',
    waiting: '等待采集', cpuEstimateNote: '基于负载估算，暂无直接 CPU 百分比', localMode: '本机模式', usingLocalDataSource: '当前使用本地数据源',
    localRuntime: '本机运行环境', freshStart: '刚启动 / 未知', platformUnavailable: '平台信息不可用', none: '暂无', noWorkspacePath: '未发现工作区路径',
    idle: '空闲', runningSuffix: ' 个运行中', noRunningTasksNow: '当前没有运行中的任务', empty: '空', queueCron: '队列 / Cron',
    noQueueOrCron: '当前无排队和定时任务', noDataSourcePath: '数据源路径不可用', callsTodaySuffix: ' 次调用', memoryItemsSuffix: ' 条',
    errorRateLabel: '错误率', noCurrentErrors: '当前没有错误',     connErrorAccess: '请通过 <a href="http://127.0.0.1:18790" target="_blank">http://127.0.0.1:18790</a> 访问',
    startHint: ' · 启动: ', noDirectHtml: '（不要直接打开 HTML 文件）',
    logLastLines: '最后 {n} 行', logEmpty: '(日志为空或文件不存在)', logShowing: '显示 ', logLines: ' 行', logFile: '文件 ', logUpdated: '更新 ', logRealtime: '实时',
    errorsAlert: '调用错误 {n} 次（{p}%）', viewErrorsOnly: '仅看错误',
    skills: '技能', skillName: '名称', skillDesc: '说明', skillEligible: '可用', skillNotEligible: '不可用', noSkills: '暂无技能',
    skillsMeta: '共 {n} 个技能 · {m} 个可用', processingRunningMeta: '{n} 个任务运行中', recentCallRecordsMeta: '共 {n} 条调用记录',
    dashboard: '仪表盘',
    heroKicker: '◉ 实时使用控制中心',
    heroTitle: '把 API 使用情况做成真正能看的控制台。',
    heroDesc: '一站式监控 API 用量、成本与系统健康。关键指标优先，优化支出，识别瓶颈。',
    heroTotalCost: '总费用',
    heroCalls: '调用量',
    heroTopModel: '主模型',
    heroDialogueChars: '对话字数',
    heroConsoleStatus: '控制台状态',
    heroSideDesc: '快速查看费用、项目数量和错误活跃度。',
    heroTodayCostLabel: '今日费用',
    heroProjectsLabel: '项目',
    heroErrorsLabel: '错误',
    onboardingWelcome: '欢迎使用 OpenClaw 控制台',
    onboardingWelcomeDesc: '一站式监控 API 用量、成本与系统健康',
    onboardingStep1: '仪表盘概览',
    onboardingStep1Desc: '顶部展示总费用、调用量和主模型；下方卡片提供详细数据。点击 ↻ 可手动刷新。',
    onboardingStep2: '时间范围',
    onboardingStep2Desc: '切换「全部」「近7天」「今日」可筛选不同时间段的统计数据。',
    onboardingStep3: '导航',
    onboardingStep3Desc: '技能 · 当前处理 · 最近调用 · 日志 — 快速切换不同功能页面。',
    onboardingStep4: '开始使用',
    onboardingStep4Desc: '数据每 30 秒自动刷新，右上角 EN 可切换英文。',
    onboardingSkip: '跳过',
    onboardingNext: '下一步',
    onboardingPrev: '上一步',
    onboardingStart: '开始使用'
  },
  en: {
    title: 'OpenClaw Console',
    sub: 'Data from gateway · Auto-refresh 30s',
    navLabel1: 'Overview', navLabel2: 'Manage',
    overview: 'Overview', conversationNav: 'Current Chat', sessionsNav: 'Sessions', costsNav: 'Costs', cronNav: 'Cron', recentNav: 'Recent',
    tabToday: 'Today', tab7d: '7 Days', tabAll: 'All',
    alertCostHigh: 'Daily cost is high', alertErrors: 'API call errors detected',
    questions: 'Questions', apiCalls: 'API Calls', toolCalls: 'Tool Calls', sessions: 'Sessions',
    inputTokens: 'Input Tokens', outputTokens: 'Output Tokens', cacheRead: 'Cache Read', cost: 'Est. Cost', costDist: 'Cost Distribution',
    todayCalls: 'Today Calls', todayCost: 'Today Cost', totalTokens: 'Total Tokens',
    cacheHitRate: 'Cache Hit %', avgPerCall: 'Avg/ Call', errorCount: 'Errors', errorRate: 'Error %',
    topModel: 'Top Model', topProvider: 'Top Provider',
    currentModels: 'Models & Pricing',
    primaryModel: 'Primary Model',
    modelsInUse: 'Models in Use',
    pricingRef: 'Official Pricing (USD per 1M tokens)',
    inputCache: 'Input (cache hit)', inputMiss: 'Input (cache miss)', outputPrice: 'Output',
    cron: 'Cron Jobs', cronId: 'Job ID', schedule: 'Schedule', status: 'Status',
    activeSessions: 'Active Sessions', session: 'Session', channel: 'Channel', source: 'Source', updatedAt: 'Updated',
    providerStats: 'By Provider', modelStats: 'By Model', recentCalls: 'Recent Calls',
    calls: 'Calls', input: 'Input', output: 'Output', cache: 'Cache', time: 'Time', model: 'Model',
    noCron: 'No cron jobs', noSessions: 'No active sessions', noData: 'No data',
    disabled: 'Disabled', active: 'Active', error: 'Error', ok: 'OK', refresh: 'Refresh',
    lastUpdate: 'Last update',
    runningTasks: 'Running Tasks', abortBtn: 'Abort', noRunningTasks: 'No running tasks', queuePending: 'Queued',
    queue: 'Queued', processingNow: 'Processing Now', projects: 'Projects', projectsSub: '{n} projects · memory {m} items', sysInfo: 'System Info', memory: 'Memory', disk: 'Disk', cpuLoad: 'CPU / Load', cpuUsageInfo: 'CPU Usage', runtimeInfo: 'Runtime', uptime: 'Uptime', hostInfo: 'Host', sessionFilesInfo: 'Session Files', activeSessionsInfo: 'Active Sessions', queueCronInfo: 'Queue / Cron', dataStatusInfo: 'Data Status', gatewayStatusInfo: 'Service Status',
    used: 'Used', rootPartition: 'Root', loading: 'Loading...', retry: 'Retry', debug: 'Debug', logs: 'Logs',
    dataSource: 'Data source', data: 'Data', time: 'Time', cost: 'Cost', status: 'Status', action: 'Action', duration: 'Duration',
    projectCol: 'Project', progressCol: 'Progress',
    exportCsv: 'Export CSV', filterProvider: 'Provider', filterAll: 'All', filterErrorsOnly: 'Errors only',
    pagePrev: 'Prev', pageNext: 'Next', pageOf: 'Page', refreshInterval: 'Refresh', intervalOff: 'Off', intervalLabel: 'Refresh',
    convUser: 'User', convAssistant: 'Assistant', convTool: 'Tool', convNoMessages: 'No messages',
    noRunningWithQueue: 'No running tasks · {n} queued', update: 'Updated', connError: 'Cannot connect to server',
    backToHome: '← Back to Home',
    noDataHint: 'No data. Ensure console is running', costHigh: 'Daily cost is high', retryLink: 'Retry',
    fileProtocol: 'Please access via',
    noCacheReads: 'No cache reads yet', waitingForSysData: 'Waiting for system data', coresLabel: 'Cores ', noCpuInfo: 'No CPU core info',
    waiting: 'Waiting', cpuEstimateNote: 'Estimated from load, no direct CPU % yet', localMode: 'Local mode', usingLocalDataSource: 'Using local data source',
    localRuntime: 'Local runtime', freshStart: 'Fresh start / unknown', platformUnavailable: 'Platform unavailable', none: 'None', noWorkspacePath: 'No workspace path',
    idle: 'Idle', runningSuffix: ' running', noRunningTasksNow: 'No running tasks right now', empty: 'Empty', queueCron: 'Queue / Cron',
    noQueueOrCron: 'No queued or cron tasks', noDataSourcePath: 'No data source path', callsTodaySuffix: ' calls today', memoryItemsSuffix: ' items',
    errorRateLabel: 'error rate', noCurrentErrors: 'No current errors',     connErrorAccess: 'Access <a href="http://127.0.0.1:18790" target="_blank">http://127.0.0.1:18790</a>',
    startHint: ' · Start: ', noDirectHtml: '(do not open HTML file directly)',
    logLastLines: 'Last {n} lines', logEmpty: '(Log is empty or file not found)', logShowing: 'Showing ', logLines: ' lines', logFile: 'File ', logUpdated: 'Updated ', logRealtime: 'Live',
    errorsAlert: '{n} errors ({p}%)', viewErrorsOnly: 'View errors only',
    skills: 'Skills', skillName: 'Name', skillDesc: 'Description', skillEligible: 'Ready', skillNotEligible: 'Not ready', noSkills: 'No skills',
    skillsMeta: '{n} skills · {m} ready', processingRunningMeta: '{n} running tasks', recentCallRecordsMeta: '{n} call records',
    dashboard: 'Dashboard',
    heroKicker: '◉ Live Usage Command Center',
    heroTitle: 'A usage console that actually feels like a real dashboard.',
    heroDesc: 'Monitor API usage, costs, and system health in one dashboard. Prioritize key metrics, optimize spend, and identify bottlenecks.',
    heroTotalCost: 'Total Cost',
    heroCalls: 'Calls',
    heroTopModel: 'Top Model',
    heroDialogueChars: 'Dialogue Tokens',
    heroConsoleStatus: 'Console Status',
    heroSideDesc: 'Quick health view for cost, project footprint, and error activity.',
    heroTodayCostLabel: 'Today Cost',
    heroProjectsLabel: 'Projects',
    heroErrorsLabel: 'Errors',
    onboardingWelcome: 'Welcome to OpenClaw Console',
    onboardingWelcomeDesc: 'Monitor API usage, costs & system health in one place',
    onboardingStep1: 'Dashboard Overview',
    onboardingStep1Desc: 'Top hero shows total cost, calls & top model; cards below provide detailed metrics. Click ↻ to refresh manually.',
    onboardingStep2: 'Time Range',
    onboardingStep2Desc: 'Switch between All · 7 Days · Today to filter stats by period.',
    onboardingStep3: 'Navigation',
    onboardingStep3Desc: 'Skills · Processing · Recent Calls · Logs — switch between pages quickly.',
    onboardingStep4: 'Get Started',
    onboardingStep4Desc: 'Data auto-refreshes every 30s. Click EN to switch language.',
    onboardingSkip: 'Skip',
    onboardingNext: 'Next',
    onboardingPrev: 'Prev',
    onboardingStart: 'Get Started'
  }
};

const HTML = `<!DOCTYPE html>
<html lang="zh-CN" id="htmlRoot">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw</title>
  <link rel="preload" href="/api/usage?range=all" as="fetch" crossorigin>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Syne:wght@500;600;700;800&family=DM+Sans:wght@400;500;600&family=Outfit:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600&family=Nunito+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #1a0b2e;
      --bg-card: #ffffff;
      --glass: #f1f5f9;
      --glass-border: #e2e8f0;
      --glass-highlight: #f8fafc;
      --text: #0c1222;
      --text-secondary: #334155;
      --muted: #64748b;
      --accent: #7c3aed;
      --accent-2: #db2777;
      --accent-warm: #6d28d9;
      --accent-soft: #ede9fe;
      --accent-glow: #8b5cf6;
      --matrix-green: #059669;
      --green: #059669;
      --green-soft: #d1fae5;
      --red: #dc2626;
      --red-soft: #fee2e2;
      --orange: #ea580c;
      --border: #e2e8f0;
      --radius: 16px;
      --radius-sm: 10px;
      --panel: #ffffff;
      --panel-strong: #f8fafc;
      --shadow-lg: 0 25px 60px rgba(15,23,42,0.08);
      --shadow-md: 0 12px 40px rgba(15,23,42,0.06);
    }
    html {
      scroll-behavior: smooth;
      min-height: 100%;
      background: #1a0b2e;
      overscroll-behavior: none;
    }
    html:not(.page-ready) .app { opacity: 0; }
    html.page-ready .app { opacity: 1; transition: opacity 0.35s ease-out; }
    @keyframes bgFloat { 0%,100%{background-position:0% 0%, 100% 0%, 50% 100%} 50%{background-position:2% 2%, 98% 2%, 52% 98%} }
    @keyframes gridPulse { 0%,100%{ opacity: 0.5; } 50%{ opacity: 0.8; } }
    @keyframes scanMove { 0%{ transform: translateY(-100%); } 100%{ transform: translateY(100vh); } }
    @keyframes orbFloat1 { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(6%,-5%) scale(1.1)} 66%{transform:translate(-4%,4%) scale(0.95)} }
    @keyframes orbFloat2 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-7%,5%) scale(1.15)} }
    @keyframes orbFloat3 { 0%,100%{transform:translate(0,0) scale(1)} 40%{transform:translate(5%,6%) scale(0.92)} 80%{transform:translate(-5%,-3%) scale(1.05)} }
    @keyframes glowBreath { 0%,100%{ opacity: 0.4; filter: blur(100px); } 50%{ opacity: 0.7; filter: blur(120px); } }
    @keyframes lineFlow { 0%{ stroke-dashoffset: 0; } 100%{ stroke-dashoffset: -1000; } }
    @keyframes bodyGradientShift { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }
    body {
      min-height: 100vh;
      min-height: 100dvh;
      overflow-y: auto;
      overflow-x: hidden;
      background:
        linear-gradient(135deg, #0f0a1e 0%, #1a0b2e 12%, #2d1b4e 28%, #4a2c6a 42%, #6b3d8f 55%, #8b4fb8 68%, #a855f7 82%, #ec4899 92%, #f472b6 100%),
        linear-gradient(45deg, rgba(6,182,212,0.12) 0%, transparent 45%),
        linear-gradient(225deg, rgba(168,85,247,0.15) 0%, transparent 45%);
      background-size: 200% 200%, 100% 100%, 100% 100%;
      background-position: 0% 50%, 0 0, 0 0;
      animation: bodyGradientShift 28s ease-in-out infinite;
      background-attachment: fixed;
      background-color: #1a0b2e;
      color: var(--text); font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.5;
      position: relative;
    }
    body::before {
      content: '';
      position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background-image:
        radial-gradient(ellipse 120% 80% at 10% 20%, rgba(168, 85, 247, 0.3) 0%, transparent 45%),
        radial-gradient(ellipse 100% 100% at 90% 80%, rgba(236, 72, 153, 0.25) 0%, transparent 50%),
        radial-gradient(ellipse 80% 60% at 50% 50%, rgba(6, 182, 212, 0.12) 0%, transparent 55%),
        linear-gradient(rgba(168, 85, 247, 0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(168, 85, 247, 0.05) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 100% 100%, 40px 40px, 40px 40px;
      opacity: 0.95;
    }
    body::after {
      content: '';
      position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background: radial-gradient(ellipse 80% 50% at 90% 20%, rgba(251, 113, 133, 0.15) 0%, transparent 50%),
        radial-gradient(ellipse 60% 40% at 5% 90%, rgba(6, 182, 212, 0.1) 0%, transparent 50%);
      opacity: 1;
    }
    .bg-effects {
      position: fixed; inset: 0; pointer-events: none; z-index: 1; overflow: hidden;
    }
    .bg-effects .orb {
      position: absolute; border-radius: 50%; filter: blur(90px);
      animation-duration: 22s; animation-timing-function: ease-in-out; animation-iteration-count: infinite;
    }
    .bg-effects .orb-1 {
      width: 400px; height: 400px; left: 0; top: 5%;
      background: radial-gradient(circle, rgba(168, 85, 247, 0.4) 0%, rgba(139, 92, 246, 0.15) 45%, transparent 70%);
      animation: orbFloat1, glowBreath 10s ease-in-out infinite;
      opacity: 0.85;
    }
    .bg-effects .orb-2 {
      width: 360px; height: 360px; right: -5%; bottom: 10%;
      background: radial-gradient(circle, rgba(236, 72, 153, 0.35) 0%, rgba(251, 113, 133, 0.15) 45%, transparent 70%);
      animation: orbFloat2 24s ease-in-out infinite, glowBreath 12s ease-in-out infinite 2s;
      opacity: 0.8;
    }
    .bg-effects .orb-3 {
      width: 280px; height: 280px; left: 50%; top: 55%;
      background: radial-gradient(circle, rgba(168, 85, 247, 0.2) 0%, rgba(236, 72, 153, 0.08) 50%, transparent 70%);
      animation: orbFloat3 20s ease-in-out infinite, glowBreath 9s ease-in-out infinite 1s;
      opacity: 0.75;
    }
    .bg-effects .scanline {
      display: none;
    }
    @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
    @keyframes titleShine { 0%{background-position:200% 50%} 100%{background-position:-100% 50%} }
    @keyframes titleGlow { 0%,100%{filter:drop-shadow(0 0 16px rgba(168,85,247,0.35))} 50%{filter:drop-shadow(0 0 24px rgba(236,72,153,0.4))} }
    @keyframes titleReveal { from{opacity:0;transform:translateY(-12px) scale(0.95)} to{opacity:1;transform:translateY(0) scale(1)} }
    @keyframes titleUnderline { 0%,100%{transform:scaleX(0.7);opacity:0.8} 50%{transform:scaleX(1);opacity:1} }
    @keyframes glowPulse { 0%,100%{opacity:0.7} 50%{opacity:1} }
    @keyframes fadeUp { from{opacity:0;transform:translateY(12px) translateZ(0)} to{opacity:1;transform:translateY(0) translateZ(0)} }
    .app {
      position: relative; z-index: 10000; max-width: 1680px; margin: 0 auto; padding: 36px 40px;
      border-radius: 20px; overflow: visible;
      transform: translateZ(0); -webkit-transform: translateZ(0);
      background: #ffffff;
      border: 1px solid var(--border);
      box-shadow: var(--shadow-lg);
    }
    .head {
      position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
      transform: translateZ(0); -webkit-transform: translateZ(0);
      max-width: 1680px; width: calc(100% - 48px); margin: 10px auto 0; box-sizing: border-box;
      display: grid; grid-template-columns: 220px 1fr 210px; gap: 16px; align-items: center;
      min-height: 72px; padding: 12px 20px 12px;
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow-md);
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    @media (max-width: 900px) { .head { grid-template-columns: minmax(0,1fr) minmax(0,1fr); } .head .head-actions { grid-column: 1 / -1; justify-self: start; } }
    .app { padding-top: 120px; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
      gap: 18px;
      margin: 6px 0 22px;
      align-items: stretch;
    }
    .hero-main, .hero-side {
      position: relative;
      overflow: hidden;
      transform: translateZ(0); -webkit-transform: translateZ(0);
      border-radius: 18px;
      border: 1px solid var(--border);
      background: #f8fafc;
    }
    .hero-main { padding: 20px 22px 18px; }
    .hero-side { padding: 18px 20px 16px; display: flex; flex-direction: column; justify-content: space-between; }
    .hero-side::after {
      content: '';
      position: absolute;
      inset: auto -20% -35% auto;
      width: 180px;
      height: 180px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(168, 85, 247, 0.15), transparent 68%);
      filter: blur(12px);
      pointer-events: none;
      opacity: 0.9;
    }
    .hero-main::before, .hero-side::before {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(110deg, transparent 20%, rgba(255,255,255,0.05) 48%, transparent 65%);
      background-size: 220% 100%;
      animation: shimmer 8s linear infinite;
      opacity: 0.5;
    }
    .hero-kicker, .hero-title, .hero-desc {
      transform: translateZ(0); -webkit-transform: translateZ(0);
    }
    .hero-kicker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 11px;
      margin-bottom: 12px;
      border-radius: 999px;
      border: 1px solid var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 500;
    }
    .hero-title {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 22px;
      line-height: 1.25;
      letter-spacing: 0.01em;
      margin-bottom: 10px;
      color: var(--text);
      text-shadow: 0 1px 2px rgba(0,0,0,0.04);
      font-weight: 600;
    }
    .hero-desc {
      max-width: 680px;
      color: var(--text);
      font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      line-height: 1.65;
      font-weight: 400;
      letter-spacing: 0.02em;
    }
    .hero-metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-top: 20px;
    }
    .hero-metric {
      position: relative;
      padding: 16px 18px 14px;
      border-radius: 16px;
      transform: translateZ(0); -webkit-transform: translateZ(0);
      background: rgba(255,255,255,0.9);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(124,58,237,0.12);
      box-shadow: 0 2px 12px rgba(15,23,42,0.04);
      transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
      overflow: hidden;
    }
    .hero-metric::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: linear-gradient(180deg, var(--accent), var(--accent-2));
      border-radius: 16px 0 0 16px;
      opacity: 0.6;
    }
    .hero-metric:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(124,58,237,0.08);
      border-color: rgba(124,58,237,0.2);
    }
    .hero-metric:first-child::before { opacity: 0.9; }
    .hero-metric .metric-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin-bottom: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
    }
    .hero-metric .metric-value {
      font-size: 19px;
      font-weight: 700;
      color: var(--text);
      line-height: 1.25;
      transition: opacity 0.2s ease;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .hero-side-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
    .hero-side-title { font-size: 12px; letter-spacing: 0.16em; color: var(--text-secondary); text-transform: uppercase; }
    .hero-side-desc { margin-top: 8px; font-size: 13px; line-height: 1.55; color: var(--text-secondary); max-width: 280px; }
    .hero-status {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: 999px;
      transform: translateZ(0); -webkit-transform: translateZ(0);
      background: var(--green-soft);
      color: var(--green);
      border: 1px solid var(--green);
      font-size: 12px; font-weight: 700;
    }
    .hero-status::before {
      content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor;
      box-shadow: 0 0 12px currentColor;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .hero-pill.wide { grid-column: 1 / -1; }
    .hero-pill {
      min-width: 0;
      padding: 13px 14px;
      border-radius: 16px;
      transform: translateZ(0); -webkit-transform: translateZ(0);
      background: #ffffff;
      border: 1px solid var(--border);
    }
    .hero-pill .pill-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; margin-bottom: 6px; }
    .hero-pill .pill-value { font-size: 17px; color: var(--text); font-weight: 700; transition: opacity 0.2s ease; }
    .hero-pill .pill-sub { margin-top: 6px; font-size: 12px; color: var(--muted); line-height: 1.45; transition: opacity 0.2s ease; }
    @media (max-width: 1040px) {
      .hero { grid-template-columns: 1fr; }
      .hero-metrics { grid-template-columns: 1fr; }
    }
    .global-nav { flex-shrink: 0; justify-self: start; margin: 8px 0 0 24px; }
    .head-actions { justify-self: end; }
    .head h1 {
      font-size: 28px; font-weight: 700; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.25; letter-spacing: 0.05em;
      background: linear-gradient(120deg, #a855f7 0%, #8b4fb8 40%, #ec4899 70%, #a855f7 100%); background-size: 200% 100%;
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
      position: relative; display: inline-block; padding-bottom: 4px;
      animation: titleReveal 0.7s cubic-bezier(0.22,1,0.36,1) backwards, titleShine 4s ease-in-out 0.7s infinite, titleGlow 2.2s ease-in-out 0.7s infinite;
    }
    .head h1::after {
      content: ''; position: absolute; left: 0; right: 0; bottom: -6px; height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent-2), var(--accent), var(--accent-2), transparent);
      animation: titleUnderline 3.5s ease-in-out 0.9s infinite;
    }
    .head-sub { font-size: 11px; color: var(--text-secondary); margin-top: 5px; font-weight: 400; }
    .head-actions { display: flex; align-items: center; gap: 10px; }
    .tabs { display: flex; background: var(--glass); padding: 4px; border-radius: 999px; border: 1px solid var(--border); min-width: fit-content; }
    .tabs button {
      padding: 8px 20px;
      border: none;
      background: none;
      color: var(--muted);
      border-radius: 999px;
      min-width: 72px;
      white-space: nowrap;
      cursor: pointer;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 500;
      line-height: 1.2;
      min-width: 0;
      transition: all 0.18s;
    }
    .tabs button:hover { color: var(--text); background: rgba(255, 255, 255, 0.8); }
    .tabs button.active { background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent); }
    .btn-icon {
      width: 38px; height: 38px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--panel-strong); color: var(--accent); cursor: pointer; font-size: 20px;
      display: flex; align-items: center; justify-content: center; transition: all 0.3s cubic-bezier(0.22,1,0.36,1);
    }
    .btn-icon:hover { background: var(--accent-soft); border-color: var(--accent); transform: scale(1.05); }
    .lang-btn { padding: 7px 12px; border: 1px solid var(--border); background: var(--panel-strong); color: var(--text); border-radius: 10px; font-size: 11px; font-weight: 500; cursor: pointer; font-family: 'Inter', -apple-system, BlinkMacSystemFont, monospace; transition: all 0.2s; }
    .lang-btn:hover { color: var(--accent); border-color: var(--accent); }
    .btn-icon.spin { animation: spin 0.5s ease; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .alerts { margin-bottom: 24px; margin-top: 8px; position: relative; z-index: 10; scroll-margin-top: 100px; min-height: 0; transition: min-height 0.3s ease, opacity 0.3s ease; }
    .alerts.dismissing { opacity: 0; min-height: 0; margin-bottom: 0; margin-top: 0; overflow: hidden; pointer-events: none; }
    .alert-loading { background: var(--accent-soft) !important; border-color: var(--accent) !important; animation: loadingPulse 1.2s ease-in-out infinite; }
    @keyframes loadingPulse { 0%,100%{ opacity: 0.7; } 50%{ opacity: 1; } }
    .alert {
      position: relative; overflow: hidden;
      transform: translateZ(0); -webkit-transform: translateZ(0);
      padding: 16px 24px; border-radius: 12px; font-size: 13px; font-family: 'JetBrains Mono', monospace;
      border: 1px solid var(--border);
      background: #ffffff;
      color: var(--text);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 4px 24px rgba(0,0,0,0.06);
      animation: alertFadeIn 0.4s ease-out;
    }
    @keyframes alertFadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
    .alert::before {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.04) 50%, transparent 60%);
      background-size: 200% 100%; animation: alertShimmer 3s ease-in-out infinite;
    }
    @keyframes alertShimmer { 0%,100%{ background-position: 200% 0 } 50%{ background-position: -100% 0 } }
    .alert.err {
      background: var(--red-soft);
      border-color: var(--red);
      color: var(--red);
    }
    .alert.warn {
      background: #fef3c7;
      border-color: #f59e0b;
      color: #b45309;
      animation: alertFadeIn 0.4s ease-out;
    }
    .alert a { color: inherit; text-decoration: underline; }
    .alert a:hover { opacity: 0.9; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 28px; }
    .cards .card:nth-child(1){animation-delay:0.01s} .cards .card:nth-child(2){animation-delay:0.03s} .cards .card:nth-child(3){animation-delay:0.05s} .cards .card:nth-child(4){animation-delay:0.07s} .cards .card:nth-child(5){animation-delay:0.09s} .cards .card:nth-child(6){animation-delay:0.11s} .cards .card:nth-child(7){animation-delay:0.13s} .cards .card:nth-child(8){animation-delay:0.15s} .cards .card:nth-child(9){animation-delay:0.17s} .cards .card:nth-child(10){animation-delay:0.19s} .cards .card:nth-child(11){animation-delay:0.21s} .cards .card:nth-child(12){animation-delay:0.23s}
    @media (max-width: 900px) { .cards { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 500px) { .cards { grid-template-columns: 1fr; } }
    .card {
      background: rgba(255,255,255,0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      animation: fadeUp 0.4s cubic-bezier(0.25,0.46,0.45,0.94) backwards;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px 22px;
      position: relative;
      overflow: hidden;
      cursor: pointer;
      user-select: none;
      transition: transform 0.4s cubic-bezier(0.22,1,0.36,1), box-shadow 0.4s, border-color 0.4s;
      box-shadow: 0 4px 24px rgba(15,23,42,0.06);
    }
    .card:hover { animation: none; }
    .card::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(120deg, transparent 15%, var(--accent-soft) 50%, transparent 85%); background-size: 200% 100%; background-position: 180% 0; opacity: 0; pointer-events: none; transition: opacity 0.3s; }
    .card:hover::after { opacity: 1; animation: cardShimmer 0.7s cubic-bezier(0.22,1,0.36,1) forwards; }
    @keyframes cardShimmer { to { background-position: -80% 0; } }
    .card::focus-visible { outline: none; }
    .card:active { transform: translateY(-2px); transition-duration: 0.1s; }
    .card.clicked { animation: cardClick 0.5s ease; }
    @keyframes cardClick { 0%{box-shadow:0 0 0 8px var(--accent-soft)} 100%{box-shadow:var(--shadow-lg)} }
    .card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: linear-gradient(180deg, transparent 0%, var(--accent) 30%, var(--accent-2) 70%, transparent 100%); border-radius: 20px 0 0 20px; opacity: 0.9; transform: scaleY(0.5); transform-origin: center; transition: transform 0.4s cubic-bezier(0.22,1,0.36,1), opacity 0.3s; }
    .card:hover::before { opacity: 1; transform: scaleY(1); }
    .card:hover { transform: translateY(-8px) scale(1.01); box-shadow: var(--shadow-lg); border-color: var(--accent); }
    .card.highlight::before { background: linear-gradient(180deg, #c4b5fd, var(--accent), var(--accent-2)); opacity: 1; }
    .card.highlight:hover { box-shadow: var(--shadow-lg); border-color: var(--accent); }
    .card.success::before { background: linear-gradient(180deg, #6ee7b7, var(--green)); }
    .card.success:hover { box-shadow: var(--shadow-lg); border-color: var(--green); }
    .card.danger::before { background: linear-gradient(180deg, #fda4af, var(--red)); }
    .card .label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.18em; font-weight: 700; margin-bottom: 14px; font-family: 'JetBrains Mono', monospace; position: relative; z-index: 2; }
    .card-sub { font-size: 12px; color: var(--muted); margin-top: 8px; position: relative; z-index: 2; transition: opacity 0.2s ease; }
    .card .val { font-family: 'Syne', 'JetBrains Mono', monospace; font-size: 28px; font-weight: 700; color: var(--text); letter-spacing: -0.03em; line-height: 1.08; transition: letter-spacing 0.3s, text-shadow 0.3s, opacity 0.2s ease; position: relative; z-index: 2; }
    .card:hover .val { letter-spacing: 0.02em; }
    .card.highlight .val { color: var(--accent); }
    .card.success .val { color: var(--green); }
    .card.danger .val { color: var(--red); }
    .section { margin-bottom: 28px; position: relative; scroll-margin-top: 20px; }
    .section-title {
      font-size: 12px; font-weight: 600; font-family: 'JetBrains Mono', monospace; color: var(--text);
      margin-bottom: 16px; letter-spacing: 0.15em; padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
      position: relative; transition: color 0.2s; padding-left: 12px; padding-right: 12px; margin-left: -12px; margin-right: -12px;
    }
    .section-title::before { content: '> '; color: var(--accent); font-family: 'JetBrains Mono', monospace; margin-right: 8px; }
    .section-badge { display: inline-block; margin-left: 10px; padding: 4px 12px; border-radius: 4px; font-size: 10px; font-weight: 600; font-family: 'JetBrains Mono', monospace; background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent); }
    .empty-msg { display: none; padding: 32px 24px; text-align: left; font-size: 14px; color: var(--text-secondary); background: var(--panel-strong); border: 1px dashed var(--accent); border-radius: var(--radius); margin-top: 12px; }
    .running-empty-hint { margin-bottom: 12px; font-weight: 500; color: var(--text); }
    .running-empty-projects { font-size: 12px; color: var(--muted); }
    .running-empty-row { margin-bottom: 6px; }
    .running-empty-path { font-family: 'JetBrains Mono', monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .running-empty-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .running-empty-tag { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-family: 'JetBrains Mono', monospace; background: var(--accent-soft); color: var(--accent); border: 1px solid var(--border); }
    .skills-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .skill-card {
      background: rgba(255,255,255,0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px 20px;
      font-size: 13px;
      transition: all 0.4s cubic-bezier(0.22,1,0.36,1);
      position: relative;
      overflow: hidden;
      box-shadow: var(--shadow-md);
    }
    .skill-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: linear-gradient(180deg, transparent, var(--accent), var(--accent-2), transparent); border-radius: 16px 0 0 16px; opacity: 0.9; transition: opacity 0.3s; }
    .skill-card:hover { transform: translateY(-8px) scale(1.01); border-color: var(--accent); box-shadow: var(--shadow-lg); }
    .skill-card:hover::before { opacity: 1; }
    .skill-card .skill-name { font-weight: 600; color: var(--text); margin-bottom: 6px; font-family: 'JetBrains Mono', monospace; }
    .skill-card .skill-desc { color: var(--muted); font-size: 12px; line-height: 1.4; }
    .skill-card .skill-meta { margin-top: 8px; font-size: 11px; }
    .skill-card .skill-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
    .skill-card .skill-badge.eligible { background: var(--green-soft); color: var(--green); }
    .skill-card .skill-badge.not-eligible { background: var(--red-soft); color: var(--red); }
    .sys-info-section .section-header { display: flex; align-items: center; cursor: pointer; user-select: none; transition: color 0.2s, box-shadow 0.2s; padding: 4px 0; margin: 0 -4px; border-radius: var(--radius-sm); }
    .sys-info-section .section-header::before { display: none; }
    .sys-info-section .section-header:hover { color: var(--accent); }
    .sys-info-section .section-header .collapse-chevron { margin-right: 8px; transition: transform 0.3s ease; font-size: 12px; opacity: 0.8; }
    .sys-info-section.collapsed .section-header .collapse-chevron { transform: rotate(-90deg); }
    .sys-info-section .sys-info-grid { transform: translateZ(0); -webkit-transform: translateZ(0); display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; max-height: 1200px; overflow: hidden; margin-top: 18px; transition: max-height 0.35s ease, opacity 0.25s ease, margin-top 0.3s ease; padding: 20px; border-radius: 24px; background: var(--panel-strong); border: 1px solid var(--border); box-shadow: var(--shadow-md); }
    .sys-info-section.collapsed .sys-info-grid { max-height: 0; opacity: 0; margin-top: -12px; pointer-events: none; }
    @media (max-width: 800px) { .sys-info-section .sys-info-grid { grid-template-columns: repeat(2, 1fr); } }
    .sys-card {
      background: rgba(255,255,255,0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transform: translateZ(0); -webkit-transform: translateZ(0);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 20px 22px;
      cursor: pointer;
      transition: all 0.4s cubic-bezier(0.22,1,0.36,1);
      position: relative;
      overflow: hidden;
      box-shadow: var(--shadow-md);
    }
    .sys-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, transparent 0%, var(--accent) 20%, var(--accent-2) 80%, transparent 100%); opacity: 0.9; transition: opacity 0.3s; }
    .sys-card:hover { transform: translateY(-10px) scale(1.02); box-shadow: var(--shadow-lg); border-color: var(--accent); }
    .sys-card:hover::before { opacity: 1; }
    .sys-card:active { transform: translateY(-2px) scale(0.98); }
    .sys-card .sys-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 8px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, monospace; }
    .sys-card .sys-val { font-family: 'Inter', -apple-system, BlinkMacSystemFont, monospace; font-size: 15px; font-weight: 600; color: var(--text); min-height: 20px; transition: opacity 0.2s ease; }
    .sys-card .sys-sub { font-size: 12px; color: var(--muted); margin-top: 4px; min-height: 18px; transition: opacity 0.2s ease; }
    .sys-card.is-empty { opacity: 0.92; border-color: var(--border); background: var(--panel-strong); }
    .sys-card.is-empty::before { opacity: 0.35; }
    .sys-card.is-empty .sys-val { color: var(--text-secondary); font-size: 13px; }
    .sys-card.is-empty .sys-sub { color: var(--muted); }
    .sys-card.is-good .sys-val { color: var(--green); }
    .sys-card.is-warn .sys-val { color: var(--orange); }
    .sys-card .sys-bar { height: 5px; background: var(--accent-soft); border-radius: 3px; margin-top: 12px; overflow: hidden; }
    .sys-card .sys-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--green)); border-radius: 3px; transition: width 0.4s cubic-bezier(0.22,1,0.36,1); }
    .sys-card .sys-bar-fill.warn { background: var(--orange); }
    .sys-card .sys-bar-fill.danger { background: var(--red); }
    .table-wrap {
      background: rgba(255,255,255,0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: var(--shadow-md);
      transition: all 0.4s cubic-bezier(0.22,1,0.36,1);
    }
    .table-wrap:hover { box-shadow: var(--shadow-lg); border-color: var(--accent); transform: translateY(-5px); }
    table { width: 100%; border-collapse: collapse; }
    th {
      padding: 14px 20px; text-align: left; font-size: 10px; font-weight: 600; color: var(--accent);
      background: var(--accent-soft);
      border-bottom: 1px solid var(--border); font-family: 'Inter', -apple-system, BlinkMacSystemFont, monospace;
      text-transform: uppercase; letter-spacing: 0.12em;
    }
    td { padding: 14px 20px; border-bottom: 1px solid var(--border); font-size: 13px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, monospace; color: var(--text); transition: background 0.2s, box-shadow 0.2s; }
    td.progress-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--accent-soft); }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 8px; font-size: 11px; font-weight: 600; }
    .badge.ok { background: var(--green-soft); color: var(--green); }
    .badge.err { background: var(--red-soft); color: var(--red); }
    .badge.info { background: var(--accent-soft); color: var(--accent); }
    .toolbar { display: flex; gap: 14px; margin-bottom: 14px; align-items: center; flex-wrap: wrap; }
    .toolbar select { padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: #ffffff; color: var(--text); font-size: 13px; font-family: inherit; }
    .toolbar .btn { padding: 10px 16px; border: 1px solid var(--border); background: #ffffff; color: var(--text); border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; font-family: inherit; font-weight: 500; transition: all 0.2s; }
    .toolbar .btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .abort-btn { color: var(--red) !important; border-color: var(--red) !important; }
    .abort-btn:hover { background: var(--red-soft) !important; border-color: var(--red) !important; color: var(--red) !important; }
    .footer {
      margin-top: 40px; padding-top: 20px; font-size: 12px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      border-top: 1px solid rgba(255, 255, 255, 0.35);
      box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.2);
    }
    .footer a { color: var(--text-secondary); text-decoration: none; transition: color 0.2s; }
    .footer a:hover { color: var(--accent); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 8px; vertical-align: middle; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.8;transform:scale(1.1)} }
    .global-nav { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; flex-shrink: 0; margin: 4px 0 0 12px; }
    .global-nav a {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 40px; padding: 0 16px; font-size: 13px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 600; line-height: 1; color: var(--text); text-decoration: none; border-radius: 10px;
      border: 1px solid var(--border); background: var(--glass);
      transition: color 0.2s, background 0.2s, box-shadow 0.2s, border-color 0.2s;
      min-width: 90px; box-sizing: border-box; white-space: nowrap;
    }
    .global-nav a span:first-child { opacity: 0.85; font-size: 11px; }
    .global-nav a:hover { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
    .global-nav a.active { color: var(--text); background: #ffffff; border-color: var(--accent); }
    .global-nav .nav-sep { width: 1px; height: 22px; background: var(--border); margin: 0 2px; flex-shrink: 0; }
    .guide-section { margin-bottom: 24px; padding: 20px 24px; border-radius: 16px; border: 1px solid var(--border); background: var(--panel-strong); }
    .guide-section.hidden { display: none; }
    .guide-section h3 { font-size: 15px; font-weight: 600; color: var(--text); margin: 0 0 14px; }
    .guide-section ul { margin: 0; padding: 0 0 0 20px; color: var(--text-secondary); font-size: 13px; line-height: 1.8; }
    .guide-section ul li { margin-bottom: 4px; }
    .guide-section .guide-dismiss { margin-top: 16px; padding: 8px 16px; font-size: 12px; font-weight: 500; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent); border-radius: 10px; cursor: pointer; transition: all 0.2s; }
    .guide-section .guide-dismiss:hover { background: #ddd6fe; }
  </style>
</head>
<body>
  <div class="bg-effects" aria-hidden="true">
    <span class="orb orb-1"></span>
    <span class="orb orb-2"></span>
    <span class="orb orb-3"></span>
    <span class="scanline"></span>
  </div>
  <div class="app">
    <header class="head">
      <div>
        <h1 data-i18n="title">OpenClaw</h1>
        <p class="head-sub"><span class="dot"></span><span data-i18n="sub">Data from gateway</span></p>
      </div>
      <nav class="global-nav" id="globalNav">
        <a href="/" class="active"><span>◉</span><span data-i18n="dashboard">仪表盘</span></a>
        <span class="nav-sep"></span>
        <a href="/skills"><span>◇</span><span data-i18n="skills">技能</span></a>
        <a href="/processing"><span>▶</span><span data-i18n="processingNow">当前正在处理</span></a>
        <a href="/recent"><span>◐</span><span data-i18n="recentCalls">最近调用</span></a>
        <span class="nav-sep"></span>
        <a href="/logs"><span>≡</span><span data-i18n="logs">日志</span></a>
      </nav>
      <div class="head-actions">
        <button type="button" id="langSwitcher" class="lang-btn" title="Switch language">EN</button>
        <div class="tabs" id="rangeTabs">
          <button type="button" class="range-btn active" data-range="all" data-i18n="tabAll">全部</button>
          <button type="button" class="range-btn" data-range="7d" data-i18n="tab7d">近7天</button>
          <button type="button" class="range-btn" data-range="today" data-i18n="tabToday">今日</button>
        </div>
        <button class="btn-icon" id="refresh" title="refresh">↻</button>
      </div>
    </header>
    <div class="alerts" id="alerts"></div>
    <section class="hero">
      <div class="hero-main">
        <div class="hero-kicker" data-i18n="heroKicker">◉ Live Usage Command Center</div>
        <div class="hero-title" data-i18n="heroTitle">把 API 使用情况做成真正能看的控制台。</div>
        <div class="hero-desc" data-i18n="heroDesc">一站式监控 API 用量、成本与系统健康。关键指标优先，优化支出，识别瓶颈。</div>
        <div class="hero-metrics">
          <div class="hero-metric">
            <div class="metric-label" data-i18n="heroTotalCost">Total Cost</div>
            <div class="metric-value" id="heroCost">—</div>
          </div>
          <div class="hero-metric">
            <div class="metric-label" data-i18n="heroCalls">Calls</div>
            <div class="metric-value" id="heroCalls">—</div>
          </div>
          <div class="hero-metric">
            <div class="metric-label" data-i18n="heroTopModel">Top Model</div>
            <div class="metric-value" id="heroModel">—</div>
          </div>
          <div class="hero-metric">
            <div class="metric-label" data-i18n="heroDialogueChars">Dialogue Tokens</div>
            <div class="metric-value" id="heroDialogueChars">—</div>
          </div>
        </div>
      </div>
      <aside class="hero-side">
        <div>
          <div class="hero-side-top">
            <div>
              <div class="hero-side-title" data-i18n="heroConsoleStatus">Console Status</div>
              <div class="hero-side-desc" data-i18n="heroSideDesc">Quick health view for cost, projects, and error activity.</div>
            </div>
            <div class="hero-status" id="heroStatus">LIVE</div>
          </div>
          <div class="hero-grid">
            <div class="hero-pill wide">
              <div class="pill-label" data-i18n="heroTodayCostLabel">Today Cost</div>
              <div class="pill-value" id="heroTodayCost">—</div>
              <div class="pill-sub" id="heroTodayMeta">—</div>
            </div>
            <div class="hero-pill">
              <div class="pill-label" data-i18n="heroProjectsLabel">Projects</div>
              <div class="pill-value" id="heroProjects">—</div>
              <div class="pill-sub" id="heroProjectsMeta">—</div>
            </div>
            <div class="hero-pill">
              <div class="pill-label" data-i18n="heroErrorsLabel">Errors</div>
              <div class="pill-value" id="heroErrors">—</div>
              <div class="pill-sub" id="heroErrorsMeta">—</div>
            </div>
          </div>
        </div>
      </aside>
    </section>
    <section id="guideSection" class="guide-section">
      <h3 data-i18n="onboardingWelcome">欢迎使用 OpenClaw 控制台</h3>
      <ul>
        <li data-i18n="onboardingStep1Desc">顶部展示总费用、调用量和主模型；下方卡片提供详细数据。点击 ↻ 可手动刷新。</li>
        <li data-i18n="onboardingStep2Desc">切换「全部」「近7天」「今日」可筛选不同时间段的统计数据。</li>
        <li data-i18n="onboardingStep3Desc">技能 · 当前处理 · 最近调用 · 日志 — 快速切换不同功能页面。</li>
        <li data-i18n="onboardingStep4Desc">数据每 30 秒自动刷新，右上角 EN 可切换英文。</li>
      </ul>
      <button type="button" class="guide-dismiss" id="guideDismiss" data-i18n="onboardingStart">开始使用</button>
    </section>
    <div class="cards">
      <div class="card highlight"><div class="label" data-i18n="apiCalls">API Calls</div><div class="val" id="totalCalls">0</div></div>
      <div class="card"><div class="label" data-i18n="questions">Questions</div><div class="val" id="userQuestions">0</div></div>
      <div class="card"><div class="label" data-i18n="toolCalls">Tool Calls</div><div class="val" id="toolCallCount">0</div></div>
      <div class="card"><div class="label" data-i18n="sessions">Sessions</div><div class="val" id="sessionCount">0</div></div>
      <div class="card"><div class="label" data-i18n="totalTokens">Total Tokens</div><div class="val" id="totalTokens">0</div></div>
      <div class="card success"><div class="label" data-i18n="cost">Cost</div><div class="val" id="totalCost">$0</div></div>
      <div class="card"><div class="label" data-i18n="todayCalls">Today</div><div class="val" id="todayCalls">0</div></div>
      <div class="card success"><div class="label" data-i18n="todayCost">Today Cost</div><div class="val" id="todayCost">$0</div></div>
      <div class="card" id="statError"><div class="label" data-i18n="error">Error</div><div class="val" id="errorCount">0</div></div>
      <div class="card highlight" id="statProjects"><div class="label" data-i18n="projects">项目情况</div><div class="val" id="projectCount">0</div><div class="card-sub" id="projectSub">—</div></div>
      <div class="card"><div class="label" data-i18n="topModel">Top Model</div><div class="val" id="topModel">—</div></div>
      <div class="card"><div class="label" data-i18n="cacheHitRate">缓存命中率</div><div class="val" id="cacheHitRateCard">—</div><div class="card-sub" id="cacheHitRateSub">—</div></div>
    </div>
    <section class="section sys-info-section" id="sysInfoSection">
      <div class="section-header section-title"><span class="collapse-chevron">▾</span><span class="section-header-text" data-i18n="sysInfo">System Info</span></div>
      <div class="sys-info-grid">
        <div class="sys-card">
          <div class="sys-label" data-i18n="memory">Memory</div>
          <div class="sys-val" id="memUsed">—</div>
          <div class="sys-sub" id="memTotal">—</div>
          <div class="sys-bar"><div class="sys-bar-fill" id="memBar" style="width:0%"></div></div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="disk">Disk</div>
          <div class="sys-val" id="diskUsed">—</div>
          <div class="sys-sub" id="diskTotal">—</div>
          <div class="sys-bar"><div class="sys-bar-fill" id="diskBar" style="width:0%"></div></div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="cpuLoad">CPU / Load</div>
          <div class="sys-val" id="cpuLoad">—</div>
          <div class="sys-sub" id="cpuMeta">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="runtimeInfo">Runtime</div>
          <div class="sys-val" id="runtimeMain">—</div>
          <div class="sys-sub" id="runtimeSub">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="uptime">Uptime</div>
          <div class="sys-val" id="sysUptime">—</div>
          <div class="sys-sub" id="sysPlatform">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="hostInfo">Host</div>
          <div class="sys-val" id="hostMain">—</div>
          <div class="sys-sub" id="hostSub">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="sessionFilesInfo">Session Files</div>
          <div class="sys-val" id="sessionFilesMain">—</div>
          <div class="sys-sub" id="sessionFilesSub">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="activeSessionsInfo">Active Sessions</div>
          <div class="sys-val" id="activeSessionsMain">—</div>
          <div class="sys-sub" id="activeSessionsSub">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="queueCronInfo">Queue / Cron</div>
          <div class="sys-val" id="queueCronMain">—</div>
          <div class="sys-sub" id="queueCronSub">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="dataStatusInfo">Data Status</div>
          <div class="sys-val" id="dataStatusMain">—</div>
          <div class="sys-sub" id="dataStatusSub">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="cpuUsageInfo">CPU Usage</div>
          <div class="sys-val" id="cpuUsageMain">—</div>
          <div class="sys-sub" id="cpuUsageSub">—</div>
        </div>
        <div class="sys-card">
          <div class="sys-label" data-i18n="gatewayStatusInfo">Service Status</div>
          <div class="sys-val" id="gatewayStatusMain">—</div>
          <div class="sys-sub" id="gatewayStatusSub">—</div>
        </div>
      </div>
    </section>
    <p class="footer" id="updated"></p>
  </div>
  <script>
    document.documentElement.classList.add('page-ready');
    window.__I18N__ = ${JSON.stringify(i18n)};
    let lang = localStorage.getItem('api-console-lang') || 'zh';
    function t(k) { const zh = window.__I18N__.zh; const en = window.__I18N__.en; if (lang === 'en') return (en && en[k]) || k; return (zh && zh[k]) || (en && en[k]) || k; }
    function applyI18n() {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const k = el.getAttribute('data-i18n');
        if (k) el.textContent = t(k);
      });
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      document.title = t('title');
      const refreshBtn = document.getElementById('refresh');
      if (refreshBtn) refreshBtn.setAttribute('title', t('refresh'));
      const langBtn = document.getElementById('langSwitcher');
      if (langBtn) langBtn.textContent = lang === 'zh' ? 'EN' : '中';
    }
    function refreshDynamicI18n(data) {
      if (!data) return;
      const ps = data.projectSummary || {};
      const subEl = document.getElementById('projectSub');
      if (subEl && ps.workspacePath) subEl.textContent = t('projectsSub').replace('{n}', ps.projectCount ?? 0).replace('{m}', ps.memoryCount ?? 0);
      const sys = data.systemInfo || {};
      const mem = sys.memory || {};
      const dsk = sys.disk || {};
      setText('memTotal', (mem.usagePct != null ? mem.usagePct + '% ' + t('used') : ''));
      setText('diskTotal', (dsk.usagePct != null ? dsk.usagePct + '% ' + t('used') + ' · ' : '') + (dsk.mount || t('rootPartition')));
      const cpu = sys.cpu || {};
      const loadavg = Array.isArray(cpu.loadavg) ? cpu.loadavg : [];
      setText('cpuLoad', loadavg.length ? loadavg.slice(0, 3).map(n => Number(n || 0).toFixed(2)).join(' / ') : '—');
      setText('cpuMeta', (cpu.count || 0) > 0 ? (t('coresLabel') + cpu.count + ' · ' + (sys.hostname || '—')) : (sys.hostname || '—'));
      setText('runtimeMain', (sys.nodeVersion || 'Node ?') + ' · ' + (sys.arch || '—'));
      setText('runtimeSub', 'OpenClaw · ' + (sys.platform ? (sys.platform === 'darwin' ? 'macOS' : sys.platform) : '—'));
      setText('sysUptime', fmtUptime(sys.uptime));
      setText('sysPlatform', sys.platform ? (sys.platform === 'darwin' ? 'macOS' : sys.platform) : '—');
    }
    let timeRange = localStorage.getItem('api-console-range') || 'all';
    let refreshInterval = 30, recentPage = 1, recentPageSize = 20, recentFilterProvider = '', recentFilterErrors = false;
    let _lastData = null, countdownTimer, _alertDismissTimer;
    document.getElementById('langSwitcher')?.addEventListener('click', () => {
      lang = lang === 'zh' ? 'en' : 'zh';
      localStorage.setItem('api-console-lang', lang);
      applyI18n();
      if (_lastData) {
        refreshDynamicI18n(_lastData);
        updateFooter();
      }
    });
    applyI18n();
    (function initGuide() {
      const KEY = 'openclaw-onboarding-seen';
      const section = document.getElementById('guideSection');
      const btn = document.getElementById('guideDismiss');
      if (!section) return;
      if (localStorage.getItem(KEY)) { section.classList.add('hidden'); return; }
      btn?.addEventListener('click', function() {
        section.classList.add('hidden');
        localStorage.setItem(KEY, '1');
      });
    })();
    (function initSysInfoCollapse() {
      const sec = document.getElementById('sysInfoSection');
      const stored = localStorage.getItem('api-console-sysinfo-collapsed');
      if (sec) {
        if (stored === '1') sec.classList.add('collapsed');
        sec.querySelector('.section-header')?.addEventListener('click', () => {
          sec.classList.toggle('collapsed');
          localStorage.setItem('api-console-sysinfo-collapsed', sec.classList.contains('collapsed') ? '1' : '0');
        });
      }
    })();
    document.querySelectorAll('.card, .sys-card').forEach(el => {
      el.addEventListener('click', function() {
        this.classList.add('clicked');
        setTimeout(() => this.classList.remove('clicked'), 300);
      });
    });
    document.querySelectorAll('.range-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.range === timeRange);
      btn.onclick = () => {
        timeRange = btn.dataset.range;
        localStorage.setItem('api-console-range', timeRange);
        document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === timeRange));
        load();
      };
    });
    function startCountdown() {
      clearInterval(countdownTimer);
      let c = refreshInterval;
      countdownTimer = setInterval(() => { c--; if (c <= 0) { load(); c = refreshInterval; } }, 1000);
    }

    function fmt(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n); }
    function fmtBytes(b) { if (!b || b <= 0) return '—'; const g = b / (1024**3); const m = b / (1024**2); return g >= 1 ? g.toFixed(1) + ' GB' : m.toFixed(0) + ' MB'; }
    function fmtUptime(s) { if (!s || s < 0) return '—'; const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60); return (d>0?d+'d ':'')+(h>0?h+'h ':'')+m+'m'; }
    function fmtCost(c) { return c > 0 ? '$'+c.toFixed(4) : '—'; }
    function fmtTime(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    function animValue(el, target) {
      if (!el) return;
      const current = parseInt(el.textContent) || 0;
      const t = parseInt(target);
      if (isNaN(t)) { el.textContent = target; return; }
      if (current === t) return;
      let step = Math.ceil((t - current) / 8);
      if (Math.abs(step) < 1) step = t > current ? 1 : -1;
      el.textContent = Math.min(Math.max(current + step, 0), t);
      if (current !== t) requestAnimationFrame(() => animValue(el, target));
    }
    function setText(id, val) {
      const el = document.getElementById(id);
      if (!el) return;
      const str = String(val);
      if (el.textContent === str) return;
      el.textContent = str;
    }
    function setSysCardState(id, state) {
      const el = document.getElementById(id);
      if (!el) return;
      const card = el.closest('.sys-card');
      if (!card) return;
      card.classList.remove('is-empty', 'is-good', 'is-warn');
      if (state) card.classList.add(state);
    }

    function renderRecentSection(recent) {
      let filtered = recent;
      if (recentFilterProvider) filtered = filtered.filter(c => c.provider === recentFilterProvider);
      if (recentFilterErrors) filtered = filtered.filter(c => c.hasError);
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / recentPageSize));
      if (recentPage > totalPages) recentPage = totalPages;
      const start = (recentPage - 1) * recentPageSize;
      const pageData = filtered.slice(start, start + recentPageSize);
      const rt = document.getElementById('recentTable');
      if (rt)       rt.innerHTML = pageData.map(c =>
        '<tr><td>'+fmtTime(c.timestamp)+'</td><td>'+c.provider+'</td><td>'+c.model+'</td><td>'+c.input+' / '+c.output+'</td><td>'+fmtCost(c.cost)+'</td><td>'+(c.hasError?'<span class="badge err">'+t('error')+'</span>':'<span class="badge ok">OK</span>')+'</td></tr>'
      ).join('') || '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--muted);">'+t('noData')+'</td></tr>';
      const pagEl = document.getElementById('recentPagination');
      if (pagEl) {
        pagEl.innerHTML = total > recentPageSize ? '<button id="pgPrev" '+(recentPage<=1?'disabled':'')+'>'+t('pagePrev')+'</button> <span>'+recentPage+' / '+totalPages+' ('+total+')</span> <button id="pgNext" '+(recentPage>=totalPages?'disabled':'')+'>'+t('pageNext')+'</button>' : '';
        pagEl.querySelector('#pgPrev')?.addEventListener('click', () => { recentPage--; renderRecentSection(recent); });
        pagEl.querySelector('#pgNext')?.addEventListener('click', () => { recentPage++; renderRecentSection(recent); });
      }
    }

    function exportRecentCsv() {
      if (!_lastData || !_lastData.recent) return;
      let rows = _lastData.recent;
      if (recentFilterProvider) rows = rows.filter(c => c.provider === recentFilterProvider);
      if (recentFilterErrors) rows = rows.filter(c => c.hasError);
      const headers = ['Time','Provider','Model','Input','Output','Cache','Cost','Error'];
      const lines = [headers.join(',')].concat(rows.map(c =>
        [fmtTime(c.timestamp), c.provider, c.model, c.input, c.output, c.cacheRead, c.cost, c.hasError?'Y':'N'].map(x => '"' + String(x).replace(/"/g,'""') + '"').join(',')
      ));
      const blob = new Blob([lines.join(String.fromCharCode(10))], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'openclaw-calls-' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    async function load() {
      const btn = document.getElementById('refresh');
      const alertsEl = document.getElementById('alerts');
      if (btn) { btn.classList.add('spin'); setTimeout(() => btn.classList.remove('spin'), 600); }
      startCountdown();
      if (!_lastData) alertsEl.innerHTML = '<div class="alert alert-loading">'+t('loading')+'</div>';
      try {
        const url = (window.location.origin || 'http://127.0.0.1:18790') + '/api/usage?range=' + (timeRange || 'all');
        const r = await fetch(url);
        if (!r.ok) throw new Error('API 返回 ' + r.status);
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) throw new Error('响应格式错误');
        const data = await r.json();
        if (!data || typeof data !== 'object') throw new Error('Invalid JSON');
        _lastData = data;
        const a = data.aggregated || {};
        const recent = data.recent || [];

        setText('totalCalls', a.totalCalls ?? 0);
        setText('heroCost', fmtCost(a.totalCost ?? 0));
        setText('heroCalls', fmt(a.totalCalls ?? 0));
        setText('heroModel', a.topModel ? a.topModel.replace(/^[^/]+\\//, '') : '—');
        setText('heroDialogueChars', fmt((a.totalTokens ?? (a.totalInput || 0) + (a.totalOutput || 0)) || 0));
        setText('userQuestions', a.userQuestions ?? 0);
        setText('toolCallCount', a.toolCallCount ?? 0);
        setText('sessionCount', a.sessionCount ?? 0);
        setText('totalTokens', fmt(a.totalTokens ?? (a.totalInput || 0) + (a.totalOutput || 0)));
        setText('totalCost', fmtCost(a.totalCost));
        setText('todayCalls', a.todayCalls ?? 0);
        setText('todayCost', fmtCost(a.todayCost ?? 0));
        setText('errorCount', a.errorCount ?? 0);
        const statErr = document.getElementById('statError');
        if (statErr) statErr.classList.toggle('danger', (a.errorCount ?? 0) > 0);
        setText('topModel', a.topModel ? a.topModel.replace(/^[^/]+\\//, '') : '—');
        setText('cacheHitRateCard', a.cacheHitRate != null ? ((a.cacheHitRate || 0).toFixed(1) + '%') : '—');
        setText('cacheHitRateSub', (a.totalCacheRead || 0) > 0 ? (fmt(a.totalCacheRead || 0) + ' cache read') : t('noCacheReads'));

        const sys = data.systemInfo || {};
        const mem = sys.memory || {};
        const dsk = sys.disk || {};
        const cpu = sys.cpu || {};
        setText('memUsed', fmtBytes(mem.used) + ' / ' + fmtBytes(mem.total));
        setText('memTotal', (mem.usagePct != null ? mem.usagePct + '% ' + t('used') : t('waitingForSysData')));
        setSysCardState('memUsed', mem.total > 0 ? (mem.usagePct >= 85 ? 'is-warn' : 'is-good') : 'is-empty');
        const memBar = document.getElementById('memBar');
        if (memBar) {
          const pct = mem.usagePct != null ? Math.min(100, mem.usagePct) : 0;
          memBar.style.width = pct + '%';
          memBar.className = 'sys-bar-fill' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
        }
        setText('diskUsed', fmtBytes(dsk.used) + ' / ' + fmtBytes(dsk.total));
        setText('diskTotal', (dsk.usagePct != null ? dsk.usagePct + '% ' + t('used') + ' · ' : '') + (dsk.mount || t('rootPartition')));
        setSysCardState('diskUsed', dsk.total > 0 ? (dsk.usagePct >= 85 ? 'is-warn' : 'is-good') : 'is-empty');
        const diskBar = document.getElementById('diskBar');
        if (diskBar) {
          const dpct = dsk.usagePct != null ? Math.min(100, dsk.usagePct) : 0;
          diskBar.style.width = dpct + '%';
          diskBar.className = 'sys-bar-fill' + (dpct >= 90 ? ' danger' : dpct >= 70 ? ' warn' : '');
        }
        const loadavg = Array.isArray(cpu.loadavg) ? cpu.loadavg : [];
        const loadText = loadavg.length ? loadavg.slice(0, 3).map(n => Number(n || 0).toFixed(2)).join(' / ') : '—';
        setText('cpuLoad', loadavg.length ? loadText : t('waiting'));
        setText('cpuMeta', (cpu.count || 0) > 0 ? (t('coresLabel') + cpu.count + ' · ' + (sys.hostname || '—')) : t('noCpuInfo'));
        setSysCardState('cpuLoad', loadavg.length ? ((Number(loadavg[0] || 0) >= Math.max(1, (cpu.count || 1) * 0.8)) ? 'is-warn' : 'is-good') : 'is-empty');
        const cpuPct = (cpu.count || 0) > 0 && loadavg.length ? Math.min(999, Math.round((Number(loadavg[0] || 0) / cpu.count) * 100)) : 0;
        setText('cpuUsageMain', cpuPct > 0 ? (cpuPct + '%') : t('waiting'));
        setText('cpuUsageSub', cpu.model || t('cpuEstimateNote'));
        setText('gatewayStatusMain', ((_lastData && _lastData.runningTasks && _lastData.runningTasks.gatewayReachable) ? 'ONLINE' : t('localMode')));
        setText('gatewayStatusSub', ((_lastData && _lastData.meta && _lastData.meta.gatewayUrl) || t('usingLocalDataSource')));
        setSysCardState('cpuUsageMain', cpuPct > 0 ? (cpuPct >= 80 ? 'is-warn' : 'is-good') : 'is-empty');
        setSysCardState('gatewayStatusMain', ((_lastData && _lastData.runningTasks && _lastData.runningTasks.gatewayReachable) ? 'is-good' : 'is-empty'));
        setText('runtimeMain', sys.nodeVersion ? ((sys.nodeVersion || 'Node ?') + ' · ' + (sys.arch || '—')) : t('localRuntime'));
        setText('runtimeSub', 'OpenClaw · ' + (sys.platform ? (sys.platform === 'darwin' ? 'macOS' : sys.platform) : '—'));
        setText('sysUptime', sys.uptime ? fmtUptime(sys.uptime) : t('freshStart'));
        setText('sysPlatform', sys.platform ? (sys.platform === 'darwin' ? 'macOS' : sys.platform) : t('platformUnavailable'));
        setSysCardState('runtimeMain', sys.nodeVersion ? 'is-good' : 'is-empty');
        setSysCardState('sysUptime', sys.uptime ? 'is-good' : 'is-empty');

        const ps = data.projectSummary || {};
        const projCount = ps.projectCount ?? 0;
        const memCount = ps.memoryCount ?? 0;
        setText('hostMain', sys.hostname || '—');
        setText('hostSub', (sys.platform ? (sys.platform === 'darwin' ? 'macOS' : sys.platform) : '—') + ' · ' + (sys.arch || '—'));
        const sessionFiles = (data.meta && data.meta.sessionFiles) || 0;
        const activeCount = (data.activeSessions || []).length;
        const runningCount = (data.runningTasks && data.runningTasks.sessions ? data.runningTasks.sessions.length : 0);
        const queueCount = (data.runningTasks && data.runningTasks.queueCount ? data.runningTasks.queueCount : 0);
        const cronCount = (data.cronJobs || []).length;
        const dataSource = ((data.meta && data.meta.dataSource) || 'local').toUpperCase();
        setText('sessionFilesMain', sessionFiles > 0 ? String(sessionFiles) : t('none'));
        setText('sessionFilesSub', ps.workspacePath || t('noWorkspacePath'));
        setText('activeSessionsMain', activeCount > 0 ? String(activeCount) : t('idle'));
        setText('activeSessionsSub', runningCount > 0 ? (runningCount + t('runningSuffix')) : t('noRunningTasksNow'));
        setText('queueCronMain', (queueCount || cronCount) ? (String(queueCount) + ' / ' + String(cronCount)) : t('empty'));
        setText('queueCronSub', (queueCount || cronCount) ? t('queueCron') : t('noQueueOrCron'));
        setText('dataStatusMain', dataSource || 'LOCAL');
        setText('dataStatusSub', (data.meta && data.meta.gatewayUrl) || ps.workspacePath || t('noDataSourcePath'));
        setSysCardState('sessionFilesMain', sessionFiles > 0 ? 'is-good' : 'is-empty');
        setSysCardState('activeSessionsMain', activeCount > 0 || runningCount > 0 ? 'is-good' : 'is-empty');
        setSysCardState('queueCronMain', queueCount > 0 || cronCount > 0 ? 'is-good' : 'is-empty');
        setSysCardState('dataStatusMain', dataSource === 'GATEWAY' ? 'is-good' : 'is-empty');
        setText('projectCount', projCount);
        setText('heroTodayCost', fmtCost(a.todayCost ?? 0));
        setText('heroTodayMeta', (a.todayCalls ?? 0) + t('callsTodaySuffix'));
        setText('heroProjects', String(projCount));
        setText('heroProjectsMeta', 'memory ' + memCount + t('memoryItemsSuffix'));
        setText('heroErrors', String(a.errorCount ?? 0));
        setText('heroErrorsMeta', (a.errorCount ?? 0) > 0 ? ((a.errorRate ?? 0).toFixed(1) + '% ' + t('errorRateLabel')) : t('noCurrentErrors'));
        setText('projectSub', ps.workspacePath ? t('projectsSub').replace('{n}', projCount).replace('{m}', memCount) : '—');
        const heroStatus = document.getElementById('heroStatus');
        if (heroStatus) {
          const hasErr = (a.errorCount ?? 0) > 0;
          heroStatus.textContent = hasErr ? 'ATTENTION' : 'LIVE';
          heroStatus.style.background = hasErr ? 'rgba(248,113,113,0.12)' : 'rgba(52,211,153,0.12)';
          heroStatus.style.color = hasErr ? 'var(--red)' : 'var(--green)';
          heroStatus.style.borderColor = hasErr ? 'rgba(248,113,113,0.24)' : 'rgba(52,211,153,0.24)';
        }
        const alerts = [];
        if (data.hint && data.hint.noData) {
          alerts.push({ type: 'err', msg: t('noDataHint') + ': cd ~/.openclaw && ./scripts/service.sh start' });
        }
        if ((a.todayCost || 0) > 1) alerts.push({ type: 'warn', msg: t('costHigh') + ' $' + (a.todayCost||0).toFixed(2) });
        const alertsContainer = document.getElementById('alerts');
        alertsContainer.innerHTML = alerts.map(al => '<div class="alert '+al.type+'">'+al.msg+'</div>').join('');
        clearTimeout(_alertDismissTimer);
        if (alerts.length > 0) {
          _alertDismissTimer = setTimeout(() => {
            alertsContainer.classList.add('dismissing');
            setTimeout(() => { alertsContainer.innerHTML = ''; alertsContainer.classList.remove('dismissing'); }, 300);
          }, 10000);
        }
      } catch (e) {
        console.error('load error:', e);
        const alertsEl = document.getElementById('alerts');
        let msg = (e.message || String(e));
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed') || msg.includes('fetch')) {
          msg = t('connError') + '. ' + t('connErrorAccess');
        }
        msg = msg + t('startHint') + 'cd ~/.openclaw && ./scripts/service.sh start';
        if (alertsEl) alertsEl.innerHTML = '<div class="alert err">' + msg + ' <a href="#" onclick="location.reload(); return false;" style="margin-left:8px;color:inherit;text-decoration:underline;">'+t('retryLink')+'</a></div>';
      }
      updateFooter();
    }
    function updateFooter() {
      const updatedEl = document.getElementById('updated');
      if (!updatedEl) return;
      const meta = (_lastData && _lastData.meta) || {};
      const dataDir = meta.dataDir || '';
      const sessionFiles = meta.sessionFiles ?? 0;
      const dataSource = meta.dataSource || 'local';
      const gatewayUrl = meta.gatewayUrl || '';
      const srcLabel = dataSource === 'gateway' && gatewayUrl
        ? t('dataSource') + ': <a href="' + gatewayUrl + '" target="_blank">' + gatewayUrl + '</a>'
        : (dataDir ? t('data') + ': ' + dataDir + ' (Session: ' + sessionFiles + ')' : '');
      updatedEl.innerHTML = t('update') + ' ' + new Date().toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') +
        (srcLabel ? ' · ' + srcLabel : '') +
        ' · <a href="/api/debug" target="_blank">' + t('debug') + '</a> · <a href="/logs">' + t('logs') + '</a>';
    }

    document.getElementById('refresh').onclick = load;
    if (window.location.protocol === 'file:') {
      document.getElementById('alerts').innerHTML = '<div class="alert err">'+t('fileProtocol')+' <a href="http://127.0.0.1:18790" target="_blank">http://127.0.0.1:18790</a> '+t('noDirectHtml')+'</div>';
    } else {
      load();
    }
  </script>
</body>
</html>`;

function buildSubPage(page) {
  const baseCss = `
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#1a0b2e;--accent:#7c3aed;--accent-2:#db2777;--accent-soft:#ede9fe;--text:#0c1222;--text-secondary:#334155;--muted:#64748b;--border:#e2e8f0;--green:#059669;--red:#dc2626}
    html{min-height:100%;background:#1a0b2e;overscroll-behavior:none}
    @keyframes gridPulse{0%,100%{opacity:0.5}50%{opacity:0.8}}
    @keyframes bodyGradientShift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
    body{min-height:100vh;overflow-x:hidden;overflow-y:auto;background:linear-gradient(135deg,#1a0b2e 0%,#2d1b4e 25%,#4a2c6a 50%,#8b4fb8 75%,#ec4899 100%);background-size:200% 200%;background-color:#1a0b2e;animation:bodyGradientShift 25s ease infinite;background-attachment:fixed;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;position:relative}
    body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;background-image:radial-gradient(circle at 20% 30%,rgba(168,85,247,0.2) 0%,transparent 50%),radial-gradient(circle at 80% 70%,rgba(236,72,153,0.15) 0%,transparent 50%),linear-gradient(rgba(168,85,247,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(168,85,247,0.04) 1px,transparent 1px);background-size:100% 100%,100% 100%,50px 50px,50px 50px;opacity:0.9}
    .sub-header{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:1000;max-width:1680px;width:calc(100% - 48px);margin:12px 0 0;box-sizing:border-box;display:grid;grid-template-columns:260px 1fr;gap:20px;align-items:center;min-height:84px;padding:14px 22px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,0.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 10px 28px rgba(15,23,42,0.08)}
    .sub-header .global-nav{justify-self:start;margin:8px 0 0 24px}
    .sub-header .brand{font-weight:600;font-size:18px;color:var(--accent);text-decoration:none;margin-right:8px}
    .sub-header .brand:hover{text-shadow:0 0 12px rgba(168,85,247,0.4)}
    .global-nav{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex-shrink:0;margin:4px 0 0 12px}
    .global-nav a{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;padding:0 16px;font-size:13px;font-weight:600;line-height:1;color:#0f172a;text-decoration:none;border-radius:10px;border:1px solid rgba(100,116,139,0.25);background:#f8fafc;transition:color 0.2s,background 0.2s,box-shadow 0.2s,border-color 0.2s;min-width:90px;white-space:nowrap;box-sizing:border-box}
    .global-nav a span:first-child{opacity:0.85;font-size:11px}
    .global-nav a:hover{color:#7c3aed;background:#f1f5f9;border-color:rgba(124,58,237,0.35);box-shadow:0 2px 8px rgba(124,58,237,0.12)}
    .global-nav a.active{color:#0f172a;background:#fff;border-color:rgba(124,58,237,0.4);box-shadow:0 2px 12px rgba(124,58,237,0.15)}
    .global-nav .nav-sep{width:1px;height:22px;background:rgba(148,163,184,0.35);margin:0 2px;flex-shrink:0}
    .sub-main{max-width:1680px;margin:0 auto;padding:140px 40px 40px;position:relative;z-index:1;min-height:200px}
    #content{min-height:120px}
    .sub-title{font-size:28px;font-weight:600;margin-bottom:8px;color:var(--accent);text-shadow:0 0 24px rgba(168,85,247,0.35);letter-spacing:0.05em;position:relative;padding-left:16px;border-left:4px solid var(--accent)}
    .sub-meta{font-size:13px;color:var(--muted);margin-bottom:24px;padding-left:20px}
  `;
  const skillCss = `
    .skill-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
    .skill-tile{background:linear-gradient(145deg,rgba(255,255,255,0.9) 0%,rgba(255,255,255,0.82) 100%);border:1px solid rgba(168,85,247,0.18);border-radius:16px;padding:22px;transition:all 0.4s cubic-bezier(0.22,1,0.36,1);position:relative;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,0.8),0 10px 36px rgba(107,61,143,0.1),0 0 0 1px rgba(168,85,247,0.06)}
    .skill-tile::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,transparent,var(--accent),var(--accent-2),transparent);border-radius:16px 0 0 16px;opacity:0.85;box-shadow:0 0 16px rgba(168,85,247,0.4)}
    .skill-tile:hover{transform:translateY(-8px) scale(1.01);box-shadow:inset 0 1px 0 rgba(255,255,255,0.95),0 20px 48px rgba(107,61,143,0.15),0 0 0 1px rgba(168,85,247,0.35),0 0 40px rgba(168,85,247,0.1);border-color:rgba(168,85,247,0.4)}
    .skill-tile .name{font-weight:600;font-size:15px;margin-bottom:8px;color:var(--text)}
    .skill-tile .desc{color:var(--muted);font-size:12px;line-height:1.5}
    .skill-tile .badge{display:inline-block;margin-top:10px;padding:4px 10px;border-radius:4px;font-size:10px}
    .skill-tile .badge.ok{background:rgba(52,211,153,0.2);color:var(--green)}
    .skill-tile .badge.no{background:rgba(248,113,113,0.2);color:var(--red)}
  `;
  const procCss = `
    .proc-table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:12px;overflow:hidden;border:1px solid var(--border);box-shadow:0 4px 20px rgba(15,23,42,0.06)}
    .proc-table th{background:rgba(168,85,247,0.08);padding:14px 20px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--accent)}
    .proc-table td{padding:14px 20px;border-bottom:1px solid rgba(168,85,247,0.08)}
    .proc-table tr:hover td{background:rgba(168,85,247,0.05)}
    .proc-empty{padding:60px 40px;text-align:center;color:var(--muted);border:2px dashed rgba(168,85,247,0.3);border-radius:8px;margin-top:20px}
    .proc-empty .hint{font-size:18px;margin-bottom:12px;color:var(--accent)}
    .abort-btn{padding:6px 12px;font-size:11px;background:transparent;border:1px solid var(--red);color:var(--red);border-radius:4px;cursor:pointer;transition:all 0.2s}
    .abort-btn:hover{background:rgba(248,113,113,0.2)}
    .proc-progress{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
  `;
  const recCss = `
    .rec-toolbar{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
    .rec-toolbar select,.rec-toolbar .btn{padding:10px 16px;border:1px solid var(--border);background:rgba(255,255,255,0.9);color:var(--text);border-radius:8px;font-size:13px}
    .rec-table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:12px;overflow:hidden;border:1px solid var(--border);box-shadow:0 4px 20px rgba(15,23,42,0.06)}
    .rec-table th{background:rgba(168,85,247,0.08);padding:14px 20px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--accent)}
    .rec-table td{padding:14px 20px;border-bottom:1px solid rgba(168,85,247,0.08)}
    .rec-table tr:hover td{background:rgba(168,85,247,0.05)}
    .rec-pag{margin-top:16px;font-size:12px;color:var(--muted)}
    .badge-ok{background:rgba(52,211,153,0.2);color:var(--green);padding:4px 8px;border-radius:4px;font-size:10px}
    .badge-err{background:rgba(248,113,113,0.2);color:var(--red);padding:4px 8px;border-radius:4px;font-size:10px}
  `;
  const css = baseCss + (page === 'skills' ? skillCss : page === 'processing' ? procCss : recCss);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaw</title><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"><style>${css}</style></head><body>
  <header class="sub-header">
    <a href="/" class="brand">OpenClaw</a>
    <nav class="global-nav">
      <a href="/" class="${page==='home'?'active':''}"><span>◉</span><span data-i18n="dashboard">仪表盘</span></a>
      <span class="nav-sep"></span>
      <a href="/skills" class="${page==='skills'?'active':''}"><span>◇</span><span data-i18n="skills">技能</span></a>
      <a href="/processing" class="${page==='processing'?'active':''}"><span>▶</span><span data-i18n="processingNow">当前正在处理</span></a>
      <a href="/recent" class="${page==='recent'?'active':''}"><span>◐</span><span data-i18n="recentCalls">最近调用</span></a>
      <span class="nav-sep"></span>
      <a href="/logs" class="${page==='logs'?'active':''}"><span>≡</span><span data-i18n="logs">日志</span></a>
    </nav>
  </header>
  <main class="sub-main">
    <h1 class="sub-title" id="subTitle"></h1>
    <div id="content">${page==='skills'||page==='processing'?'<p class="sub-meta" style="color:var(--muted)">加载中…</p>':''}</div>
  </main>
  <script>
    window.__I18N__ = ${JSON.stringify(i18n)};
    let lang = localStorage.getItem('api-console-lang') || 'zh';
    const pageKeyMap = { skills: 'skills', processing: 'processingNow', recent: 'recentCalls', logs: 'logs', home: 'dashboard' };
    function t(k){const zh=window.__I18N__.zh;const en=window.__I18N__.en;if(lang==='en')return (en&&en[k])||k;return (zh&&zh[k])||(en&&en[k])||k;}
    function applyI18n(){
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      document.querySelectorAll('[data-i18n]').forEach(el=>{ const k = el.getAttribute('data-i18n'); if(k) el.textContent = t(k); });
      const titleKey = pageKeyMap['${page}'] || 'dashboard';
      const titleText = t(titleKey);
      document.title = titleText + ' · OpenClaw';
      const subTitle = document.getElementById('subTitle');
      if (subTitle) subTitle.textContent = titleText;
    }
    function fmtTime(ts){if(!ts)return'—';return new Date(ts).toLocaleString(lang==='zh'?'zh-CN':'en-US',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
    function fmtCost(c){return c>0?'$'+c.toFixed(4):'—';}
    async function load(){
      try{
        const base=(location.origin||'http://127.0.0.1:18790');
        let data;
        if('${page}'==='skills'){
          const r=await fetch(base+'/api/skills');
          data=await r.json().catch(()=>({}));
          if(!r.ok) data={ skills:[], error:data?.error||'HTTP '+r.status };
        }else{
          const r=await fetch(base+'/api/usage?range=all');
          data=await r.json();
        }
        const el=document.getElementById('content');
        if(!el){return;}
        applyI18n();
        if('${page}'==='skills'){
          const list=Array.isArray(data?.skills)?data.skills:[];
          const okCount=list.filter(s=>s.eligible).length;
          const errMsg=data?.error?('<div class="proc-empty"><div class="hint">加载失败: '+String(data.error).replace(/</g,'&lt;')+'</div><div style="font-size:12px;margin-top:8px">请确认控制台已启动且 openclaw 在 PATH 中</div></div>'):'';
          el.innerHTML=list.length?'<p class="sub-meta">'+t('skillsMeta').replace('{n}',list.length).replace('{m}',okCount)+'</p><div class="skill-grid">'+list.map(s=>{
            const badge=s.eligible?'<span class="badge ok">'+t('skillEligible')+'</span>':'<span class="badge no">'+t('skillNotEligible')+'</span>';
            return '<div class="skill-tile"><div class="name">'+(s.emoji||'◆')+' '+(s.name||'-')+'</div><div class="desc">'+(s.description||'').slice(0,150)+'</div>'+badge+'</div>';
          }).join('')+'</div>':(errMsg||'<div class="proc-empty"><div class="hint">'+t('noSkills')+'</div></div>');
        }else if('${page}'==='processing'){
          const rt=data?.runningTasks||{},sessions=Array.isArray(rt.sessions)?rt.sessions:[],ps=data?.projectSummary||{};
          if(sessions.length){
            const esc=x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
            el.innerHTML='<p class="sub-meta">'+t('processingRunningMeta').replace('{n}',sessions.length)+'</p><table class="proc-table"><thead><tr><th>'+t('session')+'</th><th>'+t('projectCol')+'</th><th>'+t('progressCol')+'</th><th>'+t('channel')+'</th><th>'+t('model')+'</th><th>'+t('duration')+'</th><th>'+t('action')+'</th></tr></thead><tbody>'+sessions.map(s=>{
              const age=(s.age!=null?s.age+'s':'—'),proj=s.project||'—',prog=s.progress||'—';
              return '<tr data-session="'+encodeURIComponent(s.sessionId||s.key||'')+'"><td>'+esc(s.label)+'</td><td>'+esc(proj)+'</td><td class="proc-progress" title="'+esc(prog)+'">'+esc(prog)+'</td><td>'+esc(s.channel)+'</td><td>'+esc(s.model)+'</td><td>'+age+'</td><td><button class="abort-btn" data-session="'+encodeURIComponent(s.sessionId||s.key||'')+'">'+t('abortBtn')+'</button></td></tr>';
            }).join('')+'</tbody></table>';
            el.querySelectorAll('.abort-btn').forEach(btn=>{btn.onclick=()=>{fetch('/api/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:decodeURIComponent(btn.dataset.session)})}).then(()=>load());};});
          }else{
            const hint=rt.queueCount>0?t('noRunningWithQueue').replace('{n}',rt.queueCount):t('noRunningTasks');
            let html='<div class="proc-empty"><div class="hint">'+hint+'</div>';
            if(ps.workspacePath){html+='<div>'+t('projects')+': '+(ps.projectCount??0)+' · memory: '+(ps.memoryCount??0)+'</div><div style="font-size:11px;margin-top:8px">'+ps.workspacePath+'</div>';if((ps.projects||[]).length)html+='<div style="margin-top:10px">'+(ps.projects||[]).map(p=>'<span style="display:inline-block;margin:4px;padding:4px 10px;background:rgba(168,85,247,0.1);border-radius:6px">'+p+'</span>').join('')+'</div>';}
            html+='</div>';el.innerHTML=html;
          }
        }else{
          let recent=data.recent||[],fp='',fe=false,page=1,pageSize=20;
          const filter=()=>{let f=recent;if(fp)f=f.filter(c=>c.provider===fp);if(fe)f=f.filter(c=>c.hasError);return f;};
          function render(){const f=filter(),total=f.length,totalPages=Math.max(1,Math.ceil(total/pageSize)),start=(page-1)*pageSize,rows=f.slice(start,start+pageSize);
            const provs=['',...new Set(recent.map(c=>c.provider))].filter(Boolean).sort();
            el.innerHTML='<p class="sub-meta">'+t('recentCallRecordsMeta').replace('{n}',recent.length)+'</p><div class="rec-toolbar"><select id="fp">'+provs.map(p=>'<option value="'+p+'"'+(p===fp?' selected':'')+'>'+(p||t('filterAll'))+'</option>').join('')+'</select><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="fe" '+(fe?'checked':'')+'> '+t('filterErrorsOnly')+'</label><button class="btn" id="expBtn">'+t('exportCsv')+'</button></div><table class="rec-table"><thead><tr><th>'+t('time')+'</th><th>Provider</th><th>'+t('model')+'</th><th>In/Out</th><th>'+t('cost')+'</th><th>'+t('status')+'</th></tr></thead><tbody>'+rows.map(c=>'<tr><td>'+fmtTime(c.timestamp)+'</td><td>'+c.provider+'</td><td>'+c.model+'</td><td>'+c.input+' / '+c.output+'</td><td>'+fmtCost(c.cost)+'</td><td>'+(c.hasError?'<span class="badge-err">'+t('error')+'</span>':'<span class="badge-ok">OK</span>')+'</td></tr>').join('')+'</tbody></table>'+(total>pageSize?'<div class="rec-pag"><button id="pgPrev" '+(page<=1?'disabled':'')+'>'+t('pagePrev')+'</button> <span>'+page+' / '+totalPages+'</span> <button id="pgNext" '+(page>=totalPages?'disabled':'')+'>'+t('pageNext')+'</button></div>':'');
            el.querySelector('#fp').onchange=()=>{fp=el.querySelector('#fp').value;page=1;render();};
            el.querySelector('#fe').onchange=()=>{fe=el.querySelector('#fe').checked;page=1;render();};
            el.querySelector('#expBtn').onclick=()=>{const rows=filter(),lines=['Time,Provider,Model,Input,Output,Cost,Error'].concat(rows.map(c=>[fmtTime(c.timestamp),c.provider,c.model,c.input,c.output,c.cost,c.hasError?'Y':'N'].map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')));const blob=new Blob([lines.join(String.fromCharCode(10))],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='openclaw-calls-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(a.href);};
            const pgPrev=el.querySelector('#pgPrev');if(pgPrev)pgPrev.onclick=()=>{if(page>1){page--;render();}};
            const pgNext=el.querySelector('#pgNext');if(pgNext)pgNext.onclick=()=>{if(page<totalPages){page++;render();}};
          }
          render();
        }
      }catch(e){document.getElementById('content').innerHTML='<div class="proc-empty"><div class="hint">'+e.message+'</div></div>';}
    }
    applyI18n();
    load();setInterval(load,30000);
  </script></body></html>`;
}

const USAGE_CACHE_TTL_MS = 15000;
let usageCache = { data: null, timeRange: null, ts: 0 };

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.end(HTML);
    return;
  }
  if (req.url === '/skills' || req.url === '/skills/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buildSubPage('skills'));
    return;
  }
  if (req.url === '/processing' || req.url === '/processing/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buildSubPage('processing'));
    return;
  }
  if (req.url === '/recent' || req.url === '/recent/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buildSubPage('recent'));
    return;
  }
  if (req.url === '/api/skills') {
    loadSkillsRaw().then(skills => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ skills: skills || [] }));
    }).catch((err) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ skills: [], error: err?.message || String(err) }));
    });
    return;
  }
  if (req.url === '/api/usage' || req.url.startsWith('/api/usage?')) {
    (async () => {
      const u = new URL(req.url, 'http://localhost');
      const timeRange = u.searchParams.get('range') || 'all';
      const cacheNow = Date.now();
      if (usageCache.data && usageCache.timeRange === timeRange && cacheNow - usageCache.ts < USAGE_CACHE_TTL_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(usageCache.data);
        return;
      }

      const gwPromise = fetchUsageFromGateway(timeRange);
      const skillsPromise = loadSkillsAsync();
      const runningPromise = loadRunningTasksAsync();
      const callsPromise = loadAllCallsAsync();
      const cronPromise = fsPromises.readFile(CRON_JOBS, 'utf8').then(d => { try { return JSON.parse(d).jobs || []; } catch { return []; } }).catch(() => []);
      const sessionsPromise = fsPromises.readFile(SESSIONS_JSON, 'utf8').then(d => JSON.parse(d)).catch(() => ({}));
      const configPromise = fsPromises.readFile(CONFIG_PATH, 'utf8').then(d => JSON.parse(d)).catch(() => null);
      const sysInfoPromise = (async () => {
        const memTotal = os.totalmem(), memFree = os.freemem(), memUsed = memTotal - memFree;
        const memUsagePct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
        let disk = { total: 0, used: 0, free: 0, usagePct: 0, mount: '-' };
        try {
          const { stdout } = await execAsync('df -k . 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 800 });
          const parts = (stdout || '').trim().split(/\s+/);
          if (parts.length >= 4) {
            const totalK = parseInt(parts[1], 10) || 0, usedK = parseInt(parts[2], 10) || 0;
            disk = { total: totalK * 1024, used: usedK * 1024, free: (parseInt(parts[3], 10) || 0) * 1024, usagePct: totalK > 0 ? Math.round((usedK / totalK) * 100) : 0, mount: parts[5] || '-' };
          }
        } catch (_) {}
        const ifaces = [];
        try {
          for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
            if (!addrs?.length) continue;
            for (const a of addrs) { if (!a.internal && a.family === 'IPv4') { ifaces.push({ name, address: a.address, mac: a.mac || '-' }); break; } }
          }
        } catch (_) {}
        const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 0;
        const loadavg = typeof os.loadavg === 'function' ? os.loadavg() : [0, 0, 0];
        const cpus = typeof os.cpus === 'function' ? os.cpus() : [];
        const cpuModel = cpus && cpus[0] ? cpus[0].model : '';
        return { memory: { total: memTotal, free: memFree, used: memUsed, usagePct: memUsagePct }, disk, network: { interfaces: ifaces }, cpu: { count: cpuCount, loadavg, model: cpuModel }, platform: os.platform(), hostname: os.hostname(), uptime: os.uptime(), nodeVersion: process.version, arch: process.arch };
      })();

      const [gw, skills, runningTasks, { calls, userQuestions, toolCallCount, sessionCount }, cronJobs, sessionsData, rawConfig, systemInfo] = await Promise.all([
        gwPromise, skillsPromise, runningPromise, callsPromise, cronPromise, sessionsPromise, configPromise, sysInfoPromise
      ]);
      const oneDay = 24 * 60 * 60 * 1000;
      const sevenDays = 7 * oneDay;
      const refNow = Date.now();
      const filterRecent = (c) => {
        const ts = new Date(c.timestamp).getTime();
        if (timeRange === 'today') return refNow - ts < oneDay;
        if (timeRange === '7d') return refNow - ts < sevenDays;
        return true;
      };
      let aggregated;
      let dataSource = 'local';
      if (gw && (gw.cost?.totals || gw.sessions?.sessions?.length > 0)) {
        aggregated = gatewayToAggregated(gw, timeRange);
        dataSource = 'gateway';
      }
      if (!aggregated) {
        aggregated = { ...aggregate(calls, timeRange), userQuestions, toolCallCount, sessionCount };
      }
      // 当网关/数据源费用为 0 但本地有 token 数据时，用 MODEL_PRICING 估算费用
      if (aggregated && (aggregated.totalCost ?? 0) === 0 && calls.length > 0) {
        const localAgg = aggregate(calls, timeRange);
        if (localAgg.totalCost > 0) {
          aggregated = { ...aggregated, totalCost: localAgg.totalCost, todayCost: localAgg.todayCost, weekCost: localAgg.weekCost };
          if (aggregated.byProvider) {
            for (const [pk, p] of Object.entries(localAgg.byProvider || {})) {
              if (aggregated.byProvider[pk]) aggregated.byProvider[pk].cost = p.cost;
            }
          }
          if (aggregated.byModel) {
            for (const [mk, m] of Object.entries(localAgg.byModel || {})) {
              if (aggregated.byModel[mk]) aggregated.byModel[mk].cost = m.cost;
            }
          }
        }
      }
      let recent = calls.filter(filterRecent).map(c => ({ ...c, cost: c.cost > 0 ? c.cost : calcCost(c) }));
      if (recent.length > 500) recent = recent.slice(0, 500);
      const activeSessions = Object.entries(sessionsData).filter(([k]) => !k.startsWith('_')).map(([key, s]) => ({
        key, channel: s.lastChannel || s.deliveryContext?.channel || '-', updatedAt: s.updatedAt, origin: maskOrigin(s.origin?.label || s.origin?.from || '-')
      }));
      const entries = Object.entries(sessionsData).filter(([k]) => !k.startsWith('_'));
      const sorted = entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      const currentSession = sorted.length ? (() => { const s = sorted[0][1]; return { sessionId: s.sessionId || (s.sessionFile ? path.basename(s.sessionFile).replace(/\.jsonl.*$/, '') : null), sessionFile: s.sessionFile, key: sorted[0][0] }; })() : null;
      const config = rawConfig ? { primary: (typeof rawConfig.agents?.defaults?.model === 'string' ? rawConfig.agents?.defaults?.model : rawConfig.agents?.defaults?.model?.primary) || null, models: rawConfig.agents?.defaults?.models ? Object.keys(rawConfig.agents.defaults.models) : [] } : { primary: null, models: [] };
      const conversation = currentSession ? loadConversation(currentSession.sessionFile || currentSession.sessionId) : { sessionId: null, messages: [] };
      const hint = aggregated.sessionCount === 0 && calls.length === 0 && !gw ? { noData: true, dataDir: OPENCLAW_HOME } : null;
      const projectSummary = loadProjectSummary();
      const payload = JSON.stringify({
        aggregated,
        recent, cronJobs, activeSessions, config, runningTasks, conversation, currentSessionKey: currentSession?.key,
        projectSummary,
        pricing: Object.entries(MODEL_PRICING).map(([k, v]) => ({ id: k, ...v })),
        hint,
        systemInfo,
        skills,
        meta: { dataDir: OPENCLAW_HOME, sessionFiles: getSessionFileCount(), dataSource, gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}/usage` }
      });
      usageCache = { data: payload, timeRange, ts: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
    })().catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    });
    return;
  }
  if (req.url === '/api/debug') {
    const { calls, userQuestions, toolCallCount, sessionCount } = loadAllCalls();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      openclawHome: OPENCLAW_HOME,
      sessionsDir: SESSIONS_DIR,
      sessionsDirExists: fs.existsSync(SESSIONS_DIR),
      sessionFileCount: getSessionFileCount(),
      callsCount: calls.length,
      userQuestions,
      toolCallCount,
      sessionCount,
      env: {
        OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR || '(not set)',
        OPENCLAW_HOME: process.env.OPENCLAW_HOME || '(not set)',
        HOME: process.env.HOME ? '(set)' : '(not set)'
      }
    }, null, 2));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/abort') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { sessionId } = JSON.parse(body || '{}');
        const result = abortSession(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid request' }));
      }
    });
    return;
  }
  if (req.url === '/api/logs' || req.url.startsWith('/api/logs?')) {
    (async () => {
      const u = new URL(req.url, 'http://localhost');
      const fileKey = u.searchParams.get('file') || 'gateway';
      const tail = Math.min(parseInt(u.searchParams.get('tail') || '500', 10) || 500, 5000);
      const logPath = fileKey === 'gateway_err' ? GATEWAY_ERR_LOG : GATEWAY_LOG;
      if (!fs.existsSync(logPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ lines: [], totalLines: 0, path: logPath, fileSize: 0, mtime: null, showingLines: 0 }));
        return;
      }
      const buf = Buffer.alloc(2 * 1024 * 1024);
      const fd = fs.openSync(logPath, 'r');
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;
      const mtime = stat.mtime ? stat.mtime.toISOString() : null;
      const readSize = Math.min(fileSize, buf.length);
      const start = Math.max(0, fileSize - readSize);
      fs.readSync(fd, buf, 0, readSize, start);
      fs.closeSync(fd);
      const text = buf.toString('utf8', 0, readSize);
      const all = (start > 0 ? '\n' : '') + text;
      const lines = all.split(/\r?\n/).filter(Boolean);
      const lastLines = lines.slice(-tail);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        lines: lastLines,
        totalLines: lines.length,
        path: logPath,
        fileSize,
        mtime,
        showingLines: lastLines.length,
        fileKey
      }));
    })().catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e), lines: [] }));
    });
    return;
  }
  if (req.url === '/logs' || req.url === '/logs/') {
    const logsHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Logs · OpenClaw</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Syne:wght@600&family=DM+Sans:wght@500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #1a0b2e;
      --glass: #f8fafc;
      --glass-border: #e2e8f0;
      --accent: #7c3aed;
      --accent-soft: #ede9fe;
      --text: #0c1222;
      --muted: #64748b;
      --border: #e2e8f0;
      --green: #059669;
      --red: #dc2626;
      --orange: #ea580c;
      --radius: 12px;
    }
    @keyframes gridPulse { 0%,100%{opacity:0.5} 50%{opacity:0.8} }
    html { min-height: 100%; background: #1a0b2e; overscroll-behavior: none; }
    @keyframes bodyGradientShift { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }
    body {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      background: linear-gradient(135deg, #1a0b2e 0%, #2d1b4e 25%, #4a2c6a 50%, #8b4fb8 75%, #ec4899 100%);
      background-size: 200% 200%;
      background-color: #1a0b2e;
      animation: bodyGradientShift 25s ease infinite;
      background-attachment: fixed;
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 24px;
    }
    body::before {
      content: '';
      position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background-image: radial-gradient(circle at 20% 30%, rgba(168,85,247,0.2) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(236,72,153,0.15) 0%, transparent 50%), linear-gradient(rgba(168,85,247,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(168,85,247,0.04) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 50px 50px, 50px 50px;
      opacity: 1;
    }
    .container {
      max-width: 1680px;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }
    .head {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      max-width: 1680px;
      width: calc(100% - 24px);
      margin: 12px auto 0;
      box-sizing: border-box;
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 24px;
      align-items: center;
      min-height: 92px;
      padding: 18px 28px 18px;
      border: 1px solid #e2e8f0;
      border-radius: 22px;
      background: #ffffff;
      box-shadow: 0 10px 28px rgba(15,23,42,0.08);
    }
    .container { padding-top: 148px; }
    .head .global-nav { flex-shrink: 0; justify-self: start; margin: 8px 0 0 24px; }
    .head h1 {
      font-family: 'Syne', sans-serif;
      font-size: 20px;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.05em;
    }
    .head .brand { font-weight: 600; font-size: 18px; color: var(--accent); text-decoration: none; margin-right: 8px; }
    .head .brand:hover { color: #6d28d9; }
    .global-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; margin: 8px 0 0 24px; }
    .global-nav a { display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 16px; font-size: 13px; font-weight: 600; line-height: 1; color: #0f172a; text-decoration: none; border-radius: 10px; border: 1px solid rgba(100,116,139,0.25); background: #f8fafc; transition: color 0.2s, background 0.2s, box-shadow 0.2s; min-width: fit-content; box-sizing: border-box; }
    .global-nav a span:first-child { opacity: 0.85; font-size: 11px; }
    .global-nav a:hover { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
    .global-nav a.active { color: var(--text); background: #fff; border-color: var(--accent); }
    .global-nav .nav-sep { width: 1px; height: 22px; background: #e2e8f0; margin: 0 2px; flex-shrink: 0; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .tabs {
      display: flex;
      background: var(--glass);
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--glass-border);
    }
    .tabs button {
      padding: 8px 16px;
      border: none;
      background: none;
      color: var(--muted);
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      transition: all 0.2s;
    }
    .tabs button:hover { color: var(--text); }
    .tabs button.active { background: rgba(168, 85, 247, 0.15); color: var(--accent); }
    .tail-select {
      padding: 8px 12px;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      background: var(--glass);
      color: var(--text);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .stats {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      font-size: 11px;
      color: var(--muted);
    }
    .stats span { display: inline-flex; align-items: center; gap: 4px; }
    .stats .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.5} }
    .log-wrap {
      background: linear-gradient(145deg, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.98) 100%);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 2px 16px rgba(120,53,15,0.06);
    }
    .log {
      padding: 16px;
      overflow-x: auto;
      overflow-y: auto;
      max-height: calc(100vh - 220px);
      font-size: 11px;
      line-height: 1.65;
    }
    .log .ln {
      padding: 2px 0;
      border-bottom: 1px solid rgba(168, 85, 247,0.04);
      display: flex;
      gap: 12px;
      align-items: baseline;
      word-break: break-all;
    }
    .log .ln:hover { background: rgba(168, 85, 247, 0.05); }
    .log .ts { color: var(--muted); flex-shrink: 0; min-width: 28ch; }
    .log .tag { color: var(--accent); flex-shrink: 0; }
    .log .msg { color: var(--text); flex: 1; }
    .log .ln.err .msg { color: var(--red); }
    .log .ln.warn .msg { color: var(--orange); }
    .log .ln.raw { display: block; }
    .log .ln.raw .ts { display: none; }
    .log .ln.raw .tag { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="head">
      <a href="/" class="brand">OpenClaw</a>
      <nav class="global-nav">
        <a href="/"><span>◉</span><span data-i18n="dashboard">Dashboard</span></a>
        <span class="nav-sep"></span>
        <a href="/skills"><span>◇</span><span data-i18n="skills">Skills</span></a>
        <a href="/processing"><span>▶</span><span data-i18n="processingNow">Processing</span></a>
        <a href="/recent"><span>◐</span><span data-i18n="recentCalls">Recent</span></a>
        <span class="nav-sep"></span>
        <a href="/logs" class="active"><span>≡</span><span data-i18n="logs">Logs</span></a>
      </nav>
    </div>
    <div class="toolbar">
      <div class="tabs">
        <button type="button" class="active" data-file="gateway">gateway.log</button>
        <button type="button" data-file="gateway_err">gateway.err.log</button>
      </div>
      <select class="tail-select" id="tailSelect"></select>
      <div class="stats" id="stats">
        <span><span class="dot"></span><span data-i18n="logRealtime">Live</span></span>
        <span id="statLines">—</span>
        <span id="statSize">—</span>
        <span id="statMtime">—</span>
      </div>
    </div>
    <div class="log-wrap">
      <div class="log" id="log"></div>
    </div>
  </div>
  <script>
    window.__I18N__ = ${JSON.stringify(i18n)};
    let lang = localStorage.getItem('api-console-lang') || 'zh';
    function t(k){const zh=window.__I18N__.zh;const en=window.__I18N__.en;if(lang==='en')return (en&&en[k])||k;return (zh&&zh[k])||(en&&en[k])||k;}
    const logEl = document.getElementById('log');
    const statsEl = document.getElementById('stats');
    const statLines = document.getElementById('statLines');
    const statSize = document.getElementById('statSize');
    const statMtime = document.getElementById('statMtime');
    const tailSelect = document.getElementById('tailSelect');
    let interval;
    let currentFile = 'gateway';
    let currentTail = 500;
    (function init(){
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      document.title = t('logs') + ' · OpenClaw';
      document.querySelectorAll('[data-i18n]').forEach(el=>{const k=el.getAttribute('data-i18n');if(k)el.textContent=t(k);});
      tailSelect.innerHTML = [200,500,1000,2000,5000].map(n=>'<option value="'+n+'"'+(n===500?' selected':'')+'>'+t('logLastLines').replace('{n}',n)+'</option>').join('');
    })();

    function escape(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function fmtSize(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
      return (n/(1024*1024)).toFixed(2) + ' MB';
    }

    function fmtMtime(iso) {
      if (!iso) return '—';
      try {
        const d = new Date(iso);
        return d.toLocaleString();
      } catch (_) { return iso; }
    }

    function parseLine(line) {
      const m = line.match(/^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.?\\d*Z)\\s+(\\[[^\\]]+\\])?\\s*(.*)$/s);
      if (m) return { ts: m[1], tag: m[2] || '', msg: m[3] || '' };
      return { ts: '', tag: '', msg: line, raw: true };
    }

    function render(lines, meta) {
      if (!lines || lines.length === 0) {
        logEl.innerHTML = '<div class="ln raw"><span class="msg">' + t('logEmpty') + '</span></div>';
        return;
      }
      logEl.innerHTML = lines.map(line => {
        const p = parseLine(line);
        const cls = /\\berror|\\bERROR|\\bFATAL|\\bCRITICAL/i.test(line) ? ' err' : /\\bwarn|\\bWARN|\\bWARNING/i.test(line) ? ' warn' : '';
        if (p.raw) {
          return '<div class="ln raw ' + cls + '"><span class="msg">' + escape(p.msg) + '</span></div>';
        }
        return '<div class="ln' + cls + '"><span class="ts">' + escape(p.ts) + '</span><span class="tag">' + escape(p.tag) + '</span><span class="msg">' + escape(p.msg) + '</span></div>';
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;
      if (meta) {
        statLines.textContent = t('logShowing') + meta.showingLines + t('logLines');
        statSize.textContent = t('logFile') + fmtSize(meta.fileSize || 0);
        statMtime.textContent = t('logUpdated') + fmtMtime(meta.mtime);
      }
    }

    async function fetchLogs() {
      try {
        const r = await fetch('/api/logs?file=' + currentFile + '&tail=' + currentTail);
        const d = await r.json();
        if (d.lines) render(d.lines, d);
        if (d.error) logEl.innerHTML = '<div class="ln raw err"><span class="msg">' + escape(d.error) + '</span></div>';
      } catch (e) {
        logEl.innerHTML = '<div class="ln raw err"><span class="msg">' + escape(String(e?.message || e)) + '</span></div>';
      }
    }

    document.querySelectorAll('.tabs button').forEach(btn => {
      btn.onclick = () => {
        document.querySelector('.tabs button.active').classList.remove('active');
        btn.classList.add('active');
        currentFile = btn.dataset.file;
        fetchLogs();
      };
    });
    tailSelect.onchange = () => { currentTail = parseInt(tailSelect.value, 10); fetchLogs(); };
    fetchLogs();
    interval = setInterval(fetchLogs, 2000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearInterval(interval);
      else { interval = setInterval(fetchLogs, 2000); fetchLogs(); }
    });
  </script>
</body>
</html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.end(logsHtml);
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const fileCount = getSessionFileCount();
  const { calls } = loadAllCalls();
  loadSkillsAsync().then(skills => {
    if (skills.length > 0) console.log('  技能列表: 已预加载 ' + skills.length + ' 个');
  }).catch(() => {});
  console.log('');
  console.log('  🦞 OpenClaw API 调用监控控制台');
  console.log('');
  console.log('  数据目录: ' + OPENCLAW_HOME);
  console.log('  Session 文件: ' + fileCount + ' 个');
  console.log('  API 调用记录: ' + calls.length + ' 条');
  console.log('');
  console.log('  访问: http://127.0.0.1:' + PORT);
  console.log('  日志:  http://127.0.0.1:' + PORT + '/logs');
  console.log('');
});
