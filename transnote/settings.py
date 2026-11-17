"""設定（data/settings.json）の既定値・読み込み・検査・保存．

翻訳サービスは Translate for Zotero の Custom GPT と同じ考え方で，名前を付けて何件でも登録し，
「使うサービス」（activeService）を選ぶ．API は OpenAI 形式の chat/completions だけ．
画面（web/app/settings-dialog.js）は /api/settings でこの値を読み書きする．
古い形の設定ファイルは移し替えない（読めない項目は捨て，既定値で始める）．
"""

from __future__ import annotations

import copy
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

# PLaMo 3 Translate（LM Studio などの GGUF 版）は，指定を system メッセージの [plamo-translate] の見出しで受け取る．
# user メッセージに書くと，見出しも原文として訳してしまう．
DEFAULT_SYSTEM_PROMPT = "[plamo-translate]\ntarget_lang=${langTo}\nform=plain"
DEFAULT_PROMPT = "${sourceText}"
REQUIRED_VAR = "${sourceText}"

DEFAULT_SERVICE: dict[str, Any] = {
    "id": "plamo-0.8b",
    "name": "PLaMo 3 Translate 0.8B",
    # 土台の URL なら /v1/chat/completions を付ける．…/chat/completions で終わる URL はそのまま使う．
    "endpoint": "http://localhost:1234",
    "apiKey": "",
    "model": "plamo-3-translate-0.8b",
    "temperature": 0.0,
    # system メッセージの雛形（空なら送らない）と，user メッセージの雛形（${sourceText} 必須）
    "systemPrompt": DEFAULT_SYSTEM_PROMPT,
    "prompt": DEFAULT_PROMPT,
    "stream": True,
    # 要求の本文に混ぜる追加のパラメーター（JSON のオブジェクト）
    "customParams": {},
}

DEFAULTS: dict[str, Any] = {
    "services": [DEFAULT_SERVICE],
    "activeService": DEFAULT_SERVICE["id"],
    "langFrom": "en",
    "langTo": "ja",
    "concurrency": 2,  # 翻訳サーバーに同時に送る数（超えた分は画面の中で順番を待つ）
    "saveOnComment": True,  # 訳を注釈に入れたら PDF も保存する
    "lastColor": "#ffd400",  # 最後に使ったハイライトの色
}

MAX_SERVICES = 20
_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_LANG_RE = re.compile(r"^[A-Za-z]{2,3}([-_][A-Za-z0-9()]{1,12})*$|^auto$")


class SettingsError(ValueError):
    """設定の値が正しくない．"""


def defaults() -> dict[str, Any]:
    return copy.deepcopy(DEFAULTS)


# ---------------------------------------------------------------------------
# エンドポイントの URL
# ---------------------------------------------------------------------------


def chat_url(endpoint: str) -> str:
    """エンドポイントから chat/completions の URL を作る（Translate for Zotero と同じ扱い）．"""
    e = str(endpoint).strip().rstrip("/")
    if e.endswith("/chat/completions"):
        return e
    if e.endswith("/v1"):
        return e + "/chat/completions"
    return e + "/v1/chat/completions"


def models_url(endpoint: str) -> str:
    """モデル一覧（/models）の URL．"""
    return chat_url(endpoint)[: -len("/chat/completions")] + "/models"


def check_endpoint(endpoint: Any) -> str:
    e = str(endpoint or "").strip()
    parts = urlsplit(e)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise SettingsError("The endpoint must start with http:// or https://")
    return e


# ---------------------------------------------------------------------------
# 検査
# ---------------------------------------------------------------------------


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in {"1", "true", "yes", "on"}
    return bool(v)


def _service(raw: Any, index: int) -> dict[str, Any]:
    """サービス 1 件を検査して形をそろえる．誤りは SettingsError（何件目かを付ける）．"""
    where = f"Service {index + 1}"
    if not isinstance(raw, dict):
        raise SettingsError(f"{where}: invalid format")
    s = copy.deepcopy(DEFAULT_SERVICE)
    try:
        s["id"] = str(raw.get("id") or f"service-{index + 1}").strip()
        if not _ID_RE.match(s["id"]):
            raise SettingsError("The ID contains invalid characters")
        s["name"] = str(raw.get("name", "")).strip()
        if not s["name"]:
            raise SettingsError("Enter a name")
        s["endpoint"] = check_endpoint(raw.get("endpoint"))
        s["apiKey"] = str(raw.get("apiKey", "")).strip()
        s["model"] = str(raw.get("model", "")).strip()
        if not s["model"]:
            raise SettingsError("Enter a model")
        try:
            s["temperature"] = float(raw.get("temperature", 0))
        except (TypeError, ValueError) as e:
            raise SettingsError("temperature must be a number") from e
        if not 0.0 <= s["temperature"] <= 2.0:
            raise SettingsError("temperature must be between 0 and 2")
        s["systemPrompt"] = str(raw.get("systemPrompt", ""))
        s["prompt"] = str(raw.get("prompt", ""))
        if REQUIRED_VAR not in s["prompt"]:
            raise SettingsError(f"The prompt must contain {REQUIRED_VAR}")
        s["stream"] = _as_bool(raw.get("stream", True))
        params = raw.get("customParams", {})
        if isinstance(params, str):
            text = params.strip()
            try:
                params = json.loads(text) if text else {}
            except ValueError as e:
                raise SettingsError(f"Cannot read the extra parameters as JSON: {e}") from e
        if not isinstance(params, dict):
            raise SettingsError("Extra parameters must be a JSON object ({…})")
        s["customParams"] = params
    except SettingsError as e:
        raise SettingsError(f"{where} ({raw.get('name') or s['id']}): {e}") from None
    return s


def validate(values: dict[str, Any], *, strict: bool = True) -> dict[str, Any]:
    """値を検査して形をそろえる．知らない項目は捨てる．

    strict が真なら，正しくない値は SettingsError にする（画面から保存するとき）．
    偽なら，その項目を既定値に戻す（ファイルを読むとき）．正しくないサービスは捨てる．
    """
    if not isinstance(values, dict):
        if strict:
            raise SettingsError("Invalid settings format")
        return defaults()
    out = defaults()

    # --- 翻訳サービス ---
    raw_services = values.get("services")
    if raw_services is not None:
        if not isinstance(raw_services, list):
            if strict:
                raise SettingsError("Invalid translation service format")
            raw_services = []
        services = []
        for i, raw in enumerate(raw_services[:MAX_SERVICES] if not strict else raw_services):
            try:
                services.append(_service(raw, i))
            except SettingsError:
                if strict:
                    raise
        if strict and not 1 <= len(services) <= MAX_SERVICES:
            raise SettingsError(f"Register 1 to {MAX_SERVICES} translation services")
        ids = [s["id"] for s in services]
        if len(set(ids)) != len(ids):
            if strict:
                raise SettingsError("Two translation services have the same ID")
            seen, uniq = set(), []
            for s in services:
                if s["id"] not in seen:
                    seen.add(s["id"])
                    uniq.append(s)
            services = uniq
        if services:
            out["services"] = services

    ids = [s["id"] for s in out["services"]]
    active = values.get("activeService", out["activeService"])
    if active in ids:
        out["activeService"] = active
    elif strict and "activeService" in values:
        raise SettingsError("The active service is not registered")
    else:
        out["activeService"] = ids[0]

    # --- 共通の項目 ---
    def take(key, check):
        if key not in values:
            return
        try:
            out[key] = check(values[key])
        except (SettingsError, TypeError, ValueError) as e:
            if strict:
                raise SettingsError(str(e)) from None

    def lang(v):
        v = str(v).strip()
        if not _LANG_RE.match(v):
            raise SettingsError(f"Invalid language: {v}")
        return v

    def concurrency(v):
        v = int(v)
        if not 1 <= v <= 8:
            raise SettingsError("Concurrent requests must be between 1 and 8")
        return v

    def color(v):
        v = str(v).strip()
        if not _COLOR_RE.match(v):
            raise SettingsError(f"Invalid color: {v}")
        return v.lower()

    take("langFrom", lang)
    take("langTo", lang)
    take("concurrency", concurrency)
    take("saveOnComment", _as_bool)
    take("lastColor", color)
    return out


def service(settings: dict[str, Any], service_id: str | None) -> dict[str, Any] | None:
    """ID のサービスを返す（なければ None）．"""
    for s in settings.get("services", []):
        if s["id"] == service_id:
            return s
    return None


# ---------------------------------------------------------------------------
# 読み書き
# ---------------------------------------------------------------------------


def load(path: Path) -> dict[str, Any]:
    """ファイルから読む．ないとき・壊れているときは既定値．"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return defaults()
    return validate(data, strict=False)


def save(path: Path, values: dict[str, Any]) -> dict[str, Any]:
    """検査してから，一時ファイルを経由して書き込む．書いた値を返す．"""
    checked = validate(values, strict=True)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(checked, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return checked
