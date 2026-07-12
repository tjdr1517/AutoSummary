from __future__ import annotations

import ctypes
import subprocess
from ctypes import wintypes


if ctypes.sizeof(ctypes.c_void_p) == ctypes.sizeof(ctypes.c_longlong):
    LONG_PTR = ctypes.c_longlong
    ULONG_PTR = ctypes.c_ulonglong
else:
    LONG_PTR = ctypes.c_long
    ULONG_PTR = ctypes.c_ulong


user32 = ctypes.windll.user32
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_CHILD = 0x40000000
WS_POPUP = 0x80000000
WS_EX_APPWINDOW = 0x00040000
WS_EX_TOOLWINDOW = 0x00000080
HWND_TOP = 0
HWND_BOTTOM = 1
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
SWP_SHOWWINDOW = 0x0040
SMTO_NORMAL = 0x0000
PROGMAN_SPAWN_WORKERW = 0x052C
WM_COMMAND = 0x0111
MIN_ALL = 419


user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND
user32.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowExW.restype = wintypes.HWND
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.SendMessageTimeoutW.argtypes = [
    wintypes.HWND,
    wintypes.UINT,
    wintypes.WPARAM,
    wintypes.LPARAM,
    wintypes.UINT,
    wintypes.UINT,
    ctypes.POINTER(ULONG_PTR),
]
user32.SendMessageTimeoutW.restype = wintypes.LPARAM
user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowLongPtrW.restype = LONG_PTR
user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, LONG_PTR]
user32.SetWindowLongPtrW.restype = LONG_PTR
user32.SetParent.argtypes = [wintypes.HWND, wintypes.HWND]
user32.SetParent.restype = wintypes.HWND
user32.SetWindowPos.argtypes = [
    wintypes.HWND,
    wintypes.HWND,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.UINT,
]
user32.SetWindowPos.restype = wintypes.BOOL
user32.GetDesktopWindow.argtypes = []
user32.GetDesktopWindow.restype = wintypes.HWND
user32.GetParent.argtypes = [wintypes.HWND]
user32.GetParent.restype = wintypes.HWND
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.MapWindowPoints.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_void_p, wintypes.UINT]
user32.MapWindowPoints.restype = ctypes.c_int
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.SendMessageW.restype = wintypes.LPARAM


def _spawn_workerw() -> None:
    progman = user32.FindWindowW("Progman", None)
    if not progman:
        return
    result = ULONG_PTR()
    user32.SendMessageTimeoutW(progman, PROGMAN_SPAWN_WORKERW, 0, 0, SMTO_NORMAL, 1000, ctypes.byref(result))
    user32.SendMessageTimeoutW(progman, PROGMAN_SPAWN_WORKERW, 0xD, 1, SMTO_NORMAL, 1000, ctypes.byref(result))


def _find_workerw() -> int:
    _spawn_workerw()
    workerw_handle = wintypes.HWND()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_windows_proc(hwnd: int, lparam: int) -> bool:
        nonlocal workerw_handle
        shell_view = user32.FindWindowExW(hwnd, None, "SHELLDLL_DefView", None)
        if shell_view:
            workerw = user32.FindWindowExW(None, hwnd, "WorkerW", None)
            if workerw:
                workerw_handle = workerw
                return False
        return True

    user32.EnumWindows(enum_windows_proc, 0)
    return int(workerw_handle.value or 0)


def desktop_parent_handle() -> int:
    workerw = _find_workerw()
    if workerw:
        return workerw

    progman = user32.FindWindowW("Progman", None)
    if progman:
        return int(progman)
    return int(user32.GetDesktopWindow())


def _window_rect(hwnd: int) -> wintypes.RECT:
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise OSError(f"GetWindowRect failed for hwnd={hwnd}")
    return rect


def window_screen_bounds(hwnd: int) -> tuple[int, int, int, int]:
    rect = _window_rect(hwnd)
    return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top


def _map_screen_rect_to_parent(parent_hwnd: int, rect: wintypes.RECT) -> wintypes.RECT:
    mapped = wintypes.RECT(rect.left, rect.top, rect.right, rect.bottom)
    user32.MapWindowPoints(None, parent_hwnd, ctypes.byref(mapped), 2)
    return mapped


def set_window_screen_bounds(hwnd: int, x: int, y: int, width: int, height: int) -> bool:
    parent_hwnd = int(user32.GetParent(hwnd) or 0)
    if parent_hwnd:
        target_rect = _map_screen_rect_to_parent(parent_hwnd, wintypes.RECT(x, y, x + width, y + height))
        x = target_rect.left
        y = target_rect.top

    flags = SWP_NOACTIVATE | SWP_SHOWWINDOW
    return bool(user32.SetWindowPos(hwnd, HWND_BOTTOM, x, y, width, height, flags))


def reveal_desktop() -> bool:
    try:
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(New-Object -ComObject Shell.Application).MinimizeAll()",
            ],
            check=False,
            timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return True
    except Exception:
        pass

    tray = user32.FindWindowW("Shell_TrayWnd", None)
    if not tray:
        return False
    user32.SendMessageW(tray, WM_COMMAND, MIN_ALL, 0)
    return True


def attach_window_to_desktop(hwnd: int) -> bool:
    """작업 표시줄에서 숨기고 창을 맨 아래(바탕화면 바로 위)로 고정한다.

    셸 창(WorkerW/Progman)에 SetParent로 편입하는 방식은 입력은 동작하지만
    Qt 위젯의 화면 합성이 끊겨 내용이 보이지 않으므로 사용하지 않는다.
    '바탕화면 보기'로 최소화되는 문제는 UI 쪽(OverlayBoardWindow)에서
    최소화 감지 후 즉시 복원하는 방식으로 처리한다.
    """
    ex_style = int(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    ex_style = (ex_style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
    user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, LONG_PTR(ex_style))

    flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW
    return bool(user32.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, flags))
