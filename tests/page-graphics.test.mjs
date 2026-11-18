import assert from "node:assert/strict";
import { test } from "node:test";
import { graphicsFromOperatorList } from "../web/pdfjs/page-graphics.mjs";

test("近接した描画をまとめ，重複するパスの数も保持する", () => {
  const OPS = { constructPath: 1, stroke: 2 };
  const viewport = { width: 600, height: 800, convertToViewportPoint: (x, y) => [x, y] };
  const samePaths = Array(20_000).fill([OPS.stroke, [], [100, 100, 160, 200]]);
  const argsArray = [...samePaths, [OPS.stroke, [], [162, 101, 195, 200]], [OPS.stroke, [], [350, 500, 400, 600]]];
  const fnArray = Array(argsArray.length).fill(OPS.constructPath);
  const { drawings } = graphicsFromOperatorList({ fnArray, argsArray }, viewport, OPS);
  assert.equal(drawings.length, 1);
  assert.equal(drawings[0].n, 20_001);
  assert.equal(drawings[0].boxes, 20_001);
  assert.equal(drawings[0].right, 195 / 600);
});
