#!/bin/zsh
# Copy the reviewed tree of a private repo into its public mirror checkout and
# commit it with the GitHub noreply identity. Never pushes; push from the
# mirror after reviewing `git -C <mirror> show --stat`. Private-only paths are
# excluded and the outgoing tree is scanned for emails, home paths and secrets.
#   tools/publish-mirror.sh isobar|isobar-data "commit message"
set -euo pipefail
REPO="$1"; MESSAGE="$2"
SRC="$HOME/Projects/$REPO"; DST="$HOME/Projects/.isobar-public-release/$REPO"
[[ -d "$SRC/.git" && -d "$DST/.git" ]] || { echo "publish: missing $SRC or $DST" >&2; exit 1; }
[[ -z "$(git -C "$SRC" status --porcelain)" ]] || { echo "publish: $SRC has uncommitted changes" >&2; exit 1; }
EXCLUDE=(AGENTS.md CLAUDE.md .cursor docs/audit-2026-10-01.md docs/design tools/git-hooks
         tools/install-guards.sh tools/setup-notary.sh HANDOFF.md private build site/data)
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/isobar-publish.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$STAGE"
for item in $EXCLUDE; do rm -rf "$STAGE/$item"; done
if grep -rIlE '[A-Za-z0-9._%+-]+@gmail\.com|/Users/[a-z]+/|lb_[0-9a-f]{40}' "$STAGE" | grep -v '/Tests/fixtures/'; then
  echo "publish: personal data or a token in the files above" >&2; exit 1
fi
gitleaks dir "$STAGE" --no-banner -l error > /dev/null || { echo "publish: gitleaks found a secret" >&2; exit 1; }
rsync -a --delete --exclude .git "$STAGE/" "$DST/"
git -C "$DST" add -A
if git -C "$DST" diff --cached --quiet; then echo "publish: nothing to publish"; exit 0; fi
GIT_AUTHOR_NAME="Ian Todd" GIT_AUTHOR_EMAIL="128569955+todd866@users.noreply.github.com" \
GIT_COMMITTER_NAME="Ian Todd" GIT_COMMITTER_EMAIL="128569955+todd866@users.noreply.github.com" \
  git -C "$DST" commit -q -m "$MESSAGE"
git -C "$DST" show --stat --format='%h %s' HEAD | tail -5
