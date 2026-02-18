# Railpack Source Deploy Support

WARNING: Claude-generated suggestions, yet to be reviewed.

## Problem

`ambit deploy` currently has two modes:

1. **Config Mode** — user has a `fly.toml`, Fly's remote builder handles the
   rest
2. **Image Mode** — user has a pre-built Docker image

Both assume the user has already containerized their app. Many users have bare
source code and no Dockerfile. Today they have to write one themselves or use
Fly's Dockerfile detection, which is limited.

[Railpack](https://github.com/railwayapp/railpack) is a zero-config builder that
detects 13+ languages (including Deno, Node, Python, Go, Rust) and produces OCI
images via BuildKit. It could power a third mode: **source deploy**.

```
ambit deploy my-app --network browsers --source ./my-project
```

## Why Not Just Use Fly's Builders?

Fly's remote builder expects a Dockerfile or a supported buildpack. It does have
a `--nixpacks` flag and `--buildkit` mode, but:

- No Railpack frontend support — Fly's builder runs its own BuildKit pipeline,
  you can't swap in a custom frontend
- Buildpacks are limited — Fly supports Paketo and Heroku buildpacks, but
  Railpack's detection is broader and produces leaner images
- `fly deploy --dockerfile` requires a Dockerfile to exist — which is exactly
  what Railpack eliminates

The gap: Fly's builder won't accept a `railpack-plan.json` as input. We need our
own BuildKit to run the Railpack frontend.

## Architecture: Fly Machine as Ephemeral Builder

Railpack splits into two phases:

1. **`railpack prepare`** — local-only, no BuildKit needed. Analyzes source,
   detects language, outputs `railpack-plan.json` + `railpack-info.json`
2. **BuildKit frontend** — takes the plan + source context, produces an OCI
   image. This is where BuildKit is required.

We spawn a Fly machine running BuildKit, use it as the remote builder, then tear
it down.

```
User's machine                          Fly.io
─────────────                          ──────

1. railpack prepare ./src
   → railpack-plan.json

2. fly machines run buildkit-image      → Builder machine starts
   on target network                      (auto-stop enabled)

3. buildctl --addr tcp://builder:1234   → Sends plan + source context
   --frontend=gateway.v0                  to BuildKit on Fly
   --opt source=railpack-frontend
   --output type=image,name=registry.fly.io/<app>:latest

4. fly deploy --image registry.fly.io/<app>:latest
   --no-public-ips --flycast            → Standard safe deploy

5. Builder auto-stops (or explicit destroy)
```

### Key Insight: Fly's Internal Registry Mirror

Fly's new BuildKit-based builder architecture includes a local registry mirror
at `_api.internal:5000`. A builder machine on the same network can push images
directly to the host's containerd service, bypassing the global
`registry.fly.io` round-trip. This is the same mechanism Fly's own `--buildkit`
builder uses.

If we can leverage this, step 3 becomes a fast local push instead of an internet
round-trip through the registry.

### Builder Machine Lifecycle

The builder is an ephemeral Fly machine:

- **Image**: `moby/buildkit` (or a custom image with `railpack-frontend` baked
  in)
- **Auto-stop**: enabled, so it stops after idle timeout — no ongoing cost
- **Network**: deployed to the same org, can be on default network (doesn't need
  to be on the ambit custom 6PN)
- **Reuse**: once created, subsequent builds reuse the same stopped machine
  (warm cache). Only the first build pays the cold-start cost.
- **Region**: same region as the target app for fastest context transfer

### Connecting to the Builder

Two options for reaching the BuildKit daemon:

**Option A: Flycast (preferred)** Builder gets a Flycast IP. The user's machine
reaches it through the ambit router's tailnet bridge. `buildctl` connects via
`tcp://[flycast-ip]:1234`. This works because the user already has ambit set up
— they're on the tailnet.

**Option B: WireGuard tunnel** `fly proxy` or `fly wireguard` to forward a local
port to the builder's private IP. More setup, but doesn't require an ambit
router for the builder's network.

Option A is the natural fit — ambit users already have tailnet connectivity.

## Implementation Plan

### Phase 1: Builder Management

New FlyProvider methods:

```typescript
interface FlyProvider {
  // Existing...

  // Builder lifecycle
  ensureBuilder(org: string, region?: string): Promise<BuilderInfo>;
  destroyBuilder(org: string): Promise<void>;
}

interface BuilderInfo {
  appName: string; // e.g. "ambit-builder-<org>"
  machineId: string;
  address: string; // Flycast or private_v6
  port: number; // BuildKit GRPC port
}
```

`ensureBuilder` is idempotent:

1. Check if `ambit-builder-<org>` app exists
2. If not, create it + deploy BuildKit image
3. If exists but stopped, start the machine
4. Return connection info

### Phase 2: Railpack Integration

New module `ambit/src/railpack.ts`:

```typescript
interface RailpackProvider {
  ensureInstalled(): Promise<void>;
  prepare(sourceDir: string, options?: {
    env?: Record<string, string>;
  }): Promise<PrepareResult>;
}

interface PrepareResult {
  planPath: string; // path to railpack-plan.json
  infoPath: string; // path to railpack-info.json
  info: {
    provider: string; // detected language/framework
    versions: Record<string, string>;
  };
}
```

### Phase 3: Build Orchestration

New module `ambit/src/build.ts`:

```typescript
async function remoteBuild(options: {
  fly: FlyProvider;
  org: string;
  app: string;
  sourceDir: string;
  planPath: string;
  region?: string;
}): Promise<string>; // returns image ref
```

This:

1. Calls `ensureBuilder` to get a running BuildKit machine
2. Runs `buildctl` pointing at the remote builder
3. Pushes the image to `registry.fly.io/<app>:<tag>`
4. Returns the image reference

### Phase 4: Deploy Command Integration

Add `--source` flag to `ambit deploy`:

```
ambit deploy <app> --network <net> --source ./my-project
```

The flow becomes:

1. `railpack prepare` locally
2. `remoteBuild` via Fly machine
3. `deploySafe` with the produced image ref
4. `auditDeploy` as usual

Three modes, mutually exclusive:

- `--config` / auto-detected `fly.toml` → config mode
- `--image` → image mode
- `--source` → source mode (Railpack)

## Dependencies

| Dependency                | Where              | Required                 |
| ------------------------- | ------------------ | ------------------------ |
| `railpack` CLI            | User's machine     | Only for `--source` mode |
| `buildctl`                | User's machine     | Only for `--source` mode |
| BuildKit image            | Fly machine        | Managed by ambit         |
| `railpack-frontend` image | Pulled by BuildKit | Automatic                |

Both `railpack` and `buildctl` are single static binaries. We could auto-install
them (like Fly does with its own CLI) or just check and error with install
instructions.

## Open Questions

1. **Registry auth for the builder machine.** BuildKit on the Fly machine needs
   write access to `registry.fly.io/<app>`. Can we pass the user's Fly token as
   a registry credential? Or does the internal mirror (`_api.internal:5000`)
   bypass auth entirely for machines in the same org?

2. **Build context transfer.** `buildctl` sends the full source directory to the
   remote BuildKit. For large projects this could be slow over tailnet.
   Alternative: upload source to a Fly volume, mount it into the builder. More
   complex but faster for big repos.

3. **Cache persistence.** BuildKit caches layers in its local storage. If the
   builder machine is destroyed, cache is lost. Using a Fly volume for
   `/var/lib/buildkit` would preserve cache across builds. Worth it for repeated
   deploys.

4. **Railpack version pinning.** The `railpack prepare` CLI version must match
   the BuildKit frontend image version. We should pin both and update them
   together.

5. **Multi-arch.** Railpack + BuildKit support
   `--platform linux/amd64,linux/arm64`. Fly machines are amd64 today but arm64
   is coming. Worth supporting from the start?

## Cost

The builder machine only runs during builds (auto-stop). A `shared-cpu-2x` (2
vCPU, 2GB RAM) is ~$0.02/hr. A typical build takes 1-5 minutes. Cost per build:
< $0.01.

No ongoing cost when idle — the machine is stopped.

## Alternative Considered: Local BuildKit

Instead of a Fly machine, require Docker/BuildKit locally. Rejected because:

- Heavy local dependency (Docker Desktop or standalone BuildKit)
- Doesn't work in CI without Docker-in-Docker
- Slower for Fly deploys — image must push to registry.fly.io over internet
- The Fly machine approach keeps builds close to the deployment target
