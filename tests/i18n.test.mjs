// web/app/i18n.mjs のテスト．実行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { en, ja, lang, setLang, t, tn } from "../web/app/i18n.mjs";

// {name}（${name} は含めない）
const placeholders = (s) => [...s.matchAll(/(?<!\$)\{(\w+)\}/g)].map((m) => m[1]).sort();
// ${name}（文中にそのまま残す変数）
const literals = (s) => [...s.matchAll(/\$\{\w+\}/g)].map((m) => m[0]).sort();

test("document がなくても読み込める（既定は英語）", () => {
  assert.equal(lang, "en");
});

test("ja と en の key が一致する", () => {
  assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort());
});

test("{name} の置き換え先が言語間で一致する", () => {
  for (const k of Object.keys(en)) {
    assert.deepEqual(placeholders(ja[k]), placeholders(en[k]), k);
  }
});

test("${…} の変数が訳でも残る", () => {
  for (const k of Object.keys(en)) {
    assert.deepEqual(literals(ja[k]), literals(en[k]), k);
  }
  assert.match(ja["settings.promptHelp"], /\$\{sourceText\}/);
  assert.match(ja["settings.systemPromptHelp"], /\$\{langFrom\}.*\$\{langTo\}/);
  assert.match(ja["settings.langFrom"], /\$\{langFrom\}/);
});

test("値が空でない", () => {
  for (const [k, v] of Object.entries({ ...ja })) assert.ok(v.length > 0 || k === "popup.skippedSep", k);
  for (const v of Object.values(en)) assert.equal(typeof v, "string");
});

test("t：言語の切り替え，{name} の置き換え，なければ英語，なければ key", () => {
  setLang("en");
  assert.equal(t("sidebar.page", { n: 3 }), "Page 3");
  setLang("ja");
  assert.equal(t("sidebar.page", { n: 3 }), "3 ページ");
  assert.equal(t("save.done"), "保存しました．");
  assert.equal(t("no.such.key"), "no.such.key");
  setLang("xx"); // 知らない言語は英語
  assert.equal(t("save.done"), "Saved");
  setLang("en");
});

test("t：vars にない {name} と ${name} はそのまま", () => {
  setLang("en");
  assert.equal(t("settings.promptHelp"), en["settings.promptHelp"]);
  assert.equal(t("settings.promptHelp", { sourceText: "X" }), en["settings.promptHelp"]);
  assert.equal(t("sidebar.page", {}), "Page {n}");
  assert.equal(t("sidebar.page", { n: 0 }), "Page 0");
});

test("t：英語にしかない key は英語に戻る", () => {
  en["__only.en"] = "only {x}";
  setLang("ja");
  assert.equal(t("__only.en", { x: 1 }), "only 1");
  setLang("en");
  delete en["__only.en"];
});

test("tn：英語は 1 個のとき単数形", () => {
  setLang("en");
  assert.match(tn("settings.connected.available", 1), /^Connected\. 1 model\. /);
  assert.match(tn("settings.connected.available", 5), /^Connected\. 5 models\. /);
  assert.equal(tn("settings.connected.missing", 2, { model: "m" }), 'Connected. 2 models. "m" was not found');
  setLang("ja");
  assert.match(tn("settings.connected.available", 1), /^接続しました．モデルは 1 個/);
  setLang("en");
});

test("色の名前が全部ある", () => {
  for (const c of ["Yellow", "Red", "Green", "Blue", "Purple", "Magenta", "Orange", "Gray"]) {
    assert.ok(en[`color.${c}`] && ja[`color.${c}`], c);
  }
});
