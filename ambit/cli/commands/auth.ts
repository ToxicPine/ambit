// =============================================================================
// Auth Command - Manage Fly.io and Tailscale Authentication
// =============================================================================

import { parseArgs } from "@std/cli";
import { bold, confirm, readSecret } from "@/lib/cli.ts";
import { checkArgs } from "@/lib/args.ts";
import { createOutput, type Output } from "@/lib/output.ts";
import { registerCommand } from "@/cli/mod.ts";
import { runCommand } from "@/lib/command.ts";
import { createTailscaleProvider } from "@/providers/tailscale.ts";
import { getCredentialStore, getFlyIdentityKey } from "@/util/credentials.ts";
import { TAILSCALE_API_KEY_PREFIX } from "@/util/constants.ts";
import { FlyAuthSchema } from "@/schemas/fly.ts";
import { createFlyProvider } from "@/providers/fly.ts";
import { resolveOrg } from "@/util/resolve.ts";

// =============================================================================
// Types
// =============================================================================

type AuthLoginResult = {
  fly: string;
  flyScope: string;
  tailscale: boolean;
};

type AuthWhoamiResult = {
  fly: string | null;
  flyScope: string | null;
  tailscale: boolean;
};

type AuthLogoutResult = {
  fly: boolean;
  tailscale: boolean;
};

// =============================================================================
// Helpers
// =============================================================================

const tryFlyWhoami = async (
  token?: string,
): Promise<string | null> => {
  const result = await runCommand(
    ["fly", "auth", "whoami", "--json"],
    token ? { env: { FLY_API_TOKEN: token } } : undefined,
  );

  if (!result.ok) return null;

  const auth = result.json<{ email: string }>();
  if (!auth.ok) return null;

  const parsed = FlyAuthSchema.safeParse(auth.value);
  return parsed.success ? parsed.data.email : null;
};

const resolveFlyScope = async <T extends Record<string, unknown>>(
  out: Output<T>,
  opts: { json: boolean; org?: string; flyApiKey?: string; flyEmail: string },
): Promise<string> => {
  const fly = createFlyProvider(opts.flyApiKey);
  const org = await resolveOrg(fly, { json: opts.json, org: opts.org }, out);
  const scope = getFlyIdentityKey(org, opts.flyEmail);
  out.ok(`Using Fly Identity: ${scope}`);
  return scope;
};

// =============================================================================
// Auth Login
// =============================================================================

const authLogin = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["ts-api-key", "fly-api-key", "org"],
    boolean: ["help", "json"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit auth login", 0);

  if (args.help) {
    console.log(`
${bold("ambit auth login")} - Authenticate with Fly.io and Tailscale

${bold("USAGE")}
  ambit auth login [options]

${bold("OPTIONS")}
  --ts-api-key <key>    Tailscale API access token (tskey-api-...)
  --fly-api-key <token> Fly.io API token
  --org <org>           Fly.io organization slug
  --json                Output as JSON

${bold("DESCRIPTION")}
  Authenticates with both Fly.io and Tailscale. Only prompts for
  credentials that are missing or invalid.

${bold("EXAMPLES")}
  ambit auth login
  ambit auth login --org my-org
  ambit auth login --ts-api-key tskey-api-... --fly-api-key fo1_...
`);
    return;
  }

  const out = createOutput<AuthLoginResult>(args.json);
  const credentials = getCredentialStore();

  // =========================================================================
  // Step 1: Fly.io
  // =========================================================================

  out.blank().header("Fly.io Authentication").blank();

  let flyEmail: string;

  if (args["fly-api-key"]) {
    const email = await tryFlyWhoami(args["fly-api-key"]);
    if (!email) {
      return out.die("Invalid Fly.io API Token");
    }
    out.ok(`Authenticated as ${email}`);
    flyEmail = email;
  } else {
    const bestEmail = await tryFlyWhoami();

    if (bestEmail) {
      out.ok(`Already Authenticated as ${bestEmail}`);
      flyEmail = bestEmail;
    } else {
      if (args.json) {
        return out.die(
          "Not Authenticated with Fly.io. Provide --fly-api-key in JSON Mode",
        );
      }

      const loginResult = await runCommand(["fly", "auth", "login"], {
        interactive: true,
      });
      if (!loginResult.ok) {
        return out.die("Fly.io Authentication Failed");
      }

      const email = await tryFlyWhoami();
      if (!email) {
        return out.die("Fly.io Authentication Verification Failed");
      }

      out.ok(`Authenticated as ${email}`);
      flyEmail = email;
    }
  }

  const flyScope = await resolveFlyScope(out, {
    json: args.json,
    org: args.org,
    flyApiKey: args["fly-api-key"],
    flyEmail,
  });

  // =========================================================================
  // Step 2: Tailscale
  // =========================================================================

  out.blank().header("Tailscale Authentication").blank();

  let tailscaleOk = false;

  if (args["ts-api-key"]) {
    if (!args["ts-api-key"].startsWith(TAILSCALE_API_KEY_PREFIX)) {
      return out.die(
        "Invalid Token Format. Expected 'tskey-api-...' (API Access Token, Not Auth Key)",
      );
    }

    const tailscale = createTailscaleProvider(args["ts-api-key"]);
    const validateSpinner = out.spinner("Validating API Access Token");
    const isValid = await tailscale.auth.validateKey();
    if (!isValid) {
      validateSpinner.fail("Invalid API Access Token");
      return out.die("Failed to Validate Tailscale API Access Token");
    }
    validateSpinner.success("API Access Token Validated");

    await credentials.setTailscaleApiKey(args["ts-api-key"], flyScope);
    tailscaleOk = true;
  } else {
    const storedKey = await credentials.getTailscaleApiKey(flyScope);

    if (storedKey) {
      const tailscale = createTailscaleProvider(storedKey);
      const validateSpinner = out.spinner("Checking Stored API Key");
      const isValid = await tailscale.auth.validateKey();
      if (isValid) {
        validateSpinner.success("API Key Already Configured");
        tailscaleOk = true;
      } else {
        validateSpinner.fail("Stored API Key Is Invalid or Expired");
        // Fall through to prompt
      }
    }

    if (!tailscaleOk) {
      if (args.json) {
        return out.die(
          "Tailscale API Key Not Configured. Provide --ts-api-key in JSON Mode",
        );
      }

      out.dim(
        "Ambit Needs an API Access Token (Not an Auth Key) to Manage Your Tailnet.",
      )
        .dim("Create One at:").link(
          "  https://login.tailscale.com/admin/settings/keys",
        )
        .blank();

      const apiKey = await readSecret("API access token (tskey-api-...): ");
      if (!apiKey) {
        return out.die("Tailscale API Access Token Required");
      }

      if (!apiKey.startsWith(TAILSCALE_API_KEY_PREFIX)) {
        return out.die(
          "Invalid Token Format. Expected 'tskey-api-...' (API Access Token, Not Auth Key)",
        );
      }

      const tailscale = createTailscaleProvider(apiKey);
      const validateSpinner = out.spinner("Validating API Access Token");
      const isValid = await tailscale.auth.validateKey();
      if (!isValid) {
        validateSpinner.fail("Invalid API Access Token");
        return out.die("Failed to Validate Tailscale API Access Token");
      }
      validateSpinner.success("API Access Token Validated");

      await credentials.setTailscaleApiKey(apiKey, flyScope);
      tailscaleOk = true;
    }
  }

  out.blank();
  out.done({ fly: flyEmail, flyScope, tailscale: tailscaleOk });
  out.print();
};

// =============================================================================
// Auth Whoami
// =============================================================================

const authWhoami = async (argv: string[]): Promise<void> => {
  const opts = {
    string: ["org"],
    boolean: ["help", "json"],
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit auth whoami", 0);

  if (args.help) {
    console.log(`
${bold("ambit auth whoami")} - Show Current Authentication Status

${bold("USAGE")}
  ambit auth whoami [options]

${bold("OPTIONS")}
  --org <org> Fly.io organization slug
  --json   Output as JSON

${bold("EXAMPLES")}
  ambit auth whoami
  ambit auth whoami --org my-org
  ambit auth whoami --json
`);
    return;
  }

  const out = createOutput<AuthWhoamiResult>(args.json);
  const credentials = getCredentialStore();

  // =========================================================================
  // Step 1: Fly.io
  // =========================================================================

  let flyEmail: string | null = null;
  let flyScope: string | null = null;

  flyEmail = await tryFlyWhoami();
  if (flyEmail) {
    flyScope = await resolveFlyScope(out, {
      json: args.json,
      org: args.org,
      flyEmail,
    });
  }

  // =========================================================================
  // Step 2: Tailscale
  // =========================================================================

  let tailscaleOk = false;

  if (flyScope) {
    const storedKey = await credentials.getTailscaleApiKey(flyScope);
    if (storedKey) {
      const tailscale = createTailscaleProvider(storedKey);
      tailscaleOk = await tailscale.auth.validateKey();
    }
  }

  // =========================================================================
  // Output
  // =========================================================================

  out.blank();
  out.text(`  Fly.io:     ${flyEmail ?? "Not Authenticated"}`);
  if (flyScope) {
    out.text(`  Fly Scope:  ${flyScope}`);
  }
  out.text(
    `  Tailscale:  ${tailscaleOk ? "API Key Configured" : "Not Configured"}`,
  );
  out.blank();

  out.done({ fly: flyEmail, flyScope, tailscale: tailscaleOk });
  out.print();
};

// =============================================================================
// Auth Logout
// =============================================================================

const authLogout = async (argv: string[]): Promise<void> => {
  const opts = {
    boolean: ["help", "json", "yes"],
    alias: { y: "yes" },
  } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit auth logout", 0);

  if (args.help) {
    console.log(`
${bold("ambit auth logout")} - Clear Stored Credentials

${bold("USAGE")}
  ambit auth logout [options]

${bold("OPTIONS")}
  -y, --yes   Skip confirmation prompt
  --json      Output as JSON

${bold("EXAMPLES")}
  ambit auth logout
  ambit auth logout --yes
`);
    return;
  }

  const out = createOutput<AuthLogoutResult>(args.json);

  if (!args.yes && !args.json) {
    const ok = await confirm(
      "This will clear all stored credentials. Continue?",
    );
    if (!ok) {
      return out.die("Aborted");
    }
  }

  const credentials = getCredentialStore();
  await credentials.clear();
  out.ok("Cleared Stored Credentials");

  await runCommand(["fly", "auth", "logout"]);
  out.ok("Logged Out of Fly.io");

  out.blank();
  out.done({ fly: true, tailscale: true });
  out.print();
};

// =============================================================================
// Top-Level Help
// =============================================================================

const showAuthHelp = (): void => {
  console.log(`
${bold("ambit auth")} - Manage Fly.io and Tailscale Authentication

${bold("USAGE")}
  ambit auth <subcommand> [options]

${bold("SUBCOMMANDS")}
  login     Authenticate with Fly.io and Tailscale
  whoami    Show current authentication status
  logout    Clear stored credentials

${bold("EXAMPLES")}
  ambit auth login
  ambit auth whoami
  ambit auth logout

Run 'ambit auth <subcommand> --help' for details.
`);
};

// =============================================================================
// Dispatcher
// =============================================================================

const auth = async (argv: string[]): Promise<void> => {
  const subcommand = typeof argv[0] === "string" ? argv[0] : undefined;

  if (subcommand === "login") return authLogin(argv.slice(1));
  if (subcommand === "whoami") return authWhoami(argv.slice(1));
  if (subcommand === "logout") return authLogout(argv.slice(1));

  const opts = { boolean: ["help"] } as const;
  const args = parseArgs(argv, opts);
  checkArgs(args, opts, "ambit auth", 0);

  if (args.help) {
    showAuthHelp();
    return;
  }

  showAuthHelp();
  Deno.exit(1);
};

// =============================================================================
// Register Command
// =============================================================================

registerCommand({
  name: "auth",
  description: "Manage Fly.io and Tailscale authentication",
  usage: "ambit auth login|whoami|logout [options]",
  run: auth,
});
