#!/usr/bin/env -S deno run --allow-net --allow-run
/**
 * Check and update software versions in Dockerfiles
 *
 * Usage:
 *   deno task check-versions          # Check for outdated versions
 *   deno task check-versions --update # Update Dockerfiles on a new branch
 */

import { parseArgs } from "@std/cli/parse-args";

// =============================================================================
// Types
// =============================================================================

interface VersionCheck {
  name: string;
  dockerfile: string;
  pattern: RegExp;
  current: string;
  latest?: string;
  getLatest: () => Promise<string>;
}

// =============================================================================
// Git Helpers
// =============================================================================

async function git(...args: string[]): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`git ${args.join(" ")} failed: ${error}`);
  }

  return new TextDecoder().decode(stdout).trim();
}

async function gitWriteBlob(content: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["hash-object", "-w", "--stdin"],
    stdin: "piped",
    stdout: "piped",
  });

  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(content));
  await writer.close();

  const { stdout } = await proc.output();
  return new TextDecoder().decode(stdout).trim();
}

async function gitMakeTree(entries: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["mktree"],
    stdin: "piped",
    stdout: "piped",
  });

  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(entries));
  await writer.close();

  const { stdout } = await proc.output();
  return new TextDecoder().decode(stdout).trim();
}

async function gitMakeCommit(
  tree: string,
  parent: string,
  message: string,
): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["commit-tree", tree, "-p", parent, "-m", message],
    stdout: "piped",
  });

  const { stdout } = await cmd.output();
  return new TextDecoder().decode(stdout).trim();
}

// =============================================================================
// Version Fetchers
// =============================================================================

async function getGitHubLatest(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const resp = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });

  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status}`);
  }

  const data = await resp.json();
  return data.tag_name.replace(/^v/, "");
}

async function getAlpineLatest(): Promise<string> {
  const url =
    "https://hub.docker.com/v2/repositories/library/alpine/tags?page_size=100&ordering=last_updated";
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`Docker Hub API error: ${resp.status}`);
  }

  const data = await resp.json();

  const versions = data.results
    .map((t: { name: string }) => t.name)
    .filter((name: string) => /^\d+\.\d+(\.\d+)?$/.test(name))
    .sort((a: string, b: string) => {
      const [aMaj, aMin] = a.split(".").map(Number);
      const [bMaj, bMin] = b.split(".").map(Number);
      return bMaj - aMaj || bMin - aMin;
    });

  return versions[0];
}

// =============================================================================
// Dockerfile Parsing
// =============================================================================

function extractVersion(content: string, pattern: RegExp): string {
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`Pattern not found: ${pattern}`);
  }
  return match[1];
}

function applyVersionUpdate(
  content: string,
  pattern: RegExp,
  oldVersion: string,
  newVersion: string,
): string {
  const oldPattern = pattern.source.replace("([\\d.]+)", oldVersion);
  const newValue = pattern.source
    .replace("([\\d.]+)", newVersion)
    .replace(/\\/g, "");

  return content.replace(new RegExp(oldPattern), newValue);
}

// =============================================================================
// Branch Creation (Without Touching Working Tree)
// =============================================================================

async function createUpdateBranch(
  branchName: string,
  commitMessage: string,
  dockerfiles: Record<string, string>,
): Promise<string> {
  const headCommit = await git("rev-parse", "HEAD");
  const headTree = await git("rev-parse", "HEAD^{tree}");

  console.log("\nCreating Updated Blobs...");
  const blobs: Record<string, string> = {};

  for (const [name, content] of Object.entries(dockerfiles)) {
    blobs[name] = await gitWriteBlob(content);
    console.log(`  ${name}/Dockerfile -> ${blobs[name].slice(0, 8)}`);
  }

  console.log("Building New Tree...");
  const currentTree = await git("ls-tree", "-r", headTree);

  const updatedTree = currentTree
    .split("\n")
    .map((line) => {
      if (line.includes("src/docker/router/Dockerfile")) {
        return line.replace(/\b[a-f0-9]{40}\b/, blobs.router);
      }
      return line;
    })
    .join("\n");

  const newTree = await gitMakeTree(updatedTree);

  console.log("Creating Commit...");
  const newCommit = await gitMakeCommit(newTree, headCommit, commitMessage);

  await git("update-ref", `refs/heads/${branchName}`, newCommit);

  return newCommit;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["update", "help"],
    alias: { u: "update", h: "help" },
  });

  if (args.help) {
    console.log(`Usage: check-versions [--update]

Options:
  --update, -u  Update Dockerfiles to latest versions
  --help, -h    Show this help message`);
    Deno.exit(0);
  }

  const dockerfiles: Record<string, string> = {
    router: await git("show", "HEAD:src/docker/router/Dockerfile"),
  };

  const checks: VersionCheck[] = [
    {
      name: "alpine",
      dockerfile: "router",
      pattern: /FROM alpine:([\d.]+)/,
      current: extractVersion(dockerfiles.router, /FROM alpine:([\d.]+)/),
      getLatest: getAlpineLatest,
    },
    {
      name: "tailscale",
      dockerfile: "router",
      pattern: /ARG TAILSCALE_VERSION=([\d.]+)/,
      current: extractVersion(
        dockerfiles.router,
        /ARG TAILSCALE_VERSION=([\d.]+)/,
      ),
      getLatest: () => getGitHubLatest("tailscale/tailscale"),
    },
    {
      name: "coredns",
      dockerfile: "router",
      pattern: /ARG COREDNS_VERSION=([\d.]+)/,
      current: extractVersion(
        dockerfiles.router,
        /ARG COREDNS_VERSION=([\d.]+)/,
      ),
      getLatest: () => getGitHubLatest("coredns/coredns"),
    },
  ];

  console.log("Checking Versions...\n");

  let hasUpdates = false;

  for (const check of checks) {
    try {
      check.latest = await check.getLatest();

      const isOutdated = check.current !== check.latest;
      const status = isOutdated ? "Outdated" : "Ok";

      console.log(
        `${check.name.padEnd(15)} ${check.current.padEnd(10)} -> ${
          check.latest.padEnd(10)
        } ${status}`,
      );

      if (isOutdated) {
        hasUpdates = true;

        if (args.update) {
          dockerfiles[check.dockerfile] = applyVersionUpdate(
            dockerfiles[check.dockerfile],
            check.pattern,
            check.current,
            check.latest,
          );
        }
      }
    } catch (err) {
      console.error(`${check.name.padEnd(15)} ERROR: ${err}`);
    }
  }

  if (args.update && hasUpdates) {
    const branchName = `chore/update-docker-versions-${Date.now()}`;

    const updatedList = checks
      .filter((c) => c.latest && c.current !== c.latest)
      .map((c) => `${c.name} ${c.current} -> ${c.latest}`)
      .join(", ");

    const commitMessage = `chore: update docker versions\n\n${updatedList}`;

    const commitHash = await createUpdateBranch(
      branchName,
      commitMessage,
      dockerfiles,
    );

    console.log(`\nDone. Branch '${branchName}' Created With Updates.`);
    console.log(`Commit: ${commitHash.slice(0, 8)}`);
    console.log(`To Push: git push -u origin ${branchName}`);
  } else if (hasUpdates) {
    console.log("\nRun With --update To Apply Changes.");
  } else {
    console.log("\nAll Versions Are Up To Date.");
  }

  Deno.exit(hasUpdates ? 1 : 0);
}

main();
