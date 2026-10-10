#!/bin/zsh
set -euo pipefail
umask 077
export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
state="$HOME/.local/state/isobar-chat-daemon"
mkdir -p "$state"
chmod 700 "$state"
cd "$repo"
# Keep status-only logs bounded. Launchd owns one process for this label.
if [[ -f "$state/daemon.log" ]] && (( $(stat -f%z "$state/daemon.log") > 1048576 )); then
  mv -f "$state/daemon.log" "$state/daemon.previous.log"
fi
exec >>"$state/daemon.log" 2>&1
exec /usr/bin/nice -n 10 "$repo/web/node_modules/.bin/tsx" "$repo/tools/chat-daemon/daemon.ts"
