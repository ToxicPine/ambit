# dumbcomputer

A declarative NixOS + Home Manager container image for Fly.io. Everything is built with pure nix — no Dockerfile.

## Structure

```
system.nix        — image name, system packages, entrypoint command, background daemons
users.nix         — user accounts with UIDs and optional per-user HM overrides
home.nix          — shared Home Manager config applied to all users
fly.toml          — Fly.io deployment config
flake.nix         — wiring (you shouldn't need to touch this)
lib/image.nix     — OCI image builder (plumbing)
lib/entrypoint.sh — runtime boot script (plumbing)
```

Edit `system.nix`, `users.nix`, and `home.nix` to configure your machine. The `lib/` directory is infrastructure — you shouldn't need to modify it.

## Prerequisites

- [Nix](https://nixos.org/download/) with flakes enabled
- [Fly.io CLI](https://fly.io/docs/flyctl/install/) (`flyctl`)
- A Fly.io app and volume already created

## Build

```sh
nix build
```

This produces a gzipped OCI tarball at `./result`.

## Push to Fly Registry

Use [skopeo](https://github.com/containers/skopeo) to push directly from the nix-built tarball — no Docker daemon required:

```sh
nix-shell -p skopeo --run \
  "skopeo copy \
    --dest-creds x:$(fly auth token) \
    docker-archive:$(nix build --no-link --print-out-paths) \
    docker://registry.fly.io/$(nix eval --raw .#default.imageName 2>/dev/null || echo lazycoder):latest"
```

Or step by step:

```sh
# 1. build
nix build

# 2. push (the username is literally "x", the token is the password)
nix-shell -p skopeo --run \
  "skopeo copy \
    --dest-creds x:$(fly auth token) \
    docker-archive:./result \
    docker://registry.fly.io/lazycoder:latest"
```

## Deploy

```sh
fly deploy
```

Or with [ambit](https://www.npmjs.com/package/@cardelli/ambit) for private Tailscale networks:

```sh
npx @cardelli/ambit deploy lazycoder --network supercomputer
```

## Configuration

### system.nix

Defines what the machine does:

- `imageName` — name of the OCI image (should match your Fly app name)
- `entrypoint` — the foreground process (`command`, `user`, `port`)
- `daemons` — background processes started after Home Manager activation
- `packages` — system-level packages available to all users (these are infrastructure; user tools go in `home.nix`)

### users.nix

Declares users as an attrset. Each user needs a `uid`. Optional `home` attribute lets you add per-user Home Manager overrides:

```nix
{
  alice = {
    uid = 1000;
    home = { pkgs, ... }: {
      programs.git.userName = "Alice";
      home.packages = [ pkgs.python3 ];
    };
  };
  bob = { uid = 1001; };
}
```

### home.nix

Shared Home Manager module applied to every user. Put common tools, shell config, and program settings here. Uses stable nixpkgs by default; `pkgs-unstable` is available for packages from nixpkgs-unstable.

## How It Works

At boot, the entrypoint script:

1. Mounts an overlayfs on `/nix` (image store as lower, Fly volume as upper) so nix store changes persist across restarts
2. Starts `nix-daemon` for multi-user nix access
3. For each user: bind-mounts persistent home from `/data/homes/<user>`, copies the flake config on first boot, and runs Home Manager activation
4. Starts background daemons
5. Execs the foreground entrypoint as the configured user

Users can run `rebuild` (aliased to `home-manager switch --flake ~/.nixcfg`) inside the container to apply ad-hoc Home Manager changes. These changes persist across restarts via the overlay and bind mounts.
