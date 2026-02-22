# Ambit

Ambit lets you deploy apps (databases, internal tools, dashboards) that live in the cloud but are completely inaccessible to strangers. For example: you build something on your laptop and want to reach it from your phone. With Ambit, that just works: a random person on the internet cannot access it, but any device you own can.

## The Problem

Putting a database or dashboard on the public internet forces you to build login pages, configure firewalls, and worry about bots scanning your IP. Even when you do it right, you've spent hours on plumbing that has nothing to do with what you were actually trying to build.

## The Solution: "Cloud Localhost"

Ambit bridges two services: [Fly.io](https://fly.io) (where your apps run) and [Tailscale](https://tailscale.com) (a VPN that links your devices into a private network). Unlike a typical VPN that hides your browsing or spoofs your location, Tailscale creates a sealed private network: devices you enroll can connect to each other, and devices you haven't enrolled cannot. Ambit deploys your apps inside that sealed network, so they are only reachable from devices you have explicitly added to it. A stranger on the internet cannot connect to your app any more than they can connect to a server running on your laptop — there is simply no route to it from the outside.

- **No Login Pages to Build.** If your device is enrolled with your Tailscale
  account, you can access the app. If it isn't, the connection is refused before   the app ever sees it. You never have to write a login page.
- **No Security Auditing To Do.** A database with a weak password, an admin
  panel with no login, an API with no rate limiting — all of these are fine,   because the only machines that can connect are ones you already trust.
- **Human-Readable Addresses.** Your apps get names like
  `http://my-dashboard.lab` instead of IP addresses.

## Networks with Human-Readable Addresses (Ambits)

Each private network you create is called an ambit, and every app you deploy to it gets an address under that network's name — so `http://my-dashboard.lab` means the `my-dashboard` app on the `lab` ambit. These addresses work for anyone on your Tailscale network, which means you can share them with teammates and they just work, no extra configuration needed.

You can create as many ambits as you want, and through Tailscale's ACL settings you can decide precisely which of your devices or users can reach each one, as well as which ambits are allowed to talk to each other. You might, for example, give your whole team access to a `staging` ambit while keeping a `personal` ambit entirely to yourself.

## Why You Need This

### For the "Person with an AI Agent"

If you use Claude Code or OpenClaw, you want the agent to deploy things for testing. Giving it full cloud access is risky since it might deploy a public app with no password.

With Ambit, the agent deploys to `http://test-app.sandbox`. You can see it, the agent can see it, and nobody else knows it exists.

### For the Developer

Setting up auth for a personal tool is a tedious barrier. Run `ambit deploy my-tool --network lab` and the app is live and secure in minutes. The architecture enforces security so your config doesn't have to.

## How It Works

1. Ambit creates an encrypted tunnel between your machine and the cloud using    Tailscale. 2. Your apps deploy into that tunnel. 3. Any device on your Tailscale network can reach them.

## Quick Start

### 1. Install

```bash
npx @cardelli/ambit --help
```

### 2. Create a Network

```bash
ambit create lab
```

### 3. Deploy an App

```bash
ambit deploy my-crazy-site --network lab
```

### 4. Visit It

Open `http://my-crazy-site.lab`. It works for you and nobody else.

## Commands

### `ambit create <network>`

This is the first command you run, it sets up your private network: a named slice of the cloud that only your devices can reach. Under the hood it handles Fly.io and Tailscale authentication, deploys the router, sets up DNS, and configures your local machine to accept the new routes.

| Flag                | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `--org <org>`       | Fly.io organization                                        |
| `--region <region>` | Fly.io region (default: `iad`)                             |
| `--api-key <key>`   | Tailscale API access token                                 |
| `--tag <tag>`       | Tailscale ACL tag (default: `tag:ambit-<network>`)         |
| `--self-approve`    | Approve routes via API when autoApprovers isn't configured |
| `--yes`             | Skip confirmation prompts                                  |
| `--json`            | Machine-readable JSON output                               |

### `ambit deploy <app> --network <name>`

This puts an app onto your private network. This is what you run whenever you want to host something. If the app doesn't exist yet, ambit creates it on the right network for you. You can point it at a directory with a `fly.toml` (auto-detected, or pass `--config`), give it a Docker image with `--image`, or fetch a ready-made template from GitHub with `--template`.

Before deploying, ambit scans your config for settings that don't make sense on a private network (like `force_https`, which only matters for public traffic). After deploying, it checks that no public IPs were allocated, releases any that were, and verifies the app has a private address on the network you specified.

| Flag                  | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `--network <name>`    | Target private network (required)                                        |
| `--org <org>`         | Fly.io organization                                                      |
| `--region <region>`   | Deployment region                                                        |
| `--image <img>`       | Docker image (instead of fly.toml)                                       |
| `--config <path>`     | Explicit fly.toml path (instead of auto-detect)                          |
| `--template <ref>`    | GitHub template as `owner/repo/path[@ref]`                               |
| `--main-port <port>`  | Internal port for HTTP service in image mode (default: `80`, `none` to skip) |
| `--yes`               | Skip confirmation prompts                                                |
| `--json`              | Machine-readable JSON output                                             |

### `ambit status --network <name>`

This tells you if your network is working correctly: it shows whether the router is running, which Tailscale device it is, what routes it's advertising, and whether DNS is configured.

### `ambit destroy --network <name>`

This deletes the network and everything in it: tears down the router, cleans up DNS, and removes the Tailscale device. Reminds you to clean up any ACL entries you added.

### `ambit doctor`

This helps you diagnose issues, run it if something seems broken. It checks that Tailscale is running, routes are accepted, the router is healthy, and all parts of the system can talk to each other.

## Access Control

Ambit doesn't touch your Tailscale ACL policy. After creating a router, it prints the exact policy entries you need so you can control who on your tailnet can reach which networks. By default, if you haven't restricted anything, all your devices can reach everything.

If you want to lock it down, two rules do the job — one for DNS queries and one for data traffic:

```jsonc
{
  "tagOwners": {
    "tag:ambit-infra": ["autogroup:admin"]
  },
  "autoApprovers": {
    "routes": {
      "fdaa:X:XXXX::/48": ["tag:ambit-infra"]
    }
  },
  "acls": [
    {
      "action": "accept",
      "src": ["group:team"],
      "dst": ["tag:ambit-infra:53"]
    },
    { "action": "accept", "src": ["group:team"], "dst": ["fdaa:X:XXXX::/48:*"] }
  ]
}
```

## Multiple Networks

You can create as many networks as you want, and each one gets its own TLD on your tailnet. The SOCKS proxy on each router means containers on one network can reach services on another by going through the tailnet, so a browser on your `browsers` network can connect to a database on your `infra` network.

```bash
ambit create infra
ambit create browsers
```

## Templates

Templates are ready-to-deploy configurations hosted on GitHub. Use `--template` to fetch and deploy one in a single command:

```bash
ambit deploy my-browser --network lab --template ToxicPine/ambit-templates/chromatic
```

The template reference format is `owner/repo/path[@ref]` — pin to a tag, branch, or commit with `@`:

```bash
ambit deploy my-browser --network lab --template ToxicPine/ambit-templates/chromatic@v1.0
```

You can also deploy from local template files with `--config`:

```bash
ambit deploy my-opencode --network supercomputer --config templates/opencode/fly.toml
```

## Agent Skill

Install the Ambit [skill](https://skills.sh) to give your AI coding agent reference documentation for all the CLI commands. Works with Claude Code, Cursor, Windsurf, and other AI coding agents:

```bash
npx skills add ToxicPine/ambit-skills --skill ambit-cli
```

## Ambit MCP

The [ambit MCP server](../ambit-mcp/) lets AI agents deploy and manage apps on your behalf, with the same safety guarantees. In safe mode, the agent literally cannot deploy something with a public IP. See the [ambit-mcp README](../ambit-mcp/) for details.
