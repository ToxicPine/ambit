// =============================================================================
// Tailscale API Client
// =============================================================================

import { commandExists, die } from "@/lib/cli.ts";
import { runCommand } from "@/lib/command.ts";
import {
  type AuthKeyCapabilities,
  createAuthKeyPayload,
  type TailscaleDevice,
  TailscaleDevicesListSchema,
} from "../schemas/tailscale.ts";

// =============================================================================
// Constants
// =============================================================================

const API_BASE = "https://api.tailscale.com/api/v2";

// =============================================================================
// Tailscale Provider Interface
// =============================================================================

export interface TailscaleProvider {
  validateApiKey(): Promise<boolean>;
  createAuthKey(opts?: AuthKeyCapabilities): Promise<string>;
  listDevices(): Promise<TailscaleDevice[]>;
  getDeviceByHostname(hostname: string): Promise<TailscaleDevice | null>;
  deleteDevice(id: string): Promise<void>;
  approveSubnetRoutes(deviceId: string, routes: string[]): Promise<void>;
  setSplitDns(domain: string, nameservers: string[]): Promise<void>;
  clearSplitDns(domain: string): Promise<void>;
  getPolicyFile(): Promise<Record<string, unknown> | null>;
  isTagOwnerConfigured(tag: string): Promise<boolean>;
  isAutoApproverConfigured(tag: string): Promise<boolean>;
}

// =============================================================================
// API Response Type
// =============================================================================

interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

// =============================================================================
// Create Tailscale Provider
// =============================================================================

export const createTailscaleProvider = (
  tailnet: string,
  apiKey: string,
): TailscaleProvider => {
  const headers = (): HeadersInit => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Basic ${btoa(apiKey + ":")}`,
  });

  const request = async <T>(
    method: string,
    path: string,
    body?: object,
  ): Promise<ApiResponse<T>> => {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          ok: false,
          status: response.status,
          error: text || `HTTP ${response.status}`,
        };
      }

      const text = await response.text();
      if (!text) {
        return { ok: true, status: response.status };
      }

      return { ok: true, status: response.status, data: JSON.parse(text) as T };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const effectiveTailnet = tailnet || "-";

  return {
    async validateApiKey(): Promise<boolean> {
      const result = await request<unknown>(
        "GET",
        `/tailnet/${effectiveTailnet}/devices`,
      );
      return result.ok;
    },

    async createAuthKey(opts?: AuthKeyCapabilities): Promise<string> {
      const payload = createAuthKeyPayload(opts ?? {});
      const result = await request<{ key: string }>(
        "POST",
        `/tailnet/${effectiveTailnet}/keys`,
        payload,
      );

      if (!result.ok || !result.data?.key) {
        return die(`Failed to Create Auth Key: ${result.error}`);
      }

      return result.data.key;
    },

    async listDevices(): Promise<TailscaleDevice[]> {
      const result = await request<{ devices: unknown[] }>(
        "GET",
        `/tailnet/${effectiveTailnet}/devices`,
      );

      if (!result.ok) {
        return die(`Failed to List Devices: ${result.error}`);
      }

      const parsed = TailscaleDevicesListSchema.safeParse(result.data);
      return parsed.success ? parsed.data.devices : [];
    },

    async getDeviceByHostname(
      hostname: string,
    ): Promise<TailscaleDevice | null> {
      const devices = await this.listDevices();

      // Exact match first (expected with persistent state)
      const exact = devices.find((d) => d.hostname === hostname);
      if (exact) return exact;

      // Fallback: find by prefix if Tailscale added suffix (e.g., hostname-1)
      // Prefer online devices, then most recently seen
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
      const result = await request<void>("DELETE", `/device/${id}`);
      if (!result.ok) {
        return die(`Failed to Delete Device: ${result.error}`);
      }
    },

    async approveSubnetRoutes(
      deviceId: string,
      routes: string[],
    ): Promise<void> {
      const result = await request<void>(
        "POST",
        `/device/${deviceId}/routes`,
        { routes },
      );

      if (!result.ok) {
        return die(`Failed to Approve Routes: ${result.error}`);
      }
    },

    async setSplitDns(domain: string, nameservers: string[]): Promise<void> {
      // PATCH performs partial update - only specified domains are modified
      const result = await request<void>(
        "PATCH",
        `/tailnet/${effectiveTailnet}/dns/split-dns`,
        { [domain]: nameservers },
      );

      if (!result.ok) {
        return die(`Failed to Configure Split DNS: ${result.error}`);
      }
    },

    async clearSplitDns(domain: string): Promise<void> {
      const result = await request<void>(
        "PATCH",
        `/tailnet/${effectiveTailnet}/dns/split-dns`,
        { [domain]: null },
      );

      if (!result.ok) {
        return die(`Failed to Clear Split DNS: ${result.error}`);
      }
    },

    async getPolicyFile(): Promise<Record<string, unknown> | null> {
      const result = await request<Record<string, unknown>>(
        "GET",
        `/tailnet/${effectiveTailnet}/acl`,
      );
      if (!result.ok || !result.data) {
        return null;
      }
      return result.data;
    },

    async isTagOwnerConfigured(tag: string): Promise<boolean> {
      const policy = await this.getPolicyFile();
      if (!policy) return false;

      const tagOwners = policy.tagOwners as
        | Record<string, string[]>
        | undefined;
      if (!tagOwners) return false;

      return tag in tagOwners;
    },

    async isAutoApproverConfigured(tag: string): Promise<boolean> {
      const policy = await this.getPolicyFile();
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
    },
  };
};

// =============================================================================
// Wait for Device
// =============================================================================

export const waitForDevice = async (
  provider: TailscaleProvider,
  hostname: string,
  timeoutMs: number = 120000,
): Promise<TailscaleDevice> => {
  const startTime = Date.now();
  const pollInterval = 5000;

  while (Date.now() - startTime < timeoutMs) {
    const device = await provider.getDeviceByHostname(hostname);
    if (device) {
      return device;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return die(`Timeout Waiting for Device '${hostname}'`);
};

// =============================================================================
// Local Tailscale CLI
// =============================================================================

/**
 * Check if the tailscale CLI is installed.
 */
export const isTailscaleInstalled = async (): Promise<boolean> => {
  return await commandExists("tailscale");
};

/**
 * Check if accept-routes is enabled on the local client.
 */
export const isAcceptRoutesEnabled = async (): Promise<boolean> => {
  const result = await runCommand(["tailscale", "debug", "prefs"]);
  return result.json<{ RouteAll?: boolean }>().match({
    ok: (prefs) => prefs.RouteAll === true,
    err: () => false,
  });
};

/**
 * Enable accept-routes on the local client.
 * Returns true if successful, false if it failed (likely permissions).
 */
export const enableAcceptRoutes = async (): Promise<boolean> => {
  const result = await runCommand(["tailscale", "set", "--accept-routes"]);
  return result.ok;
};
