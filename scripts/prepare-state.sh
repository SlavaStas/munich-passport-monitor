#!/usr/bin/env bash
set -euo pipefail
: "${STATE_DIR:?STATE_DIR is required}"
branch=monitor-state
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
# A failed remote lookup must abort. Only a successful empty result means a fresh repo.
ref=$(git ls-remote --heads origin "refs/heads/$branch")
if [[ -n "$ref" ]]; then
  git fetch --depth=1 origin "refs/heads/$branch"
  git worktree add -b "$branch" "$STATE_DIR" FETCH_HEAD
  test -s "$STATE_DIR/state.json"
else
  git worktree add --detach "$STATE_DIR" HEAD
  git -C "$STATE_DIR" switch --orphan "$branch"
  echo '{"version":1,"notified":[],"failures":0,"lastDiagnostic":0}' > "$STATE_DIR/state.json"
  git -C "$STATE_DIR" add state.json
  git -C "$STATE_DIR" commit -m 'Initialize monitor state'
  git -C "$STATE_DIR" push origin "HEAD:refs/heads/$branch"
fi
