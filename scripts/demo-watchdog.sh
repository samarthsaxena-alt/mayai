#!/bin/bash
# Keeps the MayAI demo backend + public tunnel alive during a demo window.
# Restarts either half if it dies, and always writes the CURRENT tunnel URL
# to tunnel-url.txt so it's easy to check whether it changed.
#
# Uses an authenticated ngrok tunnel (bin/ngrok) bound to a free static
# domain (from-stagnate-ruby.ngrok-free.dev) - NOT localtunnel or
# cloudflared's anonymous quick tunnel. Both of those got this machine's IP
# rate-limited/blocked after repeated restarts during earlier iteration
# (localtunnel.me: 403 Forbidden; Cloudflare quick tunnel: 429 Too Many
# Requests, error 1015). An authenticated ngrok account isn't subject to the
# same anonymous-IP limiting, and the static domain means the URL never
# changes on restart - no more re-publishing the artifact after every
# tunnel bounce.
#
# Usage: ./scripts/demo-watchdog.sh   (run from the open-receptionist repo root,
# or anywhere - it cd's to its own directory first)
#
# Stop with Ctrl+C, or `pkill -f demo-watchdog.sh`.

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
LOG_DIR="/tmp/mayai-demo"
NGROK="$REPO_DIR/bin/ngrok"
STATIC_DOMAIN="from-stagnate-ruby.ngrok-free.dev"
mkdir -p "$LOG_DIR"

echo "[watchdog] repo: $REPO_DIR"
echo "[watchdog] logs: $LOG_DIR"
echo "[watchdog] static domain: $STATIC_DOMAIN"

# Matched against the FULL command line (pgrep -f). Verified against the
# actual running process before relying on it - a past version of this
# script used a pattern that silently never matched anything, which caused
# runaway process spawning. Don't change this without testing
# `pgrep -f "$TUNNEL_PATTERN"` against a real running instance first.
TUNNEL_PATTERN="ngrok http --url=$STATIC_DOMAIN"

is_running() { pgrep -f "$1" > /dev/null 2>&1; }

kill_tunnel() {
  pkill -f "$TUNNEL_PATTERN" 2>/dev/null
  sleep 1
}

start_backend() {
  echo "[watchdog] starting backend..."
  (cd "$REPO_DIR" && nohup npm start > "$LOG_DIR/server.log" 2>&1 &)
  sleep 2
}

start_tunnel() {
  # Defensive: always kill any existing tunnel process before starting a new
  # one, regardless of what is_running thought - this is what actually
  # prevents a runaway-process bug from recurring even if detection is wrong.
  kill_tunnel
  echo "[watchdog] starting tunnel..."
  echo "https://$STATIC_DOMAIN" > "$LOG_DIR/tunnel-url.txt"
  (nohup "$NGROK" http --url="$STATIC_DOMAIN" 8080 > "$LOG_DIR/tunnel.log" 2>&1 &)
  for i in $(seq 1 15); do
    if curl -s -m 5 "https://$STATIC_DOMAIN/api/health" > /dev/null 2>&1; then
      echo "[watchdog] tunnel up: https://$STATIC_DOMAIN"
      return 0
    fi
    sleep 1
  done
  echo "[watchdog] tunnel did not come up in time"
  return 1
}

while true; do
  if ! curl -s -m 5 http://localhost:8080/api/health > /dev/null 2>&1; then
    echo "[watchdog] $(date '+%H:%M:%S') backend down, restarting"
    pkill -f "node --env-file=.env server.js" 2>/dev/null
    start_backend
  fi

  if ! is_running "$TUNNEL_PATTERN"; then
    echo "[watchdog] $(date '+%H:%M:%S') tunnel down, restarting"
    start_tunnel
  elif ! curl -s -m 8 "https://$STATIC_DOMAIN/api/health" > /dev/null 2>&1; then
    echo "[watchdog] $(date '+%H:%M:%S') tunnel URL unresponsive, restarting tunnel"
    start_tunnel
  fi

  sleep 15
done
