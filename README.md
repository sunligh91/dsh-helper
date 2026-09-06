# dsh-helper

[![npm version](https://img.shields.io/npm/v/dsh-helper)](https://www.npmjs.com/package/dsh-helper) [![npm downloads](https://img.shields.io/npm/dm/dsh-helper)](https://www.npmjs.com/package/dsh-helper) [![GitHub stars](https://img.shields.io/github/stars/sunligh91/dsh-helper)](https://github.com/sunligh91/dsh-helper/stargazers) [![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[![Supported DSH: 0.1.2-rc.1+](https://img.shields.io/badge/DSH-0.1.2--rc.1%2B-blue)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/sunligh91/dsh-helper)

[![task notifications](https://img.shields.io/badge/-task%20notifications-4dc6fe)](https://github.com/sunligh91/dsh-helper) [![auto retry](https://img.shields.io/badge/-auto%20retry-4dc6fe)](https://github.com/sunligh91/dsh-helper) [![settings panel](https://img.shields.io/badge/-settings%20panel-4dc6fe)](https://github.com/sunligh91/dsh-helper) [![zero build](https://img.shields.io/badge/-zero%20build-4dc6fe)](https://github.com/sunligh91/dsh-helper)

🌏 [**English**](./README.md) · [中文](./README.zh.md)

> A [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that pops native Windows notifications when an agent session **finishes**, **fails**, or **needs your confirmation** — and automatically retries transient request failures so long runs don't die halfway through.

## ✨ Features

- **🔔 Task notifications** — a native Windows toast when the agent goes idle (task complete), hits an error, or is about to ask you a question.
- **🔄 Auto-retry** — transient failures (timeout, connection reset, DNS, rate limit, 5xx) are retried automatically with exponential backoff, up to a configurable count.
- **⚙️ Settings panel** — a **Task Notifications (dsh-helper)** section in DSH Settings: retry count, base backoff, and three independent notification toggles.
- **🧪 Test button** — fire a test toast to verify the notification pipeline works on your machine.
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
| `retryMax` | `3` | Max automatic retries per session in a rolling 60 s window. `0` disables retrying. |
| `retryBaseMs` | `1000` | Base backoff in ms. Each attempt doubles it (`base × 2^(n-1)`), capped at 30 s. |
| `notifyOnComplete` | `true` | Notify when a session finishes (deduped to once per 60 s per session). |
| `notifyOnError` | `true` | Notify when a session hits an error. |
| `notifyOnConfirm` | `true` | Notify when the agent is about to ask you a question. |

Defaults ship in `cordis.patch.yml`; your overrides are written to `~/.dsh/profiles/web/cordis.patch.yml`.

## 🔌 How it works

| DSH event | Behaviour |
| --- | --- |
| `agent/status` (`idle`) | Completion toast |
| `agent/request-error` | Error toast, then returns `{ kind: 'retry' }` to trigger DSH's **native** retry |
| `tools/pre-execute` (`ask_user_question`) | Confirmation toast |

The settings HTTP route (`/_dsh/dsh-helper/settings`) is bound to localhost only — anything other than `127.0.0.1` / `::1` gets a `403`.

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

- Notifications target Windows (PowerShell WinRT Toast). On macOS/Linux the plugin still loads and auto-retry still works, but toasts are silent no-ops.
- The retry budget is per session within a rolling 60 s window; once exhausted the failure is passed through to DSH as-is.
- If Windows Focus Assist is on, toasts may be suppressed — allow notifications for the `dsh-helper` app id.

## 📄 License

[MIT](./LICENSE) © sunligh91
