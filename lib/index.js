/**
 * dsh-session-communicate — 让两个已有 DSH 会话按规则对话（host half）.
 *
 * 设计要点：
 *   · 只做「投递 + 读回话」两件事。两边都是普通会话，用 sessionController.prompt 投递，
 *     用会话日志（zstd jsonl）读回话，不要求对方会使用工具、不要求对方装插件。
 *   · 每一句都带同一份规则（谁在跟谁说话、第几轮、每条字数上限、不要调用工具），
 *     避免其中一边把对话当成任务汇报或去翻文件。
 *   · 定时不自己起 timer：由 dsh-fairy-maintenance 的 bridge 任务每分钟打
 *     POST /session-communicate/api/tick，这里只判断「到点了没、今天跑过没」。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'

export const name = 'dsh-session-communicate'
export const inject = ['webServer', 'sessionController']

const DSH_HOME = path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const CONFIG_FILE = path.join(DSH_HOME, 'session-communicate.json')
const STATE_FILE = path.join(DSH_HOME, 'session-communicate.state.json')
const DEBUG_FILE = path.join(DSH_HOME, 'session-communicate.debug.log')
const LOG_FILE = path.join(DSH_HOME, 'session-communicate.log')

/** 给人看的历史记录（面板里滚动显示，也是「看所有日志」打开的目录里的文件）。 */
function logEvent(line) {
  try {
    const flat = String(line).replace(/\r?\n+/g, ' ')
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${flat}\n`)
  } catch { /* 日志失败不影响对谈 */ }
}

/** 对谈正文单独存一个目录，一场一个 md，只记双方说的话，不记规则。 */
const TALK_DIR = path.join(DSH_HOME, 'session-communicate', 'conversations')

function talkPath(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`
  try { fs.mkdirSync(TALK_DIR, { recursive: true }) } catch { /* 目录建不了就退回写失败，不阻断对谈 */ }
  return path.join(TALK_DIR, name)
}

function localHms(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function appendTalk(file, name, text, at) {
  const stamp = localHms(at ? new Date(at) : new Date())
  try {
    fs.appendFileSync(file, `\n**${name}** · ${stamp}\n\n${text}\n`)
  } catch { /* 记录失败不阻断对谈 */ }
}

function debug(line) {
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch { /* diagnostics must never break loading */ }
}

debug(`module imported (pid ${process.pid}, node ${process.version}, zstd=${typeof zlib.zstdDecompressSync})`)


const DEFAULTS = Object.freeze({
  enabled: true,
  sessionA: '',
  sessionB: '',
  nameA: '会话 A',
  nameB: '会话 B',
  initiator: 'A',
  purpose: '',
  rounds: 3,
  time: '20:00',
  messageChars: 800,
  replyTimeoutSeconds: 300,
})

let pluginCtx = null
const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  transcript: [],       // [{from:'A'|'B', text, at}]
  lastRunDay: null,
  lastResult: null,
  retryAt: null,
  attempts: 0,
  attemptDay: null,
  nextRunAt: null,
}

// ---------- config ----------

function loadConfig() {
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { saved = {} }
  const cfg = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) }
  cfg.rounds = clampInt(cfg.rounds, 1, 20, DEFAULTS.rounds)
  cfg.messageChars = clampInt(cfg.messageChars, 100, 4000, DEFAULTS.messageChars)
  cfg.replyTimeoutSeconds = clampInt(cfg.replyTimeoutSeconds, 30, 1800, DEFAULTS.replyTimeoutSeconds)
  cfg.initiator = cfg.initiator === 'B' ? 'B' : 'A'
  cfg.time = /^\d{1,2}:\d{2}$/.test(String(cfg.time)) ? String(cfg.time) : DEFAULTS.time
  return cfg
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...(patch && typeof patch === 'object' ? patch : {}) }
  next.rounds = clampInt(next.rounds, 1, 20, DEFAULTS.rounds)
  next.messageChars = clampInt(next.messageChars, 100, 4000, DEFAULTS.messageChars)
  next.time = /^\d{1,2}:\d{2}$/.test(String(next.time)) ? String(next.time) : DEFAULTS.time
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2))
  refreshNextRun(next)
  return next
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (saved && typeof saved === 'object') {
      if (typeof saved.lastRunDay === 'string') state.lastRunDay = saved.lastRunDay
      if (typeof saved.lastResult === 'string') state.lastResult = saved.lastResult
      if (typeof saved.retryAt === 'string') state.retryAt = saved.retryAt
      if (typeof saved.attempts === 'number') state.attempts = saved.attempts
      if (typeof saved.attemptDay === 'string') state.attemptDay = saved.attemptDay
    }
  } catch { /* 没有状态文件就当作没跑过 */ }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastRunDay: state.lastRunDay,
      lastResult: state.lastResult,
      retryAt: state.retryAt,
      attempts: state.attempts,
      attemptDay: state.attemptDay,
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch { /* 状态写失败不阻断对话 */ }
}

function refreshNextRun(cfg) {
  const [h, m] = String(cfg.time).split(':').map(Number)
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  state.nextRunAt = at.toISOString()
}

// ---------- session logs ----------

function sessionLogPath(sessionId) {
  let dirs = []
  try { dirs = fs.readdirSync(SESSIONS_ROOT) } catch { return null }
  for (const dir of dirs) {
    const candidate = path.join(SESSIONS_ROOT, dir, sessionId, 'session.v4.jsonl.zstd')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const ZSTD_MAGIC = 0xfd2fb528 // 文件里的小端读法（字节序列 28 b5 2f fd）

/** 单个 zstd 帧的结束位置；返回 -1 表示这里不是合法帧。 */
function zstdFrameEnd(buf, start) {
  if (start + 4 > buf.length || buf.readUInt32LE(start) !== ZSTD_MAGIC) return -1
  let p = start + 4
  if (p >= buf.length) return -1
  const fhd = buf[p]
  p += 1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictFlag]
  p += singleSegment ? [1, 2, 4, 8][fcsFlag] : [0, 2, 4, 8][fcsFlag]
  if (p + 3 > buf.length) return -1
  for (;;) {
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 1) p += 1
    else if (type === 3) return -1
    else p += size
    if (p > buf.length) return -1
    if (last) break
  }
  if (checksum) p += 4
  return p <= buf.length ? p : -1
}

/**
 * 会话日志是「追加式多帧 zstd」：宿主里的 zstd 解压只解第一帧，所以这里按帧切开逐帧解。
 */
function decodeSessionBuffer(buf) {
  const parts = []
  let offset = 0
  while (offset < buf.length) {
    const end = zstdFrameEnd(buf, offset)
    if (end < 0) {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offset)))
      break
    }
    parts.push(zlib.zstdDecompressSync(buf.subarray(offset, end)))
    offset = end
  }
  return Buffer.concat(parts).toString('utf8')
}

async function readRecords(sessionId) {
  const file = sessionLogPath(sessionId)
  if (!file) throw new Error(`会话不存在：${sessionId}`)
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(`当前 Node（${process.version}）没有 zstd 解压，请升级到 22.15 以上`)
  }
  const stat = fs.statSync(file)
  if (stat.size > 400 * 1024 * 1024) {
    throw new Error(`会话日志过大（${Math.round(stat.size / 1048576)} MB），这个插件按整份读入内存，超过 400 MB 会拒绝读取`)
  }
  const raw = decodeSessionBuffer(fs.readFileSync(file))
  const records = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try { records.push(JSON.parse(line)) } catch { /* skip torn line */ }
  }
  debug(`readRecords ${sessionId.slice(8, 16)} size=${stat.size} raw=${raw.length} recs=${records.length}`)
  return { records, file, mtime: stat.mtimeMs }
}

function maxSeq(records) {
  let max = 0
  for (const r of records) if (Number(r.seq) > max && Number.isFinite(Number(r.seq))) max = Number(r.seq)
  return max
}

function textOf(message) {
  const parts = Array.isArray(message && message.content) ? message.content : []
  const raw = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
  return raw.replace(/[\u200b-\u200d\ufeff]/g, '').trim()
}

/** 取「某个 seq 之后、最后一个已结束 turn」里最后一条有内容的 assistant 文本。 */
function replyAfter(records, afterSeq) {
  let turn = null
  for (const r of records) {
    if (Number(r.seq) <= afterSeq) continue
    if (r.type === 'turn/end') turn = r.data && Number(r.data.turn)
  }
  if (turn === null) return null
  let text = ''
  for (const r of records) {
    if (Number(r.seq) <= afterSeq) continue
    if (r.type !== 'assistant/message') continue
    const t = r.data && Number(r.data.turn)
    if (t !== turn) continue
    const candidate = textOf(r.data.message)
    if (candidate) text = candidate
  }
  return text ? text.trim() : null
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

/** 对方没在对话、而是回了一句「忙/跳过/闸没过」之类的系统口吻时，不算对谈内容。 */
const NON_DIALOGUE_PATTERNS = [
  /空闲闸/, /\.dshw-turn\.json/, /跳过本轮/, /按规则跳过/, /本轮漫游/,
  /(?:无法|不能)回复/, /(?:请求|指令)超时/, /busy/i, /rate limit/i,
]

function looksNonDialogue(text) {
  const t = String(text || '').trim()
  if (!t) return true
  return NON_DIALOGUE_PATTERNS.some((re) => re.test(t))
}

async function waitForReply(sessionId, afterSeq, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const file = sessionLogPath(sessionId)
  let lastStamp = ''
  while (Date.now() < deadline) {
    await sleep(2000)
    try {
      if (file) {
        const stat = fs.statSync(file)
        const stamp = `${stat.size}:${stat.mtimeMs}`
        if (stamp === lastStamp) continue // 文件没变，不用重复解压 140 MB
        lastStamp = stamp
      }
    } catch { /* 读不到 stat 就直接尝试读记录 */ }
    let records
    try { records = (await readRecords(sessionId)).records } catch { continue }
    const reply = replyAfter(records, afterSeq)
    if (reply && !looksNonDialogue(reply)) return reply
  }
  throw new Error(`等待回话超时（${Math.round(timeoutMs / 1000)} 秒）：${sessionId}`)
}

async function prompt(sessionId, text) {
  const controller = pluginCtx && pluginCtx.sessionController
  if (!controller) throw new Error('sessionController unavailable')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('prompt timeout')), 30_000)
  try {
    const source = Object.assign(Object.create(ac.signal), {
      kind: 'user',
      rpcId: `session-communicate-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      clientTimeZone: 'Asia/Shanghai',
    })
    Object.defineProperty(source, 'aborted', { get: () => ac.signal.aborted })
    source.throwIfAborted = () => { if (ac.signal.aborted) throw ac.signal.reason }
    await controller.prompt({
      requestId: source.rpcId,
      sessionId,
      mode: 'queue',
      clientTimeZone: 'Asia/Shanghai',
      content: [{ type: 'text', text }],
    }, source)
  } finally {
    clearTimeout(timer)
  }
}

/** 投递但不等太久：目标会话正忙时 prompt 会一直挂着，这里最多等 20 秒。 */
async function deliver(sessionId, text) {
  let pending = null
  try {
    pending = prompt(sessionId, text)
    pending.catch(() => { /* 超时后再失败不影响主流程 */ })
    await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('投递超时：目标会话可能正忙')), 20_000)),
    ])
  } catch (error) {
    throw error
  }
}

// ---------- conversation ----------

function rules(cfg, speaker, listener, index, total) {
  return [
    '【会话通讯规则 · 必须遵守】',
    `· 你现在是「${speaker}」，正在通过 DSH 与「${listener}」对话。`,
    `· 本次对话共 ${total} 条消息，你的这条是第 ${index} 条；双方都知道这条规则。`,
    `· 直接输出要交给对方的话：不要调用任何工具、不要读取或写入文件、不要解释规则、不要写「收到」「明白」。`,
    `· 一条不超过 ${cfg.messageChars} 字；只谈主题，不做任务清单。`,
    cfg.purpose ? `· 对话目的：${cfg.purpose}` : '',
  ].filter(Boolean).join('\n')
}

function openingPrompt(cfg, speaker, listener, total) {
  return [
    rules(cfg, speaker, listener, 1, total),
    '',
    `【这一条由你开场】请围绕对话目的，写出你要对「${listener}」说的第一段话。`,
    '如果这是某项工作的沟通，先说清楚你希望对方理解或决定什么；不要客套。',
  ].join('\n')
}

function replyPrompt(cfg, speaker, listener, index, total, incoming) {
  return [
    rules(cfg, speaker, listener, index, total),
    '',
    `「${listener}」刚刚对你说：`,
    '---',
    incoming,
    '---',
    '请直接回话。可以追问、反驳、补充，但不要复述规则，也不要总结整段对话。',
  ].join('\n')
}

async function runConversation(trigger = 'manual') {
  if (state.running) return { ok: false, error: 'already running' }
  const cfg = loadConfig()
  if (!cfg.sessionA || !cfg.sessionB) return { ok: false, error: '请先配置两个会话' }
  if (cfg.sessionA === cfg.sessionB) return { ok: false, error: '两个会话不能相同' }

  const first = cfg.initiator === 'B' ? 'B' : 'A'
  const sessionOf = { A: cfg.sessionA, B: cfg.sessionB }
  const nameOf = { A: cfg.nameA || '会话 A', B: cfg.nameB || '会话 B' }
  const total = cfg.rounds * 2

  state.running = true
  state.startedAt = new Date().toISOString()
  const talkFile = talkPath()
  try {
    fs.writeFileSync(talkFile, `# 会话对谈 · ${nameOf.A} × ${nameOf.B}\n\n开始：${new Date().toLocaleString('zh-CN')} · ${cfg.rounds} 轮\n`)
  } catch { /* 头部写失败不阻断 */ }
  logEvent(`run start (${trigger}) A=${nameOf.A} B=${nameOf.B} rounds=${cfg.rounds} file=${talkFile}`)
  state.finishedAt = null
  state.error = null
  state.transcript = []
  state.lastResult = `running (${trigger})`

  try {
    const start = await readRecords(sessionOf[first])
    let afterSeq = maxSeq(start.records)
    await deliver(sessionOf[first], openingPrompt(cfg, nameOf[first], nameOf[first === 'A' ? 'B' : 'A'], total))
    let message = await waitForReply(sessionOf[first], afterSeq, cfg.replyTimeoutSeconds * 1000)
    state.transcript.push({ from: first, text: message, at: new Date().toISOString() })
    appendTalk(talkFile, nameOf[first], message)
    logEvent(`1/${total} ${nameOf[first]}: ${message.slice(0, 120)}`)

    let speaker = first
    for (let index = 2; index <= total; index += 1) {
      const listener = speaker === 'A' ? 'B' : 'A'
      const target = sessionOf[listener]
      const snapshot = await readRecords(target)
      afterSeq = maxSeq(snapshot.records)
      await deliver(target, replyPrompt(cfg, nameOf[listener], nameOf[speaker], index, total, message))
      message = await waitForReply(target, afterSeq, cfg.replyTimeoutSeconds * 1000)
      state.transcript.push({ from: listener, text: message, at: new Date().toISOString() })
      appendTalk(talkFile, nameOf[listener], message)
      logEvent(`${index}/${total} ${nameOf[listener]}: ${message.slice(0, 120)}`)
      speaker = listener
    }

    state.lastResult = `ok · ${state.transcript.length} 条 · ${trigger}`
    logEvent(`run ok · ${state.transcript.length} 条 · ${talkFile}`)
    if (trigger !== 'manual') state.lastRunDay = todayKey()
    state.retryAt = null
    state.attempts = 0
    saveState()
    return { ok: true, messages: state.transcript.length }
  } catch (error) {
    state.error = String(error && error.message ? error.message : error)
    state.lastResult = `error: ${state.error}`
    const today = todayKey()
    state.attempts = state.attempts && state.attemptDay === today ? state.attempts + 1 : 1
    state.attemptDay = today
    if (state.attempts >= 3) {
      state.lastRunDay = today // 连试三次都失败，今天不再自动重试（可手动 /run）
      state.retryAt = null
    } else {
      state.retryAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 分钟后再试
    }
    saveState()
    throw error
  } finally {
    state.running = false
    state.finishedAt = new Date().toISOString()
  }
}

function todayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 插件自带调度器每 30 秒调用：只判断时间与「今天是否跑过」。 */
async function tick() {
  const cfg = loadConfig()
  if (!cfg.enabled) return { ran: false, reason: 'disabled' }
  if (!state.capability || !state.capability.prompt) return { ran: false, reason: '宿主缺少 sessionController.prompt，无法投递' }
  if (state.running) return { ran: false, reason: 'running' }
  if (!cfg.sessionA || !cfg.sessionB) return { ran: false, reason: 'not configured' }
  const today = todayKey()
  if (state.lastRunDay === today) return { ran: false, reason: 'already ran today' }
  if (state.retryAt && Date.now() < Date.parse(state.retryAt)) return { ran: false, reason: 'retry later' }
  const [h, m] = String(cfg.time).split(':').map(Number)
  const now = new Date()
  const dueMinute = now.getHours() * 60 + now.getMinutes()
  const atMinute = (Number(h) || 0) * 60 + (Number(m) || 0)
  if (dueMinute < atMinute) return { ran: false, reason: 'not yet' }
  state.lastRunDay = today // 先占位，防止同一分钟内重复触发
  saveState()
  runConversation('schedule').catch((e) => {
    state.error = String(e && e.message ? e.message : e)
  })
  return { ran: true }
}

// ---------- API ----------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  return JSON.parse(raw)
}

function sessionList() {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(SESSIONS_ROOT) } catch { return out }
  for (const dir of dirs) {
    const base = path.join(SESSIONS_ROOT, dir)
    let entries = []
    try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      const file = path.join(base, entry.name, 'session.v4.jsonl.zstd')
      let stat = null
      try { stat = fs.statSync(file) } catch { continue }
      out.push({ id: entry.name, bytes: stat.size, updatedAt: stat.mtime.toISOString(), workspace: dir })
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return out
}

async function sessionPreview(sessionId) {
  const { records, mtime } = await readRecords(sessionId)
  const firstUser = records
    .filter((r) => r.type === 'user/message')
    .map((r) => textOf(r.data && (r.data.message || r.data)))
    .find((t) => t && !t.startsWith('<') && !t.startsWith('Current runtime') && !t.startsWith('Time sampled'))
  const turns = records.filter((r) => r.type === 'turn/end').length
  return { id: sessionId, title: (firstUser || '').slice(0, 80), turns, updatedAt: new Date(mtime).toISOString() }
}

export function apply(ctx) {
  debug('apply start')
  pluginCtx = ctx
  // 宿主能力自检：缺了就在面板上明说，别等到投递时才 404/500。
  const capability = {
    prompt: typeof ctx?.sessionController?.prompt === 'function',
    webServer: typeof ctx?.webServer?.register === 'function',
    zstd: typeof zlib.zstdDecompressSync === 'function',
  }
  debug(`capability prompt=${capability.prompt} webServer=${capability.webServer} zstd=${capability.zstd}`)
  state.capability = capability
  loadState()
  try { refreshNextRun(loadConfig()) } catch (error) { debug('refreshNextRun failed: ' + (error && error.message)) }

  // 自带调度：插件自己的定时器，不依赖任何外部定时任务插件。
  ctx.effect(() => {
    const kick = () => { tick().catch((error) => debug('tick failed: ' + (error && error.message))) }
    const warm = setTimeout(kick, 8000)
    const timer = setInterval(kick, 30 * 1000)
    debug('scheduler armed (every 30s)')
    return () => { clearTimeout(warm); clearInterval(timer) }
  })

  try {
  const routes = [
    {
      path: '/session-communicate/api/config',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: loadConfig() })
        if (req.method === 'POST') {
          const patch = await readJson(req)
          const saved = saveConfig(patch)
          logEvent(`config saved · A=${String(saved.sessionA).slice(0, 20)} B=${String(saved.sessionB).slice(0, 20)} rounds=${saved.rounds} time=${saved.time} chars=${saved.messageChars}`)
          return sendJson(res, 200, { ok: true, config: saved })
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      path: '/session-communicate/api/sessions',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, sessions: sessionList() })
      },
    },
    {
      path: '/session-communicate/api/preview',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL(req.url, 'http://localhost')
        const id = String(url.searchParams.get('sessionId') || '')
        if (!id) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        return sendJson(res, 200, { ok: true, ...(await sessionPreview(id)) })
      },
    },
    {
      path: '/session-communicate/api/status',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, state: { ...state, nextRunAt: state.nextRunAt, capability: state.capability } })
      },
    },
    {
      path: '/session-communicate/api/run',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = await readJson(req).catch(() => ({}))
        if (body && body.dry) return sendJson(res, 200, { ok: true, dry: true, config: loadConfig() })
        if (state.running) return sendJson(res, 409, { ok: false, error: 'already running' })
        runConversation('manual').catch(() => {})
        return sendJson(res, 200, { ok: true, started: true })
      },
    },
    {
      path: '/session-communicate/api/tick',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const result = await tick()
        return sendJson(res, 200, { ok: true, ...result })
      },
    },
    {
      path: '/session-communicate/api/log',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL(req.url, 'http://localhost')
        const want = Math.min(500, Math.max(10, Number(url.searchParams.get('lines') || 100) || 100))
        let lines = []
        try {
          const text = fs.readFileSync(LOG_FILE, 'utf8')
          // 只回对话行（<时间戳> <序>/<总数> <名字>: <正文>），运行日志/配置写入不进历史记录
          lines = text.split(/\r?\n/).filter((line) => /^\d{4}-\d{2}-\d{2}T\S+\s+\d+\/\d+\s+/.test(line)).slice(-want)
        } catch { lines = [] }
        return sendJson(res, 200, { ok: true, lines, dir: DSH_HOME, file: LOG_FILE })
      },
    },
    {
      path: '/session-communicate/api/opendir',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try { fs.mkdirSync(TALK_DIR, { recursive: true }) } catch { /* ignore */ }
        try {
          if (process.platform === 'win32') spawn('explorer.exe', [TALK_DIR], { detached: true, stdio: 'ignore' }).unref()
          else if (process.platform === 'darwin') spawn('open', [TALK_DIR], { detached: true, stdio: 'ignore' }).unref()
          else spawn('xdg-open', [TALK_DIR], { detached: true, stdio: 'ignore' }).unref()
        } catch (e) { return sendJson(res, 200, { ok: false, dir: TALK_DIR, error: String(e && e.message || e) }) }
        return sendJson(res, 200, { ok: true, dir: TALK_DIR, log: LOG_FILE })
      },
    },
    {
      path: '/session-communicate/api/stop',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, note: '按条投递，状态会在下一条完成后停下' })
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: async (req, res) => {
          try {
            await route.handler(req, res)
          } catch (error) {
            try {
              sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
            } catch { /* response already sent */ }
          }
        },
      }),
    )
  }

    debug(`routes registered: ${routes.length}`)
    logEvent(`plugin loaded · scheduler armed · next run ${loadConfig().time || '20:00'}`)
  } catch (error) {
    debug('apply failed: ' + (error && error.stack ? error.stack : error))
    throw error
  }

  ctx.effect(() => () => { state.running = false })
}
