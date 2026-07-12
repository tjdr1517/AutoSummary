from __future__ import annotations

import sys

from PySide6.QtGui import QFont
from PySide6.QtWidgets import QApplication

from coolcalendar.services.config import load_config
from coolcalendar.ui.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("CoolCalendar Desktop")
    app.setStyle("Fusion")
    app.setFont(QFont("Malgun Gothic", 10))
    window = MainWindow(load_config())
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
