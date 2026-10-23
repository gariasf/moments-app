#!/bin/sh
# Host runs (#22): this branch's server on the Umbrel host, against the real Home, reached from the
# Mac through an SSH tunnel. In an unprivileged user namespace, all of /home/umbrel, Home included,
# is mounted read-only, with scratch folders where Moments writes (the Moments folder,
# Downloads/metube, and app data, which holds uploads), so nothing a run does can reach a real
# Source. Each branch gets its own run, port and scratch folder.
#
#   umbrel/host-run.sh start   build this branch, start its run and print its URL
#   umbrel/host-run.sh stop    stop its run, remove its scratch folder and close its tunnel
#
# The test set is about ten real Sources, one per line in $CHECKS/test-set.tsv on the Umbrel: a
# path in Home, a tab, and the traits it covers. Their paths stay out of the repo (#22). Together
# they cover MKV and MP4, HEVC tagged hev1, H.264 High 10, Dolby Vision 8.1, DTS and TrueHD,
# several audio tracks, 11 s keyframe gaps and x265 open GOP, plus two MeTube downloads, VP9 and
# AV1, that each run makes with ffmpeg until the owner downloads real ones. start reports a Source
# that has gone missing, to be replaced by one with the same traits.
set -eu

UMBREL=umbrel@umbrel.local
# Agents write only here and in /tmp on the Umbrel (docs/agents/workflow.md, The Umbrel).
CHECKS=/home/umbrel/moments-check
HOME_DIR=/home/umbrel/umbrel/home

on_umbrel() { ssh -o BatchMode=yes -i ~/.ssh/umbrel_moments "$@"; }
# The scratch folder of run $1. The name makes its path, so it's checked before anything there is
# written or removed.
scratch_of() {
	case $1 in '' | *[!A-Za-z0-9_-]*) echo "Not a run's name: $1 (letters, digits, - and _ only)" >&2; exit 1 ;; esac
	echo "$CHECKS/$1"
}

case ${1-} in
start | stop)
	cd "$(dirname "$0")/.."
	run=$(git rev-parse --abbrev-ref HEAD) # a run per branch, named after it
	scratch=$(scratch_of "$run")
	tunnel=/tmp/moments-$run.sock # the tunnel's control socket
	stop() {
		ssh -S "$tunnel" -O exit "$UMBREL" 2>/dev/null || true
		rm -f "$tunnel"
		on_umbrel "$UMBREL" sh -s on-umbrel-stop "$run" <umbrel/host-run.sh
	}
	stop
	if [ "$1" = stop ]; then
		echo "Stopped $run: its scratch folder is removed and its tunnel closed."
		exit
	fi
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	echo "Building $run for the Umbrel"
	{ (cd web && npm run build) && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$tmp/server" .; } >"$tmp/log" 2>&1 ||
		{ tail -n 25 "$tmp/log"; exit 1; }
	on_umbrel "$UMBREL" "mkdir -p $scratch && cat >$scratch/server && chmod +x $scratch/server" <"$tmp/server"
	# The tunnel goes to the background with its output in a file, so a caller reading this
	# script's output through a pipe isn't kept waiting on it.
	if ! port=$(on_umbrel "$UMBREL" sh -s on-umbrel-start "$run" <umbrel/host-run.sh) ||
		! on_umbrel -fNM -S "$tunnel" -o ExitOnForwardFailure=yes -L "$port:127.0.0.1:$port" "$UMBREL" >/dev/null 2>"$tmp/tunnel"; then
		cat "$tmp/tunnel" >&2 2>/dev/null || true
		stop
		exit 1
	fi
	echo "Running $run at http://localhost:$port/"
	;;

# The rest runs on the Umbrel, from start and stop. Messages go to stderr; start's stdout is the port.
on-umbrel-start)
	scratch=$(scratch_of "$2")
	mkdir -p "$scratch/Moments" "$scratch/metube" "$scratch/data"
	# 90 s with a keyframe every 5 s, as YouTube's: longer than the Trimmer streams ahead, so the
	# Trimmer check's seeks to 60% and 30% can need streams of their own.
	stand_in() { SVT_LOG=1 ffmpeg -nostdin -v error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine -t 90 -g 150 -c:a libopus "$@"; }
	stand_in -c:v libvpx-vp9 -deadline realtime -cpu-used 8 "$scratch/metube/Stand-in VP9.webm"
	stand_in -c:v libsvtav1 -preset 12 "$scratch/metube/Stand-in AV1.webm"
	# Each Source as this run sees it. Its Downloads/metube is scratch, so the test set's real
	# MeTube downloads are copied in.
	n=0 missing=0
	while IFS=$(printf '\t') read -r path traits || [ -n "$path" ]; do
		case $path in
		'' | '#'*) continue ;;
		Downloads/metube/*)
			file=$scratch/metube/${path#Downloads/metube/}
			[ -e "$file" ] || [ ! -e "$HOME_DIR/$path" ] || cp "$HOME_DIR/$path" "$file"
			;;
		*) file=$HOME_DIR/$path ;;
		esac
		n=$((n + 1))
		[ -e "$file" ] || { echo "Missing from the test set: $path ($traits)" >&2; missing=$((missing + 1)); }
	done <"$CHECKS/test-set.tsv"
	echo "Test set: $n Sources, $missing missing" >&2
	# The first free port, under a lock held until the server listens on it.
	exec 9>/tmp/moments-check.lock
	flock 9
	port=18700
	while ss -Hltn "sport = :$port" | grep -q .; do
		[ "$port" -lt 18799 ] || { echo "No free port in 18700-18799" >&2; exit 1; }
		port=$((port + 1))
	done
	# All of /home/umbrel read-only, Home and the app hooks umbreld runs as root included, with the
	# scratch folders on top where Moments writes. Then the server runs from /, as uid 1000 as in
	# the container, without the rights to change the mounts.
	# ponytail: the same disk stays writable through /data and /run/rugix, which no path from Home
	# or app data leads to; make every mount read-only if a run ever needs more.
	MOMENTS_HOME=$HOME_DIR MOMENTS_DATA=$scratch/data MOMENTS_ADDR=127.0.0.1:$port setsid \
		unshare --user --map-root-user --mount sh -ec '
			mount --bind "$1/metube" "$MOMENTS_HOME/Downloads/metube"
			mount --bind "$1/Moments" "$MOMENTS_HOME/Moments"
			mount --bind "$MOMENTS_DATA" "$MOMENTS_DATA"
			mount --rbind /home/umbrel /home/umbrel
			mount -o remount,bind,ro /home/umbrel
			cd /
			exec unshare --user --map-user=1000 --map-group=1000 "$1/server"' sh "$scratch" \
		>"$scratch/server.log" 2>&1 </dev/null 9>&- &
	# start hands the run over only once the server finds its folders as the package mounts them:
	# GET /api/mounts, as in CI's image check.
	want='[{"path":"","access":"read-only","want":"read-only"},{"path":"Downloads/metube","access":"writable","want":"writable"},{"path":"Moments","access":"writable","want":"writable"}]'
	i=0
	until mounts=$(curl -fsS -m 2 "http://127.0.0.1:$port/api/mounts" 2>/dev/null); do
		i=$((i + 1))
		if [ $i -gt 100 ] || ! kill -0 $! 2>/dev/null; then
			echo "The server didn't start:" >&2
			tail -n 20 "$scratch/server.log" >&2
			exit 1
		fi
		sleep 0.1
	done
	[ "$mounts" = "$want" ] || { kill $!; echo "Not serving: the mounts came out as $mounts" >&2; exit 1; }
	echo "$port"
	;;

on-umbrel-stop)
	scratch=$(scratch_of "$2")
	# SIGTERM, then SIGKILL after 10 s, as umbrelOS stops a container.
	pkill -x -f "$scratch/server" || true
	i=0
	while pgrep -x -f "$scratch/server" >/dev/null; do
		i=$((i + 1))
		[ $i -lt 100 ] || pkill -KILL -x -f "$scratch/server" || true
		sleep 0.1
	done
	rm -rf "$scratch"
	;;

*)
	echo "usage: umbrel/host-run.sh start|stop" >&2
	exit 2
	;;
esac
