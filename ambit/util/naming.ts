import { ROUTER_APP_PREFIX } from "@/util/constants.ts";

export const getRouterAppName = (
  network: string,
  randomSuffix: string,
): string => {
  return `${ROUTER_APP_PREFIX}${network}-${randomSuffix}`;
};

export const getRouterSuffix = (
  routerAppName: string,
  network: string,
): string => {
  const prefix = `${ROUTER_APP_PREFIX}${network}-`;
  return routerAppName.slice(prefix.length);
};

export const getWorkloadAppName = (
  name: string,
  routerId: string,
): string => {
  return `${name}-${routerId}`;
};

export const getRouterTag = (network: string): string => `tag:ambit-${network}`;
