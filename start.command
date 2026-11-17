#!/bin/sh
cd "$(dirname "$0")"
(sleep 1; open http://localhost:8000 2>/dev/null) &
exec python3 server.py
