#!/bin/bash
set -euo pipefail

DATA="/data"

resolve_uid() {
  jq -r --arg u "$1" '.[] | select(.name == $u) | .uid' /etc/users.json
}

run_as_user() {
  local name="$1"; shift
  local uid home user_path
  uid=$(resolve_uid "$name")
  home="/home/$name"
  user_path="$home/.nix-profile/bin:$home/.local/state/nix/profiles/home-manager/home-path/bin"

  setpriv --reuid="$uid" --regid="$uid" --init-groups \
    env HOME="$home" USER="$name" PATH="$user_path:$PATH" \
    "$@"
}

DAEMON_PIDS=()
cleanup() {
  for pid in "${DAEMON_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait
}
trap cleanup EXIT TERM INT

# Runtime-mutable but reboot-reset nix store overlay on Fly volume.
# /home remains persistent under /data/homes/*.
NIX_EPHEMERAL_ROOT="$DATA/nix-ephemeral"
NIX_UPPER="$NIX_EPHEMERAL_ROOT/upper"
NIX_WORK="$NIX_EPHEMERAL_ROOT/work"
rm -rf "$NIX_UPPER" "$NIX_WORK"
mkdir -p /nix-base "$NIX_UPPER" "$NIX_WORK"
mount --bind /nix /nix-base
mount -t overlay overlay \
  -o "lowerdir=/nix-base,upperdir=$NIX_UPPER,workdir=$NIX_WORK" \
  /nix

# Nix daemon
nix-daemon &
DAEMON_PIDS+=($!)
while [ ! -S /nix/var/nix/daemon-socket/socket ]; do sleep 0.05; done

# Per-user persistent homes and Home Manager activation
while IFS=$'\t' read -r name uid; do
  persist="$DATA/homes/$name"
  home="/home/$name"

  mkdir -p "$persist" "$home"
  chown "$uid:$uid" "$persist"

  if [ ! -d "$persist/.nixcfg" ]; then
    cp -r /etc/nixcfg "$persist/.nixcfg"
    chown -R "$uid:$uid" "$persist/.nixcfg"
  fi

  mount --bind "$persist" "$home"

  hm_gen="$home/.local/state/nix/profiles/home-manager"
  hm_profiles="$home/.local/state/nix/profiles"
  hm_gcroots="$home/.local/state/home-manager/gcroots"
  activation=$(jq -r --arg u "$name" '.[$u]' /etc/activations.json)

  run_as_user "$name" mkdir -p "$hm_profiles" "$hm_gcroots"

  if [ -L "$hm_gen" ] && [ -e "$hm_gen/activate" ]; then
    run_as_user "$name" "$hm_gen/activate" \
      || echo "Warning: Home Manager re-activation failed for $name" >&2
  elif [ -n "$activation" ] && [ "$activation" != "null" ]; then
    run_as_user "$name" "$activation/activate" \
      || echo "Warning: Home Manager initial activation failed for $name" >&2
  fi
done < <(jq -r '.[] | [.name, .uid] | @tsv' /etc/users.json)

# Application daemons
while IFS= read -r daemon; do
  readarray -t cmd < <(echo "$daemon" | jq -r '.command[]')
  daemon_user=$(echo "$daemon" | jq -r '.user // empty')

  if [ -n "$daemon_user" ]; then
    run_as_user "$daemon_user" "${cmd[@]}" &
  else
    "${cmd[@]}" &
  fi
  DAEMON_PIDS+=($!)
done < <(jq -c '.[]' /etc/daemons.json)

# Foreground entrypoint
ep_user=$(jq -r '.user' /etc/entrypoint.json)
readarray -t ep_cmd < <(jq -r '.command[]' /etc/entrypoint.json)

ep_uid=$(resolve_uid "$ep_user")
ep_home="/home/$ep_user"
ep_path="$ep_home/.nix-profile/bin:$ep_home/.local/state/nix/profiles/home-manager/home-path/bin"

cd "$ep_home"
exec setpriv --reuid="$ep_uid" --regid="$ep_uid" --init-groups \
  env HOME="$ep_home" USER="$ep_user" PATH="$ep_path:$PATH" \
  "${ep_cmd[@]}"
