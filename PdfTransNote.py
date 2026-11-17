"""PDF TransNote の入口（PyInstaller もこのファイルから exe を作る）．"""

import sys

from transnote.app import main

if __name__ == "__main__":
    sys.exit(main())
