from __future__ import annotations

import calendar as pycalendar
import datetime as dt
import json
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import asdict, replace
from html import escape as html_escape
from pathlib import Path

from PySide6.QtCore import (
    QByteArray,
    QDate,
    QEvent,
    QFileSystemWatcher,
    QMimeData,
    QPoint,
    QRect,
    QSize,
    Qt,
    QThread,
    QTime,
    QTimer,
    Signal,
)
from PySide6.QtGui import QColor, QDrag, QKeySequence, QLinearGradient, QPainter, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QDateEdit,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QPushButton,
    QRadioButton,
    QSizeGrip,
    QSizePolicy,
    QSlider,
    QSplitter,
    QTextEdit,
    QTimeEdit,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from coolcalendar.models import AppConfig, CalendarEvent, Message, MessageAnalysis
from coolcalendar.services.ai import (
    AIAnalysisStore,
    OpenAIMessageAnalyzer,
    create_ai_event_from_analysis,
    default_analysis_store_path,
    format_analysis_for_display,
    resolved_api_key,
    sanitize_model_name,
)
from coolcalendar.services.config import save_config
from coolcalendar.services.desktop import (
    attach_window_to_desktop,
    reveal_desktop,
    set_window_screen_bounds,
    window_screen_bounds,
)
from coolcalendar.services.event_state import event_key, load_completed_event_keys, set_event_completed
from coolcalendar.services.events import (
    TrashedEvent,
    create_event,
    create_event_from_message,
    load_events,
    load_trashed_events,
    move_event_to_trash,
    permanently_delete_trashed_event,
    restore_trashed_event,
    update_event,
)
from coolcalendar.services.google_calendar import (
    GoogleCalendarSyncError,
    connect_google_calendar,
    delete_synced_event,
    google_calendar_ready,
    import_events,
    move_sync_mapping,
    sync_event_path,
)
from coolcalendar.services.messages import (
    MessageService,
    build_event_description,
    guess_event_date,
    guess_event_time,
    summarize_message,
)


def shorten_text(value: str, limit: int = 96) -> str:
    compact = " ".join((value or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "..."


def apply_shadow(widget: QWidget, *, blur: int = 32, alpha: int = 70, y_offset: int = 10) -> None:
    effect = QGraphicsDropShadowEffect(widget)
    effect.setBlurRadius(blur)
    effect.setOffset(0, y_offset)
    effect.setColor(QColor(5, 19, 34, alpha))
    widget.setGraphicsEffect(effect)


OVERLAY_THEMES: dict[str, dict[str, str]] = {
    "navy": {
        "label": "네이비",
        "shell_rgb": "8, 17, 29",
        "shell_border": "rgba(186, 223, 245, 0.24)",
        "chrome_bg": "rgba(255, 255, 255, 0.05)",
        "chrome_border": "rgba(194, 229, 248, 0.16)",
        "overlay_title": "#ffffff",
        "board_title": "#f7fbff",
        "tip": "#a9c7dc",
        "weekday_bg": "rgba(141, 208, 247, 0.12)",
        "weekday_border": "rgba(165, 226, 255, 0.14)",
        "weekday": "#cdeaff",
        "weekday_sun": "#ffb1b8",
        "weekday_sat": "#a9ddff",
        "cell_bg": "rgba(120, 178, 218, 0.13)",
        "cell_border": "rgba(174, 225, 255, 0.16)",
        "cell_other": "rgba(150, 160, 176, 0.07)",
        "cell_weekend": "rgba(116, 162, 193, 0.18)",
        "today_border": "rgba(255, 220, 110, 0.95)",
        "today_bg": "rgba(255, 216, 116, 0.10)",
        "selected_border": "rgba(179, 230, 255, 0.95)",
        "selected_bg": "rgba(97, 178, 244, 0.26)",
        "day": "#f7fbff",
        "day_sun": "#ffb1b8",
        "day_sat": "#a9ddff",
        "day_muted": "rgba(240, 248, 255, 0.45)",
        "chip_bg": "rgba(255, 255, 255, 0.08)",
        "chip_border": "rgba(189, 227, 247, 0.18)",
        "chip": "#dff3ff",
        "footer_bg": "rgba(255, 255, 255, 0.06)",
        "footer_border": "rgba(176, 220, 244, 0.12)",
        "footer": "#d7edf9",
        "btn_secondary_bg": "rgba(166, 226, 255, 0.16)",
        "btn_secondary": "#dff4ff",
        "btn_secondary_border": "rgba(165, 226, 255, 0.28)",
        "btn_secondary_hover": "rgba(166, 226, 255, 0.24)",
        "btn_ghost_bg": "rgba(255, 255, 255, 0.07)",
        "btn_ghost": "#d5ebfb",
        "btn_ghost_border": "rgba(255, 255, 255, 0.10)",
        "btn_ghost_hover": "rgba(166, 226, 255, 0.24)",
        "ev_allday": "#ffd76d",
        "ev_timed": "#8fd3ff",
        "ev_title": "#f4f9fd",
        "ev_more": "#9cc6df",
    },
    "black": {
        "label": "블랙",
        "shell_rgb": "10, 10, 13",
        "shell_border": "rgba(255, 255, 255, 0.18)",
        "chrome_bg": "rgba(255, 255, 255, 0.05)",
        "chrome_border": "rgba(255, 255, 255, 0.12)",
        "overlay_title": "#ffffff",
        "board_title": "#f5f5f7",
        "tip": "#a3a3ad",
        "weekday_bg": "rgba(255, 255, 255, 0.07)",
        "weekday_border": "rgba(255, 255, 255, 0.10)",
        "weekday": "#e8e8ec",
        "weekday_sun": "#ff9ea6",
        "weekday_sat": "#9fc9ff",
        "cell_bg": "rgba(255, 255, 255, 0.055)",
        "cell_border": "rgba(255, 255, 255, 0.09)",
        "cell_other": "rgba(255, 255, 255, 0.02)",
        "cell_weekend": "rgba(255, 255, 255, 0.08)",
        "today_border": "rgba(255, 209, 102, 0.95)",
        "today_bg": "rgba(255, 209, 102, 0.10)",
        "selected_border": "rgba(255, 255, 255, 0.85)",
        "selected_bg": "rgba(255, 255, 255, 0.13)",
        "day": "#f5f5f7",
        "day_sun": "#ff9ea6",
        "day_sat": "#9fc9ff",
        "day_muted": "rgba(245, 245, 247, 0.38)",
        "chip_bg": "rgba(255, 255, 255, 0.08)",
        "chip_border": "rgba(255, 255, 255, 0.14)",
        "chip": "#e8e8ec",
        "footer_bg": "rgba(255, 255, 255, 0.06)",
        "footer_border": "rgba(255, 255, 255, 0.10)",
        "footer": "#d9d9de",
        "btn_secondary_bg": "rgba(255, 255, 255, 0.12)",
        "btn_secondary": "#f0f0f4",
        "btn_secondary_border": "rgba(255, 255, 255, 0.20)",
        "btn_secondary_hover": "rgba(255, 255, 255, 0.18)",
        "btn_ghost_bg": "rgba(255, 255, 255, 0.07)",
        "btn_ghost": "#dcdce2",
        "btn_ghost_border": "rgba(255, 255, 255, 0.10)",
        "btn_ghost_hover": "rgba(255, 255, 255, 0.14)",
        "ev_allday": "#ffd166",
        "ev_timed": "#9fd0ff",
        "ev_title": "#f5f5f7",
        "ev_more": "#9a9aa3",
    },
    "light": {
        "label": "라이트",
        "shell_rgb": "247, 250, 253",
        "shell_border": "rgba(25, 31, 40, 0.16)",
        "chrome_bg": "rgba(255, 255, 255, 0.72)",
        "chrome_border": "#e2e7ee",
        "overlay_title": "#191f28",
        "board_title": "#191f28",
        "tip": "#5b6675",
        "weekday_bg": "rgba(255, 255, 255, 0.85)",
        "weekday_border": "#e2e7ee",
        "weekday": "#4e5968",
        "weekday_sun": "#e5484d",
        "weekday_sat": "#1769e0",
        "cell_bg": "rgba(255, 255, 255, 0.78)",
        "cell_border": "#e2e7ee",
        "cell_other": "rgba(238, 242, 247, 0.55)",
        "cell_weekend": "rgba(240, 246, 252, 0.85)",
        "today_border": "#3182f6",
        "today_bg": "#eaf3ff",
        "selected_border": "#1769e0",
        "selected_bg": "#e3f0ff",
        "day": "#191f28",
        "day_sun": "#e5484d",
        "day_sat": "#1769e0",
        "day_muted": "#b0b8c1",
        "chip_bg": "#f2f4f6",
        "chip_border": "#e5e8eb",
        "chip": "#4e5968",
        "footer_bg": "rgba(255, 255, 255, 0.85)",
        "footer_border": "#e2e7ee",
        "footer": "#4e5968",
        "btn_secondary_bg": "#eef6ff",
        "btn_secondary": "#1769e0",
        "btn_secondary_border": "#d6e8ff",
        "btn_secondary_hover": "#e3f0ff",
        "btn_ghost_bg": "#f2f4f6",
        "btn_ghost": "#4e5968",
        "btn_ghost_border": "#e5e8eb",
        "btn_ghost_hover": "#e9edf2",
        "ev_allday": "#b27800",
        "ev_timed": "#1769e0",
        "ev_title": "#191f28",
        "ev_more": "#6b7684",
    },
}


def overlay_theme_palette(name: str) -> dict[str, str]:
    return OVERLAY_THEMES.get(name, OVERLAY_THEMES["navy"])


class ChromeDialog(QDialog):
    def __init__(self, title: str, subtitle: str, *, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._drag_anchor = QPoint()
        self._drag_start_pos = QPoint()
        self._position_initialized = False

        self.setWindowTitle(title)
        self.setModal(True)
        self.setWindowFlags(Qt.Dialog | Qt.FramelessWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(18, 18, 18, 18)
        outer.setSpacing(0)

        self.shell = QFrame()
        self.shell.setObjectName("dialogShell")
        apply_shadow(self.shell, blur=44, alpha=118, y_offset=16)
        outer.addWidget(self.shell)

        root = QVBoxLayout(self.shell)
        root.setContentsMargins(22, 22, 22, 22)
        root.setSpacing(18)

        self.header = QFrame()
        self.header.setObjectName("dialogHeader")
        header_layout = QHBoxLayout(self.header)
        header_layout.setContentsMargins(18, 16, 18, 16)
        header_layout.setSpacing(12)
        root.addWidget(self.header)

        header_text = QVBoxLayout()
        header_text.setContentsMargins(0, 0, 0, 0)
        header_text.setSpacing(4)
        header_layout.addLayout(header_text, 1)

        self.dialog_title_label = QLabel(title)
        self.dialog_title_label.setObjectName("dialogTitle")
        self.dialog_title_label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        header_text.addWidget(self.dialog_title_label)

        self.dialog_subtitle_label = QLabel(subtitle)
        self.dialog_subtitle_label.setObjectName("dialogSubtitle")
        self.dialog_subtitle_label.setWordWrap(True)
        self.dialog_subtitle_label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        header_text.addWidget(self.dialog_subtitle_label)

        self.dialog_meta_chip = QLabel("")
        self.dialog_meta_chip.setObjectName("pathChip")
        self.dialog_meta_chip.setVisible(False)
        self.dialog_meta_chip.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        header_layout.addWidget(self.dialog_meta_chip)

        self.close_button = QPushButton("닫기")
        self.close_button.setProperty("variant", "ghost")
        self.close_button.setFixedHeight(42)
        self.close_button.setMinimumWidth(74)
        self.close_button.clicked.connect(self.reject)
        header_layout.addWidget(self.close_button)

        self.header.mousePressEvent = self._start_drag  # type: ignore[method-assign]
        self.header.mouseMoveEvent = self._move_drag  # type: ignore[method-assign]

        self.body_widget = QWidget()
        self.body_layout = QVBoxLayout(self.body_widget)
        self.body_layout.setContentsMargins(0, 0, 0, 0)
        self.body_layout.setSpacing(16)
        root.addWidget(self.body_widget, 1)

    def set_meta_text(self, text: str) -> None:
        self.dialog_meta_chip.setText(text)
        self.dialog_meta_chip.setVisible(bool(text))

    def _start_drag(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_anchor = event.globalPosition().toPoint()
            self._drag_start_pos = self.frameGeometry().topLeft()
            event.accept()

    def _move_drag(self, event) -> None:
        if event.buttons() & Qt.LeftButton:
            delta = event.globalPosition().toPoint() - self._drag_anchor
            self.move(self._drag_start_pos + delta)
            event.accept()

    def _place_in_screen(self) -> None:
        if self._position_initialized:
            return
        self._position_initialized = True

        reference_widget = None
        parent = self.parentWidget()
        if parent is not None and parent.isVisible() and not parent.isMinimized():
            reference_widget = parent
        else:
            active = QApplication.activeWindow()
            if active is not None and active is not self and active.isVisible():
                reference_widget = active

        if reference_widget is not None:
            reference_rect = reference_widget.frameGeometry()
            screen = QApplication.screenAt(reference_rect.center())
            center = reference_rect.center()
        else:
            screen = QApplication.primaryScreen()
            screen_rect = screen.availableGeometry() if screen is not None else QRect(0, 0, 1600, 900)
            center = screen_rect.center()

        screen_rect = screen.availableGeometry() if screen is not None else QRect(0, 0, 1600, 900)
        x = center.x() - self.width() // 2
        y = center.y() - self.height() // 2
        x = min(max(x, screen_rect.x() + 18), screen_rect.right() - self.width() - 18)
        y = min(max(y, screen_rect.y() + 18), screen_rect.bottom() - self.height() - 18)
        self.move(x, y)

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        QTimer.singleShot(0, self._place_in_screen)


class AppAlertDialog(QDialog):
    """A focused confirmation surface, intentionally separate from full settings dialogs."""

    def __init__(
        self,
        title: str,
        message: str,
        *,
        tone: str = "info",
        confirm_text: str = "확인",
        cancel_text: str | None = None,
        parent: QWidget | None = None,
        stay_on_top: bool = False,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("appAlertDialog")
        self.setWindowTitle(title)
        self.setModal(True)
        self.setWindowFlags(Qt.Dialog | Qt.FramelessWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedWidth(480)
        if stay_on_top:
            self.setWindowFlag(Qt.WindowStaysOnTopHint, True)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 14, 14, 14)
        outer.setSpacing(0)

        shell = QFrame()
        shell.setObjectName("alertShell")
        apply_shadow(shell, blur=38, alpha=122, y_offset=13)
        shell.setStyleSheet(
            """
            QFrame#alertShell {
                background: qlineargradient(x1: 0, y1: 0, x2: 1, y2: 1,
                    stop: 0 rgba(20, 43, 66, 0.98), stop: 1 rgba(11, 29, 47, 0.98));
                border: 1px solid rgba(210, 235, 250, 0.18);
                border-radius: 24px;
            }
            QLabel#alertTitle { color: #f7fbff; font-size: 15pt; font-weight: 700; }
            QLabel#alertMessage { color: #c8ddec; font-size: 10.5pt; line-height: 1.45; }
            QPushButton#alertCancel {
                background: rgba(255, 255, 255, 0.08); color: #d7e9f6;
                border: 1px solid rgba(230, 244, 252, 0.14); border-radius: 12px; padding: 0 16px;
            }
            QPushButton#alertCancel:hover { background: rgba(255, 255, 255, 0.14); }
            QPushButton#alertConfirm {
                background: rgba(118, 196, 255, 0.26); color: #f8fcff;
                border: 1px solid rgba(170, 223, 255, 0.46); border-radius: 12px; padding: 0 18px; font-weight: 700;
            }
            QPushButton#alertConfirm:hover { background: rgba(118, 196, 255, 0.38); }
            QPushButton#alertConfirm:pressed, QPushButton#alertCancel:pressed { background: rgba(255, 255, 255, 0.20); }
            QPushButton#alertConfirm[destructive="true"] {
                background: rgba(226, 93, 106, 0.78); border-color: rgba(255, 180, 188, 0.46);
            }
            QPushButton#alertConfirm[destructive="true"]:hover { background: rgba(238, 108, 121, 0.94); }
            """
        )
        outer.addWidget(shell)
        layout = QVBoxLayout(shell)
        layout.setContentsMargins(24, 22, 24, 20)
        layout.setSpacing(18)

        headline = QHBoxLayout()
        headline.setSpacing(12)
        layout.addLayout(headline)

        icon = QFrame()
        icon.setObjectName("alertIcon")
        icon.setFixedSize(38, 38)
        icon_colors = {
            "info": ("rgba(88, 181, 255, 0.24)", "rgba(153, 216, 255, 0.50)"),
            "question": ("rgba(88, 181, 255, 0.24)", "rgba(153, 216, 255, 0.50)"),
            "warning": ("rgba(236, 173, 84, 0.24)", "rgba(255, 215, 140, 0.50)"),
            "error": ("rgba(232, 101, 113, 0.24)", "rgba(255, 178, 187, 0.50)"),
        }
        icon_background, icon_border = icon_colors.get(tone, icon_colors["info"])
        icon.setStyleSheet(f"background: {icon_background}; border: 1px solid {icon_border}; border-radius: 19px;")
        icon_layout = QVBoxLayout(icon)
        icon_layout.setContentsMargins(0, 0, 0, 0)
        glyph = QLabel({"info": "i", "warning": "!", "error": "!", "question": "?"}.get(tone, "i"))
        glyph.setAlignment(Qt.AlignCenter)
        glyph.setStyleSheet("color: #f8fcff; font-size: 17pt; font-weight: 700; background: transparent; border: none;")
        icon_layout.addWidget(glyph)
        headline.addWidget(icon)

        title_label = QLabel(title)
        title_label.setObjectName("alertTitle")
        headline.addWidget(title_label, 1)

        self.message_label = QLabel(message)
        self.message_label.setObjectName("alertMessage")
        self.message_label.setWordWrap(True)
        self.message_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        layout.addWidget(self.message_label)

        actions = QHBoxLayout()
        actions.setSpacing(10)
        layout.addLayout(actions)
        actions.addStretch(1)

        if cancel_text:
            cancel_button = QPushButton(cancel_text)
            cancel_button.setObjectName("alertCancel")
            cancel_button.setFixedHeight(42)
            cancel_button.clicked.connect(self.reject)
            actions.addWidget(cancel_button)

        confirm_button = QPushButton(confirm_text)
        confirm_button.setObjectName("alertConfirm")
        confirm_button.setProperty("destructive", tone == "error")
        confirm_button.setFixedHeight(42)
        confirm_button.setMinimumWidth(104)
        confirm_button.setDefault(True)
        confirm_button.clicked.connect(self.accept)
        actions.addWidget(confirm_button)
        self.adjustSize()

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        parent = self.parentWidget()
        if parent is not None and parent.isVisible() and not parent.isMinimized():
            screen = QApplication.screenAt(parent.frameGeometry().center())
            center = parent.frameGeometry().center()
        else:
            screen = QApplication.primaryScreen()
            rect = screen.availableGeometry() if screen is not None else QRect(0, 0, 1600, 900)
            center = rect.center()
        rect = screen.availableGeometry() if screen is not None else QRect(0, 0, 1600, 900)
        self.move(center.x() - self.width() // 2, center.y() - self.height() // 2)


def show_info(parent: QWidget | None, title: str, message: str) -> None:
    AppAlertDialog(title, message, tone="info", parent=parent).exec()


def show_warning(parent: QWidget | None, title: str, message: str) -> None:
    AppAlertDialog(title, message, tone="warning", parent=parent).exec()


def show_error(parent: QWidget | None, title: str, message: str) -> None:
    AppAlertDialog(title, message, tone="error", parent=parent).exec()


def ask_confirmation(
    parent: QWidget | None,
    title: str,
    message: str,
    *,
    confirm_text: str = "확인",
    cancel_text: str = "취소",
    destructive: bool = False,
    stay_on_top: bool = False,
) -> bool:
    tone = "error" if destructive else "question"
    dialog = AppAlertDialog(
        title,
        message,
        tone=tone,
        confirm_text=confirm_text,
        cancel_text=cancel_text,
        parent=parent,
        stay_on_top=stay_on_top,
    )
    return dialog.exec() == QDialog.Accepted


class BackdropWidget(QWidget):
    def paintEvent(self, event) -> None:  # type: ignore[override]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        gradient = QLinearGradient(0, 0, self.width(), self.height())
        gradient.setColorAt(0.0, QColor(247, 249, 252))
        gradient.setColorAt(0.52, QColor(241, 246, 252))
        gradient.setColorAt(1.0, QColor(232, 241, 252))
        painter.fillRect(self.rect(), gradient)

        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(49, 130, 246, 16))
        painter.drawEllipse(int(self.width() * 0.62), int(self.height() * 0.04), int(self.width() * 0.22), int(self.width() * 0.22))
        painter.setBrush(QColor(20, 184, 166, 12))
        painter.drawEllipse(int(self.width() * 0.04), int(self.height() * 0.52), int(self.width() * 0.36), int(self.width() * 0.36))
        super().paintEvent(event)


class StatTile(QFrame):
    def __init__(self, caption: str) -> None:
        super().__init__()
        self.setObjectName("statTile")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        layout.setSpacing(2)

        self.caption_label = QLabel(caption)
        self.caption_label.setObjectName("statCaption")
        layout.addWidget(self.caption_label)

        self.value_label = QLabel("-")
        self.value_label.setObjectName("statValue")
        layout.addWidget(self.value_label)

        self.detail_label = QLabel("")
        self.detail_label.setObjectName("statDetail")
        layout.addWidget(self.detail_label)

    def set_content(self, value: str, detail: str) -> None:
        self.value_label.setText(value)
        self.detail_label.setText(detail)


class MessageCardWidget(QFrame):
    def __init__(self, message: Message) -> None:
        super().__init__()
        self.setObjectName("messageCard")
        self.setProperty("selected", False)
        self.setProperty("dragging", False)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)

        suggested_date = guess_event_date(message)
        suggested_time = guess_event_time(message) or "시간 미정"
        headline = message.peer or ("보낸 메시지" if message.direction == "send" else "받은 메시지")
        preview = shorten_text(message.preview or summarize_message(message) or "(내용 없음)", 72)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.setSpacing(6)

        top = QHBoxLayout()
        top.setSpacing(10)
        layout.addLayout(top)

        self.headline_label = QLabel(headline)
        self.headline_label.setObjectName("cardTitle")
        self.headline_label.setWordWrap(False)
        top.addWidget(self.headline_label, 1)

        self.time_label = QLabel(message.when_text or "시간 없음")
        self.time_label.setObjectName("cardMetaPill")
        top.addWidget(self.time_label)

        self.preview_label = QLabel(preview)
        self.preview_label.setObjectName("cardBody")
        self.preview_label.setWordWrap(False)
        self.preview_label.setTextInteractionFlags(Qt.NoTextInteraction)
        layout.addWidget(self.preview_label)

        bottom = QHBoxLayout()
        bottom.setSpacing(6)
        layout.addLayout(bottom)

        self.date_hint = QLabel(f"{suggested_date.month:02d}/{suggested_date.day:02d}")
        self.date_hint.setObjectName("softChip")
        bottom.addWidget(self.date_hint)

        self.time_hint = QLabel(suggested_time)
        self.time_hint.setObjectName("softChip")
        bottom.addWidget(self.time_hint)
        bottom.addStretch(1)

    def set_selected(self, selected: bool) -> None:
        self.setProperty("selected", selected)
        self.style().unpolish(self)
        self.style().polish(self)


class EventCardWidget(QFrame):
    def __init__(self, event: CalendarEvent) -> None:
        super().__init__()
        self.setObjectName("eventCard")
        self.setProperty("selected", False)
        self.setProperty("completed", event.completed)

        description = shorten_text(event.description.replace("\n", " "), 88)
        time_text = event.time_text or "종일"

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(8)

        top = QHBoxLayout()
        top.setSpacing(10)
        layout.addLayout(top)

        self.time_label = QLabel(time_text)
        self.time_label.setObjectName("timeBadge")
        top.addWidget(self.time_label)

        self.title_label = QLabel(f"✓ {event.title}" if event.completed else event.title)
        self.title_label.setObjectName("cardTitle")
        self.title_label.setWordWrap(True)
        top.addWidget(self.title_label, 1)

        self.body_label = QLabel(description or "설명 없음")
        self.body_label.setObjectName("cardBody")
        self.body_label.setWordWrap(True)
        layout.addWidget(self.body_label)

        self.file_label = QLabel(event.file_path.name)
        self.file_label.setObjectName("cardSubBody")
        layout.addWidget(self.file_label)

    def set_selected(self, selected: bool) -> None:
        self.setProperty("selected", selected)
        self.style().unpolish(self)
        self.style().polish(self)


class EventEditorDialog(ChromeDialog):
    def __init__(
        self,
        event_date: dt.date,
        *,
        event: CalendarEvent | None = None,
        parent: QWidget | None = None,
    ) -> None:
        dialog_title = "일정 수정" if event is not None else "새 일정 추가"
        dialog_subtitle = "제목, 시간, 메모를 정리하면 캘린더에 바로 반영됩니다."
        super().__init__(dialog_title, dialog_subtitle, parent=parent)
        self.resize(560, 620)
        self.set_meta_text(event_date.strftime("%Y.%m.%d"))

        meta_row = QHBoxLayout()
        meta_row.setSpacing(10)
        self.body_layout.addLayout(meta_row)

        selected_date_chip = QLabel(f"선택 날짜  {event_date.strftime('%Y-%m-%d')}")
        selected_date_chip.setObjectName("softChip")
        meta_row.addWidget(selected_date_chip)

        mode_chip = QLabel("기존 일정 수정" if event is not None else "새 일정 만들기")
        mode_chip.setObjectName("softChip")
        meta_row.addWidget(mode_chip)
        meta_row.addStretch(1)

        form_shell = QFrame()
        form_shell.setObjectName("dialogSection")
        form_shell_layout = QVBoxLayout(form_shell)
        form_shell_layout.setContentsMargins(20, 20, 20, 20)
        form_shell_layout.setSpacing(16)
        self.body_layout.addWidget(form_shell, 1)

        form_title = QLabel("일정 정보")
        form_title.setObjectName("dialogSectionTitle")
        form_shell_layout.addWidget(form_title)

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        form.setFormAlignment(Qt.AlignTop)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(12)
        form_shell_layout.addLayout(form)

        self.title_edit = QLineEdit()
        self.title_edit.setPlaceholderText("일정 제목")
        self.title_edit.setClearButtonEnabled(True)
        form.addRow(self._field_label("제목"), self.title_edit)

        self.date_edit = QDateEdit()
        self.date_edit.setCalendarPopup(True)
        self.date_edit.setDisplayFormat("yyyy-MM-dd")
        self.date_edit.setDate(QDate(event_date.year, event_date.month, event_date.day))
        form.addRow(self._field_label("날짜"), self.date_edit)

        self.all_day_check = QCheckBox("종일 일정")
        self.all_day_check.setObjectName("dialogCheckBox")
        form.addRow(self._field_label("구분"), self.all_day_check)

        self.time_edit = QTimeEdit()
        self.time_edit.setDisplayFormat("HH:mm")
        self.time_edit.setTime(QTime(9, 0))
        form.addRow(self._field_label("시간"), self.time_edit)

        self.description_edit = QTextEdit()
        self.description_edit.setPlaceholderText("메모, 장소, 링크, 세부 내용을 적어둘 수 있습니다.")
        self.description_edit.setMinimumHeight(180)
        self.description_edit.setAcceptRichText(False)
        form.addRow(self._field_label("내용"), self.description_edit)

        footer = QHBoxLayout()
        footer.setSpacing(10)
        self.body_layout.addLayout(footer)

        helper_text = QLabel("저장하면 오버레이와 일정 목록이 즉시 업데이트됩니다.")
        helper_text.setObjectName("dialogHint")
        helper_text.setWordWrap(True)
        footer.addWidget(helper_text, 1)

        cancel_button = QPushButton("취소")
        cancel_button.setProperty("variant", "ghost")
        cancel_button.setFixedHeight(46)
        cancel_button.clicked.connect(self.reject)
        footer.addWidget(cancel_button)

        save_button = QPushButton("저장")
        save_button.setFixedHeight(46)
        save_button.setMinimumWidth(108)
        save_button.clicked.connect(self.accept)
        save_button.setDefault(True)
        footer.addWidget(save_button)

        self.all_day_check.toggled.connect(self._sync_time_enabled)

        if event is not None:
            self.title_edit.setText(event.title)
            self.date_edit.setDate(QDate(event.date.year, event.date.month, event.date.day))
            self.all_day_check.setChecked(event.all_day)
            if event.time_text and event.time_text != "종일":
                parsed_time = QTime.fromString(event.time_text, "HH:mm")
                if parsed_time.isValid():
                    self.time_edit.setTime(parsed_time)
            self.description_edit.setPlainText(event.description)
        else:
            self.all_day_check.setChecked(False)

        self._sync_time_enabled(self.all_day_check.isChecked())

    def _field_label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setObjectName("dialogFieldLabel")
        return label

    def _sync_time_enabled(self, checked: bool) -> None:
        self.time_edit.setEnabled(not checked)

    def event_payload(self) -> dict[str, object]:
        selected_date = self.date_edit.date()
        description = self.description_edit.toPlainText().strip()
        all_day = self.all_day_check.isChecked()
        time_text = "" if all_day else self.time_edit.time().toString("HH:mm")
        return {
            "title": self.title_edit.text().strip(),
            "date": dt.date(selected_date.year(), selected_date.month(), selected_date.day()),
            "description": description,
            "all_day": all_day,
            "time_text": time_text,
        }

    def accept(self) -> None:  # type: ignore[override]
        if not self.title_edit.text().strip():
            show_info(self, "제목 필요", "일정 제목을 입력해 주세요.")
            self.title_edit.setFocus()
            return
        super().accept()


class DayEventManagerDialog(ChromeDialog):
    def __init__(
        self,
        event_date: dt.date,
        *,
        event_provider: Callable[[dt.date], list[CalendarEvent]],
        event_lookup: Callable[[Path], CalendarEvent | None],
        on_add: Callable[[dt.date], Path | None],
        on_edit: Callable[[Path], Path | None],
        on_delete: Callable[[Path], None],
        on_open: Callable[[Path], None],
        parent: QWidget | None = None,
    ) -> None:
        self.event_date = event_date
        self.event_provider = event_provider
        self.event_lookup = event_lookup
        self.on_add = on_add
        self.on_edit = on_edit
        self.on_delete = on_delete
        self.on_open = on_open

        super().__init__(
            f"{event_date.strftime('%Y.%m.%d')} 일정 관리",
            "선택한 날짜의 일정을 여기서 추가, 수정, 휴지통 이동하고 파일까지 바로 열 수 있습니다.",
            parent=parent,
        )
        self.resize(620, 740)
        self.set_meta_text(event_date.strftime("%Y-%m-%d"))

        summary_row = QHBoxLayout()
        summary_row.setSpacing(10)
        self.body_layout.addLayout(summary_row)

        self.date_chip = QLabel(event_date.strftime("%Y년 %m월 %d일"))
        self.date_chip.setObjectName("softChip")
        summary_row.addWidget(self.date_chip)

        self.count_chip = QLabel("")
        self.count_chip.setObjectName("softChip")
        summary_row.addWidget(self.count_chip)
        summary_row.addStretch(1)

        action_shell = QFrame()
        action_shell.setObjectName("dialogSectionSoft")
        action_shell_layout = QVBoxLayout(action_shell)
        action_shell_layout.setContentsMargins(18, 18, 18, 18)
        action_shell_layout.setSpacing(12)
        self.body_layout.addWidget(action_shell)

        action_title = QLabel("빠른 작업")
        action_title.setObjectName("dialogSectionTitle")
        action_shell_layout.addWidget(action_title)

        button_row = QHBoxLayout()
        button_row.setSpacing(10)
        action_shell_layout.addLayout(button_row)

        self.add_button = QPushButton("새 일정")
        self.add_button.setProperty("variant", "secondary")
        self.add_button.setFixedHeight(44)
        self.add_button.clicked.connect(self._add_event)
        button_row.addWidget(self.add_button)

        self.edit_button = QPushButton("수정")
        self.edit_button.setProperty("variant", "ghost")
        self.edit_button.setFixedHeight(44)
        self.edit_button.clicked.connect(self._edit_event)
        button_row.addWidget(self.edit_button)

        self.delete_button = QPushButton("휴지통으로 이동")
        self.delete_button.setProperty("variant", "danger")
        self.delete_button.setFixedHeight(44)
        self.delete_button.clicked.connect(self._delete_event)
        button_row.addWidget(self.delete_button)

        self.open_button = QPushButton("파일 열기")
        self.open_button.setProperty("variant", "ghost")
        self.open_button.setFixedHeight(44)
        self.open_button.clicked.connect(self._open_event)
        button_row.addWidget(self.open_button)

        list_shell = QFrame()
        list_shell.setObjectName("dialogSection")
        list_shell_layout = QVBoxLayout(list_shell)
        list_shell_layout.setContentsMargins(18, 18, 18, 18)
        list_shell_layout.setSpacing(12)
        self.body_layout.addWidget(list_shell, 3)

        list_title = QLabel("등록된 일정")
        list_title.setObjectName("dialogSectionTitle")
        list_shell_layout.addWidget(list_title)

        self.event_list = EventListWidget()
        self.event_list.setMinimumHeight(240)
        self.event_list.currentItemChanged.connect(self._on_current_changed)
        self.event_list.itemDoubleClicked.connect(self._edit_event)
        self.event_list.delete_requested.connect(self._delete_event)
        list_shell_layout.addWidget(self.event_list, 1)

        detail_shell = QFrame()
        detail_shell.setObjectName("dialogSection")
        detail_shell_layout = QVBoxLayout(detail_shell)
        detail_shell_layout.setContentsMargins(18, 18, 18, 18)
        detail_shell_layout.setSpacing(12)
        self.body_layout.addWidget(detail_shell, 2)

        detail_title = QLabel("상세 내용")
        detail_title.setObjectName("dialogSectionTitle")
        detail_shell_layout.addWidget(detail_title)

        self.detail = QTextEdit()
        self.detail.setObjectName("detailPane")
        self.detail.setReadOnly(True)
        self.detail.setPlaceholderText("일정을 선택하면 메모와 시간을 확인할 수 있습니다.")
        self.detail.setMinimumHeight(180)
        detail_shell_layout.addWidget(self.detail, 1)

        hint_label = QLabel("일정 카드를 더블클릭하면 바로 수정할 수 있습니다.")
        hint_label.setObjectName("dialogHint")
        hint_label.setWordWrap(True)
        self.body_layout.addWidget(hint_label)

        self.refresh_events()

    def _current_event(self) -> CalendarEvent | None:
        item = self.event_list.currentItem()
        if item is None:
            return None
        target_path = Path(str(item.data(Qt.UserRole)))
        for event in self.event_provider(self.event_date):
            if event.file_path == target_path:
                return event
        return None

    def _sync_selection(self) -> None:
        current_item = self.event_list.currentItem()
        for index in range(self.event_list.count()):
            item = self.event_list.item(index)
            widget = self.event_list.itemWidget(item)
            if widget is not None and hasattr(widget, "set_selected"):
                widget.set_selected(item is current_item)

    def refresh_events(self, *, preferred_path: Path | None = None) -> None:
        current_path = preferred_path
        if current_path is None and self.event_list.currentItem() is not None:
            current_path = Path(str(self.event_list.currentItem().data(Qt.UserRole)))

        events = self.event_provider(self.event_date)
        self.dialog_title_label.setText(f"{self.event_date.strftime('%Y.%m.%d')} 일정 관리")
        self.date_chip.setText(self.event_date.strftime("%Y년 %m월 %d일"))
        self.count_chip.setText(f"일정 {len(events)}건")
        self.set_meta_text(self.event_date.strftime("%Y-%m-%d"))
        self.event_list.clear()
        for event in events:
            item = QListWidgetItem()
            item.setData(Qt.UserRole, str(event.file_path))
            item.setSizeHint(QSize(0, 112))
            card = EventCardWidget(event)
            self.event_list.addItem(item)
            self.event_list.setItemWidget(item, card)
            if current_path is not None and current_path == event.file_path:
                self.event_list.setCurrentItem(item)

        if self.event_list.currentItem() is None and self.event_list.count():
            self.event_list.setCurrentRow(0)
        if not events:
            self.detail.setPlainText("등록된 일정이 없습니다. 새 일정을 추가해 보세요.")

        self._sync_selection()
        self._on_current_changed()

    def _on_current_changed(self, *_args) -> None:
        self._sync_selection()
        event = self._current_event()
        has_event = event is not None
        self.edit_button.setEnabled(has_event)
        self.delete_button.setEnabled(has_event)
        self.open_button.setEnabled(has_event)
        if event is None:
            if self.event_list.count() == 0:
                self.detail.setPlainText("등록된 일정이 없습니다. 새 일정을 추가해 보세요.")
            return
        self.detail.setPlainText(
            f"제목: {event.title}\n시간: {event.time_text or '종일'}\n파일: {event.file_path}\n\n{event.description}"
        )

    def _add_event(self) -> None:
        created_path = self.on_add(self.event_date)
        if created_path is not None:
            found_event = self.event_lookup(created_path)
            if found_event is not None:
                self.event_date = found_event.date
            self.refresh_events(preferred_path=created_path)

    def _edit_event(self, *_args) -> None:
        event = self._current_event()
        if event is None:
            return
        updated_path = self.on_edit(event.file_path)
        if updated_path is None:
            return
        updated_event = self.event_lookup(updated_path)
        if updated_event is not None:
            self.event_date = updated_event.date
        self.refresh_events(preferred_path=updated_path)

    def _delete_event(self) -> None:
        event = self._current_event()
        if event is None:
            return
        current_date = event.date
        self.on_delete(event.file_path)
        self.event_date = current_date
        self.refresh_events()

    def _open_event(self) -> None:
        event = self._current_event()
        if event is None:
            return
        self.on_open(event.file_path)


class AISettingsDialog(ChromeDialog):
    def __init__(self, config: AppConfig, *, parent: QWidget | None = None) -> None:
        super().__init__(
            "AI 자동 일정 설정",
            "OpenAI API로 새 메시지를 요약하고, 마감/회의/제출 일정이 감지되면 자동 등록할 수 있습니다.",
            parent=parent,
        )
        self.resize(560, 560)
        self.set_meta_text("OpenAI Responses API")

        info_label = QLabel("API 키는 앱 설정 파일에 저장됩니다. 저장이 싫다면 입력하지 말고 OPENAI_API_KEY 환경변수를 사용할 수도 있습니다.")
        info_label.setObjectName("dialogHint")
        info_label.setWordWrap(True)
        self.body_layout.addWidget(info_label)

        section = QFrame()
        section.setObjectName("dialogSection")
        section_layout = QVBoxLayout(section)
        section_layout.setContentsMargins(20, 20, 20, 20)
        section_layout.setSpacing(16)
        self.body_layout.addWidget(section, 1)

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(12)
        section_layout.addLayout(form)

        self.api_key_edit = QLineEdit(config.openai_api_key)
        self.api_key_edit.setPlaceholderText("sk-...")
        self.api_key_edit.setEchoMode(QLineEdit.Password)
        self.api_key_edit.setClearButtonEnabled(True)
        form.addRow(self._field_label("API 키"), self.api_key_edit)

        self.model_edit = QLineEdit(sanitize_model_name(config.openai_model))
        self.model_edit.setPlaceholderText("gpt-5.4-mini")
        self.model_edit.setClearButtonEnabled(True)
        form.addRow(self._field_label("모델"), self.model_edit)

        self.auto_enable_check = QCheckBox("새 메시지 자동 분석 켜기")
        self.auto_enable_check.setChecked(config.ai_auto_enabled)
        form.addRow(self._field_label("자동 분석"), self.auto_enable_check)

        self.auto_create_check = QCheckBox("기한/업무 감지 시 묻지 않고 바로 일정 등록")
        self.auto_create_check.setChecked(config.ai_auto_create_events)
        form.addRow(self._field_label("등록 방식"), self.auto_create_check)

        helper = QLabel(
            "기본 모델은 `gpt-5.4-mini`로 설정했습니다. 더 높은 품질이 필요하면 `gpt-5.5`로 바꿀 수 있습니다.\n"
            "자동 분석은 현재 화면에 보이는 최근 메시지를 한 번에 돌리지 않고, 설정을 켠 뒤 새로 들어오는 메시지부터 처리합니다.\n"
            "등록 방식을 끄면 일정이 감지될 때마다 팝업으로 등록 여부를 물어봅니다."
        )
        helper.setObjectName("dialogHint")
        helper.setWordWrap(True)
        section_layout.addWidget(helper)

        self.auto_enable_check.toggled.connect(self._sync_state)
        self._sync_state(self.auto_enable_check.isChecked())

        footer = QHBoxLayout()
        footer.setSpacing(10)
        self.body_layout.addLayout(footer)

        footer.addStretch(1)

        cancel_button = QPushButton("취소")
        cancel_button.setProperty("variant", "ghost")
        cancel_button.setFixedHeight(46)
        cancel_button.clicked.connect(self.reject)
        footer.addWidget(cancel_button)

        save_button = QPushButton("저장")
        save_button.setFixedHeight(46)
        save_button.setMinimumWidth(108)
        save_button.clicked.connect(self.accept)
        footer.addWidget(save_button)

    def _field_label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setObjectName("dialogFieldLabel")
        return label

    def _sync_state(self, enabled: bool) -> None:
        self.auto_create_check.setEnabled(enabled)

    def payload(self) -> dict[str, object]:
        return {
            "openai_api_key": self.api_key_edit.text().strip(),
            "openai_model": sanitize_model_name(self.model_edit.text()),
            "ai_auto_enabled": self.auto_enable_check.isChecked(),
            "ai_auto_create_events": self.auto_enable_check.isChecked() and self.auto_create_check.isChecked(),
        }

    def accept(self) -> None:  # type: ignore[override]
        payload = self.payload()
        if payload["ai_auto_enabled"] and not resolved_api_key(str(payload["openai_api_key"])):
            show_info(
                self,
                "API 키 필요",
                "자동 분석을 켜려면 API 키를 입력하거나 OPENAI_API_KEY 환경변수를 설정해 주세요.",
            )
            self.api_key_edit.setFocus()
            return
        super().accept()


class GoogleCalendarSettingsDialog(ChromeDialog):
    def __init__(self, config: AppConfig, *, parent: QWidget | None = None) -> None:
        super().__init__(
            "Google Calendar 연동",
            "일정을 저장할 때 Google Calendar에도 바로 등록합니다.",
            parent=parent,
        )
        self.resize(620, 440)
        self.set_meta_text("Google Calendar API")

        info_label = QLabel(
            "Google OAuth Client ID로 로그인하면, 이후 일정 생성 시 Google Calendar에 자동 등록됩니다."
        )
        info_label.setObjectName("dialogHint")
        info_label.setWordWrap(True)
        self.body_layout.addWidget(info_label)

        section = QFrame()
        section.setObjectName("dialogSection")
        section_layout = QVBoxLayout(section)
        section_layout.setContentsMargins(20, 20, 20, 20)
        section_layout.setSpacing(16)
        self.body_layout.addWidget(section, 1)

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(12)
        section_layout.addLayout(form)

        self.enable_check = QCheckBox("일정 생성 시 Google Calendar에 자동 등록")
        self.enable_check.setChecked(config.google_calendar_enabled)
        form.addRow(self._field_label("자동 등록"), self.enable_check)

        self.client_id_edit = QLineEdit(config.google_oauth_client_id)
        self.client_id_edit.setPlaceholderText("xxxxxxxx.apps.googleusercontent.com")
        self.client_id_edit.setClearButtonEnabled(True)
        form.addRow(self._field_label("Client ID"), self.client_id_edit)

        self.client_secret_edit = QLineEdit(config.google_oauth_client_secret)
        self.client_secret_edit.setPlaceholderText("Google OAuth Client Secret")
        self.client_secret_edit.setEchoMode(QLineEdit.Password)
        self.client_secret_edit.setClearButtonEnabled(True)
        form.addRow(self._field_label("Client Secret"), self.client_secret_edit)

        self.calendar_id_edit = QLineEdit(config.google_calendar_id or "primary")
        self.calendar_id_edit.setPlaceholderText("primary")
        form.addRow(self._field_label("캘린더 ID"), self.calendar_id_edit)

        self.timezone_edit = QLineEdit(config.google_timezone or "Asia/Seoul")
        self.timezone_edit.setPlaceholderText("Asia/Seoul")
        form.addRow(self._field_label("시간대"), self.timezone_edit)

        helper = QLabel(
            "Google Cloud Console에서 OAuth 클라이언트 유형을 `데스크톱 앱`으로 만든 뒤 Client ID/Secret을 입력하세요. 기본 캘린더는 `primary`입니다."
        )
        helper.setObjectName("dialogHint")
        helper.setWordWrap(True)
        section_layout.addWidget(helper)

        footer = QHBoxLayout()
        footer.setSpacing(10)
        self.body_layout.addLayout(footer)
        footer.addStretch(1)

        cancel_button = QPushButton("취소")
        cancel_button.setProperty("variant", "ghost")
        cancel_button.setFixedHeight(46)
        cancel_button.clicked.connect(self.reject)
        footer.addWidget(cancel_button)

        save_button = QPushButton("저장하고 연결")
        save_button.setFixedHeight(46)
        save_button.setMinimumWidth(130)
        save_button.clicked.connect(self.accept)
        footer.addWidget(save_button)

    def _field_label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setObjectName("dialogFieldLabel")
        return label

    def payload(self) -> dict[str, object]:
        return {
            "google_calendar_enabled": self.enable_check.isChecked(),
            "google_oauth_client_id": self.client_id_edit.text().strip(),
            "google_oauth_client_secret": self.client_secret_edit.text().strip(),
            "google_calendar_id": self.calendar_id_edit.text().strip() or "primary",
            "google_timezone": self.timezone_edit.text().strip() or "Asia/Seoul",
        }

    def accept(self) -> None:  # type: ignore[override]
        payload = self.payload()
        if payload["google_calendar_enabled"] and (
            not str(payload["google_oauth_client_id"]) or not str(payload["google_oauth_client_secret"])
        ):
            show_info(
                self,
                "OAuth 정보 필요",
                "Google Calendar 자동 등록을 켜려면 Client ID와 Client Secret을 입력해 주세요.",
            )
            self.client_id_edit.setFocus()
            return
        super().accept()


class OverlaySettingsDialog(ChromeDialog):
    def __init__(
        self,
        config: AppConfig,
        *,
        on_change: Callable[[], None],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(
            "오버레이 보드 설정",
            "테마 색, 배경 투명도, 글자 크기를 조절하면 보드에 바로 반영됩니다.",
            parent=parent,
        )
        self.resize(520, 520)
        self.config = config
        self.on_change = on_change
        self._original = (config.overlay_theme, config.overlay_opacity, config.overlay_font_scale)

        section = QFrame()
        section.setObjectName("dialogSection")
        section_layout = QVBoxLayout(section)
        section_layout.setContentsMargins(20, 20, 20, 20)
        section_layout.setSpacing(18)
        self.body_layout.addWidget(section, 1)

        theme_title = QLabel("테마 색")
        theme_title.setObjectName("dialogSectionTitle")
        section_layout.addWidget(theme_title)

        theme_row = QHBoxLayout()
        theme_row.setSpacing(18)
        section_layout.addLayout(theme_row)

        self.theme_buttons: dict[str, QRadioButton] = {}
        for key, palette in OVERLAY_THEMES.items():
            radio = QRadioButton(palette["label"])
            radio.setChecked(key == config.overlay_theme)
            radio.toggled.connect(self._apply_values)
            self.theme_buttons[key] = radio
            theme_row.addWidget(radio)
        theme_row.addStretch(1)

        opacity_title = QLabel("배경 불투명도")
        opacity_title.setObjectName("dialogSectionTitle")
        section_layout.addWidget(opacity_title)

        opacity_row = QHBoxLayout()
        opacity_row.setSpacing(12)
        section_layout.addLayout(opacity_row)

        self.opacity_slider = QSlider(Qt.Horizontal)
        self.opacity_slider.setRange(50, 100)
        self.opacity_slider.setValue(max(50, min(100, config.overlay_opacity)))
        self.opacity_slider.valueChanged.connect(self._apply_values)
        opacity_row.addWidget(self.opacity_slider, 1)

        self.opacity_value = QLabel("")
        self.opacity_value.setObjectName("dialogFieldLabel")
        self.opacity_value.setMinimumWidth(48)
        opacity_row.addWidget(self.opacity_value)

        font_title = QLabel("글자 크기")
        font_title.setObjectName("dialogSectionTitle")
        section_layout.addWidget(font_title)

        font_row = QHBoxLayout()
        font_row.setSpacing(12)
        section_layout.addLayout(font_row)

        self.font_slider = QSlider(Qt.Horizontal)
        self.font_slider.setRange(80, 140)
        self.font_slider.setValue(max(80, min(140, config.overlay_font_scale)))
        self.font_slider.valueChanged.connect(self._apply_values)
        font_row.addWidget(self.font_slider, 1)

        self.font_value = QLabel("")
        self.font_value.setObjectName("dialogFieldLabel")
        self.font_value.setMinimumWidth(48)
        font_row.addWidget(self.font_value)

        hint = QLabel("낮은 불투명도일수록 배경화면이 비쳐 보이고, 높을수록 글씨가 또렷해집니다.")
        hint.setObjectName("dialogHint")
        hint.setWordWrap(True)
        section_layout.addWidget(hint)
        section_layout.addStretch(1)

        footer = QHBoxLayout()
        footer.setSpacing(10)
        self.body_layout.addLayout(footer)
        footer.addStretch(1)

        cancel_button = QPushButton("취소")
        cancel_button.setProperty("variant", "ghost")
        cancel_button.setFixedHeight(46)
        cancel_button.clicked.connect(self.reject)
        footer.addWidget(cancel_button)

        save_button = QPushButton("저장")
        save_button.setFixedHeight(46)
        save_button.setMinimumWidth(108)
        save_button.clicked.connect(self.accept)
        footer.addWidget(save_button)

        self._update_value_labels()

    def _selected_theme(self) -> str:
        for key, radio in self.theme_buttons.items():
            if radio.isChecked():
                return key
        return "navy"

    def _update_value_labels(self) -> None:
        self.opacity_value.setText(f"{self.opacity_slider.value()}%")
        self.font_value.setText(f"{self.font_slider.value()}%")

    def _apply_values(self, *_args) -> None:
        self.config.overlay_theme = self._selected_theme()
        self.config.overlay_opacity = self.opacity_slider.value()
        self.config.overlay_font_scale = self.font_slider.value()
        self._update_value_labels()
        self.on_change()

    def reject(self) -> None:  # type: ignore[override]
        # 취소하면 조절 전 상태로 되돌린다.
        self.config.overlay_theme, self.config.overlay_opacity, self.config.overlay_font_scale = self._original
        self.on_change()
        super().reject()


class AIAnalysisWorker(QThread):
    item_processed = Signal(object, object, object)
    batch_finished = Signal(object, int, int)

    def __init__(
        self,
        messages: list[Message],
        *,
        api_key: str,
        model: str,
        store_path: Path,
        event_dir: Path,
        auto_create: bool,
        force_reanalyze: bool,
        mode: str,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.messages = list(messages)
        self.api_key = api_key
        self.model = sanitize_model_name(model)
        self.store_path = store_path
        self.event_dir = event_dir
        self.auto_create = auto_create
        self.force_reanalyze = force_reanalyze
        self.mode = mode

    def run(self) -> None:  # type: ignore[override]
        store = AIAnalysisStore(self.store_path)
        processed_count = 0
        created_count = 0

        try:
            analyzer = OpenAIMessageAnalyzer(self.api_key, self.model)
        except Exception as exc:  # noqa: BLE001
            for message in self.messages:
                analysis = MessageAnalysis(
                    message_key=message.key,
                    analyzed_at=dt.datetime.now().isoformat(timespec="seconds"),
                    model=self.model,
                    error=str(exc),
                )
                store.upsert(analysis)
                processed_count += 1
                self.item_processed.emit(message.key, asdict(analysis), self.mode)
            self.batch_finished.emit(self.mode, processed_count, created_count)
            return

        for message in self.messages:
            existing = store.get(message.key)
            needs_analysis = (
                self.force_reanalyze
                or existing is None
                or not existing.summary
                or bool(existing.error)
            )

            if needs_analysis:
                try:
                    analysis = analyzer.analyze_message(message)
                    if existing is not None and existing.auto_created_event_path:
                        analysis.auto_created_event_path = existing.auto_created_event_path
                except Exception as exc:  # noqa: BLE001
                    analysis = MessageAnalysis(
                        message_key=message.key,
                        analyzed_at=dt.datetime.now().isoformat(timespec="seconds"),
                        model=self.model,
                        error=str(exc),
                    )
                store.upsert(analysis)
            else:
                analysis = existing

            if analysis is None:
                continue

            if self.auto_create and analysis.should_create_event:
                current_path = Path(analysis.auto_created_event_path) if analysis.auto_created_event_path else None
                if current_path is None or not current_path.exists():
                    try:
                        created_path = create_ai_event_from_analysis(message, analysis, self.event_dir)
                    except Exception as exc:  # noqa: BLE001
                        analysis.error = str(exc)
                        store.upsert(analysis)
                    else:
                        if created_path is not None:
                            analysis.auto_created_event_path = str(created_path)
                            store.upsert(analysis)
                            created_count += 1

            processed_count += 1
            self.item_processed.emit(message.key, asdict(analysis), self.mode)

        self.batch_finished.emit(self.mode, processed_count, created_count)

class MessageListWidget(QListWidget):
    mime_type = "application/x-coolcalendar-message"

    def __init__(self) -> None:
        super().__init__()
        self.setDragEnabled(True)
        self.setSelectionMode(QListWidget.SingleSelection)
        self.setSpacing(8)
        self.setObjectName("messageList")

    def mimeData(self, items: list[QListWidgetItem]) -> QMimeData:
        mime = QMimeData()
        if items:
            key = items[0].data(Qt.UserRole)
            mime.setData(self.mime_type, str(key).encode("utf-8"))
        return mime

    def startDrag(self, supported_actions: Qt.DropActions) -> None:
        item = self.currentItem()
        if item is None:
            return
        drag = QDrag(self)
        drag.setMimeData(self.mimeData([item]))
        card = self.itemWidget(item)
        if isinstance(card, MessageCardWidget):
            card.setProperty("dragging", True)
            card.style().unpolish(card)
            card.style().polish(card)
            preview = card.grab()
            if preview.width() > 340:
                preview = preview.scaledToWidth(340, Qt.SmoothTransformation)
            drag.setPixmap(preview)
            drag.setHotSpot(QPoint(min(28, preview.width() // 2), min(24, preview.height() // 2)))
        try:
            drag.exec(Qt.CopyAction)
        finally:
            if isinstance(card, MessageCardWidget):
                card.setProperty("dragging", False)
                card.style().unpolish(card)
                card.style().polish(card)


class EventListWidget(QListWidget):
    delete_requested = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setSelectionMode(QListWidget.SingleSelection)
        self.setSpacing(8)
        self.setObjectName("eventList")

    def keyPressEvent(self, event) -> None:  # type: ignore[override]
        if event.key() in (Qt.Key_Delete, Qt.Key_Backspace):
            self.delete_requested.emit()
            return
        super().keyPressEvent(event)


class EventTodoRowWidget(QFrame):
    def __init__(
        self,
        event: CalendarEvent,
        *,
        on_toggle: Callable[[Path, bool], None],
    ) -> None:
        super().__init__()
        self.setObjectName("eventTodoRow")
        self.setProperty("completed", event.completed)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 10, 8)
        layout.setSpacing(8)

        check = QCheckBox(event.title)
        check.setObjectName("eventTodoCheck")
        check.setChecked(event.completed)
        font = check.font()
        font.setStrikeOut(event.completed)
        check.setFont(font)
        check.toggled.connect(lambda completed: on_toggle(event.file_path, completed))
        layout.addWidget(check, 1)

        time_label = QLabel(event.time_text or "종일")
        time_label.setObjectName("softChip")
        layout.addWidget(time_label)

        if event.completed:
            done_label = QLabel("완료")
            done_label.setObjectName("eventDoneLabel")
            layout.addWidget(done_label)


class EventTodoDialog(ChromeDialog):
    def __init__(
        self,
        event_date: dt.date,
        *,
        event_provider: Callable[[dt.date], list[CalendarEvent]],
        on_toggle: Callable[[Path, bool], None],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(f"{event_date.strftime('%Y.%m.%d')} 일정", "등록된 일정을 체크리스트처럼 관리합니다.", parent=parent)
        self.event_date = event_date
        self.event_provider = event_provider
        self.on_toggle = on_toggle
        self.resize(540, 620)
        self.set_meta_text(event_date.strftime("%Y-%m-%d"))

        self.event_list = QListWidget()
        self.event_list.setObjectName("eventTodoList")
        self.event_list.setSpacing(7)
        self.body_layout.addWidget(self.event_list, 1)

        close_button = QPushButton("닫기")
        close_button.setProperty("variant", "ghost")
        close_button.setFixedHeight(42)
        close_button.clicked.connect(self.accept)
        self.body_layout.addWidget(close_button, 0, Qt.AlignRight)
        self._refresh()

    def _refresh(self) -> None:
        self.event_list.clear()
        for event in self.event_provider(self.event_date):
            item = QListWidgetItem()
            row = EventTodoRowWidget(event, on_toggle=self._toggle_event)
            item.setSizeHint(QSize(0, max(48, row.sizeHint().height() + 4)))
            self.event_list.addItem(item)
            self.event_list.setItemWidget(item, row)

    def _toggle_event(self, event_path: Path, completed: bool) -> None:
        self.on_toggle(event_path, completed)
        self._refresh()


class EventTrashDialog(ChromeDialog):
    def __init__(
        self,
        *,
        event_provider: Callable[[], list[TrashedEvent]],
        on_restore: Callable[[Path], bool],
        on_delete_forever: Callable[[Path], bool],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__("일정 휴지통", "삭제한 일정은 여기서 복원하거나 영구 삭제할 수 있습니다.", parent=parent)
        self.event_provider = event_provider
        self.on_restore = on_restore
        self.on_delete_forever = on_delete_forever
        self.resize(590, 660)
        self.set_meta_text("복원 가능한 일정")

        summary_row = QHBoxLayout()
        summary_row.setSpacing(10)
        self.body_layout.addLayout(summary_row)
        self.count_chip = QLabel("")
        self.count_chip.setObjectName("softChip")
        summary_row.addWidget(self.count_chip)
        summary_row.addStretch(1)

        self.event_list = QListWidget()
        self.event_list.setObjectName("eventTodoList")
        self.event_list.setSpacing(7)
        self.event_list.currentItemChanged.connect(self._update_actions)
        self.body_layout.addWidget(self.event_list, 1)

        self.empty_label = QLabel("휴지통이 비어 있습니다.")
        self.empty_label.setObjectName("dialogHint")
        self.empty_label.setAlignment(Qt.AlignCenter)
        self.body_layout.addWidget(self.empty_label)

        action_row = QHBoxLayout()
        action_row.setSpacing(10)
        self.body_layout.addLayout(action_row)
        self.restore_button = QPushButton("복원")
        self.restore_button.setProperty("variant", "secondary")
        self.restore_button.setFixedHeight(42)
        self.restore_button.clicked.connect(self._restore_current)
        action_row.addWidget(self.restore_button)

        self.delete_forever_button = QPushButton("영구 삭제")
        self.delete_forever_button.setProperty("variant", "danger")
        self.delete_forever_button.setFixedHeight(42)
        self.delete_forever_button.clicked.connect(self._delete_current_forever)
        action_row.addWidget(self.delete_forever_button)
        action_row.addStretch(1)

        close_button = QPushButton("닫기")
        close_button.setProperty("variant", "ghost")
        close_button.setFixedHeight(42)
        close_button.clicked.connect(self.accept)
        action_row.addWidget(close_button)
        self._refresh()

    def _current_path(self) -> Path | None:
        item = self.event_list.currentItem()
        if item is None:
            return None
        return Path(str(item.data(Qt.UserRole)))

    def _refresh(self) -> None:
        selected_path = self._current_path()
        entries = self.event_provider()
        self.event_list.clear()
        for entry in entries:
            event = entry.event
            item = QListWidgetItem()
            item.setData(Qt.UserRole, str(entry.file_path))
            item.setToolTip(f"원래 위치: {entry.original_path}\n휴지통 이동: {entry.deleted_at.strftime('%Y-%m-%d %H:%M')}")
            card = EventCardWidget(event)
            item.setSizeHint(QSize(0, max(104, card.sizeHint().height() + 6)))
            self.event_list.addItem(item)
            self.event_list.setItemWidget(item, card)
            if selected_path == entry.file_path:
                self.event_list.setCurrentItem(item)

        if self.event_list.currentItem() is None and self.event_list.count():
            self.event_list.setCurrentRow(0)
        self.count_chip.setText(f"휴지통 {len(entries)}건")
        self.empty_label.setVisible(not entries)
        self._update_actions()

    def _update_actions(self, *_args) -> None:
        has_entry = self._current_path() is not None
        self.restore_button.setEnabled(has_entry)
        self.delete_forever_button.setEnabled(has_entry)

    def _restore_current(self) -> None:
        path = self._current_path()
        if path is not None and self.on_restore(path):
            self._refresh()

    def _delete_current_forever(self) -> None:
        path = self._current_path()
        if path is not None and self.on_delete_forever(path):
            self._refresh()


class DayCell(QFrame):
    selected = Signal(object)
    message_dropped = Signal(object, int)
    open_requested = Signal(object)

    def __init__(self) -> None:
        super().__init__()
        self.date: dt.date | None = None
        self.setAcceptDrops(True)
        self.setObjectName("dayCell")
        self.setCursor(Qt.PointingHandCursor)
        self.setAttribute(Qt.WA_Hover, True)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(7, 5, 7, 5)
        layout.setSpacing(3)

        header = QHBoxLayout()
        header.setSpacing(5)
        layout.addLayout(header)

        self.day_label = QLabel("")
        self.day_label.setObjectName("dayLabel")
        header.addWidget(self.day_label)

        self.badge_label = QLabel("")
        self.badge_label.setObjectName("dayBadge")
        self.badge_label.setVisible(False)
        header.addWidget(self.badge_label)
        header.addStretch(1)

        self.events_label = QLabel("")
        self.events_label.setObjectName("eventsLabel")
        self.events_label.setWordWrap(True)
        self.events_label.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.events_label.setTextFormat(Qt.RichText)
        self.events_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        layout.addWidget(self.events_label, 1)

        self.drop_hint = QLabel("여기에 놓기")
        self.drop_hint.setObjectName("dropHint")
        self.drop_hint.setAlignment(Qt.AlignCenter)
        self.drop_hint.setVisible(False)
        layout.addWidget(self.drop_hint)

    def _set_drop_target(self, active: bool) -> None:
        if self.property("dropTarget") == active:
            return
        self.setProperty("dropTarget", active)
        self.drop_hint.setVisible(active)
        self.style().unpolish(self)
        self.style().polish(self)

    def set_payload(
        self,
        date: dt.date,
        preview_html: str,
        badge_text: str,
        *,
        in_month: bool,
        is_today: bool,
        is_selected: bool,
        weekend: bool,
    ) -> None:
        self.date = date
        self.day_label.setText(str(date.day))
        self.events_label.setText(preview_html)
        self.badge_label.setText(badge_text)
        self.badge_label.setVisible(bool(badge_text))

        if not in_month:
            tone = "muted"
        elif date.weekday() == 6:
            tone = "sun"
        elif date.weekday() == 5:
            tone = "sat"
        else:
            tone = "normal"
        if self.day_label.property("tone") != tone:
            self.day_label.setProperty("tone", tone)
            self.day_label.style().unpolish(self.day_label)
            self.day_label.style().polish(self.day_label)

        classes = ["cellCurrent" if in_month else "cellOther"]
        if weekend:
            classes.append("cellWeekend")
        if is_today:
            classes.append("cellToday")
        if is_selected:
            classes.append("cellSelected")
        self.setProperty("class", " ".join(classes))
        self.style().unpolish(self)
        self.style().polish(self)

    def mousePressEvent(self, event) -> None:  # type: ignore[override]
        if self.date is not None:
            self.selected.emit(self.date)
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event) -> None:  # type: ignore[override]
        if self.date is not None:
            self.open_requested.emit(self.date)
        super().mouseDoubleClickEvent(event)

    def dragEnterEvent(self, event) -> None:  # type: ignore[override]
        if event.mimeData().hasFormat(MessageListWidget.mime_type):
            self._set_drop_target(True)
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragLeaveEvent(self, event) -> None:  # type: ignore[override]
        self._set_drop_target(False)
        event.accept()

    def dropEvent(self, event) -> None:  # type: ignore[override]
        if self.date is None:
            self._set_drop_target(False)
            event.ignore()
            return
        raw = bytes(event.mimeData().data(MessageListWidget.mime_type)).decode("utf-8")
        self._set_drop_target(False)
        self.message_dropped.emit(self.date, int(raw))
        event.acceptProposedAction()


class CalendarBoardWidget(QWidget):
    date_selected = Signal(object)
    message_dropped = Signal(object, int)
    day_open_requested = Signal(object)

    def __init__(self, title: str) -> None:
        super().__init__()
        self.title = title
        self.current_month = dt.date.today().replace(day=1)
        self.selected_date = dt.date.today()
        self.events_by_date: dict[dt.date, list[CalendarEvent]] = {}
        self.cells: list[DayCell] = []
        self.overlay_palette = overlay_theme_palette("navy")
        self.font_scale = 1.0
        self._build_ui()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        header = QHBoxLayout()
        header.setSpacing(8)
        layout.addLayout(header)

        title_box = QVBoxLayout()
        title_box.setSpacing(1)
        header.addLayout(title_box, 1)

        self.title_label = QLabel("")
        self.title_label.setObjectName("boardTitle")
        title_box.addWidget(self.title_label)

        self.tip_label = QLabel("메시지를 날짜 칸으로 끌어다 놓으면 일정이 바로 생성됩니다.")
        self.tip_label.setObjectName("boardTip")
        title_box.addWidget(self.tip_label)

        navigation = QFrame()
        navigation.setObjectName("calendarNav")
        navigation_layout = QHBoxLayout(navigation)
        navigation_layout.setContentsMargins(3, 3, 3, 3)
        navigation_layout.setSpacing(2)

        for text, slot, segment in (
            ("이전", self.prev_month, "start"),
            ("오늘", self.go_today, "middle"),
            ("다음", self.next_month, "end"),
        ):
            button = QPushButton(text)
            button.setObjectName("calendarNavButton")
            button.setProperty("segment", segment)
            button.clicked.connect(slot)
            navigation_layout.addWidget(button)
        header.addWidget(navigation)

        weekday_row = QHBoxLayout()
        weekday_row.setSpacing(7)
        layout.addLayout(weekday_row)
        for index, name in enumerate(["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"]):
            label = QLabel(name)
            label.setObjectName("weekdayLabel")
            label.setAlignment(Qt.AlignCenter)
            if index == 0:
                label.setProperty("dow", "sun")
            elif index == 6:
                label.setProperty("dow", "sat")
            weekday_row.addWidget(label)

        grid_wrap = QWidget()
        grid = QGridLayout(grid_wrap)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(7)
        grid.setVerticalSpacing(6)
        layout.addWidget(grid_wrap, 1)

        for index in range(42):
            cell = DayCell()
            cell.selected.connect(self._on_selected)
            cell.message_dropped.connect(self.message_dropped)
            cell.open_requested.connect(self.day_open_requested)
            grid.addWidget(cell, index // 7, index % 7)
            self.cells.append(cell)
        for row in range(6):
            grid.setRowStretch(row, 1)
            grid.setRowMinimumHeight(row, 46)
        for column in range(7):
            grid.setColumnStretch(column, 1)

        self.footer_label = QLabel("")
        self.footer_label.setObjectName("boardFooter")
        layout.addWidget(self.footer_label)
        self.render()

    def set_events(self, events_by_date: dict[dt.date, list[CalendarEvent]]) -> None:
        self.events_by_date = events_by_date
        self.render()

    def set_selected_date(self, date: dt.date) -> None:
        self.selected_date = date
        if self.selected_date.month != self.current_month.month or self.selected_date.year != self.current_month.year:
            self.current_month = self.selected_date.replace(day=1)
        self.render()

    def prev_month(self) -> None:
        year = self.current_month.year
        month = self.current_month.month - 1
        if month == 0:
            year -= 1
            month = 12
        self.current_month = dt.date(year, month, 1)
        self.render()

    def next_month(self) -> None:
        year = self.current_month.year
        month = self.current_month.month + 1
        if month == 13:
            year += 1
            month = 1
        self.current_month = dt.date(year, month, 1)
        self.render()

    def go_today(self) -> None:
        self.selected_date = dt.date.today()
        self.current_month = self.selected_date.replace(day=1)
        self.render()
        self.date_selected.emit(self.selected_date)

    def _on_selected(self, date: dt.date) -> None:
        self.selected_date = date
        self.render()
        self.date_selected.emit(date)

    def _preview_html(self, events: list[CalendarEvent]) -> str:
        is_main_surface = self.objectName() == "mainBoard"
        if not events:
            return ""

        lines: list[str] = []
        if is_main_surface:
            for event in events[:1]:
                badge_color = "#8a98a8" if event.completed else ("#1769e0" if event.all_day else "#0891b2")
                title = html_escape(shorten_text(event.title, 18))
                lines.append(
                    "<div style='line-height:1.05;'>"
                    f"<span style='color:{badge_color}; font-size:10pt; font-weight:800;'>{'✓' if event.completed else '●'}</span> "
                    f"<span style='color:{'#7c8794' if event.completed else '#191f28'}; font-size:8.5pt;'>{title}</span>"
                    "</div>"
                )
            if len(events) > 1:
                lines.append(
                    f"<div style='color:#6b7684; font-size:7.8pt; margin-top:1px;'>+{len(events) - 1}건</div>"
                )
            return "".join(lines)

        palette = self.overlay_palette
        scale = self.font_scale
        time_size = f"{9.5 * scale:.1f}pt"
        title_size = f"{10.5 * scale:.1f}pt"
        more_size = f"{9 * scale:.1f}pt"
        for event in events[:2]:
            badge_color = palette["ev_more"] if event.completed else (palette["ev_allday"] if event.all_day else palette["ev_timed"])
            time_label = "종일" if event.all_day else event.time_text
            title = html_escape(shorten_text(event.title, 14))
            lines.append(
                "<div style='margin-bottom:3px; line-height:1.15;'>"
                f"<span style='color:{badge_color}; font-size:{time_size}; font-weight:700;'>{'✓' if event.completed else html_escape(time_label)}</span>&nbsp;"
                f"<span style='color:{palette['ev_title']}; font-size:{title_size}; font-weight:600;'>{title}</span>"
                "</div>"
            )
        if len(events) > 2:
            lines.append(
                f"<div style='color:{palette['ev_more']}; font-size:{more_size};'>외 {len(events) - 2}건</div>"
            )
        return "".join(lines)

    def render(self) -> None:
        self.title_label.setText(f"{self.current_month.year}년 {self.current_month.month}월")
        total = sum(len(items) for items in self.events_by_date.values())
        if self.objectName() == "mainBoard":
            self.tip_label.setText(f"저장된 일정 {total}건 · 날짜를 더블클릭하면 일정 관리 창이 열립니다.")
        else:
            self.tip_label.setText(f"총 일정 {total}건 · 메시지를 드래그해 날짜별 일정으로 정리하세요.")

        weeks = pycalendar.Calendar(firstweekday=6).monthdatescalendar(self.current_month.year, self.current_month.month)
        while len(weeks) < 6:
            start = weeks[-1][-1] + dt.timedelta(days=1)
            weeks.append([start + dt.timedelta(days=offset) for offset in range(7)])
        dates = [day for week in weeks[:6] for day in week]

        for index, date in enumerate(dates):
            events = self.events_by_date.get(date, [])
            badge_text = "오늘" if date == dt.date.today() else (f"{date.month}월" if date.day == 1 else "")
            self.cells[index].set_payload(
                date,
                self._preview_html(events),
                badge_text,
                in_month=date.month == self.current_month.month,
                is_today=date == dt.date.today(),
                is_selected=date == self.selected_date,
                weekend=index % 7 in (0, 6),
            )

        selected_events = self.events_by_date.get(self.selected_date, [])
        if selected_events:
            summary = "   ".join(f"{idx + 1}. {event.title}" for idx, event in enumerate(selected_events[:4]))
            if len(selected_events) > 4:
                summary = f"{summary}   외 {len(selected_events) - 4}건"
            self.footer_label.setText(f"{self.selected_date.isoformat()}  |  {summary}")
        else:
            self.footer_label.setText(f"{self.selected_date.isoformat()}  |  아직 등록된 일정이 없습니다.")


class OverlayBoardWindow(QWidget):
    closed = Signal()
    message_dropped = Signal(object, int)
    manage_requested = Signal(object)
    todo_requested = Signal(object)
    trash_requested = Signal()
    settings_requested = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("CoolCalendar Overlay")
        self.setWindowFlags(Qt.Tool | Qt.FramelessWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setMinimumSize(760, 500)
        self.resize(1080, 720)
        self._drag_offset = QPoint()
        self._drag_start_top_left = QPoint()
        self.selected_date = dt.date.today()
        self.events_by_date: dict[dt.date, list[CalendarEvent]] = {}
        self._desktop_attached = False

        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 20, 20, 20)
        outer.setSpacing(0)

        shell = QFrame()
        shell.setObjectName("overlayShell")
        apply_shadow(shell, blur=42, alpha=110, y_offset=16)
        outer.addWidget(shell)

        root = QVBoxLayout(shell)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(10)

        chrome = QFrame()
        chrome.setObjectName("overlayChrome")
        chrome.setCursor(Qt.OpenHandCursor)
        self.chrome = chrome
        chrome_layout = QHBoxLayout(chrome)
        chrome_layout.setContentsMargins(16, 14, 16, 14)
        chrome_layout.setSpacing(10)

        title = QLabel("바탕화면 월간 캘린더")
        title.setObjectName("overlayTitle")
        chrome_layout.addWidget(title)

        chrome_layout.addStretch(1)

        self.overlay_date_chip = QLabel("")
        self.overlay_date_chip.setObjectName("pathChip")
        chrome_layout.addWidget(self.overlay_date_chip)

        manage_btn = QPushButton("일정 관리")
        manage_btn.setProperty("variant", "secondary")
        manage_btn.clicked.connect(self._emit_manage_requested)
        chrome_layout.addWidget(manage_btn)

        todo_btn = QPushButton("일정 체크")
        todo_btn.setProperty("variant", "secondary")
        todo_btn.clicked.connect(self._emit_todo_requested)
        chrome_layout.addWidget(todo_btn)

        trash_btn = QPushButton("휴지통")
        trash_btn.setProperty("variant", "ghost")
        trash_btn.setToolTip("삭제한 일정을 복원하거나 영구 삭제합니다.")
        trash_btn.clicked.connect(self.trash_requested.emit)
        chrome_layout.addWidget(trash_btn)

        settings_btn = QPushButton("보드 설정")
        settings_btn.setProperty("variant", "ghost")
        settings_btn.setToolTip("테마 색, 배경 투명도, 글자 크기를 조절합니다.")
        settings_btn.clicked.connect(self.settings_requested)
        chrome_layout.addWidget(settings_btn)

        close_btn = QPushButton("닫기")
        close_btn.setProperty("variant", "ghost")
        close_btn.clicked.connect(self.close)
        chrome_layout.addWidget(close_btn)
        root.addWidget(chrome)

        self.board = CalendarBoardWidget("바탕화면 보드")
        self.board.message_dropped.connect(self.message_dropped)
        self.board.date_selected.connect(self._on_date_selected)
        self.board.day_open_requested.connect(self._emit_manage_requested)
        root.addWidget(self.board, 1)

        resize_grip = QSizeGrip(shell)
        resize_grip.setToolTip("드래그하여 위젯 크기 조절")
        root.addWidget(resize_grip, 0, Qt.AlignRight)

        chrome.mousePressEvent = self._start_drag  # type: ignore[method-assign]
        chrome.mouseMoveEvent = self._move_drag  # type: ignore[method-assign]
        chrome.mouseReleaseEvent = self._end_drag  # type: ignore[method-assign]
        self.set_selected_date(self.selected_date)

    def changeEvent(self, event) -> None:  # type: ignore[override]
        # '바탕화면 보기'(Win+D)가 이 창까지 최소화하면 바탕화면 위젯처럼 즉시 복귀시킨다.
        if event.type() == QEvent.WindowStateChange and (self.windowState() & Qt.WindowMinimized):
            QTimer.singleShot(0, self._restore_after_show_desktop)
        super().changeEvent(event)

    def _restore_after_show_desktop(self) -> None:
        if not (self.windowState() & Qt.WindowMinimized):
            return
        self.setWindowState(self.windowState() & ~Qt.WindowMinimized)
        self.show()
        try:
            attach_window_to_desktop(int(self.winId()))
        except Exception:
            pass

    def _start_drag(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_offset = event.globalPosition().toPoint()
            self._drag_start_top_left = self.screen_geometry().topLeft()
            self.chrome.setCursor(Qt.ClosedHandCursor)
            event.accept()

    def _move_drag(self, event) -> None:
        if event.buttons() & Qt.LeftButton:
            delta = event.globalPosition().toPoint() - self._drag_offset
            target = QRect(self.screen_geometry())
            target.moveTopLeft(self._drag_start_top_left + delta)
            self.apply_screen_geometry(target)
            event.accept()

    def _end_drag(self, event) -> None:
        self.chrome.setCursor(Qt.OpenHandCursor)
        event.accept()

    def is_desktop_attached(self) -> bool:
        return self._desktop_attached

    def screen_geometry(self) -> QRect:
        if self._desktop_attached:
            try:
                x, y, width, height = window_screen_bounds(int(self.winId()))
                return QRect(x, y, width, height)
            except Exception:
                pass
        return self.frameGeometry()

    def apply_screen_geometry(self, rect: QRect) -> None:
        target = QRect(rect)
        if self._desktop_attached:
            try:
                updated = set_window_screen_bounds(
                    int(self.winId()),
                    target.x(),
                    target.y(),
                    target.width(),
                    target.height(),
                )
                if updated:
                    return
            except Exception:
                pass
        self.setGeometry(target)

    def set_events(self, events: dict[dt.date, list[CalendarEvent]]) -> None:
        self.events_by_date = events
        self.board.set_events(events)
        self.set_selected_date(self.selected_date)

    def set_selected_date(self, date: dt.date, *, preferred_path: Path | None = None) -> None:
        self.selected_date = date
        self.board.set_selected_date(date)
        events = self.events_by_date.get(self.selected_date, [])
        unfinished_count = sum(not event.completed for event in events)
        self.overlay_date_chip.setText(f"{self.selected_date.strftime('%Y-%m-%d')} · 일정 {len(events)}건 · 미완료 {unfinished_count}건")

    def _on_date_selected(self, date: dt.date) -> None:
        self.selected_date = date
        self.set_selected_date(date)

    def _emit_manage_requested(self, date: dt.date | None = None) -> None:
        self.manage_requested.emit(date or self.selected_date)

    def _emit_todo_requested(self) -> None:
        self.todo_requested.emit(self.selected_date)

    def attach_to_desktop_layer(self) -> None:
        if self._desktop_attached:
            return
        try:
            self._desktop_attached = attach_window_to_desktop(int(self.winId()))
        except Exception:
            self._desktop_attached = False

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self.closed.emit()
        super().closeEvent(event)

class MainWindow(QMainWindow):
    def __init__(self, config: AppConfig) -> None:
        super().__init__()
        self.config = config
        self.message_service = MessageService(config.db_path)
        self.messages_by_key: dict[int, Message] = {}
        self._all_messages: list[Message] = []
        self._message_search_index: dict[int, str] = {}
        self.analysis_store = AIAnalysisStore(default_analysis_store_path(config.db_path))
        self.message_analyses: dict[int, MessageAnalysis] = self.analysis_store.values()
        self.events_by_date: dict[dt.date, list[CalendarEvent]] = {}
        self.overlay_window: OverlayBoardWindow | None = None
        self.ai_worker: AIAnalysisWorker | None = None
        self.ai_pending_count = 0
        self.ai_last_created_paths: list[Path] = []
        self.ai_confirm_queue: list[int] = []

        self.setWindowTitle("CoolCalendar Desktop")
        self.setMinimumSize(780, 560)
        self._build_ui()
        self._message_search_timer = QTimer(self)
        self._message_search_timer.setSingleShot(True)
        self._message_search_timer.setInterval(120)
        self._message_search_timer.timeout.connect(self._render_message_list)
        self._apply_styles()
        if self.config.main_geometry:
            self._restore_geometry(self, self.config.main_geometry)
            self._ensure_widget_visible(self)
        else:
            self._fit_widget_to_screen(self, width_ratio=0.96, height_ratio=0.92, min_size=QSize(820, 600))
        self._update_path_labels()
        self._load_all()

        self.refresh_timer = QTimer(self)
        self.refresh_timer.timeout.connect(self._load_all)
        self.refresh_timer.start(self.config.refresh_seconds * 1000)

        # DB 파일이 바뀌는 즉시 반영. 연속 쓰기를 한 번의 새로고침으로 묶기 위해 짧게 디바운스한다.
        self._db_reload_timer = QTimer(self)
        self._db_reload_timer.setSingleShot(True)
        self._db_reload_timer.setInterval(700)
        self._db_reload_timer.timeout.connect(self._load_all)

        self.db_watcher = QFileSystemWatcher(self)
        self.db_watcher.fileChanged.connect(self._on_db_file_changed)
        self.db_watcher.directoryChanged.connect(self._on_db_dir_changed)
        self._watch_db_paths()

    def _watch_db_paths(self) -> None:
        stale = self.db_watcher.files() + self.db_watcher.directories()
        if stale:
            self.db_watcher.removePaths(stale)

        targets = [self.config.db_path]
        # WAL 모드에서는 본 파일 대신 -wal 파일에 먼저 기록되므로 함께 감시한다.
        targets.extend(Path(str(self.config.db_path) + ext) for ext in ("-wal", "-shm"))
        existing = [str(path) for path in targets if path.exists()]
        if existing:
            self.db_watcher.addPaths(existing)
        parent = self.config.db_path.parent
        if parent.is_dir():
            self.db_watcher.addPath(str(parent))

    def _on_db_file_changed(self, _path: str) -> None:
        self._db_reload_timer.start()
        # 저장 시 파일이 교체되면 감시가 풀리므로 잠시 후 다시 등록한다.
        QTimer.singleShot(250, self._watch_db_paths)

    def _on_db_dir_changed(self, _path: str) -> None:
        watched_before = set(self.db_watcher.files())
        self._watch_db_paths()
        if set(self.db_watcher.files()) != watched_before:
            self._db_reload_timer.start()

    def _build_ui(self) -> None:
        central = BackdropWidget()
        central.setObjectName("rootSurface")
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(16, 16, 16, 14)
        layout.setSpacing(12)

        self.hero = QFrame()
        self.hero.setObjectName("topToolbar")
        apply_shadow(self.hero, blur=22, alpha=18, y_offset=5)
        hero_layout = QVBoxLayout(self.hero)
        hero_layout.setContentsMargins(12, 10, 12, 10)
        hero_layout.setSpacing(0)

        hero_top = QHBoxLayout()
        hero_top.setSpacing(16)
        hero_layout.addLayout(hero_top)

        self.ai_chip = QLabel("")
        self.ai_chip.setVisible(False)

        hero_top.addStretch(1)

        action_box = QHBoxLayout()
        action_box.setSpacing(8)
        hero_top.addLayout(action_box)
        action_box.addWidget(
            self._make_button("새 일정", self.create_event_for_current_date, tooltip="선택한 날짜에 새 일정을 추가합니다.")
        )
        action_box.addWidget(
            self._make_button(
                "오버레이 보드",
                self.toggle_overlay,
                variant="secondary",
                tooltip="바탕화면 위에 월간 캘린더 보드를 띄웁니다.",
            )
        )
        action_box.addWidget(
            self._make_button(
                "새로고침", self._load_all, variant="ghost", tooltip="메시지와 일정을 지금 다시 불러옵니다."
            )
        )
        action_box.addWidget(
            self._make_button(
                "재시작", self.restart_application, variant="ghost", tooltip="저장된 설정으로 앱을 다시 시작합니다."
            )
        )

        tools_button = QToolButton()
        tools_button.setText("설정 및 동기화")
        tools_button.setProperty("variant", "secondary")
        tools_button.setPopupMode(QToolButton.InstantPopup)
        tools_button.setToolButtonStyle(Qt.ToolButtonTextOnly)
        tools_button.setToolTip("AI, Google Calendar, 저장 위치와 화면 설정을 엽니다.")
        tools_menu = QMenu(tools_button)
        tools_menu.addAction("AI 설정", self.open_ai_settings)
        tools_menu.addAction("Google Calendar 설정", self.open_google_calendar_settings)
        tools_menu.addAction("Google Calendar 동기화", self.import_google_calendar_events)
        tools_menu.addSeparator()
        tools_menu.addAction("DB 변경", self.change_db_path)
        tools_menu.addAction("일정 폴더 변경", self.change_event_dir)
        tools_menu.addAction("일정 폴더 열기", self.open_event_dir)
        tools_menu.addSeparator()
        tools_menu.addAction("화면 맞춤", self.fit_current_windows_to_screen)
        tools_button.setMenu(tools_menu)
        action_box.addWidget(tools_button)

        self.today_tile = StatTile("오늘")
        self.message_tile = StatTile("메시지")
        self.event_tile = StatTile("일정")
        self.selection_tile = StatTile("선택한 날짜")

        self.db_chip = QLabel("")
        self.db_chip.setObjectName("statusChip")

        self.dir_chip = QLabel("")
        self.dir_chip.setObjectName("statusChip")

        layout.addWidget(self.hero)

        splitter = QSplitter()
        splitter.setChildrenCollapsible(False)
        layout.addWidget(splitter, 1)

        self.left_panel = QFrame()
        self.left_panel.setObjectName("panel")
        apply_shadow(self.left_panel, blur=28, alpha=22, y_offset=8)
        left_layout = QVBoxLayout(self.left_panel)
        left_layout.setContentsMargins(16, 16, 16, 16)
        left_layout.setSpacing(10)
        left_layout.addWidget(self._section_title("메시지 인박스", "카드형 리스트에서 메시지를 고르고 바로 달력에 넣을 수 있습니다."))

        self.message_search = QLineEdit()
        self.message_search.setObjectName("searchField")
        self.message_search.setPlaceholderText("메시지 검색  (보낸 사람 · 제목 · 내용)")
        self.message_search.setClearButtonEnabled(True)
        self.message_search.textChanged.connect(self._schedule_message_render)
        left_layout.addWidget(self.message_search)

        self.message_list = MessageListWidget()
        self.message_list.currentItemChanged.connect(self.on_message_selected)
        self.message_list.itemDoubleClicked.connect(lambda *_args: self.add_selected_message_to_current_date())
        left_layout.addWidget(self.message_list, 5)

        self.add_selected_btn = self._make_button("선택 메시지 일정 추가", self.add_selected_message_to_current_date)
        self.add_selected_btn.setEnabled(False)
        action_row = QHBoxLayout()
        action_row.setSpacing(10)
        action_row.addWidget(self.add_selected_btn, 1)

        self.ai_analyze_btn = self._make_button("AI 분석", self.analyze_selected_message, variant="secondary", tooltip="선택한 메시지에서 일정과 할 일을 분석합니다.")
        self.ai_analyze_btn.setEnabled(False)
        action_row.addWidget(self.ai_analyze_btn, 1)
        left_layout.addLayout(action_row)

        self.message_detail = QTextEdit()
        self.message_detail.setObjectName("detailPane")
        self.message_detail.setReadOnly(True)
        self.message_detail.setPlaceholderText("메시지를 선택하면 요약, 원문, 추천 일정 정보가 여기에 표시됩니다.")
        left_layout.addWidget(self.message_detail, 2)
        splitter.addWidget(self.left_panel)

        self.right_panel = QFrame()
        self.right_panel.setObjectName("panel")
        apply_shadow(self.right_panel, blur=28, alpha=22, y_offset=8)
        right_layout = QVBoxLayout(self.right_panel)
        right_layout.setContentsMargins(16, 16, 16, 16)
        right_layout.setSpacing(10)
        self.board_shell = QFrame()
        self.board_shell.setObjectName("boardShell")
        board_shell_layout = QVBoxLayout(self.board_shell)
        board_shell_layout.setContentsMargins(0, 0, 0, 0)
        board_shell_layout.setSpacing(0)
        self.board = CalendarBoardWidget("메인 보드")
        self.board.setObjectName("mainBoard")
        self.board.title_label.setVisible(False)
        self.board.tip_label.setVisible(False)
        self.board.date_selected.connect(self.on_date_selected)
        self.board.message_dropped.connect(self.on_message_dropped)
        self.board.day_open_requested.connect(self.open_day_manager)
        board_shell_layout.addWidget(self.board)
        right_layout.addWidget(self.board_shell, 8)

        event_toolbar = QHBoxLayout()
        event_toolbar.setSpacing(10)
        right_layout.addLayout(event_toolbar)

        self.selected_date_label = QLabel("")
        self.selected_date_label.setObjectName("selectionLabel")
        event_toolbar.addWidget(self.selected_date_label, 1)

        self.new_event_btn = self._make_button(
            "새 일정", self.create_event_for_current_date, variant="secondary", tooltip="선택한 날짜에 새 일정을 추가합니다."
        )
        event_toolbar.addWidget(self.new_event_btn)

        self.event_todo_btn = self._make_button(
            "일정 체크", self.open_event_todo_for_current_date, variant="secondary", tooltip="선택한 날짜의 등록 일정을 체크리스트로 엽니다."
        )
        event_toolbar.addWidget(self.event_todo_btn)

        self.event_trash_btn = self._make_button("휴지통", self.open_event_trash, variant="ghost", tooltip="삭제한 일정을 복원하거나 영구 삭제합니다.")
        event_toolbar.addWidget(self.event_trash_btn)

        self.edit_event_btn = self._make_button("수정", self.edit_current_event, variant="ghost", tooltip="선택한 일정을 수정합니다.")
        self.edit_event_btn.setEnabled(False)
        event_toolbar.addWidget(self.edit_event_btn)

        self.open_event_btn = self._make_button("열기", self.open_current_event, variant="ghost", tooltip="일정 파일을 기본 프로그램으로 엽니다.")
        self.open_event_btn.setEnabled(False)
        event_toolbar.addWidget(self.open_event_btn)

        self.delete_event_btn = self._make_button("휴지통", self.delete_current_event, variant="danger", tooltip="선택한 일정을 휴지통으로 이동합니다.")
        self.delete_event_btn.setEnabled(False)
        event_toolbar.addWidget(self.delete_event_btn)

        bottom = QSplitter(Qt.Horizontal)
        bottom.setChildrenCollapsible(False)
        right_layout.addWidget(bottom, 2)

        self.event_list = EventListWidget()
        self.event_list.currentItemChanged.connect(self.on_event_selected)
        self.event_list.itemDoubleClicked.connect(self.open_current_event)
        self.event_list.delete_requested.connect(self.delete_current_event)
        bottom.addWidget(self.event_list)

        self.event_detail = QTextEdit()
        self.event_detail.setObjectName("detailPane")
        self.event_detail.setReadOnly(True)
        self.event_detail.setPlaceholderText("일정을 선택하면 일정 메모와 파일 정보를 확인할 수 있습니다.")
        bottom.addWidget(self.event_detail)

        splitter.addWidget(self.right_panel)
        splitter.setSizes([480, 1060])
        bottom.setSizes([360, 560])

        status = self.statusBar()
        status.addPermanentWidget(self.db_chip)
        status.addPermanentWidget(self.dir_chip)
        status.showMessage("준비됨")

        search_shortcut = QShortcut(QKeySequence("Ctrl+F"), self)
        search_shortcut.activated.connect(self.message_search.setFocus)
        new_event_shortcut = QShortcut(QKeySequence("Ctrl+N"), self)
        new_event_shortcut.activated.connect(self.create_event_for_current_date)
        refresh_shortcut = QShortcut(QKeySequence("Ctrl+R"), self)
        refresh_shortcut.activated.connect(self._load_all)

    def _make_button(self, text: str, slot, *, variant: str = "primary", tooltip: str = "") -> QPushButton:
        button = QPushButton(text)
        button.setProperty("variant", variant)
        button.clicked.connect(slot)
        if tooltip:
            button.setToolTip(tooltip)
        return button

    def _section_title(self, title: str, subtitle: str) -> QWidget:
        box = QWidget()
        layout = QVBoxLayout(box)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        title_label = QLabel(title)
        title_label.setObjectName("sectionTitle")
        layout.addWidget(title_label)

        subtitle_label = QLabel(subtitle)
        subtitle_label.setObjectName("sectionSubtitle")
        subtitle_label.setWordWrap(True)
        layout.addWidget(subtitle_label)

        return box

    def _apply_styles(self) -> None:
        stylesheet = """
            QMainWindow, QWidget#rootSurface {
                background: transparent;
                color: #f3f7fb;
                font-family: "Malgun Gothic", "Segoe UI";
                font-size: 10pt;
            }
            QFrame#heroCard, QFrame#panel, QFrame#boardShell, QFrame#overlayShell {
                background: rgba(10, 22, 36, 0.68);
                border: 1px solid rgba(186, 223, 245, 0.18);
                border-radius: 22px;
            }
            QFrame#dialogShell {
                background: qlineargradient(
                    x1: 0, y1: 0, x2: 1, y2: 1,
                    stop: 0 rgba(9, 24, 40, 0.98),
                    stop: 0.55 rgba(16, 39, 61, 0.96),
                    stop: 1 rgba(19, 49, 76, 0.94)
                );
                border: 1px solid rgba(191, 227, 245, 0.18);
                border-radius: 30px;
            }
            QFrame#boardShell {
                background: rgba(11, 28, 46, 0.72);
            }
            QFrame#dialogHeader {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(196, 230, 247, 0.12);
                border-radius: 22px;
            }
            QFrame#dialogSection, QFrame#dialogSectionSoft {
                background: rgba(7, 21, 34, 0.56);
                border: 1px solid rgba(180, 222, 244, 0.12);
                border-radius: 24px;
            }
            QFrame#dialogSectionSoft {
                background: rgba(255, 255, 255, 0.045);
            }
            QFrame#alertContent {
                background: rgba(5, 17, 29, 0.44);
                border: 1px solid rgba(190, 226, 246, 0.12);
                border-radius: 20px;
            }
            QFrame#alertIcon {
                border-radius: 22px;
            }
            QFrame#alertIcon[tone="info"], QFrame#alertIcon[tone="question"] {
                background: rgba(85, 175, 255, 0.20);
                border: 1px solid rgba(142, 209, 255, 0.38);
            }
            QFrame#alertIcon[tone="warning"] {
                background: rgba(236, 173, 84, 0.20);
                border: 1px solid rgba(255, 212, 134, 0.38);
            }
            QFrame#alertIcon[tone="error"] {
                background: rgba(241, 99, 112, 0.20);
                border: 1px solid rgba(255, 165, 173, 0.38);
            }
            QLabel#alertIconGlyph {
                color: #f4fbff;
                font-size: 20pt;
                font-weight: 800;
            }
            QLabel#alertMessage {
                color: #e5f3fb;
                font-size: 10.5pt;
                line-height: 1.45;
            }
            QLabel#heroEyebrow {
                color: #a8d9ff;
                font-size: 9pt;
                font-weight: 600;
                letter-spacing: 1px;
            }
            QLabel#heroTitle {
                color: #f6fbff;
                font-family: "Malgun Gothic", "Segoe UI";
                font-size: 20pt;
                font-weight: 700;
            }
            QLabel#heroSubtitle, QLabel#sectionSubtitle, QLabel#statDetail, QLabel#boardTip {
                color: #95b4ca;
            }
            QLabel#sectionTitle, QLabel#boardTitle {
                color: #f7fbff;
                font-family: "Malgun Gothic", "Segoe UI";
                font-size: 15pt;
                font-weight: 700;
            }
            QLabel#dialogTitle {
                color: #f8fbff;
                font-family: "Malgun Gothic", "Segoe UI";
                font-size: 18pt;
                font-weight: 700;
            }
            QLabel#dialogSubtitle, QLabel#dialogHint {
                color: #9fbfd5;
            }
            QLabel#dialogSectionTitle, QLabel#dialogFieldLabel {
                color: #e4f3fc;
                font-size: 9.6pt;
                font-weight: 700;
            }
            QFrame#statTile {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 14px;
            }
            QLabel#statCaption {
                color: #86b6d5;
                font-size: 9pt;
                font-weight: 600;
            }
            QLabel#statValue {
                color: #ffffff;
                font-size: 16pt;
                font-weight: 700;
            }
            QLabel#pathChip {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(186, 223, 245, 0.12);
                border-radius: 12px;
                padding: 8px 12px;
                color: #cfe4f3;
            }
            QFrame#dialogShell QLineEdit,
            QFrame#dialogShell QTextEdit,
            QFrame#dialogShell QDateEdit,
            QFrame#dialogShell QTimeEdit {
                background: rgba(7, 20, 33, 0.76);
                border: 1px solid rgba(173, 215, 242, 0.14);
                border-radius: 16px;
                padding: 11px 14px;
                color: #ecf7ff;
                selection-background-color: rgba(103, 181, 255, 0.34);
            }
            QFrame#dialogShell QLineEdit:focus,
            QFrame#dialogShell QTextEdit:focus,
            QFrame#dialogShell QDateEdit:focus,
            QFrame#dialogShell QTimeEdit:focus {
                border: 1px solid rgba(174, 228, 255, 0.72);
                background: rgba(11, 29, 46, 0.88);
            }
            QFrame#dialogShell QDateEdit::drop-down,
            QFrame#dialogShell QTimeEdit::drop-down {
                subcontrol-origin: padding;
                subcontrol-position: top right;
                width: 28px;
                border: none;
                background: transparent;
            }
            QFrame#dialogShell QCheckBox {
                color: #edf7ff;
                spacing: 10px;
            }
            QFrame#dialogShell QCheckBox::indicator {
                width: 18px;
                height: 18px;
                border-radius: 9px;
                border: 1px solid rgba(176, 220, 244, 0.42);
                background: rgba(255, 255, 255, 0.05);
            }
            QFrame#dialogShell QCheckBox::indicator:checked {
                background: rgba(236, 173, 84, 0.98);
                border: 1px solid rgba(255, 220, 136, 0.78);
            }
            QFrame#dialogShell QCalendarWidget QWidget {
                alternate-background-color: rgba(255, 255, 255, 0.03);
                background: rgba(10, 23, 37, 0.98);
                color: #ecf7ff;
            }
            QFrame#dialogShell QCalendarWidget QToolButton {
                background: rgba(255, 255, 255, 0.06);
                color: #e6f4ff;
                border: none;
                border-radius: 10px;
                padding: 6px 10px;
                margin: 6px;
            }
            QFrame#dialogShell QCalendarWidget QAbstractItemView:enabled {
                background: rgba(10, 23, 37, 0.98);
                color: #ecf7ff;
                selection-background-color: rgba(98, 178, 244, 0.35);
                selection-color: white;
            }
            QListWidget {
                background: transparent;
                border: none;
                outline: none;
            }
            QListWidget::item {
                background: transparent;
                border: none;
                padding: 0px;
                margin: 0px;
            }
            QListWidget#eventTodoList {
                background: transparent;
                border: none;
            }
            QFrame#dialogShell QFrame#eventTodoRow {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(189, 227, 247, 0.14);
                border-radius: 14px;
            }
            QFrame#dialogShell QFrame#eventTodoRow[completed="true"] {
                background: rgba(255, 255, 255, 0.035);
                border-color: rgba(189, 227, 247, 0.08);
            }
            QFrame#dialogShell QCheckBox#eventTodoCheck {
                color: #f3f9fd;
                spacing: 10px;
                font-size: 10.5pt;
                font-weight: 600;
            }
            QFrame#dialogShell QFrame#eventTodoRow[completed="true"] QCheckBox#eventTodoCheck {
                color: #8da9bd;
            }
            QFrame#dialogShell QLabel#eventDoneLabel {
                color: #9bcbb3;
                font-size: 8.5pt;
                font-weight: 700;
            }
            QTextEdit#detailPane {
                background: rgba(7, 20, 33, 0.72);
                border: 1px solid rgba(173, 215, 242, 0.14);
                border-radius: 16px;
                padding: 12px;
                color: #ebf5fc;
                selection-background-color: rgba(104, 183, 255, 0.35);
            }
            QFrame#messageCard, QFrame#eventCard {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.07);
                border-radius: 16px;
            }
            QFrame#messageCard[selected="true"], QFrame#eventCard[selected="true"] {
                background: rgba(92, 170, 235, 0.16);
                border: 1px solid rgba(165, 226, 255, 0.58);
            }
            QLabel#cardTitle {
                color: #f9fcff;
                font-size: 10.8pt;
                font-weight: 700;
            }
            QLabel#cardBody {
                color: #d8e9f4;
                line-height: 125%;
            }
            QLabel#cardSubBody {
                color: #88a9bf;
                line-height: 120%;
            }
            QLabel#cardMetaPill, QLabel#softChip, QLabel#timeBadge, QLabel#dayBadge {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(189, 227, 247, 0.18);
                border-radius: 10px;
                padding: 4px 8px;
                color: #dff3ff;
                font-size: 9pt;
                font-weight: 600;
            }
            QLabel#timeBadge {
                color: #ffd874;
                border-color: rgba(255, 216, 116, 0.45);
            }
            QPushButton, QToolButton {
                background: rgba(235, 167, 87, 0.96);
                color: #112338;
                border: none;
                border-radius: 12px;
                padding: 9px 14px;
                font-weight: 700;
            }
            QPushButton:hover, QToolButton:hover {
                background: rgba(247, 190, 104, 1.0);
            }
            QPushButton:disabled, QToolButton:disabled {
                background: rgba(120, 132, 146, 0.45);
                color: rgba(240, 246, 251, 0.55);
            }
            QPushButton[variant="secondary"], QToolButton[variant="secondary"] {
                background: rgba(166, 226, 255, 0.16);
                color: #dff4ff;
                border: 1px solid rgba(165, 226, 255, 0.28);
            }
            QPushButton[variant="secondary"]:hover, QToolButton[variant="secondary"]:hover,
            QPushButton[variant="ghost"]:hover, QToolButton[variant="ghost"]:hover {
                background: rgba(166, 226, 255, 0.24);
            }
            QPushButton[variant="ghost"], QToolButton[variant="ghost"] {
                background: rgba(255, 255, 255, 0.07);
                color: #d5ebfb;
                border: 1px solid rgba(255, 255, 255, 0.10);
            }
            QPushButton[variant="danger"] {
                background: rgba(190, 83, 96, 0.95);
                color: white;
            }
            QPushButton[variant="danger"]:hover {
                background: rgba(209, 93, 108, 1.0);
            }
        """
        stylesheet += """
            QLabel#weekdayLabel {
                background: rgba(141, 208, 247, 0.12);
                border: 1px solid rgba(165, 226, 255, 0.14);
                border-radius: 10px;
                padding: 6px 0px;
                color: #cdeaff;
                font-size: 9pt;
                font-weight: 700;
            }
            DayCell {
                border-radius: 14px;
                min-height: 46px;
                background: rgba(95, 160, 204, 0.14);
                border: 1px solid rgba(174, 225, 255, 0.12);
            }
            DayCell[class~="cellOther"] {
                background: rgba(150, 160, 176, 0.10);
            }
            DayCell[class~="cellWeekend"] {
                background: rgba(116, 162, 193, 0.18);
            }
            DayCell[class~="cellToday"] {
                border: 1px solid rgba(255, 220, 110, 0.96);
            }
            DayCell[class~="cellSelected"] {
                background: rgba(97, 178, 244, 0.22);
                border: 1px solid rgba(179, 230, 255, 0.95);
            }
            DayCell[dropTarget="true"] {
                background: rgba(96, 185, 255, 0.26);
                border: 2px solid rgba(202, 241, 255, 0.96);
            }
            DayCell QLabel#dropHint {
                background: rgba(9, 28, 45, 0.64);
                border: 1px solid rgba(192, 233, 255, 0.48);
                border-radius: 9px;
                color: #e9f8ff;
                font-size: 8.5pt;
                font-weight: 700;
                padding: 4px 7px;
            }
            QLabel#dayLabel {
                background: transparent;
                color: #f7fbff;
                font-size: 10.5pt;
                font-weight: 700;
            }
            QLabel#dayLabel[tone="sun"] {
                color: #ffb1b8;
            }
            QLabel#dayLabel[tone="sat"] {
                color: #a9ddff;
            }
            QLabel#dayLabel[tone="muted"] {
                color: rgba(240, 248, 255, 0.45);
            }
            QLabel#weekdayLabel[dow="sun"] {
                color: #ffb1b8;
            }
            QLabel#weekdayLabel[dow="sat"] {
                color: #a9ddff;
            }
            QLabel#appTitle {
                color: #f6fbff;
                font-size: 15pt;
                font-weight: 800;
            }
            QLineEdit#searchField {
                background: rgba(7, 20, 33, 0.76);
                border: 1px solid rgba(173, 215, 242, 0.14);
                border-radius: 12px;
                padding: 9px 12px;
                color: #ecf7ff;
            }
            QLineEdit#searchField:focus {
                border: 1px solid rgba(174, 228, 255, 0.72);
            }
            QLabel#eventsLabel {
                background: transparent;
                color: #eaf5fc;
                font-size: 8pt;
            }
            QLabel#boardFooter {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(176, 220, 244, 0.12);
                border-radius: 13px;
                padding: 9px 12px;
                color: #d7edf9;
            }
            QFrame#overlayChrome {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(194, 229, 248, 0.16);
                border-radius: 18px;
            }
            QLabel#overlayTitle {
                color: #ffffff;
                font-size: 13.5pt;
                font-weight: 700;
            }
            QLabel#overlayMeta {
                color: #a9d4ef;
            }
            QFrame#dialogShell QSlider::groove:horizontal {
                height: 6px;
                background: rgba(255, 255, 255, 0.12);
                border-radius: 3px;
            }
            QFrame#dialogShell QSlider::sub-page:horizontal {
                background: rgba(236, 173, 84, 0.55);
                border-radius: 3px;
            }
            QFrame#dialogShell QSlider::handle:horizontal {
                width: 18px;
                height: 18px;
                margin: -7px 0;
                border-radius: 9px;
                background: rgba(236, 173, 84, 0.98);
            }
            QFrame#dialogShell QRadioButton {
                color: #edf7ff;
                spacing: 10px;
            }
            QFrame#dialogShell QRadioButton::indicator {
                width: 18px;
                height: 18px;
                border-radius: 9px;
                border: 1px solid rgba(176, 220, 244, 0.42);
                background: rgba(255, 255, 255, 0.05);
            }
            QFrame#dialogShell QRadioButton::indicator:checked {
                background: rgba(236, 173, 84, 0.98);
                border: 1px solid rgba(255, 220, 136, 0.78);
            }
            QScrollBar:vertical {
                background: transparent;
                width: 12px;
                margin: 6px 0px;
            }
            QScrollBar::handle:vertical {
                background: rgba(184, 223, 244, 0.28);
                border-radius: 6px;
                min-height: 30px;
            }
            QScrollBar::handle:vertical:hover {
                background: rgba(184, 223, 244, 0.42);
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical,
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical,
            QScrollBar:horizontal, QScrollBar::handle:horizontal,
            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal,
            QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {
                background: transparent;
                border: none;
            }
        """
        stylesheet += """
            QWidget#rootSurface {
                color: #1c1c1e;
                font-family: "Segoe UI Variable", "Malgun Gothic", "Segoe UI";
            }
            QWidget#rootSurface QFrame#heroCard,
            QWidget#rootSurface QFrame#panel,
            QWidget#rootSurface QFrame#boardShell {
                background: rgba(255, 255, 255, 0.96);
                border: 1px solid rgba(60, 60, 67, 0.12);
                border-radius: 18px;
            }
            QWidget#rootSurface QFrame#topToolbar {
                background: rgba(255, 255, 255, 0.84);
                border: 1px solid rgba(255, 255, 255, 0.82);
                border-radius: 16px;
            }
            QWidget#rootSurface QFrame#heroCard {
                background: rgba(255, 255, 255, 0.98);
            }
            QWidget#rootSurface QFrame#boardShell {
                background: transparent;
                border: none;
            }
            QWidget#rootSurface QLabel#heroEyebrow {
                color: #3182f6;
                font-size: 9pt;
                font-weight: 800;
                letter-spacing: 0px;
            }
            QWidget#rootSurface QLabel#heroTitle {
                color: #191f28;
                font-size: 22pt;
                font-weight: 800;
            }
            QWidget#rootSurface QLabel#heroSubtitle,
            QWidget#rootSurface QLabel#sectionSubtitle,
            QWidget#rootSurface QLabel#statDetail,
            QWidget#rootSurface QLabel#boardTip {
                color: #6b7684;
            }
            QWidget#rootSurface QLabel#sectionTitle,
            QWidget#rootSurface QLabel#boardTitle {
                color: #1c1c1e;
                font-size: 13pt;
                font-weight: 700;
            }
            QWidget#rootSurface QLabel#selectionLabel {
                color: #1c1c1e;
                font-size: 11pt;
                font-weight: 700;
            }
            QWidget#rootSurface QFrame#statTile {
                background: #f7f9fb;
                border: 1px solid #edf1f5;
                border-radius: 16px;
            }
            QWidget#rootSurface QLabel#statCaption {
                color: #8b95a1;
                font-size: 9pt;
                font-weight: 700;
            }
            QWidget#rootSurface QLabel#statValue {
                color: #191f28;
                font-size: 17pt;
                font-weight: 800;
            }
            QWidget#rootSurface QLabel#pathChip {
                background: #f7f9fb;
                border: 1px solid #edf1f5;
                border-radius: 14px;
                color: #4e5968;
                padding: 9px 12px;
            }
            QWidget#rootSurface QTextEdit#detailPane {
                background: #f7f7fa;
                border: 1px solid rgba(60, 60, 67, 0.10);
                border-radius: 14px;
                color: #1c1c1e;
                padding: 13px;
                selection-background-color: rgba(0, 122, 255, 0.20);
            }
            QWidget#rootSurface QFrame#messageCard,
            QWidget#rootSurface QFrame#eventCard {
                background: #ffffff;
                border: 1px solid rgba(60, 60, 67, 0.12);
                border-radius: 13px;
            }
            QWidget#rootSurface QFrame#messageCard[selected="true"],
            QWidget#rootSurface QFrame#eventCard[selected="true"] {
                background: #eaf3ff;
                border: 1px solid rgba(0, 122, 255, 0.52);
            }
            QWidget#rootSurface QFrame#messageCard[dragging="true"] {
                background: #eaf3ff;
                border: 2px solid #007aff;
            }
            QWidget#rootSurface QFrame#eventCard[completed="true"] {
                background: #f7f7fa;
                border-color: rgba(60, 60, 67, 0.08);
            }
            QWidget#rootSurface QFrame#eventCard[completed="true"] QLabel#cardTitle,
            QWidget#rootSurface QFrame#eventCard[completed="true"] QLabel#cardBody,
            QWidget#rootSurface QFrame#eventCard[completed="true"] QLabel#cardSubBody {
                color: #8e8e93;
            }
            QWidget#rootSurface QLabel#cardTitle {
                color: #191f28;
                font-size: 10.2pt;
                font-weight: 800;
            }
            QWidget#rootSurface QLabel#cardBody {
                color: #333d4b;
                font-size: 9.2pt;
            }
            QWidget#rootSurface QLabel#cardSubBody {
                color: #6b7684;
            }
            QWidget#rootSurface QLabel#cardMetaPill,
            QWidget#rootSurface QLabel#softChip,
            QWidget#rootSurface QLabel#timeBadge,
            QWidget#rootSurface QLabel#dayBadge {
                background: #f2f4f6;
                border: 1px solid #e5e8eb;
                border-radius: 10px;
                color: #4e5968;
                font-size: 8.5pt;
                font-weight: 700;
                padding: 3px 7px;
            }
            QWidget#rootSurface QLabel#timeBadge {
                background: #fff6db;
                color: #b27800;
                border-color: #ffe4a3;
            }
            QWidget#rootSurface QPushButton, QWidget#rootSurface QToolButton {
                background: #007aff;
                color: #ffffff;
                border: none;
                border-radius: 10px;
                padding: 8px 13px;
                font-weight: 700;
            }
            QWidget#rootSurface QPushButton:hover, QWidget#rootSurface QToolButton:hover {
                background: #0069dd;
            }
            QWidget#rootSurface QPushButton:pressed, QWidget#rootSurface QToolButton:pressed {
                background: #0058b8;
            }
            QWidget#rootSurface QPushButton:disabled, QWidget#rootSurface QToolButton:disabled {
                background: #e5e8eb;
                color: #a5adba;
            }
            QWidget#rootSurface QPushButton[variant="secondary"],
            QWidget#rootSurface QToolButton[variant="secondary"] {
                background: #eaf3ff;
                color: #007aff;
                border: 1px solid rgba(0, 122, 255, 0.16);
            }
            QWidget#rootSurface QPushButton[variant="secondary"]:hover,
            QWidget#rootSurface QToolButton[variant="secondary"]:hover {
                background: #dcecff;
            }
            QWidget#rootSurface QPushButton[variant="ghost"],
            QWidget#rootSurface QToolButton[variant="ghost"] {
                background: #f2f2f7;
                color: #3a3a3c;
                border: 1px solid rgba(60, 60, 67, 0.12);
            }
            QWidget#rootSurface QPushButton[variant="ghost"]:hover,
            QWidget#rootSurface QToolButton[variant="ghost"]:hover {
                background: #e5e5ea;
            }
            QWidget#rootSurface QPushButton[variant="danger"] {
                background: #fff0ef;
                color: #ff3b30;
                border: 1px solid rgba(255, 59, 48, 0.20);
            }
            QWidget#rootSurface QPushButton[variant="danger"]:hover {
                background: #ffe2df;
            }
            CalendarBoardWidget#mainBoard QFrame#calendarNav {
                background: #f2f2f7;
                border: 1px solid rgba(60, 60, 67, 0.12);
                border-radius: 12px;
            }
            CalendarBoardWidget#mainBoard QFrame#calendarNav QPushButton#calendarNavButton {
                background: transparent;
                color: #3a3a3c;
                border: none;
                border-radius: 9px;
                padding: 7px 12px;
                font-weight: 700;
            }
            CalendarBoardWidget#mainBoard QFrame#calendarNav QPushButton#calendarNavButton:hover {
                background: rgba(255, 255, 255, 0.92);
            }
            CalendarBoardWidget#mainBoard QFrame#calendarNav QPushButton#calendarNavButton:pressed {
                background: #dedee5;
            }
            CalendarBoardWidget#mainBoard QLabel#weekdayLabel {
                background: #f7f7fa;
                border: 1px solid rgba(60, 60, 67, 0.10);
                border-radius: 10px;
                color: #3a3a3c;
                font-size: 9pt;
                font-weight: 800;
            }
            CalendarBoardWidget#mainBoard DayCell {
                background: #ffffff;
                border: 1px solid rgba(60, 60, 67, 0.10);
                border-radius: 10px;
                min-height: 50px;
            }
            CalendarBoardWidget#mainBoard DayCell[class~="cellOther"] {
                background: #f7f7fa;
                border-color: rgba(60, 60, 67, 0.06);
            }
            CalendarBoardWidget#mainBoard DayCell[class~="cellWeekend"] {
                background: #fbfcfe;
            }
            CalendarBoardWidget#mainBoard DayCell:hover {
                background: #f5f9ff;
                border: 1px solid rgba(0, 122, 255, 0.36);
            }
            CalendarBoardWidget#mainBoard DayCell[dropTarget="true"] {
                background: #e1f0ff;
                border: 2px solid #007aff;
            }
            CalendarBoardWidget#mainBoard DayCell QLabel#dropHint {
                background: #007aff;
                border: none;
                border-radius: 9px;
                color: #ffffff;
                font-size: 8.5pt;
                font-weight: 700;
                padding: 4px 7px;
            }
            CalendarBoardWidget#mainBoard DayCell[class~="cellToday"] {
                border: 2px solid #007aff;
                background: #eef6ff;
            }
            CalendarBoardWidget#mainBoard DayCell[class~="cellSelected"] {
                border: 2px solid #007aff;
                background: #eaf3ff;
            }
            CalendarBoardWidget#mainBoard DayCell[dropTarget="true"] {
                background: #e1f0ff;
                border: 2px solid #007aff;
            }
            CalendarBoardWidget#mainBoard QLabel#dayLabel {
                color: #191f28;
                font-size: 10.5pt;
                font-weight: 800;
            }
            CalendarBoardWidget#mainBoard QLabel#dayLabel[tone="sun"] {
                color: #e5484d;
            }
            CalendarBoardWidget#mainBoard QLabel#dayLabel[tone="sat"] {
                color: #1769e0;
            }
            CalendarBoardWidget#mainBoard QLabel#dayLabel[tone="muted"] {
                color: #b0b8c1;
            }
            CalendarBoardWidget#mainBoard QLabel#weekdayLabel[dow="sun"] {
                color: #e5484d;
            }
            CalendarBoardWidget#mainBoard QLabel#weekdayLabel[dow="sat"] {
                color: #1769e0;
            }
            QWidget#rootSurface QLabel#appTitle {
                color: #191f28;
                font-size: 15pt;
                font-weight: 800;
            }
            QWidget#rootSurface QLineEdit#searchField {
                background: #f2f2f7;
                border: 1px solid rgba(60, 60, 67, 0.10);
                border-radius: 11px;
                padding: 9px 12px;
                color: #1c1c1e;
                selection-background-color: rgba(0, 122, 255, 0.20);
            }
            QWidget#rootSurface QLineEdit#searchField:focus {
                background: #ffffff;
                border: 2px solid #007aff;
            }
            QStatusBar {
                background: #f7f9fb;
                color: #4e5968;
            }
            QStatusBar::item {
                border: none;
            }
            QMenu {
                background: #ffffff;
                color: #333d4b;
                border: 1px solid #dfe5ec;
                border-radius: 12px;
                padding: 6px;
            }
            QMenu::item {
                border-radius: 8px;
                padding: 8px 28px 8px 12px;
            }
            QMenu::item:selected {
                background: #eaf3ff;
                color: #1769e0;
            }
            QMenu::separator {
                height: 1px;
                background: #edf1f5;
                margin: 5px 8px;
            }
            QLabel#statusChip {
                background: #f2f4f6;
                border: 1px solid #e5e8eb;
                border-radius: 9px;
                color: #6b7684;
                font-size: 8.5pt;
                padding: 3px 8px;
                margin-right: 4px;
            }
            CalendarBoardWidget#mainBoard QLabel#eventsLabel {
                color: #333d4b;
                font-size: 8pt;
            }
            CalendarBoardWidget#mainBoard QLabel#boardFooter {
                background: #ffffff;
                border: 1px solid #e5e8eb;
                border-radius: 14px;
                color: #4e5968;
            }
            QWidget#rootSurface QScrollBar::handle:vertical {
                background: rgba(139, 149, 161, 0.35);
                border-radius: 6px;
                min-height: 30px;
            }
            QWidget#rootSurface QScrollBar::handle:vertical:hover {
                background: rgba(107, 118, 132, 0.45);
            }
        """
        stylesheet += self._overlay_qss()
        app = QApplication.instance()
        if app is not None:
            app.setStyleSheet(stylesheet)

    def _overlay_qss(self) -> str:
        p = overlay_theme_palette(self.config.overlay_theme)
        opacity = max(50, min(100, int(self.config.overlay_opacity))) / 100
        scale = max(0.8, min(1.4, int(self.config.overlay_font_scale) / 100))
        chrome_alpha = max(0.68, min(0.86, 0.54 + opacity * 0.28))
        cell_alpha = max(0.78, min(0.94, 0.70 + opacity * 0.24))
        muted_cell_alpha = max(0.70, cell_alpha - 0.10)
        footer_alpha = max(0.74, cell_alpha - 0.05)

        def pt(value: float) -> str:
            return f"{value * scale:.1f}pt"

        return f"""
            QFrame#overlayShell {{
                background: qlineargradient(
                    x1: 0, y1: 0, x2: 1, y2: 1,
                    stop: 0 rgba({p["shell_rgb"]}, {min(0.96, opacity * 0.78):.2f}),
                    stop: 0.38 rgba(255, 255, 255, {min(0.10, opacity * 0.07):.2f}),
                    stop: 1 rgba({p["shell_rgb"]}, {min(0.98, opacity * 0.90):.2f})
                );
                border: 1px solid rgba(255, 255, 255, 0.34);
                border-radius: 28px;
            }}
            QFrame#overlayShell QFrame#overlayChrome {{
                background: qlineargradient(
                    x1: 0, y1: 0, x2: 0, y2: 1,
                    stop: 0 rgba(255, 255, 255, 0.15),
                    stop: 1 rgba({p["shell_rgb"]}, {chrome_alpha:.2f})
                );
                border: 1px solid rgba(255, 255, 255, 0.26);
                border-radius: 20px;
            }}
            QFrame#overlayShell QLabel#overlayTitle {{
                color: {p["overlay_title"]};
                font-size: {pt(13.5)};
                font-weight: 700;
                letter-spacing: 0.2px;
            }}
            QFrame#overlayShell QLabel#boardTitle {{
                color: {p["board_title"]};
                font-size: {pt(19)};
                font-weight: 700;
            }}
            QFrame#overlayShell QLabel#boardTip {{
                color: {p["tip"]};
                font-size: {pt(10)};
            }}
            QFrame#overlayShell QFrame#calendarNav {{
                background: rgba({p["shell_rgb"]}, {chrome_alpha:.2f});
                border: 1px solid rgba(255, 255, 255, 0.20);
                border-radius: 13px;
            }}
            QFrame#overlayShell QFrame#calendarNav QPushButton#calendarNavButton {{
                background: transparent;
                color: {p["footer"]};
                border: none;
                border-radius: 10px;
                padding: 8px 13px;
                font-size: {pt(10)};
                font-weight: 700;
            }}
            QFrame#overlayShell QFrame#calendarNav QPushButton#calendarNavButton:hover {{
                background: rgba(255, 255, 255, 0.14);
            }}
            QFrame#overlayShell QFrame#calendarNav QPushButton#calendarNavButton:pressed {{
                background: rgba(255, 255, 255, 0.22);
            }}
            QFrame#overlayShell QLabel#weekdayLabel {{
                background: rgba({p["shell_rgb"]}, {cell_alpha:.2f});
                border: 1px solid rgba(255, 255, 255, 0.20);
                border-radius: 12px;
                color: {p["weekday"]};
                font-size: {pt(10.5)};
                font-weight: 700;
                padding: 8px 0px;
            }}
            QFrame#overlayShell QLabel#weekdayLabel[dow="sun"] {{
                color: {p["weekday_sun"]};
            }}
            QFrame#overlayShell QLabel#weekdayLabel[dow="sat"] {{
                color: {p["weekday_sat"]};
            }}
            QFrame#overlayShell DayCell {{
                background: rgba({p["shell_rgb"]}, {cell_alpha:.2f});
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 16px;
            }}
            QFrame#overlayShell DayCell[class~="cellOther"] {{
                background: rgba({p["shell_rgb"]}, {muted_cell_alpha:.2f});
            }}
            QFrame#overlayShell DayCell[class~="cellWeekend"] {{
                background: rgba({p["shell_rgb"]}, {min(0.96, cell_alpha + 0.01):.2f});
            }}
            QFrame#overlayShell DayCell:hover {{
                background: rgba({p["shell_rgb"]}, {min(0.98, cell_alpha + 0.03):.2f});
                border: 1px solid rgba(214, 240, 255, 0.52);
            }}
            QFrame#overlayShell DayCell[dropTarget="true"] {{
                background: rgba(104, 191, 255, 0.34);
                border: 2px solid rgba(220, 246, 255, 0.96);
            }}
            QFrame#overlayShell DayCell QLabel#dropHint {{
                background: rgba(210, 241, 255, 0.18);
                border: 1px solid rgba(220, 246, 255, 0.48);
                border-radius: 9px;
                color: #f2fbff;
                font-size: {pt(8.8)};
                font-weight: 700;
                padding: 4px 7px;
            }}
            QFrame#overlayShell DayCell[class~="cellToday"] {{
                border: 2px solid rgba(255, 224, 126, 0.96);
                background: rgba(255, 211, 102, 0.16);
            }}
            QFrame#overlayShell DayCell[class~="cellSelected"] {{
                border: 2px solid rgba(206, 239, 255, 0.92);
                background: rgba(116, 196, 255, 0.22);
            }}
            QFrame#overlayShell DayCell[dropTarget="true"] {{
                background: rgba(104, 191, 255, 0.34);
                border: 2px solid rgba(220, 246, 255, 0.96);
            }}
            QFrame#overlayShell QLabel#dayLabel {{
                background: transparent;
                color: {p["day"]};
                font-size: {pt(13)};
                font-weight: 700;
            }}
            QFrame#overlayShell QLabel#dayLabel[tone="sun"] {{
                color: {p["day_sun"]};
            }}
            QFrame#overlayShell QLabel#dayLabel[tone="sat"] {{
                color: {p["day_sat"]};
            }}
            QFrame#overlayShell QLabel#dayLabel[tone="muted"] {{
                color: {p["day_muted"]};
            }}
            QFrame#overlayShell QLabel#dayBadge,
            QFrame#overlayShell QLabel#pathChip {{
                background: rgba(255, 255, 255, 0.11);
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 11px;
                color: {p["chip"]};
                font-size: {pt(9.5)};
                font-weight: 600;
                padding: 4px 9px;
            }}
            QFrame#overlayShell QLabel#boardFooter {{
                background: rgba({p["shell_rgb"]}, {footer_alpha:.2f});
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 15px;
                color: {p["footer"]};
                font-size: {pt(10.5)};
                padding: 11px 14px;
            }}
            QFrame#overlayShell QPushButton {{
                padding: 9px 16px;
                font-size: {pt(10.5)};
            }}
            QFrame#overlayShell QPushButton[variant="secondary"] {{
                background: {p["btn_secondary_bg"]};
                color: {p["btn_secondary"]};
                border: 1px solid {p["btn_secondary_border"]};
            }}
            QFrame#overlayShell QPushButton[variant="secondary"]:hover {{
                background: {p["btn_secondary_hover"]};
            }}
            QFrame#overlayShell QPushButton[variant="secondary"]:pressed {{
                background: rgba(255, 255, 255, 0.30);
            }}
            QFrame#overlayShell QPushButton[variant="ghost"] {{
                background: {p["btn_ghost_bg"]};
                color: {p["btn_ghost"]};
                border: 1px solid {p["btn_ghost_border"]};
            }}
            QFrame#overlayShell QPushButton[variant="ghost"]:hover {{
                background: {p["btn_ghost_hover"]};
            }}
            QFrame#overlayShell QPushButton[variant="ghost"]:pressed {{
                background: rgba(255, 255, 255, 0.20);
            }}
            QFrame#overlayShell QSizeGrip {{
                width: 18px;
                height: 18px;
                background: transparent;
            }}
        """

    def _update_path_labels(self) -> None:
        self.db_chip.setText(f"DB  {self.config.db_path.name}")
        self.db_chip.setToolTip(f"현재 DB\n{self.config.db_path}")
        self.dir_chip.setText(f"일정 폴더  {self.config.event_dir.name}")
        self.dir_chip.setToolTip(f"일정 저장 폴더\n{self.config.event_dir}")
        self._update_ai_status_chip()

    def _update_ai_status_chip(self) -> None:
        has_key = bool(resolved_api_key(self.config.openai_api_key))
        model_name = sanitize_model_name(self.config.openai_model)

        if self.ai_worker is not None:
            text = f"AI 분석 중  {self.ai_pending_count}건 대기"
        elif not self.config.ai_auto_enabled:
            text = "AI 자동 일정  꺼짐"
        elif not has_key:
            text = "AI 자동 일정  API 키 필요"
        else:
            register_mode = "바로 등록" if self.config.ai_auto_create_events else "팝업 확인"
            text = f"AI 자동 일정  켜짐 · {model_name} · {register_mode}"

        self.ai_chip.setText(text)
        tooltip_lines = [
            f"모델: {model_name}",
            f"자동 분석: {'켜짐' if self.config.ai_auto_enabled else '꺼짐'}",
            f"일정 등록 방식: {'묻지 않고 바로 등록' if self.config.ai_auto_create_events else '팝업으로 확인 후 등록'}",
            f"마지막 자동 처리 키: {self.config.ai_last_processed_message_key or '-'}",
            "API 키: 설정됨" if has_key else "API 키: 없음",
        ]
        self.ai_chip.setToolTip("\n".join(tooltip_lines))

    def _save_config(self) -> None:
        save_config(self.config)
        self._update_path_labels()

    def _analysis_for_message(self, message_key: int) -> MessageAnalysis | None:
        return self.message_analyses.get(int(message_key))

    def _store_analysis(self, analysis: MessageAnalysis) -> None:
        self.message_analyses[analysis.message_key] = analysis
        self.analysis_store.upsert(analysis)

    def _refresh_summary_tiles(self) -> None:
        today = dt.date.today()
        weekday_names = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"]
        total_events = sum(len(items) for items in self.events_by_date.values())
        selected_events = len(self.events_by_date.get(self.board.selected_date, []))

        self.today_tile.set_content(today.strftime("%m.%d"), f"{today.year}년 {weekday_names[today.weekday()]}")
        self.message_tile.set_content(str(len(self.messages_by_key)), "최근 메시지 로드 수")
        self.event_tile.set_content(str(total_events), "현재 저장된 일정")
        self.selection_tile.set_content(self.board.selected_date.strftime("%m.%d"), f"선택 날짜 일정 {selected_events}건")

    def _available_screen_geometry(self, widget: QWidget | None = None) -> QRect:
        if widget is not None:
            screen = QApplication.screenAt(widget.frameGeometry().center())
            if screen is not None:
                return screen.availableGeometry()
        screen = QApplication.primaryScreen()
        if screen is None:
            return QRect(0, 0, 1600, 900)
        return screen.availableGeometry()

    def _fit_widget_to_screen(
        self,
        widget: QWidget,
        *,
        width_ratio: float,
        height_ratio: float,
        min_size: QSize,
        top_ratio: float = 0.04,
    ) -> None:
        screen_rect = self._available_screen_geometry(widget)
        max_width = max(480, screen_rect.width() - 24)
        max_height = max(420, screen_rect.height() - 24)
        target_min_width = min(min_size.width(), max_width)
        target_min_height = min(min_size.height(), max_height)
        width = min(max(int(screen_rect.width() * width_ratio), target_min_width), max_width)
        height = min(max(int(screen_rect.height() * height_ratio), target_min_height), max_height)
        x = screen_rect.x() + max(12, (screen_rect.width() - width) // 2)
        centered_y = screen_rect.y() + max(12, (screen_rect.height() - height) // 2)
        top_y = screen_rect.y() + max(12, int(screen_rect.height() * top_ratio))
        y = min(centered_y, top_y)
        self._set_widget_screen_geometry(widget, QRect(x, y, width, height))
        self._ensure_widget_visible(widget)

    def _ensure_widget_visible(self, widget: QWidget, *, margin: int = 12) -> None:
        screen_rect = self._available_screen_geometry(widget)
        geometry = self._widget_screen_geometry(widget)
        width = min(max(widget.minimumWidth(), geometry.width()), max(widget.minimumWidth(), screen_rect.width() - margin * 2))
        height = min(
            max(widget.minimumHeight(), geometry.height()),
            max(widget.minimumHeight(), screen_rect.height() - margin * 2),
        )
        min_x = screen_rect.x() + margin
        min_y = screen_rect.y() + margin
        max_x = screen_rect.x() + max(margin, screen_rect.width() - width - margin)
        max_y = screen_rect.y() + max(margin, screen_rect.height() - height - margin)
        x = min(max(geometry.x(), min_x), max_x)
        y = min(max(geometry.y(), min_y), max_y)
        self._set_widget_screen_geometry(widget, QRect(x, y, width, height))

    def _widget_screen_geometry(self, widget: QWidget) -> QRect:
        if isinstance(widget, OverlayBoardWindow):
            return widget.screen_geometry()
        return widget.frameGeometry()

    def _set_widget_screen_geometry(self, widget: QWidget, rect: QRect) -> None:
        if isinstance(widget, OverlayBoardWindow):
            widget.apply_screen_geometry(rect)
            return
        widget.setGeometry(rect)

    def _encode_geometry(self, widget: QWidget) -> str:
        return bytes(widget.saveGeometry().toBase64()).decode("ascii")

    def _encode_overlay_geometry(self, widget: OverlayBoardWindow) -> str:
        geometry = widget.screen_geometry()
        payload = {
            "kind": "screen_rect",
            "x": geometry.x(),
            "y": geometry.y(),
            "width": geometry.width(),
            "height": geometry.height(),
        }
        return json.dumps(payload, separators=(",", ":"))

    def _restore_geometry(self, widget: QWidget, encoded: str) -> None:
        if not encoded:
            return
        widget.restoreGeometry(QByteArray.fromBase64(encoded.encode("ascii")))

    def _restore_overlay_geometry(self, widget: OverlayBoardWindow, encoded: str) -> None:
        if not encoded:
            return
        try:
            payload = json.loads(encoded)
        except json.JSONDecodeError:
            self._restore_geometry(widget, encoded)
            return

        if not isinstance(payload, dict) or payload.get("kind") != "screen_rect":
            return

        try:
            rect = QRect(
                int(payload["x"]),
                int(payload["y"]),
                max(widget.minimumWidth(), int(payload["width"])),
                max(widget.minimumHeight(), int(payload["height"])),
            )
        except (KeyError, TypeError, ValueError):
            return
        widget.apply_screen_geometry(rect)

    def _save_window_state(self) -> None:
        self.config.main_geometry = self._encode_geometry(self)
        if self.overlay_window is not None:
            self.config.overlay_geometry = self._encode_overlay_geometry(self.overlay_window)
        self._save_config()

    def _apply_overlay_startup_geometry(self) -> None:
        if self.overlay_window is None:
            return
        if self.config.overlay_geometry:
            self._restore_overlay_geometry(self.overlay_window, self.config.overlay_geometry)
            self._ensure_widget_visible(self.overlay_window, margin=16)
            return
        self._fit_widget_to_screen(
            self.overlay_window,
            width_ratio=0.97,
            height_ratio=0.88,
            min_size=QSize(780, 560),
            top_ratio=0.03,
        )

    def fit_current_windows_to_screen(self) -> None:
        self._fit_widget_to_screen(self, width_ratio=0.96, height_ratio=0.92, min_size=QSize(820, 600))
        if self.overlay_window is not None:
            self._fit_widget_to_screen(
                self.overlay_window,
                width_ratio=0.97,
                height_ratio=0.88,
                min_size=QSize(780, 560),
                top_ratio=0.03,
            )
        self._save_window_state()
        self.statusBar().showMessage("현재 화면 해상도에 맞춰 창 크기를 다시 조정했습니다.")

    def _current_message(self) -> Message | None:
        item = self.message_list.currentItem()
        if item is None:
            return None
        return self.messages_by_key.get(int(item.data(Qt.UserRole)))

    def _current_event(self) -> CalendarEvent | None:
        item = self.event_list.currentItem()
        if item is None:
            return None
        path = Path(str(item.data(Qt.UserRole)))
        return self._find_event_by_path(path)

    def _find_event_by_path(self, target_path: Path) -> CalendarEvent | None:
        for events in self.events_by_date.values():
            for event in events:
                if event.file_path == target_path:
                    return event
        return None

    def _events_for_date(self, target_date: dt.date) -> list[CalendarEvent]:
        return list(self.events_by_date.get(target_date, []))

    def _sync_item_widget_selection(self, list_widget: QListWidget) -> None:
        current_item = list_widget.currentItem()
        for index in range(list_widget.count()):
            item = list_widget.item(index)
            widget = list_widget.itemWidget(item)
            if widget is not None and hasattr(widget, "set_selected"):
                widget.set_selected(item is current_item)

    def _ensure_auto_ai_baseline(self, messages: list[Message]) -> None:
        if not self.config.ai_auto_enabled or self.config.ai_last_processed_message_key > 0:
            return
        if not messages:
            return
        self.config.ai_last_processed_message_key = max(message.key for message in messages)
        self._save_config()
        self.statusBar().showMessage("AI 자동 분석 기준선을 현재 메시지로 맞췄습니다. 이후 새 메시지부터 자동 처리합니다.")

    def _pending_auto_ai_messages(self, messages: list[Message]) -> list[Message]:
        if not self.config.ai_auto_enabled:
            return []
        if self.ai_worker is not None:
            return []
        if not resolved_api_key(self.config.openai_api_key):
            return []
        baseline = self.config.ai_last_processed_message_key
        if baseline <= 0:
            return []
        return [message for message in messages if message.key > baseline]

    def _start_ai_worker(self, messages: list[Message], *, auto_create: bool, force_reanalyze: bool, mode: str) -> None:
        if not messages:
            return
        if self.ai_worker is not None:
            show_info(self, "AI 분석 진행 중", "현재 다른 메시지 분석이 진행 중입니다. 잠시 후 다시 시도해 주세요.")
            return

        api_key = resolved_api_key(self.config.openai_api_key)
        if not api_key:
            show_info(self, "API 키 필요", "먼저 AI 설정에서 OpenAI API 키를 입력해 주세요.")
            return

        self.ai_pending_count = len(messages)
        self.ai_last_created_paths = []
        self.ai_worker = AIAnalysisWorker(
            messages,
            api_key=api_key,
            model=sanitize_model_name(self.config.openai_model),
            store_path=self.analysis_store.path,
            event_dir=self.config.event_dir,
            auto_create=auto_create,
            force_reanalyze=force_reanalyze,
            mode=mode,
            parent=self,
        )
        self.ai_worker.item_processed.connect(self._on_ai_item_processed)
        self.ai_worker.batch_finished.connect(self._on_ai_batch_finished)
        self.ai_worker.finished.connect(self._on_ai_worker_stopped)
        self.ai_worker.finished.connect(self.ai_worker.deleteLater)
        self.ai_analyze_btn.setEnabled(False)
        self._update_ai_status_chip()
        self.statusBar().showMessage(f"AI 분석을 시작했습니다: {len(messages)}건")
        self.ai_worker.start()

    def _start_auto_ai_if_needed(self, messages: list[Message]) -> None:
        self._ensure_auto_ai_baseline(messages)
        pending = self._pending_auto_ai_messages(messages)
        if pending:
            self._start_ai_worker(
                pending,
                auto_create=self.config.ai_auto_create_events,
                force_reanalyze=False,
                mode="automatic",
            )

    def _analysis_from_payload(self, payload: object) -> MessageAnalysis | None:
        if not isinstance(payload, dict):
            return None
        try:
            return MessageAnalysis(
                message_key=int(payload.get("message_key", 0)),
                summary=str(payload.get("summary", "")),
                has_action_item=bool(payload.get("has_action_item", False)),
                should_create_event=bool(payload.get("should_create_event", False)),
                event_title=str(payload.get("event_title", "")),
                due_date=str(payload.get("due_date", "")),
                due_time=str(payload.get("due_time", "")),
                all_day=bool(payload.get("all_day", True)),
                reason=str(payload.get("reason", "")),
                auto_created_event_path=str(payload.get("auto_created_event_path", "")),
                analyzed_at=str(payload.get("analyzed_at", "")),
                model=str(payload.get("model", "")),
                error=str(payload.get("error", "")),
            )
        except (TypeError, ValueError):
            return None

    def _on_ai_item_processed(self, message_key: object, analysis_payload: object, mode: object) -> None:
        analysis = self._analysis_from_payload(analysis_payload)
        if analysis is None:
            return

        if mode == "automatic":
            self.config.ai_last_processed_message_key = max(self.config.ai_last_processed_message_key, analysis.message_key)
            self._save_config()
            if (
                analysis.should_create_event
                and not analysis.auto_created_event_path
                and not analysis.error
                and analysis.message_key not in self.ai_confirm_queue
            ):
                self.ai_confirm_queue.append(analysis.message_key)

        self._store_analysis(analysis)

        if analysis.auto_created_event_path:
            event_path = Path(analysis.auto_created_event_path)
            if event_path not in self.ai_last_created_paths:
                self.ai_last_created_paths.append(event_path)

        current_message = self._current_message()
        if current_message is not None and current_message.key == analysis.message_key:
            self.on_message_selected()

    def _on_ai_batch_finished(self, mode: object, processed_count: int, created_count: int) -> None:
        if self.ai_last_created_paths:
            self._refresh_events(preferred_path=self.ai_last_created_paths[-1])
            self._sync_google_created_paths(self.ai_last_created_paths)

        if mode == "manual":
            message = self._current_message()
            if message is not None:
                analysis = self._analysis_for_message(message.key)
                if analysis is not None and analysis.error:
                    show_warning(self, "AI 분석 실패", analysis.error)
                elif analysis is not None and analysis.should_create_event and not analysis.auto_created_event_path:
                    if self._confirm_and_create_event(message, analysis):
                        created_count += 1

        if mode == "automatic":
            created_count += self._process_ai_confirm_queue()
            self.statusBar().showMessage(f"AI 자동 분석 완료: {processed_count}건 처리 / {created_count}건 일정 생성")
        else:
            self.statusBar().showMessage(f"AI 분석 완료: {processed_count}건 처리 / {created_count}건 일정 생성")

    def _process_ai_confirm_queue(self) -> int:
        pending, self.ai_confirm_queue = self.ai_confirm_queue, []
        created = 0
        for message_key in pending:
            message = self.messages_by_key.get(message_key)
            analysis = self._analysis_for_message(message_key)
            if message is None or analysis is None:
                continue
            if not analysis.should_create_event or analysis.auto_created_event_path:
                continue
            if self._confirm_and_create_event(message, analysis):
                created += 1
        return created

    def _confirm_and_create_event(self, message: Message, analysis: MessageAnalysis) -> bool:
        message_text = (
            f"AI가 메시지에서 일정 등록이 필요한 항목을 찾았습니다.\n\n"
            f"보낸 사람  {message.peer or '(이름 없음)'}\n"
            f"요약  {analysis.summary or shorten_text(message.preview, 80) or '-'}\n"
            f"추천 제목  {analysis.event_title or '(제목 없음)'}\n"
            f"감지 기한  {analysis.due_date or '-'} {analysis.due_time or ''}\n\n"
            "이 일정으로 등록할까요?"
        )
        if not ask_confirmation(
            self,
            "AI 일정 추천",
            message_text,
            confirm_text="일정 등록",
            cancel_text="건너뛰기",
            stay_on_top=True,
        ):
            return False

        try:
            created_path = create_ai_event_from_analysis(message, analysis, self.config.event_dir)
        except Exception as exc:  # noqa: BLE001
            show_warning(self, "일정 생성 실패", str(exc))
            return False
        if created_path is None:
            return False

        analysis.auto_created_event_path = str(created_path)
        self._store_analysis(analysis)
        self._refresh_events(preferred_path=created_path)
        self._sync_google_event_path(created_path)
        current = self._current_message()
        if current is not None and current.key == message.key:
            self.on_message_selected()
        return True

    def _on_ai_worker_stopped(self) -> None:
        self.ai_worker = None
        self.ai_pending_count = 0
        self.ai_last_created_paths = []
        self.ai_analyze_btn.setEnabled(self._current_message() is not None)
        self._update_ai_status_chip()

    def _load_all(self) -> None:
        try:
            messages = self.message_service.read_recent(limit=self.config.recent_limit)
            self.messages_by_key = {message.key: message for message in messages}
            self.populate_messages(messages)
            self._refresh_events()
            self._start_auto_ai_if_needed(messages)
            self._update_path_labels()
            total_events = sum(len(items) for items in self.events_by_date.values())
            self.statusBar().showMessage(f"메시지 {len(messages)}건 / 일정 {total_events}건 불러옴")
        except Exception as exc:  # noqa: BLE001
            self.statusBar().showMessage(f"불러오기 실패: {exc}")

    def _refresh_events(self, *, preferred_path: Path | None = None) -> None:
        completed_event_keys = load_completed_event_keys()
        self.events_by_date = {
            event_date: [replace(event, completed=event_key(event.file_path) in completed_event_keys) for event in events]
            for event_date, events in load_events(self.config.event_dir).items()
        }
        self.board.set_events(self.events_by_date)
        if self.overlay_window is not None:
            self.overlay_window.set_events(self.events_by_date)
            self.overlay_window.set_selected_date(self.board.selected_date, preferred_path=preferred_path)
        self._populate_event_list(self.board.selected_date, preferred_path=preferred_path)
        self._refresh_summary_tiles()

    def populate_messages(self, messages: list[Message]) -> None:
        self._all_messages = messages
        self._message_search_index = {
            message.key: " ".join((message.peer or "", message.title or "", message.body or "")).casefold()
            for message in messages
        }
        self._message_search_timer.stop()
        self._render_message_list()

    def _schedule_message_render(self, *_args) -> None:
        self._message_search_timer.start()

    def _filtered_messages(self) -> list[Message]:
        query = self.message_search.text().strip().casefold()
        if not query:
            return self._all_messages
        return [message for message in self._all_messages if query in self._message_search_index.get(message.key, "")]

    def _render_message_list(self, *_args) -> None:
        messages = self._filtered_messages()
        current_key = None
        current_item = self.message_list.currentItem()
        if current_item is not None:
            current_key = current_item.data(Qt.UserRole)

        self.message_list.setUpdatesEnabled(False)
        self.message_list.blockSignals(True)
        try:
            self.message_list.clear()
            for message in messages:
                item = QListWidgetItem()
                item.setData(Qt.UserRole, message.key)
                card = MessageCardWidget(message)
                item.setSizeHint(QSize(0, max(92, card.sizeHint().height() + 6)))
                self.message_list.addItem(item)
                self.message_list.setItemWidget(item, card)
                if current_key == message.key:
                    self.message_list.setCurrentItem(item)

            if self.message_list.currentItem() is None and self.message_list.count():
                self.message_list.setCurrentRow(self.message_list.count() - 1)
        finally:
            self.message_list.blockSignals(False)
            self.message_list.setUpdatesEnabled(True)

        self._sync_item_widget_selection(self.message_list)
        self.on_message_selected()
        self._refresh_summary_tiles()

    def _populate_event_list(self, date: dt.date, *, preferred_path: Path | None = None) -> None:
        current_path: Path | None = preferred_path
        if current_path is None and self.event_list.currentItem() is not None:
            current_path = Path(str(self.event_list.currentItem().data(Qt.UserRole)))

        self.event_list.clear()
        events = self.events_by_date.get(date, [])
        for event in events:
            item = QListWidgetItem()
            item.setData(Qt.UserRole, str(event.file_path))
            card = EventCardWidget(event)
            item.setSizeHint(QSize(0, max(124, card.sizeHint().height() + 6)))
            self.event_list.addItem(item)
            self.event_list.setItemWidget(item, card)
            if current_path is not None and event.file_path == current_path:
                self.event_list.setCurrentItem(item)

        self.selected_date_label.setText(f"{date.strftime('%Y.%m.%d')}  일정 {len(events)}건")
        self.add_selected_btn.setToolTip(f"{date.isoformat()} 날짜로 새 일정을 만듭니다.")

        if self.event_list.currentItem() is None and self.event_list.count():
            self.event_list.setCurrentRow(0)
        if not events:
            self.event_detail.setPlainText("선택한 날짜에 일정이 없습니다.")

        self._sync_item_widget_selection(self.event_list)
        self.on_event_selected()
        self._refresh_summary_tiles()

    def _sync_google_event_path(self, event_path: Path, *, show_success: bool = False) -> None:
        if not google_calendar_ready(self.config):
            return
        try:
            google_event_id = sync_event_path(self.config, self.events_by_date, event_path)
        except GoogleCalendarSyncError as exc:
            self.statusBar().showMessage(f"로컬 일정은 저장됨 / Google 동기화 실패: {exc}")
            return
        if show_success and google_event_id:
            self.statusBar().showMessage("Google Calendar에도 등록했습니다.")

    def _sync_google_created_paths(self, paths: list[Path]) -> None:
        if not google_calendar_ready(self.config):
            return
        synced = 0
        for event_path in dict.fromkeys(paths):
            try:
                if sync_event_path(self.config, self.events_by_date, event_path):
                    synced += 1
            except GoogleCalendarSyncError as exc:
                self.statusBar().showMessage(f"Google 동기화 실패: {exc}")
                return
        if synced:
            self.statusBar().showMessage(f"Google Calendar에 {synced}건 등록했습니다.")

    def _sync_google_events_in_range(self, start_date: dt.date, end_date: dt.date) -> int:
        if not google_calendar_ready(self.config):
            return 0
        synced = 0
        seen_paths: set[Path] = set()
        for event_date, events in self.events_by_date.items():
            if not (start_date <= event_date < end_date):
                continue
            for event in events:
                if event.file_path in seen_paths:
                    continue
                seen_paths.add(event.file_path)
                google_event_id = sync_event_path(self.config, self.events_by_date, event.file_path)
                if google_event_id:
                    synced += 1
        return synced

    def on_message_selected(self, *_args) -> None:
        self._sync_item_widget_selection(self.message_list)
        message = self._current_message()
        self.add_selected_btn.setEnabled(message is not None)
        self.ai_analyze_btn.setEnabled(message is not None and self.ai_worker is None)
        if message is None:
            self.message_detail.clear()
            return

        suggested_date = guess_event_date(message)
        suggested_time = guess_event_time(message) or "시간 미정"
        analysis = self._analysis_for_message(message.key)
        detail_lines = [
            f"상대: {message.peer or '(이름 없음)'}",
            f"원본 시각: {message.when_text}",
            f"추천 일정 날짜: {suggested_date.isoformat()}",
            f"추천 시간: {suggested_time}",
            "",
            "요약",
            summarize_message(message),
            "",
            "일정 메모에 들어가는 내용",
            build_event_description(message),
        ]
        if analysis is not None:
            detail_lines.extend(["", "AI 분석", format_analysis_for_display(analysis)])
        else:
            detail_lines.extend(["", "AI 분석", "아직 분석 기록이 없습니다. '선택 메시지 AI 분석' 버튼으로 바로 분석할 수 있습니다."])
        self.message_detail.setPlainText("\n".join(detail_lines))

    def on_date_selected(self, date: dt.date) -> None:
        self.board.set_selected_date(date)
        if self.overlay_window is not None:
            self.overlay_window.set_selected_date(date)
        self._populate_event_list(date)

    def open_event_todo_for_current_date(self) -> None:
        self.open_event_todo(self.board.selected_date)

    def open_event_todo(self, event_date: dt.date, *, parent: QWidget | None = None) -> None:
        dialog = EventTodoDialog(
            event_date,
            event_provider=lambda date: self.events_by_date.get(date, []),
            on_toggle=self._set_event_completed,
            parent=parent or self,
        )
        dialog.exec()

    def open_overlay_event_todo(self, event_date: dt.date) -> None:
        self.open_event_todo(event_date, parent=self.overlay_window)

    def open_event_trash(self) -> None:
        dialog = EventTrashDialog(
            event_provider=lambda: load_trashed_events(self.config.event_dir),
            on_restore=self.restore_event_from_trash,
            on_delete_forever=self.permanently_delete_event_from_trash,
            parent=self.overlay_window or self,
        )
        dialog.exec()

    def _set_event_completed(self, event_path: Path, completed: bool) -> None:
        set_event_completed(event_path, completed)
        self._refresh_events()

    def on_event_selected(self, *_args) -> None:
        self._sync_item_widget_selection(self.event_list)
        event = self._current_event()
        has_event = event is not None
        self.edit_event_btn.setEnabled(has_event)
        self.open_event_btn.setEnabled(has_event)
        self.delete_event_btn.setEnabled(has_event)
        if event is None:
            if self.event_list.count() == 0:
                self.event_detail.setPlainText("선택한 날짜에 일정이 없습니다.")
            return
        self.event_detail.setPlainText(
            f"제목: {event.title}\n시간: {event.time_text or '종일'}\n파일: {event.file_path}\n\n{event.description}"
        )

    def _create_event_for_message(self, message: Message, date: dt.date) -> None:
        try:
            created_path = create_event_from_message(message, date, self.config.event_dir)
            self.board.set_selected_date(date)
            self._refresh_events(preferred_path=created_path)
            self._sync_google_event_path(created_path)
            self.statusBar().showMessage(f"{date.isoformat()} 일정으로 추가했습니다: {created_path.name}")
        except Exception as exc:  # noqa: BLE001
            show_error(self, "일정 추가 실패", str(exc))

    def _open_event_editor(
        self,
        event_date: dt.date,
        *,
        event: CalendarEvent | None = None,
    ) -> Path | None:
        dialog = EventEditorDialog(event_date, event=event, parent=self)
        if dialog.exec() != QDialog.Accepted:
            return None
        payload = dialog.event_payload()
        try:
            if event is None:
                created_path = create_event(
                    payload["date"],
                    self.config.event_dir,
                    str(payload["title"]),
                    str(payload["description"]),
                    all_day=bool(payload["all_day"]),
                    time_text=str(payload["time_text"]),
                )
                self.board.set_selected_date(payload["date"])
                self._refresh_events(preferred_path=created_path)
                self._sync_google_event_path(created_path)
                self.statusBar().showMessage(f"{payload['date'].isoformat()} 일정으로 추가했습니다: {created_path.name}")
                return created_path

            old_path = event.file_path
            updated_path = update_event(
                old_path,
                event_date=payload["date"],
                title=str(payload["title"]),
                description=str(payload["description"]),
                all_day=bool(payload["all_day"]),
                time_text=str(payload["time_text"]),
            )
            move_sync_mapping(old_path, updated_path)
            self.board.set_selected_date(payload["date"])
            self._refresh_events(preferred_path=updated_path)
            self._sync_google_event_path(updated_path)
            self.statusBar().showMessage(f"일정을 수정했습니다: {updated_path.name}")
            return updated_path
        except Exception as exc:  # noqa: BLE001
            show_error(self, "일정 저장 실패", str(exc))
            return None

    def create_event_for_selected_date(self, date: dt.date) -> Path | None:
        return self._open_event_editor(date)

    def create_event_for_current_date(self) -> None:
        self.create_event_for_selected_date(self.board.selected_date)

    def edit_current_event(self) -> None:
        event = self._current_event()
        if event is None:
            return
        self.edit_event_by_path(event.file_path)

    def edit_event_by_path(self, target_path: Path) -> Path | None:
        event = self._find_event_by_path(target_path)
        if event is None:
            show_info(self, "일정 없음", "수정할 일정을 찾지 못했습니다. 목록을 새로고침합니다.")
            self._refresh_events()
            return None
        return self._open_event_editor(event.date, event=event)

    def open_event_by_path(self, target_path: Path) -> None:
        event = self._find_event_by_path(target_path)
        if event is None or not event.file_path.exists():
            show_warning(self, "파일 없음", "일정 파일을 찾을 수 없습니다. 목록을 새로고침합니다.")
            self._refresh_events()
            return
        os.startfile(str(event.file_path))

    def delete_event_by_path(self, target_path: Path) -> None:
        event = self._find_event_by_path(target_path)
        if event is None:
            show_info(self, "일정 없음", "휴지통으로 옮길 일정을 찾지 못했습니다. 목록을 새로고침합니다.")
            self._refresh_events()
            return
        trashed_path = move_event_to_trash(event.file_path)
        self._refresh_events()
        if trashed_path is not None:
            move_sync_mapping(event.file_path, trashed_path)
            self.statusBar().showMessage(f"휴지통으로 이동했습니다: {event.title}")
        else:
            show_info(self, "파일 없음", "해당 일정 파일을 찾지 못해 목록만 새로고침했습니다.")

    def restore_event_from_trash(self, trashed_path: Path) -> bool:
        restored_path = restore_trashed_event(self.config.event_dir, trashed_path)
        if restored_path is None:
            show_info(self, "복원 실패", "휴지통에서 해당 일정을 찾지 못했습니다.")
            return False
        move_sync_mapping(trashed_path, restored_path)
        self._refresh_events(preferred_path=restored_path)
        self.statusBar().showMessage(f"일정을 복원했습니다: {restored_path.name}")
        return True

    def permanently_delete_event_from_trash(self, trashed_path: Path) -> bool:
        entry = next((item for item in load_trashed_events(self.config.event_dir) if item.file_path == trashed_path), None)
        title = entry.event.title if entry is not None else trashed_path.stem
        if not ask_confirmation(
            self,
            "일정 영구 삭제",
            f"'{title}' 일정을 영구 삭제할까요?\n이 작업은 되돌릴 수 없습니다.",
            confirm_text="영구 삭제",
            cancel_text="취소",
            destructive=True,
        ):
            return False
        try:
            delete_synced_event(self.config, trashed_path)
        except GoogleCalendarSyncError as exc:
            show_warning(self, "Google Calendar 삭제 실패", f"Google Calendar에서 일정을 지우지 못했습니다.\n{exc}")
            return False
        except Exception as exc:  # noqa: BLE001
            show_warning(self, "Google Calendar 삭제 실패", f"Google Calendar에서 일정을 지우지 못했습니다.\n{exc}")
            return False
        removed = permanently_delete_trashed_event(self.config.event_dir, trashed_path)
        if removed:
            self.statusBar().showMessage(f"휴지통에서 영구 삭제했습니다: {title}")
        else:
            show_info(self, "이미 삭제됨", "휴지통에서 해당 일정을 찾지 못했습니다.")
        return removed

    def open_day_manager(self, date: dt.date) -> None:
        self.on_date_selected(date)
        dialog = DayEventManagerDialog(
            date,
            event_provider=self._events_for_date,
            event_lookup=self._find_event_by_path,
            on_add=self.create_event_for_selected_date,
            on_edit=self.edit_event_by_path,
            on_delete=self.delete_event_by_path,
            on_open=self.open_event_by_path,
            parent=self,
        )
        dialog.exec()

    def open_ai_settings(self) -> None:
        dialog = AISettingsDialog(self.config, parent=self)
        if dialog.exec() != QDialog.Accepted:
            return

        was_enabled = self.config.ai_auto_enabled
        previous_key = self.config.ai_last_processed_message_key
        payload = dialog.payload()
        self.config.openai_api_key = str(payload["openai_api_key"])
        self.config.openai_model = str(payload["openai_model"])
        self.config.ai_auto_enabled = bool(payload["ai_auto_enabled"])
        self.config.ai_auto_create_events = bool(payload["ai_auto_create_events"])

        if self.config.ai_auto_enabled and not was_enabled:
            if self.messages_by_key:
                self.config.ai_last_processed_message_key = max(self.messages_by_key)
            else:
                self.config.ai_last_processed_message_key = previous_key
        elif not self.config.ai_auto_enabled:
            self.config.ai_last_processed_message_key = previous_key

        self._save_config()
        self.statusBar().showMessage("AI 자동 분석 설정을 저장했습니다.")

    def open_google_calendar_settings(self) -> None:
        dialog = GoogleCalendarSettingsDialog(self.config, parent=self)
        if dialog.exec() != QDialog.Accepted:
            return

        payload = dialog.payload()
        self.config.google_calendar_enabled = bool(payload["google_calendar_enabled"])
        self.config.google_oauth_client_id = str(payload["google_oauth_client_id"])
        self.config.google_oauth_client_secret = str(payload["google_oauth_client_secret"])
        self.config.google_calendar_id = str(payload["google_calendar_id"])
        self.config.google_timezone = str(payload["google_timezone"])
        self._save_config()

        if not self.config.google_calendar_enabled:
            self.statusBar().showMessage("Google Calendar 자동 등록을 껐습니다.")
            return

        try:
            connect_google_calendar(self.config)
        except GoogleCalendarSyncError as exc:
            show_warning(self, "Google Calendar 연결 실패", str(exc))
            self.statusBar().showMessage("Google Calendar 연결에 실패했습니다.")
            return
        except Exception as exc:  # noqa: BLE001
            show_warning(self, "Google Calendar 연결 실패", str(exc))
            self.statusBar().showMessage("Google Calendar 연결에 실패했습니다.")
            return

        self.statusBar().showMessage("Google Calendar 연결 완료. 새 일정부터 자동 등록합니다.")

    def import_google_calendar_events(self) -> None:
        if not google_calendar_ready(self.config):
            if ask_confirmation(
                self,
                "Google Calendar 연동 필요",
                "먼저 Google Calendar 연동을 설정해야 합니다. 지금 설정할까요?",
                confirm_text="설정 열기",
                cancel_text="나중에",
            ):
                self.open_google_calendar_settings()
            return

        start_date = self.board.current_month
        if start_date.month == 12:
            end_date = dt.date(start_date.year + 1, 1, 1)
        else:
            end_date = dt.date(start_date.year, start_date.month + 1, 1)

        QApplication.setOverrideCursor(Qt.WaitCursor)
        self.statusBar().showMessage("Google Calendar 동기화 중입니다...")
        app = QApplication.instance()
        if app is not None:
            app.processEvents()

        try:
            self._refresh_events()
            self.statusBar().showMessage("Google Calendar 동기화 중: Google 일정을 가져옵니다...")
            if app is not None:
                app.processEvents()
            imported_paths = import_events(
                self.config,
                self.config.event_dir,
                start_date,
                end_date,
                interactive=True,
            )
            self._refresh_events(preferred_path=imported_paths[-1] if imported_paths else None)
            self.statusBar().showMessage("Google Calendar 동기화 중: 로컬 일정을 업로드합니다...")
            if app is not None:
                app.processEvents()
            uploaded_count = self._sync_google_events_in_range(start_date, end_date)
        except GoogleCalendarSyncError as exc:
            QApplication.restoreOverrideCursor()
            show_warning(self, "Google Calendar 동기화 실패", str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            QApplication.restoreOverrideCursor()
            show_warning(self, "Google Calendar 동기화 실패", str(exc))
            return
        finally:
            while QApplication.overrideCursor() is not None:
                QApplication.restoreOverrideCursor()

        preferred_path = imported_paths[-1] if imported_paths else None
        self._refresh_events(preferred_path=preferred_path)
        message = (
            f"{start_date.year}년 {start_date.month}월 Google 동기화 완료\n\n"
            f"로컬 일정 업로드/업데이트: {uploaded_count}건\n"
            f"Google 일정 가져오기/갱신: {len(imported_paths)}건"
        )
        self.statusBar().showMessage(message.replace("\n", " "))
        show_info(self, "Google Calendar 동기화 완료", message)

    def analyze_selected_message(self) -> None:
        message = self._current_message()
        if message is None:
            show_info(self, "메시지 선택", "먼저 AI로 분석할 메시지를 선택해 주세요.")
            return
        self._start_ai_worker([message], auto_create=False, force_reanalyze=True, mode="manual")

    def _show_overlay_on_desktop(self) -> None:
        if self.overlay_window is None:
            return
        self.overlay_window.show()
        QTimer.singleShot(0, self.overlay_window.attach_to_desktop_layer)
        QTimer.singleShot(180, self._reveal_desktop_for_overlay)

    def _reveal_desktop_for_overlay(self) -> None:
        if self.overlay_window is None or not self.overlay_window.isVisible():
            return
        revealed = reveal_desktop()
        if not revealed and not self.isMinimized():
            self.showMinimized()

    def add_selected_message_to_current_date(self) -> None:
        message = self._current_message()
        if message is None:
            show_info(self, "메시지 선택", "먼저 일정으로 옮길 메시지를 선택해 주세요.")
            return
        self._create_event_for_message(message, self.board.selected_date)

    def on_message_dropped(self, date: dt.date, message_key: int) -> None:
        message = self.messages_by_key.get(message_key)
        if message is None:
            show_warning(self, "메시지 없음", "드래그한 메시지를 찾지 못했습니다.")
            return
        self._create_event_for_message(message, date)

    def open_current_event(self, *_args) -> None:
        event = self._current_event()
        if event is None:
            return
        self.open_event_by_path(event.file_path)

    def delete_current_event(self) -> None:
        event = self._current_event()
        if event is None:
            return
        self.delete_event_by_path(event.file_path)

    def toggle_overlay(self) -> None:
        if self.overlay_window is None:
            self.overlay_window = OverlayBoardWindow()
            self.overlay_window.set_events(self.events_by_date)
            self.overlay_window.set_selected_date(self.board.selected_date)
            self.overlay_window.board.date_selected.connect(self.on_date_selected)
            self.overlay_window.manage_requested.connect(self.open_day_manager)
            self.overlay_window.todo_requested.connect(self.open_overlay_event_todo)
            self.overlay_window.trash_requested.connect(self.open_event_trash)
            self.overlay_window.settings_requested.connect(self.open_overlay_settings)
            self.overlay_window.message_dropped.connect(self.on_message_dropped)
            self.overlay_window.closed.connect(self._overlay_closed)
            self._apply_overlay_appearance()
            self._apply_overlay_startup_geometry()
            self._show_overlay_on_desktop()
            return
        self._show_overlay_on_desktop()

    def _apply_overlay_appearance(self) -> None:
        self._apply_styles()
        if self.overlay_window is not None:
            board = self.overlay_window.board
            board.overlay_palette = overlay_theme_palette(self.config.overlay_theme)
            board.font_scale = max(0.8, min(1.4, self.config.overlay_font_scale / 100))
            board.render()

    def open_overlay_settings(self) -> None:
        dialog = OverlaySettingsDialog(self.config, on_change=self._apply_overlay_appearance, parent=self)
        if dialog.exec() != QDialog.Accepted:
            return
        self._save_config()
        self.statusBar().showMessage("오버레이 보드 설정을 저장했습니다.")

    def _overlay_closed(self) -> None:
        if self.overlay_window is not None:
            self.config.overlay_geometry = self._encode_overlay_geometry(self.overlay_window)
            self._save_config()
        self.overlay_window = None

    def change_db_path(self) -> None:
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "CoolMessenger UDB 선택",
            str(self.config.db_path.parent),
            "UDB (*.udb)",
        )
        if not file_path:
            return
        self.config.db_path = Path(file_path)
        self.message_service = MessageService(self.config.db_path)
        self.config.ai_last_processed_message_key = 0
        self.analysis_store = AIAnalysisStore(default_analysis_store_path(self.config.db_path))
        self.message_analyses = self.analysis_store.values()
        self._watch_db_paths()
        self._save_window_state()
        self._load_all()

    def change_event_dir(self) -> None:
        directory = QFileDialog.getExistingDirectory(self, "일정 폴더 선택", str(self.config.event_dir))
        if not directory:
            return
        self.config.event_dir = Path(directory)
        self._save_window_state()
        self._load_all()

    def open_event_dir(self) -> None:
        self.config.event_dir.mkdir(parents=True, exist_ok=True)
        os.startfile(str(self.config.event_dir))

    def restart_application(self) -> None:
        if not ask_confirmation(
            self,
            "앱 재시작",
            "CoolCalendar를 다시 시작할까요?\n열려 있는 설정 창의 저장하지 않은 내용은 사라집니다.",
            confirm_text="재시작",
            cancel_text="취소",
        ):
            return

        launcher_path = Path(__file__).resolve().parents[3] / "run_desktop_calendar.bat"
        if launcher_path.exists():
            command = [os.environ.get("ComSpec", "cmd.exe"), "/c", str(launcher_path)]
            working_directory = str(launcher_path.parent)
        else:
            app_path = Path(__file__).resolve().parents[1] / "app.py"
            command = [sys.executable, str(app_path)]
            working_directory = str(app_path.parent.parent)

        try:
            subprocess.Popen(
                command,
                cwd=working_directory,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            show_warning(self, "재시작 실패", f"새 앱 프로세스를 시작하지 못했습니다.\n{exc}")
            return
        app = QApplication.instance()
        self.close()
        if app is not None:
            app.quit()

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self.config.main_geometry = self._encode_geometry(self)
        if self.overlay_window is not None:
            self.config.overlay_geometry = self._encode_overlay_geometry(self.overlay_window)
            self.overlay_window.close()
        self._save_config()
        if self.ai_worker is not None:
            self.ai_worker.wait(1200)
        super().closeEvent(event)
