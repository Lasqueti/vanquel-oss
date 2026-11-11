#!/usr/bin/env bash
# scripts/phone/check-line.sh <phone-ip> <bridge-port>
# Read-only health check for one iPhone line. Run it from the Mac mini's own
# terminal (not from inside a pm2 process). Changes nothing.
set -u
PHONE_IP="${1:?usage: check-line.sh <phone-ip> <bridge-port>}"
BRIDGE_PORT="${2:?usage: check-line.sh <phone-ip> <bridge-port>}"

echo "SMServer on the phone (want an HTML page):"
curl -m 6 -s "http://${PHONE_IP}:8741/" | head -c 60; echo
echo
echo "Bridge on this Mac (want \"status\":\"ok\"):"
curl -m 15 -s "http://127.0.0.1:${BRIDGE_PORT}/health"; echo
