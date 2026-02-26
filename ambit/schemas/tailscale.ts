// =============================================================================
// Tailscale API Response Schemas
// =============================================================================

import { z } from "zod";

// =============================================================================
// Auth Key Schemas
// =============================================================================

export const TailscaleAuthKeySchema = z.object({
  key: z.string(),
  id: z.string().optional(),
  created: z.string().optional(),
  expires: z.string().optional(),
});

export type TailscaleAuthKey = z.infer<typeof TailscaleAuthKeySchema>;

// =============================================================================
// Device Schemas
// =============================================================================

export const TailscaleDeviceSchema = z.object({
  id: z.string(),
  nodeKey: z.string().optional(),
  hostname: z.string(),
  addresses: z.array(z.string()),
  online: z.boolean().optional(),
  lastSeen: z.string().optional(),
  os: z.string().optional(),
  name: z.string().optional(),
  user: z.string().optional(),
  authorized: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  advertisedRoutes: z.array(z.string()).optional(),
  enabledRoutes: z.array(z.string()).optional(),
}).loose();

export type TailscaleDevice = z.infer<typeof TailscaleDeviceSchema>;

export const TailscaleDevicesListSchema = z.object({
  devices: z.array(TailscaleDeviceSchema),
});

export type TailscaleDevicesList = z.infer<typeof TailscaleDevicesListSchema>;

// =============================================================================
// Route Schemas
// =============================================================================

export const TailscaleRoutesSchema = z.object({
  advertisedRoutes: z.array(z.string()).optional(),
  enabledRoutes: z.array(z.string()).optional(),
});

export type TailscaleRoutes = z.infer<typeof TailscaleRoutesSchema>;

// =============================================================================
// DNS Schemas
// =============================================================================

export const TailscaleDnsPreferencesSchema = z.object({
  magicDNS: z.boolean().optional(),
});

export const TailscaleSplitDnsSchema = z.record(
  z.string(),
  z.array(z.string()),
);

export type TailscaleSplitDns = z.infer<typeof TailscaleSplitDnsSchema>;

// =============================================================================
// API Error Schema
// =============================================================================

export const TailscaleErrorSchema = z.object({
  message: z.string(),
});

export type TailscaleError = z.infer<typeof TailscaleErrorSchema>;

// =============================================================================
// Auth Key Capabilities
// =============================================================================

export interface AuthKeyCapabilities {
  reusable?: boolean;
  ephemeral?: boolean;
  preauthorized?: boolean;
  tags?: string[];
}

export const createAuthKeyPayload = (opts: AuthKeyCapabilities): object => {
  const payload: {
    capabilities: {
      devices: {
        create: {
          reusable?: boolean;
          ephemeral?: boolean;
          preauthorized?: boolean;
          tags?: string[];
        };
      };
    };
    expirySeconds?: number;
  } = {
    capabilities: {
      devices: {
        create: {
          reusable: opts.reusable ?? false,
          ephemeral: opts.ephemeral ?? true,
          preauthorized: opts.preauthorized ?? true,
        },
      },
    },
    expirySeconds: 3600, // 1 hour
  };

  if (opts.tags && opts.tags.length > 0) {
    payload.capabilities.devices.create.tags = opts.tags;
  }

  return payload;
};
