// PDF TransNote：設定画面（Translate for Zotero の Custom GPT 風）．pdf.js には触れない．
// ===========================================================================
// 翻訳サービスを名前付きで何件でも登録し，「使うサービス」を選ぶ．各サービスの項目は
// エンドポイント，API キー，モデル，temperature，プロンプト（${sourceText} 必須），stream，追加のパラメーター（JSON）．
// 画面では下書き（draft）を直し，「保存」でサーバーに送る（サーバーが検査する）．

import { LANGS, pickModel } from "./core.mjs";
import * as api from "./api.js";
import { el } from "./dom.js";

const langName = new Intl.DisplayNames(["en"], { type: "language" });
const langLabel = (code) => {
  try {
    return `${langName.of(code.replace(/-(han[st])$/, (_, s) => "-" + s[0].toUpperCase() + s.slice(1)))} (${code})`;
  } catch {
    return code;
  }
};

function row(label, input, help) {
  return el("div", { class: "tnRow" }, el("label", { for: input.id, text: label }), el("div", { class: "tnRowBody" }, input, help ? el("small", { text: help }) : null));
}

export class SettingsDialog {
  /**
   * @param {object} ctx main.js が渡す道具（settings()，applySettings(settings)，toast）
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.defaults = null;
    this.draft = null;
    this.current = 0; // 下書きの中で選んでいるサービスの番号
    const f = (this.f = {});

    f.serviceList = el("select", { id: "tnServiceList", "aria-label": "Translation services", onchange: () => this.selectService(f.serviceList.selectedIndex) });
    f.add = el("button", { class: "tnBtn", type: "button", onclick: () => this.addService(false) }, "Add");
    f.dup = el("button", { class: "tnBtn", type: "button", onclick: () => this.addService(true) }, "Duplicate");
    f.del = el("button", { class: "tnBtn danger", type: "button", onclick: () => this.deleteService() }, "Delete");
    f.active = el("input", { id: "tnActive", type: "checkbox", onchange: () => f.active.checked && (this.draft.activeService = this.svc().id) });

    f.name = el("input", { id: "tnName", type: "text" });
    f.endpoint = el("input", { id: "tnEndpoint", type: "url", spellcheck: "false" });
    f.apiKey = el("input", { id: "tnApiKey", type: "password", autocomplete: "off", spellcheck: "false" });
    f.model = el("input", { id: "tnModel", type: "text", list: "tnModelList", spellcheck: "false" });
    f.modelList = el("datalist", { id: "tnModelList" });
    f.test = el("button", { class: "tnBtn", type: "button", onclick: () => this.testConnection() }, "Test Connection");
    f.testResult = el("small", { class: "tnTestResult" });
    f.temperature = el("input", { id: "tnTemperature", type: "number", min: "0", max: "2", step: "0.05" });
    f.systemPrompt = el("textarea", { id: "tnSystemPrompt", rows: "3", spellcheck: "false" });
    f.prompt = el("textarea", { id: "tnPrompt", rows: "3", spellcheck: "false" });
    f.stream = el("input", { id: "tnStream", type: "checkbox" });
    f.customParams = el("textarea", { id: "tnCustomParams", rows: "3", spellcheck: "false", placeholder: '{"max_tokens": 4096}' });

    f.langFrom = el("select", { id: "tnLangFrom" }, LANGS.map((c) => el("option", { value: c, text: langLabel(c) })));
    f.langTo = el("select", { id: "tnLangTo" }, LANGS.map((c) => el("option", { value: c, text: langLabel(c) })));
    f.concurrency = el("input", { id: "tnConcurrency", type: "number", min: "1", max: "8", step: "1" });
    f.saveOnComment = el("input", { id: "tnSaveOnComment", type: "checkbox" });
    f.error = el("div", { class: "tnStatus error", role: "alert" });

    for (const k of ["name", "endpoint", "apiKey", "model", "temperature", "systemPrompt", "prompt", "stream", "customParams"]) {
      f[k].addEventListener("change", () => this.readService());
    }
    f.name.addEventListener("input", () => {
      this.readService();
      f.serviceList.options[this.current].text = this.svc().name || "(no name)";
    });

    this.dialog = el(
      "dialog",
      { id: "tnSettings", "aria-label": "PDF TransNote Settings" },
      el(
        "form",
        { method: "dialog", onsubmit: (e) => e.preventDefault() },
        el("h2", { text: "Settings" }),
        el("h3", { text: "Translation services" }),
        el("div", { class: "tnServiceBar" }, f.serviceList, f.add, f.dup, f.del),
        el(
          "fieldset",
          { class: "tnService" },
          el("label", { class: "tnCheck" }, f.active, "Use this service"),
          row("Name", f.name),
          row("Endpoint", f.endpoint, "A base URL such as http://localhost:1234 gets /v1/chat/completions appended. A URL ending in …/chat/completions is used as is."),
          row("API key", f.apiKey, "Optional. Sent as Authorization: Bearer."),
          row("Model", el("div", { class: "tnInline" }, f.model, f.test), null),
          el("div", { class: "tnRow" }, el("span"), el("div", { class: "tnRowBody" }, f.testResult, f.modelList)),
          row("temperature", f.temperature),
          row("System prompt", f.systemPrompt, "Sent as the system message (not sent if empty). For PLaMo 3 Translate, put the [plamo-translate] header here. Variables: ${langFrom}, ${langTo}."),
          row("Prompt", f.prompt, "Sent as the user message. Variables: ${sourceText} (required), ${langFrom}, ${langTo}."),
          el("div", { class: "tnRow" }, el("span"), el("label", { class: "tnCheck" }, f.stream, "Stream the response (stream)")),
          row("Extra parameters", f.customParams, "A JSON object. Sent along with model, messages, temperature, and stream; the same names are overwritten."),
        ),
        el("h3", { text: "General" }),
        el(
          "fieldset",
          {},
          row("Source language (${langFrom})", f.langFrom),
          row("Target language (${langTo})", f.langTo),
          row("Concurrent requests", f.concurrency, "1 to 8. Extra requests wait their turn."),
          el("div", { class: "tnRow" }, el("span"), el("label", { class: "tnCheck" }, f.saveOnComment, "Save the PDF after putting a translation into a comment")),
        ),
        f.error,
        el(
          "div",
          { class: "tnDialogButtons" },
          el("button", { class: "tnBtn", type: "button", onclick: () => this.fill(structuredClone(this.defaults)) }, "Reset to Defaults"),
          el("span", { class: "tnSpacer" }),
          el("button", { class: "tnBtn", type: "button", onclick: () => this.dialog.close() }, "Cancel"),
          el("button", { class: "tnBtn primary", type: "button", onclick: () => this.submit() }, "Save"),
        ),
      ),
    );
    for (const type of ["keydown", "keyup"]) this.dialog.addEventListener(type, (e) => e.stopPropagation());
    document.body.append(this.dialog);
  }

  svc() {
    return this.draft.services[this.current];
  }

  async open() {
    try {
      const data = await api.getSettings();
      this.defaults = data.defaults;
      this.fill(data.settings);
    } catch (e) {
      this.ctx.toast(e.message, "error");
      return;
    }
    this.dialog.showModal();
  }

  /** 下書きを作って画面に入れる． */
  fill(settings) {
    this.draft = structuredClone(settings);
    const f = this.f;
    f.langFrom.value = this.draft.langFrom;
    f.langTo.value = this.draft.langTo;
    f.concurrency.value = this.draft.concurrency;
    f.saveOnComment.checked = !!this.draft.saveOnComment;
    f.error.textContent = "";
    const idx = Math.max(0, this.draft.services.findIndex((s) => s.id === this.draft.activeService));
    this.renderList();
    this.selectService(idx, false);
  }

  renderList() {
    this.f.serviceList.replaceChildren(...this.draft.services.map((s) => el("option", { text: s.name || "(no name)" })));
    this.f.del.disabled = this.draft.services.length <= 1;
  }

  /** サービスを選ぶ（今の欄の内容を下書きに書き戻してから切り替える）． */
  selectService(i, saveCurrent = true) {
    if (saveCurrent) this.readService();
    this.current = i;
    this.f.serviceList.selectedIndex = i;
    const s = this.svc();
    const f = this.f;
    f.active.checked = this.draft.activeService === s.id;
    f.name.value = s.name;
    f.endpoint.value = s.endpoint;
    f.apiKey.value = s.apiKey ?? "";
    f.model.value = s.model;
    f.temperature.value = s.temperature;
    f.systemPrompt.value = s.systemPrompt ?? "";
    f.prompt.value = s.prompt;
    f.stream.checked = !!s.stream;
    f.customParams.value = Object.keys(s.customParams ?? {}).length ? JSON.stringify(s.customParams, null, 2) : "";
    f.testResult.textContent = "";
    f.testResult.className = "tnTestResult";
  }

  /** 欄の内容を下書きのサービスに書き戻す（customParams は文字のまま．サーバーが検査する）． */
  readService() {
    const s = this.svc();
    const f = this.f;
    Object.assign(s, {
      name: f.name.value.trim(),
      endpoint: f.endpoint.value.trim(),
      apiKey: f.apiKey.value.trim(),
      model: f.model.value.trim(),
      temperature: f.temperature.value,
      systemPrompt: f.systemPrompt.value,
      prompt: f.prompt.value,
      stream: f.stream.checked,
      customParams: f.customParams.value.trim() || "{}",
    });
  }

  addService(copy) {
    this.readService();
    const base = copy ? structuredClone(this.svc()) : structuredClone(this.defaults.services[0]);
    base.id = `service-${Date.now().toString(36)}`;
    base.name = copy ? `${base.name} (copy)` : "New service";
    this.draft.services.push(base);
    this.renderList();
    this.selectService(this.draft.services.length - 1, false);
    this.f.name.focus();
  }

  deleteService() {
    if (this.draft.services.length <= 1) return;
    const [removed] = this.draft.services.splice(this.current, 1);
    if (this.draft.activeService === removed.id) this.draft.activeService = this.draft.services[0].id;
    this.renderList();
    this.selectService(Math.min(this.current, this.draft.services.length - 1), false);
  }

  async testConnection() {
    this.readService();
    const s = this.svc();
    const r = this.f.testResult;
    r.className = "tnTestResult";
    r.textContent = "Checking…";
    try {
      const ids = await api.fetchModels({ endpoint: s.endpoint, apiKey: s.apiKey });
      this.f.modelList.replaceChildren(...ids.map((id) => el("option", { value: id })));
      const hit = pickModel(ids, s.model);
      r.classList.add("ok");
      r.textContent =
        `Connected. ${ids.length} models. ` +
        (hit === s.model ? "This model is available" : hit ? `Similar name: ${hit} (enter it in the Model field)` : `"${s.model}" was not found`);
    } catch (e) {
      r.classList.add("error");
      r.textContent = `Cannot connect: ${e.message}`;
    }
  }

  async submit() {
    this.readService();
    const f = this.f;
    Object.assign(this.draft, {
      langFrom: f.langFrom.value,
      langTo: f.langTo.value,
      concurrency: f.concurrency.value,
      saveOnComment: f.saveOnComment.checked,
    });
    f.error.textContent = "";
    try {
      const saved = await api.putSettings(this.draft);
      this.ctx.applySettings(saved);
      this.dialog.close();
      this.ctx.toast("Settings saved", "ok");
    } catch (e) {
      f.error.textContent = e.message;
    }
  }
}
