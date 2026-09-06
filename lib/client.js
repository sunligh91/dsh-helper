/**
 * dsh-helper — client half.
 * 在设置页注册侧边栏入口「任务通知 (dsh-helper)」，提供各通知开关；
 * 并提供「发送测试通知」按钮验证通知链路。
 * 沿用 dsh-email 的 window.__ModuleLoader__ UMD 写法（零构建、可被 dsh
 * client runtime 直接加载）。
 */
window.__ModuleLoader__.load({ id: "dsh-helper", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const React = require("react");
const { useState, useEffect, useCallback } = React;
const h = React.createElement;

const ROUTE = "/_dsh/dsh-helper/settings";

async function api(action, payload) {
  const init = action === undefined
    ? { credentials: "same-origin" }
    : {
        credentials: "same-origin",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ action }, payload)),
      };
  const res = await fetch(ROUTE, init);
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error((body && body.error && body.error.message) || ("request failed " + res.status));
  }
  return body.value;
}

const EMPTY = {
  notifyOnComplete: true,
  notifyOnError: true,
  notifyOnConfirm: true,
};

const CSS = [
  ".dshh-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f);color-scheme:light dark}",
  ".dshh-header{display:grid;gap:4px;padding:8px 2px}",
  ".dshh-header h2{font-size:22px;letter-spacing:-.02em;margin:0}",
  ".dshh-header p{max-width:640px;margin:4px 0 0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55}",
  ".dshh-kicker{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#0b6c9f;font-weight:700}",
  ".dshh-panel{display:grid;gap:12px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.02)}",
  ".dshh-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
  ".dshh-field{display:grid;gap:6px}",
  ".dshh-field label{font-size:12px;font-weight:600;color:var(--dsw-alias-fg-primary,#26231f)}",
  ".dshh-field input[type=text],.dshh-field input[type=number],.dshh-field select,.dshh-field textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-fg-primary,#26231f);font:inherit;font-size:13px}",
  ".dshh-check{display:flex;gap:8px;align-items:center;font-size:13px}",
  ".dshh-actions{display:flex;gap:8px;flex-wrap:wrap}",
  ".dshh-btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-size:13px;font-weight:600;cursor:pointer}",
  ".dshh-btn.primary{background:#0b6c9f;border-color:#0b6c9f;color:#fff}",
  ".dshh-btn:disabled{opacity:.55;cursor:default}",
  ".dshh-alert{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5}",
  ".dshh-alert.error{background:rgba(205,72,72,.1);color:#aa3939}",
  ".dshh-alert.success{background:rgba(48,154,100,.1);color:#267d52}",
  ".dshh-hint{font-size:12px;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.5}",
].join("\n");

function TaskNotifierSettings() {
  const [draft, setDraft] = useState(null);
  const [snapshot, setSnapshot] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const snap = await api();
      setSnapshot(snap);
      const value = (snap && snap.settings && snap.settings.value) || EMPTY;
      setDraft({ ...EMPTY, ...value });
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = (patch) => setDraft((cur) => Object.assign({}, cur, patch));

  const doSave = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const value = {
        notifyOnComplete: draft.notifyOnComplete === true,
        notifyOnError: draft.notifyOnError === true,
        notifyOnConfirm: draft.notifyOnConfirm === true,
      };
      const rev = snapshot && snapshot.settings ? snapshot.settings.revision : 0;
      const snap = await api("save", { value, expectedRevision: rev });
      setSnapshot(snap);
      setMessage("已保存并生效（下次请求即用新配置；运行时已热更新）。");
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doTest = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      await api("test");
      setMessage("测试通知已发送，请查看桌面右下角 Windows 通知。");
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (draft === null) {
    return h("div", { className: "dshh-settings" }, [
      h("div", { className: "dshh-alert info" }, busy ? "加载中…" : (error || "加载中…")),
    ]);
  }

  return h("div", { className: "dshh-settings" }, [
    h("header", { className: "dshh-header" }, [
      h("span", { className: "dshh-kicker" }, "dsh-helper · 任务通知"),
      h("h2", null, "任务通知"),
      h("p", null, "agent 会话任务完成 / 异常 / 需要确认时弹 Windows 通知。"),
    ]),
    h("section", { className: "dshh-panel" }, [
      h("label", { className: "dshh-check" }, [
        h("input", { type: "checkbox", checked: draft.notifyOnComplete === true, onChange: (e) => update({ notifyOnComplete: e.target.checked }) }),
        "任务完成时通知",
      ]),
      h("label", { className: "dshh-check" }, [
        h("input", { type: "checkbox", checked: draft.notifyOnError === true, onChange: (e) => update({ notifyOnError: e.target.checked }) }),
        "任务异常时通知",
      ]),
      h("label", { className: "dshh-check" }, [
        h("input", { type: "checkbox", checked: draft.notifyOnConfirm === true, onChange: (e) => update({ notifyOnConfirm: e.target.checked }) }),
        "需要确认时通知",
      ]),
      h("div", { className: "dshh-actions" }, [
        h("button", { className: "dshh-btn primary", disabled: busy, onClick: doSave }, busy ? "处理中…" : "保存并应用"),
        h("button", { className: "dshh-btn", disabled: busy, onClick: doTest }, busy ? "处理中…" : "发送测试通知"),
      ]),
      h("div", { className: "dshh-hint" }, "通知走 PowerShell WinRT Toast（零依赖）。若桌面收不到，可在设置里开启「专注助手」允许通知，或后续加装 node-notifier。"),
    ]),
    error ? h("div", { className: "dshh-alert error" }, error) : null,
    message ? h("div", { className: "dshh-alert success" }, message) : null,
  ]);
}

const inject = ["slots"];

function apply(ctx) {
  ctx.effect(() => {
    const id = "dsh-helper/client";
    if (document.querySelector('style[data-plugin-css="' + id + '"]')) return () => {};
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-helper";
    style.dataset.pluginCss = id;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, "dsh-helper: styles");

  ctx.effect(() => {
    const dispose = ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: "dsh-helper",
          order: 46,
          label: () => "任务通知 (dsh-helper)",
          inject: () => ({}),
        },
        TaskNotifierSettings,
      ),
    );
    return () => dispose();
  }, "dsh-helper: settings.section");
}

exports.apply = apply;
exports.inject = inject;

return module.exports;
}});
