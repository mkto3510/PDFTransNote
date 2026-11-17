"""開発用：ウインドウを開かずにサーバーだけ動かし，ブラウザーで画面を試す．

使い方：.venv\\Scripts\\python -m tools.devserver <PDF のパス> [--port 8765]
表示された URL をブラウザーで開く（デスクトップ専用の機能：ファイル選択・ドロップ・閉じる前の確認は動かない）．
データは環境変数 PDFTRANSNOTE_DATA_DIR（なければ data）に置く．
"""

from __future__ import annotations

import argparse
import time

from transnote import paths
from transnote.server import TransNoteServer


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    dd = paths.data_dir()
    server = TransNoteServer(
        pdfjs_dir=paths.pdfjs_dir(),
        web_dir=paths.web_dir(),
        settings_path=dd.settings,
        backups_dir=dd.backups,
        port=args.port,
    )
    server.start_in_thread()
    doc = server.registry.register(args.pdf) if args.pdf else None
    print(f"data: {dd.path}", flush=True)
    print(f"url:  {server.viewer_url(doc)}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
