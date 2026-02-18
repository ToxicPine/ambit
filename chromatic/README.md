# Chromatic

Chromatic gives your AI agent a browser. It runs a headless Chrome instance in the cloud, on your private Ambit network, that your agent can control. When an agent needs to visit a page, fill out a form, take a screenshot, or scrape content, it uses this browser rather than running one on your local machine. That means an agent like Claude Code can open your app in a real browser, click through it, spot visual bugs or broken flows, and report back — or fix the underlying code — without you lifting a finger.

## Why Not Just Use Your Local Browser?

If you let an agent drive your actual browser, it has full access to every site you are currently logged into — your email, your bank, everything. One malicious or misbehaving page and your session tokens are gone. Beyond the security risk, running headless Chrome for extended tasks also drains your battery and consumes memory that your other work needs.

Chromatic solves both problems by running the browser in a disposable cloud container instead. The agent has full control of the browser, but that browser has no access to your local files or sessions. If something goes wrong, you delete the container. Your machine and accounts are never involved.

Because the container runs on your Ambit network, it is only reachable from your enrolled Tailscale devices, which means the browser control interface is never exposed to the public internet. The agent connects to it over the same private tunnel it uses to reach everything else on your network.

## Cost

The browser sleeps when the agent is not using it, so you pay nothing while it is idle. It wakes in a couple of seconds when the agent makes a request, and you are only billed for the seconds it is actually running. There is no monthly subscription, and typical developer usage comes to around $2.50 a month.

## Quick Start

### 1. Setup
Run the one-time setup to link Fly.io and Tailscale and deploy the Ambit router.
```bash
chromatic setup
```

### 2. Create a browser
```bash
chromatic create my-browser
```

### 3. Connect your agent
This writes the browser's endpoint into your agent's config file so it can use it automatically.
```bash
chromatic mcp my-browser
```

You can now tell your agent "summarize the top post on Hacker News" and it will open the cloud browser to do it.

## Commands

### `chromatic setup`

This is the first command you run. It discovers your existing Ambit routers and saves your network preference so subsequent commands know which network to use. The Ambit router must already be deployed with `ambit create <network>` before running this.

| Flag | Description |
|------|-------------|
| `--network <name>` | Network to use (auto-detected if only one exists) |
| `--org <org>` | Fly.io organization slug |
| `--yes` | Skip confirmation prompts |
| `--json` | Machine-readable JSON output |

### `chromatic create <name>`

This deploys a new browser instance (or pool) onto your private network. The browser has no public IP and is only reachable over Tailscale. A single browser gives you a direct connection for stateful sessions. A pool load-balances across multiple Chrome instances for parallel stateless workloads like scraping.

| Flag | Description |
|------|-------------|
| `--count <n>` | Number of machines to create (default: 1, max: 10) |
| `--size <size>` | Machine size (default: `shared-cpu-1x`) |
| `--region <region>` | Fly.io region (default: `iad`) |
| `--network <name>` | Network to deploy onto (default: from setup config) |
| `--org <org>` | Fly.io organization slug |
| `--json` | Machine-readable JSON output |

Available sizes:

| Size | CPU | RAM |
|------|-----|-----|
| `shared-cpu-1x` | 1 vCPU | 1 GB |
| `shared-cpu-2x` | 2 vCPU | 2 GB |
| `shared-cpu-4x` | 4 vCPU | 4 GB |

### `chromatic mcp <name>`

This adds the browser's connection endpoint to your `.mcp.json` so your AI agent picks it up automatically. Searches parent directories for an existing `.mcp.json`; use `--create` if you don't have one yet.

| Flag | Description |
|------|-------------|
| `--name <server>` | Name for the MCP server entry (default: `chromatic-<name>`) |
| `--create` | Create a new `.mcp.json` in the current directory if none is found |
| `--dry-run` | Preview the changes without writing |
| `--network <name>` | Network name (default: from setup config) |
| `--org <org>` | Fly.io organization slug |
| `--yes` | Skip confirmation prompts |

### `chromatic scale <name>`

This adds or removes machines in a browser pool. Connections are load-balanced across all machines automatically. You can either pass a simple total count or specify exact counts per machine size.

| Flag | Description |
|------|-------------|
| `--shared-cpu-1x <n>` | Number of 1x machines |
| `--shared-cpu-2x <n>` | Number of 2x machines |
| `--shared-cpu-4x <n>` | Number of 4x machines |
| `--region <region>` | Region for new machines (default: `iad`) |
| `--yes` | Skip confirmation prompts |

```bash
chromatic scale scrapers 5                          # 5 machines total (1x)
chromatic scale scrapers --shared-cpu-1x 3 --shared-cpu-2x 2  # mixed sizes
```

### `chromatic list`

This lists all browser instances on your network with their names, machine counts, and current state.

### `chromatic status <name>`

This shows detailed information for a browser instance, including each machine's ID, state, region, and the WebSocket connection endpoint.

### `chromatic doctor`

This checks that Tailscale is running, the Ambit router is healthy, and your credentials are valid: run this if something seems broken.

### `chromatic destroy <name>`

This a browser instance and all its machines, which cannot be undone.
