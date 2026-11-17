// PDF TransNote：左のパネルの「Annotations」のビュー（ハイライトのカードの一覧）．pdf.js には触れず，bridge を通す．
// ===========================================================================
// Zotero の注釈の一覧に合わせ，1 つのハイライトを 1 枚のカードにする：
//   見出し（色の印とページ）→ 原文（3 行まで．押すと全部）→ コメント（押すとその場で直せる）→ 翻訳の状態．
// 翻訳の進み具合（Waiting／Translating…／Failed）もカードに出す（右下の一覧の代わり）．

import { cleanSource } from "./core.mjs";
import { el } from "./dom.js";

const STATE_LABEL = { queued: "Waiting", running: "Translating…", error: "Failed" };

export class AnnotationSidebar {
  /**
   * @param {object} ctx main.js が渡す道具
   *   bridge，queue，openHighlight(target)，saveComment(target, text)，openEditor(job)
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.root = ctx.bridge.sidebarContainer();
    this.entries = [];
    this.cards = new Map(); // key → { card, entry, state, comment, actions }
    this.selectedKey = null;
    this.editing = null; // コメントを直しているカードの key
    this.stale = true; // 一覧が古いか（見えていないときは描き直さずに印だけ付ける）
    this.loading = false;
    this.again = false;
    this.expanded = new Set(); // 原文を全部出しているカードの key
    if (!this.root) return;
    this.root.classList.add("tnSidebar");
    ctx.bridge.on("highlightsChanged", () => this.invalidate());
    ctx.bridge.on("sidebarView", (visible) => visible && this.stale && this.refresh());
    // パネルの中のキー操作（コメントの入力など）を，pdf.js のショートカットに渡さない
    this.root.addEventListener("keydown", (e) => {
      if (e.target.closest("textarea")) e.stopPropagation();
    });
    this.render();
  }

  invalidate() {
    this.stale = true;
    if (this.ctx.bridge.isSidebarVisible()) this.refresh();
  }

  async refresh() {
    if (!this.root) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.stale = false;
    try {
      this.entries = await this.ctx.bridge.listHighlights();
    } catch (e) {
      console.error("[transnote] listHighlights", e);
    } finally {
      this.loading = false;
    }
    this.render();
    if (this.again) {
      this.again = false;
      this.refresh();
    }
  }

  /** そのハイライトの，まだ済んでいない（または失敗した）自動のジョブ． */
  jobFor(key) {
    const { bridge, queue } = this.ctx;
    let found = null;
    for (const j of queue.jobs) {
      if (j.meta.kind !== "auto" || !j.meta.target || j.status === "done" || j.status === "canceled") continue;
      if (bridge.keyOf(j.meta.target) === key) found = j;
    }
    return found;
  }

  render() {
    if (!this.root) return;
    if (this.editing && this.cards.has(this.editing)) {
      this.pendingRender = true; // 直し終わってから描き直す
      return;
    }
    this.pendingRender = false;
    const { bridge } = this.ctx;
    const n = this.entries.length;
    bridge.setSidebarTitle(n ? `Annotations (${n})` : "Annotations");
    this.cards.clear();
    if (!n) {
      this.root.replaceChildren(el("p", { class: "tnSideEmpty", text: "No highlights yet. Select text and click a color to highlight and translate." }));
      return;
    }
    const list = el("ol", { class: "tnCards" });
    for (const entry of this.entries) list.append(this.card(entry));
    this.root.replaceChildren(list);
    this.updateJobs();
  }

  card(entry) {
    const { key, target } = entry;
    const open = () => {
      this.select(target);
      this.ctx.openHighlight(target);
    };
    const dot = el("span", { class: "tnCardDot", "aria-hidden": "true" });
    dot.style.setProperty("--sw", entry.color || "#ffd400");
    const state = el("span", { class: "tnCardState" });
    const head = el(
      "button",
      { class: "tnCardHead", type: "button", title: "Go to this highlight", onclick: open },
      dot,
      el("span", { class: "tnCardPage", text: `Page ${entry.pageIndex + 1}` }),
      state,
    );
    const quote = el("blockquote", {
      class: `tnCardQuote${this.expanded.has(key) ? " expanded" : ""}`,
      text: cleanSource(entry.text || "") || "(no text)",
      title: "Go to this highlight",
      onclick: () => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        quote.classList.toggle("expanded", this.expanded.has(key));
        open();
      },
    });
    quote.style.setProperty("--sw", entry.color || "#ffd400");
    const comment = el("div", {
      class: "tnCardComment",
      tabindex: "0",
      role: "button",
      title: "Edit the comment",
      onclick: () => this.startEdit(key),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.startEdit(key);
        }
      },
    });
    const actions = el("div", { class: "tnCardActions" });
    const card = el("li", { class: `tnCard${key === this.selectedKey ? " selected" : ""}`, "data-key": key }, head, quote, comment, actions);
    this.cards.set(key, { card, entry, state, comment, actions });
    this.showComment(key);
    return card;
  }

  /** コメントの欄に，今のコメント（翻訳中なら届いた分の訳）を出す． */
  showComment(key, job = this.jobFor(key)) {
    const c = this.cards.get(key);
    if (!c || this.editing === key) return;
    const streaming = job?.status === "running" && job.output;
    const text = streaming ? job.output : c.entry.comment;
    c.comment.textContent = text || "Add comment…";
    c.comment.classList.toggle("empty", !text);
    c.comment.classList.toggle("streaming", !!streaming);
  }

  /** 翻訳の列が変わったら呼ぶ：カードの状態と，届いた分の訳を描き直す（一覧は作り直さない）． */
  updateJobs() {
    let missing = false;
    for (const j of this.ctx.queue.jobs) {
      if (j.meta.kind === "auto" && !j.finished && j.meta.target && !this.cards.has(this.ctx.bridge.keyOf(j.meta.target))) missing = true;
    }
    if (missing && !this.loading) this.invalidate(); // まだ一覧にないハイライトの翻訳が始まった
    for (const [key, c] of this.cards) {
      const job = this.jobFor(key);
      const status = job?.status;
      c.state.textContent = STATE_LABEL[status] ?? "";
      c.state.className = `tnCardState ${status ?? ""}`;
      c.card.classList.toggle("busy", status === "queued" || status === "running");
      c.card.classList.toggle("failed", status === "error");
      const buttons = [];
      if (status === "queued" || status === "running") buttons.push(this.link("Cancel", () => job.cancel()));
      if (status === "error") {
        buttons.push(el("span", { class: "tnCardError", text: job.error || "Translation failed" }));
        buttons.push(this.link("Retry", () => job.retry()));
        buttons.push(this.link("Edit", () => this.ctx.openEditor(job)));
      }
      c.actions.replaceChildren(...buttons);
      this.showComment(key, job);
    }
  }

  link(text, onclick) {
    return el("button", { class: "tnLink", type: "button", onclick }, text);
  }

  /** そのハイライトのカードを選んだ状態にし，見える位置まで動かす（null なら選びを外す）． */
  select(target) {
    const key = target ? this.ctx.bridge.keyOf(target) : null;
    this.selectedKey = key;
    for (const [k, c] of this.cards) c.card.classList.toggle("selected", k === key);
    if (key) this.cards.get(key)?.card.scrollIntoView({ block: "nearest" });
  }

  /** コメントをその場で直す（Ctrl+Enter か外を押すと保存，Esc で取り消し）． */
  startEdit(key) {
    const c = this.cards.get(key);
    if (!c || this.editing) return;
    this.editing = key;
    const before = c.entry.comment || "";
    const area = el("textarea", { class: "tnField tnCardEditor", rows: "4", "aria-label": "Comment" });
    area.value = before;
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const text = area.value.trim();
      this.editing = null;
      area.replaceWith(c.comment);
      if (save && text !== before.trim()) {
        c.entry.comment = text;
        this.showComment(key);
        await this.ctx.saveComment(c.entry.target, text);
      } else {
        this.showComment(key);
      }
      if (this.pendingRender) this.render();
    };
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    area.addEventListener("blur", () => finish(true));
    c.comment.replaceWith(area);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }
}
