#!/usr/bin/env bash
# Task 006 (bugfix JS cursor pagination).
#
# Creates the fix branch, runs the test suite and commits the changes.
# Usage: bash scripts/branch-and-commit.sh [branch-name]
#
# The five fixed reports are:
#   1) cursor filter now ties on (createdAt, id)
#   2) nextCursor === null iff no rows remain after the page
#   3) parseLimit rejects malformed / out-of-range limits
#   4) decodeCursor rejects broken cursors with InvalidCursorError
#   5) paginate no longer mutates the input array
set -euo pipefail

BRANCH="${1:-fix/cursor-pagination}"
MESSAGE="${MESSAGE:-fix(cursor-pagination): correct cursor tiebreak, nextCursor, limit/cursor validation}"

cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git switch "${BRANCH}"
else
  git switch --create "${BRANCH}"
fi

# Record the test result before committing (must be green).
npm test | tee /tmp/cursor-pagination-npm-test.log

git add package.json src/paginate.js src/server.js test/paginate.test.js test/server.test.js
git commit -m "${MESSAGE}"

echo "branch: $(git rev-parse --abbrev-ref HEAD)"
echo "commit: $(git rev-parse --short HEAD)"
