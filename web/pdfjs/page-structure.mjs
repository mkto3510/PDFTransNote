// PDF TransNote：ページの構造（本文・補助・除外）の見分けと，選んだ範囲の絞り込み
// （pdf.js にも画面にも触れない．node --test で確かめられる）
// ===========================================================================
// 選んだ範囲がページの境目や図をまたぐと，柱（毎ページの上下に出る見出し），ページ番号，
// 図表の見出し（キャプション），脚注，図の中の文字まで拾ってしまう．このモジュールは，ページの文字
// （pdf.js の getTextContent の items）を次の三つの流れに分け，選んだ範囲からほかの流れを取り除く．
//   body      … 本文
//   auxiliary … キャプション，本文より小さい文字（脚注・表・図の中の文字など），回転した文字
//   excluded  … ページの飾り（柱，ページ番号，タグ付き PDF の Artifact）
// 考え方は Zotero の reader の読み取りモード（柱の検出と，選んだ範囲の流れの扱い）に倣う．
// ただし Zotero のコードは見ていない（ライセンスが異なる）．ここに書いた仕様だけから作っている．
//
// 入力（ページごと．まだ読んでいないページは null）：
//   { view: page.view, rotate: page.rotate, items, styles }
//   items と styles は getTextContent({ includeMarkedContent: true, disableNormalization: true }) の結果．
// 出力はすべて「span の番号」で引く．pdf.js の文字の層（text layer）は，str が空でない文字の item ごとに
// <span> を一つ作る（marked content の目印と，str が空の item は作らない）．その順番が span の番号である．
// 位置は「表示の座標」で表す：ページの回転を当て，ページの幅・高さを 1 とし，y は下向き．

/** 設定の既定値（%で表す値は，割合ではなく % のまま）． */
export const DEFAULT_OPTIONS = {
  skipFurniture: true,
  furnitureBand: 12,
  skipCaptions: true,
  skipSmallText: true,
  sizeTolerance: 6,
};

const DEG = 180 / Math.PI;
const LOG_STEP = Math.log(1.02); // 本文の大きさは 2% 刻みで数える
const round2 = (v) => Math.round(v * 100) / 100;
const isBlank = (s) => !/\S/.test(s);
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const countChars = (s) => s.replace(/\s+/g, "").length;
/** 大きさ a と b の差が，大きい方の tol 倍以内か． */
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(a, b);

// ---------------------------------------------------------------------------
// 文字列の型（キャプション，ページ番号，式番号）

const CAPTION_LABEL = String.raw`(?:(?:(?:Supplementary|SUPPLEMENTARY|Extended\s+Data|EXTENDED\s+DATA)\s+)?(?:Fig(?:ure)?\.?|FIG(?:URE)?\.?|Table|TABLE|Scheme|SCHEME|Chart|CHART|Plate|PLATE|Algorithm|ALGORITHM|Listing|LISTING)|図|表)`;
const CAPTION_NUMBER = String.raw`S?(?:[0-9０-９]+(?:[.．][0-9０-９]+)*[a-zA-Z]?|[IVXLC]+)`;
const CAPTION_RE = new RegExp(String.raw`^${CAPTION_LABEL}\s*(${CAPTION_NUMBER})(.*)$`, "su");
const CAPTION_DELIM_RE = /^\s*[.:|．：—–-]/;

/**
 * 行の頭がキャプションの形（Fig. 3: …，Table 2，図 1．… など）か．
 * 番号の後に区切り（. : | ． ： — – -）があるか，行が「TABLE I」のように見出しと番号だけなら "strict"．
 * 区切りがなければ（Springer の「Fig. 1 Title」や，本文の「Figure 3 shows …」）"loose"．形でなければ null．
 * @param {string} text
 * @returns {"strict" | "loose" | null}
 */
export function matchCaption(text) {
  const m = CAPTION_RE.exec(collapse(text));
  if (!m) return null;
  const rest = m[2];
  if (/^[A-Za-z0-9]/.test(rest)) return null; // 「Table Iteration」「Fig. 3and」は見出しではない
  if (!rest.trim() || CAPTION_DELIM_RE.test(rest)) return "strict";
  return "loose";
}

const ROMAN = String.raw`(?=[ivxlcdm])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})`;
const PAGE_NUMBER_RE = new RegExp(
  String.raw`^[-–—]?\s*(?:(?:page|p\.|pg\.?)\s*)?(?:\d{1,5}|${ROMAN})(?:\s*(?:of|/)\s*\d{1,5})?\s*(?:ページ|頁)?\s*[-–—]?$`,
  "i",
);

/**
 * ページ番号の形か（"12"，"- 12 -"，"– 12 –"，"xii"，"Page 12"，"p. 12"，"12 of 30"，"12 / 30"，"12 ページ"）．
 * @param {string} text
 */
export function isPageNumberText(text) {
  return PAGE_NUMBER_RE.test(collapse(text));
}

const EQ_NUMBER_RE = /\(\s*[A-Za-z]?\d{1,3}(?:\.\d{1,3})*[a-z]?\s*\)\s*$/;

/** 行の終わりが式番号（"(12)"，"(3.4)"，"(2a)"）か． */
export function endsWithEquationNumber(text) {
  return EQ_NUMBER_RE.test(String(text ?? ""));
}

const HYPHEN_END_RE = /[-‐­]\s*$/;
const SENTENCE_END_RE = /[.!?:;。．！？：；)\]）」』"”']\s*$/;

// ---------------------------------------------------------------------------
// ページの下ごしらえ（文字の位置と行）．設定に関係しないので，ページの入力ごとに覚えておく．

const prepCache = new WeakMap();

function preparePage(page) {
  const c = prepCache.get(page);
  const v = page.view;
  if (
    c &&
    c.items === page.items &&
    c.styles === page.styles &&
    c.rotate === page.rotate &&
    c.view === v &&
    (!v || c.v0 === v[0] + "," + v[1] + "," + v[2] + "," + v[3])
  ) {
    return c.prep;
  }
  const prep = buildPrep(page);
  prepCache.set(page, {
    prep,
    items: page.items,
    styles: page.styles,
    rotate: page.rotate,
    view: v,
    v0: v ? v[0] + "," + v[1] + "," + v[2] + "," + v[3] : "",
  });
  return prep;
}

function buildPrep(page) {
  const view = Array.isArray(page.view) && page.view.length >= 4 ? page.view : [0, 0, 612, 792];
  const vx = Math.min(view[0], view[2]);
  const vy = Math.min(view[1], view[3]);
  const W = Math.abs(view[2] - view[0]) || 1;
  const H = Math.abs(view[3] - view[1]) || 1;
  const rot = (((Math.round((Number(page.rotate) || 0) / 90) * 90) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const dispW = swap ? H : W;
  const dispH = swap ? W : H;
  // PDF の座標（y は上向き）→ 表示の座標（回転を当てる．左上が原点，y は下向き，単位は PDF のまま）
  const dx = (x, y) => (rot === 0 ? x - vx : rot === 90 ? y - vy : rot === 180 ? W - (x - vx) : H - (y - vy));
  const dy = (x, y) => (rot === 0 ? H - (y - vy) : rot === 90 ? x - vx : rot === 180 ? y - vy : W - (x - vx));
  const styles = page.styles || {};

  /** span の番号の順に並ぶ文字の item（空白だけのものも含む） */
  const items = [];
  const stack = []; // marked content の入れ子（Artifact なら true）
  let artifactDepth = 0;
  for (const it of page.items || []) {
    if (!it) continue;
    if (it.str === undefined) {
      if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
        const art = it.tag === "Artifact";
        stack.push(art);
        if (art) artifactDepth++;
      } else if (it.type === "endMarkedContent") {
        if (stack.pop()) artifactDepth--;
      }
      continue;
    }
    if (it.str === "") continue; // pdf.js は span を作らない
    const str = typeof it.str === "string" ? it.str : String(it.str ?? "");
    const t = Array.isArray(it.transform) && it.transform.length >= 6 ? it.transform : [1, 0, 0, 1, 0, 0];
    const [a, b, c, d, e, f] = t;
    const fh = round2(Math.hypot(c, d)); // span の --font-height と同じ値
    const st = styles[it.fontName] || {};
    const vertical = !!st.vertical;
    const asc = Number.isFinite(st.ascent) && st.ascent > 0 && st.ascent <= 1.5 ? st.ascent : 0.8;
    const desc = Number.isFinite(st.descent) && st.descent < 0 && st.descent >= -1 ? st.descent : -0.2;
    // 文字の進む向き u と，字の上の向き n（PDF の座標）．縦書きは u を時計回りに 90° 回す（pdf.js の文字の層と同じ）．
    let ux = a;
    let uy = b;
    const ul = Math.hypot(ux, uy);
    if (ul > 0) {
      ux /= ul;
      uy /= ul;
    } else {
      ux = 1;
      uy = 0;
    }
    if (vertical) [ux, uy] = [uy, -ux];
    const nx = -uy;
    const ny = ux;
    const len = Math.abs(Number(vertical ? it.height : it.width)) || 0;
    const lo = desc * fh;
    const hi = asc * fh;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const s of [lo, hi]) {
      for (const l of [0, len]) {
        const x = e + nx * s + ux * l;
        const y = f + ny * s + uy * l;
        const X = dx(x, y);
        const Y = dy(x, y);
        if (X < left) left = X;
        if (X > right) right = X;
        if (Y < top) top = Y;
        if (Y > bottom) bottom = Y;
      }
    }
    // 表示での傾き（反時計回り）．ページの回転は時計回りなので引く．
    let angle = Math.atan2(b, a) * DEG - (vertical ? 90 : 0) - rot;
    angle = ((((angle + 180) % 360) + 360) % 360) - 180;
    const blank = isBlank(str);
    items.push({
      str,
      fh,
      blank,
      chars: blank ? 0 : countChars(str),
      artifact: artifactDepth > 0,
      rotated: Math.abs(angle) > 1,
      left,
      right,
      top,
      bottom,
      base: dy(e, f), // 表示での基準線（回転していない文字のとき）
    });
  }

  // --- 行：描く順に続く item をまとめる ---
  const lines = [];
  let cur = null;
  let pending = []; // 空白だけの item．次の文字が来るまで，どの行に入れるか決めない
  const overlapsBox = (box, it) => {
    const ov = Math.min(box.bottom, it.bottom) - Math.max(box.top, it.top);
    const h = Math.min(box.bottom - box.top, it.bottom - it.top);
    return h > 0 ? ov >= 0.5 * h : ov >= 0;
  };
  const sameLine = (line, it) => {
    if (line.rotated || it.rotated) return false; // 回転した文字は一つずつ行にする
    if (!overlapsBox(line, it)) return false;
    // 左へ大きく戻り，しかも基準線が動いたら次の行（高い数式が隣の行に重なるとき）
    const last = items[line.nb[line.nb.length - 1]];
    const fhMax = Math.max(last.fh, it.fh);
    const fhMin = Math.min(last.fh, it.fh);
    if (it.left < last.left - fhMax && Math.abs(it.base - last.base) > 0.2 * fhMin) return false;
    return true;
  };
  const grow = (line, it) => {
    if (it.left < line.left) line.left = it.left;
    if (it.right > line.right) line.right = it.right;
    if (it.top < line.top) line.top = it.top;
    if (it.bottom > line.bottom) line.bottom = it.bottom;
  };
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.blank) {
      pending.push(k);
      continue;
    }
    if (cur && sameLine(cur, it)) {
      cur.items.push(...pending, k);
      cur.nb.push(k);
      grow(cur, it);
    } else {
      const head = [];
      for (const w of pending) {
        if (cur && overlapsBox(cur, items[w])) cur.items.push(w);
        else if (overlapsBox(it, items[w])) head.push(w);
      }
      cur = {
        items: [...head, k],
        nb: [k],
        left: it.left,
        right: it.right,
        top: it.top,
        bottom: it.bottom,
        rotated: it.rotated,
      };
      lines.push(cur);
    }
    pending = [];
  }
  if (cur) for (const w of pending) if (overlapsBox(cur, items[w])) cur.items.push(w);

  // 行の性質：大きさ（文字数で重みを付けた最頻値），基準線，文字，キャプションの形
  const lineOf = new Array(items.length).fill(-1);
  let rotChars = 0;
  let totChars = 0;
  const sizesUpright = new Map(); // 回転していない文字の大きさ → 文字数
  const sizesAll = new Map();
  const outLines = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const k of line.items) lineOf[k] = li;
    const map = new Map();
    let chars = 0;
    let artifact = true;
    for (const k of line.nb) {
      const it = items[k];
      map.set(it.fh, (map.get(it.fh) || 0) + it.chars);
      chars += it.chars;
      if (!it.artifact) artifact = false;
      totChars += it.chars;
      if (it.rotated) rotChars += it.chars;
      if (it.fh > 0) {
        sizesAll.set(it.fh, (sizesAll.get(it.fh) || 0) + it.chars);
        if (!it.rotated) sizesUpright.set(it.fh, (sizesUpright.get(it.fh) || 0) + it.chars);
      }
    }
    const size = modeOf(map) || items[line.nb[0]].fh;
    // 基準線：大きさが行の大きさに近い item のうち，いちばん文字の多いもの
    let best = null;
    for (const k of line.nb) {
      const it = items[k];
      if (Math.abs(it.fh - size) <= 0.01 * size && (!best || it.chars > best.chars)) best = it;
    }
    line.base = (best || items[line.nb[0]]).base;
    line.size = size;
    line.map = map;
    line.chars = chars;
    line.artifact = artifact;
    line.text = lineText(items, line.items);
    line.cap = matchCaption(line.text);
    outLines.push({
      top: line.top / dispH,
      bottom: line.bottom / dispH,
      left: line.left / dispW,
      right: line.right / dispW,
      items: line.items,
    });
  }
  return { items, lines, lineOf, outLines, dispW, dispH, rotChars, totChars, sizesUpright, sizesAll };
}

/** 行の文字．間が空いた item の間には空白を入れる． */
function lineText(items, idx) {
  let text = "";
  let prev = null;
  for (const k of idx) {
    const it = items[k];
    if (prev && !it.blank && !prev.blank && text && !/\s$/.test(text)) {
      if (it.left - prev.right > 0.2 * Math.min(it.fh, prev.fh)) text += " ";
    }
    text += it.str;
    prev = it;
  }
  return collapse(text);
}

/** 大きさ → 文字数 の表で，文字数のいちばん多い大きさ． */
function modeOf(map) {
  let best = 0;
  let bestW = -1;
  for (const [s, w] of map) {
    if (w > bestW || (w === bestW && s > best)) {
      best = s;
      bestW = w;
    }
  }
  return best;
}

/** 表 map の文字のうち，大きさが s に近いものの割合． */
function shareNear(map, s, tol) {
  let tot = 0;
  let hit = 0;
  for (const [k, w] of map) {
    tot += w;
    if (near(k, s, tol)) hit += w;
  }
  return tot > 0 ? hit / tot : 0;
}

/**
 * 本文の大きさ：文書全体（読んだページ）の文字数で重みを付けた最頻値．2% 刻みでまとめ，隣の刻みも足して選ぶ．
 * 回転した文字は数えない（ただし，回転した文字が半分を超える文書（縦書き）では全部を数える）．
 */
function computeBodySize(preps) {
  const up = new Map();
  const all = new Map();
  let upTot = 0;
  let allTot = 0;
  for (const p of preps) {
    if (!p) continue;
    for (const [s, w] of p.sizesUpright) {
      up.set(s, (up.get(s) || 0) + w);
      upTot += w;
    }
    for (const [s, w] of p.sizesAll) {
      all.set(s, (all.get(s) || 0) + w);
      allTot += w;
    }
  }
  const sizes = upTot >= 0.5 * allTot ? up : all;
  if (!sizes.size) return 0;
  const bins = new Map();
  const binOf = (s) => Math.round(Math.log(s) / LOG_STEP);
  for (const [s, w] of sizes) {
    const k = binOf(s);
    bins.set(k, (bins.get(k) || 0) + w);
  }
  let bestBin = 0;
  let bestScore = -1;
  for (const k of bins.keys()) {
    const score = (bins.get(k - 1) || 0) + bins.get(k) + (bins.get(k + 1) || 0);
    if (score > bestScore || (score === bestScore && k > bestBin)) {
      bestScore = score;
      bestBin = k;
    }
  }
  let body = 0;
  let bodyW = -1;
  for (const [s, w] of sizes) {
    if (Math.abs(binOf(s) - bestBin) <= 1 && w > bodyW) {
      body = s;
      bodyW = w;
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// 段落（ブロック）：続く行をまとめる

function pagePitch(prep, body, tol) {
  const L = prep.lines;
  const samples = [];
  for (let i = 1; i < L.length; i++) {
    const p = L[i - 1];
    const l = L[i];
    if (p.rotated || l.rotated || !near(p.size, body, tol) || !near(l.size, body, tol)) continue;
    const g = l.base - p.base;
    if (g > 0.5 * body && g < 3 * body && l.left <= p.right && l.right >= p.left) samples.push(g);
  }
  if (samples.length < 3) return 1.2 * body;
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

function buildBlocks(prep, body, tol, band, pitch) {
  const { lines, dispH } = prep;
  const bandOf = (box) => (box.bottom <= band * dispH ? "top" : box.top >= (1 - band) * dispH ? "bottom" : "");
  const scaleOf = (P, L) => Math.max(1, Math.max(P.size, L.size) / body);
  // 位置だけで分けるか（回転，Artifact の境，上へ戻る（段の変わり目），大きな間，横に重ならない，上下の帯の境）
  const geoSplit = (ext, P, L) => {
    if (P.rotated || L.rotated) return true;
    if (P.artifact !== L.artifact) return true;
    const g = L.base - P.base;
    if (g < -0.5 * Math.min(P.size || 1, L.size || 1)) return true;
    const scale = scaleOf(P, L);
    if (g > 1.5 * pitch * scale) return true;
    if (L.left > ext.right || L.right < ext.left) return true;
    if (bandOf(P) !== bandOf(L) && g > 1.1 * pitch * scale) return true;
    return false;
  };
  // 大きさが同じと見なせるか．上付き文字の多い行のように，大きさの混ざった行は，近い大きさが 3 割あれば同じとする．
  const sameSize = (B, L) =>
    near(B.size, L.size, tol) ||
    shareNear(L.map, B.size, tol) >= 0.3 ||
    (B.lines.length === 1 && shareNear(B.map, L.size, tol) >= 0.3);
  // キャプションの形の行が，段落の続き（前の行が文の途中で，間も大きさも同じ）か
  const continues = (P, L) => {
    if (HYPHEN_END_RE.test(P.text)) return true;
    const g = L.base - P.base;
    return g <= 1.2 * pitch * scaleOf(P, L) && near(P.size, L.size, tol) && !SENTENCE_END_RE.test(P.text);
  };

  const blocks = [];
  let B = null;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let split = !B;
    if (B) {
      const P = lines[B.lines[B.lines.length - 1]];
      if (geoSplit(B, P, L)) split = true;
      else if (!sameSize(B, L)) {
        // 大きさの変わり目で分けるのは，新しい大きさが 2 行以上続くか，間が広いときだけ
        const N = lines[i + 1];
        if (L.base - P.base > 1.2 * pitch * scaleOf(P, L)) split = true;
        else if (N && !geoSplit(L, L, N) && near(N.size, L.size, tol)) split = true;
      }
      if (!split && L.cap === "strict" && !continues(P, L)) split = true;
    }
    if (split) {
      B = { lines: [i], left: L.left, right: L.right, top: L.top, bottom: L.bottom, map: new Map(L.map), size: L.size };
      blocks.push(B);
    } else {
      B.lines.push(i);
      if (L.left < B.left) B.left = L.left;
      if (L.right > B.right) B.right = L.right;
      if (L.top < B.top) B.top = L.top;
      if (L.bottom > B.bottom) B.bottom = L.bottom;
      for (const [s, w] of L.map) B.map.set(s, (B.map.get(s) || 0) + w);
      B.size = modeOf(B.map) || B.size;
    }
  }
  for (const b of blocks) {
    const ls = b.lines.map((i) => lines[i]);
    b.text = ls.map((l) => l.text).join(" ");
    b.chars = ls.reduce((n, l) => n + l.chars, 0);
    b.rotated = ls.every((l) => l.rotated);
    b.artifact = ls.every((l) => l.artifact);
    b.band = b.lines.length <= 2 ? bandOf(b) : "";
    b.eqNumber = ls.some((l) => endsWithEquationNumber(l.text));
    b.lastText = ls[ls.length - 1].text;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 文書全体の見分け

/**
 * 文書のすべての（読んだ）ページの文字を，body・auxiliary・excluded に分ける．ページが読まれるたびに呼び直してよい．
 * @param {({view: number[], rotate: number, items: object[], styles: object} | null)[]} pages
 * @param {{furnitureBand?: number, sizeTolerance?: number}} [options] furnitureBand（%）は柱を探す上下の帯の高さ，
 *   sizeTolerance（%）は本文と同じ大きさと見なす差
 * @returns {{bodySize: number, pages: ({
 *   classes: ("body"|"auxiliary"|"excluded")[],
 *   kinds: (null|"artifact"|"furniture"|"pageNumber"|"caption"|"small"|"rotated")[],
 *   lines: {top: number, bottom: number, left: number, right: number, items: number[]}[],
 *   lineOf: number[],
 *   blocks: {lines: number[], class: string, kind: string|null, size: number}[],
 * } | null)[]}}
 *   classes・kinds・lineOf は span の番号で引く．lines の位置は表示の座標（0〜1）．lineOf は span が入る行の番号（なければ -1）．
 *   blocks は段落（lines の番号の並び）と，その分け方．
 */
export function analyzeDocument(pages, options = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const bandPct = Number.isFinite(options?.furnitureBand) ? options.furnitureBand : DEFAULT_OPTIONS.furnitureBand;
  const tolPct = Number.isFinite(options?.sizeTolerance) ? options.sizeTolerance : DEFAULT_OPTIONS.sizeTolerance;
  const band = Math.min(50, Math.max(0, bandPct)) / 100;
  const tol = Math.min(50, Math.max(0, tolPct)) / 100;
  const preps = list.map((p) => (p ? preparePage(p) : null));
  const bodySize = computeBodySize(preps);
  const body = bodySize || 10;

  // 1. ページごとに段落を作り，柱の候補の鍵を集める
  const work = preps.map((prep) => {
    if (!prep) return null;
    const pitch = pagePitch(prep, body, tol) || 1.2 * body;
    const blocks = buildBlocks(prep, body, tol, band, pitch);
    for (const b of blocks) {
      b.keys = [];
      if (!b.band || b.artifact) continue;
      const text = b.text.toLowerCase();
      if (text.length < 8 || text.length > 160) continue;
      b.bucket = Math.floor(b.top / prep.dispH / 0.05);
      b.keys.push(b.band + "|" + text);
      if (/\d/.test(text)) b.keys.push(b.band + "|#|" + text.replace(/\d+/g, "#"));
    }
    return { prep, pitch, blocks };
  });

  // 2. 柱：同じ鍵（帯の側・5% 刻みの高さ・文字）が，十分な数のページに出るか
  const N = list.length;
  const threshold = Math.max(3, Math.ceil(0.25 * N));
  const seen = new Map(); // 鍵 → 高さの刻み → ページの集合
  if (N >= 3) {
    work.forEach((w, pageIndex) => {
      if (!w) return;
      for (const b of w.blocks) {
        for (const key of b.keys) {
          let byBucket = seen.get(key);
          if (!byBucket) seen.set(key, (byBucket = new Map()));
          let set = byBucket.get(b.bucket);
          if (!set) byBucket.set(b.bucket, (set = new Set()));
          set.add(pageIndex);
        }
      }
    });
  }
  const repeated = (b) => {
    if (N < 3) return false;
    for (const key of b.keys) {
      const byBucket = seen.get(key);
      if (!byBucket) continue;
      const pagesSeen = new Set();
      for (let d = -1; d <= 1; d++) for (const p of byBucket.get(b.bucket + d) || []) pagesSeen.add(p);
      if (pagesSeen.size >= threshold) return true;
    }
    return false;
  };

  // 3. 段落ごとに分ける
  const outPages = work.map((w) => {
    if (!w) return null;
    const { prep, pitch, blocks } = w;
    const { items, lines, lineOf, dispW } = prep;
    const bodyRotated = prep.rotChars > 0.5 * prep.totChars; // 縦書きのように，本文そのものが回転している
    // 本文の行の幅の目安（いちばん広い行の代わりに，80 パーセンタイル．ページ全体に渡る 1 行に引きずられないように）
    const widths = lines
      .filter((l) => !l.rotated && !l.artifact && l.chars >= 10 && near(l.size, body, tol))
      .map((l) => l.right - l.left)
      .sort((a, b) => a - b);
    const refWidth = widths.length ? widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.8))] : 0;
    const bodyLines = lines.filter((l) => !l.rotated && !l.artifact && near(l.size, body, tol));
    const smaller = (b) => bodySize > 0 && b.size < bodySize * (1 - tol);
    const centred = (b) => {
      let cl = Infinity;
      let cr = -Infinity;
      for (const l of bodyLines) {
        if (l.right < b.left || l.left > b.right) continue;
        if (l.left < cl) cl = l.left;
        if (l.right > cr) cr = l.right;
      }
      const cw = cr - cl;
      if (!(cw > 0)) return false;
      const bw = b.right - b.left;
      return bw < 0.9 * cw && Math.abs((b.left + b.right) / 2 - (cl + cr) / 2) < 0.03 * dispW;
    };

    let prevContent = null; // 直前の（除外でない）段落
    let prev = null; // 直前の段落
    for (const b of blocks) {
      let cls = "body";
      let kind = null;
      const firstCap = lines[b.lines[0]].cap;
      if (b.artifact) {
        cls = "excluded";
        kind = "artifact";
      } else if (b.band && b.lines.length === 1 && isPageNumberText(b.text)) {
        cls = "excluded";
        kind = "pageNumber";
      } else if (b.band && repeated(b)) {
        cls = "excluded";
        kind = "furniture";
      } else if (
        firstCap &&
        !(prevContent && HYPHEN_END_RE.test(prevContent.lastText)) &&
        (firstCap === "strict" ||
          smaller(b) ||
          (refWidth > 0 && b.right - b.left < 0.7 * refWidth) ||
          centred(b))
      ) {
        cls = "auxiliary";
        kind = "caption";
      } else if (b.rotated && !bodyRotated) {
        cls = "auxiliary";
        kind = "rotated";
      } else if (smaller(b) && !b.eqNumber && !mathFragment(b, prev, pitch)) {
        cls = "auxiliary";
        kind = "small";
      }
      b.cls = cls;
      b.kind = kind;
      if (cls !== "excluded") prevContent = b;
      prev = b;
    }

    // span ごとの分け方
    const n = items.length;
    const classes = new Array(n).fill("body");
    const kinds = new Array(n).fill(null);
    const blockOfLine = new Array(lines.length);
    blocks.forEach((b) => {
      for (const li of b.lines) blockOfLine[li] = b;
    });
    for (let li = 0; li < lines.length; li++) {
      const b = blockOfLine[li];
      for (const k of lines[li].items) {
        classes[k] = b.cls;
        kinds[k] = b.kind;
      }
    }
    for (let k = 0; k < n; k++) {
      const it = items[k];
      if (it.artifact) {
        classes[k] = "excluded";
        kinds[k] = "artifact";
      } else if (it.blank && lineOf[k] >= 0) {
        // 空白は同じ行の隣に合わせる（両隣が Artifact なら Artifact）
        const ls = lines[lineOf[k]].items;
        const pos = ls.indexOf(k);
        let before = null;
        let after = null;
        for (let j = pos - 1; j >= 0; j--) if (!items[ls[j]].blank) { before = items[ls[j]]; break; }
        for (let j = pos + 1; j < ls.length; j++) if (!items[ls[j]].blank) { after = items[ls[j]]; break; }
        if ((before || after) && (!before || before.artifact) && (!after || after.artifact)) {
          classes[k] = "excluded";
          kinds[k] = "artifact";
        }
      }
    }
    return {
      classes,
      kinds,
      lines: prep.outLines,
      lineOf,
      blocks: blocks.map((b) => ({ lines: b.lines, class: b.cls, kind: b.kind, size: b.size })),
    };
  });
  return { bodySize, pages: outPages };
}

/**
 * 小さい文字の段落が，数式の切れ端（∑ の上下の添え字など）か：短く，直前の本文の段落のすぐそばにある．
 */
function mathFragment(b, prev, pitch) {
  if (!prev || prev.cls !== "body" || b.lines.length > 2 || b.chars > 16) return false;
  const mid = (b.top + b.bottom) / 2;
  if (mid < prev.top - 0.8 * pitch || mid > prev.bottom + 0.8 * pitch) return false;
  return b.right >= prev.left && b.left <= prev.right;
}

// ---------------------------------------------------------------------------
// 選んだ範囲の絞り込み

const KIND_GROUP = {
  artifact: "furniture",
  furniture: "furniture",
  pageNumber: "furniture",
  caption: "caption",
  small: "small",
  rotated: "small",
};

/**
 * 選んだ範囲（span の切れ端の並び）から，本文でないものを除く．
 * 1. 範囲の初めと終わりにある除外（柱・ページ番号など）は，本文の切れ端が一つでも残るなら落とす．
 * 2. そのうえで，残りの初めと終わり（空白でないもの）がどちらも本文なら，間の本文でないものをすべて落とす．
 *    そうでなければ（キャプションだけを選んだ，キャプションの中で終わったなど），1 で落とした両端のほかは残す．
 * 設定で外した種類は本文として扱う．分け方の分からないもの（ページを読んでいない，spanIndex が -1）も本文とする．
 * @param {{pageIndex: number, spanIndex: number, text: string}[]} pieces 選んだ順
 * @param {ReturnType<typeof analyzeDocument> | null} analysis
 * @param {{skipFurniture?: boolean, skipCaptions?: boolean, skipSmallText?: boolean}} [options]
 * @returns {{keep: boolean[], removed: {kind: "furniture"|"caption"|"small", pageIndex: number, text: string}[]}}
 */
export function filterSelection(pieces, analysis, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const list = Array.isArray(pieces) ? pieces : [];
  const n = list.length;
  const enabled = {
    furniture: !!opt.skipFurniture,
    caption: !!opt.skipCaptions,
    small: !!opt.skipSmallText,
  };
  const cat = new Array(n); // "body" | "furniture" | "caption" | "small"
  const blank = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = list[i] || {};
    blank[i] = isBlank(String(p.text ?? ""));
    const pa = analysis?.pages?.[p.pageIndex];
    let group = null;
    if (pa && Number.isInteger(p.spanIndex) && p.spanIndex >= 0) {
      const kind = pa.kinds?.[p.spanIndex];
      if (kind) group = KIND_GROUP[kind] ?? null;
      else if (pa.classes?.[p.spanIndex] === "excluded") group = "furniture";
      else if (pa.classes?.[p.spanIndex] === "auxiliary") group = "small";
    }
    cat[i] = group && enabled[group] ? group : "body";
  }

  const keep = new Array(n).fill(true);
  // 1. 両端の除外を落とす
  let s = -1;
  let e = -1;
  for (let i = 0; i < n; i++) if (!blank[i] && cat[i] !== "furniture") { s = i; break; }
  for (let i = n - 1; i >= 0; i--) if (!blank[i] && cat[i] !== "furniture") { e = i; break; }
  let hasBody = false;
  if (s >= 0) for (let i = s; i <= e; i++) if (!blank[i] && cat[i] === "body") { hasBody = true; break; }
  if (hasBody) {
    let side = false;
    for (let i = 0; i < s; i++) if (cat[i] === "furniture") side = true;
    if (side) for (let i = 0; i < s; i++) keep[i] = false;
    side = false;
    for (let i = e + 1; i < n; i++) if (cat[i] === "furniture") side = true;
    if (side) for (let i = e + 1; i < n; i++) keep[i] = false;
    // 2. 初めと終わりが本文なら，間の本文でないものを落とす
    if (cat[s] === "body" && cat[e] === "body") {
      for (let i = s + 1; i < e; i++) if (cat[i] !== "body") keep[i] = false;
    }
  }

  // 落としたものを，種類とページの続く範囲ごとにまとめる
  const removed = [];
  let run = null;
  for (let i = 0; i < n; i++) {
    const p = list[i] || {};
    if (keep[i]) {
      if (!blank[i]) run = null; // 残した空白は，まとまりを切らない
      continue;
    }
    const kind = cat[i] === "body" ? null : cat[i];
    if (run && (kind === null || (run.kind === kind && run.pageIndex === p.pageIndex))) {
      run.parts.push(p);
      continue;
    }
    if (kind === null || blank[i]) continue; // 空白だけ（または本文の空白）からは始めない
    run = { kind, pageIndex: p.pageIndex, parts: [p] };
    removed.push(run);
  }
  return {
    keep,
    removed: removed.map((r) => ({ kind: r.kind, pageIndex: r.pageIndex, text: joinParts(r.parts, analysis) })),
  };
}

/** 切れ端をつなぐ．同じ行の span の間はそのまま，行が変わるところには空白を入れる． */
function joinParts(parts, analysis) {
  let text = "";
  let prev = null;
  for (const p of parts) {
    const t = String(p.text ?? "");
    if (prev) {
      const lineOf = analysis?.pages?.[p.pageIndex]?.lineOf;
      const sameLine =
        prev.pageIndex === p.pageIndex &&
        lineOf &&
        prev.spanIndex >= 0 &&
        p.spanIndex >= 0 &&
        lineOf[prev.spanIndex] >= 0 &&
        lineOf[prev.spanIndex] === lineOf[p.spanIndex];
      if (!sameLine) text += " ";
    }
    text += t;
    prev = p;
  }
  return collapse(text);
}
