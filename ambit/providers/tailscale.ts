// =============================================================================
// Tailscale API Client
// =============================================================================

import { die } from "@/lib/cli.ts";
import {
  type AuthKeyCapabilities,
  createAuthKeyPayload,
  type TailscaleDevice,
  TailscaleDevicesListSchema,
} from "@/schemas/tailscale.ts";

// =============================================================================
// Constants
// =============================================================================

const API_BASE = "https://api.tailscale.com/api/v2";

// =============================================================================
// Tailscale Provider Interface
// =============================================================================

export interface DeviceRoutes {
  advertised: string[];
  enabled: string[];
  unapproved: string[];
}

export interface AclSetResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface TailscaleProvider {
  auth: {
    validateKey(): Promise<boolean>;
    createKey(opts?: AuthKeyCapabilities): Promise<string>;
  };
  devices: {
    list(): Promise<TailscaleDevice[]>;
    getByHostname(hostname: string): Promise<TailscaleDevice | null>;
    delete(id: string): Promise<void>;
  };
  routes: {
    get(deviceId: string): Promise<DeviceRoutes | null>;
    approve(deviceId: string, routes: string[]): Promise<void>;
  };
  dns: {
    getSplit(): Promise<Record<string, string[]>>;
    setSplit(domain: string, nameservers: string[]): Promise<void>;
    clearSplit(domain: string): Promise<void>;
  };
  acl: {
    getPolicy(): Promise<Record<string, unknown> | null>;
    setPolicy(policy: Record<string, unknown>): Promise<AclSetResult>;
    validatePolicy(policy: Record<string, unknown>): Promise<AclSetResult>;
  };
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
  apiKey: string,
  tailnet: string = "-",
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
        body: body ? JSON.stringify(body, null, 2) : undefined,
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

  const provider: TailscaleProvider = {
    auth: {
      async validateKey(): Promise<boolean> {
        const result = await request<unknown>(
          "GET",
          `/tailnet/${tailnet}/devices`,
        );
        return result.ok;
      },

      async createKey(opts?: AuthKeyCapabilities): Promise<string> {
        const payload = createAuthKeyPayload(opts ?? {});
        const result = await request<{ key: string }>(
          "POST",
          `/tailnet/${tailnet}/keys`,
          payload,
        );

        if (!result.ok || !result.data?.key) {
          return die(`Failed to Create Auth Key: ${result.error}`);
        }

        return result.data.key;
      },
    },

    devices: {
      async list(): Promise<TailscaleDevice[]> {
        const result = await request<{ devices: unknown[] }>(
          "GET",
          `/tailnet/${tailnet}/devices`,
        );

        if (!result.ok) {
          return die(`Failed to List Devices: ${result.error}`);
        }

        const parsed = TailscaleDevicesListSchema.safeParse(result.data);
        return parsed.success ? parsed.data.devices : [];
      },

      async getByHostname(
        hostname: string,
      ): Promise<TailscaleDevice | null> {
        const devices = await provider.devices.list();

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

      async delete(id: string): Promise<void> {
        const result = await request<void>("DELETE", `/device/${id}`);
        if (!result.ok) {
          return die(`Failed to Delete Device: ${result.error}`);
        }
      },
    },

    routes: {
      async get(deviceId: string): Promise<DeviceRoutes | null> {
        const result = await request<{
          advertisedRoutes?: string[];
          enabledRoutes?: string[];
        }>("GET", `/device/${deviceId}/routes`);

        if (!result.ok || !result.data) return null;

        const advertised = result.data.advertisedRoutes ?? [];
        const enabled = result.data.enabledRoutes ?? [];
        const enabledSet = new Set(enabled);

        return {
          advertised,
          enabled,
          unapproved: advertised.filter((r) => !enabledSet.has(r)),
        };
      },

      async approve(
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
    },

    dns: {
      async getSplit(): Promise<Record<string, string[]>> {
        const result = await request<Record<string, string[]>>(
          "GET",
          `/tailnet/${tailnet}/dns/split-dns`,
        );
        return result.ok && result.data ? result.data : {};
      },

      async setSplit(domain: string, nameservers: string[]): Promise<void> {
        // PATCH performs partial update - only specified domains are modified
        const result = await request<void>(
          "PATCH",
          `/tailnet/${tailnet}/dns/split-dns`,
          { [domain]: nameservers },
        );

        if (!result.ok) {
          return die(`Failed to Configure Split DNS: ${result.error}`);
        }
      },

      async clearSplit(domain: string): Promise<void> {
        const result = await request<void>(
          "PATCH",
          `/tailnet/${tailnet}/dns/split-dns`,
          { [domain]: null },
        );

        if (!result.ok) {
          return die(`Failed to Clear Split DNS: ${result.error}`);
        }
      },
    },

    acl: {
      async getPolicy(): Promise<Record<string, unknown> | null> {
        const result = await request<Record<string, unknown>>(
          "GET",
          `/tailnet/${tailnet}/acl`,
        );
        if (!result.ok || !result.data) {
          return null;
        }
        return result.data;
      },

      async setPolicy(policy: Record<string, unknown>): Promise<AclSetResult> {
        const result = await request<void>(
          "POST",
          `/tailnet/${tailnet}/acl`,
          policy,
        );
        if (!result.ok) {
          return { ok: false, status: result.status, error: result.error };
        }
        return { ok: true, status: result.status };
      },

      async validatePolicy(
        policy: Record<string, unknown>,
      ): Promise<AclSetResult> {
        const result = await request<Record<string, unknown>>(
          "POST",
          `/tailnet/${tailnet}/acl/validate`,
          policy,
        );
        if (!result.ok) {
          return { ok: false, status: result.status, error: result.error };
        }

        const body = result.data ?? {};
        if (Object.keys(body).length > 0) {
          return {
            ok: false,
            status: result.status,
            error: JSON.stringify(body),
          };
        }
        return { ok: true, status: result.status };
      },
    },
  };

  return provider;
};
