#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SmartSaver AI — שרת פיתוח מקומי.

מגיש את index.html (דף הנחיתה) ואת dashboard.html (לוח הבקרה) מהתיקייה הזו.
הרצה:  python server.py            → http://localhost:8000
        python server.py 5500       → פורט אחר
        python server.py --no-open  → בלי לפתוח דפדפן
"""

import http.server
import socketserver
import socket
import sys
import os
import csv
import json
import webbrowser
from functools import partial

DEFAULT_PORT = 8000
MAX_PORT_TRIES = 20
ROOT = os.path.dirname(os.path.abspath(__file__))

# must stay in sync with google-sheets/Code.gs
SHEET_FIELDS = ["ts", "event", "email", "pw", "goalName", "goalCost", "saved", "amount", "pct", "device"]
SHEET_COLUMNS = ["תאריך", "אירוע", "אימייל", "סיסמה", "שם היעד", "עלות היעד",
                 "נחסך", "סכום", "אחוז", "מכשיר"]


def _use_utf8_console():
    """קונסולת Windows ברירת־מחדל לא יודעת עברית — מיישרים אותה ל-UTF-8.

    line_buffering חשוב לא פחות: בלעדיו פייתון אוגר את הפלט כשה-stdout אינו
    טרמינל, והבאנר פשוט לא מופיע לעולם כי השרת אף פעם לא יוצא.
    """
    # pythonw.exe (הרצה בלי חלון) לא נותן stdout בכלל — בלי זה כל print היה מפיל את השרת
    if sys.stdout is None or sys.stderr is None:
        try:
            log = open(os.path.join(ROOT, "server.log"), "a", encoding="utf-8", buffering=1)
        except Exception:
            log = open(os.devnull, "w")
        if sys.stdout is None:
            sys.stdout = log
        if sys.stderr is None:
            sys.stderr = log
        return

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:
            pass


class SmartSaverHandler(http.server.SimpleHTTPRequestHandler):
    """שרת סטטי עם charset נכון, בלי קאשינג, ועם לוג קריא."""

    # charset מפורש — בלעדיו חלק מהדפדפנים יציגו עברית כג'יבריש
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".md": "text/plain; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".woff2": "font/woff2",
        "": "application/octet-stream",
    }

    def do_POST(self):
        """מדמה את Apps Script מקומית: /api/log כותב ל-sheets-mock.csv.

        קיים כדי שאפשר יהיה לבדוק את צד הלקוח בלי לפרוס לגוגל בכל שינוי.
        """
        if self.path.rstrip("/") != "/api/log":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8")
            row = json.loads(raw)
        except Exception as err:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(str(err).encode("utf-8"))
            return

        path = os.path.join(ROOT, "sheets-mock.csv")
        fresh = not os.path.exists(path)
        with open(path, "a", encoding="utf-8-sig", newline="") as fh:
            w = csv.writer(fh)
            if fresh:
                w.writerow(SHEET_COLUMNS)
            w.writerow([row.get(k, "") for k in SHEET_FIELDS])

        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # the browser may post from file:// or another port while testing
        self.send_header("Access-Control-Allow-Origin", "*")
        # בפיתוח רוצים תמיד את הגרסה הכי עדכנית, בלי קאש של הדפדפן
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        code = args[1] if len(args) > 1 else ""
        mark = "✓" if str(code).startswith("2") or str(code).startswith("3") else "✗"
        sys.stdout.write("  %s  %s\n" % (mark, fmt % args))

    def log_error(self, fmt, *args):
        sys.stderr.write("  ✗  %s\n" % (fmt % args))


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def find_free_port(start):
    for port in range(start, start + MAX_PORT_TRIES):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return None


def main():
    _use_utf8_console()

    args = [a for a in sys.argv[1:]]
    open_browser = "--no-open" not in args
    args = [a for a in args if not a.startswith("--")]
    requested = int(args[0]) if args and args[0].isdigit() else DEFAULT_PORT

    missing = [f for f in ("index.html", "dashboard.html") if not os.path.exists(os.path.join(ROOT, f))]
    if missing:
        print("⚠  חסרים קבצים בתיקייה: " + ", ".join(missing))

    port = find_free_port(requested)
    if port is None:
        print("✗  לא נמצא פורט פנוי בטווח %d–%d." % (requested, requested + MAX_PORT_TRIES - 1))
        sys.exit(1)
    if port != requested:
        print("ℹ  פורט %d תפוס — עוברים ל-%d." % (requested, port))

    handler = partial(SmartSaverHandler, directory=ROOT)
    url = "http://localhost:%d/" % port

    # הבאנר באנגלית בכוונה: cmd.exe הופך סדר של טקסט מימין־לשמאל ומרנדר אותו שבור
    try:
        httpd = ReusableTCPServer(("127.0.0.1", port), handler)
    except OSError as err:
        print("")
        print("  [X] Could not start the server on port %d." % port)
        print("      %s" % err)
        print("      Try a different port:   python server.py 5500")
        print("")
        sys.exit(1)

    with httpd:
        print("")
        print("  +---------------------------------------------+")
        print("  |   SmartSaver AI  -  local server running    |")
        print("  +---------------------------------------------+")
        print("")
        print("   Full site (one file)  %ssmartsaver-ai-complete.html" % url)
        print("   Landing page          %s" % url)
        print("   Dashboard             %sdashboard.html" % url)
        print("")
        print("   Serving from          %s" % ROOT)
        print("   Stop with             Ctrl+C")
        print("")
        sys.stdout.flush()

        if open_browser:
            try:
                webbrowser.open(url + "smartsaver-ai-complete.html")
            except Exception:
                pass

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.\n")


if __name__ == "__main__":
    main()
