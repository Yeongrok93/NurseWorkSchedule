"""
듀티표 생성기 데스크톱 런처
============================
PyInstaller exe 진입점.
내장 서버(FastAPI+솔버)를 백그라운드 스레드로 띄우고,
pywebview(Edge WebView2) 네이티브 창으로 UI를 연다.
WebView2를 쓸 수 없는 환경에서는 기본 브라우저로 폴백.
창을 닫으면 프로그램이 종료된다.
"""

from __future__ import annotations

import multiprocessing
import os
import socket
import sys
import threading
import time

# --windowed 빌드에서는 stdout/stderr가 None → print/logging 크래시 방지
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")


def _find_free_port(preferred: int = 8002) -> int:
    for port in [preferred] + list(range(8003, 8020)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return 0


def _run_server(port: int):
    import uvicorn
    from main import app
    uvicorn.run(app, host="127.0.0.1", port=port, log_config=None, log_level="critical")


def _wait_ready(port: int, timeout: float = 30.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def main():
    multiprocessing.freeze_support()

    port = _find_free_port()
    url = f"http://127.0.0.1:{port}"

    threading.Thread(target=_run_server, args=(port,), daemon=True).start()
    _wait_ready(port)

    try:
        import webview
        webview.settings["ALLOW_DOWNLOADS"] = True   # 엑셀 다운로드 허용
        webview.create_window(
            "간호사 듀티표 생성기",
            url,
            width=1440, height=900,
            min_size=(1000, 680),
        )
        webview.start()
    except Exception:
        # WebView2 미설치 등 → 기본 브라우저 폴백 (창 대신 탭)
        import webbrowser
        webbrowser.open(url)
        # 서버 유지 (사용자가 프로세스를 끌 때까지)
        while True:
            time.sleep(3600)

    # 창이 닫히면 즉시 종료 (데몬 서버 스레드 정리)
    os._exit(0)


if __name__ == "__main__":
    main()
