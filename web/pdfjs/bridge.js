// PDF TransNote：pdf.js（v6.5.438）との境目
// ===========================================================================
// pdf.js の名前（PDFViewerApplication，pdfjsLib，AnnotationEditorUIManager，.textLayer など）に
// 触れるのはこのファイルだけ．独自の部分（web/app/）は，ここが出す `bridge` だけを使う．
// pdf.js を更新したときに直すのは web/pdfjs/ の中だけで済むようにする．
//
// 「target」は注釈を指す値で，app 側は中を見ない．中身は次のどちらか：
//   { kind: "editor", editor }               このセッションで作った（または編集用に変えた）ハイライト
//   { kind: "annotation", id, pageIndex }    ファイルにあったハイライト（pdf.js の注釈の層の要素）
// 「anchor」は選んだ範囲の記録（ハイライトにする前）．app 側が読むのは anchor.text だけ．
//
// このファイルは viewer.mjs より前に読まれる（app/main.js が import する）ので，
// 「webviewerloaded」を待ち受けて，pdf.js の起動前に設定を差し込める．
// pdf.js に触れない計算（色，quadPoints の中の文字，並べ方）は highlight-math.mjs に分けてある．

import { blendOpacity, compareHighlights, textInQuads } from "./highlight-math.mjs";
import { analyzeDocument, DEFAULT_OPTIONS as STRUCTURE_DEFAULTS, filterSelection } from "./page-structure.mjs";

const HOOK_LABEL = "transnote";
/** 一度に選べるページの数（長いと，pdf.js が途中のページの層を捨てることがある）． */
const MAX_SELECTION_PAGES = 3;

// ---------------------------------------------------------------------------
// 1. 小道具
// ---------------------------------------------------------------------------

const app = () => window.PDFViewerApplication;
const lib = () => window.pdfjsLib;
const uiManager = () => app()?.pdfViewer?._layerProperties?.annotationEditorUIManager ?? null;
const EditorType = () => lib().AnnotationEditorType;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const listeners = new Map();
function emit(name, ...args) {
  for (const fn of listeners.get(name) ?? []) {
    try {
      fn(...args);
    } catch (e) {
      console.error(`[transnote] ${name}:`, e);
    }
  }
}

/** 点 (x, y) が矩形の中か（少しの余白 pad を許す）． */
const inside = (r, x, y, pad = 0) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

/** 矩形の集まりを 1 つに包む（なければ null）． */
function union(rects) {
  const list = [...rects].filter((r) => r && r.width + r.height > 0);
  if (!list.length) return null;
  const left = Math.min(...list.map((r) => r.left));
  const top = Math.min(...list.map((r) => r.top));
  const right = Math.max(...list.map((r) => r.right));
  const bottom = Math.max(...list.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

const pageDiv = (pageIndex) => document.querySelector(`#viewer .page[data-page-number="${pageIndex + 1}"]`);
const textLayerOf = (pageIndex) => pageDiv(pageIndex)?.querySelector(".textLayer") ?? null;
const pageIndexOf = (node) => {
  const page = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.(".page");
  return page ? Number(page.dataset.pageNumber) - 1 : -1;
};

/** ファイルにあった注釈の，pdf.js の要素（AnnotationElement）．なければ null． */
function annotationElement(pageIndex, id) {
  return app()?.pdfViewer?.getPageView(pageIndex)?.annotationLayer?.annotationLayer?.getEditableAnnotation(id) ?? null;
}

const toHex = (rgb) =>
  rgb && rgb.length >= 3 ? "#" + [...rgb].slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : null;

// ---------------------------------------------------------------------------
// 1b. ファイルにあったハイライトの一覧（ページが描かれていなくても使えるように，文書を開いたら覚える）
// ---------------------------------------------------------------------------

let doc = null; // 下の覚えがどの文書のものか（PDFDocumentProxy）
let fileHl = new Map(); // pageIndex → [{ id, pageIndex, quadPoints, color, opacity, comment }]
let fileHlLoading = new Map(); // pageIndex → Promise
let fileHlIds = new Set(); // ファイルにあったハイライトの ID（canvas に描かせない）
let fileHlVersion = 0;
const contentCache = new Map(); // pageIndex → Promise<ページの文字（pageContent の値）>
let scanned = []; // pageIndex → 読み終えたページの文字（分析に渡す．読んでいなければ undefined）
let analysis = null; // 本文とそれ以外の分類（page-structure.mjs の analyzeDocument の値）
let analysisDirty = true;
const textCache = new Map(); // 注釈の ID → 範囲の文字

/** 今の文書．文書が変わっていたら，覚えを捨てて，新しい文書の注釈の置き場を見張る． */
function currentDoc() {
  const d = app()?.pdfDocument ?? null;
  if (d !== doc) {
    doc = d;
    fileHl = new Map();
    fileHlLoading = new Map();
    fileHlIds = new Set();
    fileHlVersion++;
    contentCache.clear();
    scanned = [];
    analysis = null;
    analysisDirty = true;
    textCache.clear();
    if (d) patchStorage(d.annotationStorage);
  }
  return d;
}

/** ページのハイライトを pdf.js の getAnnotations から取り出して覚える（pdf.js も同じ結果を覚えるので，注釈の層と二重に読まない）． */
function loadPageHighlights(pageIndex, pdfPage = null) {
  const d = currentDoc();
  if (!d) return Promise.resolve([]);
  let p = fileHlLoading.get(pageIndex);
  if (p) return p;
  p = (async () => {
    let list = [];
    try {
      const page = pdfPage ?? (await d.getPage(pageIndex + 1));
      const annots = await page.getAnnotations();
      const HIGHLIGHT = lib().AnnotationType.HIGHLIGHT;
      list = annots
        .filter((a) => a.annotationType === HIGHLIGHT && a.quadPoints?.length)
        .map((a) => ({
          id: a.id,
          pageIndex,
          quadPoints: a.quadPoints,
          color: toHex(a.color) ?? "#ffd400",
          opacity: typeof a.opacity === "number" ? a.opacity : 1,
          comment: a.contentsObj?.str ?? "",
        }));
    } catch (e) {
      console.warn("[transnote] getAnnotations failed", pageIndex, e);
    }
    if (d !== doc) return [];
    fileHl.set(pageIndex, list);
    if (list.length) {
      for (const h of list) fileHlIds.add(h.id);
      fileHlVersion++;
    }
    return list;
  })();
  fileHlLoading.set(pageIndex, p);
  return p;
}

const loadAllHighlights = () => Promise.all(Array.from({ length: app()?.pagesCount ?? 0 }, (_, i) => loadPageHighlights(i)));
const fileData = (pageIndex, id) => fileHl.get(pageIndex)?.find((h) => h.id === id) ?? null;

/**
 * 文書の注釈の置き場（annotationStorage）に手を入れる．
 * - modifiedIds：canvas に描かない注釈の ID．ファイルにあったハイライトを足し，代わりに独自の層で薄く描く
 *   （描画のときだけ使われ，保存や印刷には関係しない）．
 * - setValue／remove：注釈が足されたり消されたりしたら，一覧が変わったと知らせる．
 */
function patchStorage(storage) {
  if (!storage || storage.__transnotePatched) return;
  let proto = Object.getPrototypeOf(storage);
  let desc = null;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "modifiedIds"))) proto = Object.getPrototypeOf(proto);
  if (desc?.get) {
    let cache = null;
    Object.defineProperty(storage, "modifiedIds", {
      configurable: true,
      get() {
        const base = desc.get.call(this);
        if (!fileHlIds.size) return base;
        if (cache?.base === base && cache.version === fileHlVersion) return cache.value;
        const value = { ids: new Set([...base.ids, ...fileHlIds]), hash: `${base.hash}|tn${fileHlVersion}` };
        cache = { base, version: fileHlVersion, value };
        return value;
      },
    });
  }
  for (const name of ["setValue", "remove"]) {
    const original = storage[name];
    if (typeof original !== "function") continue;
    storage[name] = function (...args) {
      const r = original.apply(this, args);
      highlightsChanged();
      return r;
    };
  }
  storage.__transnotePatched = true;
}

/** ページを描く前に，そのページのハイライトの一覧を揃える（canvas に描かせない ID を決めるため）． */
function hookRendering(a) {
  const q = a.pdfRenderingQueue;
  if (!q || q.__transnotePatched) return;
  const original = q.renderView.bind(q);
  const INITIAL = 0; // RenderingStates.INITIAL
  q.renderView = (view) => {
    const page = view?.pdfPage;
    if (view?.renderingState === INITIAL && page && currentDoc()) {
      const pageIndex = page.pageNumber - 1;
      if (!fileHl.has(pageIndex)) {
        loadPageHighlights(pageIndex, page).finally(() => a.forceRendering());
        return true;
      }
    }
    return original(view);
  };
  q.__transnotePatched = true;
}

// ---------------------------------------------------------------------------
// 1c. ハイライトを Zotero と同じ薄さで描く（ファイルにあったものは独自の層に描く）
// ---------------------------------------------------------------------------

const pct = (v) => `${(v * 100).toFixed(4)}%`;

/** このページのファイルにあったハイライトを，canvas の上（文字の層の下）の独自の層に描き直す． */
function drawFileHighlights(pageIndex) {
  const div = app()?.pdfViewer?.getPageView(pageIndex)?.div;
  const wrapper = div?.querySelector(".canvasWrapper");
  let layer = div?.querySelector(".tnHighlightLayer");
  if (!wrapper) {
    layer?.remove();
    return;
  }
  const um = uiManager();
  const replaced = new Set();
  for (const ed of um?.getEditors(pageIndex) ?? []) if (ed.annotationElementId) replaced.add(ed.annotationElementId);
  const list = (fileHl.get(pageIndex) ?? []).filter((h) => !replaced.has(h.id) && !um?.isDeletedAnnotationElement?.(h.id));
  if (!list.length) {
    layer?.remove();
    return;
  }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "tnHighlightLayer";
    layer.setAttribute("aria-hidden", "true");
  }
  // 拡大したときの部分の canvas より上にあるよう，いつも最後に置く
  if (wrapper.lastElementChild !== layer) wrapper.append(layer);
  const frag = document.createDocumentFragment();
  for (const h of list) {
    const color = blendOpacity(h.color, h.opacity);
    for (const b of quadFractions(pageIndex, h.quadPoints)) {
      const r = document.createElement("div");
      Object.assign(r.style, { left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height), backgroundColor: color });
      frag.append(r);
    }
  }
  layer.replaceChildren(frag);
}

function drawAllFileHighlights() {
  const n = app()?.pagesCount ?? 0;
  for (let i = 0; i < n; i++) {
    if (app().pdfViewer.getPageView(i)?.div?.querySelector(".canvasWrapper")) drawFileHighlights(i);
  }
}

let changeTimer = null;
/** ハイライトの一覧が変わった：独自の層を描き直し，少し後にまとめて app に知らせる． */
function highlightsChanged() {
  setTimeout(drawAllFileHighlights, 0);
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    emit("highlightsChanged");
  }, 150);
}

// ---------------------------------------------------------------------------
// 2. 注釈の作成の見張りと，1 件ずつの実行
// ---------------------------------------------------------------------------

/** このセッションで作ったハイライトと，作ったときに選んでいた文字（pdf.js はこの文字を外に出さない）． */
const editorText = new WeakMap();
/** このセッションで作ったハイライトの範囲（文字の層＝ページに対する割合の矩形の並び）． */
const editorBoxes = new WeakMap();

/** pdf.js の注釈の種類（クラス）．ハイライト用のモードに切り替えずにハイライトを作るのに使う． */
let editorTypes = [];
const highlightClass = () => editorTypes.find((t) => t._type === "highlight") ?? null;

/** こちらの都合でハイライト用のモードにしている間か（その間にユーザーが選んだ文字は，pdf.js に自動でハイライトさせない）． */
let transientMode = false;
let deferredSelection = false;

/** pdf.js の起動前に呼ぶ：注釈の種類を受け取り，ハイライトの作成を見張る． */
function patchEditorClasses() {
  const um = lib()?.AnnotationEditorUIManager?.prototype;
  if (um && !um.__transnotePatched) {
    const register = um.registerEditorTypes;
    um.registerEditorTypes = function (types) {
      if (!editorTypes.length) editorTypes = [...types];
      return register.call(this, types);
    };
    // ハイライト用のモードでは，文字を選び終えると pdf.js がすぐハイライトを作る（"main_toolbar"）．
    // こちらが一時的にそのモードにしている間は作らせず，戻ってから選択ポップアップを出す．
    const highlightSelection = um.highlightSelection;
    um.highlightSelection = function (methodOfCreation = "", comment = false) {
      if (transientMode && methodOfCreation === "main_toolbar") {
        deferredSelection = true;
        return;
      }
      return highlightSelection.call(this, methodOfCreation, comment);
    };
    um.__transnotePatched = true;
  }
  const layer = lib()?.AnnotationEditorLayer?.prototype;
  if (layer && !layer.__transnotePatched) {
    const original = layer.createAndAddNewEditor;
    layer.createAndAddNewEditor = function (event, isCentered, data = {}) {
      const editor = original.call(this, event, isCentered, data);
      if (editor && typeof data.text === "string") editorText.set(editor, data.text);
      if (editor && Array.isArray(data.boxes)) editorBoxes.set(editor, data.boxes);
      return editor;
    };
    layer.__transnotePatched = true;
  }
}

/** モードの切り替えを伴う操作を 1 件ずつ順に行う（途中で次の操作が重なると，受け取りが混ざるため）． */
let chain = Promise.resolve();
function oneAtATime(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/**
 * 通常のモードに戻す．ハイライト用のモードに切り替わっている途中で送ると無視されることがあるので，
 * 実際に戻ったことを確かめながら何回か送る．
 */
async function backToNoneMode() {
  const um = uiManager();
  const NONE = EditorType().NONE;
  for (let i = 0; i < 20 && um && um.getMode() !== NONE; i++) {
    await nextFrame();
    if (um.getMode() === NONE) break;
    app().eventBus.dispatch("switchannotationeditormode", { source: window, mode: NONE });
    await sleep(40);
  }
}

function waitEvent(name, test, timeout = 4000) {
  return new Promise((resolve) => {
    const bus = app().eventBus;
    const done = (v) => {
      bus.off(name, on);
      clearTimeout(timer);
      resolve(v);
    };
    const on = (e) => {
      if (!test || test(e)) done(e);
    };
    const timer = setTimeout(() => done(null), timeout);
    bus.on(name, on);
  });
}

let pendingOps = 0; // 順番待ちを含めた，モードの切り替えを伴う操作の数
let burstFromNone = false; // 続けて行い始めたときに通常のモードだったか（最後に戻すため）

/**
 * ハイライト用のモードで fn を行う．続けて行うときは毎回モードを戻さず，最後の 1 件の後で 1 回だけ戻す．
 * fn の結果を，モードを戻すのを待たずに返す．
 */
function inHighlightMode(fn) {
  pendingOps++;
  const result = oneAtATime(async () => {
    try {
      const um = uiManager();
      if (!um) return null;
      const { HIGHLIGHT, NONE } = EditorType();
      if (um.getMode() === NONE) {
        burstFromNone = true;
        transientMode = true;
        await new Promise((resolve) => {
          um.switchToMode(HIGHLIGHT, resolve);
        });
      }
      return await fn(um);
    } finally {
      pendingOps--;
    }
  });
  oneAtATime(async () => {
    if (pendingOps === 0 && burstFromNone) {
      burstFromNone = false;
      await backToNoneMode();
      transientMode = false;
      // モードを切り替えていた間に選び終えた文字があれば，ここで選択ポップアップを出す
      if (deferredSelection) {
        deferredSelection = false;
        const anchor = captureAnchor();
        if (anchor) emit("selection", anchor);
      }
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// 3. 選んだ範囲の記録とハイライトの作成
// ---------------------------------------------------------------------------

// 選択はページをまたいでよい．pdf.js が選択をページごとに分けて描くやり方（DrawLayer の selectionchange）に倣い，
// 範囲と交わる文字の層ごとに，文字のノードを範囲で切って集める（「断片」）．ページの間の注釈の層や，
// 構造ツリーの代替テキスト・MathML は拾わない．矩形は断片ごとの部分の範囲から取る（要素ごとの矩形を混ぜない．
// タグ付き PDF では，代替テキストのある図全体を包む矩形が入ってしまうため）．

/** 文字の層の中で飛ばす要素（選択の終わりの印，画像の層，代替テキストの図）． */
const SKIP_IN_LAYER = ".endOfContent, .textLayerImages, span[role='img']";
const FONT_SPAN = "span[style*='--font-height']";

/** 範囲と交わる文字の層（文書の順）． */
function selectedTextLayers(range) {
  return [...document.querySelectorAll("#viewer .page .textLayer")].filter((layer) => range.intersectsNode(layer));
}

/** 文字の層の client 座標の矩形を，層に対する割合の矩形にする（getSelectionBoxes と同じ回転の扱い）． */
function layerRotator(layer) {
  const { x: lx, y: ly, width: pw, height: ph } = layer.getBoundingClientRect();
  switch (layer.getAttribute("data-main-rotation")) {
    case "90":
      return (r) => ({ x: (r.y - ly) / ph, y: 1 - (r.x + r.width - lx) / pw, width: r.height / ph, height: r.width / pw });
    case "180":
      return (r) => ({ x: 1 - (r.x + r.width - lx) / pw, y: 1 - (r.y + r.height - ly) / ph, width: r.width / pw, height: r.height / ph });
    case "270":
      return (r) => ({ x: 1 - (r.y + r.height - ly) / ph, y: (r.x - lx) / pw, width: r.height / ph, height: r.width / pw });
    default:
      return (r) => ({ x: (r.x - lx) / pw, y: (r.y - ly) / ph, width: r.width / pw, height: r.height / ph });
  }
}

/**
 * 文字の層の span と，ページの文字の項目の番号の対応．pdf.js は，文字が空でない項目ごとに span を順に作る．
 * 覚えた項目の文字と合わなければ null（分類を使わない）．
 */
function spanIndexMap(layer, pageIndex) {
  const spans = [...layer.querySelectorAll(FONT_SPAN)];
  const strs = scanned[pageIndex]?.items.filter((i) => typeof i.str === "string" && i.str !== "").map((i) => i.str);
  if (!strs || spans.length > strs.length) return null;
  for (const k of [0, spans.length >> 1, spans.length - 1]) {
    if (spans[k] && spans[k].textContent !== strs[k]) {
      console.warn("[transnote] text layer spans do not match the text content", pageIndex);
      return null;
    }
  }
  return new Map(spans.map((s, k) => [s, k]));
}

/** 範囲 range の中の，文字の層 layer の断片（文書の順）． */
function piecesInLayer(range, layer) {
  const pageIndex = pageIndexOf(layer);
  const map = spanIndexMap(layer, pageIndex);
  const toBox = layerRotator(layer);
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeType === Node.ELEMENT_NODE ? (n.matches(SKIP_IN_LAYER) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT,
  });
  const out = [];
  const sub = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const s = node === range.startContainer ? range.startOffset : 0;
    const e = node === range.endContainer ? range.endOffset : node.length;
    if (s >= e) continue;
    const span = node.parentElement?.closest(FONT_SPAN);
    if (!span || !layer.contains(span)) continue;
    sub.setStart(node, s);
    sub.setEnd(node, e);
    const rects = [...sub.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    out.push({
      pageIndex,
      node,
      start: s,
      end: e,
      text: node.data.slice(s, e),
      spanIndex: map?.get(span) ?? -1,
      boxes: rects.map(toBox),
      rect: union(rects),
    });
  }
  return out;
}

/** 断片の矩形を，行ごとに 1 つにまとめる（続く断片で，縦が重なり，横の隙間が小さいもの）． */
function mergeBoxes(pieces) {
  const out = [];
  for (const b of pieces.flatMap((p) => p.boxes)) {
    const last = out.at(-1);
    if (last) {
      const overlap = Math.min(last.y + last.height, b.y + b.height) - Math.max(last.y, b.y);
      const gap = b.x - (last.x + last.width);
      if (overlap > 0.5 * Math.min(last.height, b.height) && gap < 2 * Math.max(last.height, b.height) && gap > -last.width) {
        const x = Math.min(last.x, b.x);
        const y = Math.min(last.y, b.y);
        last.width = Math.max(last.x + last.width, b.x + b.width) - x;
        last.height = Math.max(last.y + last.height, b.y + b.height) - y;
        last.x = x;
        last.y = y;
        continue;
      }
    }
    out.push({ ...b });
  }
  return out;
}

/** 断片の文字をつなぐ．行が変わるところ，ページが変わるところ，除いた部分を挟むところは改行にする． */
function joinPieces(pieces) {
  let out = "";
  let prev = null;
  for (const p of pieces) {
    if (prev) {
      const newLine =
        p.pageIndex !== prev.pageIndex || p.after !== prev.index || p.rect.top > prev.rect.bottom - p.rect.height / 2 || p.rect.bottom < prev.rect.top;
      if (newLine) out += "\n";
    }
    out += p.text;
    prev = p;
  }
  return out;
}

/** 断片の並びから，ページごとの部分を作る（ハイライト 1 件ずつになる）． */
function buildParts(pieces) {
  const parts = [];
  for (const p of pieces) {
    let part = parts.at(-1);
    if (!part || part.pageIndex !== p.pageIndex) {
      part = { pageIndex: p.pageIndex, pieces: [] };
      parts.push(part);
    }
    part.pieces.push(p);
  }
  return parts
    .map(({ pageIndex, pieces: ps }) => ({
      pageIndex,
      boxes: mergeBoxes(ps),
      text: joinPieces(ps),
      anchorNode: ps[0].node,
      anchorOffset: ps[0].start,
      focusNode: ps.at(-1).node,
      focusOffset: ps.at(-1).end,
    }))
    .filter((part) => part.boxes.length);
}

/** 断片の並びから anchor を作る（removed は除いた部分の一覧）． */
function makeAnchor(pieces, { text = null, removed = [], backward = false } = {}) {
  const parts = buildParts(pieces);
  if (!parts.length) return null;
  const joined = text ?? joinPieces(pieces);
  if (!joined.trim()) return null;
  return {
    text: joined,
    // 最初の部分（1 ページだけのときは，これまでと同じ形で使える）
    pageIndex: parts[0].pageIndex,
    boxes: parts[0].boxes,
    anchorNode: parts[0].anchorNode,
    anchorOffset: parts[0].anchorOffset,
    focusNode: parts[0].focusNode,
    focusOffset: parts[0].focusOffset,
    parts,
    focusPart: backward ? 0 : parts.length - 1, // 選び終えた側の部分（ポップアップをそこに出す）
    removed,
    raw: null,
  };
}

/** 直前の captureAnchor で，途中のページの文字の層がまだなかったか（描き終えたら読み直す）． */
let missingLayer = false;

/**
 * 今の選択を，ハイライトにするための情報（anchor）として記録する．ページをまたいでよい（MAX_SELECTION_PAGES まで）．
 * 本文に挟まれたヘッダー・フッター・図表の見出しなどは，設定に従って除く（page-structure.mjs）．
 * @param {{notify?: boolean}} [opts] notify が真なら，長すぎる選択を知らせる
 */
function captureAnchor({ notify = false } = {}) {
  missingLayer = false;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const layers = selectedTextLayers(range);
  if (!layers.length || layers.some((l) => l.hidden || l.closest("[hidden]"))) return null;
  const first = pageIndexOf(layers[0]);
  const last = pageIndexOf(layers.at(-1));
  if (first < 0 || last < 0) return null;
  if (last - first + 1 > MAX_SELECTION_PAGES) {
    if (notify) emit("notice", "selectionTooLong", { maxPages: MAX_SELECTION_PAGES });
    return null;
  }
  if (layers.length !== last - first + 1) {
    missingLayer = true; // 途中のページを描いている途中
    return null;
  }
  const pieces = layers.flatMap((layer) => piecesInLayer(range, layer));
  if (!pieces.some((p) => p.text.trim())) return null;
  pieces.forEach((p, i) => {
    p.index = i;
    p.after = i - 1;
  });
  const backward = sel.anchorNode === range.endContainer && sel.anchorOffset === range.endOffset;

  // 本文に挟まれたものを除く
  let kept = pieces;
  let removed = [];
  const a = currentAnalysis();
  if (a) {
    try {
      const r = filterSelection(pieces, a, filterOptions);
      if (r.keep.some((k) => !k) && r.keep.some((k, i) => k && pieces[i].text.trim())) {
        kept = pieces.filter((_, i) => r.keep[i]);
        removed = r.removed;
      }
    } catch (e) {
      console.error("[transnote] filterSelection", e);
    }
  }
  // 除いた部分を挟むところは改行にする（cleanSource がページの境目で切れた単語をつなぎ直す）
  kept.forEach((p, i) => {
    if (i > 0) p.after = kept[i - 1].index === p.index - 1 ? p.index - 1 : -1;
  });

  // 1 ページの中で，何も除かず，範囲が文字の層の中に収まるときは，文字をこれまでどおり選択の文字にする
  const simple = !removed.length && layers.length === 1 && layers[0].contains(range.commonAncestorContainer);
  const anchor = makeAnchor(kept, { text: simple ? sel.toString() : null, removed, backward });
  if (anchor && removed.length) {
    pieces.forEach((p, i) => (p.after = i - 1));
    anchor.raw = makeAnchor(pieces, { backward });
  }
  return anchor;
}

/**
 * ページをまたぐハイライトのまとまり（このセッションの間だけ．保存すると残らない）．
 * 部分のハイライト → まとまりの部分の並び．コメント・色・削除・翻訳中の印は，まとまり全体に行う．
 */
const groups = new WeakMap();
/** ed のまとまりの部分（生きているもの）．まとまりでなければ [ed]． */
const groupOf = (ed) => (groups.get(ed) ?? [ed]).filter(editorAlive);

/** 部分 1 つ分の，ハイライトを作るための値． */
const editorData = (part, text) => ({
  methodOfCreation: HOOK_LABEL,
  boxes: part.boxes,
  // その部分の最初と最後の文字（他のページの位置を渡すと，選びを外したときにカーソルがそのページへ飛ぶ）
  anchorNode: part.anchorNode ?? null,
  anchorOffset: part.anchorOffset ?? 0,
  focusNode: part.focusNode ?? null,
  focusOffset: part.focusOffset ?? 0,
  text,
});

/**
 * モードを切り替えずにハイライトを作る．ハイライト用のモードに切り替えると，その間にユーザーが選んだ文字を
 * pdf.js が自動でハイライトしてしまううえ，切り替えに時間もかかるため．作れなければ null．
 */
function createEditorDirect(part, text) {
  const um = uiManager();
  const Cls = highlightClass();
  const layer = um?.getLayer(part.pageIndex);
  if (!Cls || !layer) return null;
  try {
    const ed = new Cls({ parent: layer, id: um.getId(), x: 0, y: 0, uiManager: um, isCentered: false, ...editorData(part, text) });
    // 作った直後に注釈へフォーカスすると pdf.js が編集モードに入るので，フォーカスさせない
    const onceAdded = ed.onceAdded.bind(ed);
    ed.onceAdded = () => onceAdded(false);
    layer.add(ed);
    delete ed.onceAdded;
    if (um.getMode() === EditorType().NONE) ed.disableEditing();
    return ed;
  } catch (e) {
    console.warn("[transnote] direct highlight failed; falling back", e);
    return null;
  }
}

/**
 * 記録した範囲に，色 color のハイライトを作る．ページをまたぐ範囲は，ページごとのハイライトにして，まとまりとして覚える．
 * 最初の部分のハイライトの target を返す（作れなければ null）．
 */
async function createHighlight(anchor, color) {
  const parts = (anchor.parts ?? [{ pageIndex: anchor.pageIndex, boxes: anchor.boxes, ...anchor }]).filter((p) => p.boxes?.length);
  if (!parts.length) return null;
  // まだ描かれていないページ：最初の部分のページを 1 回だけ表示して，足りない注釈の層ができるのを待つ
  const missing = parts.filter((p) => !uiManager()?.getLayer(p.pageIndex));
  if (missing.length) {
    const waits = missing.map((p) => waitEvent("annotationeditorlayerrendered", (e) => e.pageNumber === p.pageIndex + 1));
    app().page = missing[0].pageIndex + 1;
    await Promise.all(waits);
  }
  // どの部分のハイライトにも，つないだ全文を覚える（どの部分から訳し直しても全文を訳す）
  const text = anchor.text;
  const made = new Map(); // part → editor
  for (const part of parts) {
    const ed = createEditorDirect(part, text);
    if (ed) made.set(part, ed);
  }
  // 作れなかった部分は，pdf.js の手順（ハイライト用のモードにして作る）で，1 回の切り替えの中でまとめて作る
  const rest = parts.filter((p) => !made.has(p) && uiManager()?.getLayer(p.pageIndex));
  if (rest.length) {
    await inHighlightMode(async (um2) => {
      for (const part of rest) {
        const layer = um2.getLayer(part.pageIndex);
        const ed = layer?.createAndAddNewEditor({ x: 0, y: 0 }, false, editorData(part, text));
        if (ed) made.set(part, ed);
      }
    });
  }
  const eds = parts.map((p) => made.get(p)).filter(Boolean);
  if (!eds.length) return null;
  for (const [part, ed] of made) {
    editorText.set(ed, text);
    editorBoxes.set(ed, part.boxes);
    if (color) ed.updateParams(lib().AnnotationEditorParamsType.HIGHLIGHT_COLOR, color);
  }
  if (eds.length > 1) for (const ed of eds) groups.set(ed, eds);
  if (eds.length < parts.length) emit("notice", "highlightPartsFailed", { failed: parts.length - eds.length, total: parts.length });
  uiManager()?.showAllEditors("highlight", true, true);
  highlightsChanged();
  return { kind: "editor", editor: eds[0] };
}

// ---------------------------------------------------------------------------
// 4. target の扱い
// ---------------------------------------------------------------------------

const editorAlive = (ed) => !!ed && uiManager()?.getEditor(ed.id) === ed;

/** ファイルにあった注釈が，すでに編集用の部品に変わっていれば，その部品． */
function editorForAnnotation(id, pageIndex) {
  const um = uiManager();
  if (!um) return null;
  for (const ed of um.getEditors(pageIndex)) if (ed.annotationElementId === id) return ed;
  return null;
}

/** target が「編集用の部品」を指すようにできれば，その部品を返す（モードは切り替えない）． */
function resolveEditor(target) {
  if (target.kind === "editor") return editorAlive(target.editor) ? target.editor : null;
  const ed = editorForAnnotation(target.id, target.pageIndex);
  if (ed) Object.assign(target, { kind: "editor", editor: ed });
  return ed;
}

/**
 * target の編集用の部品に対して fn を行う．ファイルにあった注釈は，ハイライト用のモードにすると
 * pdf.js が編集用の部品に変えるので，そうしてから行い，通常のモードに戻す（変更した部品は残る）．
 * ページが描かれていないときは，描かれるまで待つ（ページは動かさない）．
 */
async function withEditor(target, fn) {
  const ed = resolveEditor(target);
  if (ed) return fn(ed);
  if (target.kind !== "annotation") return false;
  if (!uiManager()?.getLayer(target.pageIndex)) {
    await waitEvent("annotationeditorlayerrendered", (e) => e.pageNumber === target.pageIndex + 1, 24 * 3600 * 1000);
  }
  return inHighlightMode(async () => {
    let found = editorForAnnotation(target.id, target.pageIndex);
    if (!found) {
      await waitEvent("editorsrendered", (e) => e.pageNumber === target.pageIndex + 1, 2000);
      found = editorForAnnotation(target.id, target.pageIndex);
    }
    if (!found) return false;
    Object.assign(target, { kind: "editor", editor: found });
    return fn(found);
  });
}

function isAlive(target) {
  if (!target) return false;
  if (target.kind === "editor") return editorAlive(target.editor);
  const um = uiManager();
  if (um?.isDeletedAnnotationElement?.(target.id)) return false;
  return (
    !!annotationElement(target.pageIndex, target.id) ||
    !!editorForAnnotation(target.id, target.pageIndex) ||
    !!fileData(target.pageIndex, target.id)
  );
}

function pageOf(target) {
  if (!target) return null;
  return (target.kind === "editor" ? target.editor.pageIndex : target.pageIndex) + 1;
}

/** target を見分ける鍵．ファイルにあった注釈は，編集用の部品に変わっても同じ鍵になる． */
function keyOf(target) {
  if (!target) return "";
  const ed = resolveEditor(target);
  if (ed) return ed.annotationElementId ? `a:${ed.annotationElementId}` : `e:${ed.id}`;
  return target.kind === "annotation" ? `a:${target.id}` : `e:${target.editor?.id}`;
}

function getComment(target) {
  const ed = resolveEditor(target);
  if (ed) return ed.comment?.text ?? "";
  const data = annotationElement(target.pageIndex, target.id)?.data;
  return data ? (data.contentsObj?.str ?? "") : (fileData(target.pageIndex, target.id)?.comment ?? "");
}

/** コメントが書けなかったハイライト（ページが描かれていないなど）．描かれたらもう一度書く． */
const pendingComments = new Map();

function writeComment(ed, text) {
  try {
    ed.comment = text;
    pendingComments.delete(ed);
  } catch {
    pendingComments.set(ed, text);
  }
  return true;
}

/** 書き換えが済んだら，一覧が変わったと知らせる． */
const changed = (ok) => {
  if (ok) highlightsChanged();
  return ok;
};

async function setComment(target, text) {
  if (!isAlive(target)) return false;
  return changed(
    !!(await withEditor(target, (ed) => {
      for (const part of groupOf(ed)) writeComment(part, text); // まとまりのどの部分にも同じ訳を入れる
      return true;
    })),
  );
}

function getColor(target) {
  const ed = resolveEditor(target);
  if (ed) return ed.color ?? null;
  return toHex(annotationElement(target.pageIndex, target.id)?.data?.color) ?? fileData(target.pageIndex, target.id)?.color ?? null;
}

async function setColor(target, color) {
  if (!isAlive(target)) return false;
  return changed(
    !!(await withEditor(target, (ed) => {
      for (const part of groupOf(ed)) part.updateParams(lib().AnnotationEditorParamsType.HIGHLIGHT_COLOR, color);
      return true;
    })),
  );
}

async function remove(target) {
  if (!isAlive(target)) return false;
  return changed(
    !!(await withEditor(target, (ed) => {
      for (const part of groupOf(ed)) part.remove(); // ファイルにあった注釈なら，消したことが記録され，保存で消える
      return true;
    })),
  );
}

/**
 * target の範囲を，ページに対する割合の矩形の並びで返す（{pageIndex, boxes}）．
 * 通常のモードでは pdf.js が注釈の編集の層ごと隠す（ハイライトは別の描画の層に描く）ので，
 * 編集用の部品の大きさは使えない．このセッションで作ったものは選んだ範囲，ファイルにあったものは
 * 注釈の quadPoints，どちらもなければ部品の位置（x，y，width，height）から求める．
 */
function fracBoxes(target) {
  const ed = resolveEditor(target);
  const pageIndex = ed ? ed.pageIndex : target.pageIndex;
  if (ed && editorBoxes.has(ed)) return { pageIndex, boxes: editorBoxes.get(ed) };
  const id = ed ? ed.annotationElementId : target.id;
  const quads = id ? quadsOf(pageIndex, id) : null;
  if (quads?.length) return { pageIndex, boxes: quadFractions(pageIndex, quads) };
  if (ed && ed.width) return { pageIndex, boxes: [{ x: ed.x, y: ed.y, width: ed.width, height: ed.height }] };
  return { pageIndex, boxes: [] };
}

/** ページの中身（枠線の内側）の画面の上の矩形． */
function pageInnerRect(pageIndex) {
  const div = pageDiv(pageIndex);
  if (!div) return null;
  return (div.querySelector(".canvasWrapper") ?? div).getBoundingClientRect();
}

/** 割合の矩形を，画面の矩形（client 座標）にする． */
function toClientRects(pageIndex, boxes) {
  const r = pageInnerRect(pageIndex);
  if (!r || !r.width) return [];
  return boxes.map((b) => new DOMRect(r.left + b.x * r.width, r.top + b.y * r.height, b.width * r.width, b.height * r.height));
}

/** 翻訳中の印（ハイライトの上の点線の枠）を付け外す．ページをまたぐまとまりは，すべての部分に付ける． */
function markBusy(target, on) {
  if (!target) return;
  const ed = target.kind === "editor" ? target.editor : resolveEditor(target);
  const members = ed && groups.has(ed) ? groups.get(ed) : null; // 消えた部分の印も外せるよう，生死を問わない
  if (!members) return markBusyOne(target, on);
  for (const m of members) markBusyOne({ kind: "editor", editor: m }, on && editorAlive(m));
}

/** 翻訳中の印を 1 件分付け外す．ページの中に置くので，倍率が変わっても位置が合う． */
function markBusyOne(target, on) {
  const key = target.kind === "editor" ? target.editor.id : `a-${target.id}`;
  for (const old of document.querySelectorAll(`.tnBusyMark[data-key="${CSS.escape(key)}"]`)) old.remove();
  if (!on) return;
  const { pageIndex, boxes } = fracBoxes(target);
  const div = pageDiv(pageIndex);
  if (!div) return;
  for (const b of boxes) {
    const m = document.createElement("div");
    m.className = "tnBusyMark";
    m.dataset.key = key;
    Object.assign(m.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` });
    div.append(m);
  }
}

/** 画面の上での target の位置（client 座標）．見えない（描かれていない）ときは null． */
function rectOf(target) {
  if (!target) return null;
  const { pageIndex, boxes } = fracBoxes(target);
  return union(toClientRects(pageIndex, boxes));
}

/** 記録した範囲の位置（client 座標）．ページをまたぐときは，選び終えた側の部分（なければ見えている部分）． */
function rectOfAnchor(anchor) {
  const parts = anchor.parts ?? [anchor];
  const rectOfPart = (part) => {
    const layer = textLayerOf(part.pageIndex);
    if (!layer || !part.boxes?.length) return null;
    const r = layer.getBoundingClientRect();
    return union(part.boxes.map((b) => new DOMRect(r.left + b.x * r.width, r.top + b.y * r.height, b.width * r.width, b.height * r.height)));
  };
  const focus = parts[anchor.focusPart ?? parts.length - 1];
  return (focus && rectOfPart(focus)) ?? union(parts.map(rectOfPart));
}

// ---------------------------------------------------------------------------
// 5. ハイライトの範囲の文字
// ---------------------------------------------------------------------------

/** 注釈の quadPoints（PDF の座標）を，ページに対する割合の矩形にする． */
function quadFractions(pageIndex, quadPoints) {
  const view = app().pdfViewer.getPageView(pageIndex);
  const vp = view?.viewport;
  if (!vp || !quadPoints?.length) return [];
  const out = [];
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    // 4 つの角を画面の座標に移して包む（v6 には convertToViewportRectangle がない．回転にも対応する）
    const pts = [0, 2, 4, 6].map((k) => vp.convertToViewportPoint(quadPoints[i + k], quadPoints[i + k + 1]));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    out.push({ x: left / vp.width, y: top / vp.height, width: (Math.max(...xs) - left) / vp.width, height: (Math.max(...ys) - top) / vp.height });
  }
  return out;
}

/** 文字の層から，矩形の中にある文字を取り出す（1 文字ずつ，その中心が矩形の中にあるかで判定）． */
function textInRects(pageIndex, rects) {
  const layer = textLayerOf(pageIndex);
  if (!layer || !rects.length) return "";
  const box = union(rects);
  const range = document.createRange();
  const out = [];
  let lastBottom = null;
  for (const span of layer.querySelectorAll("span")) {
    if (span.children.length) continue; // 入れ子の span は中身の方で数える
    const sr = span.getBoundingClientRect();
    if (sr.bottom < box.top || sr.top > box.bottom || sr.right < box.left || sr.left > box.right) continue;
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    let piece = "";
    for (let i = 0; i < node.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const cr = range.getBoundingClientRect();
      const cx = cr.left + cr.width / 2;
      const cy = cr.top + cr.height / 2;
      if (rects.some((r) => inside(r, cx, cy, 1))) piece += node.data[i];
    }
    if (!piece) continue;
    if (lastBottom !== null && sr.top > lastBottom - sr.height / 2) out.push("\n");
    out.push(piece);
    lastBottom = sr.bottom;
  }
  return out.join("");
}

/** ファイルにあった注釈の quadPoints（描かれていれば pdf.js の要素から，なければ覚えた一覧から）． */
function quadsOf(pageIndex, id) {
  return annotationElement(pageIndex, id)?.data?.quadPoints ?? fileData(pageIndex, id)?.quadPoints ?? null;
}

const hasTextLayer = (pageIndex) => !!textLayerOf(pageIndex)?.querySelector("span");

/**
 * ページの文字（pdf.js の getTextContent）．ページごとに覚える．
 * 文字の層と同じ指定（印の項目を含め，文字を正規化しない）で取るので，項目の順と span の順が合う．
 * @returns {Promise<{view, rotate, items, styles} | null>}
 */
function pageContent(pageIndex) {
  let p = contentCache.get(pageIndex);
  if (!p) {
    const d = currentDoc();
    p = d
      ? d
          .getPage(pageIndex + 1)
          .then(async (page) => {
            const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
            const content = { view: page.view, rotate: page.rotate, items: tc.items, styles: tc.styles };
            if (d === doc) {
              scanned[pageIndex] = content;
              analysisDirty = true;
            }
            return content;
          })
          .catch(() => null)
      : Promise.resolve(null);
    contentCache.set(pageIndex, p);
  }
  return p;
}

/** ページの文字の項目（印の項目を除く）． */
const textItems = (pageIndex) => pageContent(pageIndex).then((c) => (c ? c.items.filter((i) => typeof i.str === "string") : []));

/** 文書を開いたら，裏で全ページの文字を読む（本文とそれ以外を見分けるため）．画面を止めないよう少しずつ． */
async function scanDocument(d) {
  const n = app()?.pagesCount ?? 0;
  for (let i = 0; i < n; i++) {
    if (d !== doc) return;
    await pageContent(i);
    if (i % 4 === 3) await sleep(0);
  }
}

/** 本文とそれ以外の分類．読み終えたページだけで分ける（読んでいないページは分類なし）． */
function currentAnalysis() {
  if (!currentDoc()) return null;
  if (analysisDirty || !analysis) {
    const n = app()?.pagesCount ?? 0;
    const pages = Array.from({ length: n }, (_, i) => scanned[i] ?? null);
    try {
      analysis = analyzeDocument(pages, { furnitureBand: filterOptions.furnitureBand, sizeTolerance: filterOptions.sizeTolerance });
    } catch (e) {
      console.error("[transnote] analyzeDocument", e);
      analysis = null;
    }
    analysisDirty = false;
  }
  return analysis;
}

/** 本文の間から除くものの指定（app 側の設定から渡される）． */
let filterOptions = { ...STRUCTURE_DEFAULTS };

function setSelectionFilter(options = {}) {
  const next = { ...filterOptions };
  for (const k of Object.keys(STRUCTURE_DEFAULTS)) {
    if (options[k] === undefined) continue;
    next[k] = typeof STRUCTURE_DEFAULTS[k] === "boolean" ? !!options[k] : Number(options[k]);
  }
  if (next.furnitureBand !== filterOptions.furnitureBand || next.sizeTolerance !== filterOptions.sizeTolerance) analysisDirty = true;
  filterOptions = next;
}

/**
 * target の範囲の文字（原文）．順に：このセッションで選んでいた文字 → 覚えた文字 → 文字の層（描かれているとき）．
 * ポップアップのように，すぐに要るときに使う．
 */
function sourceText(target) {
  const ed = resolveEditor(target);
  if (ed && editorText.has(ed)) return editorText.get(ed);
  const id = ed ? ed.annotationElementId : target.kind === "annotation" ? target.id : null;
  if (id && textCache.has(id)) return textCache.get(id);
  const { pageIndex, boxes } = fracBoxes(target);
  const text = textInRects(pageIndex, toClientRects(pageIndex, boxes));
  if (id && text) textCache.set(id, text);
  return text;
}

/** sourceText と同じ．ただし，描かれていないページでは PDF の文字の位置から取り出す． */
async function sourceTextAsync(target) {
  const ed = resolveEditor(target);
  if (ed && editorText.has(ed)) return editorText.get(ed);
  const id = ed ? ed.annotationElementId : target.kind === "annotation" ? target.id : null;
  if (id && textCache.has(id)) return textCache.get(id);
  const { pageIndex, boxes } = fracBoxes(target);
  let text = hasTextLayer(pageIndex) ? textInRects(pageIndex, toClientRects(pageIndex, boxes)) : "";
  const quads = id ? quadsOf(pageIndex, id) : null;
  if (!text && quads) text = textInQuads(await textItems(pageIndex), quads);
  if (id && text) textCache.set(id, text);
  return text;
}

/** 一覧の 1 件． */
async function describe(target) {
  const { pageIndex, boxes } = fracBoxes(target);
  const first = boxes[0] ?? { x: 0, y: 0 };
  return {
    target,
    key: keyOf(target),
    pageIndex,
    top: first.y,
    left: first.x,
    color: getColor(target),
    comment: getComment(target),
    text: await sourceTextAsync(target),
  };
}

/**
 * 文書のすべてのハイライト（ページ順，ページの中では上から下，左から右）．
 * このセッションの部品と，ファイルにあったもの（部品に変わったものと消したものを除く）．
 * @returns {Promise<{target, key, pageIndex, top, left, color, comment, text}[]>}
 */
async function listHighlights() {
  const d = currentDoc();
  if (!d) return [];
  await loadAllHighlights();
  if (d !== doc) return [];
  const um = uiManager();
  const out = [];
  for (let p = 0; p < app().pagesCount; p++) {
    const eds = um ? [...um.getEditors(p)].filter((ed) => ed.editorType === "highlight" && !ed.isEmpty?.() && !ed.deleted) : [];
    const replaced = new Set(eds.map((ed) => ed.annotationElementId).filter(Boolean));
    for (const ed of eds) out.push(await describe({ kind: "editor", editor: ed }));
    for (const h of fileHl.get(p) ?? []) {
      if (replaced.has(h.id) || um?.isDeletedAnnotationElement?.(h.id)) continue;
      out.push(await describe({ kind: "annotation", id: h.id, pageIndex: p }));
    }
  }
  return out.sort(compareHighlights);
}

// ---------------------------------------------------------------------------
// 6. ハイライトのクリックと，ダブルクリックで編集モードに入るのを止める
// ---------------------------------------------------------------------------

/** 点 (x, y) にあるハイライトの target．なければ null． */
function highlightAt(x, y, pageIndex) {
  const um = uiManager();
  if (!um || pageIndex < 0) return null;
  for (const ed of um.getEditors(pageIndex)) {
    if (ed.editorType !== "highlight" || ed.isEmpty?.()) continue;
    const target = { kind: "editor", editor: ed };
    if (toClientRects(pageIndex, fracBoxes(target).boxes).some((r) => inside(r, x, y, 1))) return target;
  }
  for (const s of pageDiv(pageIndex)?.querySelectorAll(".annotationLayer .highlightAnnotation[data-annotation-id]") ?? []) {
    if (s.hidden || s.closest("[hidden]")) continue;
    if (inside(s.getBoundingClientRect(), x, y)) {
      const id = s.dataset.annotationId;
      return editorForAnnotation(id, pageIndex) ? { kind: "editor", editor: editorForAnnotation(id, pageIndex) } : { kind: "annotation", id, pageIndex };
    }
  }
  return null;
}

const inNoneMode = () => uiManager()?.getMode() === EditorType().NONE;
const isUiControl = (el) => !!el?.closest?.("button, a, input, textarea, select, .popup, .commentPopup, .editToolbar, [contenteditable]");

function bindPointer(container) {
  let down = null;
  let lastDown = { t: 0, x: 0, y: 0 };

  container.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const pageIndex = pageIndexOf(e.target);
      // 2 回目の押し下げ（ダブルクリック）がハイライトの上なら，pdf.js に渡さない
      // （pdf.js は文字の層でダブルクリックを見つけると，ハイライトの編集モードに入る）
      const dbl = e.timeStamp - lastDown.t < 500 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
      lastDown = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      if (dbl && inNoneMode() && highlightAt(e.clientX, e.clientY, pageIndex)) e.stopPropagation();
      down = { x: e.clientX, y: e.clientY, pageIndex, onControl: isUiControl(e.target) };
    },
    true,
  );
  // 注釈の層の要素も，ダブルクリックで編集モードに入る（_editOnDoubleClick）ので止める
  container.addEventListener(
    "dblclick",
    (e) => {
      if (inNoneMode() && highlightAt(e.clientX, e.clientY, pageIndexOf(e.target))) e.stopPropagation();
    },
    true,
  );
  // window の捕捉の段階で受ける（注釈の層の要素は，pdf.js がコメントの表示のために伝わるのを止めることがある．
  // また，ページをまたいで選ぶときは，文書の外（ツールバーの上など）で離すことがある）
  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.button !== 0 || !down) return;
      const start = down;
      down = null;
      setTimeout(() => {
        const anchor = captureAnchor({ notify: true });
        if (anchor) {
          emit("selection", anchor);
          return;
        }
        // 途中のページを描いている途中だった：描き終えたら読み直す
        if (missingLayer) {
          waitEvent("textlayerrendered", null, 1000).then(() => {
            const again = captureAnchor({ notify: true });
            if (again) emit("selection", again);
          });
          return;
        }
        // 動かさずに押して離した（クリック）：ハイライトの上なら知らせる
        if (start.onControl || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 || !inNoneMode()) return;
        const target = highlightAt(e.clientX, e.clientY, start.pageIndex);
        if (target) emit("highlightClick", target, { x: e.clientX, y: e.clientY });
      }, 0);
    },
    true,
  );
  // キーで選んだとき（Shift＋矢印など）．pdf.js が選択の終わりの印を戻した後に読む
  container.addEventListener("keyup", (e) => {
    if (!e.shiftKey) return;
    setTimeout(() => {
      const anchor = captureAnchor({ notify: true });
      if (anchor) emit("selection", anchor);
    }, 0);
  });
}

// ---------------------------------------------------------------------------
// 7. 保存・開く・ドロップ・ツールバー
// ---------------------------------------------------------------------------

let saveHandler = null;
let openHandler = null;
let dropHandler = null;

function hookOpenFile(a) {
  let input = null;
  Object.defineProperty(a, "_openFileInput", {
    configurable: true,
    get: () => input,
    set: (v) => {
      input = v;
      if (v) {
        const original = v.click.bind(v);
        v.click = () => (openHandler ? openHandler() : original());
      }
    },
  });
}

function hookSave(a) {
  a.downloadOrSave = async function () {
    uiManager()?.endCurrentEditing();
    await saveHandler?.({ manual: true });
  };
}

function bindDrop() {
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  window.addEventListener(
    "dragover",
    (e) => {
      if (!dropHandler || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    },
    true,
  );
  window.addEventListener(
    "drop",
    (e) => {
      // pdf.js の既定（ファイルを中身だけで開く）ではパスが分からず，元の場所に保存できないため，app に渡す
      if (!dropHandler || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dropHandler(e.dataTransfer.files);
    },
    true,
  );
}

function addToolbarButton({ id, title, onClick }) {
  const right = document.getElementById("toolbarViewerRight");
  if (!right) return null;
  const b = document.createElement("button");
  b.id = id;
  b.className = "toolbarButton";
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  const sep = document.createElement("div");
  sep.className = "verticalToolbarSeparator";
  right.prepend(b, sep);
  return b;
}

// ---------------------------------------------------------------------------
// 7b. 左のパネル（pdf.js の ViewsManager）に「Annotations」のビューを足す
// ---------------------------------------------------------------------------
// pdf.js 6 のビューは 4 つ（ページ・アウトライン・添付・レイヤー）に固定されているので，
// 選択肢と中身の入れ物を足し，ViewsManager の switchView をインスタンスの上で包む．
// 選んだビューの番号は pdf.js が文書ごとに覚え（sidebarviewchanged），開き直すと switchView で戻す．

const ANNOTATIONS_VIEW = 101; // pdf.js の SidebarView と重ならない番号
let sidebarView = null; // { vm, button, container, label, title, visible }

function installSidebarView(a) {
  const vm = a.viewsManager;
  const menu = document.getElementById("viewsManagerSelectorOptions");
  const content = document.getElementById("viewsManagerContent");
  const label = document.getElementById("viewsManagerHeaderLabel");
  if (!vm || !menu || !content || !label || sidebarView) return;
  const button = document.createElement("button");
  button.id = "transnoteAnnotationsViewMenu";
  button.type = "button";
  button.tabIndex = -1;
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", "false");
  const span = document.createElement("span");
  span.textContent = "Annotations";
  button.append(span);
  menu.append(button);
  const container = document.createElement("div");
  container.id = "transnoteAnnotationsView";
  container.className = "hidden";
  container.tabIndex = -1;
  content.append(container);
  sidebarView = { vm, button, container, label, title: "Annotations", visible: false };

  const builtIns = [
    [vm.thumbnailButton, vm.thumbnailsView],
    [vm.outlineButton, vm.outlinesView],
    [vm.attachmentsButton, vm.attachmentsView],
    [vm.layersButton, vm.layersView],
  ];
  const showOurs = (on) => {
    button.classList.toggle("selected", on);
    button.setAttribute("aria-selected", String(on));
    container.classList.toggle("hidden", !on);
  };
  const original = vm.switchView.bind(vm);
  vm.switchView = (view, forceOpen = false) => {
    if (view !== ANNOTATIONS_VIEW) {
      showOurs(false);
      original(view, forceOpen);
      updateSidebarVisibility();
      return;
    }
    const isChanged = vm.active !== ANNOTATIONS_VIEW;
    for (const [b, v] of builtIns) {
      b?.classList.remove("selected");
      b?.setAttribute("aria-selected", "false");
      v?.classList.add("hidden");
    }
    showOurs(true);
    label.removeAttribute("data-l10n-id");
    label.textContent = sidebarView.title;
    if (vm.viewsManagerStatus) vm.viewsManagerStatus.hidden = true;
    if (vm.viewsManagerAddFileButton) vm.viewsManagerAddFileButton.hidden = true;
    if (vm.viewsManagerCurrentOutlineButton) vm.viewsManagerCurrentOutlineButton.hidden = true;
    vm.active = ANNOTATIONS_VIEW;
    if (forceOpen && !vm.isOpen) {
      vm.open(); // open は this.switchView(this.active) を呼ぶので，ここに戻ってくる
      return;
    }
    if (isChanged) a.eventBus.dispatch("sidebarviewchanged", { source: vm, view: vm.visibleView });
    updateSidebarVisibility();
  };
  // 選択肢を押したとき（メニューは pdf.js がクリックで閉じる）
  button.addEventListener("click", () => vm.switchView(ANNOTATIONS_VIEW, true));
  a.eventBus.on("sidebarviewchanged", () => setTimeout(updateSidebarVisibility, 0));
}

/** 独自のビューが見えているかが変わったら，app に知らせる． */
function updateSidebarVisibility() {
  if (!sidebarView) return;
  const { vm } = sidebarView;
  const visible = !!vm.isOpen && vm.active === ANNOTATIONS_VIEW;
  if (visible === sidebarView.visible) return;
  sidebarView.visible = visible;
  if (visible) setSidebarAlert(false);
  emit("sidebarView", visible);
}

function setSidebarAlert(on) {
  document.getElementById("viewsManagerToggleButton")?.classList.toggle("tnAlert", !!on);
}

/** pdf.js のハイライトに関わるイベントを見張る． */
function bindHighlights(a) {
  const bus = a.eventBus;
  bus.on("pagerendered", (e) => drawFileHighlights(e.pageNumber - 1));
  bus.on("pagerender", (e) => drawFileHighlights(e.pageNumber - 1));
  bus.on("annotationeditormodechanged", () => {
    drawAllFileHighlights();
    highlightsChanged();
  });
  bus.on("editorsrendered", (e) => drawFileHighlights(e.pageNumber - 1));
  bus.on("annotationeditorstateschanged", highlightsChanged);
  bus.on("documentloaded", () => {
    const d = currentDoc();
    scanDocument(d); // 本文とそれ以外を見分けるため，裏でページの文字を読む
    loadAllHighlights().then(() => {
      drawAllFileHighlights();
      highlightsChanged();
    });
  });
}

// ---------------------------------------------------------------------------
// 8. 起動
// ---------------------------------------------------------------------------

function bindLayout(a) {
  const fire = () => emit("layout");
  for (const name of ["scalechanging", "rotationchanging", "spreadmodechanged", "scrollmodechanged", "pagesloaded"]) {
    a.eventBus.on(name, () => nextFrame().then(fire));
  }
  let scheduled = false;
  const onScroll = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fire();
    });
  };
  document.getElementById("viewerContainer").addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  // 描かれていなかったページが描かれたら，書けなかったコメントをもう一度書く
  a.eventBus.on("annotationeditorlayerrendered", () => {
    for (const [ed, text] of pendingComments) {
      if (!editorAlive(ed)) pendingComments.delete(ed);
      else writeComment(ed, text);
    }
  });
}

document.addEventListener(
  "webviewerloaded",
  () => {
    const o = window.PDFViewerApplicationOptions;
    o.set("disablePreferences", true); // 保存済みの好みで上書きされないように
    o.set("enableComment", true);
    o.set("enableHighlightFloatingButton", false); // 独自のポップアップを使う
    o.set("defaultUrl", "");
    // 画面の言語は設定に従う（サーバーが viewer.html に書き込む．既定はブラウザーの言語なので必ず決める）
    const uiLang = document.querySelector('meta[name="transnote-ui-lang"]')?.content;
    o.set("localeProperties", { lang: uiLang === "ja" ? "ja" : "en-US" });
    const a = window.PDFViewerApplication;
    hookOpenFile(a);
    patchEditorClasses(); // 注釈の層が作られる前に（registerEditorTypes を受け取るため）
    a.initializedPromise.then(() => {
      hookSave(a);
      hookRendering(a);
      bindDrop();
      bindLayout(a);
      bindHighlights(a);
      installSidebarView(a); // 文書を開く前に（開くときに pdf.js が覚えたビューへ戻すため）
      bindPointer(document.getElementById("viewerContainer"));
      emit("ready");
    });
  },
  { once: true },
);

// ---------------------------------------------------------------------------
// 9. app 側に出す API
// ---------------------------------------------------------------------------

export const bridge = {
  /**
   * イベント：ready，selection(anchor)，highlightClick(target, point)，layout，
   * highlightsChanged（ハイライトの作成・変更・削除），sidebarView(visible)（左のパネルの Annotations が見えたか），
   * notice(code, data)（"selectionTooLong" {maxPages}，"highlightPartsFailed" {failed, total}）．
   */
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  },

  // 文書
  docUrl: () => new URLSearchParams(location.search).get("file") || "",
  hasDocument: () => !!app()?.pdfDocument,
  goToPage: (n) => {
    app().page = n;
  },
  /** 文書の表示領域（client 座標）．ポップアップをこの中に収める． */
  viewRect: () => document.getElementById("viewerContainer").getBoundingClientRect(),
  /** ポップアップなどを置く親（ページの外，ツールバーの下）． */
  overlayParent: () => document.getElementById("outerContainer"),

  // 選択と注釈
  currentAnchor: captureAnchor,
  clearSelection: () => document.getSelection()?.removeAllRanges(),
  rectOfAnchor,
  createHighlight,
  isAlive,
  pageOf,
  rectOf,
  getComment,
  setComment,
  getColor,
  setColor,
  remove,
  sourceText,
  markBusy,
  keyOf,
  listHighlights,
  /** 2 つの target が同じハイライトを指すか． */
  sameTarget: (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const ea = resolveEditor(a);
    const eb = resolveEditor(b);
    if (ea || eb) return ea === eb;
    return a.id === b.id && a.pageIndex === b.pageIndex;
  },
  /** 2 つの target が同じハイライトか，ページをまたぐ同じまとまりの部分か． */
  sameGroup: (a, b) => {
    if (bridge.sameTarget(a, b)) return true;
    const ea = a && resolveEditor(a);
    const eb = b && resolveEditor(b);
    return !!(ea && eb && groups.get(ea)?.includes(eb));
  },
  /** 本文の間から除くもの（{skipFurniture, furnitureBand, skipCaptions, skipSmallText, sizeTolerance}）． */
  setSelectionFilter,
  scrollTo: (target) => {
    const r = rectOf(target);
    if (r) document.getElementById("viewerContainer").scrollBy({ top: r.top - bridge.viewRect().top - 120 });
    else if (pageOf(target)) app().page = pageOf(target);
  },

  // 保存
  setSaveHandler: (fn) => (saveHandler = fn),
  hasChanges: () => app()?.pdfDocument?.annotationStorage.size > 0 || !!app()?._annotationStorageModified,
  isModified: () => !!app()?._annotationStorageModified,
  saveData: () => app().pdfDocument.saveDocument(),
  markSaved: () => app().pdfDocument.annotationStorage.resetModified(),
  setBusy: (on) => document.getElementById("outerContainer")?.classList.toggle("transnoteSaving", !!on),
  setDirtyMark: (on) => document.documentElement.classList.toggle("transnoteDirty", !!on),

  // 左のパネルの Annotations のビュー
  /** 中身の入れ物（まだ用意できていなければ null）． */
  sidebarContainer: () => sidebarView?.container ?? null,
  setSidebarTitle: (title) => {
    if (!sidebarView) return;
    sidebarView.title = title;
    if (sidebarView.vm.active === ANNOTATIONS_VIEW) sidebarView.label.textContent = title;
  },
  isSidebarVisible: () => !!sidebarView?.visible,
  showSidebar: () => sidebarView?.vm.switchView(ANNOTATIONS_VIEW, true),
  /** 左のパネルの開閉ボタンに印を付ける（翻訳の失敗など．Annotations が見えたら消える）． */
  setSidebarAlert,
  /** 左のパネルのビューの選択肢に出す名前． */
  setSidebarOptionLabel: (text) => {
    const span = sidebarView?.button.querySelector("span");
    if (span) span.textContent = text;
  },

  // 開く・ドロップ・ツールバー
  setOpenHandler: (fn) => (openHandler = fn),
  setDropHandler: (fn) => (dropHandler = fn),
  addToolbarButton,
  setSaveButtonTitle: (title) => {
    const b = document.getElementById("downloadButton");
    if (!b) return;
    // pdf.js は言語ファイルを読み終えてから説明を付ける（英語以外では起動の後になる）ので，訳の対象から外し，
    // それでも書き換えられたら戻す
    b.removeAttribute("data-l10n-id");
    b.dataset.tnTitle = title;
    const apply = () => {
      if (b.title !== b.dataset.tnTitle) b.title = b.dataset.tnTitle;
    };
    apply();
    if (!b.__tnTitleObserver) {
      b.__tnTitleObserver = new MutationObserver(apply);
      b.__tnTitleObserver.observe(b, { attributes: true, attributeFilter: ["title"] });
    }
  },
};
