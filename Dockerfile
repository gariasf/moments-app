# Base images are pinned by digest and Debian packages by version. Bumps happen
# when the owner asks, or when Debian replaces a pinned package and this fails.

FROM node:24.16.0@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7 AS ui
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
RUN npm run build

FROM golang:1.27.3@sha256:f20d83a83e18dbd2a4714b8ffd4b30b287b6243962dd75608e86abcc63ba4efc AS server
WORKDIR /src
COPY go.mod *.go ./
COPY --from=ui /src/web/dist web/dist
RUN CGO_ENABLED=0 go build -o /moments .

# The server's tests on the Mac, which has no FFmpeg (CLAUDE.md), with the
# Debian and FFmpeg CI's tests run on. Built only when asked for by name.
FROM golang:1.27.3@sha256:f20d83a83e18dbd2a4714b8ffd4b30b287b6243962dd75608e86abcc63ba4efc AS test
RUN apt-get update -qq \
	&& apt-get install -qq -y --no-install-recommends ffmpeg=7:7.1.5-0+deb13u1 >/dev/null \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src

# The Debian and FFmpeg that CI's tests run on (ci.yml), and Intel's free VA-API
# driver for the GPU.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
RUN apt-get update -qq \
	&& apt-get install -qq -y --no-install-recommends ffmpeg=7:7.1.5-0+deb13u1 intel-media-va-driver=25.2.3+dfsg1-1 >/dev/null \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=server /moments /usr/local/bin/moments
# Files' user, so what Moments writes in Home stays editable from Files.
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/moments"]
