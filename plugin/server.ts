#!/usr/bin/env bun
/**
 * WeChat channel for Claude Code (WeCom self-built app + WeChat plugin).
 *
 * In:  callback_server.py writes decrypted messages to $WECOM_STATE/inbox/*.json; this polls them,
 *      injects them into the session via notifications/claude/channel, then moves them to done/.
 * Out: reply tool -> gettoken (cached) -> message/send, split at 1800 UTF-8 bytes.
 * Recipients must be users who messaged the app (seen-users) or listed in WECOM_ALLOWED_USERS.
 * Credentials are read only from the env file (WECOM_ENV) and never printed.
 * Voice: amr -> ffmpeg 16k wav (dynaudnorm) -> Whisper-compatible API (default Groq); the transcript goes into content.
 *      WECOM_STT_PROVIDER=elevenlabs uses ElevenLabs Scribe first (falls back to the Whisper API).
 * Call bubble: WECOM_CALL_LOG points at the phone plugin's call log (jsonl); every 2 s new lines are checked and
 *      "ᯅ 通话时长 mm:ss" / "ᯅ 未接通" is sent, only for lines with "via":"wechat"
 *      (calls started from WeChat: the model passes via=wechat to dial).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, renameSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const ENV_FILE = process.env.WECOM_ENV ?? '/etc/wecom-agent/wecom.env'
const STATE = process.env.WECOM_STATE ?? '/var/lib/wecom-agent'
const INBOX = join(STATE, 'inbox')
const DONE = join(STATE, 'done')
const MEDIA = join(STATE, 'media')
const SEEN_USERS = join(STATE, 'seen-users')
// UserID is often a real-name pinyin; keep it out of the session: aliases.json {UserID: alias}, swapped in on inbound and back on reply
const ALIASES = join(STATE, 'aliases.json')
function aliases(): Record<string, string> {
  try { return JSON.parse(readFileSync(ALIASES, 'utf8')) } catch { return {} }
}
const toAlias = (u: string) => aliases()[u] ?? u
const fromAlias = (a: string) => Object.entries(aliases()).find(([, v]) => v === a)?.[0] ?? a
const API = process.env.WECOM_API ?? 'https://qyapi.weixin.qq.com/cgi-bin'

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
  }
  return env
}
const ENV = loadEnv()
const AGENT_ID = Number(ENV.WECOM_AGENT_ID)

for (const d of [INBOX, DONE, MEDIA]) mkdirSync(d, { recursive: true, mode: 0o700 })

function allowedUsers(): Set<string> {
  const s = new Set((ENV.WECOM_ALLOWED_USERS ?? '').split(',').filter(Boolean))
  if (existsSync(SEEN_USERS)) for (const u of readFileSync(SEEN_USERS, 'utf8').split('\n')) if (u) s.add(u)
  return s
}
function rememberUser(u: string) {
  if (u && !allowedUsers().has(u)) appendFileSync(SEEN_USERS, u + '\n', { mode: 0o600 })
}

// ---- access_token (7200s, refreshed 5 min early) ----
let tokenCache: { value: string; exp: number } | null = null
async function accessToken(force = false): Promise<string> {
  if (!force && tokenCache && Date.now() < tokenCache.exp) return tokenCache.value
  const u = new URL(`${API}/gettoken`)
  u.searchParams.set('corpid', ENV.WECOM_CORP_ID)
  u.searchParams.set('corpsecret', ENV.WECOM_SECRET)
  const d: any = await (await fetch(u)).json()
  if (d.errcode !== 0) throw new Error(`gettoken errcode ${d.errcode}`)
  tokenCache = { value: d.access_token, exp: Date.now() + (d.expires_in - 300) * 1000 }
  return tokenCache.value
}

async function api(path: string, body: unknown): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${API}/${path}?access_token=${encodeURIComponent(await accessToken(attempt > 0))}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d: any = await r.json()
    if ([40014, 42001].includes(d.errcode) && attempt === 0) continue // token expired, refresh and retry once
    return d
  }
}

// split at newline/sentence end where possible; hard-cut only if the break point is before 55%
function splitUtf8(text: string, limit = 1800): string[] {
  const parts: string[] = []
  let rest = [...text]
  while (rest.length) {
    let used = 0, boundary = 0, preferred = 0
    for (let i = 0; i < rest.length; i++) {
      used += Buffer.byteLength(rest[i])
      if (used > limit) break
      boundary = i + 1
      if ('\n。！？；'.includes(rest[i])) preferred = i + 1
    }
    // if the rest fits, do not split
    const at = boundary === rest.length || preferred < boundary * 0.55 ? boundary : preferred
    parts.push(rest.slice(0, at).join(''))
    rest = rest.slice(at)
  }
  return parts
}

async function downloadMedia(mediaId: string, ext: string): Promise<string | undefined> {
  try {
    const u = `${API}/media/get?access_token=${encodeURIComponent(await accessToken())}&media_id=${encodeURIComponent(mediaId)}`
    const r = await fetch(u)
    if ((r.headers.get('content-type') ?? '').includes('json')) return undefined
    const p = join(MEDIA, `${Date.now()}-${mediaId.slice(0, 12).replace(/[^\w-]/g, '')}.${ext}`)
    writeFileSync(p, Buffer.from(await r.arrayBuffer()), { mode: 0o600 })
    return p
  } catch { return undefined }
}

const mcp = new Server(
  { name: 'wecom', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      '用户在个人微信里发的消息走这里（企业微信应用→微信插件），用户在微信上看不到这个会话。要让用户在微信里看到，必须调 wecom 的 reply 工具，把 user 原样传回去。',
      '消息以 <channel source="wecom" user="..." msg_type="..." ts="..."> 到达；有 image_path 就 Read 那张图；语音已自动转成文字放在正文里（「(语音) 转写：…」，转写难免认错字，按意思读）；原始 amr 在 voice_path。',
      '微信里纯文本，不打 markdown；每句一条、可以多条并行发。用户在哪个入口说话就回哪个入口，别跑去别的渠道回微信的消息。',
      '用户在微信里叫你打电话、或给微信派的活打电话报完工时，dial 带上 via="wechat"，挂断后微信里会冒「ᯅ 通话时长」气泡；别的入口来的电话不带。',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: '回用户的微信消息（企业微信应用 → 用户的微信）。纯文本，长了会自动分段。',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: '收到消息时 meta 里的 user，原样传回' },
        text: { type: 'string' },
      },
      required: ['user', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool ${req.params.name}`)
  const { user: who, text } = req.params.arguments as { user: string; text: string }
  const user = fromAlias(who)
  if (!allowedUsers().has(user)) return { isError: true, content: [{ type: 'text', text: '这个收件人没给我发过消息，不发。' }] }
  const ids: string[] = []
  const parts = splitUtf8(text)
  for (const [i, part] of parts.entries()) {
    // parts are sent in order, but parts sent within the same second can arrive out of order; space them out
    if (i > 0) await new Promise(r => setTimeout(r, 1200))
    const d = await api('message/send', { touser: user, msgtype: 'text', agentid: AGENT_ID, text: { content: part } })
    if (d?.errcode !== 0) {
      const hint = d?.errcode === 60020 ? '（企业可信 IP 没填本机出口地址）' : ''
      return { isError: true, content: [{ type: 'text', text: `发送失败 errcode ${d?.errcode} ${String(d?.errmsg ?? '').slice(0, 80)}${hint}` }] }
    }
    if (d.msgid) ids.push(d.msgid)
  }
  return { content: [{ type: 'text', text: `sent (${ids.length} part${ids.length === 1 ? '' : 's'})` }] }
})

const VOICE_EXT: Record<string, string> = { voice: 'amr', image: 'jpg', video: 'mp4' }

// ---- Voice transcription (OpenAI-compatible /audio/transcriptions, default Groq; can share a key with ringringring) ----
const STT_URL = ENV.WECOM_STT_URL || 'https://api.groq.com/openai/v1/audio/transcriptions'
const STT_MODEL = ENV.WECOM_STT_MODEL || 'whisper-large-v3-turbo'
// Optional short prompt (e.g. '以下是普通话的句子。' to bias toward Simplified Chinese). Default empty.
// Note: a long comma-separated list of names made Groq return empty text in testing; keep it short.
const STT_PROMPT = ENV.WECOM_STT_PROMPT ?? ''
const STT_PROVIDER = (ENV.WECOM_STT_PROVIDER || 'openai').toLowerCase()
const STT_ELEVEN_MODEL = ENV.WECOM_STT_ELEVEN_MODEL || 'scribe_v1'
function sttKey(names = ['GROQ_API_KEY', 'STT_KEY'], path = ENV.WECOM_STT_ENV_FILE): string {
  if (!path) return ''
  try {
    for (let line of readFileSync(path, 'utf8').split('\n')) {
      line = line.trim().replace(/^export /, '')
      if (names.some(n => line.startsWith(n + '='))) return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
  return ''
}
// ElevenLabs Scribe: not OpenAI format. Auth header xi-api-key, field model_id, JSON response with text.
// language_code takes ISO-639-3 (Chinese is zho, not zh).
async function scribe(wav: string, key: string): Promise<string> {
  const fd = new FormData()
  fd.append('model_id', STT_ELEVEN_MODEL)
  fd.append('language_code', 'zho')
  fd.append('tag_audio_events', 'false')
  fd.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'a.wav')
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: fd, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`Scribe HTTP ${r.status}`)
  return String(((await r.json()) as any)?.text ?? '').trim()
}
async function transcribe(amr: string): Promise<{ text?: string; err?: string }> {
  const elKey = STT_PROVIDER === 'elevenlabs' ? sttKey(['ELEVENLABS_API_KEY'], ENV.WECOM_STT_ELEVEN_ENV_FILE || ENV.WECOM_STT_ENV_FILE) : ''
  const key = sttKey()
  if (!key && !elKey) return { err: '没配转写 key' }
  const wav = amr.replace(/\.amr$/, '') + '.wav'
  const ff = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-i', amr, '-ac', '1', '-ar', '16000', '-af', 'dynaudnorm', wav], { stdout: 'ignore', stderr: 'ignore' })
  if ((await ff.exited) !== 0) return { err: 'ffmpeg 转码失败' }
  if (elKey) {
    try {
      const t = await scribe(wav, elKey)
      if (t) return { text: t }
    } catch {} // fall back to the Whisper API (never log key or response)
    if (!key) return { err: 'Scribe 失败且没配 Groq key' }
  }
  const ask = async (prompt: string) => {
    const fd = new FormData()
    fd.append('model', STT_MODEL)
    fd.append('language', 'zh')
    fd.append('temperature', '0')
    fd.append('response_format', 'text')
    if (prompt) fd.append('prompt', prompt)
    fd.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'a.wav')
    const r = await fetch(STT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`识别接口 HTTP ${r.status}`)
    return (await r.text()).trim()
  }
  try {
    let text = await ask(STT_PROMPT)
    if (!text && STT_PROMPT) text = await ask('') // the prompt sometimes makes it return empty; retry without it
    return text ? { text } : { err: '识别结果为空' }
  } catch (e: any) {
    return { err: String(e?.message ?? e?.name ?? '识别请求失败').slice(0, 60) }
  }
}

// ---- Call bubble: the phone plugin appends one line {at,dir,answered,seconds,via?} per call to WECOM_CALL_LOG; we forward it ----
const CALL_LOG = (ENV.WECOM_CALL_LOG || '').replace(/^~(?=\/|$)/, homedir()) // ~ is expanded, same as on the phone side
// CALL-HELPERS-BEGIN
function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
function bubbleText(rec: { answered?: boolean; seconds?: number }): string {
  return rec.answered ? `ᯅ 通话时长 ${fmtDuration(Number(rec.seconds) || 0)}` : 'ᯅ 未接通'
}
// Read from offset to the last newline; returns complete lines and the new offset. File shrank = truncated/rotated, re-read from 0
function readNewLines(path: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(path).size
  if (size < offset) offset = 0
  if (size === offset) return { lines: [], offset }
  const buf = Buffer.alloc(size - offset)
  const fd = openSync(path, 'r')
  try { readSync(fd, buf, 0, buf.length, offset) } finally { closeSync(fd) }
  const end = buf.lastIndexOf(10)
  if (end < 0) return { lines: [], offset }
  return { lines: buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean), offset: offset + end + 1 }
}
// CALL-HELPERS-END
async function sendBubble(rec: { answered?: boolean; seconds?: number; via?: string }) {
  const user = (ENV.WECOM_ALLOWED_USERS ?? '').split(',').filter(Boolean)[0]
  if (!user) return
  if (rec.via !== 'wechat') return // only calls started from WeChat (dial with via=wechat) get a bubble
  const d = await api('message/send', { touser: user, msgtype: 'text', agentid: AGENT_ID, text: { content: bubbleText(rec) } })
  if (d?.errcode !== 0) console.error(`[wecom] call bubble send failed errcode ${d?.errcode}`)
}
let callOffset = 0
function startCallWatcher() {
  if (!CALL_LOG) return
  try { callOffset = statSync(CALL_LOG).size } catch { callOffset = 0 } // start from the end, do not replay old calls
  setInterval(() => {
    (async () => {
      let r
      try { r = readNewLines(CALL_LOG, callOffset) } catch (e: any) { if (e?.code === 'ENOENT') callOffset = 0; return } // reset only if the file is missing; other read errors keep the offset to avoid re-sending old bubbles
      callOffset = r.offset
      for (const line of r.lines) {
        try { await sendBubble(JSON.parse(line)) } catch (e: any) { console.error(`[wecom] call bubble failed: ${e?.name ?? 'error'}`) }
      }
    })().catch(() => {})
  }, 2000)
}

async function pump() {
  let files: string[]
  try { files = readdirSync(INBOX).filter(f => f.endsWith('.json')).sort() } catch { return }
  for (const f of files) {
    const src = join(INBOX, f)
    let m: Record<string, string>
    try { m = JSON.parse(readFileSync(src, 'utf8')) } catch { continue }
    renameSync(src, join(DONE, f))
    const type = m.MsgType ?? ''
    const user = m.FromUserName ?? ''
    if (type === 'event') continue // subscribe / enter-app events etc., ignore
    rememberUser(user)
    const meta: Record<string, string> = {
      user: toAlias(user), msg_type: type,
      ts: new Date(Number(m.CreateTime ?? 0) * 1000).toISOString(),
      ...(m.MsgId ? { message_id: m.MsgId } : {}),
    }
    let content = ''
    if (type === 'text') content = m.Content ?? ''
    else if (type === 'image' || type === 'voice' || type === 'video') {
      const p = m.MediaId ? await downloadMedia(m.MediaId, VOICE_EXT[type]) : undefined
      if (p) meta[type === 'image' ? 'image_path' : `${type}_path`] = p
      content = `(${type}${p ? '' : '，下载失败'})`
      if (type === 'voice' && p) {
        const t = await transcribe(p)
        content = t.text ? `(语音) 转写：${t.text}` : `(语音，转写失败：${t.err})`
      }
    } else if (type === 'location') content = `(位置) ${m.Label ?? ''}`
    else if (type === 'link') content = `(链接) ${m.Title ?? ''} ${m.Url ?? ''}`
    else content = `(${type})`
    await mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })
  }
}

await mcp.connect(new StdioServerTransport())
setInterval(() => { pump().catch(() => {}) }, 1000)
startCallWatcher()
