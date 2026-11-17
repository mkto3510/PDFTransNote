// web/pdfjs/page-structure.mjs（本文・補助・除外の見分けと，選んだ範囲の絞り込み）の確かめ．実行：node --test tests/
import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDocument,
  DEFAULT_OPTIONS,
  endsWithEquationNumber,
  filterSelection,
  isPageNumberText,
  matchCaption,
} from "../web/pdfjs/page-structure.mjs";

// --- pdf.js の getTextContent に似た item を作る（ページは 612×792，y は上向き） ---
const STYLES = {
  F1: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: "sans-serif" },
  V1: { ascent: 0.8, descent: -0.2, vertical: true, fontFamily: "serif" },
};
const t = (str, x, y, fs = 10, extra = {}) => ({
  str,
  dir: "ltr",
  transform: [fs, 0, 0, fs, x, y],
  width: 0.5 * fs * str.length,
  height: fs,
  fontName: "F1",
  hasEOL: false,
  ...extra,
});
const page = (items, extra = {}) => ({ view: [0, 0, 612, 792], rotate: 0, items, styles: STYLES, ...extra });
const LOREM = "the quick brown fox jumps over the lazy dog while the model reads every line of the page text";
/** 本文の段落：(x, y) から pitch ずつ下へ n 行 */
const para = (n, { x = 72, y = 680, fs = 10, pitch = 12, text = LOREM, first } = {}) =>
  Array.from({ length: n }, (_, i) => t(i === 0 && first ? first : text, x, y - i * pitch, fs));
/** item の str（span の番号順）から，その span の番号を探す */
const spanOf = (pg, str) => pg.items.filter((it) => it.str !== undefined && it.str !== "").findIndex((it) => it.str === str);
const kindOf = (result, pageIndex, pg, str) => {
  const k = spanOf(pg, str);
  assert.ok(k >= 0, `span not found: ${str}`);
  return [result.pages[pageIndex].classes[k], result.pages[pageIndex].kinds[k]];
};

test("DEFAULT_OPTIONS", () => {
  assert.deepEqual(DEFAULT_OPTIONS, {
    skipFurniture: true,
    furnitureBand: 12,
    skipCaptions: true,
    skipSmallText: true,
    sizeTolerance: 6,
  });
});

test("span の番号：marked content の目印と空の item を数えない．空白だけの item は数える", () => {
  const pg = page([
    { type: "beginMarkedContentProps", tag: "P", id: "p1" },
    t("Alpha", 72, 680),
    t("", 100, 680),
    { type: "endMarkedContent" },
    t(" ", 97, 680),
    { type: "beginMarkedContent", tag: "Span" },
    t("Beta", 102, 680),
    { type: "endMarkedContent" },
    ...para(5, { y: 668 }),
  ]);
  const r = analyzeDocument([pg]);
  const p = r.pages[0];
  assert.equal(p.classes.length, 8); // Alpha，空白，Beta，5 行
  assert.equal(p.kinds.length, 8);
  assert.deepEqual(p.lines[0].items, [0, 1, 2]);
  assert.equal(p.lineOf[2], 0);
  assert.deepEqual(p.lines[1].items, [3]);
  // 表示の座標（0〜1，y は下向き）
  assert.ok(p.lines[0].top < p.lines[1].top);
  assert.ok(p.lines[0].left > 0.11 && p.lines[0].left < 0.12);
  assert.equal(r.bodySize, 10);
});

test("読んでいないページは null のまま", () => {
  const r = analyzeDocument([null, page(para(3)), null]);
  assert.equal(r.pages[0], null);
  assert.equal(r.pages[2], null);
  assert.ok(r.pages[1]);
});

// --- 柱とページ番号 ---
const HEADER = "Journal of Synthetic Tests, Vol. 7";
function furnitureDoc(n, { header = () => HEADER, number = (i) => String(i + 1), extra = () => [] } = {}) {
  return Array.from({ length: n }, (_, i) =>
    page([t(header(i), 72, 750), ...para(30), t(number(i), 300, 40), ...extra(i)]),
  );
}

test("柱：十分な数のページで同じ位置に出る見出しは除外（furniture）", () => {
  const doc = furnitureDoc(10);
  const r = analyzeDocument(doc);
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(kindOf(r, i, doc[i], HEADER), ["excluded", "furniture"]);
    assert.deepEqual(kindOf(r, i, doc[i], String(i + 1)), ["excluded", "pageNumber"]);
    assert.deepEqual(kindOf(r, i, doc[i], LOREM), ["body", null]);
  }
});

test("柱：奇数・偶数のページで違う見出しも，それぞれ数える", () => {
  const doc = furnitureDoc(10, { header: (i) => (i % 2 ? "Author One and Author Two" : "A Study of Page Furniture") });
  const r = analyzeDocument(doc);
  for (let i = 0; i < 10; i++) {
    const h = i % 2 ? "Author One and Author Two" : "A Study of Page Furniture";
    assert.deepEqual(kindOf(r, i, doc[i], h), ["excluded", "furniture"]);
  }
});

test("柱：数字だけ違う見出し（ページ番号入り）も，数字を # にした鍵で数える", () => {
  const doc = furnitureDoc(10, { header: (i) => `Proceedings of the Workshop, pages ${100 + i}` });
  const r = analyzeDocument(doc);
  assert.deepEqual(kindOf(r, 4, doc[4], "Proceedings of the Workshop, pages 104"), ["excluded", "furniture"]);
});

test("柱：10 ページのうち 1 ページにしか出ない帯の中の行は本文のまま", () => {
  const doc = furnitureDoc(10, { extra: (i) => (i === 3 ? [t("Special Issue Announcement", 72, 720)] : []) });
  const r = analyzeDocument(doc);
  assert.deepEqual(kindOf(r, 3, doc[3], "Special Issue Announcement"), ["body", null]);
  assert.deepEqual(kindOf(r, 3, doc[3], HEADER), ["excluded", "furniture"]);
});

test("柱：帯の高さ（furnitureBand）の外なら柱にしない", () => {
  const doc = furnitureDoc(10);
  const r = analyzeDocument(doc, { furnitureBand: 3 });
  assert.deepEqual(kindOf(r, 0, doc[0], HEADER), ["body", null]);
});

test("ページ番号：帯の中の「12」「- 3 -」「xii」「Page 4 of 10」は除外，ページの中ほどの数字は本文", () => {
  const nums = ["12", "- 3 -", "xii", "Page 4 of 10"];
  const doc = nums.map((s, i) =>
    page([...para(20), t("42", 300, 400), ...para(10, { y: 370 }), t(s, 290, i % 2 ? 40 : 760)]),
  );
  const r = analyzeDocument(doc);
  doc.forEach((pg, i) => {
    assert.deepEqual(kindOf(r, i, pg, nums[i]), ["excluded", "pageNumber"], nums[i]);
    assert.deepEqual(kindOf(r, i, pg, "42"), ["body", null]);
  });
});

test("3 ページ未満の文書：繰り返しの判定はしないが，ページ番号は除外する", () => {
  const doc = furnitureDoc(2);
  const r = analyzeDocument(doc);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(kindOf(r, i, doc[i], HEADER), ["body", null]);
    assert.deepEqual(kindOf(r, i, doc[i], String(i + 1)), ["excluded", "pageNumber"]);
  }
});

test("Artifact の中の文字は除外（入れ子も数える）", () => {
  const pg = page([
    ...para(10),
    { type: "beginMarkedContent", tag: "Artifact" },
    t("Downloaded from example.org on 1 Jan", 72, 500),
    { type: "beginMarkedContentProps", tag: "Span", id: "s1" },
    t("by a reader", 260, 500),
    { type: "endMarkedContent" },
    t(" ", 255, 500),
    { type: "endMarkedContent" },
    t("after the artifact", 72, 470),
  ]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "Downloaded from example.org on 1 Jan"), ["excluded", "artifact"]);
  assert.deepEqual(kindOf(r, 0, pg, "by a reader"), ["excluded", "artifact"]);
  assert.deepEqual(kindOf(r, 0, pg, " "), ["excluded", "artifact"]);
  assert.deepEqual(kindOf(r, 0, pg, "after the artifact"), ["body", null]);
});

// --- キャプション ---
test("matchCaption：strict・loose・形でないもの", () => {
  for (const s of ["Figure 3: Overview", "Fig. 2. Results", "TABLE I", "Table 2", "図 1．システムの構成", "表2：結果",
    "Figure S1. Extra", "Fig. 3a: Detail", "Table 1.2 — Values", "Supplementary Figure 4: More", "Algorithm 1 |",
    "第1図．調査地域の地質図", "第 2 表：試料の一覧", "第3-1図. 断面"]) {
    assert.equal(matchCaption(s), "strict", s);
  }
  for (const s of ["Fig. 1 Overview of the pipeline", "Figure 3 shows that the model", "図１　調査地域の地質図", "第1図　調査地域の地質図",
    "図 3.10 つくばと水沢の観測点の位置", "表 4 とかち平野の試料"]) {
    assert.equal(matchCaption(s), "loose", s);
  }
  // 図・表の番号の後が助詞なら本文（「図 1 に示す」）
  for (const s of ["Figures 3 and 4 show", "Table of Contents", "Tablet 3", "Table Iteration counts", "In Figure 3: x",
    "図1は構成を示す", "図 2 に示すように", "表3の値は", "図 5 のように", "第1図に示すように", "第 2 表の結果から", "図 6 では"]) {
    assert.equal(matchCaption(s), null, s);
  }
});

test("キャプション（strict）：本文と同じ大きさでも補助（caption）", () => {
  const caps = ["Figure 3: Overview of the system.", "Fig. 2. Results on the test set.", "TABLE I", "図 1．システムの構成", "表2：結果の一覧"];
  const doc = caps.map((c) => page([...para(10), t(c, 72, 540), ...para(10, { y: 500 })]));
  const r = analyzeDocument(doc);
  doc.forEach((pg, i) => {
    assert.deepEqual(kindOf(r, i, pg, caps[i]), ["auxiliary", "caption"], caps[i]);
    assert.deepEqual(kindOf(r, i, pg, LOREM), ["body", null]);
  });
});

test("キャプション：2 行目以降も同じ段落として補助になる", () => {
  const pg = page([...para(10), t("Figure 3: Overview of the system and of the", 72, 540), t("way the pieces fit together.", 72, 528), ...para(10, { y: 490 })]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "way the pieces fit together."), ["auxiliary", "caption"]);
});

test("本文の「Figure 3 shows that …」は本文（段落の頭でも途中でも）", () => {
  const pg = page([
    ...para(10),
    ...para(5, { y: 540, first: "Figure 3 shows that the quick brown fox jumps over the lazy dog while the model reads it" }),
    t("as seen in", 72, 480),
    t("Fig. 3. The quick brown fox jumps over the lazy dog while the model reads every line of it", 72, 468),
    ...para(4, { y: 456 }),
  ]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "Figure 3 shows that the quick brown fox jumps over the lazy dog while the model reads it"), ["body", null]);
  assert.deepEqual(kindOf(r, 0, pg, "Fig. 3. The quick brown fox jumps over the lazy dog while the model reads every line of it"), ["body", null]);
});

test("キャプション（loose）：「Fig. 1 Title」は本文より小さければキャプション", () => {
  const pg = page([
    ...para(10),
    t("Fig. 1 Overview of the pipeline used in all of the experiments in this paper", 72, 540, 8),
    t("and the data flow between the stages", 72, 530, 8),
    ...para(10, { y: 500 }),
  ]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "and the data flow between the stages"), ["auxiliary", "caption"]);
});

test("キャプション（loose）：本文の大きさでも，幅が狭いか中央にあればキャプション", () => {
  const pg = page([...para(10), t("Fig. 4 The setup", 260, 540), ...para(10, { y: 500 })]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "Fig. 4 The setup"), ["auxiliary", "caption"]);
});

test("キャプションの形でも，前の本文の行がハイフンで終わるならキャプションにしない", () => {
  const cont = page([
    ...para(10),
    t("the quick brown fox jumps over the lazy dog and so the trans-", 72, 560),
    t("Table 2: lation of the next line continues the paragraph here", 72, 548),
    ...para(4, { y: 536 }),
  ]);
  const gap = page([
    ...para(10),
    t("the quick brown fox jumps over the lazy dog and so the trans-", 72, 560),
    t("Figure 2: lation continues after a large gap in the layout", 72, 520),
    ...para(4, { y: 490 }),
  ]);
  const r = analyzeDocument([cont, gap]);
  assert.deepEqual(kindOf(r, 0, cont, "Table 2: lation of the next line continues the paragraph here"), ["body", null]);
  assert.deepEqual(kindOf(r, 1, gap, "Figure 2: lation continues after a large gap in the layout"), ["body", null]);
});

// --- 小さい文字，回転した文字 ---
test("脚注（本文 10，脚注 8）は補助（small）", () => {
  const pg = page([...para(30), t("1 The footnote text explains a detail of the method in a smaller font size.", 72, 110, 8), t("It continues on a second line.", 72, 100, 8)]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "It continues on a second line."), ["auxiliary", "small"]);
  assert.deepEqual(kindOf(r, 0, pg, LOREM), ["body", null]);
});

test("上付き文字ばかりの行も，段落の中なら本文", () => {
  const pg = page([
    ...para(5),
    t("a", 72, 620),
    t("12345678901234567890", 80, 623, 7),
    t("b", 160, 620),
    ...para(5, { y: 608 }),
  ]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "12345678901234567890"), ["body", null]);
  assert.equal(r.pages[0].blocks.length, 1);
});

test("式番号「(12)」で終わる行は，文字が小さくても本文．番号がなければ小さい文字", () => {
  const mk = (num) => [t("alpha beta gamma delta epsilon zeta eta", 150, 540, 7), ...(num ? [t("(12)", 500, 540)] : [])];
  const withNum = page([...para(10), ...mk(true), ...para(10, { y: 510 })]);
  const without = page([...para(10), ...mk(false), ...para(10, { y: 510 })]);
  const r = analyzeDocument([withNum, without]);
  assert.deepEqual(kindOf(r, 0, withNum, "alpha beta gamma delta epsilon zeta eta"), ["body", null]);
  assert.deepEqual(kindOf(r, 1, without, "alpha beta gamma delta epsilon zeta eta"), ["auxiliary", "small"]);
});

test("本文より大きい見出しは本文", () => {
  const pg = page([...para(10), t("2. Related Work", 72, 540, 14), ...para(10, { y: 515 })]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "2. Related Work"), ["body", null]);
});

test("回転した文字（arXiv の余白の印）は補助（rotated）", () => {
  const stamp = { ...t("arXiv:2101.00001v1 [cs.CL] 1 Jan 2021", 30, 250), transform: [0, 10, -10, 0, 30, 250] };
  const pg = page([...para(30), stamp]);
  const r = analyzeDocument([pg]);
  assert.deepEqual(kindOf(r, 0, pg, "arXiv:2101.00001v1 [cs.CL] 1 Jan 2021"), ["auxiliary", "rotated"]);
});

test("縦書きの本文（文字がすべて回転している）は本文のまま", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    ...t("縦書きの本文がこのように続いていく", 500 - i * 14, 720),
    fontName: "V1",
    width: 10,
    height: 170,
  }));
  const pg = page(items);
  const r = analyzeDocument([pg]);
  assert.ok(r.pages[0].classes.every((c) => c === "body"));
});

test("ページの回転（rotate 90）：表示の座標で見る", () => {
  // 横向きのページ：PDF の座標で 90° 回した文字は，表示ではまっすぐになる
  const items = Array.from({ length: 10 }, (_, i) => ({
    ...t(LOREM, 100 + i * 12, 72),
    transform: [0, 10, -10, 0, 100 + i * 12, 72],
  }));
  const pg = page(items, { rotate: 90 });
  const r = analyzeDocument([pg]);
  assert.ok(r.pages[0].classes.every((c) => c === "body"));
  // 回すと，PDF の左下（x が小さい）は表示の左上の近く
  assert.ok(r.pages[0].lines[0].top < 0.2);
});

test("二段組：段の変わり目（上へ戻る）で段落を分ける", () => {
  const COL = "short column line of text here";
  const pg = page([...para(40, { text: COL }), ...para(40, { x: 320, text: COL })]);
  const r = analyzeDocument([pg]);
  const p = r.pages[0];
  const blockOfLine = new Map();
  p.blocks.forEach((b, bi) => b.lines.forEach((li) => blockOfLine.set(li, bi)));
  assert.equal(p.lines.length, 80);
  assert.notEqual(blockOfLine.get(39), blockOfLine.get(40));
  assert.equal(blockOfLine.get(0), blockOfLine.get(39));
});

test("isPageNumberText・endsWithEquationNumber", () => {
  for (const s of ["12", "- 12 -", "– 12 –", "xii", "XII", "Page 12", "p. 12", "12 of 30", "12 / 30", "12 ページ"]) {
    assert.ok(isPageNumberText(s), s);
  }
  for (const s of ["Section 12", "civil", "12 apples", "1.5"]) assert.ok(!isPageNumberText(s), s);
  for (const s of ["E = mc^2 (12)", "x (3.4)", "y (2a)"]) assert.ok(endsWithEquationNumber(s), s);
  assert.ok(!endsWithEquationNumber("published in (2019)"));
});

// --- 選んだ範囲の絞り込み ---
const CLASS_OF = { artifact: "excluded", furniture: "excluded", pageNumber: "excluded", caption: "auxiliary", small: "auxiliary", rotated: "auxiliary" };
/** ページごとの kinds（span の順）から，analyzeDocument の結果に似たものを作る．lines は span ごとの行の番号． */
const mock = (...pagesSpec) => ({
  bodySize: 10,
  pages: pagesSpec.map((spec) =>
    spec && {
      kinds: spec.kinds,
      classes: spec.kinds.map((k) => (k ? CLASS_OF[k] : "body")),
      lineOf: spec.lines ?? spec.kinds.map((_, i) => i),
    },
  ),
});
const piece = (pageIndex, spanIndex, text) => ({ pageIndex, spanIndex, text });

test("filterSelection：本文…柱・ページ番号・次の柱…本文 → 柱を落とし，ページごとにまとめる", () => {
  const a = mock({ kinds: [null, null, "furniture", "pageNumber"], lines: [0, 1, 2, 3] }, { kinds: ["furniture", null] });
  const pieces = [
    piece(0, 0, "end of the"),
    piece(0, 1, "page"),
    piece(0, 2, "Journal of Tests"),
    piece(0, 3, "12"),
    piece(1, 0, "Running Head"),
    piece(1, 1, "next page"),
  ];
  const r = filterSelection(pieces, a);
  assert.deepEqual(r.keep, [true, true, false, false, false, true]);
  assert.deepEqual(r.removed, [
    { kind: "furniture", pageIndex: 0, text: "Journal of Tests 12" },
    { kind: "furniture", pageIndex: 1, text: "Running Head" },
  ]);
});

test("filterSelection：同じ行の span はそのままつなぐ", () => {
  const a = mock({ kinds: [null, "caption", "caption", "caption", null], lines: [0, 1, 1, 1, 2] });
  const r = filterSelection([piece(0, 0, "a"), piece(0, 1, "Fig"), piece(0, 2, "ure 3:"), piece(0, 3, " Over\nview "), piece(0, 4, "b")], a);
  assert.deepEqual(r.keep, [true, false, false, false, true]);
  assert.deepEqual(r.removed, [{ kind: "caption", pageIndex: 0, text: "Figure 3: Over view" }]);
});

test("filterSelection：本文…キャプション…本文 → キャプションを落とす", () => {
  const a = mock({ kinds: [null, "caption", "caption", null, "small", null] });
  const r = filterSelection([piece(0, 0, "x"), piece(0, 1, "Figure 1:"), piece(0, 2, "Title"), piece(0, 3, "y"), piece(0, 4, "foot"), piece(0, 5, "z")], a);
  assert.deepEqual(r.keep, [true, false, false, true, false, true]);
  assert.deepEqual(r.removed, [
    { kind: "caption", pageIndex: 0, text: "Figure 1: Title" },
    { kind: "small", pageIndex: 0, text: "foot" },
  ]);
});

test("filterSelection：キャプションだけを選んだら残す", () => {
  const a = mock({ kinds: [null, "caption", "caption", null] });
  const r = filterSelection([piece(0, 1, "Figure 1:"), piece(0, 2, "Title")], a);
  assert.deepEqual(r.keep, [true, true]);
  assert.deepEqual(r.removed, []);
});

test("filterSelection：本文で始まりキャプションの中で終わるなら残す", () => {
  const a = mock({ kinds: [null, null, "caption", "caption"] });
  const r = filterSelection([piece(0, 0, "body"), piece(0, 1, "text"), piece(0, 2, "Figure 1:"), piece(0, 3, "Title")], a);
  assert.deepEqual(r.keep, [true, true, true, true]);
});

test("filterSelection：次のページの柱で終わる・柱から始まる → 端の柱を落とす", () => {
  const a = mock({ kinds: ["furniture", null, null] }, { kinds: ["furniture", "pageNumber", null] });
  const end = filterSelection([piece(0, 1, "last"), piece(0, 2, "line"), piece(1, 0, "Running Head"), piece(1, 1, " ")], a);
  assert.deepEqual(end.keep, [true, true, false, false]);
  assert.deepEqual(end.removed, [{ kind: "furniture", pageIndex: 1, text: "Running Head" }]);
  const start = filterSelection([piece(0, 0, "Running Head"), piece(0, 1, "first"), piece(0, 2, "line")], a);
  assert.deepEqual(start.keep, [false, true, true]);
});

test("filterSelection：柱だけ・本文のない範囲は残す", () => {
  const a = mock({ kinds: ["furniture", "pageNumber", "caption"] });
  assert.deepEqual(filterSelection([piece(0, 0, "Running Head"), piece(0, 1, "12")], a).keep, [true, true]);
  assert.deepEqual(filterSelection([piece(0, 2, "Figure 1"), piece(0, 0, "Running Head")], a).keep, [true, true]);
});

test("filterSelection：設定で外した種類は本文として残す", () => {
  const a = mock({ kinds: [null, "furniture", "caption", "small", "rotated", "artifact", null] });
  const pieces = [0, 1, 2, 3, 4, 5, 6].map((k) => piece(0, k, `s${k}`));
  assert.deepEqual(filterSelection(pieces, a).keep, [true, false, false, false, false, false, true]);
  const off = { skipFurniture: false, skipCaptions: false, skipSmallText: false };
  assert.deepEqual(filterSelection(pieces, a, off).keep, [true, true, true, true, true, true, true]);
  assert.deepEqual(filterSelection(pieces, a, { skipCaptions: false }).keep, [true, false, true, false, false, false, true]);
});

test("filterSelection：分け方の分からないもの（ページ未解析，spanIndex -1）は本文", () => {
  const a = mock(null, { kinds: [null, "caption"] });
  const r = filterSelection([piece(0, 3, "unknown"), piece(1, -1, "no span"), piece(1, 1, "Fig. 1"), piece(1, 0, "x")], a);
  assert.deepEqual(r.keep, [true, true, false, true]);
  assert.deepEqual(filterSelection([piece(0, 0, "a")], null).keep, [true]);
  assert.deepEqual(filterSelection([], a), { keep: [], removed: [] });
});

test("filterSelection：ページをまたぐハイフンの語（transla- … tion）は両側を残す", () => {
  const a = mock({ kinds: [null, "small", "pageNumber"] }, { kinds: ["furniture", null] });
  const pieces = [piece(0, 0, "transla-\n"), piece(0, 1, "1 A footnote."), piece(0, 2, "5"), piece(1, 0, "Short Title"), piece(1, 1, "tion")];
  const r = filterSelection(pieces, a);
  assert.deepEqual(r.keep, [true, false, false, false, true]);
  assert.deepEqual(r.removed.map((x) => x.kind), ["small", "furniture", "furniture"]);
});

test("analyzeDocument と filterSelection：ページをまたいで選ぶと柱とページ番号が落ちる", () => {
  const doc = furnitureDoc(10);
  const r = analyzeDocument(doc);
  const spans = (pg) => pg.items.filter((it) => it.str !== undefined && it.str !== "");
  const p0 = spans(doc[0]);
  const p1 = spans(doc[1]);
  // 1 ページ目の最後の 2 行 → ページ番号 → 2 ページ目の柱 → 最初の 2 行
  const pieces = [
    ...[29, 30].map((k) => piece(0, k, p0[k].str)),
    piece(0, 31, p0[31].str),
    piece(1, 0, p1[0].str),
    ...[1, 2].map((k) => piece(1, k, p1[k].str)),
  ];
  const f = filterSelection(pieces, r);
  assert.deepEqual(f.keep, [true, true, false, false, true, true]);
  assert.deepEqual(f.removed, [
    { kind: "furniture", pageIndex: 0, text: "1" },
    { kind: "furniture", pageIndex: 1, text: HEADER },
  ]);
});

test("同じページの入力で呼び直しても結果は変わらない（下ごしらえを覚えている）", () => {
  const doc = furnitureDoc(10);
  const a = analyzeDocument(doc);
  const b = analyzeDocument(doc);
  assert.deepEqual(a, b);
  // ページを読み足すと本文の大きさが変わりうる
  const partial = analyzeDocument([doc[0], null, null]);
  assert.equal(partial.bodySize, 10);
});

test("数百ページでも速い", () => {
  const doc = furnitureDoc(300);
  const t0 = performance.now();
  analyzeDocument(doc);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  analyzeDocument(doc);
  const warm = performance.now() - t1;
  assert.ok(cold < 2000, `cold ${cold} ms`);
  assert.ok(warm < 1000, `warm ${warm} ms`);
});
