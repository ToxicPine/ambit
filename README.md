# Ambi(en)t

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![npm @cardelli/ambit](https://img.shields.io/npm/v/@cardelli/ambit?label=ambit)](https://www.npmjs.com/package/@cardelli/ambit)
[![GitHub stars](https://img.shields.io/github/stars/ToxicPine/ambit)](https://github.com/ToxicPine/ambit)
[![Built with Nix](https://img.shields.io/badge/Built_with-Nix-5277C3?logo=nixos)](https://nixos.org)
[![Stability: Beta](https://img.shields.io/badge/Stability-Beta-orange)](https://github.com/ToxicPine/ambit)

A toolkit for hosting apps in the cloud so that only you — and the AI agents you work with — can reach them.

When you put something on the internet, you normally have to build login pages, configure firewalls, and worry about bots or strangers stumbling across it. These tools skip all of that. Your apps live in the cloud but are completely invisible to the public internet: there is no address for a stranger to find, no door for them to knock on. The only machines that can connect are the ones you have explicitly added to your private network.

## Projects

### [Ambit](./ambit/)

Ambit is the core tool. It deploys your apps — databases, dashboards, internal tools, anything packaged as a Docker image — onto a private cloud network that only your devices can reach (via Tailscale VPN). Each app gets a clean, human-readable address like `http://my-app.lab`, and you access it the same way you'd access anything on your home network. No login page needed, because access is controlled at the network level: if your device is on the network, the app is there; if it isn't, the app simply doesn't exist from its perspective.

→ [Read the Ambit docs](./ambit/README.md)

---

### [Templates](./ambit-templates/)

The [ambit-templates](./ambit-templates/) directory has ready-to-deploy examples for common setups.

| Template | Description |
| --- | --- |
| [wetty](./ambit-templates/wetty/) | A cloud devshell — Nix-based environment with a web terminal, persistent home directory, passwordless sudo, and auto start/stop. |
| [opencode](./ambit-templates/opencode/) | A private [OpenCode](https://opencode.ai) web workspace — Nix-based environment with persistent home and auto start/stop. |
| [chromatic](./ambit-templates/chromatic/) | A headless Chrome instance exposing the Chrome DevTools Protocol — for AI agents or scripts that need to drive a browser on your private network. |
| [openclaw](https://github.com/ToxicPine/ambit-openclaw) | A self-hosted [OpenClaw](https://openclaw.ai) instance — a personal AI assistant you can talk to from WhatsApp, Telegram, Discord, and other chat apps. |

## Installation

Ambit is available on npm:

```bash
npx @cardelli/ambit --help
```

## Agent Skills

Install [skills](https://skills.sh) to give your AI coding agent reference documentation for the CLI and MCP tools. Works with Claude Code, Cursor, Windsurf, and other AI coding agents:

```bash
npx skills add ToxicPine/ambit-skills --skill ambit-cli
```

## Quick Usage

**Set Up a Private Network and Deploy an App:**

```bash
npx @cardelli/ambit create lab
npx @cardelli/ambit deploy my-app.lab
# → http://my-app.lab, visible only to your devices
```

**Deploy a headless browser from a template:**

```bash
npx @cardelli/ambit deploy my-browser.lab --template ToxicPine/ambit-templates/chromatic
# → headless Chrome on your private network, reachable via CDP at my-browser.lab:9222
```
