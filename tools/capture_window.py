"""開発用：タイトルに指定の文字を含むウインドウを PNG に写す（WebView2 の中身も写る PrintWindow を使う）．

実行：.venv\\Scripts\\python -m tools.capture_window "PDF TransNote" out.png
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as w
import sys

from tools.make_icon import png

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
PW_RENDERFULLCONTENT = 2


def find_window(part: str) -> int | None:
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
    def cb(h, _):
        if user32.IsWindowVisible(h):
            n = user32.GetWindowTextLengthW(h)
            b = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, b, n + 1)
            if part in b.value:
                found.append(h)
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else None


def capture(hwnd: int) -> tuple[int, int, bytes]:
    rect = w.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    width, height = rect.right - rect.left, rect.bottom - rect.top
    hdc = user32.GetWindowDC(hwnd)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, width, height)
    gdi32.SelectObject(mem, bmp)
    user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG), ("biPlanes", w.WORD),
            ("biBitCount", w.WORD), ("biCompression", w.DWORD), ("biSizeImage", w.DWORD),
            ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG), ("biClrUsed", w.DWORD), ("biClrImportant", w.DWORD),
        ]

    bih = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), width, -height, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(width * height * 4)
    gdi32.GetDIBits(mem, bmp, 0, height, buf, ctypes.byref(bih), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(hwnd, hdc)
    raw = bytearray(buf.raw)
    raw[0::4], raw[2::4] = raw[2::4], raw[0::4]  # BGRA → RGBA
    raw[3::4] = b"\xff" * (width * height)
    return width, height, bytes(raw)


def main() -> None:
    part, out = sys.argv[1], sys.argv[2]
    hwnd = find_window(part)
    if not hwnd:
        sys.exit(f"window not found: {part}")
    width, height, rgba = capture(hwnd)
    if width != height:
        # make_icon.png は正方形用なので，ここで長方形の PNG を作る
        import struct
        import zlib

        rows = b"".join(b"\0" + rgba[y * width * 4 : (y + 1) * width * 4] for y in range(height))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        data = (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 6))
            + chunk(b"IEND", b"")
        )
    else:
        data = png(width, rgba)
    open(out, "wb").write(data)
    print(f"{out}: {width}x{height}")


if __name__ == "__main__":
    main()
