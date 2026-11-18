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
  skipMarginNotes: true,
  skipRuby: true,
  skipLineNumbers: true,
  skipCode: true,
  skipEquations: true,
};

const DEG = 180 / Math.PI;
/**
 * 同じ高さの文字でも，右へこの倍数（文字の大きさに対して）より離れていれば別の行の切れ端にする（隣の段）．
 * 左へ戻るときは SEGMENT_GAP_LEFT（行の左の余白の注）．OCR の文字は語の間が広いことがあるので，右は大きめにする．
 */
const SEGMENT_GAP = 3;
const SEGMENT_GAP_LEFT = 1.5;
/** 行の中の欄の切れ目（表の欄）とみなす間（文字の大きさに対する倍数）． */
const CELL_GAP = 1.5;
/** ルビとみなす大きさ（付く行の文字に対する割合）の上限． */
const RUBY_RATIO = 0.62;
/**
 * まとめられた下付き文字：pdf.js が下付きの文字（「T0」の「0」）とその後の本文を一つの item にし，item 全体に下付きの
 * 大きさと基準線を付けることがある．一文字あたりの送り幅（大きさに対する割合）が前の文字よりこの倍数以上広く，
 * 送り幅から推した大きさが前の文字の大きさに近ければ（MERGED_SIZE_TOL 以内），前の文字と同じ大きさ・基準線にする．
 * 送り幅を比べるので，空白を除いて MERGED_MIN_CHARS 文字以上の item だけを見る．
 */
const MERGED_ADVANCE_RATIO = 1.15;
const MERGED_SIZE_TOL = 0.15;
const MERGED_MIN_CHARS = 4;
const LOG_STEP = Math.log(1.02); // 本文の大きさは 2% 刻みで数える
const round2 = (v) => Math.round(v * 100) / 100;
const isBlank = (s) => !/\S/.test(s);
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const countChars = (s) => s.replace(/\s+/g, "").length;
/** 大きさ a と b の差が，大きい方の tol 倍以内か． */
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(a, b);

// ---------------------------------------------------------------------------
// 文字列の型（キャプション，ページ番号，式番号）

const CAPTION_LABEL = String.raw`(?:(?:(?:Supplementary|SUPPLEMENTARY|Extended\s+Data|EXTENDED\s+DATA)\s+)?(?:Fig(?:ure)?\.?|FIG(?:URE)?\.?|Table|TABLE|Scheme|SCHEME|Chart|CHART|Plate|PLATE|Algorithm|ALGORITHM|Listing|LISTING|Procedure|PROCEDURE)|図|表|アルゴリズム)`;
const CAPTION_NUMBER = String.raw`S?(?:[0-9０-９]+(?:[.．][0-9０-９]+)*[a-zA-Z]?|[IVXLC]+)`;
const CAPTION_RE = new RegExp(String.raw`^${CAPTION_LABEL}\s*(${CAPTION_NUMBER})(.*)$`, "su");
// 日本の雑誌に多い「第 1 図」「第 2 表」（番号が前に来る）
const JP_DAI_RE = /^第\s*([0-9０-９]+(?:[.．\-－‐][0-9０-９]+)*)\s*[図表](.*)$/su;
const CAPTION_DELIM_RE = /^\s*[.:|．：—–-]/;
// 見出しの番号だけの文字（「図 3」「Fig. 2.」「第 1 表」「Table 4:」）
const CAPTION_LABEL_ONLY_RE = new RegExp(String.raw`^(?:${CAPTION_LABEL}\s*${CAPTION_NUMBER}|第\s*[0-9０-９]+\s*[図表])\s*[.:．：]?$`, "u");
// 日本語の見出しの番号の後に続く助詞（本文の「図 1 に示す」「第 2 表の値」）．1 文字の助詞は，後にひらがなが続かないときだけ
// （「図 3 つくばの…」のように，ひらがなで始まる題を本文と取り違えないため）
const JP_PARTICLE_RE =
  /^\s*(?:から|まで|より|では|には|とは|および|ならびに|について|による|のよう|のとおり|と同様|[にのはをでとがへやも](?!\p{Script=Hiragana}))/u;

/**
 * 行の頭がキャプションの形（Fig. 3: …，Table 2，図 1．…，第 1 図 … など）か．
 * 番号の後に区切り（. : | ． ： — – -）があるか，行が「TABLE I」のように見出しと番号だけなら "strict"．
 * 区切りがなければ（Springer の「Fig. 1 Title」や，本文の「Figure 3 shows …」）"loose"．形でなければ null．
 * 日本語の見出し（図，表，第 N 図）の番号の後が助詞なら，本文（「図 1 に示す」「第 2 表の値」）なので null．
 * @param {string} text
 * @returns {"strict" | "loose" | null}
 */
export function matchCaption(text) {
  const t = collapse(text);
  const dai = JP_DAI_RE.exec(t);
  const m = dai ? null : CAPTION_RE.exec(t);
  if (!dai && !m) return null;
  const rest = dai ? dai[2] : m[2];
  const japanese = !!dai || /^[図表]/.test(t);
  if (japanese && JP_PARTICLE_RE.test(rest)) return null;
  if (!japanese && /^[A-Za-z0-9]/.test(rest)) return null; // 「Table Iteration」「Fig. 3and」は見出しではない
  if (!rest.trim() || CAPTION_DELIM_RE.test(rest)) return "strict";
  return "loose";
}

const ROMAN = String.raw`(?=[ivxlcdm])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})`;
const PAGE_NUMBER_RE = new RegExp(
  String.raw`^[-–—―‐]?\s*(?:(?:page|p\.|pg\.?)\s*)?(?:\d{1,5}|${ROMAN})(?:\s*(?:of|/)\s*\d{1,5})?\s*(?:ページ|頁)?\s*[-–—―‐]?$`,
  "i",
);

/**
 * ページ番号の形か（"12"，"- 12 -"，"– 12 –"，"― 12 ―"，"xii"，"Page 12"，"p. 12"，"12 of 30"，"12 / 30"，"12 ページ"）．
 * @param {string} text
 */
export function isPageNumberText(text) {
  return PAGE_NUMBER_RE.test(collapse(text));
}

// 式番号は，行の頭か，空白・句読点・日本語の文字の後に置かれる．識別子に付いた括弧（図のラベルの「∆w(1)」，「f(2)」）は
// 式番号ではない
const EQ_NUMBER_RE = /(?:^|[\s,.;:]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。，．])\(\s*[A-Za-z]?\d{1,3}(?:\.\d{1,3})*[a-z]?\s*\)\s*$/u;
const EQ_NUMBER_ONLY_RE = /^\s*\(\s*[A-Za-z]?\d{1,3}(?:\.\d{1,3})*[a-z]?\s*\)\s*$/;

/** 行の終わりが式番号（"(12)"，"(3.4)"，"(2a)"）か．「w(1)」のように識別子に付いた括弧は式番号としない． */
export function endsWithEquationNumber(text) {
  return EQ_NUMBER_RE.test(String(text ?? ""));
}

const HYPHEN_END_RE = /[-‐­]\s*$/;
const SENTENCE_END_RE = /[.!?:;。．！？：；)\]）」』"”']\s*$/;

// ---------------------------------------------------------------------------
// ページの下ごしらえ（文字の位置と行）．設定に関係しないので，ページの入力ごとに覚えておく．

const prepCache = new WeakMap();

/**
 * @param {object} page
 * @param {{side: string, edge: number}[] | null} [knownColumns] ほかのページで見つかった行番号の列（候補の少ないページで使う）
 */
export function preparePage(page, knownColumns = null) {
  let cache = prepCache.get(page);
  const viewKey = page.view?.join(",");
  if (!cache || (page.normalized && cache.normalized !== page.normalized) ||
      cache.items !== page.items || cache.styles !== page.styles ||
      cache.rotate !== page.rotate || cache.viewKey !== viewKey) {
    const normalized = page.normalized ?? normalizePageText(page);
    cache = {
      items: page.items, styles: page.styles, rotate: page.rotate, viewKey, normalized,
      base: buildPrep(normalized),
    };
    prepCache.set(page, cache);
  }
  if (!knownColumns?.length || !cache.normalized.hasNumbers) return cache.base;
  const key = JSON.stringify(knownColumns);
  if (cache.knownKey !== key) {
    const detected = findLineNumbers(cache.normalized.items, cache.normalized.dispW, knownColumns);
    const same = detected.indices.size === cache.base.numberIndices.size &&
      [...detected.indices].every((i) => cache.base.numberIndices.has(i));
    cache.known = same ? cache.base : buildPrep(cache.normalized, detected);
    cache.knownKey = key;
  }
  return cache.known;
}

/** Worker では PDF.js の文字項目を持ち続けず，解析に使う座標と属性だけを保持する． */
export function normalizePageText(page) {
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
      vertical,
      // 等幅のフォント．日本語のフォントは多くが等幅なので，日本語の文字を含む item は数えない
      mono: st.fontFamily === "monospace" && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u.test(str),
      font: it.fontName,
      len,
      left,
      right,
      top,
      bottom,
      base: dy(e, f), // 表示での基準線（回転していない文字のとき）
    });
  }
  fixMergedSubscripts(items);
  return { items, dispW, dispH, hasNumbers: items.some((it) => LINE_NUMBER_RE.test(it.str)) };
}

function buildPrep({ items, dispW, dispH }, detected = findLineNumbers(items, dispW)) {
  const { columns: lineNumbers, indices: numberIndices } = detected;

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
    // 同じ高さでも，横に大きく離れていれば別の行の切れ端（余白の注，隣の段，表の別の欄）
    // （行の右に離して置いた式番号「(12)」は同じ行のまま）
    const em = Math.max(fhMax, line.fh || 0);
    if (it.right < line.left - SEGMENT_GAP_LEFT * em) return false;
    if (it.left > line.right + SEGMENT_GAP * em && !EQ_NUMBER_ONLY_RE.test(it.str) && !captionLabelOnly(line)) return false;
    return true;
  };
  // 行が図表の見出しで始まる（「図3」「Fig. 2. Map showing」）なら，離れて続く文字も同じ行にする
  // （OCR では見出しの語が離れて，順も入れ替わって置かれることがある）
  const captionLabelOnly = (line) => {
    const head = collapse(line.nb.slice(0, 4).map((k) => items[k].str).join(" "));
    return CAPTION_LABEL_ONLY_RE.test(head) || matchCaption(head) !== null;
  };
  // ルビ：行の文字よりずっと小さく，行のすぐ上に横が重なって置かれた文字．行を切らずに，その行に付ける
  const rubyOf = (line, it) => {
    if (!line || line.rotated || it.rotated || !(line.fh > 0)) return false;
    if (it.fh > RUBY_RATIO * line.fh) return false;
    if (it.bottom > line.top + 0.35 * line.fh || it.bottom < line.top - 0.7 * line.fh) return false;
    return it.right > line.left - line.fh && it.left < line.right + 2 * line.fh;
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
    if (numberIndices.has(k)) continue; // 行番号は本文の行に入れない（後で，1 個ずつの行にして末尾に足す）
    if (cur && rubyOf(cur, it)) {
      cur.items.push(...pending, k);
      cur.ruby.push(k);
    } else if (cur && sameLine(cur, it)) {
      if (it.left > cur.right + CELL_GAP * Math.max(it.fh, cur.fh || 0)) cur.cells++;
      cur.items.push(...pending, k);
      cur.nb.push(k);
      grow(cur, it);
      if (it.fh > cur.fh) cur.fh = it.fh;
    } else {
      const head = [];
      for (const w of pending) {
        if (cur && overlapsBox(cur, items[w])) cur.items.push(w);
        else if (overlapsBox(it, items[w])) head.push(w);
      }
      cur = {
        items: [...head, k],
        nb: [k],
        ruby: [],
        cells: 1,
        fh: it.fh,
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
  // 行番号：本文の行の並びを切らないように，末尾に 1 個ずつの行として足す
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (!numberIndices.has(k)) continue;
    lines.push({
      items: [k],
      nb: [k],
      ruby: [],
      cells: 1,
      fh: it.fh,
      left: it.left,
      right: it.right,
      top: it.top,
      bottom: it.bottom,
      rotated: false,
      lineNo: true,
    });
  }

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
    const fonts = new Map();
    let chars = 0;
    let monoChars = 0;
    let artifact = true;
    for (const k of line.nb) {
      const it = items[k];
      map.set(it.fh, (map.get(it.fh) || 0) + it.chars);
      fonts.set(it.font, (fonts.get(it.font) || 0) + it.chars);
      chars += it.chars;
      if (it.mono) monoChars += it.chars;
      if (!it.artifact) artifact = false;
      if (numberIndices.has(k)) continue;
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
    line.font = modeOf(fonts);
    line.chars = chars;
    line.monoChars = monoChars;
    line.artifact = artifact;
    line.text = lineText(items, line.items);
    const digits = (line.text.match(/[0-9０-９]/g) || []).length;
    line.digitShare = chars ? digits / chars : 0;
    line.cap = matchCaption(line.text);
    outLines.push({
      top: line.top / dispH,
      bottom: line.bottom / dispH,
      left: line.left / dispW,
      right: line.right / dispW,
      items: line.items,
    });
  }
  // 同じ高さに並ぶ行の切れ端の数（表の行は 3 つ以上の欄に分かれる）
  for (const l of lines) l.row = 1;
  const upright = lines.filter((line) => !line.rotated && !line.lineNo).sort((a, b) => a.base - b.base);
  for (let i = 0; i < upright.length; i++) {
    const a = upright[i];
    for (let j = i + 1; j < upright.length; j++) {
      const b = upright[j];
      const distance = b.base - a.base;
      if (distance > 0.3 * (a.size || 1)) break;
      if (distance <= 0.3 * (b.size || 1)) {
        a.row++;
        b.row++;
      }
    }
  }
  // ページの本文のフォント（長い行でいちばん多いフォント）
  const fontChars = new Map();
  for (const l of lines) if (!l.rotated && !l.lineNo && l.chars >= 30) fontChars.set(l.font, (fontChars.get(l.font) || 0) + l.chars);
  const bodyFont = fontChars.size ? modeOf(fontChars) : null;
  return { items, lines, lineOf, outLines, dispW, dispH, rotChars, totChars, sizesUpright, sizesAll, lineNumbers, numberIndices, bodyFont };
}

/**
 * まとめられた下付き文字の item（MERGED_ADVANCE_RATIO の説明を参照）の大きさと基準線を，直前の文字に合わせる．
 * 例：「ture is maintained at」「T」「0. Equation (6.409) governing」（最後の item だけ 7.57 pt で，幅は 9.96 pt の文字の幅）．
 * 位置の箱（left・right・top・bottom）は変えない．
 */
function fixMergedSubscripts(items) {
  // ページの中の，大きさごとの一文字あたりの送り幅（大きさに対する割合）の中央値．10 文字以上の横書きの item から測る
  const samples = new Map();
  for (const it of items) {
    if (it.blank || it.rotated || it.vertical || !(it.fh > 0) || !(it.len > 0) || it.str.length < 10) continue;
    if (!samples.has(it.fh)) samples.set(it.fh, []);
    samples.get(it.fh).push(it.len / it.str.length / it.fh);
  }
  const pageAdvance = new Map();
  for (const [fh, v] of samples) {
    v.sort((a, b) => a - b);
    pageAdvance.set(fh, v[v.length >> 1]);
  }
  let pk = -1; // 直前の（空白でない）item
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.blank) continue;
    const p = pk >= 0 ? items[pk] : null;
    const pIndex = pk;
    pk = k;
    if (!p || it.rotated || p.rotated || it.vertical || p.vertical) continue;
    if (it.chars < MERGED_MIN_CHARS || !(it.fh > 0) || !(it.len > 0) || !(it.fh < 0.9 * p.fh)) continue;
    const gap = it.left - p.right;
    if (gap < -0.3 * p.fh || gap > p.fh) continue;
    if (Math.abs(it.base - p.base) > 0.5 * p.fh) continue;
    // 参照の送り幅：ページの中の同じ大きさの文字の中央値．なければ，直前から左へ続く，同じ大きさ・同じ基準線の item
    // （直前の「M」1 文字のような数式の文字は幅が広く，それだけでは測れない）
    let ref = pageAdvance.get(p.fh);
    if (!ref) {
      let w = 0;
      let n = 0;
      for (let j = pIndex, seen = 0; j >= 0 && seen < 20; j--) {
        const q = items[j];
        if (q.blank) continue;
        if (q.rotated || q.vertical || q.fh !== p.fh || Math.abs(q.base - p.base) > 0.1 * p.fh) break;
        w += q.len;
        n += q.str.length;
        seen++;
      }
      if (!(w > 0) || !n) continue;
      ref = w / n / p.fh;
    }
    const r = it.len / it.str.length / it.fh / ref;
    if (r < MERGED_ADVANCE_RATIO || Math.abs(it.fh * r - p.fh) > MERGED_SIZE_TOL * p.fh) continue;
    it.fh = p.fh;
    it.base = p.base;
  }
}

/** 行番号の列とみなす，ページの中の番号の数の下限（ほかのページで見つかった列と同じ位置なら 1 個でよい）． */
const LINE_NUMBER_MIN = 4;
/** 行番号の列の位置を比べるときの許し（ページの幅に対する割合）． */
const LINE_NUMBER_EDGE_TOL = 0.004;

/**
 * 行番号（査読用原稿の余白の 1, 2, 3 …）の item に印（lineNo）を付ける．次の三つを満たす整数だけの item の列を行番号とする．
 *   1. 本文の文字の外（左の余白なら右端が，右の余白なら左端が）同じ位置にそろう．
 *   2. 上から順に，1 ずつ（または 5 ずつ）増える．
 *   3. 番号の縦の間が，番号の差に比例する（行の送りが一定）．
 * 表の欄の数（本文の枠の中にある），番号付きの箇条書き（「1.」）は取らない．
 * @returns {{side: string, edge: number}[]} 見つけた列（edge はページの幅に対する割合）
 */
const LINE_NUMBER_RE = /^\s*\d{1,4}\s*$/;

function findLineNumbers(items, dispW, knownColumns) {
  const indices = new Set();
  const columns = [];
  const cands = [];
  const lefts = [];
  const rights = [];
  const others = []; // 番号でない文字（表の見出しの欄などを見つけるため）
  const longs = []; // 長い文字の item（段の間の空きを見つけるため）
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.blank || it.rotated || it.vertical) continue;
    const numeric = LINE_NUMBER_RE.test(it.str);
    if (numeric) cands.push({ k, v: Number(it.str.trim()), it });
    else if (it.chars >= 2) others.push(it);
    if (!numeric && it.chars >= 15) {
      longs.push(it);
      lefts.push(it.left);
      rights.push(it.right);
    }
  }
  if (!cands.length || !lefts.length) return { columns, indices };
  lefts.sort((a, b) => a - b);
  rights.sort((a, b) => a - b);
  const refLeft = lefts[Math.floor(lefts.length * 0.1)];
  const refRight = rights[Math.ceil(rights.length * 0.9) - 1];
  // 二段組の段の間の空き：長い文字の item がほとんどかからない位置（表題など，段をまたぐ行は少しならよい）
  const inGutter = (c) => {
    if (c.it.left <= refLeft + 2 * c.it.fh || c.it.right >= refRight - 2 * c.it.fh) return false;
    const over = longs.filter((o) => o.left < c.it.right && o.right > c.it.left).length;
    return over <= 0.05 * longs.length;
  };
  for (const side of ["left", "right", "gutter"]) {
    // 余白の候補と，そろえる端（左の余白は右寄せ，右の余白は左寄せ，段の間は中央）
    const edgeOf = (c) => (side === "left" ? c.it.right : side === "right" ? c.it.left : (c.it.left + c.it.right) / 2);
    const pool = cands
      .filter((c) =>
        side === "left" ? c.it.right <= refLeft + 0.3 * c.it.fh : side === "right" ? c.it.left >= refRight - 0.3 * c.it.fh : inGutter(c),
      )
      .sort((a, b) => edgeOf(a) - edgeOf(b));
    // 端の位置でまとめる
    const groups = [];
    for (const c of pool) {
      const g = groups[groups.length - 1];
      if (g && edgeOf(c) - edgeOf(g[g.length - 1]) <= 0.6 * c.it.fh) g.push(c);
      else groups.push([c]);
    }
    for (const g of groups) {
      g.sort((a, b) => a.it.top - b.it.top);
      const edge = edgeOf(g[0]) / dispW;
      const known = knownColumns?.some((kc) => kc.side === side && Math.abs(kc.edge - edge) <= LINE_NUMBER_EDGE_TOL);
      if (g.length < (known ? 1 : LINE_NUMBER_MIN)) continue;
      // 上から順に増える
      let ok = true;
      let unit = 0; // 番号の差 1 あたりの縦の間
      const units = [];
      let steps1 = 0;
      let steps5 = 0;
      for (let i = 1; i < g.length; i++) {
        const dv = g[i].v - g[i - 1].v;
        const dy = g[i].it.top - g[i - 1].it.top;
        if (dv <= 0 || dy <= 0) {
          ok = false;
          break;
        }
        if (dv === 1) steps1++;
        if (dv === 5) steps5++;
        units.push(dy / dv);
      }
      if (!ok) continue;
      // 番号の列の上下（3 行分まで）に，同じ列にかかる文字があれば表の欄（「class」の見出しの下の 1, 2, 3 …）
      const cl = Math.min(...g.map((c) => c.it.left));
      const cr = Math.max(...g.map((c) => c.it.right));
      const fh = g[0].it.fh || 10;
      const ct = g[0].it.top - 3 * fh;
      const cb = g[g.length - 1].it.bottom + 3 * fh;
      if (others.some((o) => o.left < cr && o.right > cl && (o.top + o.bottom) / 2 > ct && (o.top + o.bottom) / 2 < cb)) continue;
      if (g.length >= 2) {
        const n = g.length - 1;
        const every5 = g.every((c) => c.v % 5 === 0) && steps5 >= 0.8 * n;
        if (!known && steps1 < 0.8 * n && !every5) continue;
        units.sort((a, b) => a - b);
        unit = units[units.length >> 1];
        // 行の送りが一定（番号の差に比例する）
        if (!known && units.filter((u) => Math.abs(u - unit) <= 0.25 * unit).length < 0.8 * units.length) continue;
      }
      for (const c of g) indices.add(c.k);
      columns.push({ side, edge });
    }
  }
  return { columns, indices };
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
    if (p.rotated || l.rotated || p.lineNo || l.lineNo || !near(p.size, body, tol) || !near(l.size, body, tol)) continue;
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
    if (!!P.lineNo !== !!L.lineNo) return true;
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
      // キャプションの段落の後の，字下げで始まる本文の段落（キャプションが本文と同じ大きさで，間も同じとき）．
      // 次の行が左へ戻る（1 行目だけの字下げ）ときだけ．ぶら下げ字下げのキャプションの 2 行目以降は分けない
      if (!split && lines[B.lines[0]].cap && SENTENCE_END_RE.test(P.text)) {
        const N = lines[i + 1];
        const indent = L.left - B.left;
        if (indent > 0.7 * body && indent < 4 * body && N && !N.lineNo && Math.abs(N.left - B.left) < 0.5 * body) split = true;
      }
      // キャプションの続きの行（PDFFigures 2.0）：文で終わった行の後で，行の間がキャプションの中の行の間より広いか，
      // フォントがキャプションの続きの行と変わるなら，次の段落とする
      // （字下げした行は，キャプションの中の小見出しや凡例の続きなので分けない）
      if (!split && lines[B.lines[0]].cap && SENTENCE_END_RE.test(P.text) && !L.lineNo && L.left <= B.left + 0.5 * body) {
        const g = L.base - P.base;
        if (B.lines.length >= 2) {
          const gaps = [];
          for (let j = 1; j < B.lines.length; j++) gaps.push(lines[B.lines[j]].base - lines[B.lines[j - 1]].base);
          gaps.sort((x, y) => x - y);
          const med = gaps[gaps.length >> 1];
          const capFont = lines[B.lines[1]].font;
          if (med > 0 && g > 1.15 * med + 0.1 * body) split = true;
          else if (capFont && L.font && L.font !== capFont && L.font !== P.font && L.font === prep.bodyFont) split = true;
        }
      }
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
  for (const b of blocks) finishBlock(b, lines, bandOf);
  return blocks;
}

/** 段落の性質（文字，文字数，回転，帯など）を，行から求め直す． */
function finishBlock(b, lines, bandOf) {
  const ls = b.lines.map((i) => lines[i]);
  b.left = Math.min(...ls.map((l) => l.left));
  b.right = Math.max(...ls.map((l) => l.right));
  b.top = Math.min(...ls.map((l) => l.top));
  b.bottom = Math.max(...ls.map((l) => l.bottom));
  b.map = new Map();
  for (const l of ls) for (const [s, w] of l.map) b.map.set(s, (b.map.get(s) || 0) + w);
  b.size = modeOf(b.map) || ls[0].size;
  b.text = ls.map((l) => l.text).join(" ");
  b.chars = ls.reduce((n, l) => n + l.chars, 0);
  b.rotated = ls.every((l) => l.rotated);
  b.lineNo = ls.every((l) => l.lineNo);
  b.artifact = ls.every((l) => l.artifact);
  b.band = b.lines.length <= 2 ? bandOf(b) : "";
  b.eqNumber = ls.some((l) => endsWithEquationNumber(l.text));
  b.lastText = ls[ls.length - 1].text;
  return b;
}

/** 柱の行と本文が一つの段落になっていたら（OCR で柱が本文に近い），柱の行を別の段落に分ける． */
function splitFurniture(blocks, lines, marks, bandOf) {
  const out = [];
  for (const b of blocks) {
    if (!b.lines.some((li) => marks.has(li)) || b.lines.every((li) => marks.has(li))) {
      out.push(b);
      continue;
    }
    let cur = null;
    for (const li of b.lines) {
      const f = marks.has(li);
      if (!cur || cur.f !== f) {
        cur = { f, lines: [] };
        out.push(cur);
      }
      cur.lines.push(li);
    }
  }
  return out.map((b) => (b.f === undefined ? b : finishBlock({ lines: b.lines }, lines, bandOf)));
}

// ---------------------------------------------------------------------------
// アルゴリズム・コードの箱
// 語やフォントではなく，主に行の並び方で見分ける．本文は両端をそろえて組むので，段落の途中の行の右端がそろい，
// 字下げは段落の 1 行目だけである．コードと疑似コードは，行の右端がそろわず，字下げが何段にも分かれる．
// 箱（塗った矩形・囲んだ矩形，上下の罫線）があれば，その中の行をまとめて見る．箱だけでは決めない
// （枠で囲んだ本文や，罫線で挟んだ表もあるため）．

/** 行の右端が，まとまりの右端からこの倍数（文字の大きさに対して）より左で終わっていれば「そろわない」． */
const CODE_RAGGED_EM = 2;
/** 字下げの段を分ける間（文字の大きさに対する倍数）． */
const CODE_INDENT_EM = 0.6;
/** 右端の近くまで届く行の割合の上限．これを超えれば本文（枠で囲んだ問題文，注の箱など）とみなす． */
const CODE_MAX_FULL = 0.4;
const CODE_LABEL_RE = /^(?:Algorithm|ALGORITHM|Listing|LISTING|Code|Procedure|PROCEDURE)\s*[0-9]/;

/** 行の集まりの並び方：右端のそろわない行の割合，右端まで届く行の割合，字下げの段の数，等幅の文字の割合． */
function codeShape(ls) {
  const sizes = ls.map((l) => l.size || 1).sort((a, b) => a - b);
  const em = sizes[sizes.length >> 1];
  const maxR = Math.max(...ls.map((l) => l.right));
  // 最後の行は段落の終わりなので数えない
  const body = ls.slice(0, -1);
  const ragged = body.length ? body.filter((l) => maxR - l.right > CODE_RAGGED_EM * em).length / body.length : 0;
  // 右端の近くまで届く行の割合．本文は，両端をそろえても右をそろえなくても，段落の途中の行は右端の近く（幅の 15% 以内）まで届く
  const minL = Math.min(...ls.map((l) => l.left));
  const nearFull = body.length ? body.filter((l) => maxR - l.right <= 0.15 * (maxR - minL)).length / body.length : 0;
  const lefts = ls.map((l) => l.left).sort((a, b) => a - b);
  let levels = 1;
  for (let i = 1; i < lefts.length; i++) if (lefts[i] - lefts[i - 1] > CODE_INDENT_EM * em) levels++;
  let chars = 0;
  let mono = 0;
  for (const l of ls) {
    chars += l.chars;
    mono += l.monoChars || 0;
  }
  // 中央にそろえた行（左右とも 3 文字分以上あき，中心がまとまりの中心に近い．別行立ての式）の割合．コードの行は，
  // 字下げしても左に寄せて組む
  const mid = (minL + maxR) / 2;
  const centred =
    ls.filter((l) => l.left - minL > 3 * em && maxR - l.right > 3 * em && Math.abs((l.left + l.right) / 2 - mid) < 2 * em).length / ls.length;
  return { ragged, nearFull, centred, levels, mono: chars ? mono / chars : 0 };
}

/** 表の形の行（3 つ以上の欄，同じ高さに 3 つ以上の切れ端）を含むか． */
const tableLike = (ls) => ls.some((l) => l.cells >= 3 || l.row >= 3);

/**
 * アルゴリズム・コードの箱の行を探す．
 *   1. 箱（塗った・囲んだ矩形，同じ幅の上下の罫線で挟んだ所）の中の段で，右端のそろわない行が半分以上，右端の近くまで
 *      届く行が 4 割以下のもの（短い切れ端だけのものを除く）．等幅の文字が半分以上なら 3 行から，そうでなければ 4 行以上で，
 *      中ほどに浮いた行（式）が 2 割以下で，右端の近くまで届く行が 4 分の 1 以下かつ字下げが 2 段以上か，「Algorithm 1」などの
 *      見出しがあるときに，その段の行はコード．
 *   2. 箱がなくても，3 行以上の段落で，右端のそろわない行が 6 割以上，右端の近くまで届く行が 4 割以下，字下げが 3 段以上に
 *      分かれ，等幅の文字が半分以上か，
 *      すぐ前の行が「Algorithm 1」などの見出しなら，コード．
 *   表の形の行を含むもの，キャプションの行，行番号は入れない．
 * @returns {Set<number>} 行の番号
 */
function findCodeLines(prep, blocks, page) {
  const { lines, dispW, dispH } = prep;
  const out = new Set();
  const usable = (l) => !l.rotated && !l.lineNo && !l.artifact && l.chars > 0 && !l.cap;
  const bodyFont = prep.bodyFont;
  // 箱の領域（表示の座標，0〜1）
  const regions = [];
  for (const b of page?.boxes ?? []) {
    if ((b.right - b.left) * (b.bottom - b.top) < 0.8) regions.push(b);
  }
  // 罫線は，ページの幅の 3 割以上のものだけ（分数の横線を除く）
  const rules = (page?.rules ?? []).filter((r) => r.right - r.left >= 0.3).sort((a, b) => a.top - b.top);
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const c = rules[j];
      if (Math.abs(a.left - c.left) > 0.02 || Math.abs(a.right - c.right) > 0.02) continue;
      if (c.top - a.bottom >= 0.02) regions.push({ left: Math.min(a.left, c.left), right: Math.max(a.right, c.right), top: a.bottom, bottom: c.top });
      break; // 同じ幅のすぐ下の罫線までの間だけ
    }
  }
  const pad = 0.005;
  for (const r of regions) {
    const ls = [];
    const idx = [];
    lines.forEach((l, li) => {
      if (!usable(l)) return;
      const cx = (l.left + l.right) / 2 / dispW;
      const cy = (l.top + l.bottom) / 2 / dispH;
      if (cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad) {
        ls.push(l);
        idx.push(li);
      }
    });
    // 段ごとに見る（二段組のページ全体を囲む箱では，左右の段の行がまざる）．横に重なる行を一つの段にまとめる
    const cols = [];
    idx.forEach((li, i) => {
      const l = ls[i];
      const hit = cols.filter((c) => l.left < c.right && l.right > c.left);
      const merged = { left: l.left, right: l.right, items: [[li, l]] };
      for (const c of hit) {
        merged.left = Math.min(merged.left, c.left);
        merged.right = Math.max(merged.right, c.right);
        merged.items.push(...c.items);
        cols.splice(cols.indexOf(c), 1);
      }
      cols.push(merged);
    });
    for (const c of cols) {
      const group = c.items.sort((a, b) => a[1].top - b[1].top);
      const gl = group.map((x) => x[1]);
      const labelled = () => {
        const top = Math.min(...gl.map((l) => l.top));
        const em = gl[0].size || 10;
        return lines.some(
          (l) => CODE_LABEL_RE.test(l.text) && l.bottom <= Math.max(...gl.map((x) => x.bottom)) && l.bottom >= top - 3 * em && l.right > c.left && l.left < c.right,
        );
      };
      if (gl.length < 3 || (tableLike(gl) && !labelled())) continue;
      // 図の中のラベル（「∆w(1)」）のような短い切れ端だけの箱は入れない
      const counts = gl.map((l) => l.chars).sort((a, b) => a - b);
      if (counts[counts.length >> 1] < 8 || counts.reduce((a, b) => a + b, 0) < 30) continue;
      const shape = codeShape(gl);
      // 等幅の文字が半分以上なら 3 行から．そうでなければ，4 行以上で，中ほどに浮いた行（式）が少なく，字下げが 2 段以上か
      // 箱の中かすぐ上に「Algorithm 1」などの見出しがあるとき（枠で囲んだ問題文や式と分けるため）
      // 見出しのある箱は，右端の近くまで届く行が少し多くてもよい（長い式の行が並ぶ疑似コード）
      const ok =
        shape.ragged >= 0.5 &&
        (shape.nearFull <= CODE_MAX_FULL || (shape.nearFull <= 0.6 && labelled())) &&
        (shape.mono >= 0.5 ||
          (gl.length >= 4 && ((shape.centred <= 0.2 && shape.nearFull <= 0.25 && shape.levels >= 2) || (shape.centred <= 0.3 && labelled()))));
      if (ok) for (const [li] of group) out.add(li);
    }
  }
  // 箱のない段落
  for (const b of blocks) {
    // 段落の頭が「Algorithm 1 …」の見出しなら，見出しを除いた行を見る（見出しは見出しとして残す）
    let lis = b.lines;
    const head = lines[lis[0]];
    const labelInside = lis.length > 1 && CODE_LABEL_RE.test(head.text);
    if (labelInside) lis = lis.slice(1);
    const ls = lis.map((li) => lines[li]).filter(usable);
    const before = lines[b.lines[0] - 1];
    const labelled = labelInside || (before && CODE_LABEL_RE.test(before.text));
    // 見出しのある疑似コードは，行番号や式の切れ端で表の形に見えることがあるので，表の形の判定をしない
    if (ls.length < 3 || ls.length !== lis.length || (!labelled && tableLike(ls)) || lis.some((li) => out.has(li))) continue;
    const shape = codeShape(ls);
    if (shape.ragged < 0.6 || shape.nearFull > CODE_MAX_FULL || shape.levels < 3) continue;
    // 見出しがなくても：4 行以上で，右端の近くまで届く行が少なく，本文と違うフォントか，行の頭に番号（「1:」）が並ぶ
    let other = 0;
    let tot = 0;
    for (const l of ls) {
      tot += l.chars;
      if (bodyFont && l.font !== bodyFont) other += l.chars;
    }
    const numberedLines = ls.filter((l) => /^\s*\d{1,3}\s*:\s/.test(l.text)).length >= 0.6 * ls.length;
    const unlabelled = ls.length >= 4 && shape.nearFull <= 0.3 && shape.centred <= 0.2 && ((tot && other / tot >= 0.6) || numberedLines);
    if (shape.mono >= 0.5 || labelled || unlabelled) for (const li of lis) out.add(li);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 別行立ての式
// 語や記号ではなく，主に配置で見分ける．式は段の中で字下げか中央寄せで組み，番号は段の右端に寄せる．本文の行は段の左端から
// 始まり，段落の途中の行は右端まで届く．

/** 式の行の中の語の割合の上限（3 文字以上の英字の語の文字の割合．見出しや短い文の行を式としないため）． */
const EQ_MAX_WORD_SHARE = 0.4;
/** 式と式の間に置く，本文のつなぎの語（「or」「and C is」「so that」「where i is」）． */
const CONNECTOR_RE = /^(?:or|and|where|so that|that|then|with|given by|by|hence|thus|i\.e\.|which gives|we (?:find|obtain|have|get))(?:\s|[,:]|$)/;
/** 式の中の関数の名前など（語として数えない）． */
const MATH_WORD_RE = /^(?:sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|log|exp|max|min|sup|inf|lim|det|arg|div|grad|curl|erf|erfc|cov|var|diag|sgn|sign|mod|Tr|tr)$/;

/**
 * 別行立ての式の行を探す．
 *   1. 式番号：行の末尾が「(3)」などの番号だけの item で，その前が 2 文字分以上あき，番号が段の右端に寄る．
 *      式の部分が段の左端から字下げしていれば，式の行とする．
 *   2. 番号がなくても，段の中で左右とも 3 文字分以上あき，中央にそろい，上か下の行との間が本文の行の送りより広い行は式とする．
 *   3. 1・2 の行のすぐ上下にあり，段の左端から字下げし，右端まで届かない行（分数の上下，複数行の式）も式に含める．
 *   どの場合も，大きい文字の行，キャプション，行番号，コード，語の多い行（見出し・文）は入れない．
 * @returns {Set<number>} 行の番号
 */
function findEquationLines(prep, body, tol, pitch, codeLines) {
  const { lines, items } = prep;
  const out = new Set();
  const em = body;
  const long = lines.filter((l) => !l.rotated && !l.lineNo && !l.artifact && l.chars >= 30 && near(l.size, body, tol));
  if (!long.length) return out;
  /** 行のかかる段の左右の端（長い本文の行の端）． */
  const colOf = (l) => {
    let cl = Infinity;
    let cr = -Infinity;
    for (const o of long) {
      if (o.right < l.left || o.left > l.right) continue;
      if (o.left < cl) cl = o.left;
      if (o.right > cr) cr = o.right;
    }
    return cr > cl ? { cl, cr } : null;
  };
  const usable = (l, li) =>
    !l.rotated && !l.lineNo && !l.artifact && !l.cap && l.chars > 0 && !codeLines.has(li) && !(l.size > body * (1 + tol)) && l.size >= 0.8 * body;
  const wordy = (l) => {
    const words = (l.text.match(/[A-Za-z]{3,}/g) || []).filter((w) => !MATH_WORD_RE.test(w)).join("").length;
    const cjk = (l.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    return l.chars > 0 && (words / l.chars >= EQ_MAX_WORD_SHARE || cjk / l.chars >= 0.3);
  };
  /** 式らしい文字（演算の記号，ギリシャ文字，数学の文字）を含むか．数だけ・語だけの行は式としない． */
  const mathy = (l) => /[=<>≤≥≈≠∼~±×÷·∑∏∫∂∇√∞→←↔⇒⇔∈∉⊂⊆∪∩∀∃+\-−/^_|Ͱ-Ͽ\u{1D400}-\u{1D7FF}]/u.test(l.text) && /[^\d\s.,]/.test(l.text);
  /** 行の末尾の式番号の item と，その前の部分の左右．番号がなければ null． */
  const numbered = (l) => {
    const ks = l.nb.filter((k) => !items[k].blank);
    if (ks.length < 2) return null;
    const last = items[ks[ks.length - 1]];
    if (!EQ_NUMBER_ONLY_RE.test(last.str)) return null;
    const restR = Math.max(...ks.slice(0, -1).map((k) => items[k].right));
    const restL = Math.min(...ks.slice(0, -1).map((k) => items[k].left));
    if (last.left - restR < 2 * em) return null;
    return { left: restL, right: restR, numRight: last.right };
  };
  const cand = new Array(lines.length).fill(false);
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (!usable(l, li)) continue;
    const col = colOf(l);
    if (!col) continue;
    const num = numbered(l);
    if (num) {
      if (col.cr - num.numRight <= 1.5 * em && num.left - col.cl > 1.5 * em) cand[li] = true;
      continue;
    }
    // 番号だけの行（分数などで式の基準線が番号とずれた）：段の右端に寄り，左が大きくあく
    if (EQ_NUMBER_ONLY_RE.test(l.text) && col.cr - l.right <= 1.5 * em && l.left - col.cl > 5 * em) {
      cand[li] = true;
      continue;
    }
    if (wordy(l) || !mathy(l)) continue;
    const lg = l.left - col.cl;
    const rg = col.cr - l.right;
    if (lg <= 3 * em || rg <= 3 * em || Math.abs((l.left + l.right) / 2 - (col.cl + col.cr) / 2) >= 2 * em) continue;
    // 上か下の行（重なる行）との間が，本文の行の送りより広い
    let above = Infinity;
    let below = Infinity;
    for (const o of lines) {
      if (o === l || o.rotated || o.lineNo || o.right < col.cl || o.left > col.cr) continue;
      const d = l.base - o.base;
      if (d > 0.5 * em && d < above) above = d;
      if (-d > 0.5 * em && -d < below) below = -d;
    }
    if (above > 1.15 * pitch || below > 1.15 * pitch) cand[li] = true;
  }
  // 3. 上下に広げる
  const seeds = [];
  cand.forEach((c, li) => c && seeds.push(li));
  for (const li of seeds) out.add(li);
  const queue = [...seeds];
  while (queue.length) {
    const li = queue.pop();
    const l = lines[li];
    const col = colOf(l);
    if (!col) continue;
    for (let lj = 0; lj < lines.length; lj++) {
      if (out.has(lj)) continue;
      const o = lines[lj];
      if (!usable(o, lj) || wordy(o)) continue;
      if (Math.abs(o.base - l.base) > 1.3 * pitch) continue;
      // 横に離れた行は，ほぼ同じ高さ（同じ式の左右の部分，式と番号）のときだけ
      if ((o.right < l.left - 2 * em || o.left > l.right + 2 * em) && Math.abs((o.top + o.bottom) / 2 - (l.top + l.bottom) / 2) > 0.8 * em) continue;
      // 段の左端から字下げし，右端まで届かない（番号があれば番号の前まで）
      const num = numbered(o);
      const right = num ? num.right : o.right;
      const left = num ? num.left : o.left;
      if (left - col.cl <= 1.5 * em || col.cr - right <= 1.5 * em) continue;
      out.add(lj);
      queue.push(lj);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文書全体の見分け

/** 柱を探す，前後のページの幅（このページ数の中で繰り返していれば柱）． */
const FURNITURE_WINDOW = 8;
/** OCR の揺れを許す，柱の文字の似かたの下限（2 文字ずつの組の Dice 係数）． */
const FURNITURE_SIMILARITY = 0.8;
const DOI_RE = /^(?:doi|DOI)\s*[:：]|doi\.org\//;
const NOTE_RE = /^[*＊†‡]|〒|e-?mail|corresponding author/i;
const NOTE_LEAD_RE = /^(?:[*＊†‡]|corresponding author)/i;

/** 空白を除き，小文字にした文字．柱の比較に使う． */
const squeeze = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** 2 文字ずつの組の集まり（Dice 係数を求めるため）． */
function bigrams(s) {
  const m = new Map();
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}
function dice(a, b) {
  let n = 0;
  let ta = 0;
  let tb = 0;
  for (const v of a.values()) ta += v;
  for (const v of b.values()) tb += v;
  if (!ta || !tb) return 0;
  for (const [g, v] of a) n += Math.min(v, b.get(g) || 0);
  return (2 * n) / (ta + tb);
}

/** 行の頭か末尾にある数（ページ番号の候補）．「210 7. GRADIENT DESCENT」「7.1 Error Surfaces 211」「― 690 ―」． */
function folioNumbers(text) {
  const t = collapse(text);
  const out = [];
  const head = /^[^\p{L}\p{N}]{0,3}(\d{1,4})(?![\d.．])/u.exec(t);
  const tail = /(?<![\d.．])(\d{1,4})[^\p{L}\p{N}]{0,3}$/u.exec(t);
  if (head) out.push(Number(head[1]));
  if (tail && (!head || tail.index !== head.index)) out.push(Number(tail[1]));
  return out;
}

/**
 * 柱とページ番号の行を見つける．上下の帯の中の行を候補にし，次のどれかなら柱とする．
 *   1. 近くのページ（前後 FURNITURE_WINDOW ページ）の同じ側・同じくらいの高さに，同じ文字（数字は # にする）か，
 *      よく似た文字（OCR の揺れ）の行が，ほかに 2 ページ以上ある．章ごとに変わる柱も，偶数・奇数で違う柱も拾える．
 *   2. 行の頭か末尾の数が，近くのページの帯の行の数とページの順に 1 ずつ（見開きを 1 ページにした PDF では 2 ずつ）並ぶ．
 *   3. DOI の行．
 * @returns {Set<number>[]} ページごとの，柱の行の番号
 */
const furnitureCache = new WeakMap();

function findFurniture(work, band) {
  const N = work.length;
  const cands = work.map((w) => {
    if (!w) return [];
    const prep = w.prep;
    const cached = furnitureCache.get(prep);
    if (cached?.band === band) return cached.candidates;
    const { lines, dispH } = prep;
    const out = [];
    // 帯の中で，いちばん外側（上の帯ならいちばん上，下の帯ならいちばん下）の行の位置
    let minTop = Infinity;
    let maxBottom = -Infinity;
    for (const l of lines) {
      if (l.rotated || l.artifact || l.lineNo || !l.chars) continue;
      if (l.top < minTop) minTop = l.top;
      if (l.bottom > maxBottom) maxBottom = l.bottom;
    }
    lines.forEach((l, li) => {
      if (l.rotated || l.artifact || l.lineNo || !l.chars) return;
      const mid = (l.top + l.bottom) / 2; // 行の中ほどが帯の中（帯の境にかかる大きめの柱も拾う）
      const side = mid <= band * dispH ? "top" : mid >= (1 - band) * dispH ? "bottom" : "";
      if (!side) return;
      const text = squeeze(l.text);
      if (!text || text.length > 160) return;
      const plain = text.replace(/\d+/g, "#");
      const outer = side === "top" ? l.top - minTop < 0.6 * l.size : maxBottom - l.bottom < 0.6 * l.size;
      out.push({ li, side, outer, pos: l.top / dispH, text, plain, letters: plain.replace(/[#\p{P}\p{S}]/gu, ""), grams: null, nums: folioNumbers(l.text), raw: l.text });
    });
    furnitureCache.set(prep, { band, candidates: out });
    return out;
  });
  const marks = work.map(() => new Set());
  for (let p = 0; p < N; p++) {
    for (const c of cands[p]) {
      if (DOI_RE.test(collapse(c.raw))) {
        marks[p].add(c.li);
        continue;
      }
      // 1. 近くのページで繰り返す
      let same = 0;
      if (c.letters.length >= 2 || c.plain.length >= 4) {
        for (let q = Math.max(0, p - FURNITURE_WINDOW); q <= Math.min(N - 1, p + FURNITURE_WINDOW) && same < 2; q++) {
          if (q === p) continue;
          for (const d of cands[q]) {
            if (d.side !== c.side || Math.abs(d.pos - c.pos) > 0.025) continue;
            let hit = d.plain === c.plain;
            if (!hit && c.letters.length >= 6 && d.letters.length >= 6) {
              c.grams ??= bigrams(c.letters);
              d.grams ??= bigrams(d.letters);
              hit = dice(c.grams, d.grams) >= FURNITURE_SIMILARITY;
            }
            if (hit) {
              same++;
              break;
            }
          }
        }
      }
      if (same >= 2) {
        marks[p].add(c.li);
        continue;
      }
      // 2. ページ番号が並ぶ
      if (!c.outer || !c.nums.length || c.text.length > 80) continue;
      let seq = 0;
      for (let q = Math.max(0, p - 3); q <= Math.min(N - 1, p + 3) && seq < 2; q++) {
        if (q === p) continue;
        const want = c.nums.flatMap((n) => [n + (q - p), n + 2 * (q - p)]);
        if (cands[q].some((d) => d.outer && d.nums.some((m) => want.includes(m)))) seq++;
      }
      const need = N <= 4 ? 1 : 2;
      if (seq >= need) marks[p].add(c.li);
    }
  }
  // 柱の行やページ番号と同じ高さに並ぶ帯の行も柱（「7.1. Error Surfaces    211」の見出しの部分）
  for (let p = 0; p < N; p++) {
    const lines = work[p]?.prep.lines;
    if (!lines) continue;
    const anchors = cands[p].filter((c) => marks[p].has(c.li) || isPageNumberText(c.raw));
    for (const c of cands[p]) {
      if (marks[p].has(c.li)) continue;
      const l = lines[c.li];
      // 高さが重なる（OCR では柱の文字とページ番号の基準線が少しずれる）
      const beside = (a) => {
        const m = lines[a.li];
        const ov = Math.min(m.bottom, l.bottom) - Math.max(m.top, l.top);
        return ov > 0.4 * Math.min(m.bottom - m.top, l.bottom - l.top);
      };
      if (anchors.some((a) => a.li !== c.li && a.side === c.side && beside(a))) marks[p].add(c.li);
    }
  }
  return marks;
}

/**
 * 本文の枠：本文の大きさの長い行の左端と右端から，偶数・奇数ページごとに，本文が置かれる横の範囲を求める．
 * 枠の外（余白）にある行の切れ端は余白の注とする．行が少なければ null．
 */
function bodyFrames(work, body, tol) {
  const frames = [null, null];
  for (const parity of [0, 1]) {
    const lefts = [];
    const rights = [];
    work.forEach((w, p) => {
      if (!w || p % 2 !== parity) return;
      const { lines, dispW } = w.prep;
      for (const l of lines) {
        if (l.rotated || l.artifact || l.lineNo || l.chars < 25 || !near(l.size, body, tol)) continue;
        lefts.push(l.left / dispW);
        rights.push(l.right / dispW);
      }
    });
    if (lefts.length < 20) continue;
    lefts.sort((a, b) => a - b);
    rights.sort((a, b) => a - b);
    // 10 パーセンタイル：全幅の図表や章の扉の長い行に引きずられないように
    frames[parity] = { left: lefts[Math.floor(lefts.length * 0.1)], right: rights[Math.ceil(rights.length * 0.9) - 1] };
  }
  return frames;
}

/**
 * XY-cut による読み順（NDLOCR の読み順推定の考え方に倣う．コードは使っていない）．
 * 段落の矩形の集まりを，縦か横の空白で再帰的に分け，左→右・上→下の順に並べる．
 *   - 縦の空白（段の間）があり，両側に 2 行以上あれば，先に縦で分ける（段組み）．
 *   - そうでなければ横の空白で分ける．このとき，幅の広い段落（段をまたぐ見出し・図）があれば，その上と下だけで分け，
 *     なければすべての横の空白で分ける（段組みの段を，横の空白で輪切りにしないため）．
 *   - どちらの空白もなければ，上→下，左→右．
 * @returns {number[]} 段落の番号の読む順
 */
function xyOrder(rects, em) {
  const lineCount = (ids) => ids.reduce((n, i) => n + rects[i].lines, 0);
  const gaps = (ids, lo, hi) => {
    const sorted = [...ids].sort((a, b) => rects[a][lo] - rects[b][lo]);
    const out = [];
    let reach = rects[sorted[0]][hi];
    for (let k = 1; k < sorted.length; k++) {
      const r = rects[sorted[k]];
      if (r[lo] > reach) out.push({ at: k, from: reach, to: r[lo], width: r[lo] - reach, sorted });
      if (r[hi] > reach) reach = r[hi];
    }
    return out;
  };
  const cut = (ids) => {
    if (ids.length <= 1) return ids;
    const vs = gaps(ids, "left", "right");
    let best = null;
    for (const g of vs) {
      if (g.width < 0.5 * em) continue;
      const a = g.sorted.slice(0, g.at);
      const b = g.sorted.slice(g.at);
      if (lineCount(a) < 2 || lineCount(b) < 2) continue;
      if (!best || g.width > best.width) best = g;
    }
    if (best) return [...cut(best.sorted.slice(0, best.at)), ...cut(best.sorted.slice(best.at))];
    const hs = gaps(ids, "top", "bottom");
    if (hs.length) {
      const sorted = hs[0].sorted;
      const left = Math.min(...ids.map((i) => rects[i].left));
      const right = Math.max(...ids.map((i) => rects[i].right));
      const wide = new Set(ids.filter((i) => rects[i].right - rects[i].left > 0.6 * (right - left)));
      let use = hs;
      if (wide.size && wide.size < ids.length) {
        // 幅の広い段落の直前と直後の空白だけ
        use = hs.filter((g) => wide.has(sorted[g.at]) || wide.has(sorted[g.at - 1]));
        if (!use.length) use = hs;
      }
      const out = [];
      let start = 0;
      for (const g of use) {
        out.push(...cut(sorted.slice(start, g.at)));
        start = g.at;
      }
      out.push(...cut(sorted.slice(start)));
      return out;
    }
    if (vs.length) {
      const g = vs.reduce((a, b) => (b.width > a.width ? b : a));
      return [...cut(g.sorted.slice(0, g.at)), ...cut(g.sorted.slice(g.at))];
    }
    return [...ids].sort((a, b) => rects[a].top - rects[b].top || rects[a].left - rects[b].left);
  };
  return cut(rects.map((_, i) => i));
}

/**
 * 文書のすべての（読んだ）ページの文字を，body・auxiliary・excluded に分ける．ページが読まれるたびに呼び直してよい．
 * @param {({view: number[], rotate: number, items: object[], styles: object, figures?: {left: number, top: number, right: number, bottom: number}[]} | null)[]} pages
 *   figures は，ページの図（画像・線画）の矩形（表示の座標，0〜1）．あれば，その中の文字を図の中の文字とする．
 * @param {{furnitureBand?: number, sizeTolerance?: number}} [options] furnitureBand（%）は柱を探す上下の帯の高さ，
 *   sizeTolerance（%）は本文と同じ大きさと見なす差
 * @returns {{bodySize: number, hyphenWords: Set<string>, pages: ({
 *   classes: ("body"|"auxiliary"|"excluded")[],
 *   kinds: (null|"artifact"|"furniture"|"pageNumber"|"caption"|"small"|"rotated"|"margin"|"figure"|"table"|"note"|"ruby"|"lineNumber"|"code"|"equation")[],
 *   order: number[],
 *   paraStart: boolean[],
 *   lines: {top: number, bottom: number, left: number, right: number, items: number[]}[],
 *   lineOf: number[],
 *   blocks: {lines: number[], class: string, kind: string|null, size: number, rank: number}[],
 * } | null)[]}}
 *   classes・kinds・order・lineOf は span の番号で引く．order は span が入る段落の，ページの中の読む順（なければ -1）．
 *   paraStart は行の番号で引き，段落の始まりの行（字下げ）なら true．lines の位置は表示の座標（0〜1）．
 *   hyphenWords は，行の途中にハイフンでつないで書かれた語（小文字）．行末のハイフンを残すかを決めるのに使う．
 */
export function analyzeDocument(pages, options = {}) {
  const analysis = prepareDocumentAnalysis(pages, options);
  return { bodySize: analysis.bodySize, hyphenWords: analysis.hyphenWords, pages: Array.from(Array.isArray(pages) ? pages : [], (_, i) => analysis.page(i)) };
}

const pageResults = new WeakMap();
const pageWords = new WeakMap();

export function prepareDocumentAnalysis(pages, options = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const bandPct = Number.isFinite(options?.furnitureBand) ? options.furnitureBand : DEFAULT_OPTIONS.furnitureBand;
  const tolPct = Number.isFinite(options?.sizeTolerance) ? options.sizeTolerance : DEFAULT_OPTIONS.sizeTolerance;
  const band = Math.min(50, Math.max(0, bandPct)) / 100;
  const tol = Math.min(50, Math.max(0, tolPct)) / 100;
  let preps = list.map((p) => (p ? preparePage(p) : null));
  // 行番号の列：2 ページ以上で同じ位置に見つかった列は，番号の少ないページ（図のページなど）でも行番号とする
  const cols = [];
  for (const [pageIndex, prep] of preps.entries()) {
    for (const c of prep?.lineNumbers ?? []) {
      const g = cols.find((x) => x.side === c.side && Math.abs(x.edge - c.edge) <= LINE_NUMBER_EDGE_TOL);
      if (g) g.pages.add(pageIndex);
      else cols.push({ side: c.side, edge: c.edge, pages: new Set([pageIndex]) });
    }
  }
  const known = cols.filter((c) => c.pages.size >= 2).map(({ side, edge }) => ({ side, edge }));
  if (known.length) preps = list.map((p) => (p ? preparePage(p, known) : null));
  const bodySize = computeBodySize(preps);
  const body = bodySize || 10;

  const work = preps.map((prep) => prep ? { prep } : null);
  const furnitureLines = findFurniture(work, band);
  const frames = bodyFrames(work, body, tol);
  const hyphenWords = new Set();
  for (const prep of preps) {
    if (!prep) continue;
    let words = pageWords.get(prep);
    if (!words) {
      words = new Set();
      for (const l of prep.lines) {
        for (const m of l.text.matchAll(/(\p{L}+)[-‐](\p{L}+)(?=.)/gu)) {
          if (m.index + m[0].length < l.text.length) words.add(m[0].toLowerCase().replace("‐", "-"));
        }
      }
      pageWords.set(prep, words);
    }
    for (const word of words) hyphenWords.add(word);
  }

  function page(pageIndex) {
    const prep = preps[pageIndex];
    if (!prep) return null;
    const pg = list[pageIndex];
    const frame = frames[pageIndex % 2];
    const furniture = furnitureLines[pageIndex];
    const key = JSON.stringify([bodySize, band, tol, frame, [...furniture]]);
    const old = pageResults.get(pg);
    if (old?.prep === prep && old.key === key &&
        old.graphics.every((value, i) => value === pg[GRAPHICS[i]])) return old.result;

    const pitch = pagePitch(prep, body, tol) || 1.2 * body;
    let blocks = buildBlocks(prep, body, tol, band, pitch);
    const codeLines = findCodeLines(prep, blocks, pg);
    const bandOf = (box) => (box.bottom <= band * prep.dispH ? "top" : box.top >= (1 - band) * prep.dispH ? "bottom" : "");
    if (codeLines.size) blocks = splitFurniture(blocks, prep.lines, codeLines, bandOf);
    const eqLines = findEquationLines(prep, body, tol, pitch, codeLines);
    if (eqLines.size) blocks = splitFurniture(blocks, prep.lines, eqLines, bandOf);
    blocks = splitFurniture(blocks, prep.lines, furniture, bandOf);
    const { items, lines, lineOf, dispW, dispH } = prep;
    const figures = (list[pageIndex]?.figures ?? []).filter((f) => f && (f.right - f.left) * (f.bottom - f.top) < 0.8);
    const bodyRotated = prep.rotChars > 0.5 * prep.totChars; // 縦書きのように，本文そのものが回転している
    // 本文の行の幅の目安（いちばん広い行の代わりに，80 パーセンタイル．ページ全体に渡る 1 行に引きずられないように）
    const widths = lines
      .filter((l) => !l.rotated && !l.artifact && !l.lineNo && l.chars >= 10 && near(l.size, body, tol))
      .map((l) => l.right - l.left)
      .sort((a, b) => a - b);
    const refWidth = widths.length ? widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.8))] : 0;
    const bodyLines = lines.filter((l) => !l.rotated && !l.artifact && !l.lineNo && near(l.size, body, tol));
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
    const em = body;
    /** 見出しの番号の後が小文字の語か「,」で始まる（「Figure 3 shows …」「Table 2.3, we …」．本文の文）． */
    const proseStart = (b) => {
      const m = CAPTION_RE.exec(collapse(lines[b.lines[0]].text));
      return !!m && /^\s*(?:[a-z]|[,，])/.test(m[2]);
    };
    /** 段落のすぐ上か下（3 文字分以内）に，横に重なる図（画像・線画）があるか（PDFFigures 2.0：キャプションは図に接する）． */
    const nearFigure = (b) => {
      const t = b.top / dispH;
      const btm = b.bottom / dispH;
      const l = b.left / dispW;
      const r = b.right / dispW;
      const gap = (3 * em) / dispH;
      return [...figures, ...drawings].some((f) => f.left < r && f.right > l && ((f.bottom <= t + gap / 3 && t - f.bottom < gap) || (f.top >= btm - gap / 3 && f.top - btm < gap)));
    };
    // ページの本文のフォント（長い本文の行でいちばん多いもの）
    const pageFonts = new Map();
    for (const l of bodyLines) if (l.chars >= 30) pageFonts.set(l.font, (pageFonts.get(l.font) || 0) + l.chars);
    const pageFont = pageFonts.size ? modeOf(pageFonts) : null;
    /** 段落のフォントが本文と違うか（キャプションを本文と違うフォントで組む PDF）． */
    const otherFont = (b) => {
      if (!pageFont) return false;
      const fs = new Map();
      for (const li of b.lines) fs.set(lines[li].font, (fs.get(lines[li].font) || 0) + lines[li].chars);
      return modeOf(fs) !== pageFont;
    };
    /** 段落の左端が，本文の長い行のどの左端ともそろわないか（図の横に置いたキャプションなど）． */
    const offColumn = (b) =>
      bodyLines.some((l) => l.chars >= 30) && !bodyLines.some((l) => l.chars >= 30 && !b.lines.includes(lines.indexOf(l)) && Math.abs(l.left - b.left) <= em);
    /** 段落が本文の枠の外（余白）にあるか． */
    const outsideFrame = (b) => {
      if (!frame) return false;
      const l = b.left / dispW;
      const r = b.right / dispW;
      const pad = em / dispW;
      return r < frame.left - pad || l > frame.right + pad;
    };
    /** 段落の文字の中心が図の矩形の中にある割合． */
    const inFigure = (b) => {
      if (!figures.length) return 0;
      let hit = 0;
      let tot = 0;
      for (const li of b.lines) {
        for (const k of lines[li].nb) {
          const it = items[k];
          const cx = (it.left + it.right) / 2 / dispW;
          const cy = (it.top + it.bottom) / 2 / dispH;
          tot += it.chars;
          if (figures.some((f) => cx >= f.left && cx <= f.right && cy >= f.top && cy <= f.bottom)) hit += it.chars;
        }
      }
      return tot ? hit / tot : 0;
    };
    /** 段落の文字の中心が，矩形の並び（表示の座標，0〜1）のどれかに入る割合． */
    const shareIn = (b, rects) => {
      if (!rects.length) return 0;
      let hit = 0;
      let tot = 0;
      for (const li of b.lines) {
        for (const k of lines[li].nb) {
          const it = items[k];
          const cx = (it.left + it.right) / 2 / dispW;
          const cy = (it.top + it.bottom) / 2 / dispH;
          tot += it.chars;
          if (rects.some((f) => cx >= f.left && cx <= f.right && cy >= f.top && cy <= f.bottom)) hit += it.chars;
        }
      }
      return tot ? hit / tot : 0;
    };
    /** 文の段落の形（本文の幅に近い長い行が 2 行以上）．図や表の領域の中でも，これは本文とする． */
    const proseLike = (b) =>
      refWidth > 0 && b.lines.filter((li) => lines[li].chars >= 30 && lines[li].right - lines[li].left >= 0.6 * refWidth).length >= 2;
    // 線画の図の領域（PDFFigures 2.0）：近い描画をまとめたもの．罫線ばかりのもの（表の罫線）は除く
    // 本文の文の行（長く，本文の幅に近い行）を 2 行以上含む領域は，本文の上の飾り（行の背景の色など）なので図としない
    const proseIn = (g) =>
      lines.filter((l) => {
        if (l.rotated || l.lineNo || l.chars < 30 || !(refWidth > 0) || l.right - l.left < 0.6 * refWidth) return false;
        const cx = (l.left + l.right) / 2 / dispW;
        const cy = (l.top + l.bottom) / 2 / dispH;
        return cx >= g.left && cx <= g.right && cy >= g.top && cy <= g.bottom;
      }).length;
    const drawings = (pg.drawings ?? []).filter(
      (g) => g && g.rules < 0.8 * g.n && (g.right - g.left) * (g.bottom - g.top) < 0.8 && proseIn(g) < 2,
    );
    // 罫線で挟まれた領域（表の候補）：左右の端がそろう，段の幅ほどの罫線が 2 本以上，上下に並ぶ
    const ruleRegions = [];
    {
      const rs = (pg.rules ?? []).filter((r) => r.right - r.left >= 0.25).sort((a, b) => a.top - b.top);
      const used = new Set();
      for (let i = 0; i < rs.length; i++) {
        if (used.has(i)) continue;
        const set = [rs[i]];
        for (let j = i + 1; j < rs.length; j++) {
          const r = rs[j];
          if (Math.abs(r.left - rs[i].left) <= 0.02 && Math.abs(r.right - rs[i].right) <= 0.02 && r.top - set[set.length - 1].bottom <= 0.5) {
            set.push(r);
            used.add(j);
          }
        }
        if (set.length >= 2) ruleRegions.push({ left: rs[i].left, right: rs[i].right, top: set[0].top, bottom: set[set.length - 1].bottom });
      }
    }
    /** 表の行の形（欄が 2 つ以上に分かれる行が半分以上）． */
    const tabular = (b) => b.lines.filter((li) => lines[li].cells >= 2 || lines[li].row >= 2).length >= Math.max(1, 0.5 * b.lines.length);
    // 脚注の区切りの線（PDFBoT）：ページの下の半分の，段の幅の半分より短い罫線
    // （分数の線と取り違えないよう，段の左端から始まり，すぐ上に文字がないものだけ）
    const footRules = (pg.rules ?? []).filter((r) => {
      if (!(r.top >= 0.5 && r.right - r.left >= 0.03 && refWidth > 0 && (r.right - r.left) * dispW < 0.5 * refWidth)) return false;
      const rl = r.left * dispW;
      const rr = r.right * dispW;
      const rt = r.top * dispH;
      if (!bodyLines.some((l) => Math.abs(l.left - rl) <= 0.5 * em && l.right - l.left >= 0.6 * refWidth)) return false;
      // ほかの罫線と並ばない（表の枠の線は，同じ高さや近い高さに別の線がある）
      if ((pg.rules ?? []).some((o) => o !== r && Math.abs(o.top - r.top) < 0.03)) return false;
      // すぐ上（と線にかかる所）に文字がない（分数の線，見出しの下線を除く）
      return !items.some((it) => !it.blank && it.left < rr && it.right > rl && it.top < rt + 0.1 * em && it.bottom > rt - 1.2 * em);
    });
    /** 段落が脚注の区切りの線より下にあり，同じ段にあるか． */
    const belowFootRule = (b) =>
      footRules.some((r) => {
        const rl = r.left * dispW;
        return b.top >= r.bottom * dispH - 0.2 * em && b.left >= rl - em && b.left <= rl + 2 * em && b.right <= rl + 1.1 * refWidth;
      });
    // 表の行：3 つ以上の欄（離れた行の切れ端か，行の中の広い間）が同じ高さに並び，数字が多い
    const tableRows = (b) =>
      b.lines.filter((li) => {
        const l = lines[li];
        return (l.cells >= 3 || (l.row >= 3 && l.chars <= 30)) && l.digitShare >= 0.3;
      }).length;
    const isShort = (b) => b.chars <= 30 && b.lines.length <= 6 && b.lines.every((li) => lines[li].chars <= 8) && !b.eqNumber;
    // 短い行ばかりの小さな段落が 3 つ以上あるページでは，それらを図の中の記号や軸の数字とみなす
    const shortCount = blocks.filter((b) => !b.artifact && !b.band && !b.lineNo && isShort(b)).length;
    /** 式の間の「or」「and C is」「so that」「where」のような，本文のつなぎの語で始まる短い段落． */
    const connector = (b) => CONNECTOR_RE.test(collapse(b.text));
    const shortBlock = (b) => shortCount >= 3 && isShort(b);

    let prevContent = null; // 直前の（除外でない）段落
    let prev = null; // 直前の段落
    for (const b of blocks) {
      let cls = "body";
      let kind = null;
      const firstCap = lines[b.lines[0]].cap;
      const allFurniture = b.lines.every((li) => furnitureLines[pageIndex].has(li));
      if (b.lineNo) {
        cls = "auxiliary";
        kind = "lineNumber";
      } else if (b.artifact) {
        cls = "excluded";
        kind = "artifact";
      } else if (b.band && b.lines.length === 1 && isPageNumberText(b.text)) {
        cls = "excluded";
        kind = "pageNumber";
      } else if (allFurniture) {
        cls = "excluded";
        kind = "furniture";
      } else if (inFigure(b) >= 0.5) {
        cls = "auxiliary";
        kind = "figure";
      } else if (
        firstCap &&
        !(prevContent && HYPHEN_END_RE.test(prevContent.lastText)) &&
        (firstCap === "strict" ||
          smaller(b) ||
          (refWidth > 0 && b.right - b.left < 0.7 * refWidth) ||
          centred(b) ||
          (!proseStart(b) && (offColumn(b) || otherFont(b))))
      ) {
        cls = "auxiliary";
        kind = "caption";
      } else if (b.lines.every((li) => codeLines.has(li))) {
        cls = "auxiliary";
        kind = "code";
      } else if (b.lines.every((li) => eqLines.has(li))) {
        cls = "auxiliary";
        kind = "equation";
      } else if (b.rotated && !bodyRotated) {
        cls = "auxiliary";
        kind = "rotated";
      } else if (outsideFrame(b)) {
        cls = "auxiliary";
        kind = "margin";
      } else if (b.lines.length >= 2 && tableRows(b) >= Math.max(2, 0.5 * b.lines.length)) {
        cls = "auxiliary";
        kind = "table";
      } else if (ruleRegions.length && shareIn(b, ruleRegions) >= 0.5 && tabular(b) && !proseLike(b)) {
        // 罫線で挟まれた表
        cls = "auxiliary";
        kind = "table";
      } else if (drawings.length && shareIn(b, drawings) >= 0.5 && !proseLike(b)) {
        // 線画の図の中の文字
        cls = "auxiliary";
        kind = "figure";
      } else if (b.top / dispH >= 0.55 && (pageIndex === 0 || smaller(b) || (b.lines.length <= 2 && NOTE_LEAD_RE.test(collapse(b.text)))) && NOTE_RE.test(collapse(b.text))) {
        // 所属・連絡先の脚注（1 ページ目のもの．ほかのページでは，本文より小さいものと，「*」や「Corresponding author」で
        // 始まる 2 行までのものだけ．本文の「データの入手先」の段落のメールアドレスで本文を除かないため）
        cls = "auxiliary";
        kind = "note";
      } else if (footRules.length && belowFootRule(b) && (smaller(b) || (b.size <= bodySize * (1 + tol) && footRules.some((r) => r.top >= 0.75)))) {
        // 脚注の区切りの線の下の段落
        cls = "auxiliary";
        kind = "note";
      } else if (smaller(b) && !b.eqNumber && !mathFragment(b, prev, pitch)) {
        cls = "auxiliary";
        kind = "small";
      } else if (shortBlock(b) && !connector(b) && !(prevContent && HYPHEN_END_RE.test(prevContent.lastText))) {
        // 短い行ばかりの小さな段落（図の中の記号や軸の数字）
        cls = "auxiliary";
        kind = "figure";
      }
      b.cls = cls;
      b.kind = kind;
      if (kind === "lineNumber") continue; // 行番号の段落は，前後の段落の関係に入れない
      if (cls !== "excluded") prevContent = b;
      prev = b;
    }

    // 読む順（XY-cut）．縦書きが本文のページは，描く順のまま．柱と余白の注は段の切れ目をふさぐので入れない（順は -1）
    const placed = blocks.filter((b) => b.cls !== "excluded" && b.kind !== "margin" && b.kind !== "lineNumber");
    const rects = placed.map((b) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom, lines: b.lines.length }));
    const seq = bodyRotated || !placed.length ? placed.map((_, i) => i) : xyOrder(rects, em);
    for (const b of blocks) b.rank = -1;
    seq.forEach((i, rank) => (placed[i].rank = rank));

    // 読む順で前後を見る規則
    const content = seq.map((i) => placed[i]);
    const aux = (b) => b && b.cls === "auxiliary" && b.kind !== "caption" && b.kind !== "equation";
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      const P = content[i - 1];
      const Nx = content[i + 1];
      // 区切りのない見出し（Table 7.1 Radar …）：すぐ前か後が表・図などなら見出し
      // 二つの言語で並ぶキャプション（「第 7 図 …」のすぐ下の「Fig. 7 …」）も，すぐ上がキャプションなら見出し
      const capAbove = blocks.some(
        (c) => c !== b && c.kind === "caption" && c.top < b.top && b.top - c.bottom < 2 * em && c.left < b.right && c.right > b.left,
      );
      if (b.cls === "body" && lines[b.lines[0]].cap === "loose" && !proseStart(b) && (aux(P) || aux(Nx) || capAbove || nearFigure(b))) {
        b.cls = "auxiliary";
        b.kind = "caption";
      }
    }
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      const P = content[i - 1];
      const Nx = content[i + 1];
      // 続きの規則：本文の段落に挟まれ，左端がそろい，幅も同じくらいの「小さい」段落は本文（OCR の大きさの揺れ，
      // 添え字の多い行を小さい文字で書いた PDF）．ページの初めか終わりの段落は，大きさの差が 1 割以内のときだけ
      // （段の終わりの脚注を本文にしないため）
      if (b.kind !== "small") continue;
      const aligned = (o) => o && o.cls === "body" && Math.abs(o.left - b.left) <= em && Math.abs(o.right - b.right) <= 2 * em;
      const between = P?.cls === "body" && Nx?.cls === "body";
      const edge = (!P && Nx?.cls === "body") || (!Nx && P?.cls === "body");
      if ((between && b.size >= 0.7 * body && (aligned(P) || aligned(Nx))) || (edge && b.size >= 0.9 * body && (aligned(P) || aligned(Nx)))) {
        b.cls = "body";
        b.kind = null;
      }
    }

    // span ごとの分け方
    const n = items.length;
    const classes = new Array(n).fill("body");
    const kinds = new Array(n).fill(null);
    const order = new Array(n).fill(-1);
    const blockOfLine = new Array(lines.length);
    blocks.forEach((b) => {
      for (const li of b.lines) blockOfLine[li] = b;
    });
    for (let li = 0; li < lines.length; li++) {
      const b = blockOfLine[li];
      const furniture = furnitureLines[pageIndex].has(li) && b.cls !== "excluded";
      for (const k of lines[li].items) {
        classes[k] = furniture ? "excluded" : b.cls;
        kinds[k] = furniture ? "furniture" : b.kind;
        order[k] = b.rank;
      }
      for (const k of lines[li].ruby ?? []) {
        classes[k] = "auxiliary";
        kinds[k] = "ruby";
      }
    }
    for (let k = 0; k < n; k++) {
      const it = items[k];
      if (it.artifact && kinds[k] !== "lineNumber") {
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

    // 段落の始まりの行：段落の中で，前の行が文で終わり，この行が字下げされている
    const paraStart = new Array(lines.length).fill(false);
    for (const b of blocks) {
      for (let j = 1; j < b.lines.length; j++) {
        const P = lines[b.lines[j - 1]];
        const L = lines[b.lines[j]];
        if (L.left > b.left + 0.7 * em && L.left < b.left + 4 * em && SENTENCE_END_RE.test(P.text)) paraStart[b.lines[j]] = true;
      }
    }

    const result = {
      classes,
      kinds,
      order,
      paraStart,
      lines: prep.outLines,
      lineOf,
      blocks: blocks.map((b) => ({ lines: b.lines, class: b.cls, kind: b.kind, size: b.size, rank: b.rank })),
    };
    pageResults.set(pg, { prep, key, graphics: GRAPHICS.map((name) => pg[name]), result });
    return result;
  }

  return { bodySize, hyphenWords, page };
}

const GRAPHICS = ["figures", "boxes", "rules", "drawings"];

/**
 * 小さい文字の段落が，数式の切れ端（∑ の上下の添え字など）か：短く，直前の本文の段落のすぐそばにある．
 */
function mathFragment(b, prev, pitch) {
  if (!prev || prev.cls !== "body" || b.lines.length > 2 || b.chars > 16) return false;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(b.text)) return false; // 日本語の語は数式でない
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
  figure: "small",
  table: "small",
  note: "small",
  margin: "margin",
  ruby: "ruby",
  lineNumber: "lineNumber",
  code: "code",
  equation: "equation",
};

/**
 * 選んだ範囲（span の切れ端の並び）から，本文でないものを除く．
 * 1. 範囲の初めと終わりにある除外（柱・ページ番号など）は，本文の切れ端が一つでも残るなら落とす．
 * 2. そのうえで，残りの初めと終わり（空白でないもの）がどちらも本文なら，間の本文でないものをすべて落とす．
 *    そうでなければ（キャプションだけを選んだ，キャプションの中で終わったなど），1 で落とした両端のほかは残す．
 * 3. ルビと行番号は，ほかに残るものがあれば，どこにあっても落とす．
 * 4. 初めと終わりの本文の切れ端の読む順（ページ，段落の読む順）の外にあるものを落とす（段の後に描かれた見出しなど）．
 *    残りは読む順に並べた順番（order）も返す．
 * 設定で外した種類は本文として扱う．分け方の分からないもの（ページを読んでいない，spanIndex が -1）も本文とする．
 * @param {{pageIndex: number, spanIndex: number, text: string}[]} pieces 選んだ順
 * @param {ReturnType<typeof analyzeDocument> | null} analysis
 * @param {{skipFurniture?: boolean, skipCaptions?: boolean, skipSmallText?: boolean, skipMarginNotes?: boolean, skipRuby?: boolean, skipLineNumbers?: boolean, skipCode?: boolean, skipEquations?: boolean}} [options]
 * @returns {{keep: boolean[], order: number[], removed: {kind: string, pageIndex: number, text: string}[]}}
 *   order は，残した切れ端の番号を読む順に並べたもの．
 */
export function filterSelection(pieces, analysis, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const list = Array.isArray(pieces) ? pieces : [];
  const n = list.length;
  const enabled = {
    furniture: !!opt.skipFurniture,
    caption: !!opt.skipCaptions,
    small: !!opt.skipSmallText,
    margin: !!opt.skipMarginNotes,
    ruby: !!opt.skipRuby,
    lineNumber: !!opt.skipLineNumbers,
    code: !!opt.skipCode,
    equation: !!opt.skipEquations,
  };
  const cat = new Array(n); // "body" | "furniture" | "caption" | "small" | "margin" | "ruby" | "lineNumber" | "code"
  const anywhere = (c) => c === "ruby" || c === "lineNumber"; // どこにあっても落とすもの
  const blank = new Array(n);
  const rank = new Array(n); // 読む順（ページ × 大きな数 ＋ 段落の順．分からなければ null）
  for (let i = 0; i < n; i++) {
    const p = list[i] || {};
    blank[i] = isBlank(String(p.text ?? ""));
    const pa = analysis?.pages?.[p.pageIndex];
    let group = null;
    rank[i] = null;
    if (pa && Number.isInteger(p.spanIndex) && p.spanIndex >= 0) {
      const kind = pa.kinds?.[p.spanIndex];
      if (kind) group = KIND_GROUP[kind] ?? null;
      else if (pa.classes?.[p.spanIndex] === "excluded") group = "furniture";
      else if (pa.classes?.[p.spanIndex] === "auxiliary") group = "small";
      const o = pa.order?.[p.spanIndex];
      if (Number.isInteger(o) && o >= 0) rank[i] = p.pageIndex * 1e6 + o;
    }
    cat[i] = group && enabled[group] ? group : "body";
  }

  const keep = new Array(n).fill(true);
  const why = new Array(n).fill(null); // 落とした理由（種類）
  const drop = (i, kind) => {
    keep[i] = false;
    why[i] = kind;
  };
  // 1. 両端の除外を落とす
  let s = -1;
  let e = -1;
  for (let i = 0; i < n; i++) if (!blank[i] && cat[i] !== "furniture" && !anywhere(cat[i])) { s = i; break; }
  for (let i = n - 1; i >= 0; i--) if (!blank[i] && cat[i] !== "furniture" && !anywhere(cat[i])) { e = i; break; }
  let hasBody = false;
  if (s >= 0) for (let i = s; i <= e; i++) if (!blank[i] && cat[i] === "body") { hasBody = true; break; }
  if (hasBody) {
    // 0. 選択のはみ出し：文字の層では，段の後に描かれた文字（別行立ての数式など）が段の span の後に並ぶ．段の最後まで
    //    選ぶと，その先の span まで選択が伸びる．同じページで選択の初めの行より上にある末尾の切れ端（同じ段のもの，
    //    または読む順で初めより前のもの）は，選んだ範囲の外なので落とす
    const box = (i) => {
      const p = list[i] || {};
      const pa = analysis?.pages?.[p.pageIndex];
      const li = Number.isInteger(p.spanIndex) && p.spanIndex >= 0 ? pa?.lineOf?.[p.spanIndex] : -1;
      return li >= 0 ? pa?.lines?.[li] ?? null : null;
    };
    const sBox = box(s);
    const eBox = box(e);
    if (sBox && eBox && list[s].pageIndex === list[e].pageIndex) {
      let j = e;
      // 初めの行より上にあり，同じ段（横に重なる）か，読む順で初めより前のもの．
      // 隣の段の上へ続ける選択（段またぎ．読む順では後）は落とさない
      const above = (i) => {
        const b = box(i);
        if (!b || b.top >= sBox.top) return false;
        if (rank[i] !== null && rank[s] !== null && rank[i] !== rank[s]) return rank[i] < rank[s];
        return cat[i] !== "body" && b.bottom <= sBox.top && b.left < sBox.right && b.right > sBox.left;
      };
      while (j > s && (blank[j] || (list[j].pageIndex === list[s].pageIndex && above(j)))) j--;
      if (j < e && cat[j] === "body") {
        for (let i = j + 1; i <= e; i++) drop(i, blank[i] ? null : cat[i] === "body" ? "order" : cat[i]);
        e = j;
      }
    }
    let side = false;
    for (let i = 0; i < s; i++) if (cat[i] === "furniture") side = true;
    if (side) for (let i = 0; i < s; i++) drop(i, cat[i] === "body" ? null : cat[i]);
    side = false;
    for (let i = e + 1; i < n; i++) if (cat[i] === "furniture") side = true;
    if (side) for (let i = e + 1; i < n; i++) drop(i, cat[i] === "body" ? null : cat[i]);
    // 2. 初めと終わりが本文なら，間の本文でないものを落とす
    if (cat[s] === "body" && cat[e] === "body") {
      for (let i = s + 1; i < e; i++) if (cat[i] !== "body") drop(i, cat[i]);
      // 4. 読む順の外にあるもの
      const lo = rank[s];
      const hi = rank[e];
      if (lo !== null && hi !== null && lo <= hi) {
        for (let i = s + 1; i < e; i++) {
          if (!keep[i] || blank[i] || rank[i] === null) continue;
          if (rank[i] < lo || rank[i] > hi) drop(i, cat[i] === "body" ? "order" : cat[i]);
        }
      }
    }
  }
  // 3. ルビと行番号
  if (s >= 0) for (let i = 0; i < n; i++) if (anywhere(cat[i]) && keep[i]) drop(i, cat[i]);

  // 残したものを読む順に並べる（順の分からない切れ端は直前のものに付ける．同じ順なら選んだ順のまま）
  const kept = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const r = rank[i] ?? last;
    kept.push({ i, r });
    if (rank[i] !== null && !blank[i]) last = rank[i];
  }
  const order = [...kept].sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.i);

  // 落としたものを，種類とページの続く範囲ごとにまとめる
  const removed = [];
  let run = null;
  for (let i = 0; i < n; i++) {
    const p = list[i] || {};
    if (keep[i]) {
      if (!blank[i]) run = null; // 残した空白は，まとまりを切らない
      continue;
    }
    const kind = why[i];
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
    order,
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

/**
 * 行末のハイフンで切れた語のうち，文書の中で行の途中にもハイフン付きで書かれている語（short-wavelength）は，
 * ハイフンを残してつなぐ（改行を消す）．それ以外はそのまま（原文の整形で，ハイフンを消してつなぐ）．
 * @param {string} text
 * @param {Set<string> | null | undefined} words analyzeDocument の hyphenWords
 */
export function keepHyphens(text, words) {
  if (!words?.size) return text;
  return String(text).replace(/(\p{L}+)([-‐])[ \t]*\n[ \t]*(\p{L}+)/gu, (m, a, h, b) =>
    words.has(`${a}-${b}`.toLowerCase()) ? `${a}${h}${b}` : m,
  );
}
