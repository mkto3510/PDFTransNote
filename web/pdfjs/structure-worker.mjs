import { normalizePageText, prepareDocumentAnalysis, preparePage } from "./page-structure.mjs";
import { groupPageDrawings } from "./page-graphics.mjs";

const pages = [];
let analysis = null;
let analysisKey;

// The bridge owns one worker per document. Its most recent context is shared by selections.
self.onmessage = ({ data }) => {
  const { type, pageIndex, content, requestId } = data;
  if (type !== "selection") {
    const page = pages[pageIndex] ??= {};
    if (type === "text") {
      page.normalized = normalizePageText(content);
      preparePage(page);
      analysis = null;
    } else {
      try {
        Object.assign(page, groupPageDrawings(content));
      } catch (error) {
        console.warn("[transnote] page geometry", pageIndex, error);
      }
    }
    return;
  }
  try {
    const { pageIndices, pageCount, furnitureBand, sizeTolerance } = data;
    const key = `${pageCount}:${furnitureBand}:${sizeTolerance}`;
    if (!analysis || analysisKey !== key) {
      const input = Array.from({ length: pageCount }, (_, i) => pages[i]?.normalized ? pages[i] : null);
      analysis = prepareDocumentAnalysis(input, { furnitureBand, sizeTolerance });
      analysisKey = key;
    }
    const classified = Object.fromEntries(pageIndices.map((i) => [i, analysis.page(i)]));
    const matches = data.spans.map(({ pageIndex, spanIndex, text }) =>
      pages[pageIndex]?.normalized?.items[spanIndex]?.str === text);
    self.postMessage({ requestId, classified, matches, hyphenWords: analysis.hyphenWords });
  } catch (error) {
    self.postMessage({ requestId, error: String(error) });
  }
};
