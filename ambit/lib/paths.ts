// =============================================================================
// Path Helpers - Locate Package Resources
// =============================================================================

export const getRouterDockerDir = (): string =>
  new URL("../src/docker/router", import.meta.url).pathname;
