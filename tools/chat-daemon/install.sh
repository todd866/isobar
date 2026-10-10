#!/bin/zsh
set -euo pipefail
if [[ $# -ne 1 || "$1" != "--install" ]]; then
  echo "usage: $0 --install" >&2
  exit 2
fi
umask 077
repo="$(cd "$(dirname "$0")/../.." && pwd)"
# Render with an XML parser, not sed: spaces, ampersands and quotes stay valid.
# This copies the LaunchAgent only. It does not bootstrap or start a daemon.
/usr/bin/python3 - "$repo" <<'PY'
import pathlib, plistlib, sys
repo = pathlib.Path(sys.argv[1])
home = pathlib.Path.home()
state = home / '.local/state/isobar-chat-daemon'
state.mkdir(parents=True, exist_ok=True, mode=0o700)
state.chmod(0o700)
with (repo / 'tools/chat-daemon/md.isobar.chat-daemon.plist').open('rb') as stream:
    plist = plistlib.load(stream)
def render(value):
    if isinstance(value, str):
        return value.replace('__ISOBAR_REPO__', str(repo)).replace('__ISOBAR_HOME__', str(home))
    if isinstance(value, list): return [render(v) for v in value]
    if isinstance(value, dict): return {k: render(v) for k, v in value.items()}
    return value
agents = home / 'Library/LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
target = agents / 'md.isobar.chat-daemon.plist'
with target.open('wb') as stream:
    plistlib.dump(render(plist), stream)
target.chmod(0o600)
print('LaunchAgent copied; not started.')
PY
