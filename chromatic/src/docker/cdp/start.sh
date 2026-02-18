#!/bin/sh
echo "CDP: Starting Chrome Headless"

PROXY_ARGS=""
if [ -n "$ROUTER_PROXY" ]; then
  echo "CDP: Using proxy ${ROUTER_PROXY}"
  PROXY_ARGS="--proxy-server=${ROUTER_PROXY}"
fi

# Bind to 0.0.0.0 for Flycast compatibility (Fly Proxy handles IPv6 translation)
exec chromium-browser \
  --headless \
  --disable-gpu \
  --no-sandbox \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  ${PROXY_ARGS} \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --disable-background-networking \
  --disable-default-apps \
  --disable-extensions \
  --disable-sync \
  --disable-translate \
  --mute-audio \
  --no-first-run \
  --safebrowsing-disable-auto-update \
  --hide-scrollbars \
  --metrics-recording-only \
  --no-zygote \
  --single-process
