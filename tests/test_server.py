"""transnote.server・settings・paths のテスト．実行：.venv\\Scripts\\python -m unittest discover -s tests"""

from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from transnote import paths, settings
from transnote.server import TOKEN_HEADER, FORCE_HEADER, TransNoteServer

PDF_BYTES = b"%PDF-1.4\n" + bytes(range(256)) * 40 + b"\n%%EOF\n"


class FakeLLM(BaseHTTPRequestHandler):
    """少しずつ応答する試験用の翻訳サーバー．"""

    protocol_version = "HTTP/1.1"
    received: list = []

    def log_message(self, *args):  # noqa: D401
        pass

    def do_GET(self):
        FakeLLM.received.append((self.path, None, dict(self.headers)))
        body = json.dumps({"data": [{"id": "pfnet/plamo-3-translate-0.8b-gguf"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers["Content-Length"])
        FakeLLM.received.append((self.path, json.loads(self.rfile.read(length)), dict(self.headers)))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for piece in ("こん", "にちは"):
            line = f'data: {json.dumps({"choices": [{"delta": {"content": piece}}]}, ensure_ascii=False)}\n\n'.encode()
            self.wfile.write(b"%x\r\n%s\r\n" % (len(line), line))
            self.wfile.flush()
            time.sleep(0.05)
        end = b"data: [DONE]\n\n"
        self.wfile.write(b"%x\r\n%s\r\n0\r\n\r\n" % (len(end), end))


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.pdf = root / "論文 sample.pdf"
        self.pdf.write_bytes(PDF_BYTES)
        self.backups = root / "data" / "backups"
        self.settings_path = root / "data" / "settings.json"
        self.server = TransNoteServer(
            pdfjs_dir=paths.pdfjs_dir(),
            web_dir=paths.web_dir(),
            settings_path=self.settings_path,
            backups_dir=self.backups,
        )
        self.server.start_in_thread()
        self.doc = self.server.registry.register(self.pdf)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        h = {"Host": host or f"127.0.0.1:{self.server.port}"}
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp, data

    def auth(self, extra=None):
        h = {TOKEN_HEADER: self.server.secret}
        h.update(extra or {})
        return h

    # --- 読み出し ---
    def test_get_whole_and_range(self):
        resp, data = self.request("GET", self.doc.url)
        self.assertEqual(resp.status, 200)
        self.assertEqual(data, PDF_BYTES)
        self.assertEqual(resp.getheader("Accept-Ranges"), "bytes")

        resp, data = self.request("GET", self.doc.url, headers={"Range": "bytes=10-19"})
        self.assertEqual(resp.status, 206)
        self.assertEqual(data, PDF_BYTES[10:20])
        self.assertEqual(resp.getheader("Content-Range"), f"bytes 10-19/{len(PDF_BYTES)}")

        resp, data = self.request("GET", self.doc.url, headers={"Range": "bytes=-5"})
        self.assertEqual(data, PDF_BYTES[-5:])

        resp, _ = self.request("GET", self.doc.url, headers={"Range": f"bytes={len(PDF_BYTES) + 5}-"})
        self.assertEqual(resp.status, 416)

    def test_unknown_token_and_bad_host(self):
        resp, _ = self.request("GET", "/doc/nope/x.pdf")
        self.assertEqual(resp.status, 404)
        resp, _ = self.request("GET", self.doc.url, host="evil.example:80")
        self.assertEqual(resp.status, 403)

    def test_static_cannot_escape(self):
        resp, _ = self.request("GET", "/transnote/..%2F..%2Ftransnote%2Fserver.py")
        self.assertIn(resp.status, (403, 404))
        resp, _ = self.request("GET", "/pdfjs/../web/transnote-core.mjs")
        self.assertIn(resp.status, (403, 404))

    def test_viewer_injection(self):
        resp, data = self.request("GET", "/pdfjs/web/viewer.html")
        self.assertEqual(resp.status, 200)
        html = data.decode()
        self.assertIn(f'content="{self.server.secret}"', html)
        self.assertLess(html.index("/transnote/app/main.js"), html.index('src="viewer.mjs"'))
        self.assertIn("/transnote/app/app.css", html)
        self.assertIn("/transnote/pdfjs/overrides.css", html)
        for name in ("app/main.js", "app/app.css", "app/core.mjs", "app/jobs.mjs", "pdfjs/bridge.js", "pdfjs/overrides.css"):
            resp, _ = self.request("GET", f"/transnote/{name}")
            self.assertEqual(resp.status, 200, name)
        resp, _ = self.request("GET", "/transnote/app/core.mjs")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "text/javascript")

    # --- 保存 ---
    def test_save_requires_token(self):
        new = PDF_BYTES + b"% edited\n"
        resp, _ = self.request("PUT", self.doc.url, body=new)
        self.assertEqual(resp.status, 403)
        resp, _ = self.request("PUT", self.doc.url, body=new, headers={TOKEN_HEADER: "wrong"})
        self.assertEqual(resp.status, 403)
        self.assertEqual(self.pdf.read_bytes(), PDF_BYTES)
        resp, _ = self.request("OPTIONS", self.doc.url)
        self.assertEqual(resp.status, 403)
        self.assertIsNone(resp.getheader("Access-Control-Allow-Origin"))

    def test_save_backup_and_replace(self):
        new = PDF_BYTES + b"% edited\n"
        resp, data = self.request("PUT", self.doc.url, body=new, headers=self.auth())
        self.assertEqual(resp.status, 200, data)
        self.assertEqual(self.pdf.read_bytes(), new)
        backups = list(self.backups.glob("*.pdf"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), PDF_BYTES)
        self.assertEqual(list(self.pdf.parent.glob("*.transnote-tmp")), [])

        # 2 回目はバックアップを増やさない
        newer = new + b"% again\n"
        resp, _ = self.request("PUT", self.doc.url, body=newer, headers=self.auth())
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.pdf.read_bytes(), newer)
        self.assertEqual(len(list(self.backups.glob("*.pdf"))), 1)

    def test_save_rejects_non_pdf(self):
        resp, _ = self.request("PUT", self.doc.url, body=b"hello", headers=self.auth())
        self.assertEqual(resp.status, 400)
        self.assertEqual(self.pdf.read_bytes(), PDF_BYTES)

    def test_save_conflict_when_changed_elsewhere(self):
        time.sleep(0.02)
        self.pdf.write_bytes(PDF_BYTES + b"% other app\n")
        resp, data = self.request("PUT", self.doc.url, body=PDF_BYTES + b"% mine\n", headers=self.auth())
        self.assertEqual(resp.status, 409)
        self.assertEqual(json.loads(data)["reason"], "changed")
        resp, _ = self.request(
            "PUT", self.doc.url, body=PDF_BYTES + b"% mine\n", headers=self.auth({FORCE_HEADER: "1"})
        )
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.pdf.read_bytes(), PDF_BYTES + b"% mine\n")

    def test_save_locked_file(self):
        with mock.patch("transnote.server.os.replace", side_effect=PermissionError("locked")):
            resp, data = self.request("PUT", self.doc.url, body=PDF_BYTES + b"%x\n", headers=self.auth())
        self.assertEqual(resp.status, 423)
        self.assertEqual(json.loads(data)["reason"], "locked")
        self.assertEqual(self.pdf.read_bytes(), PDF_BYTES)
        self.assertEqual(list(self.pdf.parent.glob("*.transnote-tmp")), [])

    # --- 設定 ---
    def test_settings_roundtrip(self):
        resp, data = self.request("GET", "/api/settings")
        self.assertEqual(resp.status, 403)
        resp, data = self.request("GET", "/api/settings", headers=self.auth())
        self.assertEqual(resp.status, 200)
        got = json.loads(data)["settings"]
        self.assertEqual(got["activeService"], "plamo-0.8b")
        self.assertEqual(got["services"][0]["endpoint"], "http://localhost:1234")
        self.assertEqual(got["services"][0]["model"], "plamo-3-translate-0.8b")
        self.assertEqual(got["services"][0]["customParams"], {})

        lan = dict(got["services"][0], id="lan-8b", name="LAN 8B", endpoint="http://192.0.2.10:1234/v1",
                   model="plamo-3-translate-8b", temperature="0.2", customParams='{"max_tokens": 512}')
        new = dict(got, services=got["services"] + [lan], activeService="lan-8b")
        resp, data = self.request("PUT", "/api/settings", body=json.dumps(new).encode(), headers=self.auth())
        self.assertEqual(resp.status, 200, data)
        saved = json.loads(data)["settings"]
        self.assertEqual(saved["activeService"], "lan-8b")
        self.assertEqual(saved["services"][1]["temperature"], 0.2)
        self.assertEqual(saved["services"][1]["customParams"], {"max_tokens": 512})
        self.assertEqual(settings.load(self.settings_path), saved)

        for bad, word in (
            (dict(lan, prompt="translate"), "${sourceText}"),
            (dict(lan, endpoint="ftp://x"), "http://"),
            (dict(lan, customParams="{broken"), "JSON"),
            (dict(lan, customParams="[1, 2]"), "JSON object"),
            (dict(lan, name=""), "Enter a name"),
        ):
            body = json.dumps(dict(saved, services=[saved["services"][0], bad])).encode()
            resp, data = self.request("PUT", "/api/settings", body=body, headers=self.auth())
            self.assertEqual(resp.status, 400, word)
            self.assertIn(word, json.loads(data)["error"])
        body = json.dumps(dict(saved, activeService="missing")).encode()
        resp, _ = self.request("PUT", "/api/settings", body=body, headers=self.auth())
        self.assertEqual(resp.status, 400)

    # --- 中継 ---
    def _with_llm(self):
        llm = ThreadingHTTPServer(("127.0.0.1", 0), FakeLLM)
        threading.Thread(target=llm.serve_forever, daemon=True).start()
        base = settings.defaults()
        svc = dict(base["services"][0], id="fake", name="試験",
                   endpoint=f"http://127.0.0.1:{llm.server_address[1]}", apiKey="sk-test")
        settings.save(self.settings_path, dict(base, services=[svc], activeService="fake"))
        FakeLLM.received.clear()
        return llm

    def test_llm_chat_streams_to_registered_service(self):
        llm = self._with_llm()
        try:
            resp, data = self.request("GET", "/llm/models?service=fake", headers=self.auth())
            self.assertEqual(resp.status, 200)
            self.assertEqual(json.loads(data)["data"][0]["id"], "pfnet/plamo-3-translate-0.8b-gguf")
            self.assertEqual(FakeLLM.received[-1][0], "/v1/models")

            conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
            body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "p"}], "stream": True}).encode()
            conn.request("POST", "/llm/chat?service=fake", body=body, headers=self.auth({"Content-Type": "application/json"}))
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            first = resp.read1(1024)  # 1 つ目の断片は最後を待たずに届く
            self.assertIn("こん".encode(), first)
            rest = resp.read()
            conn.close()
            self.assertIn(b"[DONE]", first + rest)
            path, sent, headers = FakeLLM.received[-1]
            self.assertEqual(path, "/v1/chat/completions")
            self.assertEqual(sent["messages"][0]["content"], "p")
            self.assertEqual(headers.get("Authorization"), "Bearer sk-test")

            # 登録していないサービス，知らない道，トークンなしは断る
            resp, _ = self.request("POST", "/llm/chat?service=nope", body=b"{}", headers=self.auth())
            self.assertEqual(resp.status, 404)
            resp, _ = self.request("POST", "/llm/other?service=fake", body=b"{}", headers=self.auth())
            self.assertEqual(resp.status, 404)
            resp, _ = self.request("POST", "/llm/chat?service=fake", body=b"{}")
            self.assertEqual(resp.status, 403)
        finally:
            llm.shutdown()
            llm.server_close()

    def test_llm_models_connection_test(self):
        llm = self._with_llm()
        try:
            endpoint = f"http://127.0.0.1:{llm.server_address[1]}/v1/chat/completions"
            body = json.dumps({"endpoint": endpoint, "apiKey": "k2"}).encode()
            resp, data = self.request("POST", "/llm/models", body=body, headers=self.auth())
            self.assertEqual(resp.status, 200, data)
            path, _, headers = FakeLLM.received[-1]
            self.assertEqual(path, "/v1/models")
            self.assertEqual(headers.get("Authorization"), "Bearer k2")
            resp, _ = self.request("POST", "/llm/models", body=b'{"endpoint": "file:///c:/x"}', headers=self.auth())
            self.assertEqual(resp.status, 400)
        finally:
            llm.shutdown()
            llm.server_close()

    def test_llm_unreachable(self):
        base = settings.defaults()
        svc = dict(base["services"][0], id="dead", endpoint="http://127.0.0.1:9")
        settings.save(self.settings_path, dict(base, services=[svc], activeService="dead"))
        resp, data = self.request("POST", "/llm/chat?service=dead", body=b"{}", headers=self.auth())
        self.assertEqual(resp.status, 502)
        self.assertIn("Cannot reach", json.loads(data)["error"])


class SettingsTest(unittest.TestCase):
    def test_defaults_and_broken_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "settings.json"
            self.assertEqual(settings.load(p), settings.defaults())
            p.write_text("{broken", encoding="utf-8")
            self.assertEqual(settings.load(p), settings.defaults())
            # 古い形（1.1）は移し替えず，既定値で始める
            p.write_text(json.dumps({"apiUrl": "http://x:1", "model": "m", "mode": "pfml3"}), encoding="utf-8")
            self.assertEqual(settings.load(p), settings.defaults())
            # 正しくないサービスは捨て，使うサービスは残ったものに合わせる
            good = dict(settings.defaults()["services"][0], id="g", name="G")
            bad = dict(good, id="b", prompt="no var")
            p.write_text(json.dumps({"services": [bad, good], "activeService": "b", "concurrency": 99}), encoding="utf-8")
            loaded = settings.load(p)
            self.assertEqual([x["id"] for x in loaded["services"]], ["g"])
            self.assertEqual(loaded["activeService"], "g")
            self.assertEqual(loaded["concurrency"], 2)

    def test_validate_strict(self):
        with self.assertRaises(settings.SettingsError):
            settings.validate({"concurrency": 9})
        with self.assertRaises(settings.SettingsError):
            settings.validate({"services": []})
        svc = settings.defaults()["services"][0]
        with self.assertRaises(settings.SettingsError):
            settings.validate({"services": [svc, dict(svc)]})  # 同じ ID
        self.assertEqual(settings.validate({"concurrency": "3"})["concurrency"], 3)
        self.assertEqual(settings.validate({"lastColor": "#FF6666"})["lastColor"], "#ff6666")
        with self.assertRaises(settings.SettingsError):
            settings.validate({"lastColor": "red"})

    def test_endpoint_urls(self):
        self.assertEqual(settings.chat_url("http://localhost:1234"), "http://localhost:1234/v1/chat/completions")
        self.assertEqual(settings.chat_url("http://h:1/v1/"), "http://h:1/v1/chat/completions")
        self.assertEqual(settings.chat_url("https://api.x.com/v1/chat/completions"), "https://api.x.com/v1/chat/completions")
        self.assertEqual(settings.models_url("http://localhost:1234"), "http://localhost:1234/v1/models")
        self.assertEqual(settings.models_url("https://a/b/v1/chat/completions"), "https://a/b/v1/models")


class PathsTest(unittest.TestCase):
    def test_portable_data_dir(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PDFTRANSNOTE_DATA_DIR", None)
            dd = paths.data_dir(Path(d))
            self.assertTrue(dd.portable)
            self.assertEqual(dd.path, Path(d) / "data")

    def test_fallback_when_not_writable(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"LOCALAPPDATA": d}):
            os.environ.pop("PDFTRANSNOTE_DATA_DIR", None)
            with mock.patch("transnote.paths._writable", return_value=False):
                dd = paths.data_dir(Path(d) / "app")
            self.assertFalse(dd.portable)
            self.assertEqual(dd.path, Path(d) / "PdfTransNote")


if __name__ == "__main__":
    unittest.main()
