"""PDF.js の公式配布物を vendor/ に取ってくる．

実行：.venv\\Scripts\\python -m tools.fetch_pdfjs
PDF.js のリポジトリ（mozilla/pdf.js）の Release にある pdfjs-<版>-dist.zip をダウンロードし，
SHA-256 を確かめてから vendor/pdfjs-<版>-dist/ に展開する．展開済みなら何もしない．
PDF.js を更新するときは，transnote/__init__.py の PDFJS_VERSION と下の SHA256 を直す．
"""

from __future__ import annotations

import hashlib
import io
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from transnote import PDFJS_VERSION  # noqa: E402

# 版ごとの zip の SHA-256
SHA256 = {
    "6.5.438": "fcbe9ba21d9911843e3502adc178a7f549a524a4055f887bedc942e5490c6ba1",
}

URL = "https://github.com/mozilla/pdf.js/releases/download/v{v}/pdfjs-{v}-dist.zip"


def main() -> int:
    dest = ROOT / "vendor" / f"pdfjs-{PDFJS_VERSION}-dist"
    if (dest / "web" / "viewer.html").exists():
        print(f"already present: {dest}")
        return 0
    expected = SHA256.get(PDFJS_VERSION)
    if not expected:
        print(f"SHA-256 for PDF.js {PDFJS_VERSION} is not registered in tools/fetch_pdfjs.py", file=sys.stderr)
        return 1

    url = URL.format(v=PDFJS_VERSION)
    print(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as resp:
        data = resp.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        print(f"SHA-256 mismatch: expected {expected}, got {actual}", file=sys.stderr)
        return 1

    tmp = dest.with_name(dest.name + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            target = (tmp / name).resolve()
            if not target.is_relative_to(tmp.resolve()):
                print(f"unsafe path in zip: {name}", file=sys.stderr)
                return 1
        zf.extractall(tmp)
    if dest.exists():
        shutil.rmtree(dest)
    tmp.rename(dest)
    print(f"extracted to {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
