#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu server for the game server. Run on the server as the
# default `ubuntu` user (deploy.sh copies this folder there first):
#   bash setup.sh <public hostname>     e.g. bash setup.sh 15-206-64-146.sslip.io
# Installs Node 22, a 1 GB swap file (the t3.micro has 1 GB of memory), Caddy for HTTPS /
# WSS with an automatic Let's Encrypt certificate, and the tank-ctf systemd service.
set -euo pipefail
HOST="${1:?usage: setup.sh <public hostname>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Swap, so npm installs can't run the machine out of memory.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

# Node 22 from NodeSource.
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Caddy from its official repository.
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
fi

# The app runs as its own unprivileged user from /opt/tank-ctf (filled by deploy.sh).
id tank >/dev/null 2>&1 || sudo useradd --system --home /opt/tank-ctf --shell /usr/sbin/nologin tank
sudo mkdir -p /opt/tank-ctf
sudo chown ubuntu:ubuntu /opt/tank-ctf

sudo cp "$HERE/tank-ctf.service" /etc/systemd/system/tank-ctf.service
sudo systemctl daemon-reload
sudo systemctl enable tank-ctf

sed "s/{HOST}/$HOST/" "$HERE/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy
sudo systemctl reload-or-restart caddy

echo "Setup done. Now run deploy.sh from your machine."
