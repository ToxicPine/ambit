// =============================================================================
// Constants - Shared Magic Values
// =============================================================================

// =============================================================================
// Router / App Identity
// =============================================================================

export const ROUTER_APP_PREFIX = "ambit-";

export const DEFAULT_FLY_NETWORK = "default";

export const ROUTER_DOCKER_DIR = new URL("../router", import.meta.url)
  .pathname;

// =============================================================================
// Networking
// =============================================================================

export const SOCKS_PROXY_PORT = 1080;

// =============================================================================
// Tailscale
// =============================================================================

export const TAILSCALE_API_KEY_PREFIX = "tskey-api-";

export const ENV_TAILSCALE_API_KEY = "TAILSCALE_API_KEY";

// =============================================================================
// External URLs
// =============================================================================

export const FLYCTL_INSTALL_URL = "https://fly.io/docs/flyctl/install/";

// =============================================================================
// Fly.io Secret Names (set on router machines)
// =============================================================================

export const SECRET_TAILSCALE_AUTHKEY = "TAILSCALE_AUTHKEY";
export const SECRET_NETWORK_NAME = "NETWORK_NAME";
export const SECRET_ROUTER_ID = "ROUTER_ID";

// =============================================================================
// Fly.io Secret Names (set on workload machines)
// =============================================================================

export const SECRET_AMBIT_OUTBOUND_PROXY = "AMBIT_OUTBOUND_PROXY";
