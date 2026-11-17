// web/pdfjs/highlight-math.mjs（ハイライトの色・範囲の文字・並べ方）の確かめ
import assert from "node:assert/strict";
import test from "node:test";
import { blendOpacity, compareHighlights, HIGHLIGHT_OPACITY, quadsToRects, textInQuads } from "../web/pdfjs/highlight-math.mjs";

test("blendOpacity：不透明（/CA が 1 か，ない）なら色はそのまま", () => {
  assert.equal(blendOpacity("#ffd400", 1), "#ffd400");
  assert.equal(blendOpacity("#FF6666", undefined), "#ff6666");
  assert.equal(blendOpacity("#2ea8e5", NaN), "#2ea8e5");
});

test("blendOpacity：Zotero の取り込みと同じく，白に寄せる（alpha*c + (1-alpha)*255）", () => {
  // #000000 を 0.5 → 127.5 → 128（0x80）
  assert.equal(blendOpacity("#000000", 0.5), "#808080");
  // #ff0000 を 0.4 → r=255, g=b=0.6*255=153（0x99）
  assert.equal(blendOpacity("#ff0000", 0.4), "#ff9999");
  // 0.1 より薄くはしない（見えなくならないように）
  assert.equal(blendOpacity("#000000", 0), blendOpacity("#000000", 0.1));
});

test("blendOpacity：色として読めなければそのまま返す", () => {
  assert.equal(blendOpacity("red", 0.5), "red");
});

test("HIGHLIGHT_OPACITY は Zotero の画面と同じ 0.4", () => {
  assert.equal(HIGHLIGHT_OPACITY, 0.4);
});

test("quadsToRects：4 つの角を包む矩形にする（8 個ずつ）", () => {
  const q = [10, 20, 50, 20, 10, 8, 50, 8, 0, 0, 5, 0, 0, -3, 5, -3];
  assert.deepEqual(quadsToRects(q), [
    { x1: 10, y1: 8, x2: 50, y2: 20 },
    { x1: 0, y1: -3, x2: 5, y2: 0 },
  ]);
  assert.deepEqual(quadsToRects(null), []);
});

// 横書き：x は 100 から，1 文字 10 の幅，基準線 y=700，高さ 10
const item = (str, x, y, h = 10) => ({ str, transform: [h, 0, 0, h, x, y], width: str.length * 10, height: h });
// 矩形（x1..x2, y1..y2）の quadPoints（左上，右上，左下，右下）
const quad = (x1, y1, x2, y2) => [x1, y2, x2, y2, x1, y1, x2, y1];

test("textInQuads：矩形の中にある文字だけを取り出す", () => {
  const items = [item("Hello world", 100, 700)];
  // "world" は 160..210
  assert.equal(textInQuads(items, quad(158, 698, 212, 711)), "world");
  // 行の外（下の行）は拾わない
  assert.equal(textInQuads(items, quad(100, 680, 300, 690)), "");
});

test("textInQuads：行が変わったところに改行を入れる", () => {
  const items = [item("first line", 100, 700), item(" ", 200, 700), item("second", 100, 686)];
  const q = [...quad(100, 698, 200, 711), ...quad(100, 684, 160, 697)];
  assert.equal(textInQuads(items, q), "first line\nsecond");
});

test("textInQuads：文字のない item や空の入力は飛ばす", () => {
  assert.equal(textInQuads([{ type: "beginMarkedContent" }, item("abc", 0, 0)], quad(-1, -1, 31, 11)), "abc");
  assert.equal(textInQuads([], quad(0, 0, 1, 1)), "");
  assert.equal(textInQuads([item("abc", 0, 0)], []), "");
});

test("compareHighlights：ページ → 上から下 → 同じ行なら左から右", () => {
  const list = [
    { pageIndex: 1, top: 0.1, left: 0.1, n: "p2" },
    { pageIndex: 0, top: 0.5, left: 0.1, n: "low" },
    { pageIndex: 0, top: 0.2, left: 0.6, n: "right" },
    { pageIndex: 0, top: 0.202, left: 0.1, n: "left" },
  ];
  assert.deepEqual(
    list.sort(compareHighlights).map((x) => x.n),
    ["left", "right", "low", "p2"],
  );
});
