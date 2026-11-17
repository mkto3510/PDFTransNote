# PyInstaller のビルド設定．実行：.venv\Scripts\pyinstaller --noconfirm --clean PdfTransNote.spec
# 一つのフォルダにまとめる（--onedir 相当）．--onefile は起動のたびに展開するので遅い．
# pdf.js の配布物と web/ を同梱する．pdf.js のソースマップ（*.map）と見本の PDF は入れない．

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH)
PDFJS = "vendor/pdfjs-6.5.438-dist"


def tree(src, dest, exclude_suffixes=(".map",), exclude_names=("compressed.tracemonkey-pldi-09.pdf",)):
    out = []
    base = ROOT / src
    for p in base.rglob("*"):
        if p.is_file() and p.suffix not in exclude_suffixes and p.name not in exclude_names:
            out.append((str(p), str(Path(dest) / p.relative_to(base).parent)))
    return out


datas = tree(PDFJS, PDFJS) + tree("web", "web") + collect_data_files("webview")

a = Analysis(
    ["PdfTransNote.py"],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=["clr", "webview.platforms.edgechromium", "webview.platforms.winforms"],
    excludes=["tkinter", "unittest", "pydoc", "test"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PdfTransNote",
    icon=str(ROOT / "assets" / "PdfTransNote.ico"),
    version=str(ROOT / "assets" / "version_info.txt"),
    console=False,
    disable_windowed_traceback=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="PdfTransNote", upx=False)
