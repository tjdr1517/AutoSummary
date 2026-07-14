from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtWidgets import QApplication

from coolcalendar.services.config import load_config
from coolcalendar.ui.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("CoolCalendar Desktop")
    app.setStyle("Fusion")
    font_dir = Path(Path.home().anchor) / "Windows" / "Fonts"
    regular_font_id = QFontDatabase.addApplicationFont(str(font_dir / "Hancom Gothic Regular.ttf"))
    QFontDatabase.addApplicationFont(str(font_dir / "Hancom Gothic Bold.ttf"))
    families = QFontDatabase.applicationFontFamilies(regular_font_id) if regular_font_id >= 0 else []
    app.setFont(QFont(families[0] if families else "Malgun Gothic", 10))
    window = MainWindow(load_config())
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
