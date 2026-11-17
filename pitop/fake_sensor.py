#!/usr/bin/env python3
"""Stand-in for the pi-top, for rehearsing without hardware. Runs on the laptop.

    python3 pitop/fake_sensor.py            # then type commands:
      d   drain a bit        f   refill        x   unplug / replug the sensor        q   quit
"""
import json
import sys
import threading
import time
import urllib.request

URL = f"http://localhost:{sys.argv[1] if len(sys.argv) > 1 else 8000}/api/sensor"
state = {"cm": 5.0, "plugged": True, "run": True}


def loop():
    while state["run"]:
        payload = {"distance_cm": state["cm"]} if state["plugged"] else {"ok": False}
        try:
            urllib.request.urlopen(urllib.request.Request(URL, data=json.dumps(payload).encode()), timeout=1).read()
        except Exception as e:
            print("server not reachable:", e)
        time.sleep(0.3)


threading.Thread(target=loop, daemon=True).start()
print(__doc__)
for line in sys.stdin:
    c = line.strip().lower()
    if c == "d":
        state["cm"] = min(20.0, state["cm"] + 1.5)
    elif c == "f":
        state["cm"] = max(4.0, state["cm"] - 3.0)
    elif c == "x":
        state["plugged"] = not state["plugged"]
    elif c == "q":
        break
    print(f"distance {state['cm']:.1f} cm, sensor {'plugged in' if state['plugged'] else 'UNPLUGGED'}")
state["run"] = False
