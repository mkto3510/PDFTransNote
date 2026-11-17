// PDF TransNote：設定画面（Translate for Zotero の Custom GPT 風）．pdf.js には触れない．
// ===========================================================================
// 翻訳サービスを名前付きで何件でも登録し，「使うサービス」を選ぶ．各サービスの項目は
// エンドポイント，API キー，モデル，temperature，プロンプト（${sourceText} 必須），stream，追加のパラメーター（JSON）．
// 画面では下書き（draft）を直し，「保存」でサーバーに送る（サーバーが検査する）．

import { LANGS, pickModel } from "./core.mjs";
import * as api from "./api.js";
import { el } from "./dom.js";
import { lang, t, tn } from "./i18n.mjs";

const langName = new Intl.DisplayNames([lang], { type: "language" });
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

    f.serviceList = el("select", { id: "tnServiceList", "aria-label": t("settings.services"), onchange: () => this.selectService(f.serviceList.selectedIndex) });
    f.add = el("button", { class: "tnBtn", type: "button", onclick: () => this.addService(false) }, t("settings.add"));
    f.dup = el("button", { class: "tnBtn", type: "button", onclick: () => this.addService(true) }, t("settings.duplicate"));
    f.del = el("button", { class: "tnBtn danger", type: "button", onclick: () => this.deleteService() }, t("settings.delete"));
    f.active = el("input", { id: "tnActive", type: "checkbox", onchange: () => f.active.checked && (this.draft.activeService = this.svc().id) });

    f.name = el("input", { id: "tnName", type: "text" });
    f.endpoint = el("input", { id: "tnEndpoint", type: "url", spellcheck: "false" });
    f.apiKey = el("input", { id: "tnApiKey", type: "password", autocomplete: "off", spellcheck: "false" });
    f.model = el("input", { id: "tnModel", type: "text", list: "tnModelList", spellcheck: "false" });
    f.modelList = el("datalist", { id: "tnModelList" });
    f.test = el("button", { class: "tnBtn", type: "button", onclick: () => this.testConnection() }, t("settings.test"));
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
    f.backupCount = el("input", { id: "tnBackupCount", type: "number", min: "0", max: "200", step: "1" });
    // 画面の言語の選択肢は，それぞれの言語で書く
    f.uiLang = el("select", { id: "tnUiLang" }, [el("option", { value: "en", text: "English" }), el("option", { value: "ja", text: "日本語" })]);
    // 選んだ文字のうち，本文に挟まれたものを除く
    f.skipFurniture = el("input", { id: "tnSkipFurniture", type: "checkbox" });
    f.furnitureBand = el("input", { id: "tnFurnitureBand", type: "number", min: "3", max: "25", step: "1" });
    f.skipCaptions = el("input", { id: "tnSkipCaptions", type: "checkbox" });
    f.skipSmallText = el("input", { id: "tnSkipSmallText", type: "checkbox" });
    f.sizeTolerance = el("input", { id: "tnSizeTolerance", type: "number", min: "2", max: "30", step: "1" });
    f.error = el("div", { class: "tnStatus error", role: "alert" });

    for (const k of ["name", "endpoint", "apiKey", "model", "temperature", "systemPrompt", "prompt", "stream", "customParams"]) {
      f[k].addEventListener("change", () => this.readService());
    }
    f.name.addEventListener("input", () => {
      this.readService();
      f.serviceList.options[this.current].text = this.svc().name || t("settings.noName");
    });

    this.dialog = el(
      "dialog",
      { id: "tnSettings", "aria-label": t("settings.dialog") },
      el(
        "form",
        { method: "dialog", onsubmit: (e) => e.preventDefault() },
        el("h2", { text: t("settings.title") }),
        el("h3", { text: t("settings.services") }),
        el("div", { class: "tnServiceBar" }, f.serviceList, f.add, f.dup, f.del),
        el(
          "fieldset",
          { class: "tnService" },
          el("label", { class: "tnCheck" }, f.active, t("settings.useService")),
          row(t("settings.name"), f.name),
          row(t("settings.endpoint"), f.endpoint, t("settings.endpointHelp")),
          row(t("settings.apiKey"), f.apiKey, t("settings.apiKeyHelp")),
          row(t("settings.model"), el("div", { class: "tnInline" }, f.model, f.test), null),
          el("div", { class: "tnRow" }, el("span"), el("div", { class: "tnRowBody" }, f.testResult, f.modelList)),
          row(t("settings.temperature"), f.temperature),
          row(t("settings.systemPrompt"), f.systemPrompt, t("settings.systemPromptHelp")),
          row(t("settings.prompt"), f.prompt, t("settings.promptHelp")),
          el("div", { class: "tnRow" }, el("span"), el("label", { class: "tnCheck" }, f.stream, t("settings.stream"))),
          row(t("settings.customParams"), f.customParams, t("settings.customParamsHelp")),
        ),
        el("h3", { text: t("settings.general") }),
        el(
          "fieldset",
          {},
          row(t("settings.langFrom"), f.langFrom),
          row(t("settings.langTo"), f.langTo),
          row(t("settings.concurrency"), f.concurrency, t("settings.concurrencyHelp")),
          el("div", { class: "tnRow" }, el("span"), el("label", { class: "tnCheck" }, f.saveOnComment, t("settings.saveOnComment"))),
          row(t("settings.backupCount"), f.backupCount, t("settings.backupCountHelp")),
          row(t("settings.uiLang"), f.uiLang, t("settings.uiLangHelp")),
        ),
        el("h3", { text: t("settings.selection") }),
        el(
          "fieldset",
          {},
          el("p", { class: "tnNote", text: t("settings.selectionNote") }),
          el("div", { class: "tnRow" }, el("span"), el("label", { class: "tnCheck" }, f.skipFurniture, t("settings.skipFurniture"))),
          row(t("settings.furnitureBand"), f.furnitureBand, t("settings.furnitureBandHelp")),
          el("div", { class: "tnRow" }, el("span"), el("label", { class: "tnCheck" }, f.skipCaptions, t("settings.skipCaptions"))),
          el("div", { class: "tnRow" }, el("span"), el("label", { class: "tnCheck" }, f.skipSmallText, t("settings.skipSmallText"))),
          row(t("settings.sizeTolerance"), f.sizeTolerance, t("settings.sizeToleranceHelp")),
        ),
        f.error,
        el(
          "div",
          { class: "tnDialogButtons" },
          el("button", { class: "tnBtn", type: "button", onclick: () => this.fill(structuredClone(this.defaults)) }, t("settings.reset")),
          el("span", { class: "tnSpacer" }),
          el("button", { class: "tnBtn", type: "button", onclick: () => this.dialog.close() }, t("settings.cancel")),
          el("button", { class: "tnBtn primary", type: "button", onclick: () => this.submit() }, t("settings.save")),
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
    f.backupCount.value = this.draft.backupCount;
    f.uiLang.value = this.draft.uiLang;
    f.skipFurniture.checked = !!this.draft.skipFurniture;
    f.furnitureBand.value = this.draft.furnitureBand;
    f.skipCaptions.checked = !!this.draft.skipCaptions;
    f.skipSmallText.checked = !!this.draft.skipSmallText;
    f.sizeTolerance.value = this.draft.sizeTolerance;
    f.error.textContent = "";
    const idx = Math.max(0, this.draft.services.findIndex((s) => s.id === this.draft.activeService));
    this.renderList();
    this.selectService(idx, false);
  }

  renderList() {
    this.f.serviceList.replaceChildren(...this.draft.services.map((s) => el("option", { text: s.name || t("settings.noName") })));
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
    base.name = copy ? t("settings.copyName", { name: base.name }) : t("settings.newService");
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
    r.textContent = t("settings.checking");
    try {
      const ids = await api.fetchModels({ endpoint: s.endpoint, apiKey: s.apiKey });
      this.f.modelList.replaceChildren(...ids.map((id) => el("option", { value: id })));
      const hit = pickModel(ids, s.model);
      r.classList.add("ok");
      const key = hit === s.model ? "settings.connected.available" : hit ? "settings.connected.similar" : "settings.connected.missing";
      r.textContent = tn(key, ids.length, { hit, model: s.model });
    } catch (e) {
      r.classList.add("error");
      r.textContent = t("settings.connectFailed", { message: e.message });
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
      backupCount: f.backupCount.value,
      uiLang: f.uiLang.value,
      skipFurniture: f.skipFurniture.checked,
      furnitureBand: f.furnitureBand.value,
      skipCaptions: f.skipCaptions.checked,
      skipSmallText: f.skipSmallText.checked,
      sizeTolerance: f.sizeTolerance.value,
    });
    f.error.textContent = "";
    try {
      const saved = await api.putSettings(this.draft);
      this.ctx.applySettings(saved);
      this.dialog.close();
      if (saved.uiLang === lang) this.ctx.toast(t("settings.saved"), "ok");
      else if (this.ctx.canReload?.()) location.reload(); // 画面の言語は再読み込みで変わる
      else this.ctx.toast(t("settings.uiLangLater"), "ok");
    } catch (e) {
      f.error.textContent = e.message;
    }
  }
}
