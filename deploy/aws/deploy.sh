#!/usr/bin/env bash
# Ships the committed code (HEAD) to the AWS game server and restarts it. Run from the repo:
#   deploy/aws/deploy.sh            update the code and restart
#   deploy/aws/deploy.sh --setup    first time only: also run setup.sh on the server
# Only committed files are sent: commit first.
set -euo pipefail
IP="15.206.64.146" # Elastic IP of tank-ctf-server (EC2, Mumbai)
HOST="15-206-64-146.sslip.io"
KEY="$HOME/.ssh/tank-ctf-aws"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "ubuntu@$IP")
cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--setup" ]]; then
  "${SSH[@]}" "mkdir -p ~/tank-ctf-setup"
  scp -i "$KEY" deploy/aws/setup.sh deploy/aws/tank-ctf.service deploy/aws/Caddyfile "ubuntu@$IP:tank-ctf-setup/"
  "${SSH[@]}" "bash ~/tank-ctf-setup/setup.sh $HOST"
fi

echo "Deploying $(git log --oneline -1)"
# Replace the code with HEAD, install what the game server needs (not the web app; dev
# dependencies included, esbuild builds it), compile it, and pick up service file changes.
scp -q -i "$KEY" deploy/aws/tank-ctf.service "ubuntu@$IP:/tmp/tank-ctf.service"
git archive --format=tar HEAD | "${SSH[@]}" "
  set -e
  cd /opt/tank-ctf
  find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  tar -x
  npm ci --workspace server --workspace shared --include-workspace-root --no-audit --no-fund
  npm run build -w server
  sudo cp /tmp/tank-ctf.service /etc/systemd/system/tank-ctf.service
  sudo systemctl daemon-reload
  sudo systemctl restart tank-ctf
  sleep 3
  systemctl is-active tank-ctf
"
curl -fsS "https://$HOST/health" >/dev/null && echo "Live: wss://$HOST"
