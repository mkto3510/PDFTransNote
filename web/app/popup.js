// PDF TransNote：ポップアップ（選択ポップアップと注釈ポップアップ）．pdf.js には触れず，bridge を通す．
// ===========================================================================
// 部品は縦に積む．
//   選択ポップアップ：色の丸 → 原文の欄 → Translate → （訳文の欄と Add Annotation）→ Annotate & Translate
//   注釈ポップアップ：色の丸 → コメント → 原文の欄 → Translate → （訳文の欄と Save to Comment）
//                     → Translate to Comment → Delete
// どちらも，選んだ範囲（ハイライト）の下に出す．下に場所がなければ上に出す．左右は文書の表示領域に収める．

import { cleanSource } from "./core.mjs";
import { COLORS, el, normColor } from "./dom.js";

const MARGIN = 8;

export class Popup {
  /**
   * @param {object} ctx main.js が渡す道具（bridge，設定，翻訳の列への操作など）
   * @param {object} p
   * @param {object} [p.anchor] 選んだ範囲（選択ポップアップ）
   * @param {object} [p.target] 既存のハイライト（注釈ポップアップ）
   * @param {object} [p.job] 引き継ぐジョブ（一覧の「Edit」）
   */
  constructor(ctx, { anchor = null, target = null, job = null }) {
    this.ctx = ctx;
    this.anchor = anchor;
    this.target = target;
    this.job = null;
    this.mode = anchor ? "selection" : "annotation";
    const { bridge } = ctx;
    const isSel = this.mode === "selection";

    // --- 部品 ---
    this.swatches = COLORS.map((c) =>
      el("button", {
        class: "tnSwatch",
        type: "button",
        title: isSel ? `Highlight in ${c.name} and translate` : `Change to ${c.name}`,
        "aria-label": c.name,
        "data-color": c.value,
        onclick: () => this.onColor(c.value),
      }),
    );
    this.comment = isSel ? null : el("div", { class: "tnComment" });
    this.source = el("textarea", { class: "tnField tnSource", rows: "3", spellcheck: "false", "aria-label": "Source text" });
    this.source.value = cleanSource(job?.source ?? (isSel ? anchor.text : bridge.sourceText(target)));
    this.translateBtn = el("button", { class: "tnBtn", type: "button", title: "Translate here (Ctrl+Enter)", onclick: () => this.onTranslate() }, "Translate");
    this.output = el("textarea", { class: "tnField tnOutput", rows: "3", "aria-label": "Translation", placeholder: "Translation (editable)" });
    this.status = el("div", { class: "tnStatus", role: "status" });
    this.commitBtn = el(
      "button",
      { class: "tnBtn primary", type: "button", title: isSel ? "Highlight with this translation as the comment" : "Use this translation as the comment", onclick: () => this.onCommit() },
      isSel ? "Add Annotation" : "Save to Comment",
    );
    this.result = el("div", { class: "tnResult", hidden: true }, this.output, this.commitBtn);
    this.autoBtn = el(
      "button",
      {
        class: "tnBtn",
        type: "button",
        title: isSel ? "Highlight, translate, and put the translation in the comment (Alt+Shift+T)" : "Translate and put the translation in the comment",
        onclick: () => this.onAuto(),
      },
      isSel ? "Annotate & Translate" : "Translate to Comment",
    );
    this.deleteBtn = isSel ? null : el("button", { class: "tnBtn danger", type: "button", onclick: () => this.onDelete() }, "Delete");
    this.service = el("select", { class: "tnService", title: "Translation service", "aria-label": "Translation service", onchange: () => ctx.setActiveService(this.service.value) });

    this.root = el(
      "div",
      { class: "tnPopup", role: "dialog", "aria-label": isSel ? "Translate" : "Annotation" },
      el("div", { class: "tnColors" }, this.swatches),
      this.comment,
      this.source,
      this.translateBtn,
      this.result,
      this.status,
      this.autoBtn,
      this.deleteBtn,
      el("div", { class: "tnFooter" }, this.service),
    );

    // ポップアップの中の操作を，文書の側（pdf.js のショートカットや選択）に渡さない
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "wheel"]) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.target === this.output && this.output.value.trim()) this.onCommit();
        else this.onTranslate();
      }
    });
    this.output.addEventListener("input", () => this.updateButtons());
    this.source.addEventListener("input", () => this.updateButtons());

    bridge.overlayParent().append(this.root);
    this.refresh();
    if (job) this.adopt(job);
    this.updateButtons();
    this.place();
    new ResizeObserver(() => this.place()).observe(this.root);
  }

  /** 色の印，コメント，サービスの一覧を今の状態に合わせる． */
  refresh() {
    const { bridge } = this.ctx;
    const current = normColor(this.mode === "selection" ? this.ctx.settings().lastColor : bridge.getColor(this.target));
    for (const s of this.swatches) s.classList.toggle("current", normColor(s.dataset.color) === current);
    if (this.comment) {
      const text = bridge.getComment(this.target);
      this.comment.textContent = text || "No comment";
      this.comment.classList.toggle("empty", !text);
    }
    const s = this.ctx.settings();
    this.service.replaceChildren(...s.services.map((v) => el("option", { value: v.id, text: v.name })));
    this.service.value = s.activeService;
  }

  /** 位置を決める（選んだ範囲の下．場所がなければ上．文書の表示領域に収める）． */
  place() {
    if (!this.root.isConnected) return;
    const { bridge } = this.ctx;
    const r = this.mode === "selection" ? bridge.rectOfAnchor(this.anchor) : bridge.rectOf(this.target);
    const view = bridge.viewRect();
    const visible = r && r.bottom > view.top && r.top < view.bottom && r.right > view.left && r.left < view.right;
    this.root.classList.toggle("offscreen", !visible);
    if (!visible) return;
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(view.left + MARGIN, Math.min(left, view.right - w - MARGIN));
    let top = r.bottom + MARGIN;
    if (top + h > view.bottom - MARGIN) {
      const above = r.top - MARGIN - h;
      top = above >= view.top + MARGIN ? above : Math.max(view.top + MARGIN, view.bottom - MARGIN - h);
    }
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
  }

  setStatus(text, kind = "") {
    this.status.textContent = text;
    this.status.className = `tnStatus ${kind}`;
  }

  updateButtons() {
    const running = this.job && !this.job.finished;
    this.translateBtn.textContent = running ? "Stop" : "Translate";
    this.translateBtn.disabled = !running && !this.source.value.trim();
    this.autoBtn.disabled = !this.source.value.trim();
    this.commitBtn.disabled = !this.output.value.trim() && !running;
  }

  /** ジョブの変化を映す． */
  onJob(job) {
    if (job.status === "running" || job.status === "done") {
      this.output.value = job.output;
      this.output.scrollTop = this.output.scrollHeight;
    }
    const msg = {
      queued: ["Waiting… (other translations are running)", ""],
      running: ["Translating…", ""],
      done: ["", ""],
      error: [`Translation failed: ${job.error}`, "error"],
      canceled: ["Canceled", ""],
    }[job.status];
    this.setStatus(...msg);
    this.updateButtons();
  }

  /** 一覧から引き継いだジョブを，このポップアップで扱う． */
  adopt(job) {
    this.job = job;
    this.ctx.adoptToPopup(job, this);
    this.result.hidden = false;
    this.onJob(job);
  }

  // --- 操作 ---

  onTranslate() {
    if (this.job && !this.job.finished) return this.job.cancel();
    const source = this.source.value.trim();
    if (!source) return;
    this.result.hidden = false;
    this.output.value = "";
    if (this.job) this.job.retry(source);
    else this.job = this.ctx.newPopupJob(source, this);
    this.updateButtons();
  }

  /** 訳文をコメントにする（選択ならハイライトを作ってから）．翻訳中なら，届いたときに入れる． */
  async onCommit(color = null) {
    const { bridge } = this.ctx;
    const running = this.job && !this.job.finished;
    const text = this.output.value.trim();
    if (!running && !text) return;
    this.commitBtn.disabled = true;
    let target = this.target;
    if (this.mode === "selection") {
      const c = color ?? this.ctx.settings().lastColor;
      this.ctx.rememberColor(c);
      target = await bridge.createHighlight(this.anchor, c);
      if (!target) {
        this.setStatus("Could not create a highlight. Select the text again.", "error");
        return this.updateButtons();
      }
    }
    if (running) {
      this.ctx.adoptAsAuto(this.job, target); // 訳が届いたらコメントに入れる
      this.job = null;
    } else if (!(await this.ctx.commitTranslation(target, text))) {
      this.setStatus("Could not write the comment (the highlight is gone).", "error");
      return this.updateButtons();
    }
    this.close();
  }

  onColor(color) {
    if (this.mode === "annotation") {
      this.ctx.changeColor(this.target, color).then(() => this.refresh());
      return;
    }
    // 選択：ここで訳していれば，その訳でハイライトする．訳していなければ「Annotate & Translate」
    if (this.job || this.output.value.trim()) return this.onCommit(color);
    this.ctx.rememberColor(color);
    this.onAuto(color);
  }

  onAuto(color = null) {
    const source = this.source.value.trim();
    if (!source) return;
    if (this.mode === "selection") this.ctx.annotateAndTranslate(this.anchor, color ?? this.ctx.settings().lastColor, source);
    else this.ctx.startAutoJob(this.target, source);
    this.close();
  }

  async onDelete() {
    await this.ctx.deleteHighlight(this.target);
    this.close();
  }

  /** 閉じる．注釈にしていない翻訳は取り消す． */
  close() {
    if (this.job) this.ctx.dropPopupJob(this.job);
    this.job = null;
    this.root.remove();
    this.ctx.popupClosed(this);
  }

  /** 閉じても失うもの（ここで訳した，まだ注釈にしていない訳文）があるか． */
  get holdsWork() {
    return !!(this.job || this.output.value.trim());
  }
}
