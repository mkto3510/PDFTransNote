// web/app/core.mjs のテスト．実行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChatBody,
  chatRequest,
  cleanSource,
  extractText,
  fillTemplate,
  pickModel,
  sseData,
  translate,
} from "../web/app/core.mjs";

const SERVICE = {
  id: "plamo-0.8b",
  name: "PLaMo",
  endpoint: "http://localhost:1234",
  apiKey: "",
  model: "plamo-3-translate-0.8b",
  temperature: 0,
  systemPrompt: "[plamo-translate]\ntarget_lang=${langTo}\nform=plain",
  prompt: "${sourceText}",
  stream: true,
  customParams: {},
};
const LANGS = { langFrom: "en", langTo: "ja" };

test("cleanSource：行末ハイフンの結合，合字，改行", () => {
  assert.equal(cleanSource("This transla-\ntion is ﬁne."), "This translation is fine.");
  assert.equal(cleanSource("the eﬀect of\r\nthe ﬂow"), "the effect of the flow");
  assert.equal(cleanSource("COVID-\n19 and Type-\nB"), "COVID-19 and Type-B");
  // 単語の中でないハイフン（ページ番号の飾り）の後は，改行を空白にする
  assert.equal(cleanSource("page 1.39\n- 2 -\nA Study"), "page 1.39 - 2 - A Study");
  assert.equal(cleanSource("  a  b\t c \n d  "), "a b c d");
  assert.equal(cleanSource("first para\nline two\n\n  \nsecond para"), "first para line two\n\nsecond para");
  assert.equal(cleanSource("soft­hyphen"), "softhyphen");
  assert.equal(cleanSource(""), "");
  assert.equal(cleanSource(null), "");
});

test("cleanSource：日本語の前後の改行は空白にしない（段落の空行は残す）", () => {
  assert.equal(cleanSource("中\n心極限定理と，\n「距\n離」"), "中心極限定理と，「距離」");
  assert.equal(cleanSource("ここでは，t\nは粒子の数"), "ここでは，tは粒子の数");
  assert.equal(cleanSource("一つ目の段落．\n\n二つ目の段落"), "一つ目の段落．\n\n二つ目の段落");
  assert.equal(cleanSource("English\ntext"), "English text");
});

test("fillTemplate：既知の差し込み文字だけ置き換える", () => {
  assert.equal(
    fillTemplate("${langFrom}->${langTo}: ${sourceText} ${unknown}", { sourceText: "hi", langFrom: "en", langTo: "ja" }),
    "en->ja: hi ${unknown}",
  );
});

test("buildChatBody：プロンプトの差し込みと標準の項目", () => {
  const body = buildChatBody(SERVICE, "Hello.", LANGS);
  assert.deepEqual(body, {
    model: "plamo-3-translate-0.8b",
    messages: [
      { role: "system", content: "[plamo-translate]\ntarget_lang=ja\nform=plain" },
      { role: "user", content: "Hello." },
    ],
    temperature: 0,
    stream: true,
  });
});

test("buildChatBody：system の雛形が空なら user だけ", () => {
  const body = buildChatBody({ ...SERVICE, systemPrompt: "  ", prompt: "Translate to ${langTo}: ${sourceText}" }, "Hi", LANGS);
  assert.deepEqual(body.messages, [{ role: "user", content: "Translate to ja: Hi" }]);
});

test("buildChatBody：追加のパラメーターを混ぜる（後から上書き）", () => {
  const body = buildChatBody({ ...SERVICE, stream: false, customParams: { max_tokens: 100, temperature: 0.5, stop: ["x"] } }, "a", LANGS);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.temperature, 0.5);
  assert.deepEqual(body.stop, ["x"]);
  assert.equal(body.stream, false);
});

test("chatRequest：サービスは ID で指定する（キーは本文に入れない）", () => {
  const r = chatRequest({ ...SERVICE, id: "a b", apiKey: "secret" }, "x", LANGS);
  assert.equal(r.path, "/llm/chat?service=a%20b");
  assert.equal(JSON.stringify(r.body).includes("secret"), false);
});

test("pickModel：完全一致を優先し，なければ部分一致", () => {
  const ids = ["pfnet/plamo-3-translate-8b-gguf", "plamo-3-translate-0.8b", "other"];
  assert.equal(pickModel(ids, "plamo-3-translate-0.8b"), "plamo-3-translate-0.8b");
  assert.equal(pickModel(ids, "PLAMO-3-TRANSLATE-8B"), "pfnet/plamo-3-translate-8b-gguf");
  assert.equal(pickModel(ids, "missing"), null);
  assert.equal(pickModel(ids, ""), null);
});

test("extractText：少しずつ／まとめて", () => {
  assert.equal(extractText({ choices: [{ delta: { content: "い" } }] }), "い");
  assert.equal(extractText({ choices: [{ message: { content: "う" } }] }), "う");
  assert.equal(extractText({ choices: [{ text: "あ" }] }), "あ");
  assert.equal(extractText({}), "");
});

test("sseData：行の途中で切れた断片をつなぐ", async () => {
  async function* chunks() {
    yield 'data: {"a":1}\n\nda';
    yield 'ta: {"a":2}\r\n\n: comment\n';
    yield "data: [DONE]";
  }
  const out = [];
  for await (const d of sseData(chunks())) out.push(d);
  assert.deepEqual(out, ['{"a":1}', '{"a":2}', "[DONE]"]);
});

function fakeFetch(bodyText, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(bodyText, { status });
  };
  return { impl, calls };
}

test("translate：少しずつ受け取り，onDelta を呼ぶ", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"こん"}}]}\n\n' + 'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\n' + "data: [DONE]\n\n";
  const { impl, calls } = fakeFetch(sse);
  const deltas = [];
  const out = await translate({
    fetchImpl: impl,
    headers: { "X-TransNote-Token": "t" },
    request: chatRequest(SERVICE, "Hello", LANGS),
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(out, "こんにちは");
  assert.deepEqual(deltas, ["こん", "にちは"]);
  assert.equal(calls[0].url, "/llm/chat?service=plamo-0.8b");
  assert.equal(calls[0].init.headers["X-TransNote-Token"], "t");
});

test("translate：まとめて受け取る（stream なし）", async () => {
  const { impl } = fakeFetch(JSON.stringify({ choices: [{ message: { content: " 訳文 " } }] }));
  const out = await translate({ fetchImpl: impl, request: chatRequest({ ...SERVICE, stream: false }, "x", LANGS) });
  assert.equal(out, "訳文");
});

test("translate：誤りの応答は，その文だけを例外にする", async () => {
  const { impl } = fakeFetch(JSON.stringify({ error: "翻訳サーバーに接続できません" }), { status: 502 });
  await assert.rejects(translate({ fetchImpl: impl, request: chatRequest(SERVICE, "x", LANGS) }), /^Error: 502 翻訳サーバーに接続できません$/);
  const { impl: impl2 } = fakeFetch(JSON.stringify({ error: { message: "model not loaded" } }), { status: 400 });
  await assert.rejects(translate({ fetchImpl: impl2, request: chatRequest(SERVICE, "x", LANGS) }), /400 model not loaded/);
  const { impl: impl3 } = fakeFetch('data: {"error":"boom"}\n\n');
  await assert.rejects(translate({ fetchImpl: impl3, request: chatRequest(SERVICE, "x", LANGS) }), /boom/);
});
