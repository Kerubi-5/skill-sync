#!/bin/sh
set -e

# The mounted repo is almost never owned by this container's UID — avoid
# git's "detected dubious ownership" refusal rather than make every caller
# work around it themselves.
git config --global --add safe.directory '*'

git config --global user.name "${SKILL_SYNC_GIT_NAME:-skill-sync-bot}"
git config --global user.email "${SKILL_SYNC_GIT_EMAIL:-skill-sync-bot@users.noreply.github.com}"

# `gh repo clone`/`gh pr create` pick up GH_TOKEN on their own, but plain
# `git push`/`git pull` don't — wire a credential helper so they do too.
gh auth setup-git

exec node /app/bin/skill-sync.mjs "$@"
