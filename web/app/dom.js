// PDF TransNote：画面の部品を作る小道具（pdf.js には触れない）

/** 要素を作る．props の class は className，on* はイベント，text は文字，それ以外は属性． */
export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

/** 長い文字を短くする（一覧の表示用）． */
export function shorten(s, n = 40) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** ハイライトの色（Zotero と同じ 8 色）． */
export const COLORS = [
  { value: "#ffd400", name: "Yellow" },
  { value: "#ff6666", name: "Red" },
  { value: "#5fb236", name: "Green" },
  { value: "#2ea8e5", name: "Blue" },
  { value: "#a28ae5", name: "Purple" },
  { value: "#e56eee", name: "Magenta" },
  { value: "#f19837", name: "Orange" },
  { value: "#aaaaaa", name: "Gray" },
];

/** 色を比べるための正規化（#RRGGBB の小文字）． */
export const normColor = (c) => String(c ?? "").trim().toLowerCase();

let toastBox = null;
/** 左下に少しの間だけ知らせを出す． */
export function toast(parent, text, kind = "") {
  toastBox ||= el("div", { id: "tnToast", role: "status", "aria-live": "polite" });
  if (!toastBox.isConnected) parent.append(toastBox);
  const item = el("div", { class: `tnToastItem ${kind}`, text });
  toastBox.append(item);
  setTimeout(() => item.remove(), kind === "error" ? 8000 : 3500);
}
