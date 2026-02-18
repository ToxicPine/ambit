# Ambi(en)t

A toolkit for hosting apps in the cloud so that only you — and the AI agents you work with — can reach them.

When you put something on the internet, you normally have to build login pages, configure firewalls, and worry about bots or strangers stumbling across it. These tools skip all of that. Your apps live in the cloud but are completely invisible to the public internet: there is no address for a stranger to find, no door for them to knock on. The only machines that can connect are the ones you have explicitly added to your private network.

## Projects

### [Ambit](./ambit/)

Ambit is the core tool. It deploys your apps — databases, dashboards, internal tools, anything packaged as a Docker image — onto a private cloud network that only your devices can reach (via Tailscale VPN). Each app gets a clean, human-readable address like `http://my-app.lab`, and you access it the same way you'd access anything on your home network. No login page needed, because access is controlled at the network level: if your device is on the network, the app is there; if it isn't, the app simply doesn't exist from its perspective.

→ [Read the Ambit docs](./ambit/README.md)

---

### [Ambit MCP](./ambit-mcp/)

Ambit MCP lets an AI agent like Claude Code deploy and manage your apps for you. Rather than handing the agent unrestricted access to your cloud account and hoping it doesn't do anything dangerous, Ambit MCP gives it a constrained set of tools that can only ever produce private deployments. The agent can write code, deploy it, check logs, and update configuration — but it has no way to accidentally make something public, because that option simply doesn't exist in the interface it's given.

→ [Read the Ambit MCP docs](./ambit-mcp/README.md)

---

### [Chromatic](./chromatic/)

Chromatic gives your AI agent a browser. It runs a headless Chrome instance in the cloud, on your private network, that your agent can control to visit pages, fill in forms, and take screenshots. This matters because you don't want the agent using your actual browser — that would give it access to every site you're logged into. With Chromatic, the agent gets its own isolated browser with no connection to your accounts or local files. An agent like Claude Code can open your app, click through it, spot visual bugs or broken flows, and fix the underlying code, all without your laptop being involved.

→ [Read the Chromatic docs](./chromatic/README.md)

---

## Installation

Each tool is available as a Nix package:

```bash
nix profile add github:ToxicPine/ambit        # ambit
nix profile add github:ToxicPine/ambit#chromatic   # chromatic
```

If you don't have Nix, install it first:

```bash
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
```

Ambit MCP is installed per-project via its setup command:

```bash
nix run github:ToxicPine/ambit#ambit-mcp -- setup --create --yes
```

## Agent Skills

Install [skills](https://skills.sh) to give your AI coding agent reference documentation for the CLI, MCP, and browser tools. Works with Claude Code, Cursor, Windsurf, and other AI coding agents:

```bash
npx skills add ToxicPine/ambit-skills --skill ambit-cli
npx skills add ToxicPine/ambit-skills --skill ambit-mcp
npx skills add ToxicPine/ambit-skills --skill chromatic
```

## Quick Usage

**Set Up a Private Network and Deploy an App:**

```bash
ambit create lab
ambit deploy my-app --network lab
# → http://my-app.lab, visible only to your devices
```

**Give your AI agent deploy access (run once per project):**

```bash
nix run github:ToxicPine/ambit#ambit-mcp -- setup --create --yes
# → agent can now deploy to your private network, nothing else
```

**Give your AI agent a browser:**

```bash
chromatic setup
chromatic create my-browser
chromatic mcp my-browser
# → agent can now open pages, take screenshots, and fix what it finds
```
