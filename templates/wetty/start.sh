#!/bin/sh
set -e

# Initialize home directory if volume is empty (first boot)
if [ ! -f /home/user/.bashrc ]; then
  cp -a /etc/skel-user/. /home/user/
fi
chown user:user /home/user

# Start wetty in foreground with direct shell (no SSH, no password)
exec node /opt/wetty/build/main.js \
  --port 3000 \
  --host 0.0.0.0 \
  --command "login -f user" \
  --base / \
  --title superwet.computer
