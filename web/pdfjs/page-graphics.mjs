// PDF TransNote：ページの描画の命令（operatorList）から，図（画像）と箱（塗った矩形・線で囲んだ矩形）の位置を集める
// （pdf.js の OPS と viewport を引数で受け取るので，アプリ（bridge.js）からも Node の道具（tools/）からも使える）
// ===========================================================================
// 位置は表示の座標（ページの幅・高さを 1 とし，左上が原点，y は下向き）で返す．
// operatorList は pdf.js の内部の値なので，pdf.js を更新したら確かめること（constructPath の引数は
// [描く命令, [道の数値], minMax]．minMax はその時の座標系での外接矩形）．

/** 小さな画像（記号・飾り）は図として数えない（ページの面積に対する割合）． */
const MIN_FIGURE_AREA = 0.01;
/** 箱とみなす矩形の大きさの下限（ページの幅・高さに対する割合）．細い線（罫線）は rules に入れる． */
const MIN_BOX_SIDE = 0.02;
/** 罫線とみなす太さの上限（ページの高さに対する割合）． */
const MAX_RULE_THICKNESS = 0.004;
/** 線画のまとまり：この距離（ページの幅・高さに対する割合）より近い描画を一つにまとめる． */
const DRAWING_JOIN = 0.006;
/** 線画のまとまりとして返す最小の数（描画の数）と面積（ページの面積に対する割合）． */
const MIN_DRAWING_PATHS = 4;
const MIN_DRAWING_AREA = 0.01;

/**
 * 描画の矩形を，近いものどうしでまとめる（PDFFigures 2.0 の「図の領域」の考え方）．
 * @param {{left: number, top: number, right: number, bottom: number, t: string}[]} rs
 */
function clusterDrawings(rs) {
  const unique = new Map();
  for (const r of rs) {
    const key = `${r.left},${r.top},${r.right},${r.bottom}`;
    let entry = unique.get(key);
    if (!entry) unique.set(key, (entry = { ...r, n: 0, rules: 0, boxes: 0 }));
    entry.n++;
    if (r.t === "rule") entry.rules++;
    if (r.t === "box") entry.boxes++;
  }
  const rects = [...unique.values()];
  const parent = rects.map((_, i) => i);
  const size = new Uint32Array(rects.length).fill(1);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (i, j) => {
    let a = find(i);
    let b = find(j);
    if (a === b) return;
    if (size[a] < size[b]) [a, b] = [b, a];
    parent[b] = a;
    size[a] += size[b];
  };
  const band = (y) => Math.max(0, Math.min(63, Math.floor(y * 64)));
  const rows = Array.from({ length: 64 }, () => []);
  const order = rects.map((_, i) => i).sort((a, b) => rects[b].left - rects[a].left);
  const visited = new Int32Array(rects.length).fill(-1);
  for (const i of order) {
    const a = rects[i];
    const first = band(a.top - DRAWING_JOIN);
    const last = band(a.bottom + DRAWING_JOIN);
    for (let y = first; y <= last; y++) {
      const row = rows[y];
      for (let k = row.length - 1; k >= 0; k--) {
        const j = row[k];
        const b = rects[j];
        if (b.left > a.right + DRAWING_JOIN) break;
        if (visited[j] === i) continue;
        visited[j] = i;
        if (b.top <= a.bottom + DRAWING_JOIN && a.top <= b.bottom + DRAWING_JOIN) join(i, j);
      }
    }
    for (let y = band(a.top); y <= band(a.bottom); y++) rows[y].push(i);
  }
  const groups = new Map();
  rects.forEach((r, i) => {
    const k = find(i);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, n: 0, rules: 0, boxes: 0 }));
    g.left = Math.min(g.left, r.left);
    g.top = Math.min(g.top, r.top);
    g.right = Math.max(g.right, r.right);
    g.bottom = Math.max(g.bottom, r.bottom);
    g.n += r.n;
    g.rules += r.rules;
    g.boxes += r.boxes;
  });
  return [...groups.values()];
}

const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1],
  A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3],
  A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4],
  A[1] * B[4] + A[3] * B[5] + A[5],
];

/** 色が白か（背景と同じ色で塗った矩形は箱ではない）． */
function isWhite(color) {
  if (typeof color === "string") return /^#?f{6}$/i.test(color.trim());
  if (Array.isArray(color)) return color.length > 0 && color.every((v) => v >= 0.99 * (color.some((c) => c > 1) ? 255 : 1));
  return false;
}

/**
 * 描画の命令をたどり，画像の矩形（figures），塗った矩形・線で囲んだ矩形（boxes），細い横線（rules）を返す．
 * @param {{fnArray: number[], argsArray: any[]}} opList
 * @param {{width: number, height: number, convertToViewportPoint: (x: number, y: number) => number[]}} viewport scale 1 の viewport
 * @param {Record<string, number>} OPS pdf.js の OPS
 * drawings は，描画（線・曲線・塗り）を近いものどうしでまとめた矩形．n は描画の数，rules と boxes はそのうちの罫線と箱の数．
 * @returns {{figures: Rect[], boxes: (Rect & {fill: boolean})[], rules: Rect[], drawings: (Rect & {n: number, rules: number, boxes: number})[]}}
 * @typedef {{left: number, top: number, right: number, bottom: number}} Rect
 */
export function graphicsFromOperatorList(opList, viewport, OPS) {
  return groupPageDrawings(collectPageGeometry(opList, viewport, OPS));
}

export function groupPageDrawings({ figures, boxes, rules, paths }) {
  const drawings = clusterDrawings(paths).filter((g) => g.n >= MIN_DRAWING_PATHS && (g.right - g.left) * (g.bottom - g.top) >= MIN_DRAWING_AREA);
  return { figures, boxes, rules, drawings };
}

export function collectPageGeometry(opList, viewport, OPS) {
  const O = OPS;
  const IMAGE_OPS = new Set(
    [O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintImageXObjectRepeat].filter((v) => v !== undefined),
  );
  const FILL_OPS = new Set([O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke].filter((v) => v !== undefined));
  const STROKE_OPS = new Set([O.stroke, O.closeStroke].filter((v) => v !== undefined));
  let ctm = [1, 0, 0, 1, 0, 0];
  let fillColor = null;
  const stack = [];
  const figures = [];
  const boxes = [];
  const rules = [];
  const paths = [];
  const W = viewport.width || 1;
  const H = viewport.height || 1;
  /** 現在の座標系の矩形（x0, y0, x1, y1）を表示の座標に */
  const toView = (x0, y0, x1, y1) => {
    const pts = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ].map(([x, y]) => viewport.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
    const xs = pts.map((p) => p[0] / W);
    const ys = pts.map((p) => p[1] / H);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  };
  const { fnArray, argsArray } = opList;
  let annotDepth = 0; // 注釈（ハイライトなど）の見た目の中．ページの中身ではないので数えない
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === O.beginAnnotation) annotDepth++;
    else if (fn === O.endAnnotation) annotDepth = Math.max(0, annotDepth - 1);
    if (annotDepth > 0 && fn !== O.save && fn !== O.restore && fn !== O.transform) continue;
    if (fn === O.save) stack.push({ ctm, fillColor });
    else if (fn === O.restore) {
      const s = stack.pop();
      if (s) ({ ctm, fillColor } = s);
    } else if (fn === O.transform) ctm = mul(ctm, args);
    else if (fn === O.paintFormXObjectBegin) {
      stack.push({ ctm, fillColor });
      if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
    } else if (fn === O.paintFormXObjectEnd) {
      const s = stack.pop();
      if (s) ({ ctm, fillColor } = s);
    } else if (fn === O.setFillRGBColor || fn === O.setFillGray || fn === O.setFillColor || fn === O.setFillCMYKColor) {
      fillColor = args?.length === 1 ? args[0] : args;
    } else if (IMAGE_OPS.has(fn)) {
      const r = toView(0, 0, 1, 1);
      if ((r.right - r.left) * (r.bottom - r.top) >= MIN_FIGURE_AREA) figures.push(r);
    } else if (fn === O.constructPath) {
      const op = args?.[0];
      const mm = args?.[2];
      if (!mm || mm.length < 4 || !Number.isFinite(mm[0])) continue;
      const fill = FILL_OPS.has(op);
      if (!fill && !STROKE_OPS.has(op)) continue;
      if (fill && isWhite(fillColor)) continue;
      const r = toView(mm[0], mm[1], mm[2], mm[3]);
      const w = r.right - r.left;
      const h = r.bottom - r.top;
      let t = "path";
      if (h <= MAX_RULE_THICKNESS && w >= MIN_BOX_SIDE) {
        rules.push(r);
        t = "rule";
      } else if (w >= MIN_BOX_SIDE && h >= MIN_BOX_SIDE) {
        boxes.push({ ...r, fill });
        t = "box";
      }
      // ページ全体を囲む枠や背景は，まとまりに入れない
      if (w * h < 0.6) paths.push({ ...r, t });
    }
  }
  return { figures, boxes, rules, paths };
}
