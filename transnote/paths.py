"""置き場所をまとめる．

ポータブルアプリなので，設定などは exe の横の data フォルダに置く（レジストリは使わない）．
  - 同梱物（pdf.js，web）：PyInstaller の exe なら sys._MEIPASS，開発時はプロジェクトのフォルダ．
  - データ（settings.json，backups，webview，ipc.json，log）：exe（開発時はプロジェクト）の横の data．
    そこに書き込めないときだけ %LOCALAPPDATA%\\PdfTransNote を使う．
  - 環境変数 PDFTRANSNOTE_DATA_DIR があれば，それを優先する（テスト用）．
"""

from __future__ import annotations

import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import APP_ID, PDFJS_VERSION


def is_frozen() -> bool:
    """PyInstaller で作った exe として動いているか．"""
    return bool(getattr(sys, "frozen", False))


def app_dir() -> Path:
    """exe のあるフォルダ（開発時はプロジェクトのフォルダ）．"""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def resource_dir() -> Path:
    """同梱物のフォルダ．"""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", app_dir()))
    return Path(__file__).resolve().parent.parent


def pdfjs_dir() -> Path:
    return resource_dir() / "vendor" / f"pdfjs-{PDFJS_VERSION}-dist"


def web_dir() -> Path:
    return resource_dir() / "web"


def _writable(folder: Path) -> bool:
    """folder を作り，中に一時ファイルを書けるか．"""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=folder, prefix=".write-test-", delete=True):
            pass
        return True
    except OSError:
        return False


@dataclass(frozen=True)
class DataDir:
    path: Path
    portable: bool  # exe の横に置けたか（False なら代わりの場所）

    @property
    def settings(self) -> Path:
        return self.path / "settings.json"

    @property
    def backups(self) -> Path:
        return self.path / "backups"

    @property
    def webview(self) -> Path:
        return self.path / "webview"

    @property
    def ipc(self) -> Path:
        return self.path / "ipc.json"

    @property
    def log(self) -> Path:
        return self.path / "transnote.log"


def data_dir(base: Path | None = None) -> DataDir:
    """データの置き場所を決める．base は exe のフォルダの代わり（テスト用）．"""
    override = os.environ.get("PDFTRANSNOTE_DATA_DIR")
    if override:
        p = Path(override)
        p.mkdir(parents=True, exist_ok=True)
        return DataDir(p, True)
    portable = (base or app_dir()) / "data"
    if _writable(portable):
        return DataDir(portable, True)
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    fallback = Path(local) / APP_ID
    fallback.mkdir(parents=True, exist_ok=True)
    return DataDir(fallback, False)
