// 開発用：PDF のページの構造（web/pdfjs/page-structure.mjs の見分け）を一覧にする．
// 使い方：node tools/dump-structure.mjs <file.pdf> [--band 12] [--tol 6] [--pages 1-3]
// vendor/ の pdf.js（tools/fetch_pdfjs.py で取ってくる）を Node で読み込んで，getTextContent の結果を渡す．
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { analyzeDocument } from "../web/pdfjs/page-structure.mjs";
import { graphicsFromOperatorList } from "../web/pdfjs/page-graphics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "vendor", "pdfjs-6.5.438-dist");

function parseArgs(argv) {
  const out = { file: null, band: 12, tol: 6, from: 1, to: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--band") out.band = Number(argv[++i]);
    else if (a === "--tol") out.tol = Number(argv[++i]);
    else if (a === "--pages") {
      const [f, t] = String(argv[++i]).split("-");
      out.from = Number(f) || 1;
      out.to = t === undefined ? out.from : Number(t) || Infinity;
    } else if (!out.file) out.file = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error("usage: node tools/dump-structure.mjs <file.pdf> [--band 12] [--tol 6] [--pages 1-3]");
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, "build", "pdf.mjs"))) {
  console.error(`pdf.js が見つからない：${dist}（python tools/fetch_pdfjs.py で取ってくる）`);
  process.exit(1);
}

const pdfjs = await import(pathToFileURL(path.join(dist, "build", "pdf.mjs")).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dist, "build", "pdf.worker.mjs")).href;
// Node の pdf.js は CMap と標準フォントを fs.readFile で読むので，file:// の URL ではなくパスを渡す
// （URL を渡すと読めず，埋め込みのない日本語のフォントの文字が 0 件になる）．区切りは / にする（末尾の / が要る）
const dirUrl = (p) => path.join(dist, p).split(path.sep).join("/") + "/";

const data = new Uint8Array(fs.readFileSync(args.file));
const task = pdfjs.getDocument({
  data,
  cMapUrl: dirUrl("web/cmaps"),
  cMapPacked: true,
  standardFontDataUrl: dirUrl("web/standard_fonts"),
  isEvalSupported: false,
  verbosity: 0,
});
const doc = await task.promise;

const pages = [];
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  // 図（画像）と箱（塗った・囲んだ矩形）：アプリと同じく，描画の命令から集める
  const g = graphicsFromOperatorList(await page.getOperatorList(), page.getViewport({ scale: 1 }), pdfjs.OPS);
  pages.push({ view: page.view, rotate: page.rotate, items: tc.items, styles: tc.styles, ...g });
}

const t0 = performance.now();
const result = analyzeDocument(pages, { furnitureBand: args.band, sizeTolerance: args.tol });
const ms = performance.now() - t0;

console.log(`${path.basename(args.file)}: ${doc.numPages} pages, bodySize ${result.bodySize}, analysis ${ms.toFixed(1)} ms`);
const mark = { body: "B", auxiliary: "A", excluded: "X" };
result.pages.forEach((pa, pi) => {
  if (!pa || pi + 1 < args.from || pi + 1 > args.to) return;
  // span の番号 → 文字
  const strs = pages[pi].items.filter((it) => it.str !== undefined && it.str !== "").map((it) => it.str);
  console.log(`\n--- page ${pi + 1} (${pa.blocks.length} blocks, ${pa.lines.length} lines) ---`);
  for (const b of pa.blocks) {
    const ls = b.lines.map((i) => pa.lines[i]);
    const text = ls
      .map((l) => l.items.map((k) => strs[k]).join(""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const top = Math.min(...ls.map((l) => l.top));
    const left = Math.min(...ls.map((l) => l.left));
    const tag = `${mark[b.class]} ${(b.kind ?? "").padEnd(10)}`;
    const pos = `y${top.toFixed(2)} x${left.toFixed(2)} ${String(b.lines.length).padStart(2)}L ${b.size.toFixed(1).padStart(5)}`;
    console.log(`${tag} ${pos}  ${text.slice(0, 60)}`);
  }
});
await task.destroy();
