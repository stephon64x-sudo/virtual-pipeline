#!/usr/bin/env python3
"""Virtual Pipeline demo server. Standard library only: `python3 server.py` then open http://localhost:8000

  GET  /                 the dashboard (files in web/)
  POST /api/sensor       the pi-top posts {"distance_cm": 12.3} or {"ok": false}
  GET  /api/sensor       the dashboard polls the latest reading
  POST /api/calibrate    {"full_cm": 4.0} and/or {"empty_cm": 22.0}
  GET  /api/info         this laptop's address, for the pi-top connection guide
  POST /api/status       the dashboard posts the live well's status; the pi-top shows it on its screen
  POST /api/sms          {"text": "..."}  -> real SMS through Twilio if configured, else simulated

Real SMS is optional. To switch it on, set these before starting the server:
  export TWILIO_SID=ACxxxx TWILIO_TOKEN=xxxx TWILIO_FROM=+1xxxx ALERT_TO=+9715xxxx
"""
import base64
import json
import os
import socket
import sys
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parent / "web"
CAL_FILE = Path(__file__).resolve().parent / "calibration.json"
STATE = {"distance_cm": None, "ok": False, "ts": 0.0, "full_cm": 4.0, "empty_cm": 20.0}
if CAL_FILE.exists():
    STATE.update(json.loads(CAL_FILE.read_text()))
TWILIO = {k: os.environ.get(k) for k in ("TWILIO_SID", "TWILIO_TOKEN", "TWILIO_FROM", "ALERT_TO")}
LAST_SMS = {"ts": 0.0}
STATUS = {}          # what the dashboard currently says about the live well; echoed to the pi-top screen
PORT = {"n": 8000}


def send_sms(text):
    if not all(TWILIO.values()):
        return {"sent": False, "reason": "SMS gateway not set up, shown on screen only"}
    if time.time() - LAST_SMS["ts"] < 10:
        return {"sent": False, "reason": "rate limit: one SMS every 10 seconds"}
    LAST_SMS["ts"] = time.time()
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO['TWILIO_SID']}/Messages.json"
    body = urllib.parse.urlencode({"From": TWILIO["TWILIO_FROM"], "To": TWILIO["ALERT_TO"], "Body": text}).encode()
    req = urllib.request.Request(url, data=body)
    token = base64.b64encode(f"{TWILIO['TWILIO_SID']}:{TWILIO['TWILIO_TOKEN']}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return {"sent": r.status in (200, 201), "to": TWILIO["ALERT_TO"][:-4] + "****"}
    except Exception as e:  # network down, bad credentials, unverified number...
        return {"sent": False, "reason": f"gateway error: {e}"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        if "/api/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/sensor"):
            age = time.time() - STATE["ts"] if STATE["ts"] else None
            return self._json({**STATE, "age_s": age, "sms_ready": all(TWILIO.values())})
        if self.path.startswith("/api/info"):
            return self._json({"ip": lan_ip(), "port": PORT["n"]})
        if self.path.startswith("/pitop/well_sensor.py"):
            data = (WEB.parent / "pitop" / "well_sensor.py").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/x-python")
            self.send_header("Content-Disposition", 'attachment; filename="well_sensor.py"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        return super().do_GET()

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except ValueError:
            return self._json({"error": "bad json"}, 400)
        if self.path == "/api/sensor":
            STATE["ok"] = bool(body.get("ok", True)) and body.get("distance_cm") is not None
            if STATE["ok"]:
                STATE["distance_cm"] = float(body["distance_cm"])
            STATE["ts"] = time.time()
            return self._json({"ok": True, "status": STATUS})
        if self.path == "/api/status":
            STATUS.clear()
            STATUS.update({k: body.get(k) for k in ("well", "status", "detail", "level")})
            return self._json({"ok": True})
        if self.path == "/api/calibrate":
            for k in ("full_cm", "empty_cm"):
                if k in body:
                    STATE[k] = float(body[k])
            CAL_FILE.write_text(json.dumps({k: STATE[k] for k in ("full_cm", "empty_cm")}))
            return self._json({k: STATE[k] for k in ("full_cm", "empty_cm")})
        if self.path == "/api/sms":
            return self._json(send_sms(str(body.get("text", ""))[:480]))
        return self._json({"error": "not found"}, 404)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    PORT["n"] = port
    print(f"Dashboard:           http://localhost:{port}")
    print(f"pi-top should post to http://{lan_ip()}:{port}   (python3 well_sensor.py {lan_ip()})")
    print("Real SMS:            " + ("ON" if all(TWILIO.values()) else "off (simulated on screen)"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
