// PDF TransNote：ポップアップ（選択ポップアップと注釈ポップアップ）．pdf.js には触れず，bridge を通す．
// ===========================================================================
// 部品は縦に積む．
//   選択ポップアップ：色の丸 → 原文の欄 → Translate → （訳文の欄と Add Annotation）→ Annotate & Translate
//   注釈ポップアップ：色の丸 → コメント（左のパネルのカードの下に付けたときは省く） → 原文の欄 → Translate → （訳文の欄と Save to Comment）
//                     → Translate to Comment → Delete
// どちらも，選んだ範囲（ハイライト）の下に出す．下に場所がなければ上に出す．左右は文書の表示領域に収める．

import { cleanSource } from "./core.mjs";
import { COLORS, colorLabel, el, normColor } from "./dom.js";
import { t } from "./i18n.mjs";

const MARGIN = 8;
const MIN_W = 260;
const MIN_H = 200;

export class Popup {
  /**
   * @param {object} ctx main.js が渡す道具（bridge，設定，翻訳の列への操作など）
   * @param {object} p
   * @param {object} [p.anchor] 選んだ範囲（選択ポップアップ）
   * @param {object} [p.target] 既存のハイライト（注釈ポップアップ）
   * @param {object} [p.job] 引き継ぐジョブ（一覧の「Edit」）
   * @param {HTMLElement} [p.dock] 注釈ポップアップを入れる場所（左のパネルのカードの下）．なければ浮かせる
   */
  constructor(ctx, { anchor = null, target = null, job = null, dock = null }) {
    this.ctx = ctx;
    this.anchor = anchor;
    this.target = target;
    this.job = null;
    this.mode = anchor ? "selection" : "annotation";
    this.docked = !!dock && !anchor;
    this.offset = null; // 大きさを変えた後の，範囲に対するポップアップの位置のずれ
    this.resizing = false;
    const { bridge } = ctx;
    const isSel = this.mode === "selection";

    // --- 部品 ---
    this.swatches = COLORS.map((c) =>
      el("button", {
        class: "tnSwatch",
        type: "button",
        title: t(isSel ? "popup.swatchSelection" : "popup.swatchAnnotation", { color: colorLabel(c) }),
        "aria-label": colorLabel(c),
        "data-color": c.value,
        onclick: () => this.onColor(c.value),
      }),
    );
    this.comment = isSel || this.docked ? null : el("div", { class: "tnComment" });
    this.source = el("textarea", { class: "tnField tnSource", rows: "3", spellcheck: "false", "aria-label": t("popup.sourceText") });
    this.source.value = cleanSource(job?.source ?? (isSel ? anchor.text : bridge.sourceText(target)));
    this.skipped = isSel ? this.makeSkipped() : null;
    this.translateBtn = el("button", { class: "tnBtn", type: "button", title: t("popup.translateTitle"), onclick: () => this.onTranslate() }, t("popup.translate"));
    this.output = el("textarea", { class: "tnField tnOutput", rows: "3", "aria-label": t("popup.translation"), placeholder: t("popup.translationPlaceholder") });
    this.status = el("div", { class: "tnStatus", role: "status" });
    this.commitBtn = el(
      "button",
      { class: "tnBtn primary", type: "button", title: t(isSel ? "popup.addAnnotationTitle" : "popup.saveToCommentTitle"), onclick: () => this.onCommit() },
      t(isSel ? "popup.addAnnotation" : "popup.saveToComment"),
    );
    this.result = el("div", { class: "tnResult", hidden: true }, this.output, this.commitBtn);
    this.autoBtn = el(
      "button",
      {
        class: "tnBtn",
        type: "button",
        title: t(isSel ? "popup.annotateTranslateTitle" : "popup.translateToCommentTitle"),
        onclick: () => this.onAuto(),
      },
      t(isSel ? "popup.annotateTranslate" : "popup.translateToComment"),
    );
    this.deleteBtn = isSel ? null : el("button", { class: "tnBtn danger", type: "button", onclick: () => this.onDelete() }, t("popup.delete"));
    this.service = el("select", { class: "tnService", title: t("popup.service"), "aria-label": t("popup.service"), onchange: () => ctx.setActiveService(this.service.value) });

    this.root = el(
      "div",
      { class: this.docked ? "tnPopup docked" : "tnPopup", role: "dialog", "aria-label": t(isSel ? "popup.dialogSelection" : "popup.dialogAnnotation") },
      el("div", { class: "tnColors" }, this.swatches),
      this.comment,
      this.source,
      this.skipped,
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

    if (this.docked) {
      dock.append(this.root);
    } else {
      this.grip = this.makeGrip();
      this.root.append(this.grip);
      bridge.overlayParent().append(this.root);
      const s = ctx.settings();
      if (Number(s.popupWidth) > 0 && Number(s.popupHeight) > 0) this.applySize(Number(s.popupWidth), Number(s.popupHeight));
    }
    this.refresh();
    if (job) this.adopt(job);
    this.updateButtons();
    this.place();
    if (!this.docked) {
      this.resizeObserver = new ResizeObserver(() => this.place());
      this.resizeObserver.observe(this.root);
    }
    this.sourceReady = anchor?.ready ? this.loadSelection(anchor.ready) : Promise.resolve(true);
    if (!anchor && !this.source.value && target) {
      bridge.sourceTextAsync(target).then((text) => {
        if (!this.root.isConnected || this.source.value) return;
        this.source.value = cleanSource(text);
        this.updateButtons();
      }).catch((error) => console.warn("[transnote] highlight text", error));
    }
  }

  // --- 大きさを変える（浮かせたポップアップだけ） ---

  async loadSelection(ready) {
    this.pending = true;
    this.source.readOnly = true;
    this.setStatus(t("popup.analyzing"));
    this.updateButtons();
    const anchor = await ready;
    if (!this.root.isConnected) return false;
    if (!anchor) {
      this.close();
      return false;
    }
    this.anchor = anchor;
    this.source.value = cleanSource(anchor.text);
    this.skipped = this.makeSkipped();
    if (this.skipped) this.source.after(this.skipped);
    this.pending = false;
    this.source.readOnly = false;
    this.setStatus("");
    this.updateButtons();
    this.place();
    return true;
  }

  /** 右下の持ち手．ドラッグで大きさを変え，ダブルクリックで自動の大きさに戻す． */
  makeGrip() {
    const grip = el("div", { class: "tnGrip", role: "separator", "aria-label": t("popup.resize"), title: t("popup.resizeTitle") });
    let start = null;
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const b = this.root.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, w: b.width, h: b.height, left: b.left, top: b.top };
      this.resizing = true;
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => {
      if (!start) return;
      const view = this.ctx.bridge.viewRect();
      const w = Math.max(MIN_W, Math.min(start.w + e.clientX - start.x, view.right - MARGIN - start.left));
      const h = Math.max(MIN_H, Math.min(start.h + e.clientY - start.y, view.bottom - MARGIN - start.top));
      this.applySize(w, h);
    });
    const end = (e) => {
      if (!start) return;
      start = null;
      this.resizing = false;
      if (grip.hasPointerCapture?.(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      const b = this.root.getBoundingClientRect();
      const r = this.rect();
      if (r) this.offset = { dx: b.left - r.left, dy: b.top - r.bottom };
      this.ctx.rememberPopupSize?.(Math.round(b.width), Math.round(b.height));
      this.place();
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => {
      this.root.classList.remove("sized");
      this.root.style.width = "";
      this.root.style.height = "";
      this.offset = null;
      this.ctx.rememberPopupSize?.(0, 0);
      this.place();
    });
    return grip;
  }

  /** 大きさを決める（最小と文書の表示領域で挟む）．高さは固定になり，欄が残りを分け合う． */
  applySize(w, h) {
    const view = this.ctx.bridge.viewRect();
    const maxW = Math.max(MIN_W, view.right - view.left - 2 * MARGIN);
    const maxH = Math.max(MIN_H, view.bottom - view.top - 2 * MARGIN);
    this.root.classList.add("sized");
    this.root.style.width = `${Math.round(Math.max(MIN_W, Math.min(w, maxW)))}px`;
    this.root.style.height = `${Math.round(Math.max(MIN_H, Math.min(h, maxH)))}px`;
  }

  /** 選んだ範囲（ハイライト）の矩形． */
  rect() {
    const { bridge } = this.ctx;
    return this.mode === "selection" ? bridge.rectOfAnchor(this.anchor) : bridge.rectOf(this.target);
  }

  // --- 選択から取り除かれた部分（選択ポップアップ） ---

  makeSkipped() {
    const removed = this.anchor?.removed;
    if (!removed?.length || !this.anchor.raw) return null;
    const kind = (k) => (["furniture", "caption", "small", "margin", "ruby", "lineNumber", "code", "equation", "order"].includes(k) ? t(`popup.kind.${k}`) : k);
    const list = removed.map((r) => t("popup.skippedItem", { kind: kind(r.kind), n: r.pageIndex + 1 })).join(t("popup.skippedSep"));
    const link = el("button", { class: "tnLink", type: "button", title: t("popup.includeTitle"), onclick: () => this.onInclude() }, t("popup.include"));
    return el("div", { class: "tnSkipped" }, `${t("popup.skipped")} ${list} `, link);
  }

  /** 取り除いた部分を戻す：原文を取り除く前のものにする． */
  onInclude() {
    const raw = this.anchor?.raw;
    if (!raw) return;
    this.anchor = raw;
    this.source.value = cleanSource(raw.text);
    this.skipped?.remove();
    this.skipped = null;
    this.updateButtons();
    this.place();
  }

  /** 色の印，コメント，サービスの一覧を今の状態に合わせる． */
  refresh() {
    const { bridge } = this.ctx;
    const current = normColor(this.mode === "selection" ? this.ctx.settings().lastColor : bridge.getColor(this.target));
    for (const s of this.swatches) s.classList.toggle("current", normColor(s.dataset.color) === current);
    if (this.comment) {
      const text = bridge.getComment(this.target);
      this.comment.textContent = text || t("popup.noComment");
      this.comment.classList.toggle("empty", !text);
    }
    const s = this.ctx.settings();
    this.service.replaceChildren(...s.services.map((v) => el("option", { value: v.id, text: v.name })));
    this.service.value = s.activeService;
  }

  /** 位置を決める（選んだ範囲の下．場所がなければ上．文書の表示領域に収める）． */
  place() {
    if (this.docked || this.resizing || !this.root.isConnected) return;
    const { bridge } = this.ctx;
    const r = this.rect();
    const view = bridge.viewRect();
    const visible = r && r.bottom > view.top && r.top < view.bottom && r.right > view.left && r.left < view.right;
    this.root.classList.toggle("offscreen", !visible);
    if (!visible) return;
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    let top = r.bottom + MARGIN;
    if (this.offset) {
      // 大きさを変えた後は，範囲に対するずれを保つ（スクロールに付いていく）
      left = r.left + this.offset.dx;
      top = r.bottom + this.offset.dy;
      top = Math.max(view.top + MARGIN, Math.min(top, view.bottom - h - MARGIN));
    } else if (top + h > view.bottom - MARGIN) {
      const above = r.top - MARGIN - h;
      top = above >= view.top + MARGIN ? above : Math.max(view.top + MARGIN, view.bottom - MARGIN - h);
    }
    left = Math.max(view.left + MARGIN, Math.min(left, view.right - w - MARGIN));
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
  }

  setStatus(text, kind = "") {
    this.status.textContent = text;
    this.status.className = `tnStatus ${kind}`;
  }

  updateButtons() {
    const running = this.job && !this.job.finished;
    this.translateBtn.textContent = running ? t("popup.stop") : t("popup.translate");
    this.translateBtn.disabled = this.pending || (!running && !this.source.value.trim());
    this.autoBtn.disabled = this.pending || !this.source.value.trim();
    for (const swatch of this.swatches) swatch.disabled = !!this.pending;
    this.commitBtn.disabled = this.pending || (!this.output.value.trim() && !running);
  }

  /** ジョブの変化を映す． */
  onJob(job) {
    if (job.status === "running" || job.status === "done") {
      this.output.value = job.output;
      this.output.scrollTop = this.output.scrollHeight;
    }
    const msg = {
      queued: [t("popup.queued"), ""],
      running: [t("popup.running"), ""],
      done: ["", ""],
      error: [t("popup.failed", { message: job.error }), "error"],
      canceled: [t("popup.canceled"), ""],
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
    if (this.pending) return;
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
        this.setStatus(t("popup.createFailed"), "error");
        return this.updateButtons();
      }
    }
    if (running) {
      this.ctx.adoptAsAuto(this.job, target); // 訳が届いたらコメントに入れる
      this.job = null;
    } else if (!(await this.ctx.commitTranslation(target, text))) {
      this.setStatus(t("popup.commentFailed"), "error");
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
    this.deleteBtn.disabled = true;
    try {
      if (await this.ctx.deleteHighlight(this.target)) {
        this.close();
        return;
      }
      this.setStatus(t("popup.deleteFailed"), "error");
    } catch (error) {
      this.setStatus(t("popup.deleteFailed"), "error");
      console.warn("[transnote] delete highlight", error);
    } finally {
      this.deleteBtn.disabled = false;
    }
  }

  /** 閉じる．注釈にしていない翻訳は取り消す． */
  close() {
    if (this.job) this.ctx.dropPopupJob(this.job);
    this.job = null;
    this.resizeObserver?.disconnect();
    this.root.remove();
    this.ctx.popupClosed(this);
  }

  /** 閉じても失うもの（ここで訳した，まだ注釈にしていない訳文）があるか． */
  get holdsWork() {
    return !!(this.job || this.output.value.trim());
  }
}
