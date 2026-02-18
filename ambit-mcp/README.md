# Ambit MCP Server

Ambit MCP is what you install when you want an AI agent to deploy and manage apps for you. It gives the agent access to your Fly.io account, but wraps every operation in a safety layer so that the agent can only ever deploy things onto your private Ambit network. It cannot make anything public, no matter what you ask it to do.

## The Problem

Agents are good at writing code and not particularly careful about security. If you hand one your raw cloud credentials and ask it to "deploy this," it will deploy it — possibly with no password on the database, an admin panel open to the world, and API keys sitting in a public config file. It is not being reckless on purpose; it is just executing the task without thinking through the consequences.

## The Solution

Ambit MCP wraps the Fly.io CLI in a constrained interface that makes insecure deployments structurally impossible. The agent is given tools to create apps, deploy code, read logs, and manage secrets, but those tools only produce private deployments. There is no "deploy publicly" option for it to accidentally choose.

When your agent deploys something through Ambit MCP, it lands on your Ambit network at an address like `http://my-app.lab`. You can reach it, the agent can verify it's working, and nobody else can.

## Safety Rules

Safe Mode is on by default and enforces four hard rules:

1. **No Public IPs.** The agent cannot allocate a public IP address. The tool does not exist. 2. **Private Network Only.** Every deployment must name a specific private network to target. 3. **Audit on Every Deploy.** Immediately after deploying, the system checks whether any public IPs were allocated and deletes them if so. 4. **Router Protection.** The agent cannot modify or delete the Ambit router that underpins your network.

## Installation

Run the setup command, which writes the server configuration into your project so your agent picks it up automatically:

```bash
npx @cardelli/mcp setup --create --yes
```

You need `flyctl` installed and authenticated, and an Ambit network already set up with `ambit create <network>`.

## Agent Skill

Install the Ambit MCP [skill](https://skills.sh) to give your AI coding agent reference documentation for all the tools. Works with Claude Code, Cursor, Windsurf, and other AI coding agents:

```bash
npx skills add ToxicPine/ambit-skills --skill ambit-mcp
```

## Tool Reference

### Apps and Deployment

**`fly_auth_status`** Checks whether the `fly` CLI is authenticated and returns the current user's email. Run this first if something seems wrong with credentials.

**`fly_app_list`** Lists all apps in your organization. In safe mode, infrastructure apps (those named `ambit-*`) are hidden.

**`fly_app_status`** — inputs: `app` Returns the deployment state, hostname, and list of machines for an app, including each machine's region, state, and IP address.

**`fly_app_create`** — inputs: `name`, `org` Creates a new app on your configured private network. In safe mode, the network is always set automatically so the app is never placed on a public network.

**`fly_app_destroy`** — inputs: `app` Permanently deletes an app and all its machines, volumes, and IP allocations. Cannot target `ambit-*` infrastructure apps.

**`fly_deploy`** — inputs: `app`, `image`, `dockerfile`, `region`, `strategy`, `env`, `build_args` Deploys code to an app. In safe mode, `--no-public-ips` and `--flycast` are always injected, and the result is automatically audited. Deployment strategy options are `rolling` (default), `immediate`, `canary`, and `bluegreen`.

### Machines

**`fly_machine_list`** — inputs: `app` Lists all virtual machines for an app, with their IDs, states, regions, and hardware configuration.

**`fly_machine_start`** — inputs: `app`, `machine_id` Starts a stopped machine.

**`fly_machine_stop`** — inputs: `app`, `machine_id` Gracefully stops a running machine.

**`fly_machine_destroy`** — inputs: `app`, `machine_id`, `force` Permanently deletes a machine. Use `force: true` if the machine is stuck.

**`fly_machine_exec`** — inputs: `app`, `machine_id`, `command` Runs a single command on a running machine and returns the output. Useful for inspecting state, checking logs, or verifying connectivity.

### Networking

**`fly_ip_list`** — inputs: `app` Lists all IP addresses allocated to an app. Use this to audit whether an app has any public exposure.

**`fly_ip_release`** — inputs: `app`, `address` Releases (removes) an IP address from an app.

**`fly_ip_allocate_flycast`** (safe mode) — inputs: `app`, `network` Allocates a private Flycast IPv6 address, making the app reachable from a specific named private network. This is the only IP allocation tool available in safe mode.

### Secrets and Config

**`fly_secrets_list`** — inputs: `app` Lists the names and creation timestamps of secrets on an app. Values are never returned.

**`fly_secrets_set`** — inputs: `app`, `secrets`, `stage` Sets encrypted environment variables on an app. Use this for API keys, database passwords, and tokens — not `env` in `fly_deploy`. Pass `stage: true` to stage the secrets without triggering a redeploy.

**`fly_secrets_unset`** — inputs: `app`, `keys` Removes secrets from an app.

**`fly_config_show`** — inputs: `app` Shows the live merged configuration Fly.io is running for an app.

**`fly_logs`** — inputs: `app`, `region`, `machine` Fetches recent log output. Optionally filter by region or machine ID.

### Scaling

**`fly_scale_show`** — inputs: `app` Shows the current VM size and machine count per process group.

**`fly_scale_count`** — inputs: `app`, `count`, `region`, `process_group` Sets the number of machines for an app. Capped at 20. Pass `region` or `process_group` to target a specific subset.

**`fly_scale_vm`** — inputs: `app`, `size`, `memory` Changes the VM size for an app's machines. Common sizes: `shared-cpu-1x`, `shared-cpu-2x`, `performance-1x`.

### Volumes

**`fly_volumes_list`** — inputs: `app` Lists all persistent volumes attached to an app.

**`fly_volumes_create`** — inputs: `app`, `name`, `region`, `size_gb` Creates a persistent volume. Volumes are region-specific and must be in the same region as the machines that will use them.

**`fly_volumes_destroy`** — inputs: `app`, `volume_id`, `confirm` Permanently deletes a volume and all its data. The `confirm` field must exactly match the `volume_id` as a safety check.

### Router Tools (Safe Mode Only)

**`router_list`** — inputs: `org` Discovers all Ambit routers in your organization.

**`router_status`** — inputs: `network`, `org` Shows the detailed health of a specific router: machine state, Tailscale device info, advertised routes, and DNS configuration.

**`router_deploy`** — inputs: `network`, `org`, `region`, `tag`, `self_approve` Deploys a new Ambit router for a network. The network name becomes the TLD for apps on that network. Optionally pass `tag` to use a custom Tailscale ACL tag (default: `tag:ambit-<network>`).

**`router_destroy`** — inputs: `network`, `org` Tears down a router. Apps on the network are not deleted, only the router is removed.

**`router_doctor`** — inputs: `network`, `org` Runs health checks on a router and returns pass/fail results with remediation hints for any failures.

**`router_logs`** — inputs: `network`, `org` Fetches recent logs from the router's machine, useful for debugging Tailscale auth and DNS issues.
