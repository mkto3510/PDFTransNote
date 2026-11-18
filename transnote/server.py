"""127.0.0.1 だけで動く小さな HTTP サーバー．

役割
  1. pdf.js と自作の画面（web/）を配る．viewer.html には自作の CSS・JS と接続用のトークンを差し込む．
  2. GET  /doc/<文書トークン>/<ファイル名>：開いた PDF を渡す（Range 要求に対応）．
  3. PUT  /doc/<文書トークン>/<ファイル名>：注釈を入れた PDF を元の場所に保存する．
     初めて上書きする前に data/backups に複製し，一時ファイルを経由して置き換える．
  3b. PUT /save-as/<行き先トークン>：「名前を付けて保存」．行き先はウインドウ側のファイルのダイアログで選んだものだけ
     （Api.save_as_dialog が DocRegistry.register_target で登録する．1 回だけ使える）．
  4. GET/PUT /api/settings：設定の読み書き．
  5. /llm/…：設定に登録した翻訳サービスへの中継（応答は少しずつそのまま返す）．
     POST /llm/chat?service=<id>   chat/completions（サービスのエンドポイントにだけ送り，API キーを付ける）
     GET  /llm/models?service=<id> モデル一覧
     POST /llm/models             接続テスト（本文の endpoint と apiKey で一覧を読む）
     画面から直接送らないので，LM Studio 側で CORS を有効にしなくてよい．

守り
  - Host ヘッダーが 127.0.0.1／localhost のこのポートでなければ断る（DNS リバインディング対策）．
  - 2〜5 の書き込みと中継は，起動ごとに作る秘密の値（X-TransNote-Token ヘッダー）がなければ断る．
    このヘッダーを付けた他サイトからの要求は事前確認（CORS）で止まり，このサーバーは許可を返さない．
  - PDF の読み出しは，推測できない文書トークンを知っているときだけできる．
  - 登録した PDF のパスにしか触れない．同梱物の配布はフォルダの外に出られない．
"""

from __future__ import annotations

import hmac
import http.client
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

from . import APP_NAME, PDFJS_VERSION, VERSION, paths
from . import settings as settings_mod
from .i18n import normalize_lang, tr

log = logging.getLogger(__name__)

TOKEN_HEADER = "X-TransNote-Token"
FORCE_HEADER = "X-TransNote-Force"
LANG_HEADER = "X-TransNote-Lang"
MAX_PDF_BYTES = 2 * 1024**3  # 保存を受け付ける大きさの上限（2 GiB）
MAX_JSON_BYTES = 4 * 1024**2
CHUNK = 1024 * 1024

MIME_OVERRIDES = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".ftl": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".icc": "application/vnd.iccprofile",
    ".map": "application/json",
    ".pdf": "application/pdf",
}

VIEWER_SCRIPT_TAG = '<script src="viewer.mjs" type="module"></script>'


@dataclass
class Doc:
    token: str
    path: Path
    name: str
    mtime_ns: int
    size: int
    backed_up: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def url(self) -> str:
        """viewer.html の file= に渡す，同じサーバーの中の URL．"""
        return f"/doc/{self.token}/{quote(self.name)}"


class DocRegistry:
    """開いた PDF のパスと文書トークンの対応．"""

    def __init__(self) -> None:
        self._docs: dict[str, Doc] = {}
        self._targets: dict[str, Path] = {}  # 「名前を付けて保存」の行き先（1 回だけ使える）
        self._lock = threading.Lock()

    def register_target(self, path: str | os.PathLike) -> str:
        """「名前を付けて保存」で選ばれた行き先を登録し，1 回だけ使えるトークンを返す．

        行き先はウインドウ側（Api.save_as_dialog）がファイルのダイアログで選んだものだけ．画面からは登録できない．
        """
        p = Path(path).resolve()
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._targets[token] = p
        return token

    def take_target(self, token: str) -> Path | None:
        with self._lock:
            return self._targets.pop(token, None)

    def doc_at(self, path: Path) -> Doc | None:
        """そのパスで開いている文書（なければ None）．"""
        with self._lock:
            for d in self._docs.values():
                if d.path == path:
                    return d
        return None

    def register(self, path: str | os.PathLike) -> Doc:
        p = Path(path).resolve()
        st = p.stat()
        if not p.is_file():
            raise FileNotFoundError(p)
        doc = Doc(secrets.token_urlsafe(24), p, p.name, st.st_mtime_ns, st.st_size)
        with self._lock:
            self._docs[doc.token] = doc
        return doc

    def get(self, token: str) -> Doc | None:
        with self._lock:
            return self._docs.get(token)

    def unregister(self, token: str) -> None:
        with self._lock:
            self._docs.pop(token, None)


class TransNoteServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        *,
        pdfjs_dir: Path,
        web_dir: Path,
        settings_path: Path,
        backups_dir: Path,
        port: int = 0,
        upstream_timeout: float = 600.0,
    ) -> None:
        super().__init__(("127.0.0.1", port), Handler)
        self.pdfjs_dir = Path(pdfjs_dir).resolve()
        self.web_dir = Path(web_dir).resolve()
        self.settings_path = Path(settings_path)
        self.backups_dir = Path(backups_dir)
        self.upstream_timeout = upstream_timeout
        self.secret = secrets.token_urlsafe(32)
        self.registry = DocRegistry()
        self._settings_lock = threading.Lock()

    @property
    def port(self) -> int:
        return self.server_address[1]

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def viewer_url(self, doc: Doc | None) -> str:
        url = f"{self.origin}/pdfjs/web/viewer.html"
        if doc is None:
            return url + "?file="
        return url + "?file=" + quote(doc.url, safe="")

    # --- 設定 ---
    def read_settings(self) -> dict[str, Any]:
        with self._settings_lock:
            return settings_mod.load(self.settings_path)

    def write_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        with self._settings_lock:
            return settings_mod.save(self.settings_path, values)

    def start_in_thread(self) -> threading.Thread:
        t = threading.Thread(target=self.serve_forever, name="transnote-server", daemon=True)
        t.start()
        return t


class HttpError(Exception):
    def __init__(self, status: int, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def _safe_join(root: Path, rel: str) -> Path:
    """root の中のファイルだけを返す（.. などでフォルダの外に出さない）．"""
    rel = unquote(rel).replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise HttpError(403, "forbidden")
    if not target.is_file():
        raise HttpError(404, "not found")
    return target


def _content_type(path: Path) -> str:
    ext = path.suffix.lower()
    return MIME_OVERRIDES.get(ext) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Range ヘッダー（1 区間だけ）を [start, end]（end を含む）にする．なければ None．"""
    if not header:
        return None
    m = _RANGE_RE.match(header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        raise HttpError(416, "bad range")
    if m.group(1):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    else:  # 末尾から n バイト
        n = int(m.group(2))
        start, end = max(size - n, 0), size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        raise HttpError(416, "range not satisfiable")
    return start, end


class Handler(BaseHTTPRequestHandler):
    server: TransNoteServer
    protocol_version = "HTTP/1.1"
    server_version = f"{APP_NAME.replace(' ', '')}/{VERSION}"

    # 既定の記録（標準エラー出力）は使わない．exe では出力先がないため．
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        log.debug("%s - %s", self.address_string(), format % args)

    # --- 入口 ---
    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_OPTIONS(self) -> None:
        # CORS の事前確認には許可を返さない（他サイトからの書き込みを止める）
        self._dispatch("OPTIONS")

    def _dispatch(self, method: str) -> None:
        try:
            self._check_host()
            path = urlsplit(self.path).path
            if method == "OPTIONS":
                raise HttpError(403, "forbidden")
            if path.startswith("/pdfjs/") and method in {"GET", "HEAD"}:
                return self._static(self.server.pdfjs_dir, path[len("/pdfjs/") :], method)
            if path.startswith("/transnote/") and method in {"GET", "HEAD"}:
                return self._static(self.server.web_dir, path[len("/transnote/") :], method)
            if path.startswith("/doc/"):
                token = path[len("/doc/") :].split("/", 1)[0]
                doc = self.server.registry.get(token)
                if doc is None:
                    raise HttpError(404, "unknown document")
                if method in {"GET", "HEAD"}:
                    return self._send_doc(doc, method)
                if method == "PUT":
                    self._check_token()
                    return self._save_doc(doc)
            if path.startswith("/save-as/") and method == "PUT":
                self._check_token()
                return self._save_as(path[len("/save-as/") :].split("/", 1)[0])
            if path == "/api/settings":
                self._check_token()
                if method == "GET":
                    return self._settings_get()
                if method == "PUT":
                    return self._settings_put()
            if path.startswith("/llm/"):
                self._check_token()
                return self._llm(path, method)
            if path == "/api/ping" and method == "GET":
                return self._json(200, {"app": APP_NAME, "version": VERSION, "pdfjsVersion": PDFJS_VERSION})
            if path == "/api/about/licenses" and method == "GET":
                self._check_token()
                return self._about_licenses()
            raise HttpError(404, "not found")
        except HttpError as e:
            self._json(e.status, {"error": tr(self._lang(), e.message), **e.extra})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # 画面側が読み込みを止めた（ページ移動など）
        except Exception as e:  # noqa: BLE001
            log.exception("request failed: %s %s", method, self.path)
            try:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            except OSError:
                pass

    def _lang(self) -> str:
        """画面の言語（X-TransNote-Lang ヘッダー．ないとき・知らない値は en）．"""
        return normalize_lang(self.headers.get(LANG_HEADER))

    # --- 守り ---
    def _check_host(self) -> None:
        host = (self.headers.get("Host") or "").lower()
        allowed = {f"127.0.0.1:{self.server.port}", f"localhost:{self.server.port}"}
        if host not in allowed:
            raise HttpError(403, "bad host")

    def _check_token(self) -> None:
        got = self.headers.get(TOKEN_HEADER) or ""
        if not hmac.compare_digest(got.encode(), self.server.secret.encode()):
            raise HttpError(403, "bad token")

    # --- 応答の部品 ---
    def _json(self, status: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status >= 400:
            # 読み残した本文が次の要求に混ざらないよう，誤りのときは接続を閉じる
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError as e:
            raise HttpError(411, "bad length") from e
        if length <= 0:
            raise HttpError(411, "empty body")
        if length > limit:
            raise HttpError(413, "too large")
        chunks, left = [], length
        while left:
            data = self.rfile.read(min(left, CHUNK))
            if not data:
                raise HttpError(400, "incomplete body")
            chunks.append(data)
            left -= len(data)
        return b"".join(chunks)

    # --- 同梱物 ---
    def _static(self, root: Path, rel: str, method: str) -> None:
        target = _safe_join(root, rel)
        if root == self.server.pdfjs_dir and rel == "web/viewer.html":
            body = self._viewer_html(target)
        else:
            body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", _content_type(target))
        self.send_header("Content-Length", str(len(body)))
        # 自作の画面（web/）は残さない（書き換えた後に古いモジュールが使われないように）．pdf.js の配布物は確かめてから使う．
        self.send_header("Cache-Control", "no-store" if root == self.server.web_dir else "no-cache")
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(body)

    def _viewer_html(self, path: Path) -> bytes:
        """pdf.js の viewer.html に，自作の CSS・JS と接続用のトークンを差し込む．

        自作の JS は viewer.mjs より前に置く．module のスクリプトは書いた順に動くので，
        pdf.js の起動（webviewerloaded）より先に設定を差し込める．
        """
        html = path.read_text(encoding="utf-8")
        # 画面の言語は起動の前に決める（PDF.js は起動のときに言語を読み込む）
        ui_lang = self.server.read_settings().get("uiLang", "en")
        if ui_lang not in settings_mod.UI_LANGS:
            ui_lang = "en"
        inject = (
            f'<meta name="transnote-token" content="{self.server.secret}" />\n'
            f'    <meta name="transnote-ui-lang" content="{ui_lang}" />\n'
            '    <link rel="stylesheet" href="/transnote/pdfjs/overrides.css" />\n'
            '    <link rel="stylesheet" href="/transnote/app/app.css" />\n'
            '    <script src="/transnote/app/main.js" type="module"></script>\n    '
        )
        if VIEWER_SCRIPT_TAG not in html:
            raise HttpError(500, "viewer.html has an unexpected structure (check the pdf.js version)")
        html = html.replace(VIEWER_SCRIPT_TAG, inject + VIEWER_SCRIPT_TAG, 1)
        return html.encode("utf-8")

    # --- PDF の読み出し ---
    def _send_doc(self, doc: Doc, method: str) -> None:
        size = doc.path.stat().st_size
        rng = _parse_range(self.headers.get("Range"), size)
        start, end = rng if rng else (0, size - 1)
        length = end - start + 1 if size else 0
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if method == "HEAD" or not length:
            return
        with doc.path.open("rb") as f:
            f.seek(start)
            left = length
            while left:
                data = f.read(min(left, CHUNK))
                if not data:
                    break
                self.wfile.write(data)
                left -= len(data)

    # --- PDF の保存 ---
    def _save_doc(self, doc: Doc) -> None:
        body = self._read_body(MAX_PDF_BYTES)
        if not body.startswith(b"%PDF-"):
            raise HttpError(400, "Not a PDF")
        force = (self.headers.get(FORCE_HEADER) or "") == "1"
        keep = self.server.read_settings().get("backupCount", settings_mod.DEFAULTS["backupCount"])
        with doc.lock:
            backup = save_pdf(doc, body, self.server.backups_dir, force=force, keep=keep)
        self._json(200, {"ok": True, "size": len(body), "backup": str(backup) if backup else None})

    def _save_as(self, token: str) -> None:
        """「名前を付けて保存」：Api.save_as_dialog が登録した行き先に書く（行き先は 1 回だけ使える）．"""
        body = self._read_body(MAX_PDF_BYTES)
        target = self.server.registry.take_target(token)
        if target is None:
            raise HttpError(404, "unknown document")
        if not body.startswith(b"%PDF-"):
            raise HttpError(400, "Not a PDF")
        same = self.server.registry.doc_at(target)
        if same is not None:
            # 開いている PDF そのものを選んだ：上書き保存と同じく，バックアップを取ってから書く
            keep = self.server.read_settings().get("backupCount", settings_mod.DEFAULTS["backupCount"])
            with same.lock:
                save_pdf(same, body, self.server.backups_dir, force=True, keep=keep)
        else:
            write_atomic(target, body)
        self._json(200, {"ok": True, "size": len(body), "name": target.name, "original": same is not None})

    # --- 設定 ---
    def _about_licenses(self) -> None:
        root = paths.app_dir()
        bundled = root / "LICENSES"
        app_license = root / ("LICENSE.txt" if paths.is_frozen() else "LICENSE")
        files = [("GPL-3.0-or-later", app_license)]
        if bundled.is_dir():
            files.extend((file.name, file) for file in sorted(bundled.glob("*.txt")))
        else:
            files.append(("PDF.js (Apache-2.0)", self.server.pdfjs_dir / "LICENSE"))
        licenses = [{"name": name, "text": file.read_text(encoding="utf-8", errors="replace")}
                    for name, file in files if file.is_file()]
        self._json(200, {"licenses": licenses})

    def _settings_get(self) -> None:
        self._json(
            200,
            {
                "settings": self.server.read_settings(),
                "defaults": settings_mod.defaults(),
                "app": {"name": APP_NAME, "version": VERSION},
            },
        )

    def _settings_put(self) -> None:
        try:
            values = json.loads(self._read_body(MAX_JSON_BYTES).decode("utf-8"))
        except ValueError as e:
            raise HttpError(400, f"Cannot read JSON: {e}") from e
        if not isinstance(values, dict):
            raise HttpError(400, "Invalid JSON structure")
        try:
            saved = self.server.write_settings(values)
        except settings_mod.SettingsError as e:
            raise HttpError(400, str(e)) from e
        self._json(200, {"settings": saved})

    # --- 翻訳サービスへの中継 ---
    def _llm(self, path: str, method: str) -> None:
        query = parse_qs(urlsplit(self.path).query)
        if path == "/llm/models" and method == "POST":
            # 接続テスト：まだ保存していない入力でも試せるよう，本文のエンドポイントとキーを使う
            try:
                req = json.loads(self._read_body(MAX_JSON_BYTES).decode("utf-8"))
                endpoint = settings_mod.check_endpoint(req.get("endpoint"))
            except (ValueError, AttributeError, settings_mod.SettingsError) as e:
                raise HttpError(400, f"Invalid endpoint: {e}") from e
            return self._forward("GET", settings_mod.models_url(endpoint), None, str(req.get("apiKey") or ""))
        sid = (query.get("service") or [""])[0]
        svc = settings_mod.service(self.server.read_settings(), sid)
        if svc is None:
            raise HttpError(404, f"Translation service \"{sid}\" is not registered")
        if path == "/llm/chat" and method == "POST":
            body = self._read_body(MAX_JSON_BYTES)
            return self._forward("POST", settings_mod.chat_url(svc["endpoint"]), body, svc["apiKey"])
        if path == "/llm/models" and method == "GET":
            return self._forward("GET", settings_mod.models_url(svc["endpoint"]), None, svc["apiKey"])
        raise HttpError(404, "not found")

    def _forward(self, method: str, url: str, body: bytes | None, api_key: str) -> None:
        """url に要求を送り，応答を少しずつそのまま返す（chunked）．"""
        parts = urlsplit(url)
        target = parts.path + (f"?{parts.query}" if parts.query else "")
        conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(parts.hostname, parts.port, timeout=10)
        try:
            try:
                conn.connect()
                conn.sock.settimeout(self.server.upstream_timeout)
                headers = {"Accept": "text/event-stream, application/json"}
                if body is not None:
                    headers["Content-Type"] = "application/json"
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                conn.request(method, target, body=body, headers=headers)
                resp = conn.getresponse()
            except OSError as e:
                raise HttpError(502, f"Cannot reach the translation server ({parts.scheme}://{parts.netloc}): {e}") from e
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.getheader("Content-Type") or "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                data = resp.read1(64 * 1024)
                if not data:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        finally:
            conn.close()


class ConflictError(HttpError):
    pass


def _prune_backups(folder: Path, keep: int) -> None:
    files = sorted((p for p in folder.glob("*.pdf") if p.is_file()), key=lambda p: p.stat().st_mtime)
    for old in files[: max(len(files) - keep, 0)]:
        try:
            old.unlink()
        except OSError:
            pass


def write_atomic(path: Path, data: bytes) -> None:
    """同じフォルダの一時ファイルに書いてから置き換える．置き換えられない（使用中）ときは 423．"""
    tmp = path.with_name(f".{path.name}.transnote-tmp")
    try:
        with tmp.open("wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.replace(tmp, path)
        except PermissionError as e:
            raise HttpError(423, "Cannot save because the file is in use by another app", reason="locked") from e
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def save_pdf(doc: Doc, data: bytes, backups_dir: Path, *, force: bool = False, keep: int = 5) -> Path | None:
    """data を doc.path に保存する．

    - 開いた後（または前回の保存の後）にほかのアプリがファイルを変えていたら，force でない限り 409．
    - この起動で初めて上書きするときは，元のファイルを backups_dir に複製し，
      backups_dir の中を新しいものから keep 個に減らす（すべての PDF をまとめて数える）．keep が 0 なら複製しない．
    - 同じフォルダの一時ファイルに書いてから置き換える．置き換えられない（使用中）ときは 423．
    戻り値：作ったバックアップのパス（作らなかったときは None）．
    """
    path = doc.path
    try:
        st = path.stat()
    except FileNotFoundError:
        st = None
    if st is not None and not force and (st.st_mtime_ns, st.st_size) != (doc.mtime_ns, doc.size):
        raise ConflictError(409, "Another app has changed the file", reason="changed")

    backup = None
    if st is not None and not doc.backed_up and keep > 0:
        backups_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = backups_dir / f"{path.stem}.{stamp}.pdf"
        n = 1
        while backup.exists():
            backup = backups_dir / f"{path.stem}.{stamp}-{n}.pdf"
            n += 1
        shutil.copy2(path, backup)
        doc.backed_up = True
        _prune_backups(backups_dir, keep)

    write_atomic(path, data)
    st = path.stat()
    doc.mtime_ns, doc.size = st.st_mtime_ns, st.st_size
    return backup
