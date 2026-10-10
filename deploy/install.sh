#!/usr/bin/env bash
# Installs the systemd unit and default config. Usage: sudo deploy/install.sh [service-user]
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Run as root (sudo)." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${1:-${SUDO_USER:-root}}"
NODE="$(command -v node || true)"

if [[ -z "$NODE" ]]; then
    echo "node not found in PATH." >&2
    exit 1
fi

sed -e "s|@USER@|$SERVICE_USER|g" \
    -e "s|@APP_DIR@|$APP_DIR|g" \
    -e "s|@NODE@|$NODE|g" \
    "$SCRIPT_DIR/breezeprint.service" > /etc/systemd/system/breezeprint.service
chmod 644 /etc/systemd/system/breezeprint.service

# Never overwrite an existing config
if [[ -e /etc/default/breezeprint ]]; then
    echo "/etc/default/breezeprint exists; leaving it unchanged."
else
    install -m 600 -o "$SERVICE_USER" "$SCRIPT_DIR/breezeprint.default" /etc/default/breezeprint
fi

systemctl daemon-reload
systemctl enable breezeprint.service

echo "Installed. Edit /etc/default/breezeprint, then run: systemctl restart breezeprint"
