// =============================================================================
// Resolve - Org Resolution Helper
// =============================================================================

import { prompt } from "../lib/cli.ts";
import type { Output } from "../lib/output.ts";
import type { FlyProvider } from "./providers/fly.ts";

// =============================================================================
// Resolve Org
// =============================================================================

/**
 * Resolve Fly.io organization: --org flag → single org auto-select → prompt.
 */
export const resolveOrg = async (
  fly: FlyProvider,
  args: { org?: string; json?: boolean },
  out: Output<Record<string, unknown>>,
): Promise<string> => {
  if (args.org) return args.org;

  if (args.json) {
    return out.die("--org Is Required in JSON Mode");
  }

  const orgs = await fly.listOrgs();
  const orgSlugs = Object.keys(orgs);

  if (orgSlugs.length === 0) {
    return out.die("No Fly.io Organizations Found");
  }

  if (orgSlugs.length === 1) {
    out.ok(`Using Organization: ${orgSlugs[0]}`);
    return orgSlugs[0];
  }

  out.text("Available Organizations:");
  for (const [slug, name] of Object.entries(orgs)) {
    out.text(`  ${slug} - ${name}`);
  }
  const org = await prompt("Organization Slug: ");
  if (!orgSlugs.includes(org)) {
    return out.die(`Invalid Organization: ${org}`);
  }

  return org;
};
