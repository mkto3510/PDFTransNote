"""同梱するソフトのライセンス文を LICENSES/ に集める．

実行：.venv\\Scripts\\python -m tools.collect_licenses
exe（dist）とインストーラーの両方に，このフォルダを入れる．
"""

from __future__ import annotations

import shutil
import sys
from importlib import metadata
from pathlib import Path

from transnote import PDFJS_VERSION

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "LICENSES"

# (配布名, 表示名, ライセンス)
PACKAGES = [
    ("pywebview", "pywebview", "BSD-3-Clause"),
    ("pythonnet", "Python.NET（pythonnet）", "MIT"),
    ("clr_loader", "clr-loader", "MIT"),
    ("bottle", "Bottle", "MIT"),
    ("proxy_tools", "proxy_tools", "MIT"),
    ("cffi", "CFFI", "MIT-0"),
    ("pycparser", "pycparser", "BSD-3-Clause"),
    ("typing_extensions", "typing_extensions", "PSF-2.0"),
]


def _license_text(dist: str) -> str | None:
    d = metadata.distribution(dist)
    for f in d.files or []:
        name = f.name.lower()
        if name.startswith(("license", "copying", "notice")):
            return f.read_text(encoding="utf-8")
    meta = d.metadata.get("License")
    return meta if meta and len(meta) > 40 else None


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    rows = []

    pdfjs = ROOT / "vendor" / f"pdfjs-{PDFJS_VERSION}-dist" / "LICENSE"
    shutil.copy2(pdfjs, OUT / "pdf.js-LICENSE.txt")
    rows.append(f"| PDF.js {PDFJS_VERSION}（Mozilla） | Apache-2.0 | pdf.js-LICENSE.txt |")

    for dist, label, lic in PACKAGES:
        try:
            version = metadata.version(dist)
            text = _license_text(dist)
        except metadata.PackageNotFoundError:
            continue
        fname = f"{dist}-LICENSE.txt"
        if text:
            (OUT / fname).write_text(text, encoding="utf-8")
        else:
            fname = "（同梱の配布物にライセンス文なし．PyPI の記載による）"
        rows.append(f"| {label} {version} | {lic} | {fname} |")

    py_license = Path(sys.base_prefix) / "LICENSE.txt"
    if py_license.exists():
        shutil.copy2(py_license, OUT / "Python-LICENSE.txt")
        rows.append(f"| Python {sys.version.split()[0]} | PSF-2.0 | Python-LICENSE.txt |")

    rows.append(
        "| PyInstaller のブートローダー | GPL-2.0（ブートローダーの例外つき．同梱して配布してよい） | "
        "https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt |"
    )
    rows.append(
        "| Microsoft Edge WebView2 ランタイム | Windows に入っているものを使う（同梱しない） | — |"
    )

    readme = [
        "# 同梱しているソフトとライセンス",
        "",
        "PDF TransNote 本体のライセンスは GPL-3.0-or-later です（`LICENSE.txt`）．",
        "",
        "PDF TransNote は次のソフトを使っています．",
        "",
        "| ソフト | ライセンス | ファイル |",
        "|---|---|---|",
        *rows,
        "",
    ]
    (OUT / "README.md").write_text("\n".join(readme), encoding="utf-8")
    print(f"wrote {OUT} ({len(rows)} entries)")


if __name__ == "__main__":
    main()
