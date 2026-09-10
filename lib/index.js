/**
 * dsh-helper — host half.
 *
 * 功能：agent 会话任务完成 / 异常 / 需要确认时，弹 Windows 通知
 * （PowerShell WinRT Toast）；任务完成可附带提示音（WPF MediaPlayer，
 * 可调音量、可指定本地音频文件，默认播放随包内置的合成双音）。
 *
 * 配置：写回 profile 层 cordis.patch.yml（与 dsh-task-reliability 同一套
 * dsh-shared 工具），dsh 的 watchUserPatches 热重载。
 *
 * 安全：设置路由仅监听 127.0.0.1；退出无残留（effect 自动反注册）。
 */

import { spawn } from 'node:child_process'
import { readFile, unlink, access, appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { currentProfile, patchFileOf, writePatchConfig } from 'dsh-shared'

export const name = 'dsh-helper'

export const inject = ['webServer']

const SETTINGS_ROUTE = '/_dsh/dsh-helper/settings'

const DEFAULTS = {
  notifyOnComplete: true,
  notifyOnError: true,
  notifyOnConfirm: true,
  notifyOnPermission: true,
  soundOnComplete: true,
  soundVolume: 70,
  soundFile: '',
}

// Windows 自带提示音，作为「内置文件缺失」时的最后兜底（按优先级）。
const SYSTEM_SOUND_FALLBACKS = [
  'C:\\Windows\\Media\\Windows Notify System Generic.wav',
  'C:\\Windows\\Media\\Windows Notify.wav',
  'C:\\Windows\\Media\\notify.wav',
  'C:\\Windows\\Media\\chimes.wav',
]

// ── 配置 ───────────────────────────────────────────────────────────────────

function mergeConfig(input) {
  const c = input && typeof input === 'object' ? input : {}
  const out = { ...DEFAULTS, ...c }
  out.notifyOnComplete = out.notifyOnComplete !== false
  out.notifyOnError = out.notifyOnError !== false
  out.notifyOnConfirm = out.notifyOnConfirm !== false
  out.notifyOnPermission = out.notifyOnPermission !== false
  out.soundOnComplete = out.soundOnComplete !== false
  const vol = Number(out.soundVolume)
  out.soundVolume = Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : DEFAULTS.soundVolume
  out.soundFile = typeof out.soundFile === 'string' ? out.soundFile : ''
  return out
}

function configToPlain(o) {
  return {
    notifyOnComplete: o.notifyOnComplete,
    notifyOnError: o.notifyOnError,
    notifyOnConfirm: o.notifyOnConfirm,
    notifyOnPermission: o.notifyOnPermission,
    soundOnComplete: o.soundOnComplete,
    soundVolume: o.soundVolume,
    soundFile: o.soundFile,
  }
}

// ── Windows 通知 ──────────────────────────────────────────────────────────

function escapePs(s) {
  return String(s).replace(/'/g, "''")
}

/**
 * WinRT Toast 的应用标识（AUMID）与显示名。
 *
 * 通知顶部显示的名字来自 AUMID 的注册信息：Windows 先在
 * `HKCU\Software\Classes\AppUserModelId\<AUMID>` 里查 `DisplayName`，
 * 查不到就回落显示原始 AUMID 字符串（此前借用 File Explorer 的
 * `{1AC14E77-…}\explorer.exe` 时，用户看到的正是那串十六进制）。
 *
 * 现在用自有 AUMID + 每次发送前幂等写入 DisplayName，通知顶部即显示
 * "dsh-helper"。若某些 Windows 版本对无快捷方式的 AUMID 静默丢弃通知，
 * 会由 psBalloon 兜底为可见弹窗，不会静默失败。
 */
const TOAST_APP_ID = 'dsh-helper'
const TOAST_APP_NAME = 'dsh-helper'

/**
 * 通过 PowerShell WinRT Toast 弹 Windows 通知。零外部依赖。
 * 脚本以 UTF-16LE base64 经 -EncodedCommand 传入，中文不乱码。
 * 若 WinRT 完全不可用（spawn 报错 / 进程非零退出），退化到 WScript.Shell
 * 弹窗，保证至少有可见提示。
 */
function psToast(title, body) {
  const script = `
$ErrorActionPreference = 'Stop'
$appId = '${TOAST_APP_ID}'
try {
  $key = "HKCU:\\Software\\Classes\\AppUserModelId\\$appId"
  New-Item -Path $key -Force -ErrorAction SilentlyContinue | Out-Null
  Set-ItemProperty -Path $key -Name DisplayName -Value '${escapePs(TOAST_APP_NAME)}' -ErrorAction SilentlyContinue
} catch {}
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$tn = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('${escapePs(title)}')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode('${escapePs(body)}')) | Out-Null
$tn.Show([Windows.UI.Notifications.ToastNotification]::new($t))
`
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'ignore' },
    )
    child.on('error', () => psBalloon(title, body))
    child.on('exit', (code, signal) => {
      if (typeof debugLog === 'function') {
        debugLog(`psToast exit: code=${code} signal=${signal} title=${title}`).catch(() => {})
      }
      if ((code !== 0 && code !== null) || signal) psBalloon(title, body)
    })
  } catch {
    /* 忽略：powershell 缺失时静默失败 */
  }
}

/**
 * 兜底提示：当 WinRT Toast 完全不可用（如 COM 未注册）时，用 WScript.Shell
 * 弹一个自动消失(8s)的对话框，保证至少有可见反馈。
 */
function psBalloon(title, body) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$sh.Popup('${escapePs(body)}', 8, '${escapePs(title)}', 0x40) | Out-Null
`
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'ignore' },
    )
    child.on('error', () => {})
  } catch {
    /* 忽略 */
  }
}

/**
 * 弹通知。可选引入 node-notifier 提升可靠性（需在 dependencies 里加
 * node-notifier），否则走 PowerShell WinRT Toast。
 */
function notify(title, body) {
  const t = typeof title === 'string' ? title : 'dsh-helper'
  const b = typeof body === 'string' ? body : ''
  psToast(t, b)
}

// ── 提示音 ─────────────────────────────────────────────────────────────────

async function fileExists(p) {
  if (!p) return false
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 解析要播放的音频文件：自定义文件 > 随包内置 notify.wav > Windows 自带提示音。
 * 返回空字符串表示找不到任何可播放文件。
 */
async function resolveSoundFile(options) {
  const custom = typeof options.soundFile === 'string' ? options.soundFile.trim() : ''
  if (custom && (await fileExists(custom))) return custom
  const builtin = fileURLToPath(new URL('./notify.wav', import.meta.url))
  if (await fileExists(builtin)) return builtin
  for (const p of SYSTEM_SOUND_FALLBACKS) {
    if (await fileExists(p)) return p
  }
  return ''
}

/**
 * 用 PowerShell + WPF MediaPlayer 播放音频（支持 wav/mp3/wma，可调音量）。
 * MediaPlayer 是异步播放，脚本按媒体时长等待后退出；PresentationCore 不可用
 * 时退回 Media.SoundPlayer（仅 wav，音量不生效）。
 */
function psSound(file, volumePct) {
  if (!file) return
  const vol = (Math.max(0, Math.min(100, Number(volumePct) || 0)) / 100).toFixed(2)
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName PresentationCore | Out-Null
  $p = New-Object System.Windows.Media.MediaPlayer
  $p.Open([Uri]::new('${escapePs(file)}'))
  $p.Volume = ${vol}
  Start-Sleep -Milliseconds 300
  $p.Play()
  $waited = $false
  try {
    $d = $p.NaturalDuration
    if ($d -and $d.HasTimeSpan) {
      Start-Sleep -Milliseconds ([int][math]::Ceiling($d.TimeSpan.TotalMilliseconds) + 400)
      $waited = $true
    }
  } catch {}
  if (-not $waited) { Start-Sleep -Milliseconds 2500 }
  $p.Close()
} catch {
  try { (New-Object System.Media.SoundPlayer('${escapePs(file)}')).PlaySync() } catch {}
}`
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'ignore' },
    )
    child.on('error', () => {})
  } catch {
    /* 忽略：powershell 缺失时静默失败 */
  }
}

/** 按当前配置解析并播放提示音（fire-and-forget）。 */
function playSound(options) {
  if (!options.soundOnComplete) return
  resolveSoundFile(options).then((f) => psSound(f, options.soundVolume)).catch(() => {})
}

// ── 工具 ───────────────────────────────────────────────────────────────────

const shortId = (id) => (typeof id === 'string' && id.length > 8 ? `…${id.slice(-6)}` : String(id ?? 'unknown'))

/** 诊断日志（临时）：追加到 profile 目录下 cordis.patch.yml.dsh-helper.log。 */
async function debugLog(msg) {
  try {
    const file = `${patchFileOf(currentProfile())}.dsh-helper.log`
    await appendFile(file, `${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch {
    /* 诊断日志失败不影响功能 */
  }
}

/** 取多行文本的首行并截断（用于通知正文）。 */
function firstLine(text, max = 80) {
  if (typeof text !== 'string') return ''
  const line = text.trim().split('\n')[0] || ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function firstQuestionText(args) {
  try {
    const questions = args && args.questions
    if (!Array.isArray(questions) || questions.length === 0) return ''
    const first = questions[0]
    if (!first || typeof first !== 'object') return ''
    const text = typeof first.question === 'string' && first.question !== ''
      ? first.question
      : (typeof first.header === 'string' ? first.header : '')
    const line = text.split('\n')[0]
    return line.length > 80 ? `${line.slice(0, 80)}…` : line
  } catch {
    return ''
  }
}

// ── 设置路由 ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      if (chunks.reduce((n, c) => n + c.length, 0) > 256 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(status)
  res.end(bytes)
}

function snapshot(shared) {
  return {
    settings: { value: configToPlain(shared.options), revision: shared.revision },
    writable: true,
  }
}

/**
 * 写回配置。dsh 在「无用户覆盖」时会把 profile 层 cordis.patch.yml 写成
 * 字面量 `[]`（一个 YAML 数组文档）。dsh-shared 的 writePatchConfig 把该
 * 文件当作「`- id:` 条目列表」处理，若原文件是 `[]`，它会保留 `[]` 再在其后
 * 追加我的条目，产出 `[]\n- id: …` 这种非法两文档 YAML，导致 dsh 下次启动
 * 解析 overlay 直接崩溃。这里在写入前把 `[]` / 空白归一为「无文件」状态，
 * 让 writePatchConfig 从干净的单条目文档起步。
 */
async function safeWritePatch(file, rowId, config) {
  try {
    const cur = (await readFile(file, 'utf8')).trim()
    if (cur === '[]' || cur === '') {
      await unlink(file).catch(() => {})
    }
  } catch {
    /* 文件不存在：writePatchConfig 会按初次写入处理 */
  }
  await writePatchConfig(file, rowId, config)
}

async function saveConfig(shared, value) {
  const next = mergeConfig(value)
  await safeWritePatch(patchFileOf(currentProfile()), 'dsh-helper', configToPlain(next))
  Object.assign(shared.options, next)
  shared.revision = (shared.revision || 0) + 1
}

async function handleRoute(req, res, shared) {
  const remote = String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '')
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'dsh-helper settings route is localhost-only' } })
    return
  }
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, value: snapshot(shared) })
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } })
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'bad json' } })
    return
  }
  try {
    if (body && body.action === 'save') {
      await saveConfig(shared, body.value || {})
      sendJson(res, 200, { ok: true, value: snapshot(shared) })
    } else if (body && body.action === 'test') {
      // kind: complete（默认，附音效）/ confirm（多选一确认）/ permission（工具授权）
      const kind = typeof body.kind === 'string' ? body.kind : 'complete'
      if (kind === 'confirm') {
        notify('❓ 需要确认', '会话 …test：这是一条测试确认（多选一），请选择一个选项？')
      } else if (kind === 'permission') {
        notify('🔐 需要授权', '会话 …test 请求执行 bash：这是一条测试授权请求')
      } else {
        notify('✅ 任务完成', '会话 …test 已完成（测试）')
        playSound(shared.options)
      }
      sendJson(res, 200, { ok: true, value: { ok: true, kind } })
    } else {
      sendJson(res, 400, { ok: false, error: { code: 'invalid-action', message: 'unsupported action' } })
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: { code: 'rejected', message: String(error && error.message ? error.message : error) } })
  }
}

// ── 装配 ───────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const options = mergeConfig(config)
  const shared = {
    ctx,
    options,
    revision: 0,
    lastIdle: new Map(),
  }

  // 1. 任务完成通知（agent 进入 idle）
  ctx.on('agent/status', ({ agent, status }) => {
    debugLog(`agent/status: status=${status} agent=${agent && agent.id}`)
    if (status !== 'idle') return
    if (!options.notifyOnComplete) return
    const sid = agent && agent.id
    const now = Date.now()
    const last = shared.lastIdle.get(sid)
    if (last && now - last < 60000) return // 1 分钟内同一会话去重
    shared.lastIdle.set(sid, now)
    notify('✅ 任务完成', `会话 ${shortId(sid)} 已完成`)
    playSound(options)
  })

  // 2. 异常通知（agent 请求错误）
  ctx.on('agent/request-error', async (payload, next) => {
    const agent = payload && payload.agent
    const sid = agent && agent.id
    const failure = payload && payload.failure
    const code = failure && typeof failure.code === 'string' ? failure.code : ''
    debugLog(`agent/request-error: code=${code} agent=${sid}`)
    if (options.notifyOnError) {
      notify('⚠️ 任务异常', `会话 ${shortId(sid)} 出错${code ? ` (${code})` : ''}`)
    }
    return next()
  })

  // 3. 需要确认通知（ask_user_question 即将弹出）
  ctx.on('tools/pre-execute', (exec, next) => {
    debugLog(`tools/pre-execute: name=${exec && exec.name} agent=${exec && exec.agent && exec.agent.id}`)
    if (exec && exec.name === 'ask_user_question') {
      if (options.notifyOnConfirm) {
        const q = firstQuestionText(exec.arguments)
        debugLog(`confirm match: notifying, q=${q}`)
        notify('❓ 需要确认', q ? `会话 ${shortId(exec.agent && exec.agent.id)}：${q}` : '有任务需要你的确认')
      }
    }
    return next()
  })

  // 3.5 需要授权通知（工具被权限策略拦下、即将弹审批对话框）
  //     事件为 waterfall：只旁观并转发 next()，绝不拦截审批决定。
  ctx.on('approval/request', (req, next) => {
    const tool = req && req.toolName
    debugLog(`approval/request: tool=${tool} agent=${req && req.agent && req.agent.id}`)
    if (options.notifyOnPermission) {
      const reason = firstLine(req && req.reason)
      notify(
        '🔐 需要授权',
        `会话 ${shortId(req && req.agent && req.agent.id)} 请求执行 ${tool || '工具'}${reason ? `：${reason}` : ''}`,
      )
    }
    return next()
  })

  // 4. 设置路由
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: SETTINGS_ROUTE,
      handler: (req, res) => handleRoute(req, res, shared),
    })
    return () => dispose()
  }, 'dsh-helper: settings route')

  debugLog('apply: dsh-helper loaded, hooks registered')

  return shared
}
