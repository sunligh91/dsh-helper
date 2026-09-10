# dsh-helper

[![npm version](https://img.shields.io/npm/v/dsh-helper)](https://www.npmjs.com/package/dsh-helper) [![npm downloads](https://img.shields.io/npm/dm/dsh-helper)](https://www.npmjs.com/package/dsh-helper) [![GitHub stars](https://img.shields.io/github/stars/sunligh91/dsh-helper)](https://github.com/sunligh91/dsh-helper/stargazers) [![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[![Supported DSH: 0.1.2-rc.1+](https://img.shields.io/badge/DSH-0.1.2--rc.1%2B-blue)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/sunligh91/dsh-helper)

[![task notifications](https://img.shields.io/badge/-task%20notifications-4dc6fe)](https://github.com/sunligh91/dsh-helper) [![settings panel](https://img.shields.io/badge/-settings%20panel-4dc6fe)](https://github.com/sunligh91/dsh-helper) [![zero build](https://img.shields.io/badge/-zero%20build-4dc6fe)](https://github.com/sunligh91/dsh-helper)

🌏 [**English**](./README.md) · [中文](./README.zh.md)

> A [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that pops native Windows notifications when an agent session **finishes**, **fails**, or **needs your confirmation** — with an optional completion chime — so you can walk away from long runs and still know the moment something needs you.

## ✨ Features

- **🔔 Task notifications** — a native Windows toast when the agent goes idle (task complete), hits an error, is about to ask you a question, or a tool needs permission approval.
- **🔊 Completion chime** — plays a sound when a session finishes. Ships with a built-in synthesized two-note chime; volume is adjustable (0–100) and you can point it at any local audio file (wav / mp3 / wma).
- **⚙️ Settings panel** — a **Task Notifications (dsh-helper)** section in DSH Settings with four notification toggles plus the sound controls.
- **🧪 Three test buttons** — preview each real notification type (complete / multi-choice confirm / permission approval) with one click.
- **🪶 Zero native dependencies** — notifications go through PowerShell WinRT Toast, so there is nothing to compile.
- **🔁 Hot reload** — configuration is written back to the profile's `cordis.patch.yml` and picked up by DSH's patch watcher, no restart needed.

## 🚀 Installation

**Prerequisites**: DSH `0.1.2-rc.1+` with the `web` profile already initialized (run `dsh web` at least once), Node.js ≥ 20, pnpm ≥ 10.

### Option 1 — npm

```bash
# from the git repo (works today)
npm install github:sunligh91/dsh-helper

# or from the npm registry
npm install dsh-helper
```

Then register it with your web profile:

```bash
dsh plugin --profile web add dsh-helper@latest
```

### Option 2 — one-liner through DSH

```bash
dsh plugin --profile web add dsh-helper@latest
```

> If pnpm 11 blocks build scripts, run `pnpm approve-builds --all` inside `~/.dsh/profiles/web` and re-run the command.

### Option 3 — from source

```bash
git clone https://github.com/sunligh91/dsh-helper.git
cd dsh-helper

# link it into your web profile
cd ~/.dsh/profiles/web
pnpm add file:/absolute/path/to/dsh-helper
```

Then add `"dsh-helper"` to the `dsh.profile.bundles` array in `~/.dsh/profiles/web/package.json`, and **hard-refresh** your browser (Ctrl/Cmd + Shift + R).

## ⚙️ Configuration

Go to **Settings → Task Notifications (dsh-helper)**.

| Key | Default | Description |
| --- | --- | --- |
| `notifyOnComplete` | `true` | Notify when a session finishes (deduped to once per 60 s per session). |
| `notifyOnError` | `true` | Notify when a session hits an error. |
| `notifyOnConfirm` | `true` | Notify when the agent is about to ask you a question (multi-choice). |
| `notifyOnPermission` | `true` | Notify when a tool triggers a permission approval dialog. |
| `soundOnComplete` | `true` | Play the completion chime after the completion toast. |
| `soundVolume` | `70` | Chime volume, `0`–`100`. |
| `soundFile` | `""` | Path to a local audio file (wav / mp3 / wma). Empty = the bundled chime; if the custom file is missing it falls back to the bundled chime, then to Windows built-in notify sounds. |

Defaults ship in `cordis.patch.yml`; your overrides are written to `~/.dsh/profiles/web/cordis.patch.yml`.

## 🔌 How it works

| DSH event | Behaviour |
| --- | --- |
| `agent/status` (`idle`) | Completion toast + chime |
| `agent/request-error` | Error toast (passthrough — this plugin never blocks or retries) |
| `tools/pre-execute` (`ask_user_question`) | Confirmation toast (multi-choice question) |
| `approval/request` | Permission toast (tool approval; observe-and-forward only, never blocks) |

The settings HTTP route (`/_dsh/dsh-helper/settings`) is bound to localhost only — anything other than `127.0.0.1` / `::1` gets a `403`.

> 🔄 **Need auto-retry too?** This plugin intentionally does notifications only. Pair it with a retry plugin such as [`dsh-task-reliability`](https://www.npmjs.com/package/dsh-task-reliability), which returns `{ kind: 'retry' }` on the same event.

## 🛠️ Development

```bash
git clone https://github.com/sunligh91/dsh-helper.git
cd dsh-helper
```

| File | Role |
| --- | --- |
| `lib/index.js` | Host half — cordis plugin: event hooks + settings route |
| `lib/client.js` | Client half — registered via `window.__ModuleLoader__`, no build step |
| `cordis.patch.yml` | Default configuration inserted into the profile |

Both halves are plain ES modules / UMD — there is no bundler, so edit and reload.

## ⚠️ Known limitations

- Notifications target Windows (PowerShell WinRT Toast). On macOS/Linux the plugin still loads, but toasts and sounds are silent no-ops.
- Sound playback uses WPF MediaPlayer via PowerShell. If that's unavailable it falls back to `System.Media.SoundPlayer`, which only plays wav and ignores the volume setting.
- If Windows Focus Assist / Do Not Disturb is on, toasts may be suppressed.
- Toasts are sent under Windows' built-in File Explorer app id (a registered AUMID), so no Start-Menu shortcut is required and notifications are never silently dropped for an unregistered custom id. They'll appear in Action Center grouped under "File Explorer".

## 📄 License

[MIT](./LICENSE) © sunligh91

## 📝 Changelog

- **0.4.1** — Fixed notifications falling back to a popup dialog: `GetTemplateContent` was mistakenly called on the `ToastNotifier` instance (the method belongs to the static `ToastNotificationManager` class), so the WinRT toast never actually succeeded and every notification took the WScript dialog fallback. Now calls the correct target — real toasts verified.
- **0.4.0** — Added a "needs permission" notification (hooks the `approval/request` event for tool approval dialogs); the settings panel now has three test buttons: complete / multi-choice confirm / permission.
- **0.3.2** — Fixed confirmation toasts not appearing. Windows silently drops WinRT toasts sent under an unregistered custom app id, so notifications are now sent under File Explorer's always-registered AUMID. Added a `WScript.Shell` popup fallback for environments where WinRT is unavailable.
- **0.3.1** — Added temporary diagnostic logging (to be removed once the confirm-notification issue is verified resolved).
- **0.3.0** — Added an optional completion chime (built-in synthesized two-note sound, adjustable volume, custom local file).
- **0.2.0** — Removed auto-retry; notifications only.
- **0.1.0** — Initial release: completion / error / confirm notifications.
