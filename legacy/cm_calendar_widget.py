#!/usr/bin/env python3
"""Desktop calendar widget for events generated from CoolMessenger messages."""

from __future__ import annotations

import calendar as pycalendar
import datetime as dt
import os
import re
import tkinter as tk
import tkinter.font as tkfont
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import cm_auto_summary as core


def kr(text: str) -> str:
    return text.encode("ascii").decode("unicode_escape")


@dataclass
class CalendarEvent:
    file_path: Path
    date: dt.date
    time_text: str
    title: str
    description: str
    all_day: bool


def unescape_ics(value: str) -> str:
    return (
        value.replace("\\n", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
    )


def unfold_ics_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        if raw_line.startswith((" ", "\t")) and lines:
            lines[-1] += raw_line[1:]
        else:
            lines.append(raw_line.strip())
    return lines


def parse_ics_datetime(value: str) -> tuple[dt.date, str]:
    clean = value.rstrip("Z")
    parsed = dt.datetime.strptime(clean, "%Y%m%dT%H%M%S")
    return parsed.date(), parsed.strftime("%H:%M")


def parse_ics_date(value: str) -> dt.date:
    parsed = dt.datetime.strptime(value, "%Y%m%d")
    return parsed.date()


def parse_ics_file(path: Path) -> CalendarEvent | None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return None

    title = ""
    description = ""
    event_date: dt.date | None = None
    time_text = kr(r"\uc885\uc77c")
    all_day = False

    for line in unfold_ics_lines(text):
        if line.startswith("SUMMARY:"):
            title = unescape_ics(line.partition(":")[2])
        elif line.startswith("DESCRIPTION:"):
            description = unescape_ics(line.partition(":")[2])
        elif line.startswith("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE"):
            all_day = True
            time_text = kr(r"\uc885\uc77c")
        elif line.startswith("DTSTART;VALUE=DATE:"):
            event_date = parse_ics_date(line.partition(":")[2])
            all_day = True
            time_text = kr(r"\uc885\uc77c")
        elif line.startswith("DTSTART:"):
            event_date, time_text = parse_ics_datetime(line.partition(":")[2])

    if event_date is None:
        return None

    return CalendarEvent(
        file_path=path,
        date=event_date,
        time_text=time_text,
        title=title or path.stem,
        description=description,
        all_day=all_day,
    )


def load_events(folder: Path) -> dict[str, list[CalendarEvent]]:
    folder.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, list[CalendarEvent]] = {}
    for path in sorted(folder.glob("*.ics")):
        event = parse_ics_file(path)
        if event is None:
            continue
        key = event.date.isoformat()
        grouped.setdefault(key, []).append(event)
    for items in grouped.values():
        items.sort(key=lambda item: (item.all_day is False, item.time_text, item.title))
    return grouped


class CalendarWidget:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(kr(r"\ub370\uc2a4\ud06c\ud0d1 \uce98\ub9b0\ub354"))
        self.root.geometry("1120x720+120+40")
        self.root.minsize(980, 620)
        self.root.configure(bg="#8fb6ca")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.92)

        self.folder_var = tk.StringVar(value=str(core.desktop_calendar_drop_dir()))
        self.topmost_var = tk.BooleanVar(value=True)
        self.header_clock_var = tk.StringVar(value="")
        self.month_footer_var = tk.StringVar(value="")
        self.selected_info_var = tk.StringVar(value="")
        self.drag_origin: tuple[int, int] | None = None

        self.today = dt.date.today()
        self.current_month = self.today.replace(day=1)
        self.selected_date = self.today
        self.events_by_date: dict[str, list[CalendarEvent]] = {}
        self.cell_dates: list[dt.date] = []
        self.day_cells: list[dict[str, tk.Widget]] = []

        self._build_ui()
        self._update_clock()
        self.refresh_events()
        self.root.after(5000, self._auto_refresh)
        self.root.bind("<Escape>", lambda _event: self.root.destroy())

    def _build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(2, weight=1)

        header = tk.Frame(self.root, bg="#6b9eb6", padx=14, pady=10)
        header.grid(row=0, column=0, sticky="ew", padx=14, pady=(14, 4))
        header.columnconfigure(1, weight=1)

        move_pad = tk.Label(
            header,
            text=kr(r"\ub4dc\ub798\uadf8"),
            bg="#6b9eb6",
            fg="#e9f6ff",
            font=("Malgun Gothic", 9, "bold"),
            padx=10,
        )
        move_pad.grid(row=0, column=0, sticky="w")
        for widget in (header, move_pad):
            widget.bind("<ButtonPress-1>", self._start_move)
            widget.bind("<B1-Motion>", self._do_move)

        center = tk.Label(
            header,
            textvariable=self.header_clock_var,
            bg="#6b9eb6",
            fg="#f7f6cf",
            font=("Malgun Gothic", 10, "bold"),
        )
        center.grid(row=0, column=1, sticky="ew")
        center.bind("<ButtonPress-1>", self._start_move)
        center.bind("<B1-Motion>", self._do_move)

        action_bar = tk.Frame(header, bg="#6b9eb6")
        action_bar.grid(row=0, column=2, sticky="e")
        self._make_action_button(action_bar, kr(r"\ud3f4\ub354"), self.choose_folder).pack(side="left", padx=3)
        self._make_action_button(action_bar, kr(r"\uc0c8\ub85c"), self.refresh_events).pack(side="left", padx=3)
        self._make_action_button(action_bar, kr(r"\uc624\ub298"), self.go_today).pack(side="left", padx=3)
        self._make_action_button(action_bar, kr(r"\uace0\uc815"), self.toggle_topmost).pack(side="left", padx=3)
        self._make_action_button(action_bar, "X", self.root.destroy).pack(side="left", padx=3)

        weekday_bar = tk.Frame(self.root, bg="#78acc3")
        weekday_bar.grid(row=1, column=0, sticky="ew", padx=14, pady=(0, 3))
        for col in range(7):
            weekday_bar.columnconfigure(col, weight=1)
        weekdays = [kr(r"\uc77c\uc694\uc77c"), kr(r"\uc6d4\uc694\uc77c"), kr(r"\ud654\uc694\uc77c"), kr(r"\uc218\uc694\uc77c"), kr(r"\ubaa9\uc694\uc77c"), kr(r"\uae08\uc694\uc77c"), kr(r"\ud1a0\uc694\uc77c")]
        for col, text in enumerate(weekdays):
            tk.Label(
                weekday_bar,
                text=text,
                bg="#78acc3",
                fg="#f6f1bc",
                font=("Malgun Gothic", 10, "bold"),
                pady=6,
            ).grid(row=0, column=col, sticky="ew", padx=1)

        board = tk.Frame(self.root, bg="#93bbcf")
        board.grid(row=2, column=0, sticky="nsew", padx=14, pady=(0, 4))
        for col in range(7):
            board.columnconfigure(col, weight=1, uniform="col")
        for row in range(6):
            board.rowconfigure(row, weight=1, uniform="row")

        for idx in range(42):
            cell = tk.Frame(board, bg="#6da7c0", highlightthickness=1, highlightbackground="#d4e9f5")
            cell.grid(row=idx // 7, column=idx % 7, sticky="nsew", padx=1, pady=1)
            cell.grid_propagate(False)
            cell.rowconfigure(1, weight=1)
            cell.columnconfigure(0, weight=1)

            top = tk.Label(
                cell,
                text="",
                anchor="w",
                justify="left",
                bg="#6da7c0",
                fg="#f8e7a2",
                font=("Malgun Gothic", 10),
                padx=8,
                pady=4,
            )
            top.grid(row=0, column=0, sticky="ew")

            body = tk.Label(
                cell,
                text="",
                anchor="nw",
                justify="left",
                bg="#6da7c0",
                fg="#f8fbff",
                font=("Malgun Gothic", 10),
                padx=10,
                pady=4,
                wraplength=140,
            )
            body.grid(row=1, column=0, sticky="nsew")

            for widget in (cell, top, body):
                widget.bind("<Button-1>", lambda _event, i=idx: self.select_index(i))
                widget.bind("<Double-Button-1>", lambda _event, i=idx: self.open_first_event(i))

            self.day_cells.append({"frame": cell, "top": top, "body": body})

        footer = tk.Frame(self.root, bg="#6f9fb7", padx=16, pady=10)
        footer.grid(row=3, column=0, sticky="ew", padx=14, pady=(0, 14))
        footer.columnconfigure(1, weight=1)
        self._make_action_button(footer, "<", self.prev_month).grid(row=0, column=0, sticky="w")
        tk.Label(
            footer,
            textvariable=self.month_footer_var,
            bg="#6f9fb7",
            fg="#f8f2bf",
            font=("Malgun Gothic", 12, "bold"),
        ).grid(row=0, column=1, sticky="ew")
        self._make_action_button(footer, ">", self.next_month).grid(row=0, column=2, sticky="e")

        self.info_label = tk.Label(
            footer,
            textvariable=self.selected_info_var,
            bg="#6f9fb7",
            fg="#eef9ff",
            anchor="w",
            justify="left",
            font=("Malgun Gothic", 10),
            wraplength=980,
            pady=10,
        )
        self.info_label.grid(row=1, column=0, columnspan=3, sticky="ew")

    def _make_action_button(self, parent: tk.Widget, text: str, command: object) -> tk.Button:
        return tk.Button(
            parent,
            text=text,
            command=command,
            relief="flat",
            bg="#5d8ea5",
            fg="#ffffff",
            activebackground="#4e7f95",
            activeforeground="#ffffff",
            font=("Malgun Gothic", 9, "bold"),
            padx=10,
            pady=4,
        )

    def _start_move(self, event: tk.Event[tk.Widget]) -> None:
        self.drag_origin = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())

    def _do_move(self, event: tk.Event[tk.Widget]) -> None:
        if self.drag_origin is None:
            return
        x = event.x_root - self.drag_origin[0]
        y = event.y_root - self.drag_origin[1]
        self.root.geometry(f"+{x}+{y}")

    def _update_clock(self) -> None:
        weekdays = [kr(r"\uc6d4"), kr(r"\ud654"), kr(r"\uc218"), kr(r"\ubaa9"), kr(r"\uae08"), kr(r"\ud1a0"), kr(r"\uc77c")]
        now = dt.datetime.now()
        ampm = kr(r"\uc624\uc804") if now.hour < 12 else kr(r"\uc624\ud6c4")
        hour = now.hour if 1 <= now.hour <= 12 else abs(now.hour - 12) or 12
        self.header_clock_var.set(
            f"{kr(r'\uc624\ub298\uc740')} {now.year}{kr(r'\ub144')}{now.month}{kr(r'\uc6d4')}{now.day}{kr(r'\uc77c')} "
            f"{weekdays[now.weekday()]}{kr(r'\uc694\uc77c')} {ampm} {hour}:{now.minute:02d}"
        )
        self.root.after(60000, self._update_clock)

    def choose_folder(self) -> None:
        path = filedialog.askdirectory(title=kr(r"\uac10\uc2dc \ud3f4\ub354 \uc120\ud0dd"))
        if path:
            self.folder_var.set(path)
            self.refresh_events()

    def toggle_topmost(self) -> None:
        self.topmost_var.set(not self.topmost_var.get())
        self.root.attributes("-topmost", bool(self.topmost_var.get()))

    def prev_month(self) -> None:
        year = self.current_month.year
        month = self.current_month.month - 1
        if month == 0:
            year -= 1
            month = 12
        self.current_month = dt.date(year, month, 1)
        self.render_calendar()

    def next_month(self) -> None:
        year = self.current_month.year
        month = self.current_month.month + 1
        if month == 13:
            year += 1
            month = 1
        self.current_month = dt.date(year, month, 1)
        self.render_calendar()

    def go_today(self) -> None:
        self.today = dt.date.today()
        self.selected_date = self.today
        self.current_month = self.today.replace(day=1)
        self.render_calendar()

    def refresh_events(self) -> None:
        folder = Path(self.folder_var.get().strip())
        self.events_by_date = load_events(folder)
        self.render_calendar()

    def _auto_refresh(self) -> None:
        self.today = dt.date.today()
        self.refresh_events()
        self.root.after(5000, self._auto_refresh)

    def _month_dates(self) -> list[dt.date]:
        weeks = pycalendar.Calendar(firstweekday=6).monthdatescalendar(self.current_month.year, self.current_month.month)
        while len(weeks) < 6:
            start = weeks[-1][-1] + dt.timedelta(days=1)
            weeks.append([start + dt.timedelta(days=offset) for offset in range(7)])
        return [day for week in weeks[:6] for day in week]

    def render_calendar(self) -> None:
        self.cell_dates = self._month_dates()
        self.month_footer_var.set(f"{self.current_month.month}{kr(r'\uc6d4')}")

        for idx, (cell, day) in enumerate(zip(self.day_cells, self.cell_dates)):
            events = self.events_by_date.get(day.isoformat(), [])
            top = cell["top"]
            body = cell["body"]
            frame = cell["frame"]

            day_head = f"{day.day}"
            if day == self.today:
                day_head = f"{day.day} {kr(r'\uc624\ub298')}"
            top.configure(text=day_head)

            visible = events[:4]
            lines = []
            for event in visible:
                prefix = f"{event.time_text} " if not event.all_day else ""
                lines.append(f"{len(lines)+1}. {prefix}{event.title}")
            if len(events) > len(visible):
                lines.append(f"+{len(events) - len(visible)} more")
            body.configure(text="\n".join(lines))

            if day.month != self.current_month.month:
                bg = "#8f8f93" if idx % 7 in (0, 6) else "#85a4b0"
                fg = "#f5eab6"
                event_fg = "#e4eef4"
            elif idx % 7 in (0, 6):
                bg = "#888b8f"
                fg = "#ffefaf"
                event_fg = "#ffffff"
            else:
                bg = "#6da7c0"
                fg = "#fff1a6"
                event_fg = "#ffffff"

            if events:
                body_bg = "#5f9eba"
            else:
                body_bg = bg

            if day == self.selected_date:
                frame.configure(highlightbackground="#fff6cf", highlightthickness=2, bg="#8fc1d4")
                top.configure(bg="#8fc1d4", fg="#fff8cf")
                body.configure(bg="#7ab3ca", fg="#ffffff")
            else:
                frame.configure(highlightbackground="#cde4f0", highlightthickness=1, bg=bg)
                top.configure(bg=bg, fg=fg)
                body.configure(bg=body_bg, fg=event_fg)

        self.render_selected_info()

    def select_index(self, idx: int) -> None:
        if idx >= len(self.cell_dates):
            return
        self.selected_date = self.cell_dates[idx]
        if self.selected_date.month != self.current_month.month:
            self.current_month = self.selected_date.replace(day=1)
        self.render_calendar()

    def render_selected_info(self) -> None:
        events = self.events_by_date.get(self.selected_date.isoformat(), [])
        title = f"{self.selected_date.year}-{self.selected_date.month:02d}-{self.selected_date.day:02d}"
        if not events:
            self.selected_info_var.set(f"{title} | {kr(r'\ub4f1\ub85d\ub41c \uc77c\uc815\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.')}")
            return
        summary = "   ".join(
            f"{index+1}. {(event.time_text + ' ') if not event.all_day else ''}{event.title}"
            for index, event in enumerate(events[:5])
        )
        self.selected_info_var.set(f"{title} | {summary}")

    def open_first_event(self, idx: int) -> None:
        if idx >= len(self.cell_dates):
            return
        day = self.cell_dates[idx]
        events = self.events_by_date.get(day.isoformat(), [])
        if not events:
            return
        event = events[0]
        if event.file_path.exists():
            os.startfile(str(event.file_path))


def main() -> int:
    root = tk.Tk()
    CalendarWidget(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
