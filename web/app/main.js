// PDF TransNote：入口．pdf.js との境目（../pdfjs/bridge.js）と，独自の部品をつなぐ．
// ===========================================================================
// サーバーが viewer.html の viewer.mjs より前に差し込む．bridge.js を import するので，
// bridge が pdf.js の起動前に「webviewerloaded」を待ち受けられる．
// このファイルと web/app/ の他のファイルは，pdf.js の名前に触れない（bridge だけを使う）．
// 画面の文は英語（訳文は日本語）．

import { bridge } from "../pdfjs/bridge.js";
import * as api from "./api.js";
import { chatRequest, cleanSource, translate } from "./core.mjs";
import { toast as showToast } from "./dom.js";
import { JobQueue, SaveScheduler } from "./jobs.mjs";
import { Popup } from "./popup.js";
import { SettingsDialog } from "./settings-dialog.js";
import { AnnotationSidebar } from "./sidebar.js";

const FALLBACK = { services: [], activeService: "", lastColor: "#ffd400", saveOnComment: true, concurrency: 2, langFrom: "en", langTo: "ja" };

let settings = null;
let popup = null;
let sidebar = null;
let settingsDialog = null;

const toast = (text, kind) => showToast(bridge.overlayParent(), text, kind);

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function applySettings(s) {
  settings = s;
  queue.setLimit(Number(s.concurrency) || 1);
  popup?.refresh();
}

const activeService = () => settings.services.find((s) => s.id === settings.activeService) ?? settings.services[0];

/** 設定の一部を変えて保存する（失敗したら知らせる）． */
async function updateSettings(patch) {
  try {
    applySettings(await api.putSettings({ ...settings, ...patch }));
  } catch (e) {
    toast(`Could not save the settings: ${e.message}`, "error");
  }
}

const rememberColor = (color) => settings && settings.lastColor !== color && updateSettings({ lastColor: color });
const setActiveService = (id) => updateSettings({ activeService: id });

// ---------------------------------------------------------------------------
// 翻訳の列
// ---------------------------------------------------------------------------

async function runJob(job, signal, onDelta) {
  if (!settings) applySettings((await api.getSettings()).settings);
  return translate({
    fetchImpl: fetch,
    headers: api.AUTH,
    request: chatRequest(activeService(), job.source, settings),
    signal,
    onDelta: (_d, full) => onDelta(full),
  });
}

const queue = new JobQueue({ run: runJob, limit: 2, onChange: () => sidebar?.updateJobs() });

// ---------------------------------------------------------------------------
// 保存（元の PDF に上書き）
// ---------------------------------------------------------------------------

async function saveToFile({ force = false, manual = false } = {}) {
  if (!bridge.hasDocument()) return;
  if (!bridge.hasChanges()) {
    if (manual) toast("There are no changes to save");
    return;
  }
  bridge.setBusy(true);
  try {
    const data = await bridge.saveData();
    const { status, ok, info } = await api.putPdf(bridge.docUrl(), data, force);
    if (status === 409 && !force) {
      if (confirm("Another app has changed this PDF. Overwrite it?")) return await saveToFile({ force: true, manual });
      toast("Save canceled", "error");
      return;
    }
    if (!ok) throw new Error(info.error || `${status}`);
    bridge.markSaved();
    toast(info.backup ? "Saved (the original file was copied to data\\backups)" : "Saved", "ok");
  } catch (e) {
    toast(`Could not save: ${e.message}`, "error");
    throw e;
  } finally {
    bridge.setBusy(false);
    reportDirty(true);
  }
}

const saver = new SaveScheduler(() => saveToFile());
const requestSave = () => (settings?.saveOnComment ?? true) && saver.request();

// ---------------------------------------------------------------------------
// 注釈と翻訳
// ---------------------------------------------------------------------------

/** 訳文をハイライトのコメントにする．書けたら保存を頼み，true を返す． */
async function commitTranslation(target, text) {
  if (!text.trim()) return false;
  const ok = await bridge.setComment(target, text.trim());
  if (ok) requestSave();
  return ok;
}

/** ハイライトに結び付いた自動のジョブ（訳が届いたらコメントに入れる）を作る． */
function startAutoJob(target, source) {
  const job = queue.add({ source: cleanSource(source), meta: { kind: "auto", target, committed: false }, onChange: onAutoJobChange });
  bridge.markBusy(target, true);
  return job;
}

/** 翻訳の失敗を知らせる（1 回だけ）．左のパネルの Annotations が見えていなければ，開閉ボタンに印を付ける． */
function reportFailure(job) {
  if (job.meta.notified) return;
  job.meta.notified = true;
  toast(`Translation failed: ${job.error}`, "error");
  if (!bridge.isSidebarVisible()) bridge.setSidebarAlert(true);
}

async function onAutoJobChange(job) {
  const { target } = job.meta;
  bridge.markBusy(target, !job.finished);
  if (job.status === "queued" || job.status === "running") job.meta.notified = false;
  if (job.status === "canceled") return queue.remove(job);
  if (job.status === "error") return reportFailure(job);
  if (job.status !== "done" || job.meta.committed) return;
  job.meta.committed = true;
  if (await commitTranslation(target, job.output)) {
    queue.remove(job); // 訳はカードのコメントに出る
  } else {
    job.status = "error";
    job.error = "The highlight is gone";
    reportFailure(job);
    sidebar?.updateJobs();
  }
}

/** Annotate & Translate：ハイライトを作り，翻訳を列に入れる． */
async function annotateAndTranslate(anchor, color, source) {
  rememberColor(color);
  bridge.clearSelection();
  const target = await bridge.createHighlight(anchor, color);
  if (!target) return toast("Could not create a highlight (select some text)", "error");
  startAutoJob(target, source);
}

async function changeColor(target, color) {
  if (await bridge.setColor(target, color)) requestSave();
}

async function deleteHighlight(target) {
  for (const j of queue.jobs) if (!j.finished && bridge.sameTarget(j.meta.target, target)) j.cancel();
  if (await bridge.remove(target)) requestSave();
}

/** サイドバーでコメントを直した：そのハイライトへ移動してから書く（描かれていないページでは書けないため）． */
async function saveComment(target, text) {
  bridge.scrollTo(target);
  if (await bridge.setComment(target, text)) requestSave();
  else toast("Could not write the comment (the highlight is gone)", "error");
}

// ---------------------------------------------------------------------------
// ポップアップ
// ---------------------------------------------------------------------------

const ctx = {
  bridge,
  queue,
  toast,
  settings: () => settings ?? FALLBACK,
  setActiveService,
  rememberColor,
  annotateAndTranslate,
  startAutoJob,
  commitTranslation,
  changeColor,
  deleteHighlight,
  saveComment,
  newPopupJob: (source, p) => queue.add({ source, meta: { kind: "popup", popup: p, target: p.target }, onChange: (j) => p.onJob(j) }),
  adoptToPopup: (job, p) => {
    Object.assign(job.meta, { kind: "popup", popup: p });
    job.onChange = (j) => p.onJob(j);
  },
  adoptAsAuto: (job, target) => {
    job.meta = { kind: "auto", target, committed: false };
    job.onChange = onAutoJobChange;
    bridge.markBusy(target, !job.finished);
    if (job.finished) onAutoJobChange(job);
  },
  dropPopupJob: (job) => job.meta.kind === "popup" && queue.remove(job),
  popupClosed: (p) => {
    if (popup !== p) return;
    popup = null;
    sidebar?.select(null);
  },
  openEditor: (job) => openPopup({ target: job.meta.target, job }),
  /** カードから：そのハイライトへ移動して，注釈ポップアップを開く． */
  openHighlight: (target) => {
    bridge.scrollTo(target);
    openPopup({ target });
  },
};

function openPopup(options) {
  popup?.close();
  popup = new Popup(ctx, options);
  if (options.target) sidebar?.select(options.target);
}

function bindPopupEvents() {
  bridge.on("selection", (anchor) => openPopup({ anchor }));
  bridge.on("highlightClick", (target) => openPopup({ target }));
  bridge.on("layout", () => popup?.place());
  // ポップアップの外を押したら閉じる（新しい選択やハイライトのクリックなら，その後で開き直す）
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (popup && !popup.root.contains(e.target)) popup.close();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && popup) {
        popup.close();
        return;
      }
      if (!e.altKey || e.ctrlKey || (e.key !== "t" && e.key !== "T")) return;
      const anchor = bridge.currentAnchor();
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        annotateAndTranslate(anchor, ctx.settings().lastColor, anchor.text);
      } else {
        openPopup({ anchor });
        popup.onTranslate();
      }
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// 閉じる前の確認（保存していない変更，翻訳中のもの，まだ注釈にしていない訳文）
// ---------------------------------------------------------------------------

let lastDirty = null;
function reportDirty(force = false) {
  const modified = bridge.isModified();
  bridge.setDirtyMark(modified);
  const dirty = modified || queue.busy || !!popup?.holdsWork;
  if (!force && dirty === lastDirty) return;
  lastDirty = dirty;
  api.setDirty(dirty);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

bridge.on("ready", async () => {
  sidebar = new AnnotationSidebar(ctx);
  settingsDialog = new SettingsDialog({ toast, applySettings });
  bridge.addToolbarButton({ id: "transnoteGear", title: "PDF TransNote settings", onClick: () => settingsDialog.open() });
  bridge.setSaveButtonTitle("Save to the original PDF (Ctrl+S)");
  bridge.setSaveHandler(async ({ manual }) => {
    if (!bridge.hasChanges()) {
      if (manual) toast("There are no changes to save");
      return;
    }
    await saver.request();
  });
  if (api.inDesktop) {
    bridge.setOpenHandler(() => api.openDialog());
    bridge.setDropHandler(async (files) => {
      if (!(await api.openDropped(files))) toast("Drop a PDF file", "error");
    });
  }
  bindPopupEvents();
  setInterval(reportDirty, 700);
  try {
    applySettings((await api.getSettings()).settings);
  } catch (e) {
    toast(e.message, "error");
  }
  if (!bridge.docUrl()) toast("Open a PDF with Open (Ctrl+O) or drop one onto the window");
});
