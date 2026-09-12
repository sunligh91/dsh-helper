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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
 * "dsh-helper"。
 *
 * 关键（2026-09-12 实测）：仅注册 HKCU\Software\Classes\AppUserModelId
 * 这条注册表键**只提供显示名，不构成投递身份**。Microsoft 明文规定桌面
 * 程序必须在开始菜单有一条携带 System.AppUserModel.ID 的快捷方式
 * （learn.microsoft.com/windows/win32/shell/enable-desktop-toast-with-appusermodelid
 * ：「Without a valid shortcut installed in the Start screen or in All Programs,
 * you cannot raise a toast notification from a desktop app」）。
 * 缺这条快捷方式时，toast 会被**间歇性静默丢弃**（尤其在前台窗口存在时），
 * 表现为"焦点不在本应用就收不到通知"。
 *
 * 因此 apply() 启动时会调用 ensureAumidShortcut() 幂等补齐这条快捷方式。
 * 走运行时而非 npm 安装脚本的原因见该函数注释。
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

// ── AUMID 快捷方式（投递身份） ──────────────────────────────────────────────
//
// 为什么是"运行时自建"而不是"npm 安装脚本"：
//
//   Windows 要求桌面程序在开始菜单有一条携带 System.AppUserModel.ID 的
//   快捷方式，否则 toast 会被静默丢弃（Microsoft:
//   "Without a valid shortcut installed in the Start screen or in All Programs,
//    you cannot raise a toast notification from a desktop app"）。
//
//   这条快捷方式必须落在用户机器上（%APPDATA%\...\Start Menu\Programs），
//   它**不可能被打包进 npm 包**。而 DSH 也没有提供安装钩子：
//   dsh-package-manifest 的 DshManifest 只有 bundle/profile/client/
//   configTrees/sessionFormatMigration/moduleFallback，**没有任何生命周期钩子**；
//   靠 npm postinstall 又会被 pnpm >=10 拦下，要求用户手写 allowBuilds 授权
//   任意代码执行——对用户是负担，对分发是阻碍。
//
//   所以放进 apply()，启动时幂等补一次。好处：
//     1. 包内零安装钩子 → npm 打包/分发完全走普通路径，无需任何授权；
//     2. 自愈：快捷方式被删或被清理软件干掉，下次启动自动重建；
//     3. 无需管理员权限（写 HKCU/%APPDATA%）。
//
// target 指向什么并不影响投递身份（2026-09-12 实测：把 target 换成
// powershell.exe 后 toast 仍 2/2 送达）——身份只由 AUMID + 位于开始菜单决定。
// 因此这里指向 powershell.exe 做占位，避免硬编码任何机器特有的浏览器
// app-id；用户点它只是弹一个无害的 PowerShell 窗口。

/** 快捷方式所在目录（当前用户开始菜单）。 */
function startMenuProgramsDir() {
  const appData = process.env.APPDATA
  if (typeof appData !== 'string' || !appData) return ''
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
}

/**
 * 幂等确保存在一条带 System.AppUserModel.ID = TOAST_APP_ID 的开始菜单快捷方式。
 *
 * 已存在且 AUMID 正确时**不做任何写入**（避免每次启动都改文件）。
 * 任何失败都静默降级：通知本身仍有 psBalloon 兜底，不影响主功能。
 */
function ensureAumidShortcut() {
  if (process.platform !== 'win32') return
  const dir = startMenuProgramsDir()
  if (!dir) return
  const lnkPath = join(dir, `${TOAST_APP_ID}.lnk`)

  const script = `
$ErrorActionPreference = 'Stop'
$lnk = '${escapePs(lnkPath)}'
$aumid = '${escapePs(TOAST_APP_ID)}'
$dir = Split-Path -Parent $lnk
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$force = $false
if (Test-Path -LiteralPath $lnk) {
  try {
    $sc = New-Object -ComObject Shell.Application
    $f = $sc.Namespace($dir)
    $i = $f.ParseName((Split-Path -Leaf $lnk))
    $cur = $i.ExtendedProperty('System.AppUserModel.ID')
    if ($cur -eq $aumid) { Write-Output 'AUMID_OK'; exit 0 }
    $force = $true
  } catch { $force = $true }
}

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshAumidLnk {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] private class ShellLink { }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  private interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, IntPtr f, int fl);
    void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string p);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string p);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string p);
    void GetHotkey(out short k); void SetHotkey(short k);
    void GetShowCmd(out int s); void SetShowCmd(int s);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r);
    void Resolve(IntPtr h, int f);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
  }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
  private interface IPersistFile {
    void GetClassID(out Guid g); [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
  }
  [StructLayout(LayoutKind.Sequential, Pack=4)] private struct PK { public Guid f; public uint p; }
  [StructLayout(LayoutKind.Explicit)] private struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  private interface IPS { void GetCount(out uint c); void GetAt(uint i, out PK k); void GetValue(ref PK k, out PV v); void SetValue(ref PK k, ref PV v); void Commit(); }
  public static void Make(string lnk, string target, string wd, string desc, string aumid) {
    object o = new ShellLink();
    IShellLinkW l = (IShellLinkW)o;
    l.SetPath(target);
    if (wd != null && wd.Length > 0) l.SetWorkingDirectory(wd);
    if (desc != null && desc.Length > 0) l.SetDescription(desc);
    IPS s = (IPS)o;
    PK k = new PK(); k.f = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.p = 5;
    PV v = new PV(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(aumid);
    try { s.SetValue(ref k, ref v); } finally { Marshal.FreeCoTaskMem(v.p); }
    s.Commit();
    IPersistFile pf = (IPersistFile)o;
    pf.Save(lnk, true);
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp | Out-Null
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if ($force -and (Test-Path -LiteralPath $lnk)) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue }
[DshAumidLnk]::Make($lnk, $ps, (Split-Path -Parent $ps), 'DSH task notifications (dsh-helper)', $aumid)

$sc2 = New-Object -ComObject Shell.Application
$f2 = $sc2.Namespace($dir)
$i2 = $f2.ParseName((Split-Path -Leaf $lnk))
Write-Output ('AUMID_READBACK=' + $i2.ExtendedProperty('System.AppUserModel.ID'))
`
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'ignore' },
    )
    child.on('error', (e) => {
      if (debugLog) debugLog(`aumid shortcut spawn failed: ${e.message}`).catch(() => {})
    })
    child.on('exit', (code) => {
      if (debugLog) debugLog(`aumid shortcut exit: code=${code}`).catch(() => {})
    })
  } catch (e) {
    if (debugLog) debugLog(`aumid shortcut threw: ${e && e.message}`).catch(() => {})
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

  // 0. 投递身份：幂等补齐带 AUMID 的开始菜单快捷方式。
  //    Windows 缺这条快捷方式会静默丢弃 toast（详见 ensureAumidShortcut 注释）。
  //    fire-and-forget：不阻塞装配，失败由通知自带的 psBalloon 兜底。
  ensureAumidShortcut()

  // 1. 任务完成通知（agent 进入 idle）
  ctx.on('agent/status', ({ agent, status }) => {
    debugLog(`agent/status: status=${status} agent=${agent && agent.id}`)
    if (status !== 'idle') return
    if (!options.notifyOnComplete) return
    const sid = agent && agent.id
    const id = String(sid || '')
    // 子 agent（裸 UUID，主会话 id 才带 session- 前缀）不打扰：
    // dsh 并行跑多个子 agent，每个收尾都发一条会把通知中心刷爆
    if (id && !id.startsWith('session-')) {
      debugLog(`skip subagent idle: ${shortId(id)}`)
      return
    }
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
  //
  // 为什么监听 approval/asked（会话审计事件）而不是 approval/request（瀑布事件）：
  //
  // approval/request 是 cordis *waterfall* 事件——"Each listener wraps the rest
  // of the chain: calling next() invokes the next listener; not calling it
  // vetoes"（@deepseek-ai/cordis events.d.ts）。任何排在前面且直接 return 结果
  // （不调 next()）的监听器都会**终结整条链**，后面的监听器再也收不到事件。
  // 现实中 dsh-approval-gate 正是以 `ctx.on('approval/request', h, { prepend: true })`
  // 抢占队首，命中白名单/Flash 判定 SAFE 时直接 `return 'allowed-once'`，
  // 于是本插件这段监听器**从未执行过一次**（诊断日志中 'approval/request:' 计数恒为 0），
  // 而 gate 转人工时（内部 await next()）反而能收到——通知时有时无，极难排查。
  //
  // approval/asked 是 ApprovalService.request() 在派发瀑布**之前**写入会话日志的
  // 审计事件，与 approval/decided 配对；它是 log-only、不带 surfaceOp、不参与决策，
  // 因此**任何人都无法拦截或抢答**。监听它，通知的到达就不再取决于别的插件怎么排队。
  //
  // session/event 同样是广播 firehose（签名 (session, event)、无 next、无 veto），
  // 作用域过滤只影响 agent 作用域的监听器；本插件在裸 ctx 上注册即全局可见。
  //
  // 注意 approval/asked 的 data 里只有 { id, toolName, callId?, reason? }，
  // 不含 agent——会话 id 从 session/event 的第一个参数取。
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'approval/asked') return
    const data = event.data || {}
    const tool = data.toolName
    const sid = session && session.id
    debugLog(`approval/asked: tool=${tool} session=${sid}`)
    if (!options.notifyOnPermission) return
    const reason = firstLine(data.reason)
    notify(
      '🔐 需要授权',
      `会话 ${shortId(sid)} 请求执行 ${tool || '工具'}${reason ? `：${reason}` : ''}`,
    )
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
