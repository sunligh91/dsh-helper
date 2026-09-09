# dsh-helper

[![npm version](https://img.shields.io/npm/v/dsh-helper)](https://www.npmjs.com/package/dsh-helper) [![npm downloads](https://img.shields.io/npm/dm/dsh-helper)](https://www.npmjs.com/package/dsh-helper) [![GitHub stars](https://img.shields.io/github/stars/sunligh91/dsh-helper)](https://github.com/sunligh91/dsh-helper/stargazers) [![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[![支持 DSH 版本：0.1.2-rc.1+](https://img.shields.io/badge/DSH-0.1.2--rc.1%2B-blue)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![平台](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/sunligh91/dsh-helper)

[![任务通知](https://img.shields.io/badge/-任务通知-4dc6fe)](https://github.com/sunligh91/dsh-helper) [![设置面板](https://img.shields.io/badge/-设置面板-4dc6fe)](https://github.com/sunligh91/dsh-helper) [![零构建](https://img.shields.io/badge/-零构建-4dc6fe)](https://github.com/sunligh91/dsh-helper)

🌏 [English](./README.md) · [**中文**](./README.zh.md)

> 一个 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件：当 agent 会话**完成**、**异常**或**需要你确认**时弹出 Windows 原生通知，完成时还可附带提示音——长任务可以放手不管，出事的瞬间你会知道。

## ✨ 功能一览

- **🔔 任务通知** — agent 进入空闲（任务完成）、出错、或即将向你提问时，弹出 Windows 原生 Toast。
- **🔊 完成音效** — 会话完成时播放提示音。随包内置一段合成的双音提示音；音量可调（0–100），也可指定任意本地音频文件（wav / mp3 / wma）。
- **⚙️ 设置面板** — DSH 设置页新增「任务通知 (dsh-helper)」分区：三个通知开关 + 音效控制。
- **🧪 测试按钮** — 一键发送测试通知并按当前设置试听音效，验证本机链路是否正常。
- **🪶 零原生依赖** — 通知走 PowerShell WinRT Toast，无需编译任何二进制。
- **🔁 热重载** — 配置写回 profile 的 `cordis.patch.yml`，由 DSH 的 patch watcher 自动生效，无需重启。

## 🚀 安装

**前置条件**：DSH `0.1.2-rc.1+`，且 `web` profile 已初始化（至少跑过一次 `dsh web`），Node.js ≥ 20、pnpm ≥ 10。

### 方式一 — npm

```bash
# 从 git 仓库安装（当前可用）
npm install github:sunligh91/dsh-helper

# 或从 npm registry 安装
npm install dsh-helper
```

然后注册到 web profile：

```bash
dsh plugin --profile web add dsh-helper@latest
```

### 方式二 — DSH 一行命令

```bash
dsh plugin --profile web add dsh-helper@latest
```

> 若 pnpm 11 拦截了构建脚本，先在 `~/.dsh/profiles/web` 下执行 `pnpm approve-builds --all`，再重跑上面的命令。

### 方式三 — 从源码安装

```bash
git clone https://github.com/sunligh91/dsh-helper.git
cd dsh-helper

# 链接到你的 web profile
cd ~/.dsh/profiles/web
pnpm add file:/绝对路径/dsh-helper
```

然后把 `"dsh-helper"` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组，并**硬刷新**浏览器（Ctrl/Cmd + Shift + R）。

## ⚙️ 配置

进入 **设置 → 任务通知 (dsh-helper)**。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `notifyOnComplete` | `true` | 会话完成时通知（同一会话 60 秒内去重）。 |
| `notifyOnError` | `true` | 会话出错时通知。 |
| `notifyOnConfirm` | `true` | agent 即将提问时通知。 |
| `soundOnComplete` | `true` | 完成通知后播放提示音。 |
| `soundVolume` | `70` | 提示音音量，`0`–`100`。 |
| `soundFile` | `""` | 本地音频文件路径（wav / mp3 / wma）。留空用内置提示音；自定义文件不存在时回退到内置提示音，再回退到 Windows 系统自带提示音。 |

默认值随包附在 `cordis.patch.yml`；你的改动会写入 `~/.dsh/profiles/web/cordis.patch.yml`。

## 🔌 工作原理

| DSH 事件 | 行为 |
| --- | --- |
| `agent/status`（`idle`） | 弹出「任务完成」通知 + 播放提示音 |
| `agent/request-error` | 弹出「任务异常」通知（纯放行，不做任何拦截或重试） |
| `tools/pre-execute`（`ask_user_question`） | 弹出「需要确认」通知 |

设置路由（`/_dsh/dsh-helper/settings`）仅监听本机，非 `127.0.0.1` / `::1` 的请求一律返回 `403`。

> 🔄 **还需要自动重试？** 本插件只做通知，这是有意为之。可搭配专门的重试插件，例如 [`dsh-task-reliability`](https://www.npmjs.com/package/dsh-task-reliability)（它在同一事件上返回 `{ kind: 'retry' }` 触发 DSH 原生重试）。

## 🛠️ 开发与构建

```bash
git clone https://github.com/sunligh91/dsh-helper.git
cd dsh-helper
```

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主侧 — cordis 插件：事件钩子 + 设置路由 |
| `lib/client.js` | 客户端侧 — 通过 `window.__ModuleLoader__` 注册，无需构建 |
| `cordis.patch.yml` | 注入 profile 的默认配置 |

两侧都是原生 ES module / UMD，没有打包器，改完刷新即可。

## ⚠️ 已知限制

- 通知面向 Windows（PowerShell WinRT Toast）。在 macOS/Linux 上插件仍会加载，但通知和音效都是静默空操作。
- 音效走 PowerShell + WPF MediaPlayer；不可用时退回 `System.Media.SoundPlayer`（仅支持 wav，且音量设置不生效）。
- 若 Windows「专注助手 / 勿扰」开启，通知可能被拦截。
- 通知以 Windows 内置的「文件资源管理器」应用 id（已注册 AUMID）发送，无需开始菜单快捷方式、不会被静默丢弃；在通知中心里会归到「文件资源管理器」名下。

## 📄 许可证

[MIT](./LICENSE) © sunligh91

## 📝 更新日志

- **0.4.0** — 新增「需要授权」通知（钩 `approval/request` 事件，工具权限审批时提醒）；设置面板拆分为三个测试按钮：完成 / 多选一确认 / 权限审批。
- **0.3.2** — 修复确认通知不显示：Windows 会静默丢弃未注册自定义应用 id 的 Toast，现改用文件资源管理器的注册 AUMID 发送；新增 WScript.Shell 弹窗兜底。
- **0.3.1** — 加入临时诊断日志（确认问题解决后移除）。
- **0.3.0** — 新增完成音效（内置合成双音、音量可调、可指定本地文件）。
- **0.2.0** — 移除自动重试，专注通知。
- **0.1.0** — 首个版本：完成 / 异常 / 确认通知。
