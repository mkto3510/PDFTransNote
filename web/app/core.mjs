// PDF TransNote：翻訳の中核（原文の整形，chat の本文の組み立て，翻訳サーバーとの通信）
// ===========================================================================
// pdf.js にも画面にも依存しないので，node --test でそのまま確かめられる（tests/core.test.mjs）．
// 翻訳サービスの考え方は Translate for Zotero の Custom GPT と同じ：OpenAI 形式の chat/completions に，
// プロンプトの雛形（${sourceText} 必須，${langFrom}，${langTo}）を user メッセージとして送る．
// それに加えて，system メッセージの雛形も持てる（PLaMo 3 Translate の GGUF 版は，[plamo-translate] の
// 見出しを system メッセージで受け取る．user メッセージに書くと見出しまで訳してしまう）．

/** 言語の選択肢（コード）．PLaMo 3 Translate のモデルカードの「対応言語」の表の順． */
// prettier-ignore
export const LANGS = [
  "ja", "en", "zh-hans", "zh-hant", "ko", "ar", "az", "be", "bg", "bn", "ca", "ceb", "de",
  "es", "et", "eu", "fa", "fr", "gu", "he", "hi", "hr", "hu", "hy", "id", "it",
  "jv", "ka", "kk", "km", "lt", "lv", "ml", "mr", "ms", "my", "ne", "nl", "pa",
  "pl", "ru", "si", "sk", "sl", "sr", "sw", "ta", "te", "th", "tl", "ur", "uz",
  "vi",
];

// ---------------------------------------------------------------------------
// 1. 原文の整形
// ---------------------------------------------------------------------------

/** PDF でよく出る合字（1 文字で 2〜3 文字を表すもの）と，その分解． */
const LIGATURES = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

/**
 * PDF から選んだ文字を，翻訳に向く形に整える．
 *   - 改行コードをそろえ，ソフトハイフン（U+00AD）を消し，合字（ﬁ など）を普通の文字に分ける．
 *   - 行末のハイフンで切れた単語をつなぐ（"transla-\ntion" → "translation"）．
 *     次の行が大文字や数字で始まるときは，ハイフンを残して改行だけ消す（"COVID-\n19" → "COVID-19"）．
 *   - 空行（段落の区切り）は 1 つの空行として残し，それ以外の改行は空白にする．
 *   - 続く空白を 1 つにし，前後の空白を取る．
 * @param {string} text
 * @returns {string}
 */
export function cleanSource(text) {
  let s = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "")
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c);
  s = s.replace(/(\p{L})[-‐][ \t]*\n[ \t]*(?=\p{Ll})/gu, "$1");
  // 単語の中のハイフン（前が文字か数字）のときだけ．"- 2 -\nA Study"（ページ番号と次のページのヘッダー）はつながない
  s = s.replace(/(?<=[\p{L}\p{N}])([-‐])[ \t]*\n[ \t]*(?=[\p{Lu}\p{N}])/gu, "$1");
  s = s
    .replace(/\n[ \t]*\n[\s]*/g, "\u0000")
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/[ \t ]+/g, " ")
    .split("\u0000")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  return s.trim();
}

// ---------------------------------------------------------------------------
// 2. 要求の組み立て
// ---------------------------------------------------------------------------

/**
 * 雛形の差し込み文字を置き換える．知らない名前の ${…} はそのまま残す．
 * @param {string} template
 * @param {Object<string, string>} vars
 */
export const fillTemplate = (template, vars) =>
  String(template ?? "").replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/**
 * 翻訳サービスの設定と原文から，chat/completions の本文を作る．
 * messages は，system の雛形が空でなければ system と user の 2 件，空なら user の 1 件．
 * 標準の項目（model，messages，temperature，stream）に，追加のパラメーターを混ぜる
 * （Translate for Zotero の Custom Request と同じく，追加のパラメーターが後から上書きする）．
 * @param {object} service 翻訳サービス（settings.json の services の 1 件）
 * @param {string} text 原文（整形済み）
 * @param {{langFrom: string, langTo: string}} langs
 */
export function buildChatBody(service, text, { langFrom, langTo }) {
  const vars = { sourceText: text, langFrom, langTo };
  const system = fillTemplate(service.systemPrompt ?? "", vars).trim();
  const messages = [{ role: "user", content: fillTemplate(service.prompt, vars) }];
  if (system) messages.unshift({ role: "system", content: system });
  return {
    model: service.model,
    messages,
    temperature: Number(service.temperature),
    stream: !!service.stream,
    ...(service.customParams ?? {}),
  };
}

/** 中継（サーバーの /llm/chat）に送る要求．サービスは ID で指定し，キーはサーバーが付ける． */
export function chatRequest(service, text, langs) {
  return {
    path: `/llm/chat?service=${encodeURIComponent(service.id)}`,
    body: buildChatBody(service, text, langs),
  };
}

/**
 * サーバーのモデル一覧から，設定のモデル ID に当たるものを選ぶ（接続テストの表示用）．
 * 完全に一致する ID（大文字と小文字は区別しない）を優先し，なければ指定の文字列を含む ID の最初のもの．
 * @returns {string | null}
 */
export function pickModel(ids, wanted) {
  const w = String(wanted ?? "").trim().toLowerCase();
  if (!w) return null;
  const list = (ids ?? []).map(String);
  return list.find((id) => id.toLowerCase() === w) ?? list.find((id) => id.toLowerCase().includes(w)) ?? null;
}

// ---------------------------------------------------------------------------
// 3. 応答の読み取り
// ---------------------------------------------------------------------------

/** 応答 1 件（JSON）から訳文の断片を取り出す（少しずつなら delta.content，まとめてなら message.content）． */
export function extractText(obj) {
  const c = obj?.choices?.[0];
  if (!c) return "";
  return c.delta?.content ?? c.message?.content ?? c.text ?? "";
}

/**
 * SSE（Server-Sent Events）の文字の流れを，"data: …" 行の中身ごとに返す．
 * 1 回で届く量は行の途中で切れることがあるので，最後の（未完成の）行は次と合わせる．
 * @param {AsyncIterable<string>} chunks
 */
export async function* sseData(chunks) {
  let buf = "";
  for await (const chunk of chunks) {
    const lines = (buf + chunk).split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const m = /^data:\s?(.*)$/.exec(line.replace(/\r$/, ""));
      if (m && m[1].trim()) yield m[1].trim();
    }
  }
  const m = /^data:\s?(.*)$/.exec(buf.replace(/\r$/, ""));
  if (m && m[1].trim()) yield m[1].trim();
}

async function* decodeStream(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 翻訳を 1 回行う．本文の stream が真なら，届いた断片ごとに onDelta を呼ぶ．
 * @param {object} p
 * @param {typeof fetch} p.fetchImpl
 * @param {Object<string, string>} [p.headers] 追加のヘッダー（中継のトークン）
 * @param {{path: string, body: object}} p.request chatRequest の結果
 * @param {(delta: string, full: string) => void} [p.onDelta]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>} 訳文（前後の空白は取る）
 */
export async function translate({ fetchImpl, headers = {}, request, onDelta, signal }) {
  const res = await fetchImpl(request.path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(request.body),
    signal,
  });
  if (!res.ok) {
    // 誤りは {"error": "…"} か {"error": {"message": "…"}} で返ることが多いので，その文だけを出す
    const body = await res.text();
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = typeof j.error === "string" ? j.error : (j.error?.message ?? body);
    } catch {}
    throw new Error(`${res.status} ${String(msg).slice(0, 500)}`);
  }
  let full = "";
  if (!request.body.stream) {
    full = extractText(await res.json());
    onDelta?.(full, full);
    return full.trim();
  }
  for await (const data of sseData(decodeStream(res.body))) {
    if (data === "[DONE]") break;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      continue;
    }
    if (obj.error) throw new Error(typeof obj.error === "string" ? obj.error : (obj.error.message ?? JSON.stringify(obj.error)));
    const delta = extractText(obj);
    if (delta) {
      full += delta;
      onDelta?.(delta, full);
    }
  }
  return full.trim();
}
