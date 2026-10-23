#!/bin/sh
# Release snapshots (#52): the public repo, gariasf/moments-app, gets one commit per release,
# holding that release's files and nothing else. This commits the tree of <ref> on top of the
# public main, with a message naming the version, and pushes that commit.
#
#   ./snapshot.sh v0.3.0         a release's tag
#   ./snapshot.sh origin/main    unreleased work, after a git fetch
#
# Never add the public repo as a remote of a clone of this repo, and push nothing there but a
# snapshot to its main: any other push sends this repo's history. No tags either: release.yml
# would run on them there.
set -eu

[ $# -eq 1 ] || { echo "usage: ./snapshot.sh <ref>" >&2; exit 2; }
ref=$1
url=https://github.com/gariasf/moments-app.git
cd "$(dirname "$0")"

# Trees from before #52, v0.2.0's included, have no LICENSE, and their fixtures name commercial
# titles.
git cat-file -e "$ref:LICENSE" 2>/dev/null || { echo "$ref has no LICENSE: it predates the snapshots (#52)" >&2; exit 1; }

# A release's tag names its version. A branch holds unreleased work after the latest release,
# found by version, since its tag sits on a squashed PR's head, outside main's history.
if tag=$(git describe --tags --exact-match --match 'v*' "$ref" 2>/dev/null); then
	message="Moments $tag"
else
	latest=$(git for-each-ref --count=1 --sort=-version:refname --format='%(refname:short)' 'refs/tags/v*')
	message="Moments: unreleased work after $latest"
fi
# On top of the public main, fetched by URL; the first snapshot has no parent. Were the fetch to
# fail with a main there, the push below would be refused, as it isn't forced.
parent=$(git fetch --quiet "$url" refs/heads/main 2>/dev/null && git rev-parse FETCH_HEAD) || parent=
[ -n "$parent" ] || echo "No main fetched from $url: a first snapshot, with no parent" >&2
snapshot=$(git commit-tree "$ref^{tree}" ${parent:+-p "$parent"} -m "$message")
git push "$url" "$snapshot:refs/heads/main"
echo "Published $message: ${url%.git}/commit/$snapshot"
