#!/usr/bin/env bash
# hostpulse installer. Puts the service in /opt/hostpulse and starts it on
# 127.0.0.1:8899 - put a reverse proxy with TLS in front of it, or open an SSH
# tunnel to reach the panel. It is deliberately not bound to a public address.
set -euo pipefail

DEST=${DEST:-/opt/hostpulse}
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== dependencies =="
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 python3-venv python3-pip curl
fi

echo "== files =="
mkdir -p "$DEST/data"
for item in app.py db.py collector.py crypto.py static templates requirements.txt; do
  cp -r "$SRC/$item" "$DEST/"
done

echo "== python environment =="
python3 -m venv "$DEST/venv"
"$DEST/venv/bin/pip" install -q --upgrade pip
"$DEST/venv/bin/pip" install -q -r "$DEST/requirements.txt"

echo "== charting library (served locally, no CDN at runtime) =="
if [ ! -s "$DEST/static/chart.min.js" ]; then
  curl -fsSL -o "$DEST/static/chart.min.js" \
    https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
fi

echo "== service =="
cp "$SRC/hostpulse.service" /etc/systemd/system/hostpulse.service
systemctl daemon-reload
systemctl enable --now hostpulse
sleep 2
systemctl --no-pager --lines=5 status hostpulse || true

cat <<MSG

hostpulse is running on 127.0.0.1:8899

Open it and set the panel password on first visit. To reach it from your
laptop without exposing it:

    ssh -N -L 8899:127.0.0.1:8899 root@$(hostname -I | awk '{print $1}')

then browse to http://127.0.0.1:8899

MSG
