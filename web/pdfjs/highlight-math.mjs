// PDF TransNote：ハイライトの計算（pdf.js にも画面にも触れない．node --test で確かめられる）
// ===========================================================================
// bridge.js が使う．pdf.js が出すデータ（注釈の quadPoints，文字の位置）を受け取って計算するだけ．

/** ハイライトを画面に重ねるときの不透明度（Zotero の reader と同じ．src/pdf/page.js の _pushHighlight）． */
export const HIGHLIGHT_OPACITY = 0.4;

const hex2 = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");

/**
 * 不透明度 alpha 付きの色を，白に寄せた不透明な色にする（Zotero が外部の注釈を取り込むときと同じ式．
 * document-worker の src/pdf/annotations/read.js）．alpha が 1 以上か数でなければ，色はそのまま．
 * @param {string} hex "#rrggbb"
 * @param {number} alpha 注釈の /CA
 * @returns {string} "#rrggbb"
 */
export function blendOpacity(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? "").trim());
  if (!m) return hex;
  const rgb = m.slice(1).map((h) => parseInt(h, 16));
  if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha >= 1) return `#${rgb.map(hex2).join("")}`;
  const a = Math.max(0.1, alpha); // 見えなくならないように（Zotero と同じ）
  return `#${rgb.map((c) => hex2(a * c + (1 - a) * 255)).join("")}`;
}

/**
 * quadPoints（8 個ずつ：4 つの角の x, y．PDF の座標）を，角を包む矩形の並びにする．
 * @returns {{x1: number, y1: number, x2: number, y2: number}[]}
 */
export function quadsToRects(quadPoints) {
  const out = [];
  if (!quadPoints) return out;
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]];
    const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]];
    out.push({ x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) });
  }
  return out;
}

/**
 * 文字の位置（pdf.js の getTextContent の items）から，quadPoints の中にある文字を取り出す．
 * 1 つの item の中では文字の幅を等しいと見なし，各文字の中心（行の高さの 35% の所）が矩形の中にあるかで判定する．
 * 行が変わったところには改行を入れる（後で cleanSource が整える）．
 * @param {{str?: string, transform: number[], width: number, height: number}[]} items
 * @param {ArrayLike<number>} quadPoints
 * @param {number} [tol] 矩形を広げる量（PDF の単位）
 */
export function textInQuads(items, quadPoints, tol = 1) {
  const rects = quadsToRects(quadPoints);
  if (!rects.length || !items?.length) return "";
  const hit = (x, y) => rects.some((r) => x >= r.x1 - tol && x <= r.x2 + tol && y >= r.y1 - tol && y <= r.y2 + tol);
  let out = "";
  let lastLine = null;
  for (const it of items) {
    const str = it?.str;
    if (typeof str !== "string" || !str || !it.transform) continue;
    const [a, b, c, d, e, f] = it.transform;
    const len = Math.hypot(a, b) || 1;
    const ux = a / len; // 文字の進む向き
    const uy = b / len;
    const vx = -uy; // 行の上の向き
    const vy = ux;
    const h = it.height || Math.hypot(c, d) || 0;
    const n = str.length;
    let piece = "";
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) / n) * (it.width || 0);
      const x = e + ux * t + vx * h * 0.35;
      const y = f + uy * t + vy * h * 0.35;
      if (hit(x, y)) piece += str[k];
    }
    if (!piece) continue;
    const line = e * vx + f * vy; // 行の位置（上の向きに測る）
    if (lastLine !== null && Math.abs(line - lastLine) > Math.max(h, 1) * 0.5) out += "\n";
    out += piece;
    lastLine = line;
  }
  return out;
}

/**
 * サイドバーに並べる順：ページ，ページの中では上から下，同じ行（高さの差が 0.5% 未満）なら左から右．
 * @param {{pageIndex: number, top: number, left: number}} a
 * @param {{pageIndex: number, top: number, left: number}} b
 */
export function compareHighlights(a, b) {
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
  if (Math.abs(a.top - b.top) >= 0.005) return a.top - b.top;
  return a.left - b.left;
}
