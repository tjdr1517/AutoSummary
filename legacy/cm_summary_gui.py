#!/usr/bin/env python3
"""Korean GUI app for reading CoolMessenger messages and drafting calendar events."""

from __future__ import annotations

import datetime as dt
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
import tkinter.font as tkfont
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import cm_auto_summary as core


def kr(text: str) -> str:
    return text.encode("ascii").decode("unicode_escape")


class SummaryGUI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(kr(r"\ucfe8\uba54\uc2e0\uc800 \uba54\uc2dc\uc9c0 \uc694\uc57d \u0026 \uce98\ub9b0\ub354"))
        self.root.geometry("1420x900")
        self.root.minsize(1180, 760)

        self.messages: list[core.Message] = []
        self.worker: threading.Thread | None = None
        self.stop_event: threading.Event | None = None
        self.log_queue: queue.Queue[str] = queue.Queue()
        self.drag_iid: str | None = None
        self.drag_label: tk.Label | None = None
        self.last_ics_path: Path | None = None
        self.event_source_message: core.Message | None = None

        self.db_var = tk.StringVar(value=self._default_db_value())
        self.output_var = tk.StringVar(value=str(Path(__file__).resolve().parent))
        self.calendar_dir_var = tk.StringVar(value=str(core.desktop_calendar_drop_dir()))
        self.interval_var = tk.DoubleVar(value=5.0)
        self.bootstrap_var = tk.StringVar(value="latest")
        self.include_sent_var = tk.BooleanVar(value=False)
        self.force_bootstrap_var = tk.BooleanVar(value=False)
        self.max_cycle_var = tk.IntVar(value=200)
        self.recent_limit_var = tk.IntVar(value=200)
        self.status_var = tk.StringVar(value=kr(r"\ub300\uae30 \uc911"))
        self.event_date_var = tk.StringVar(value=dt.date.today().isoformat())
        self.event_time_var = tk.StringVar(value="09:00")
        self.event_title_var = tk.StringVar(value="")
        self.event_duration_var = tk.IntVar(value=30)
        self.all_day_var = tk.BooleanVar(value=True)

        self._configure_style()
        self._build_ui()
        self.root.after(200, self._drain_log_queue)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    @staticmethod
    def _default_db_value() -> str:
        try:
            return str(core.find_default_db())
        except Exception:
            return ""

    @staticmethod
    def _dir_label(direction: str) -> str:
        return kr(r"\uc218\uc2e0") if direction == "recv" else kr(r"\ubc1c\uc2e0")

    def _configure_style(self) -> None:
        self.root.configure(bg="#f4efe7")
        self.style = ttk.Style()
        try:
            self.style.theme_use("clam")
        except tk.TclError:
            pass

        title_font = tkfont.Font(family="Malgun Gothic", size=20, weight="bold")
        subtitle_font = tkfont.Font(family="Malgun Gothic", size=10)
        section_font = tkfont.Font(family="Malgun Gothic", size=11, weight="bold")
        body_font = tkfont.Font(family="Malgun Gothic", size=10)

        self.style.configure(".", font=body_font)
        self.style.configure("Card.TFrame", background="#fbf8f3")
        self.style.configure("Toolbar.TFrame", background="#ede3d6")
        self.style.configure("Stat.TLabel", background="#243447", foreground="#ffffff", padding=(12, 6))
        self.style.configure("Section.TLabelframe.Label", background="#fbf8f3", foreground="#243447", font=section_font)
        self.style.configure("Header.TLabel", background="#f4efe7", foreground="#243447", font=title_font)
        self.style.configure("SubHeader.TLabel", background="#f4efe7", foreground="#6e6257", font=subtitle_font)
        self.style.configure("CardSub.TLabel", background="#fbf8f3", foreground="#6e6257", font=subtitle_font)
        self.style.configure("Field.TLabel", background="#fbf8f3", foreground="#51463f")
        self.style.configure("Accent.TButton", background="#d5724c", foreground="#ffffff", borderwidth=0, padding=(14, 8))
        self.style.map("Accent.TButton", background=[("active", "#b95b3b"), ("pressed", "#9d4c30")])
        self.style.configure("Soft.TButton", background="#e8ddd0", foreground="#3e342f", borderwidth=0, padding=(12, 8))
        self.style.map("Soft.TButton", background=[("active", "#dccab8"), ("pressed", "#cfb9a3")])
        self.style.configure("Treeview", background="#fffdfa", fieldbackground="#fffdfa", rowheight=30, bordercolor="#d8c8b8")
        self.style.configure("Treeview.Heading", background="#efe4d8", foreground="#2d2522", relief="flat", padding=(8, 8))
        self.style.map("Treeview", background=[("selected", "#ead2bf")], foreground=[("selected", "#2b1e18")])
        self.style.configure("TEntry", fieldbackground="#fffdfa", padding=6)
        self.style.configure("TCombobox", padding=4)
        self.style.configure("TSpinbox", padding=4)
        self.style.configure("TCheckbutton", background="#fbf8f3")

    def _build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(2, weight=1)
        self._build_header()
        self._build_toolbar()
        self._build_content()

    def _build_header(self) -> None:
        header = tk.Frame(self.root, bg="#f4efe7", padx=20, pady=18)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)

        ttk.Label(header, text=kr(r"\ucfe8\uba54\uc2e0\uc800 \uba54\uc2dc\uc9c0 \ubcf4\ub4dc"), style="Header.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            header,
            text=kr(
                r"\uba54\uc2dc\uc9c0\ub97c \uc77d\uace0 \uc694\uc57d\ud558\uace0, \ub04c\uc5b4\ub2e4 \ub193\uc73c\uba74 \uc77c\uc815 \ucd08\uc548\uc744 \ub9cc\ub4ed\ub2c8\ub2e4."
            ),
            style="SubHeader.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))
        ttk.Label(header, textvariable=self.status_var, style="Stat.TLabel").grid(row=0, column=1, rowspan=2, sticky="e")

    def _build_toolbar(self) -> None:
        shell = ttk.Frame(self.root, style="Toolbar.TFrame", padding=14)
        shell.grid(row=1, column=0, sticky="ew", padx=18, pady=(0, 12))
        shell.columnconfigure(1, weight=1)

        ttk.Label(shell, text=kr(r"\uba54\ubaa8 DB"), style="Field.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Entry(shell, textvariable=self.db_var).grid(row=0, column=1, sticky="ew", padx=(8, 8))
        ttk.Button(shell, text=kr(r"\uc790\ub3d9 \ucc3e\uae30"), command=self.detect_db, style="Soft.TButton").grid(
            row=0, column=2, padx=(0, 6)
        )
        ttk.Button(shell, text=kr(r"\uc120\ud0dd"), command=self.browse_db, style="Soft.TButton").grid(row=0, column=3)

        ttk.Label(shell, text=kr(r"\uc694\uc57d \uc800\uc7a5 \ud3f4\ub354"), style="Field.TLabel").grid(
            row=1, column=0, sticky="w", pady=(10, 0)
        )
        ttk.Entry(shell, textvariable=self.output_var).grid(row=1, column=1, sticky="ew", padx=(8, 8), pady=(10, 0))
        ttk.Button(shell, text=kr(r"\uc120\ud0dd"), command=self.browse_output, style="Soft.TButton").grid(
            row=1, column=2, pady=(10, 0), padx=(0, 6)
        )
        ttk.Button(shell, text=kr(r"\ud3f4\ub354 \uc5f4\uae30"), command=self.open_output, style="Soft.TButton").grid(
            row=1, column=3, pady=(10, 0)
        )

    def _build_content(self) -> None:
        content = ttk.Panedwindow(self.root, orient="horizontal")
        content.grid(row=2, column=0, sticky="nsew", padx=18, pady=(0, 18))

        left = self._build_left_panel(content)
        right = self._build_right_panel(content)
        content.add(left, weight=5)
        content.add(right, weight=4)

    def _build_left_panel(self, parent: ttk.Panedwindow) -> ttk.Frame:
        left = ttk.Frame(parent, style="Card.TFrame", padding=14)
        left.columnconfigure(0, weight=1)
        left.rowconfigure(3, weight=1)

        ttk.Label(left, text=kr(r"\uba54\uc2dc\uc9c0 \ubaa9\ub85d"), style="Section.TLabelframe.Label").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            left,
            text=kr(r"\uc120\ud0dd\ud55c \uba54\uc2dc\uc9c0\ub97c \uc624\ub978\ucabd \uce98\ub9b0\ub354 \uc601\uc5ed\uc73c\ub85c \ub04c\uc5b4\uc11c \ub193\uc73c\uc138\uc694."),
            style="CardSub.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(4, 10))

        action_bar = ttk.Frame(left, style="Card.TFrame")
        action_bar.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        ttk.Button(action_bar, text=kr(r"\uae30\uc874 \uba54\uc2dc\uc9c0 \ubd88\ub7ec\uc624\uae30"), command=self.load_existing, style="Accent.TButton").pack(
            side="left"
        )
        ttk.Button(action_bar, text=kr(r"\ubd88\ub7ec\uc628 \uba54\uc2dc\uc9c0 \uc694\uc57d \uc800\uc7a5"), command=self.summarize_loaded, style="Soft.TButton").pack(
            side="left", padx=(8, 0)
        )
        self.start_btn = ttk.Button(action_bar, text=kr(r"\uc790\ub3d9 \uac10\uc2dc \uc2dc\uc791"), command=self.start_auto, style="Soft.TButton")
        self.start_btn.pack(side="left", padx=(18, 0))
        self.stop_btn = ttk.Button(
            action_bar,
            text=kr(r"\uc790\ub3d9 \uac10\uc2dc \uc911\uc9c0"),
            command=self.stop_auto,
            style="Soft.TButton",
            state="disabled",
        )
        self.stop_btn.pack(side="left", padx=(8, 0))
        ttk.Button(action_bar, text=kr(r"\ubaa9\ub85d \ube44\uc6b0\uae30"), command=self.clear_messages, style="Soft.TButton").pack(
            side="left", padx=(18, 0)
        )

        table_wrap = ttk.Frame(left, style="Card.TFrame")
        table_wrap.grid(row=3, column=0, sticky="nsew")
        table_wrap.columnconfigure(0, weight=1)
        table_wrap.rowconfigure(0, weight=1)

        columns = ("key", "dir", "when", "peer", "title", "preview")
        self.tree = ttk.Treeview(table_wrap, columns=columns, show="headings")
        self.tree.heading("key", text=kr(r"\ud0a4"))
        self.tree.heading("dir", text=kr(r"\uad6c\ubd84"))
        self.tree.heading("when", text=kr(r"\uc77c\uc2dc"))
        self.tree.heading("peer", text=kr(r"\ubcf4\ub0b8/\ubc1b\uc740 \uc0ac\ub78c"))
        self.tree.heading("title", text=kr(r"\uc81c\ubaa9"))
        self.tree.heading("preview", text=kr(r"\ubbf8\ub9ac\ubcf4\uae30"))
        self.tree.column("key", width=70, stretch=False, anchor="center")
        self.tree.column("dir", width=70, stretch=False, anchor="center")
        self.tree.column("when", width=170, stretch=False)
        self.tree.column("peer", width=230, stretch=False)
        self.tree.column("title", width=240, stretch=False)
        self.tree.column("preview", width=520, stretch=True)
        self.tree.grid(row=0, column=0, sticky="nsew")
        self.tree.bind("<<TreeviewSelect>>", self.on_select)
        self.tree.bind("<Double-Button-1>", self.apply_selected_to_event)
        self.tree.bind("<ButtonPress-1>", self._drag_start)
        self.tree.bind("<B1-Motion>", self._drag_motion)
        self.tree.bind("<ButtonRelease-1>", self._drag_release)

        yscroll = ttk.Scrollbar(table_wrap, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=yscroll.set)
        yscroll.grid(row=0, column=1, sticky="ns")
        return left

    def _build_right_panel(self, parent: ttk.Panedwindow) -> ttk.Panedwindow:
        right = ttk.Panedwindow(parent, orient="vertical")
        right.add(self._build_schedule_panel(right), weight=4)
        right.add(self._build_detail_panel(right), weight=4)
        right.add(self._build_log_panel(right), weight=2)
        return right

    def _build_schedule_panel(self, parent: ttk.Panedwindow) -> ttk.Frame:
        frame = ttk.Frame(parent, style="Card.TFrame", padding=14)
        frame.columnconfigure(1, weight=1)
        frame.columnconfigure(3, weight=1)

        ttk.Label(frame, text=kr(r"\uce98\ub9b0\ub354 \uc77c\uc815 \ub9cc\ub4e4\uae30"), style="Section.TLabelframe.Label").grid(
            row=0, column=0, columnspan=4, sticky="w"
        )
        ttk.Label(
            frame,
            text=kr(
                r"\uba54\uc2dc\uc9c0\ub97c \uc774 \uc601\uc5ed\uc73c\ub85c \ub04c\uc5b4 \ub193\uc73c\uba74 \ub0a0\uc9dc\ub97c \ucd94\uc815\ud574 \uc77c\uc815 \ucd08\uc548\uc744 \ucc44\uc6c1\ub2c8\ub2e4."
            ),
            style="CardSub.TLabel",
        ).grid(row=1, column=0, columnspan=4, sticky="w", pady=(4, 10))

        self.drop_zone = tk.Frame(frame, bg="#f7dcc8", bd=0, highlightthickness=2, highlightbackground="#d88a63")
        self.drop_zone.grid(row=2, column=0, columnspan=4, sticky="ew", pady=(0, 14))
        self.drop_zone.columnconfigure(0, weight=1)
        tk.Label(
            self.drop_zone,
            text=kr(r"\uba54\uc2dc\uc9c0\ub97c \uc5ec\uae30\ub85c \ub04c\uc5b4\uc11c \ub193\uc73c\uc138\uc694"),
            bg="#f7dcc8",
            fg="#5a3627",
            font=("Malgun Gothic", 11, "bold"),
            pady=10,
        ).grid(row=0, column=0, sticky="ew")
        tk.Label(
            self.drop_zone,
            text=kr(
                r"\uc678\ubd80 \uc704\uc82f\uc73c\ub85c \uc9c1\uc811 \ub4dc\ub86d\ud558\ub294 \uac83\uc740 \uc704\uc82f \uc885\ub958\uc5d0 \ub530\ub77c \ub2e4\ub974\ubbc0\ub85c, \uc6b0\uc120 .ics \uc77c\uc815 \ud30c\uc77c\uc744 \ub9cc\ub4dc\ub294 \ud750\ub984\uc744 \ub123\uc5c8\uc2b5\ub2c8\ub2e4."
            ),
            bg="#f7dcc8",
            fg="#6c4b3c",
            font=("Malgun Gothic", 9),
            pady=4,
        ).grid(row=1, column=0, sticky="ew")

        ttk.Label(frame, text=kr(r"\uc77c\uc815 \ub0a0\uc9dc"), style="Field.TLabel").grid(row=3, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.event_date_var).grid(row=3, column=1, sticky="ew", padx=(8, 16))
        ttk.Label(frame, text=kr(r"\uc2dc\uc791 \uc2dc\uac04"), style="Field.TLabel").grid(row=3, column=2, sticky="w")
        ttk.Entry(frame, textvariable=self.event_time_var).grid(row=3, column=3, sticky="ew", padx=(8, 0))

        ttk.Label(frame, text=kr(r"\uc77c\uc815 \uc81c\ubaa9"), style="Field.TLabel").grid(row=4, column=0, sticky="w", pady=(10, 0))
        ttk.Entry(frame, textvariable=self.event_title_var).grid(row=4, column=1, columnspan=3, sticky="ew", padx=(8, 0), pady=(10, 0))

        ttk.Label(frame, text=kr(r"\uc18c\uc694 \uc2dc\uac04(\ubd84)"), style="Field.TLabel").grid(row=5, column=0, sticky="w", pady=(10, 0))
        ttk.Spinbox(frame, from_=5, to=1440, textvariable=self.event_duration_var, width=10).grid(
            row=5, column=1, sticky="w", padx=(8, 16), pady=(10, 0)
        )
        ttk.Checkbutton(frame, text=kr(r"\uc885\uc77c \uc77c\uc815"), variable=self.all_day_var).grid(
            row=5, column=2, columnspan=2, sticky="w", pady=(10, 0)
        )

        ttk.Label(frame, text=kr(r"\uc77c\uc815 \ud30c\uc77c \ud3f4\ub354"), style="Field.TLabel").grid(
            row=6, column=0, sticky="w", pady=(10, 0)
        )
        ttk.Entry(frame, textvariable=self.calendar_dir_var).grid(row=6, column=1, columnspan=2, sticky="ew", padx=(8, 8), pady=(10, 0))
        ttk.Button(frame, text=kr(r"\ud3f4\ub354 \uc5f4\uae30"), command=self.open_calendar_folder, style="Soft.TButton").grid(
            row=6, column=3, pady=(10, 0)
        )

        action_row = ttk.Frame(frame, style="Card.TFrame")
        action_row.grid(row=7, column=0, columnspan=4, sticky="ew", pady=(14, 0))
        ttk.Button(action_row, text=kr(r"\uc120\ud0dd \uba54\uc2dc\uc9c0\ub85c \uc77c\uc815 \ucc44\uc6b0\uae30"), command=self.apply_selected_to_event, style="Soft.TButton").pack(
            side="left"
        )
        ttk.Button(action_row, text=kr(r"\uc77c\uc815 \ud30c\uc77c(.ics) \ub9cc\ub4e4\uae30"), command=self.create_calendar_file, style="Accent.TButton").pack(
            side="left", padx=(8, 0)
        )
        ttk.Button(action_row, text=kr(r"\ub9c8\uc9c0\ub9c9 \ud30c\uc77c \uc5f4\uae30"), command=self.open_last_ics, style="Soft.TButton").pack(
            side="left", padx=(8, 0)
        )
        ttk.Button(action_row, text=kr(r"\uce98\ub9b0\ub354 \uc704\uc82f \uc5f4\uae30"), command=self.launch_widget, style="Soft.TButton").pack(
            side="left", padx=(18, 0)
        )

        ttk.Label(frame, text=kr(r"\uc77c\uc815 \uba54\ubaa8"), style="Field.TLabel").grid(row=8, column=0, sticky="w", pady=(14, 6))
        memo_frame = ttk.Frame(frame, style="Card.TFrame")
        memo_frame.grid(row=9, column=0, columnspan=4, sticky="nsew")
        memo_frame.columnconfigure(0, weight=1)
        memo_frame.rowconfigure(0, weight=1)
        frame.rowconfigure(9, weight=1)

        self.event_notes = tk.Text(
            memo_frame,
            height=10,
            wrap="word",
            bg="#fffdfa",
            fg="#2f2520",
            relief="flat",
            font=("Malgun Gothic", 10),
            padx=10,
            pady=10,
        )
        self.event_notes.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(memo_frame, orient="vertical", command=self.event_notes.yview)
        self.event_notes.configure(yscrollcommand=scroll.set)
        scroll.grid(row=0, column=1, sticky="ns")
        return frame

    def _build_detail_panel(self, parent: ttk.Panedwindow) -> ttk.Frame:
        frame = ttk.Frame(parent, style="Card.TFrame", padding=14)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(1, weight=1)
        ttk.Label(frame, text=kr(r"\uc120\ud0dd \uba54\uc2dc\uc9c0 \uc0c1\uc138"), style="Section.TLabelframe.Label").grid(
            row=0, column=0, sticky="w"
        )

        text_wrap = ttk.Frame(frame, style="Card.TFrame")
        text_wrap.grid(row=1, column=0, sticky="nsew", pady=(10, 0))
        text_wrap.columnconfigure(0, weight=1)
        text_wrap.rowconfigure(0, weight=1)

        self.detail = tk.Text(
            text_wrap,
            wrap="word",
            bg="#fffdfa",
            fg="#2f2520",
            relief="flat",
            font=("Malgun Gothic", 10),
            padx=10,
            pady=10,
        )
        self.detail.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(text_wrap, orient="vertical", command=self.detail.yview)
        self.detail.configure(yscrollcommand=scroll.set)
        scroll.grid(row=0, column=1, sticky="ns")
        return frame

    def _build_log_panel(self, parent: ttk.Panedwindow) -> ttk.Frame:
        frame = ttk.Frame(parent, style="Card.TFrame", padding=14)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(1, weight=1)

        top = ttk.Frame(frame, style="Card.TFrame")
        top.grid(row=0, column=0, sticky="ew")
        ttk.Label(top, text=kr(r"\uc2e4\ud589 \ub85c\uadf8"), style="Section.TLabelframe.Label").pack(side="left")

        opts = ttk.Frame(top, style="Card.TFrame")
        opts.pack(side="right")
        ttk.Label(opts, text=kr(r"\uac10\uc2dc \uac04\uaca9"), style="Field.TLabel").pack(side="left")
        ttk.Spinbox(opts, from_=1, to=60, textvariable=self.interval_var, width=6).pack(side="left", padx=(6, 16))
        ttk.Label(opts, text=kr(r"\ud68c\ub2f9 \ucc98\ub9ac"), style="Field.TLabel").pack(side="left")
        ttk.Spinbox(opts, from_=1, to=5000, textvariable=self.max_cycle_var, width=7).pack(side="left", padx=(6, 16))
        ttk.Label(opts, text=kr(r"\ubd88\ub7ec\uc62c \uac74\uc218"), style="Field.TLabel").pack(side="left")
        ttk.Spinbox(opts, from_=10, to=5000, textvariable=self.recent_limit_var, width=7).pack(side="left", padx=(6, 16))
        ttk.Label(opts, text=kr(r"\uc2dc\uc791 \ubc29\uc2dd"), style="Field.TLabel").pack(side="left")
        ttk.Combobox(opts, textvariable=self.bootstrap_var, values=("latest", "all"), state="readonly", width=10).pack(
            side="left", padx=(6, 14)
        )
        ttk.Checkbutton(opts, text=kr(r"\ubc1c\uc2e0 \ud3ec\ud568"), variable=self.include_sent_var).pack(side="left", padx=(0, 12))
        ttk.Checkbutton(opts, text=kr(r"\uc0c1\ud0dc \ucd08\uae30\ud654"), variable=self.force_bootstrap_var).pack(side="left")

        text_wrap = ttk.Frame(frame, style="Card.TFrame")
        text_wrap.grid(row=1, column=0, sticky="nsew", pady=(10, 0))
        text_wrap.columnconfigure(0, weight=1)
        text_wrap.rowconfigure(0, weight=1)

        self.log_text = tk.Text(
            text_wrap,
            wrap="word",
            height=8,
            bg="#fffdfa",
            fg="#2f2520",
            relief="flat",
            font=("Consolas", 10),
            padx=10,
            pady=10,
        )
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(text_wrap, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scroll.set)
        scroll.grid(row=0, column=1, sticky="ns")
        return frame

    def _log(self, message: str) -> None:
        ts = dt.datetime.now().strftime("%H:%M:%S")
        self.log_text.insert("end", f"[{ts}] {message}\n")
        self.log_text.see("end")

    def _drain_log_queue(self) -> None:
        while True:
            try:
                msg = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self._log(msg)
        self.root.after(200, self._drain_log_queue)

    def detect_db(self) -> None:
        try:
            self.db_var.set(str(core.find_default_db()))
            self._log(kr(r"\uae30\ubcf8 UDB \ud30c\uc77c\uc744 \ucc3e\uc558\uc2b5\ub2c8\ub2e4."))
        except Exception as exc:
            messagebox.showerror(kr(r"\ucc3e\uae30 \uc2e4\ud328"), str(exc))

    def browse_db(self) -> None:
        path = filedialog.askopenfilename(
            title=kr(r"UDB \ud30c\uc77c \uc120\ud0dd"),
            filetypes=[("UDB files", "*.udb"), ("All files", "*.*")],
        )
        if path:
            self.db_var.set(path)

    def browse_output(self) -> None:
        path = filedialog.askdirectory(title=kr(r"\uc694\uc57d \uc800\uc7a5 \ud3f4\ub354 \uc120\ud0dd"))
        if path:
            self.output_var.set(path)

    def open_output(self) -> None:
        out = Path(self.output_var.get().strip())
        out.mkdir(parents=True, exist_ok=True)
        os.startfile(str(out))

    def open_calendar_folder(self) -> None:
        folder = Path(self.calendar_dir_var.get().strip())
        folder.mkdir(parents=True, exist_ok=True)
        os.startfile(str(folder))

    def _validate_paths(self) -> tuple[Path, Path] | None:
        db = Path(self.db_var.get().strip())
        out = Path(self.output_var.get().strip())
        if not db.exists():
            messagebox.showerror(kr(r"\uc798\ubabb\ub41c DB"), f"DB not found:\n{db}")
            return None
        out.mkdir(parents=True, exist_ok=True)
        return db, out

    def clear_messages(self) -> None:
        self.messages = []
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.detail.delete("1.0", "end")
        self._log(kr(r"\uba54\uc2dc\uc9c0 \ubaa9\ub85d\uc744 \ube44\uc6e0\uc2b5\ub2c8\ub2e4."))
        self.status_var.set(kr(r"\ubaa9\ub85d \ube44\uc6c0"))

    def load_existing(self) -> None:
        paths = self._validate_paths()
        if not paths:
            return
        db, _ = paths
        limit = max(10, int(self.recent_limit_var.get()))
        include_sent = bool(self.include_sent_var.get())

        try:
            self.messages = core.read_recent_from_db(db, include_sent=include_sent, limit=limit)
        except Exception as exc:
            messagebox.showerror(kr(r"\ubd88\ub7ec\uc624\uae30 \uc2e4\ud328"), str(exc))
            return

        for item in self.tree.get_children():
            self.tree.delete(item)

        for idx, msg in enumerate(self.messages):
            self.tree.insert(
                "",
                "end",
                iid=str(idx),
                values=(
                    msg.key,
                    self._dir_label(msg.direction),
                    msg.when_text,
                    msg.peer,
                    msg.title,
                    core.preview_text(msg.body, 120),
                ),
            )

        self.status_var.set(kr(r"\uba54\uc2dc\uc9c0 \ubd88\ub7ec\uc634"))
        self._log(f"{len(self.messages)}{kr(r'\uac74\uc758 \uba54\uc2dc\uc9c0\ub97c \ubd88\ub7ec\uc654\uc2b5\ub2c8\ub2e4.')}")

    def _selected_message(self) -> core.Message | None:
        selected = self.tree.selection()
        if not selected:
            return None
        idx = int(selected[0])
        if idx >= len(self.messages):
            return None
        return self.messages[idx]

    def on_select(self, _event: object) -> None:
        msg = self._selected_message()
        if not msg:
            return

        summary = core.summarize_message(msg)
        detail = [
            f"{kr(r'\uad6c\ubd84')}: {self._dir_label(msg.direction)}",
            f"{kr(r'\ud0a4')}: {msg.key}",
            f"{kr(r'\uc77c\uc2dc')}: {msg.when_text}",
            f"{kr(r'\uc0c1\ub300')}: {msg.peer}",
            f"{kr(r'\uc81c\ubaa9')}: {msg.title}",
            "",
            f"{kr(r'\uc694\uc57d')}: {summary}",
            "",
            kr(r"\ubcf8\ubb38") + ":",
            core.normalize_text(msg.body),
        ]
        if msg.file_path:
            detail.extend(["", f"{kr(r'\ucca8\ubd80')}: {msg.file_path}"])
        if msg.link_url:
            detail.extend(["", f"{kr(r'\ub9c1\ud06c')}: {msg.link_url}"])

        self.detail.delete("1.0", "end")
        self.detail.insert("1.0", "\n".join(detail))

    def summarize_loaded(self) -> None:
        if not self.messages:
            messagebox.showinfo(kr(r"\uba54\uc2dc\uc9c0 \uc5c6\uc74c"), kr(r"\uba3c\uc800 \uba54\uc2dc\uc9c0\ub97c \ubd88\ub7ec\uc624\uc138\uc694."))
            return
        paths = self._validate_paths()
        if not paths:
            return
        _, out = paths
        written = core.append_summaries(out, self.messages)
        self._log(f"{written}{kr(r'\uac74\uc758 \uc694\uc57d\uc744 \uc800\uc7a5\ud588\uc2b5\ub2c8\ub2e4.')}")
        self.status_var.set(kr(r"\uc694\uc57d \uc800\uc7a5 \uc644\ub8cc"))

    def _apply_message_to_event(self, msg: core.Message) -> None:
        self.event_source_message = msg
        self.event_date_var.set(core.guess_event_date(msg))
        guessed_time = core.guess_event_time(msg)
        self.event_time_var.set(guessed_time or "09:00")
        self.all_day_var.set(guessed_time == "")
        self.event_title_var.set(core.build_calendar_title(msg))
        self.event_duration_var.set(30)
        self.event_notes.delete("1.0", "end")
        self.event_notes.insert("1.0", core.build_calendar_description(msg))
        self.status_var.set(kr(r"\uc77c\uc815 \ucd08\uc548 \uc900\ube44"))

    def apply_selected_to_event(self, _event: object | None = None) -> None:
        msg = self._selected_message()
        if not msg:
            messagebox.showinfo(kr(r"\uc120\ud0dd \ud544\uc694"), kr(r"\uc77c\uc815\uc73c\ub85c \ubc14\uafc0 \uba54\uc2dc\uc9c0\ub97c \uba3c\uc800 \uc120\ud0dd\ud558\uc138\uc694."))
            return
        self._apply_message_to_event(msg)
        self._log(kr(r"\uc120\ud0dd\ud55c \uba54\uc2dc\uc9c0\ub85c \uc77c\uc815 \ucd08\uc548\uc744 \ucc44\uc6e0\uc2b5\ub2c8\ub2e4."))

    def create_calendar_file(self) -> None:
        source = self.event_source_message or self._selected_message()
        if not source:
            messagebox.showinfo(kr(r"\uc120\ud0dd \ud544\uc694"), kr(r"\uba54\uc2dc\uc9c0\ub97c \uc120\ud0dd\ud558\uac70\ub098 \ub04c\uc5b4\uc11c \uc77c\uc815 \ucd08\uc548\uc744 \uba3c\uc800 \ub9cc\ub4e4\uc5b4\uc8fc\uc138\uc694."))
            return

        out_dir = Path(self.calendar_dir_var.get().strip())
        title = self.event_title_var.get().strip()
        event_date = self.event_date_var.get().strip()
        event_time = self.event_time_var.get().strip()
        notes = self.event_notes.get("1.0", "end").strip()
        all_day = bool(self.all_day_var.get())
        duration = max(5, int(self.event_duration_var.get()))

        try:
            self.last_ics_path = core.create_ics_file(
                output_dir=out_dir,
                msg=source,
                event_date=event_date,
                event_time="" if all_day else event_time,
                duration_minutes=duration,
                all_day=all_day,
                title=title,
                description=notes,
            )
        except Exception as exc:
            messagebox.showerror(kr(r"\uc77c\uc815 \ud30c\uc77c \uc0dd\uc131 \uc2e4\ud328"), str(exc))
            return

        self._log(f"{kr(r'\uc77c\uc815 \ud30c\uc77c\uc744 \ub9cc\ub4e4\uc5c8\uc2b5\ub2c8\ub2e4')}: {self.last_ics_path}")
        self.status_var.set(kr(r"\uc77c\uc815 \ud30c\uc77c \uc0dd\uc131 \uc644\ub8cc"))
        messagebox.showinfo(
            kr(r"\uc0dd\uc131 \uc644\ub8cc"),
            f"{kr(r'\uc77c\uc815 \ud30c\uc77c\uc744 \ub9cc\ub4e4\uc5c8\uc2b5\ub2c8\ub2e4.')}\n\n{self.last_ics_path}",
        )

    def open_last_ics(self) -> None:
        if not self.last_ics_path or not self.last_ics_path.exists():
            messagebox.showinfo(kr(r"\ud30c\uc77c \uc5c6\uc74c"), kr(r"\uba3c\uc800 .ics \ud30c\uc77c\uc744 \ub9cc\ub4e4\uc5b4\uc8fc\uc138\uc694."))
            return
        os.startfile(str(self.last_ics_path))

    def launch_widget(self) -> None:
        widget_path = Path(__file__).resolve().parent / "cm_calendar_widget.py"
        if not widget_path.exists():
            messagebox.showerror(kr(r"\uc2e4\ud589 \uc2e4\ud328"), f"Widget file not found:\n{widget_path}")
            return
        try:
            subprocess.Popen([sys.executable, str(widget_path)], cwd=str(widget_path.parent))
        except Exception as exc:
            messagebox.showerror(kr(r"\uc2e4\ud589 \uc2e4\ud328"), str(exc))
            return
        self._log(kr(r"\uce98\ub9b0\ub354 \uc704\uc82f\uc744 \uc2e4\ud589\ud588\uc2b5\ub2c8\ub2e4."))

    def start_auto(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        paths = self._validate_paths()
        if not paths:
            return
        db, out = paths
        state_path = out / "state.json"
        interval = max(1.0, float(self.interval_var.get()))
        max_cycle = max(1, int(self.max_cycle_var.get()))
        include_sent = bool(self.include_sent_var.get())
        bootstrap = self.bootstrap_var.get().strip() or "latest"
        force_bootstrap = bool(self.force_bootstrap_var.get())

        self.stop_event = threading.Event()
        self.worker = threading.Thread(
            target=self._auto_loop,
            args=(db, out, state_path, interval, max_cycle, include_sent, bootstrap, force_bootstrap),
            daemon=True,
        )
        self.worker.start()
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.status_var.set(kr(r"\uc790\ub3d9 \uac10\uc2dc \uc911"))
        self._log(kr(r"\uc790\ub3d9 \uc694\uc57d \uac10\uc2dc\ub97c \uc2dc\uc791\ud588\uc2b5\ub2c8\ub2e4."))

    def _auto_loop(
        self,
        db_path: Path,
        output_dir: Path,
        state_path: Path,
        interval: float,
        max_cycle: int,
        include_sent: bool,
        bootstrap: str,
        force_bootstrap: bool,
    ) -> None:
        first_loop = True
        while self.stop_event and not self.stop_event.is_set():
            try:
                written, state = core.run_cycle(
                    db_path=db_path,
                    output_dir=output_dir,
                    state_path=state_path,
                    include_sent=include_sent,
                    bootstrap=bootstrap,
                    force_bootstrap=(force_bootstrap and first_loop),
                    max_new_per_cycle=max_cycle,
                )
                self.log_queue.put(
                    f"{kr(r'\uc790\ub3d9 \uc0ac\uc774\ud074 \uc644\ub8cc')} | "
                    f"{kr(r'\uc2e0\uaddc')}: {written}, "
                    f"last_recv={state.get('last_recv_key', 0)}, "
                    f"last_send={state.get('last_send_key', 0)}"
                )
            except Exception as exc:
                self.log_queue.put(f"{kr(r'\uc790\ub3d9 \uac10\uc2dc \uc624\ub958')}: {exc}")
            first_loop = False
            if self.stop_event.wait(interval):
                break
        self.log_queue.put(kr(r"\uc790\ub3d9 \uac10\uc2dc\ub97c \uc911\uc9c0\ud588\uc2b5\ub2c8\ub2e4."))

    def stop_auto(self) -> None:
        if self.stop_event:
            self.stop_event.set()
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.status_var.set(kr(r"\uc815\uc9c0\ub428"))

    def _drag_start(self, event: tk.Event[tk.Widget]) -> None:
        self.drag_iid = self.tree.identify_row(event.y) or None

    def _drag_motion(self, event: tk.Event[tk.Widget]) -> None:
        if not self.drag_iid:
            return
        idx = int(self.drag_iid)
        if idx >= len(self.messages):
            return
        msg = self.messages[idx]
        if self.drag_label is None:
            self.drag_label = tk.Label(
                self.root,
                text=core.preview_text(msg.title or msg.body, 28),
                bg="#c96544",
                fg="#ffffff",
                padx=12,
                pady=6,
                font=("Malgun Gothic", 10, "bold"),
            )
        x = event.x_root - self.root.winfo_rootx() + 16
        y = event.y_root - self.root.winfo_rooty() + 16
        self.drag_label.place(x=x, y=y)

    def _widget_in_drop_zone(self, widget: tk.Widget | None) -> bool:
        current = widget
        while current is not None:
            if current == self.drop_zone:
                return True
            current = current.master
        return False

    def _drag_release(self, event: tk.Event[tk.Widget]) -> None:
        if self.drag_label is not None:
            self.drag_label.destroy()
            self.drag_label = None

        if not self.drag_iid:
            return
        idx = int(self.drag_iid)
        self.drag_iid = None
        if idx >= len(self.messages):
            return

        target = self.root.winfo_containing(event.x_root, event.y_root)
        if self._widget_in_drop_zone(target):
            msg = self.messages[idx]
            self._apply_message_to_event(msg)
            self._log(kr(r"\uba54\uc2dc\uc9c0\ub97c \ub04c\uc5b4\uc11c \uc77c\uc815 \ucd08\uc548\uc73c\ub85c \ub123\uc5c8\uc2b5\ub2c8\ub2e4."))

    def _on_close(self) -> None:
        self.stop_auto()
        if self.worker and self.worker.is_alive():
            self.worker.join(timeout=2.0)
        self.root.destroy()


def main() -> int:
    root = tk.Tk()
    SummaryGUI(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
