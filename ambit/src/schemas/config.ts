// =============================================================================
// Configuration Helpers
// =============================================================================

// =============================================================================
// Derived Values
// =============================================================================

export const getRouterTag = (network: string): string =>
  `tag:ambit-${network}`;

export const extractSubnet = (privateIp: string): string => {
  // privateIp format: fdaa:X:XXXX::Y
  // Extract first 3 hextets and append ::/48
  const parts = privateIp.split(":");
  return `${parts[0]}:${parts[1]}:${parts[2]}::/48`;
};

// =============================================================================
// Config Directory
// =============================================================================

export const getConfigDir = (): string => {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  return `${home}/.config/ambit`;
};
