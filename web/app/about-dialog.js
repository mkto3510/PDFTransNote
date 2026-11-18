import { getAbout, getLicenses } from "./api.js";
import { el } from "./dom.js";
import { t } from "./i18n.mjs";

export class AboutDialog {
  constructor() {
    this.version = el("p", { role: "status" });
    this.licenseList = el("div");
    const licenses = el("details", { ontoggle: () => this.loadLicenses(licenses) },
      el("summary", { text: t("about.licenses") }), this.licenseList);
    const source = el("a", {
      href: "https://github.com/mkto3510/PDFTransNote", target: "_blank", rel: "noopener noreferrer",
      text: t("about.source"),
    });
    this.dialog = el("dialog", { id: "tnAbout", "aria-labelledby": "tnAboutTitle" },
      el("h2", { id: "tnAboutTitle", text: t("about.title") }),
      this.version,
      el("p", { text: t("about.summary") }),
      el("p", {}, source),
      licenses,
      el("form", { method: "dialog" }, el("button", { class: "tnBtn", autofocus: true, text: t("about.close") })),
    );
    for (const type of ["keydown", "keyup"]) this.dialog.addEventListener(type, (event) => event.stopPropagation());
    document.body.append(this.dialog);
  }

  async open() {
    this.dialog.showModal();
    if (this.info) return;
    this.version.textContent = t("about.loading");
    try {
      this.info = await getAbout();
      this.version.textContent = `${this.info.app} ${this.info.version} · PDF.js ${this.info.pdfjsVersion}`;
    } catch {
      this.version.textContent = t("about.unavailable");
    }
  }

  async loadLicenses(details) {
    if (!details.open || this.licenses || this.loadingLicenses) return;
    this.loadingLicenses = true;
    this.licenseList.textContent = t("about.loading");
    try {
      this.licenses = await getLicenses();
      this.licenseList.replaceChildren(...this.licenses.map(({ name, text }) =>
        el("details", {}, el("summary", { text: name }), el("pre", { text, tabindex: "0" }))));
    } catch {
      this.licenseList.textContent = t("about.unavailable");
    } finally {
      this.loadingLicenses = false;
    }
  }
}
