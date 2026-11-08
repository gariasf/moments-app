#!/bin/sh
# Host runs (#22): this branch's server on the Umbrel host, against the real Home, reached from the
# Mac through an SSH tunnel. In an unprivileged user namespace, all of /home/umbrel, Home included,
# is mounted read-only, with scratch folders where Moments writes (the Moments folder,
# Downloads/metube, and app data, which holds uploads), so nothing a run does can reach a real
# Source. Each branch gets its own run, port and scratch folder.
#
#   umbrel/host-run.sh start   build this branch, start its run and print its URL
#   umbrel/host-run.sh stop    stop its run, remove its scratch folder and close its tunnel
#   umbrel/host-run.sh restart [KILL]  end its server with SIGTERM (or SIGKILL) and start it again
#                              on the same folders and port, as umbrelOS restarts the app
#   umbrel/host-run.sh iphone  serve the iPhone check (#37) on the LAN from the started run, until stop
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
# The Dockerfile's intel-media-va-driver version and the gmmlib it depends on; bump with the Dockerfile.
VA_DRIVER=$CHECKS/iHD-25.2.3+dfsg1-1

on_umbrel() { ssh -o BatchMode=yes -i ~/.ssh/umbrel_moments "$@"; }
# The scratch folder of run $1. The name makes its path, so it's checked before anything there is
# written or removed.
scratch_of() {
	case $1 in '' | *[!A-Za-z0-9_-]*) echo "Not a run's name: $1 (letters, digits, - and _ only)" >&2; exit 1 ;; esac
	echo "$CHECKS/$1"
}
# SIGTERM, then SIGKILL after 10 s, as umbrelOS stops a container.
end_program() {
	pkill -x -f "$1" || true
	i=0
	while pgrep -x -f "$1" >/dev/null; do
		i=$((i + 1))
		[ $i -lt 100 ] || pkill -KILL -x -f "$1" || true
		sleep 0.1
	done
}
fetch_va_driver() {
	[ -d "$VA_DRIVER" ] && return
	download=$(mktemp -d)
	while read -r checksum package; do
		curl -fsS -o "$download/package.deb" "http://deb.debian.org/debian/pool/main/$package"
		echo "$checksum  $download/package.deb" | sha256sum -c --quiet
		dpkg-deb -x "$download/package.deb" "$download/root"
	done <<-PACKAGES
		0a4de626ba63bb6cc1365f3285aa05455030f5dcac0d0090988ba2082896d2d1 i/intel-media-driver/intel-media-va-driver_25.2.3+dfsg1-1_amd64.deb
		81b668213cb59d2bcae8c66b1184277fd0228e3648ab63f4f2b3b578da291b06 i/intel-gmmlib/libigdgmm12_22.7.2+ds1-1_amd64.deb
	PACKAGES
	mv "$download/root" "$VA_DRIVER"
	rm -rf "$download"
}
# Runs the server of the run in scratch folder $1 on port $2, once it's found free under the lock on
# fd 9, and returns once the server finds its folders as the package mounts them.
serve() {
	# All of /home/umbrel read-only, Home and the app hooks umbreld runs as root included, with the
	# scratch folders on top where Moments writes. Then the server runs from /, as uid 1000 as in
	# the container, without the rights to change the mounts. It's the first process of its own
	# PID namespace, so what it starts ends with it, as in the container.
	# ponytail: the same disk stays writable through /data and /run/rugix, which no path from Home
	# or app data leads to; make every mount read-only if a run ever needs more.
	LIBVA_DRIVER_NAME=iHD LIBVA_DRIVERS_PATH=$VA_DRIVER/usr/lib/x86_64-linux-gnu/dri LD_LIBRARY_PATH=$VA_DRIVER/usr/lib/x86_64-linux-gnu \
		MOMENTS_HOME=$HOME_DIR MOMENTS_DATA=$1/data MOMENTS_ADDR=127.0.0.1:$2 setsid \
		unshare --user --map-root-user --mount --pid --fork --kill-child sh -ec '
			mount --bind "$1/metube" "$MOMENTS_HOME/Downloads/metube"
			mount --bind "$1/Moments" "$MOMENTS_HOME/Moments"
			mount --bind "$MOMENTS_DATA" "$MOMENTS_DATA"
			mount --rbind /home/umbrel /home/umbrel
			mount -o remount,bind,ro /home/umbrel
			cd /
			exec unshare --user --map-user=1000 --map-group=1000 "$1/server"' sh "$1" \
		>>"$1/server.log" 2>&1 </dev/null 9>&- &
	# GET /api/mounts, as in CI's image check.
	want='[{"path":"","access":"read-only","want":"read-only"},{"path":"Downloads/metube","access":"writable","want":"writable"},{"path":"Moments","access":"writable","want":"writable"}]'
	i=0
	until mounts=$(curl -fsS -m 2 "http://127.0.0.1:$2/api/mounts" 2>/dev/null); do
		i=$((i + 1))
		if [ $i -gt 100 ] || ! kill -0 $! 2>/dev/null; then
			echo "The server didn't start:" >&2
			tail -n 20 "$1/server.log" >&2
			exit 1
		fi
		sleep 0.1
	done
	[ "$mounts" = "$want" ] || { kill $!; echo "Not serving: the mounts came out as $mounts" >&2; exit 1; }
}

case ${1-} in
start | stop | iphone | restart)
	cd "$(dirname "$0")/.."
	run=$(git rev-parse --abbrev-ref HEAD) # a run per branch, named after it
	scratch=$(scratch_of "$run")
	tunnel=/tmp/moments-$run.sock # the tunnel's control socket
	stop() {
		ssh -S "$tunnel" -O exit "$UMBREL" 2>/dev/null || true
		rm -f "$tunnel"
		on_umbrel "$UMBREL" sh -s on-umbrel-stop "$run" <umbrel/host-run.sh
	}
	if [ "$1" = restart ]; then
		on_umbrel "$UMBREL" sh -s on-umbrel-restart "$run" "${2:-TERM}" <umbrel/host-run.sh
		echo "Restarted $run: its server ended with SIG${2:-TERM} and runs again on the same folders."
		exit
	fi
	if [ "$1" = iphone ]; then
		check=$(mktemp)
		trap 'rm -f "$check"' EXIT
		GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$check" ./umbrel/iphone
		on_umbrel "$UMBREL" "test -d $scratch && cat >$scratch/iphone-check.new && chmod +x $scratch/iphone-check.new" <"$check" ||
			{ echo "No run of $run on the Umbrel: umbrel/host-run.sh start first" >&2; exit 1; }
		echo "Making the test Moments"
		port=$(on_umbrel "$UMBREL" sh -s on-umbrel-iphone "$run" <umbrel/host-run.sh)
		echo "iPhone check at http://umbrel.local:$port/ until umbrel/host-run.sh stop"
		echo "Its results, until stop: ssh -i ~/.ssh/umbrel_moments $UMBREL cat $scratch/iphone/results.txt"
		exit
	fi
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
	fetch_va_driver
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
	echo "$port" >"$scratch/port"
	serve "$scratch" "$port"
	echo "$port"
	;;

on-umbrel-restart)
	scratch=$(scratch_of "$2")
	case $3 in TERM | KILL) ;; *) echo "Not a way to end the server: $3 (TERM or KILL)" >&2; exit 1 ;; esac
	[ -s "$scratch/port" ] || { echo "No run of $2 on the Umbrel: umbrel/host-run.sh start first" >&2; exit 1; }
	pkill "-$3" -x -f "$scratch/server" || true
	end_program "$scratch/server"
	exec 9>/tmp/moments-check.lock
	flock 9
	serve "$scratch" "$(cat "$scratch/port")"
	;;

on-umbrel-stop)
	scratch=$(scratch_of "$2")
	end_program "$scratch/server"
	end_program "$scratch/iphone-check"
	rm -rf "$scratch"
	;;

# stdout is the port.
on-umbrel-iphone)
	scratch=$(scratch_of "$2")
	end_program "$scratch/iphone-check"
	mv -f "$scratch/iphone-check.new" "$scratch/iphone-check"
	rm -f "$scratch/iphone/port"
	setsid "$scratch/iphone-check" >"$scratch/iphone-check.log" 2>&1 </dev/null &
	until [ -s "$scratch/iphone/port" ]; do
		kill -0 $! 2>/dev/null || { echo "The iPhone check didn't start:" >&2; tail -n 20 "$scratch/iphone-check.log" >&2; exit 1; }
		sleep 0.5
	done
	cat "$scratch/iphone/port"
	;;

*)
	echo "usage: umbrel/host-run.sh start|stop|restart [KILL]|iphone" >&2
	exit 2
	;;
esac
