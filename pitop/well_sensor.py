#!/usr/bin/env python3
"""Field station for well W12. Runs ON THE PI-TOP.

    python3 well_sensor.py <laptop-address> [sensor port, default D3] [server port, default 8000]

What it does, four times a second:
  1. reads the ultrasonic sensor that points straight down at the water (it never touches it)
  2. smooths the reading and posts it to the laptop running server.py
  3. shows on the pi-top's own little screen what the system currently says about the well
     (OK / WATCH / ACT / DRY), so the warning is visible at the well itself

Water goes down -> distance goes up. Pull the sensor cable and the dashboard shows
"sensor offline" within about three seconds and falls back to herders' rope texts.
"""
import json
import statistics
import sys
import time
import urllib.request

from pitop import UltrasonicSensor

HOST = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.10"
PORT = sys.argv[2] if len(sys.argv) > 2 else "D3"
SERVER_PORT = sys.argv[3] if len(sys.argv) > 3 else "8000"
URL = f"http://{HOST}:{SERVER_PORT}/api/sensor"
MIN_CM, MAX_CM = 1.5, 150.0        # anything outside this is a pulled cable or a bad echo


def post(payload):
    """Send one reading. Returns the dashboard's current status for the well, or None if unreachable."""
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=1) as r:
            return json.loads(r.read()).get("status") or {}
    except Exception as e:
        print("  cannot reach laptop:", e)
        return None


class Screen:
    """The pi-top's built-in miniscreen. Optional: if anything about it fails, we just carry on without it."""

    def __init__(self):
        self.screen, self.last = None, ""
        try:
            from pitop import Pitop
            self.screen = Pitop().miniscreen
        except Exception as e:
            print("miniscreen not available, continuing without it:", e)

    def show(self, text):
        if self.screen is None or text == self.last:
            return
        self.last = text
        try:
            self.screen.display_multiline_text(text, font_size=14)
        except Exception as e:
            print("miniscreen stopped working:", e)
            self.screen = None


def main():
    sensor = UltrasonicSensor(PORT)
    screen = Screen()
    recent = []
    print(f"Field station posting to {URL} from port {PORT}. Ctrl+C to stop.")
    while True:
        try:
            cm = sensor.distance * 100.0
            if not MIN_CM < cm < MAX_CM:
                raise ValueError(f"implausible reading {cm:.1f} cm")
            recent = (recent + [cm])[-5:]
            smooth = statistics.median(recent)       # median of the last 5 kills ripples and spikes
            status = post({"distance_cm": round(smooth, 1)})
            line = f"{smooth:5.1f} cm"
        except Exception as e:
            recent = []
            status = post({"ok": False})
            line = f"sensor offline ({e})"
        if status is None:
            screen.show("W12 field station\nno link to laptop")
        elif status.get("status"):
            screen.show(f"{status.get('well', 'W12')}  {status['status']}\n{status.get('detail', '')}\n{line}")
        else:
            screen.show(f"W12 field station\n{line}")
        print(" ", line, "|", (status or {}).get("status", ""))
        time.sleep(0.25)


if __name__ == "__main__":
    main()
