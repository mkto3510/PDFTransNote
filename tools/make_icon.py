"""アイコン（assets/PdfTransNote.ico と assets/icon-256.png）を作る．外部ライブラリは使わない．

図柄：右上を折った白い紙（PDF）に文字の行，黄色のハイライト，右下に紫の吹き出し（注釈）．
吹き出しの中には「A→あ」を表す 2 つの点と矢印を描き，翻訳を表す．
4×4 の細かい点で塗ってから平均し，縁をなめらかにする．
実行：.venv\\Scripts\\python -m tools.make_icon
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
SS = 4  # 1 画素あたりの細かい点の数（縦・横）

# 色（R, G, B, A）
PAPER = (255, 255, 255, 255)
EDGE = (60, 60, 72, 255)
FOLD = (214, 214, 222, 255)
LINE = (120, 120, 132, 255)
HIGHLIGHT = (255, 214, 0, 255)
ACCENT = (118, 78, 221, 255)  # 参考 HTML の --color-accent-primary（ライト）
WHITE = (255, 255, 255, 255)


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """(x, y) が角の丸い四角の中か．"""
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shape_color(x: float, y: float):
    """座標 (0〜1) の色．上に描くものから順に調べる．"""
    # --- 吹き出し（右下） ---
    bx0, by0, bx1, by1 = 0.50, 0.52, 0.97, 0.88
    in_bubble = rounded_rect(x, y, bx0, by0, bx1, by1, 0.09)
    # 吹き出しのしっぽ（左下へ）
    tail = (0.56 <= x <= 0.70) and (by1 - 0.01 <= y <= 0.98) and (x - 0.56) <= (0.98 - y) * 1.2 and y <= by1 + (0.70 - x) * 0.9
    if in_bubble or tail:
        # 中の印：左の点（A），右の点（あ），その間の矢印
        if (x - 0.61) ** 2 + (y - 0.70) ** 2 <= 0.045**2:
            return WHITE
        if (x - 0.86) ** 2 + (y - 0.70) ** 2 <= 0.045**2:
            return WHITE
        if 0.67 <= x <= 0.78 and abs(y - 0.70) <= 0.016:
            return WHITE
        if 0.76 <= x <= 0.81 and abs(y - 0.70) <= (0.81 - x) * 0.9:
            return WHITE
        return ACCENT
    # 吹き出しの白い縁取り（紙との境目をはっきりさせる）
    if rounded_rect(x, y, bx0 - 0.025, by0 - 0.025, bx1 + 0.025, by1 + 0.025, 0.11):
        return WHITE

    # --- 紙 ---
    px0, py0, px1, py1 = 0.14, 0.04, 0.80, 0.96
    fold = 0.18
    in_page = px0 <= x <= px1 and py0 <= y <= py1 and not (x > px1 - fold and y < py0 + fold and (x - (px1 - fold)) > (y - py0))
    if not in_page:
        return None
    # 縁の線
    edge_w = 0.022
    near_edge = (
        x - px0 < edge_w
        or px1 - x < edge_w
        or y - py0 < edge_w
        or py1 - y < edge_w
        or (x > px1 - fold - 0.01 and y < py0 + fold + 0.01 and abs((x - (px1 - fold)) - (y - py0)) < edge_w * 1.2)
    )
    if near_edge:
        return EDGE
    # 折り返し
    if x > px1 - fold and y < py0 + fold:
        return FOLD
    # ハイライトの帯（3 行目）
    if 0.21 <= x <= 0.70 and 0.40 <= y <= 0.50:
        if 0.43 <= y <= 0.47 and 0.24 <= x <= 0.66:
            return LINE
        return HIGHLIGHT
    # 文字の行
    for ly, lx1 in ((0.20, 0.56), (0.31, 0.70), (0.58, 0.44), (0.69, 0.42), (0.80, 0.40)):
        if abs(y - ly) <= 0.02 and 0.24 <= x <= lx1:
            return LINE
    return PAPER


def render(size: int) -> bytes:
    """size×size の RGBA の画素列を作る（4×4 の細かい点を平均）．"""
    out = bytearray()
    n = SS * SS
    for py in range(size):
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = shape_color((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    if c:
                        a = c[3]
                        acc[0] += c[0] * a
                        acc[1] += c[1] * a
                        acc[2] += c[2] * a
                        acc[3] += a
            a = acc[3] / n
            if acc[3]:
                out += bytes((round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(a)))
            else:
                out += b"\0\0\0\0"
    return bytes(out)


def png(size: int, rgba: bytes) -> bytes:
    raw = b"".join(b"\0" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def ico(images: list[tuple[int, bytes]]) -> bytes:
    """PNG を入れた ICO（Windows Vista 以降が読める形）．"""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        s = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


def main() -> None:
    OUT.mkdir(exist_ok=True)
    images = []
    for size in SIZES:
        data = png(size, render(size))
        images.append((size, data))
        if size == 256:
            (OUT / "icon-256.png").write_bytes(data)
    (OUT / "PdfTransNote.ico").write_bytes(ico(images))
    print(f"wrote {OUT / 'PdfTransNote.ico'} ({len(images)} sizes)")


if __name__ == "__main__":
    main()
