// PDF TransNote：サーバー（transnote/server.py）とデスクトップ（pywebview）とのやりとり（pdf.js には触れない）

import { lang } from "./i18n.mjs";

const TOKEN = document.querySelector('meta[name="transnote-token"]')?.content ?? "";
/** サーバーへの要求に付けるヘッダー（起動ごとの秘密の値と，画面の言語．サーバーは誤りの文をこの言語で返す）． */
export const AUTH = { "X-TransNote-Token": TOKEN, "X-TransNote-Lang": lang };

async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

export async function getAbout() {
  return json(await fetch("/api/ping"));
}

export async function getLicenses() {
  return (await json(await fetch("/api/about/licenses", { headers: AUTH }))).licenses;
}

/** 設定と既定値を読む． */
export async function getSettings() {
  return json(await fetch("/api/settings", { headers: AUTH }));
}

/** 設定を保存する（サーバーが検査する．誤りは例外にする）．保存した値を返す． */
export async function putSettings(values) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  return (await json(res)).settings;
}

/** 翻訳サーバーのモデル一覧．service は保存済みの ID か，{endpoint, apiKey}（接続テスト）． */
export async function fetchModels(service) {
  const res =
    typeof service === "string"
      ? await fetch(`/llm/models?service=${encodeURIComponent(service)}`, { headers: AUTH })
      : await fetch("/llm/models", {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: service.endpoint, apiKey: service.apiKey }),
        });
  return ((await json(res)).data ?? []).map((m) => m.id);
}

/** 注釈を入れた PDF を元の場所に保存する．{status, info} を返す（409 は「ほかのアプリが変更した」）． */
export async function putPdf(url, data, force = false) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/pdf", ...(force ? { "X-TransNote-Force": "1" } : {}) },
    body: data,
  });
  const info = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, info };
}

/** 「名前を付けて保存」：ダイアログが登録した行き先（トークン）に書く．{status, ok, info} を返す． */
export async function putSaveAs(token, data) {
  const res = await fetch(`/save-as/${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/pdf" },
    body: data,
  });
  const info = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, info };
}

// ---------------------------------------------------------------------------
// デスクトップ（pywebview＋Edge WebView2）
// ---------------------------------------------------------------------------

/** デスクトップで動いているか．WebView2 には chrome.webview がある． */
export const inDesktop = !!window.chrome?.webview;

/** pywebview の API．デスクトップでなければ，または 2 秒待っても来なければ null． */
export const desktop = new Promise((resolve) => {
  if (!inDesktop) return resolve(null);
  if (window.pywebview?.api) return resolve(window.pywebview.api);
  window.addEventListener("pywebviewready", () => resolve(window.pywebview.api), { once: true });
  setTimeout(() => resolve(window.pywebview?.api ?? null), 2000);
});

/** ファイルを選ぶダイアログ（デスクトップのとき）． */
export async function openDialog() {
  (await desktop)?.open_dialog();
}

/**
 * ドロップされたファイルを開く．WebView2 は本当のパスを postMessageWithAdditionalObjects で
 * ホスト側に渡すので，名前を添えて pywebview に開いてもらう．開いた数を返す．
 */
export async function openDropped(files) {
  try {
    window.chrome.webview.postMessageWithAdditionalObjects("FilesDropped", files);
  } catch {}
  const api = await desktop;
  await new Promise((r) => setTimeout(r, 50));
  return api ? await api.open_dropped([...files].map((f) => f.name)) : 0;
}

/**
 * 「名前を付けて保存」のダイアログ（デスクトップのとき）．docToken は開いている文書のトークン．
 * 選んだ行き先の書き込み用のトークンを返す（取り消し，またはデスクトップでなければ null）．
 */
export async function saveAsDialog(docToken) {
  return (await (await desktop)?.save_as_dialog(docToken)) ?? null;
}

/** 閉じる前の確認に使う「変更あり」を知らせる． */
export async function setDirty(dirty) {
  (await desktop)?.set_dirty(!!dirty);
}
