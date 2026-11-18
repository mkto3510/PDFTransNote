"""PDF TransNote の本体：ウインドウ（pywebview＋Edge WebView2）とローカルサーバーを動かす．

使い方：PdfTransNote.exe [PDF のパス ...]
  - 同時に一つだけ動かす．二つ目の起動は，動いている方に「このファイルを開く」と伝えて終わる．
    連絡には 127.0.0.1 の multiprocessing.connection を使い，ポートと鍵は data/ipc.json に置く．
  - PDF ごとにウインドウを開く．保存していない変更があれば，閉じる前に確認する．
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import secrets
import sys
import threading
from logging.handlers import RotatingFileHandler
from multiprocessing.connection import Client, Listener
from pathlib import Path
from typing import Any

from . import APP_NAME, VERSION
from . import paths
from . import settings as settings_mod
from .i18n import tr
from .server import TransNoteServer

log = logging.getLogger("transnote")

DEBUG = os.environ.get("PDFTRANSNOTE_DEBUG") == "1" or "--debug" in sys.argv


def _ui_lang(settings_path: Path | None = None) -> str:
    """いまの設定の画面の言語（設定が変わることがあるので，表示のたびに読む）．"""
    try:
        return settings_mod.load(settings_path or paths.data_dir().settings).get("uiLang", "en")
    except Exception:  # noqa: BLE001
        return "en"


def _message_box(text: str) -> None:
    """pywebview が使えないときの知らせ（Windows の標準のメッセージボックス）．"""
    try:
        ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x10)
    except Exception:  # noqa: BLE001
        print(text, file=sys.stderr)


# インストーラー（installer/PdfTransNote.iss の AppMutex）が「動いているか」を調べるための名前付きミューテックス
APP_MUTEX = "PdfTransNote.AppMutex"


def _hold_app_mutex() -> int | None:
    """APP_MUTEX を作って持ち続ける（プロセスが終わると OS が閉じる）．"""
    try:
        return ctypes.windll.kernel32.CreateMutexW(None, False, APP_MUTEX) or None
    except Exception:  # noqa: BLE001
        return None


def _pdf_args(argv: list[str]) -> list[str]:
    out = []
    for a in argv:
        if a.startswith("--"):
            continue
        p = Path(a)
        if p.is_file():
            out.append(str(p.resolve()))
    return out


# ---------------------------------------------------------------------------
# 同時に一つだけ動かす
# ---------------------------------------------------------------------------


def send_to_running(ipc_file: Path, pdfs: list[str]) -> bool:
    """動いている PDF TransNote があれば，開くファイルを渡して True を返す．"""
    try:
        info = json.loads(ipc_file.read_text(encoding="utf-8"))
        conn = Client(("127.0.0.1", int(info["port"])), authkey=bytes.fromhex(info["key"]))
    except (OSError, ValueError, KeyError, EOFError):
        return False
    try:
        conn.send({"cmd": "open", "paths": pdfs})
        return conn.recv() == "ok"
    except (OSError, EOFError):
        return False
    finally:
        conn.close()


class IpcListener:
    """二つ目以降の起動から「このファイルを開く」を受け取る．"""

    def __init__(self, ipc_file: Path, on_open) -> None:
        self.ipc_file = ipc_file
        self.on_open = on_open
        key = secrets.token_bytes(32)
        self.listener = Listener(("127.0.0.1", 0), authkey=key)
        port = self.listener.address[1]
        ipc_file.write_text(json.dumps({"port": port, "key": key.hex(), "pid": os.getpid()}), encoding="utf-8")
        threading.Thread(target=self._loop, name="transnote-ipc", daemon=True).start()

    def _loop(self) -> None:
        while True:
            try:
                conn = self.listener.accept()
            except OSError:
                return  # 閉じた
            except Exception:  # noqa: BLE001  鍵の違う接続など
                log.warning("ipc: rejected a connection", exc_info=DEBUG)
                continue
            try:
                msg = conn.recv()
                if isinstance(msg, dict) and msg.get("cmd") == "open":
                    self.on_open([str(p) for p in msg.get("paths", [])])
                conn.send("ok")
            except Exception:  # noqa: BLE001
                log.exception("ipc: failed")
            finally:
                conn.close()

    def close(self) -> None:
        try:
            self.listener.close()
        finally:
            try:
                info = json.loads(self.ipc_file.read_text(encoding="utf-8"))
                if info.get("pid") == os.getpid():
                    self.ipc_file.unlink()
            except (OSError, ValueError):
                pass


# ---------------------------------------------------------------------------
# ウインドウ
# ---------------------------------------------------------------------------


class Api:
    """画面（JS）から呼ぶ機能．ウインドウごとに 1 つ作る（window.pywebview.api）．"""

    def __init__(self, app: "TransNoteApp") -> None:
        self._app = app
        self._window = None
        self._dirty = False
        self._has_doc = False

    # pywebview は公開属性を JS に出すので，内部の値は _ で始める
    def info(self) -> dict[str, Any]:
        dd = self._app.data
        return {"app": APP_NAME, "version": VERSION, "dataDir": str(dd.path), "portable": dd.portable}

    def set_dirty(self, dirty: bool) -> None:
        self._dirty = bool(dirty)

    def open_dialog(self) -> int:
        """ファイルを選ぶダイアログを出し，選んだ PDF を開く．開いた数を返す．"""
        import webview

        lang = _ui_lang(self._app.data.settings)
        result = self._window.create_file_dialog(
            webview.FileDialog.OPEN,
            allow_multiple=True,
            file_types=(tr(lang, "PDF files (*.pdf)"), tr(lang, "All files (*.*)")),
        )
        files = [str(p) for p in (result or [])]
        self._app.open_paths(files, reuse=self if not self._has_doc else None)
        return len(files)

    def save_as_dialog(self, doc_token: str) -> str | None:
        """「名前を付けて保存」のダイアログを出す．選んだ行き先をサーバーに登録し，書き込み用のトークンを返す．

        行き先は開いている PDF と同じフォルダ・同じ名前から始める．取り消したら None．
        """
        import webview

        doc = self._app.server.registry.get(str(doc_token or ""))
        lang = _ui_lang(self._app.data.settings)
        result = self._window.create_file_dialog(
            webview.FileDialog.SAVE,
            directory=str(doc.path.parent) if doc else "",
            save_filename=doc.name if doc else "document.pdf",
            file_types=(tr(lang, "PDF files (*.pdf)"),),
        )
        if not result:
            return None
        path = result if isinstance(result, str) else result[0]
        if not path:
            return None
        if not path.lower().endswith(".pdf"):
            path += ".pdf"
        return self._app.server.registry.register_target(path)

    def open_dropped(self, names: list[str]) -> int:
        """ウインドウにドロップされたファイルを開く．

        WebView2 は，ドロップされたファイルの本当のパスを postMessageWithAdditionalObjects で
        ホスト側に渡す．pywebview はそれを webview.dom._dnd_state に溜めるので，そこから名前で取り出す．
        （pywebview 6.2 の内部の仕組みに頼っている．版を上げたら確かめること）
        """
        from webview.dom import _dnd_state

        found = []
        for name in names:
            for item in list(_dnd_state["paths"]):
                if os.path.basename(item[1]) == name or item[0] == name:
                    found.append(item[1])
                    _dnd_state["paths"].remove(item)
                    break
        pdfs = [p for p in found if p.lower().endswith(".pdf") and Path(p).is_file()]
        self._app.open_paths(pdfs, reuse=self if not self._has_doc else None)
        return len(pdfs)


class TransNoteApp:
    def __init__(self) -> None:
        self.data = paths.data_dir()
        self.server: TransNoteServer | None = None
        self.ipc: IpcListener | None = None
        self._mutex: int | None = None
        self._started = threading.Event()
        self._windows_lock = threading.Lock()

    def _setup_logging(self) -> None:
        handler = RotatingFileHandler(self.data.log, maxBytes=512 * 1024, backupCount=1, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root = logging.getLogger()
        root.addHandler(handler)
        root.setLevel(logging.DEBUG if DEBUG else logging.INFO)

    def open_paths(self, pdfs: list[str], reuse: Api | None = None) -> None:
        """PDF を開く．reuse に空のウインドウの Api を渡すと，最初の 1 つはそこに読み込む．"""
        for i, p in enumerate(pdfs):
            try:
                doc = self.server.registry.register(p)
            except OSError as e:
                log.warning("cannot open %s: %s", p, e)
                continue
            url = self.server.viewer_url(doc)
            title = f"{doc.name} - {APP_NAME}"
            if i == 0 and reuse is not None and reuse._window is not None:
                reuse._has_doc = True
                reuse._window.set_title(title)
                reuse._window.load_url(url)
            else:
                self._create_window(url, title, has_doc=True)

    def _create_window(self, url: str, title: str, has_doc: bool):
        import webview

        api = Api(self)
        api._has_doc = has_doc
        window = webview.create_window(
            title,
            url,
            js_api=api,
            width=1280,
            height=900,
            min_size=(640, 480),
            text_select=True,
            confirm_close=False,
        )
        api._window = window

        def on_closing():
            if api._dirty:
                return window.create_confirmation_dialog(
                    APP_NAME,
                    tr(
                        _ui_lang(self.data.settings),
                        "There are unsaved changes or translations in progress. Close anyway?",
                    ),
                )
            return True

        window.events.closing += on_closing
        return window

    def run(self, argv: list[str]) -> int:
        pdfs = _pdf_args(argv[1:])
        if send_to_running(self.data.ipc, pdfs):
            return 0
        self._mutex = _hold_app_mutex()
        self._setup_logging()
        log.info("%s %s start (data=%s, portable=%s)", APP_NAME, VERSION, self.data.path, self.data.portable)

        try:
            import webview
            from webview.dom import _dnd_state
        except Exception as e:  # noqa: BLE001
            _message_box(tr(_ui_lang(self.data.settings), f"Could not load the window component (pywebview).\n{e}"))
            return 1

        self.server = TransNoteServer(
            pdfjs_dir=paths.pdfjs_dir(),
            web_dir=paths.web_dir(),
            settings_path=self.data.settings,
            backups_dir=self.data.backups,
        )
        self.server.start_in_thread()
        self.ipc = IpcListener(self.data.ipc, lambda ps: self.open_paths(ps))

        # ドロップされたファイルのパスを WebView2 から受け取るようにする（Api.open_dropped を参照）
        _dnd_state["num_listeners"] += 1

        if pdfs:
            self.open_paths(pdfs)
        else:
            self._create_window(self.server.viewer_url(None), APP_NAME, has_doc=False)

        try:
            webview.start(
                gui="edgechromium",
                private_mode=False,
                storage_path=str(self.data.webview),
                debug=DEBUG,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("webview failed")
            _message_box(
                tr(_ui_lang(self.data.settings), "Could not open the window. Check that the Microsoft Edge WebView2 Runtime is installed.\n\n"
                f"{e}")
            )
            return 1
        finally:
            if self.ipc:
                self.ipc.close()
            self.server.shutdown()
            self.server.server_close()
            log.info("exit")
        return 0


def main() -> int:
    return TransNoteApp().run(sys.argv)
