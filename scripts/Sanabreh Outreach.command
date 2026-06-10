#!/bin/bash
# Double-click this file to open the Sanabreh Outreach dashboard.
# It starts the dashboard if it is not already running, then opens it in
# your browser. No typing required.

cd "/Users/raysmacbook/Desktop/Vernon Tech And Media/Client Projects/Scalesolo" || exit 1

# Start the dashboard only if it is not already responding.
if ! curl -s -o /dev/null http://localhost:8787/ ; then
  echo "Starting the Sanabreh outreach dashboard..."
  nohup python3 scripts/outreach-dashboard.py >/tmp/sanabreh-dashboard.log 2>&1 &
  # wait for it to come up (up to ~10s)
  for i in $(seq 1 20); do
    sleep 0.5
    curl -s -o /dev/null http://localhost:8787/ && break
  done
fi

echo "Opening dashboard in your browser..."
open http://localhost:8787

# Keep this window open briefly so any startup errors are visible.
sleep 2
