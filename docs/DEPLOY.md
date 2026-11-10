# Deploying the game server (AWS EC2)

The game server runs on an AWS EC2 instance in **ap-south-1 (Mumbai)**, reached at
`wss://<ip-with-dashes>.sslip.io` (today `wss://15-206-64-146.sslip.io`). The web app is on
Vercel and finds the server through its `NEXT_PUBLIC_SERVER_URL` setting.

Why this page exists: the server runs the game 60 times a second. A t2.micro only guarantees
**10% of one CPU**; above that it spends "CPU credits", and when they run out AWS holds it at
10%. Measured in Docker: at 0.1 CPU the server stalls (hundreds of gaps over 100 ms in 30 s,
other players freeze); at 0.5 CPU it is smooth (no gaps over 100 ms). So the instance needs more
CPU than a t2.micro can promise, and the server now runs as plain compiled JavaScript (no
TypeScript compiler at runtime).

## How the live server is set up (Nov 2026)

- EC2 `tank-ctf-server`, t3.micro (unlimited credits by default for t3), Ubuntu 26.04, Mumbai,
  Elastic IP `15.206.64.146` (step 2a is done). SSH key `~/.ssh/tank-ctf-aws` on Asad's Mac;
  SSH is allowed only from his two home IPs (security group `launch-wizard-1`).
- Code lives in `/opt/tank-ctf`, runs as the `tank` user from the systemd unit in
  `deploy/aws/tank-ctf.service` (compiled `node dist/index.js`, `PUBLIC_IP` and the UDP range
  set there). Secrets (TURN keys) go in `/etc/tank-ctf.env`, never overwritten by deploys.
- Caddy terminates TLS for `15-206-64-146.sslip.io` (`deploy/aws/Caddyfile`).
- **Deploy from the Mac, not with `git pull` on the server** (the server has no GitHub access):
  `deploy/aws/deploy.sh` ships the committed HEAD, runs `npm ci` + `npm run build -w server`,
  installs the service file and restarts. A fresh server: `deploy/aws/deploy.sh --setup`.
- Steps 1-4 below are the general guide (other layouts, checking CPU credits, changing the
  instance type); step 3's security group table and step 5's checks apply as they are.

Prices change and depend on the region: check the
[EC2 pricing page](https://aws.amazon.com/ec2/pricing/on-demand/) (pick Asia Pacific (Mumbai))
before you choose. Nothing below states a price.

---

## 1. Check whether the CPU credits run out

1. Sign in to the AWS console. Top right, make sure the region says **Asia Pacific (Mumbai)**.
2. Search for **EC2** and open it. Left menu: **Instances**.
3. Tick the game server's instance. In the panel below, open the **Monitoring** tab.
4. Find these two graphs (use the time picker at the top right to show the last 1 day or 1 week,
   ideally covering a time you played):
   - **CPU credit balance** (`CPUCreditBalance`): how many credits are saved up. If it sits **at or
     near 0** (the line on the floor of the graph), the instance is being held to 10% of a CPU
     and the game will stutter, whatever the code does.
   - **CPU utilization** (`CPUUtilization`): if it is flat at about **10%** while you were playing,
     that is the throttle.
5. Tip: click the three dots on a graph > **View in metrics** to zoom in on a play session.

If the balance is healthy (far from 0) and CPU utilization stays well under 10%, the CPU isn't the
problem. If it hits 0, do step 2.

---

## 2. Change the instance type (t2.micro -> t3.small or t3.micro)

- **t3.small**: 2 vCPUs, 2 GB memory. Recommended.
- **t3.micro**: 2 vCPUs, 1 GB memory. Cheaper; also fine for one room of 8.

Both are "burstable" like t2, but t3 instances can run in **unlimited** mode: when the credits are
used up the instance keeps its full speed and AWS charges a small extra amount for the extra CPU
time instead of slowing down. For a game server that is busy only while people play, that is what
you want. (Check the pricing page for the "unlimited" surplus credit price.)

### 2a. First: give the instance a fixed IP (Elastic IP)

Stopping and starting an instance usually gives it a **new public IP**. The server's name
`15-206-64-146.sslip.io` is just the IP written with dashes, so a new IP means a new name, a new
TLS certificate and a new `NEXT_PUBLIC_SERVER_URL` on Vercel. An Elastic IP stays the same
across stop/start, so do this first:

1. EC2 left menu: **Network & Security > Elastic IPs** > **Allocate Elastic IP address** >
   leave the defaults (Amazon's pool of IPv4 addresses) > **Allocate**.
2. Tick the new address > **Actions > Associate Elastic IP address**. Resource type: **Instance**;
   pick the game server's instance; **Associate**.
3. Note the new address, e.g. `13.233.10.20`. The instance's public IP is now this address
   **right away** (the old one is gone), so the server's name changes once, to
   `13-233-10-20.sslip.io`. Do steps 2e and 2f below now.

AWS charges for public IPv4 addresses, including an Elastic IP that isn't attached to a running
instance; see the "Public IPv4 address" part of the pricing page. Release it if you ever shut the
server down for good (**Actions > Release Elastic IP addresses**).

If you'd rather not use an Elastic IP: skip 2a, change the type (2b-2d), then look up the new
public IP on the instance's **Details** tab and do 2e and 2f with it.

### 2b. Stop the instance

Instances > tick the instance > **Instance state > Stop instance** > **Stop**. Wait until
**Instance state** says **Stopped** (refresh; about a minute). Players are disconnected now.

### 2c. Change the type

1. With the instance still ticked: **Actions > Instance settings > Change instance type**.
2. Pick **t3.small** (or **t3.micro**) > **Apply** (or **Change**).
   - If t3 isn't allowed, the operating system image is too old for t3's network driver
     (ENA). Any Amazon Linux 2/2023 or Ubuntu 18.04+ image is fine; if yours is older, launch a
     new instance from a current image instead.
3. Credit mode: **Actions > Instance settings > Change credit specification**, tick
   **Unlimited** for this instance > **Save**. (t3 instances launched new default to unlimited;
   an instance converted from t2 may still say standard, so check.)

### 2d. Start it again

**Instance state > Start instance**. Wait for **Running** and **2/2 checks passed** (Status check
column, a few minutes). If the server is set up as a systemd service (step 4), it starts by itself.

### 2e. The TLS name on the server

Only if the IP changed. Whatever terminates TLS on port 443 (Caddy, nginx, ...) has the old
name in its config. For Caddy, edit `/etc/caddy/Caddyfile`:

```
13-233-10-20.sslip.io {
    reverse_proxy localhost:2567
}
```

then `sudo systemctl reload caddy`. Caddy fetches a certificate for the new name by itself
(port 80 and 443 must be open for that). For nginx with certbot: change `server_name` and run
`sudo certbot --nginx -d 13-233-10-20.sslip.io`.

### 2f. Tell the web app (Vercel)

Only if the IP changed.

1. vercel.com > the tank-ctf project > **Settings > Environment Variables**.
2. Edit `NEXT_PUBLIC_SERVER_URL` (Production) to `wss://13-233-10-20.sslip.io` > **Save**.
3. **Deployments** > the latest production deployment > **...** > **Redeploy**. A `NEXT_PUBLIC_`
   value is baked in when the site is built, so the change only takes effect after a redeploy.

---

## 3. Security group: open the ports

EC2 > Instances > tick the instance > **Security** tab > click the security group name >
**Edit inbound rules**. You should have (or add):

| Type | Protocol | Port range | Source | Why |
|---|---|---|---|---|
| HTTPS | TCP | 443 | 0.0.0.0/0 | the game (`wss://`); already there |
| HTTP | TCP | 80 | 0.0.0.0/0 | only if your TLS proxy gets certificates over HTTP (Caddy, certbot) |
| Custom UDP | UDP | 40000-40100 | 0.0.0.0/0 | the upcoming UDP game transport |
| SSH | TCP | 22 | My IP | to log in; better limited to your own IP |

**Add rule** for each missing one > **Save rules**. If the instance also runs a firewall
(`sudo ufw status` says "active"), open the same there: `sudo ufw allow 40000:40100/udp`.

---

## 4. Deploy the new build on the instance

The server now runs as compiled JavaScript: `npm run build -w server` makes
`server/dist/index.js` and `npm start -w server` runs it with plain `node`.

Log in (EC2 > instance > **Connect** > **EC2 Instance Connect** > **Connect**, or `ssh`). The
commands assume the repo is at `~/tank-ctf` and Node 22 or newer is installed (`node -v`).

```sh
cd ~/tank-ctf
git pull                    # or check out the branch you want to run
npm ci                      # installs everything, including the build tool (esbuild)
npm run build -w server     # -> server/dist/index.js
```

Secrets (TURN keys, see docs/VOICE.md) go in `~/tank-ctf/server/.env`; the server reads it at
startup.

### Run it as a service (systemd)

Stop whatever runs the server today first (a `tsx` in a terminal or tmux, `pm2 delete all`, or
`docker stop ...`), so the port is free.

Create the service file:

```sh
sudo nano /etc/systemd/system/tank-ctf.service
```

Paste this. Change `User` and the paths if your login isn't `ubuntu` (on Amazon Linux it is
`ec2-user`, so `/home/ec2-user/tank-ctf`), and the `node` path to the output of `which node`
(e.g. `/home/ubuntu/.nvm/versions/node/v22.22.0/bin/node` if you installed Node with nvm):

```ini
[Unit]
Description=Tank CTF game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/tank-ctf/server
# Secrets (TURN keys). The "-" means: fine if the file doesn't exist.
EnvironmentFile=-/home/ubuntu/tank-ctf/server/.env
Environment=NODE_ENV=production
Environment=PORT=2567
ExecStart=/usr/bin/node --enable-source-maps dist/index.js
Restart=always
RestartSec=2
# Plenty for one small game server; stops a runaway from taking the whole machine.
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Save (Ctrl+O, Enter, Ctrl+X), then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tank-ctf     # starts now and on every boot
systemctl status tank-ctf                # should say "active (running)"
journalctl -u tank-ctf -f                # live logs (Ctrl+C to leave)
```

`PORT` must match what your TLS proxy forwards to (`reverse_proxy localhost:2567` above).

Next time you deploy:

```sh
cd ~/tank-ctf && git pull && npm ci && npm run build -w server && sudo systemctl restart tank-ctf
```

(Restarting ends running matches: deploy when nobody is playing.)

pm2 works too if you prefer it: `pm2 start npm --name tank-ctf -- start -w server`, then
`pm2 save` and `pm2 startup` (run the line it prints). Use one or the other, not both.

---

## 5. Check that it works

From your laptop (use your server's name):

```sh
curl https://15-206-64-146.sslip.io/health
```

should print `{"ok":true}`.

Then a short load test from the repo on your laptop (4 bots play for 15 s on the real server):

```sh
SERVER_URL=wss://15-206-64-146.sslip.io PLAYERS=4 SECONDS=15 npm run loadtest -w server
```

What good looks like:

| Line | Good | Bad (server starved of CPU) |
|---|---|---|
| `Server ticks:` | 60.0 per second | below 60, or a wide range |
| `Snapshots:` | about 30 per second per player | well below 30 |
| `Snapshot gaps:` | median about 33 ms, p99 under about 60-80 ms | p99 in the hundreds |
| `Gaps > 100 / 200 ms:` | 0 / 0, or a handful (your own Wi-Fi) | dozens or hundreds |
| `Deltas that failed:` and `Same game for all:` | 0 and 0 differed | anything else is a bug: tell us |

Gaps measured from a laptop include your internet connection, so a few 100 ms gaps on Wi-Fi are
normal; hundreds are not. For the server's own view, run the same test on the instance itself
against `ws://localhost:2567`: there should be no gaps over 100 ms at all.

While the test runs you can watch the CPU on the instance with `top` (press `q` to leave): the
`node` process should use well under half a CPU for one room.

`npm run smoke -w server` (with `SERVER_URL=wss://...`) runs the end-to-end check (lobby, match,
reconnect, voice relay rules) against the deployed server; it should print a line starting
with `smoke ok:` and no assertion error. It plays a short match in a room of its own.

---

## Notes

- **Node flags.** The service runs `node --enable-source-maps dist/index.js`: source maps make
  crash logs point at the `.ts` lines. GC tuning flags were tried and not kept: with 8 bots
  firing heavily the server does about 3-4 minor GCs a second of under 2 ms each (largest 1.7 ms)
  and the heap stays around 25 MB, so `--max-semi-space-size` made no measurable difference. The
  stalls on a throttled t2.micro come from the CPU cap, not from garbage collection.
- **Compiled vs tsx.** Same game; the compiled server starts faster and doesn't load the
  TypeScript compiler at runtime (measured locally, 8 bots for 10 s: 89 MB vs 94 MB memory and
  1.4 s vs 1.7 s CPU including startup). For development keep using `npm run dev -w server`
  (restarts on every change).
- **Render** still works with `render.yaml` (build `npm ci && npm run build -w server`, start
  `npm start -w server`), but the free plan's tenth of a CPU stalls the game, as above.

## UDP ports (game channel)

Inputs and snapshots go over a UDP channel (WebRTC data channel) when a browser can open one,
and over the WebSocket otherwise (see docs/NETCODE.md, "UDP game channel"). For it to work on
the instance:

- **Security group:** inbound **UDP 40000-40100** from 0.0.0.0/0 (the row in step 3). Without it
  the game still works, everyone just stays on the WebSocket (5 s after joining).
- **Env** (in `server/.env` or the systemd unit), all optional:
  - `UDP_PORT_MIN=40000`, `UDP_PORT_MAX=40100`: the range to open (one port per connected
    player is used; change both here and in the security group if you change it).
  - `PUBLIC_IP=<the Elastic IP>`: recommended on EC2. The server finds its public address with
    STUN (`stun:stun.l.google.com:19302`, override with `UDP_STUN`, `off` to skip) and this is
    the fallback if STUN is blocked.
  - `UDP_OFF=1` turns the channel off (everyone on the WebSocket).
  - `UDP_LOSS`, `UDP_DELAY_MS`, `UDP_JITTER_MS` are for testing only; never set them in production.
- `node-datachannel` is a native module: `npm ci` on the instance installs its prebuilt binary
  (Linux x64/arm64). If it fails to load, the log says `udp: node-datachannel unavailable` and
  the game stays on the WebSocket.
- Check: in the browser console (dev build) `__net.transport` is `"udp"`, or run
  `SERVER_URL=wss://... TRANSPORT=udp npm run smoke -w server` from a laptop.
