/**
 * dsh-helper — host half.
 *
 * 功能：agent 会话任务完成 / 异常 / 需要确认时，弹 Windows 通知
 * （PowerShell WinRT Toast，零外部依赖）。
 *
 * 配置：写回 profile 层 cordis.patch.yml（与 dsh-task-reliability 同一套
 * dsh-shared 工具），dsh 的 watchUserPatches 热重载。
 *
 * 安全：设置路由仅监听 127.0.0.1；退出无残留（effect 自动反注册）。
 */

import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { currentProfile, patchFileOf, writePatchConfig } from 'dsh-shared'

export const name = 'dsh-helper'

export const inject = ['webServer']

const SETTINGS_ROUTE = '/_dsh/dsh-helper/settings'

const DEFAULTS = {
  notifyOnComplete: true,
  notifyOnError: true,
  notifyOnConfirm: true,
}

// ── 配置 ───────────────────────────────────────────────────────────────────

function mergeConfig(input) {
  const c = input && typeof input === 'object' ? input : {}
  const out = { ...DEFAULTS, ...c }
  out.notifyOnComplete = out.notifyOnComplete !== false
  out.notifyOnError = out.notifyOnError !== false
  out.notifyOnConfirm = out.notifyOnConfirm !== false
  return out
}

function configToPlain(o) {
  return {
    notifyOnComplete: o.notifyOnComplete,
    notifyOnError: o.notifyOnError,
    notifyOnConfirm: o.notifyOnConfirm,
  }
}

// ── Windows 通知 ──────────────────────────────────────────────────────────

function escapePs(s) {
  return String(s).replace(/'/g, "''")
}

/**
 * 通过 PowerShell WinRT Toast 弹 Windows 通知。零外部依赖。
 * 脚本以 UTF-16LE base64 经 -EncodedCommand 传入，中文不乱码。
 */
function psToast(title, body) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('dsh-helper') | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('${escapePs(title)}')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode('${escapePs(body)}')) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('dsh-helper').Show([Windows.UI.Notifications.ToastNotification]::new($t))
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
    /* 忽略：powershell 缺失时静默失败 */
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

// ── 工具 ───────────────────────────────────────────────────────────────────

const shortId = (id) => (typeof id === 'string' && id.length > 8 ? `…${id.slice(-6)}` : String(id ?? 'unknown'))

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
      notify('✅ 测试通知', 'dsh-helper 通知链路正常')
      sendJson(res, 200, { ok: true, value: { ok: true } })
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
    if (status !== 'idle') return
    if (!options.notifyOnComplete) return
    const sid = agent && agent.id
    const now = Date.now()
    const last = shared.lastIdle.get(sid)
    if (last && now - last < 60000) return // 1 分钟内同一会话去重
    shared.lastIdle.set(sid, now)
    notify('✅ 任务完成', `会话 ${shortId(sid)} 已完成`)
  })

  // 2. 异常通知（agent 请求错误）
  ctx.on('agent/request-error', async (payload, next) => {
    const agent = payload && payload.agent
    const sid = agent && agent.id
    const failure = payload && payload.failure
    const code = failure && typeof failure.code === 'string' ? failure.code : ''
    if (options.notifyOnError) {
      notify('⚠️ 任务异常', `会话 ${shortId(sid)} 出错${code ? ` (${code})` : ''}`)
    }
    return next()
  })

  // 3. 需要确认通知（ask_user_question 即将弹出）
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec && exec.name === 'ask_user_question') {
      if (options.notifyOnConfirm) {
        const q = firstQuestionText(exec.arguments)
        notify('❓ 需要确认', q ? `会话 ${shortId(exec.agent && exec.agent.id)}：${q}` : '有任务需要你的确认')
      }
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

  return shared
}
