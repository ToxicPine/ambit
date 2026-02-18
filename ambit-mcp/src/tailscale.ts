// =============================================================================
// ambit-mcp: Tailscale API Client
// =============================================================================
// Lightweight Tailscale API client for the MCP server context.
// Unlike the CLI's TailscaleProvider, this throws catchable errors
// instead of calling die() / Deno.exit().
// =============================================================================

const API_BASE = "https://api.tailscale.com/api/v2";

// =============================================================================
// Types
// =============================================================================

export interface TailscaleDevice {
  id: string;
  hostname: string;
  addresses: string[];
  online?: boolean;
  lastSeen?: string;
  advertisedRoutes?: string[];
}

// =============================================================================
// Client Interface
// =============================================================================

export interface TailscaleClient {
  validateApiKey(): Promise<boolean>;
  listDevices(): Promise<TailscaleDevice[]>;
  getDeviceByHostname(hostname: string): Promise<TailscaleDevice | null>;
  deleteDevice(id: string): Promise<void>;
  approveSubnetRoutes(deviceId: string, routes: string[]): Promise<void>;
  setSplitDns(domain: string, nameservers: string[]): Promise<void>;
  clearSplitDns(domain: string): Promise<void>;
  isTagOwnerConfigured(tag: string): Promise<boolean>;
  isAutoApproverConfigured(tag: string): Promise<boolean>;
}

// =============================================================================
// Create Client
// =============================================================================

export function createTailscaleClient(apiKey: string): TailscaleClient {
  const headers = (): HeadersInit => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Basic ${btoa(apiKey + ":")}`,
  });

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | undefined> => {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Tailscale API ${method} ${path}: HTTP ${response.status} – ${text}`,
      );
    }

    const text = await response.text();
    if (!text) return undefined;
    return JSON.parse(text) as T;
  };

  return {
    async validateApiKey(): Promise<boolean> {
      try {
        await request("GET", "/tailnet/-/devices");
        return true;
      } catch {
        return false;
      }
    },

    async listDevices(): Promise<TailscaleDevice[]> {
      const data = await request<{ devices: TailscaleDevice[] }>(
        "GET",
        "/tailnet/-/devices",
      );
      return data?.devices ?? [];
    },

    async getDeviceByHostname(
      hostname: string,
    ): Promise<TailscaleDevice | null> {
      const devices = await this.listDevices();

      // Exact match first (expected with persistent state)
      const exact = devices.find((d) => d.hostname === hostname);
      if (exact) return exact;

      // Fallback: prefix match (Tailscale may add suffix like -1)
      const prefixMatches = devices
        .filter((d) => d.hostname.startsWith(hostname + "-"))
        .sort((a, b) => {
          if (a.online && !b.online) return -1;
          if (!a.online && b.online) return 1;
          const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
          const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
          return bTime - aTime;
        });

      return prefixMatches[0] ?? null;
    },

    async deleteDevice(id: string): Promise<void> {
      await request("DELETE", `/device/${id}`);
    },

    async approveSubnetRoutes(
      deviceId: string,
      routes: string[],
    ): Promise<void> {
      await request("POST", `/device/${deviceId}/routes`, { routes });
    },

    async setSplitDns(
      domain: string,
      nameservers: string[],
    ): Promise<void> {
      await request("PATCH", "/tailnet/-/dns/split-dns", {
        [domain]: nameservers,
      });
    },

    async clearSplitDns(domain: string): Promise<void> {
      await request("PATCH", "/tailnet/-/dns/split-dns", {
        [domain]: null,
      });
    },

    async isTagOwnerConfigured(tag: string): Promise<boolean> {
      try {
        const policy = await request<Record<string, unknown>>(
          "GET",
          "/tailnet/-/acl",
        );
        if (!policy) return false;
        const tagOwners = policy.tagOwners as
          | Record<string, string[]>
          | undefined;
        return tagOwners ? tag in tagOwners : false;
      } catch {
        return false;
      }
    },

    async isAutoApproverConfigured(tag: string): Promise<boolean> {
      try {
        const policy = await request<Record<string, unknown>>(
          "GET",
          "/tailnet/-/acl",
        );
        if (!policy) return false;
        const autoApprovers = policy.autoApprovers as
          | Record<string, unknown>
          | undefined;
        if (!autoApprovers) return false;
        const routes = autoApprovers.routes as
          | Record<string, string[]>
          | undefined;
        if (!routes) return false;
        return Object.values(routes).some(
          (approvers) => Array.isArray(approvers) && approvers.includes(tag),
        );
      } catch {
        return false;
      }
    },
  };
}

// =============================================================================
// Wait for Device (with timeout, throws on timeout)
// =============================================================================

export async function waitForDevice(
  client: TailscaleClient,
  hostname: string,
  timeoutMs: number = 180000,
): Promise<TailscaleDevice> {
  const startTime = Date.now();
  const pollInterval = 5000;

  while (Date.now() - startTime < timeoutMs) {
    const device = await client.getDeviceByHostname(hostname);
    if (device) return device;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for device '${hostname}' to join tailnet (${
      timeoutMs / 1000
    }s)`,
  );
}
