"""サーバーとネイティブ画面の文言を日本語にする（英語の文言を日本語に引き当てる）．

文言は英語を基準にして書き，lang が "ja" のときだけ，このファイルの対応表で日本語にする．
パラメーターを含む文言は正規表現で受け，日本語側の \名前付きグループ参照 に差し込む．
コロンの後ろの生の例外文（OS の誤り，JSON の誤り，相手サーバーの文言）は訳さずそのまま付ける．
英語のとき・知らない文言のときは，文言をそのまま返す．
"""

from __future__ import annotations

import re

LANGS = ("en", "ja")

# 設定画面の数値項目の名前（settings.py の int_range に渡す英語名）
_NAMES = {
    "The header and footer band": "ヘッダー・フッターを探す範囲",
    "The size difference": "小さい文字とみなす差",
    "The popup width": "ポップアップの幅",
    "The popup height": "ポップアップの高さ",
    "Backups to keep": "残すバックアップの数",
}
_NAME_RE = "|".join(re.escape(n) for n in _NAMES)

# (英語の正規表現, 日本語の雛形, 例文) — 例文は tests が使う（各行が自分の例文に一致し，日本語に引数が入ること）
# 雛形の中の \g<名前> は正規表現の名前付きグループ．rest グループは再帰して訳す．
CATALOGUE: list[tuple[str, str, str]] = [
    # --- 設定の検査（settings.py） ---
    (r"Service (?P<n>\d+) \((?P<name>.*?)\): (?P<rest>.*)", r"サービス \g<n>（\g<name>）：\g<rest>",
     "Service 2 (My LLM): Enter a name"),
    (r"Service (?P<n>\d+): invalid format", r"サービス \g<n>：形式が正しくありません．", "Service 3: invalid format"),
    (r"The endpoint must start with http:// or https://", "エンドポイントは http:// または https:// で始めてください．",
     "The endpoint must start with http:// or https://"),
    (r"The ID contains invalid characters", "ID に使えない文字が含まれています．", "The ID contains invalid characters"),
    (r"Enter a name", "名前を入力してください．", "Enter a name"),
    (r"Enter a model", "モデルを入力してください．", "Enter a model"),
    (r"temperature must be a number", "temperature は数値で指定してください．", "temperature must be a number"),
    (r"temperature must be between 0 and 2", "temperature は 0 から 2 までの値にしてください．",
     "temperature must be between 0 and 2"),
    (r"The prompt must contain (?P<v>.+)", r"プロンプトに \g<v> を含めてください．", "The prompt must contain ${sourceText}"),
    (r"Cannot read the extra parameters as JSON: (?P<e>.*)", r"追加のパラメーターを JSON として読み取れません：\g<e>",
     "Cannot read the extra parameters as JSON: Expecting value"),
    (r"Extra parameters must be a JSON object \(\{…\}\)", "追加のパラメーターは JSON のオブジェクト（{…}）にしてください．",
     "Extra parameters must be a JSON object ({…})"),
    (r"Invalid settings format", "設定の形式が正しくありません．", "Invalid settings format"),
    (r"Invalid translation service format", "翻訳サービスの形式が正しくありません．", "Invalid translation service format"),
    (r"Register (?P<lo>\d+) to (?P<hi>\d+) translation services", r"翻訳サービスは \g<lo> 件から \g<hi> 件まで登録してください．",
     "Register 1 to 20 translation services"),
    (r"Two translation services have the same ID", "同じ ID の翻訳サービスが 2 件あります．",
     "Two translation services have the same ID"),
    (r"The active service is not registered", "使うサービスが登録されていません．", "The active service is not registered"),
    (r"Invalid language: (?P<v>.*)", r"言語の指定が正しくありません：\g<v>", "Invalid language: xx"),
    (r"Concurrent requests must be between (?P<lo>\d+) and (?P<hi>\d+)",
     r"同時に送る要求の数は \g<lo> から \g<hi> までにしてください．", "Concurrent requests must be between 1 and 8"),
    (r"Invalid color: (?P<v>.*)", r"色の指定が正しくありません：\g<v>", "Invalid color: red"),
    (r"Invalid display language: (?P<v>.*)", r"表示言語の指定が正しくありません：\g<v>", "Invalid display language: fr"),
    (r"Invalid editing buttons", "編集のボタンの指定が正しくありません．", "Invalid editing buttons"),
    (rf"(?P<name>{_NAME_RE}) must be a number", r"\g<name>は数値で指定してください．", "The popup width must be a number"),
    (rf"(?P<name>{_NAME_RE}) must be between (?P<lo>\d+) and (?P<hi>\d+)",
     r"\g<name>は \g<lo> から \g<hi> までにしてください．", "The header and footer band must be between 3 and 25"),
    (rf"(?P<name>{_NAME_RE}) must be 0 or between (?P<lo>\d+) and (?P<hi>\d+)",
     r"\g<name>は 0（自動）か，\g<lo> から \g<hi> までにしてください．", "The popup width must be 0 or between 200 and 4000"),
    # --- サーバーの応答（server.py） ---
    (r"Cannot read JSON: (?P<e>.*)", r"JSON を読み取れません：\g<e>", "Cannot read JSON: Expecting value"),
    (r"Invalid JSON structure", "JSON の構造が正しくありません．", "Invalid JSON structure"),
    (r"Invalid endpoint: (?P<rest>.*)", r"エンドポイントが正しくありません：\g<rest>",
     "Invalid endpoint: The endpoint must start with http:// or https://"),
    (r'Translation service "(?P<id>.*)" is not registered', r"翻訳サービス「\g<id>」は登録されていません．",
     'Translation service "x" is not registered'),
    (r"Cannot reach the translation server \((?P<url>.*?)\): (?P<e>.*)",
     r"翻訳サーバー（\g<url>）に接続できません：\g<e>", "Cannot reach the translation server (http://127.0.0.1:9): refused"),
    (r"Cannot save because the file is in use by another app", "ほかのアプリがファイルを使っているため，保存できません．",
     "Cannot save because the file is in use by another app"),
    (r"Not a PDF", "PDF ファイルではありません．", "Not a PDF"),
    (r"viewer\.html has an unexpected structure \(check the pdf\.js version\)",
     "viewer.html の構造が想定と違います（pdf.js の版を確かめてください）．",
     "viewer.html has an unexpected structure (check the pdf.js version)"),
    (r"forbidden", "許可されていません．", "forbidden"),
    (r"not found", "見つかりません．", "not found"),
    (r"unknown document", "不明な文書です．", "unknown document"),
    (r"bad host", "ホスト名が正しくありません．", "bad host"),
    (r"bad token", "トークンが正しくありません．", "bad token"),
    (r"bad range", "範囲の指定が正しくありません．", "bad range"),
    (r"range not satisfiable", "指定した範囲は読み出せません．", "range not satisfiable"),
    (r"bad length", "本文の長さが正しくありません．", "bad length"),
    (r"empty body", "本文が空です．", "empty body"),
    (r"too large", "大きすぎます．", "too large"),
    (r"incomplete body", "本文が途中で切れています．", "incomplete body"),
    # --- ネイティブの画面（app.py） ---
    (r"There are unsaved changes or translations in progress\. Close anyway\?",
     "保存していない変更か，実行中の翻訳があります．このまま閉じますか？",
     "There are unsaved changes or translations in progress. Close anyway?"),
    (r"PDF files \(\*\.pdf\)", "PDF ファイル (*.pdf)", "PDF files (*.pdf)"),
    (r"All files \(\*\.\*\)", "すべてのファイル (*.*)", "All files (*.*)"),
    (r"Could not load the window component \(pywebview\)\.\n(?P<e>.*)",
     r"ウインドウの部品（pywebview）を読み込めませんでした．\n\g<e>", "Could not load the window component (pywebview).\nboom"),
    (r"Could not open the window\. Check that the Microsoft Edge WebView2 Runtime is installed\.\n\n(?P<e>.*)",
     r"ウインドウを開けませんでした．Microsoft Edge WebView2 ランタイムがインストールされているか確かめてください．\n\n\g<e>",
     "Could not open the window. Check that the Microsoft Edge WebView2 Runtime is installed.\n\nboom"),
]

_COMPILED = [(re.compile(p, re.DOTALL), ja) for p, ja, _ in CATALOGUE]


def tr(lang: str | None, message: str) -> str:
    """英語の文言を lang に合わせて返す．"ja" 以外・対応表にない文言は，そのまま返す．"""
    if lang != "ja":
        return message
    for rx, ja in _COMPILED:
        m = rx.fullmatch(message)
        if not m:
            continue
        groups = m.groupdict()
        if "rest" in groups:
            # 入れ子の文言（サービス名の後ろ・エンドポイントの検査）は中も訳す
            ja = ja.replace(r"\g<rest>", "\x00")
            out = m.expand(ja)
            return out.replace("\x00", tr(lang, groups["rest"]))
        if "name" in groups and groups["name"] in _NAMES:
            return rx.sub(lambda mm: _expand_name(ja, mm), message)
        return m.expand(ja)
    return message


def _expand_name(ja: str, m: re.Match) -> str:
    return m.expand(ja.replace(r"\g<name>", _NAMES[m.group("name")]))


def normalize_lang(value: object) -> str:
    """ヘッダーや設定の値を "en"／"ja" にそろえる（知らない値は "en"）．"""
    v = str(value or "").strip().lower()
    return v if v in LANGS else "en"
