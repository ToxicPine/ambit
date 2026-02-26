#!/bin/bash
set -e

# =============================================================================
# ambit - Self-Configuring Tailscale Subnet Router
# =============================================================================
# State is persisted to /var/lib/tailscale via Fly volume.
# On first run: creates auth key (with tags), authenticates, approves routes.
# On restart: reuses existing state, no new device created.
# =============================================================================

echo "Router: Enabling IP Forwarding"
echo 'net.ipv4.ip_forward = 1' | tee -a /etc/sysctl.conf
echo 'net.ipv6.conf.all.forwarding = 1' | tee -a /etc/sysctl.conf
sysctl -p /etc/sysctl.conf

echo "Router: Starting Tailscaled"
/usr/local/bin/tailscaled \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock &

# Wait for tailscaled to be ready
sleep 3

echo "Router: Extracting Fly.io Subnet"
SUBNET=$(grep fly-local-6pn /etc/hosts | awk '{print $1}' | cut -d: -f1-3)::/48
echo "Router: Subnet ${SUBNET}"

if /usr/local/bin/tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' > /dev/null 2>&1; then
  echo "Router: Already Authenticated (Using Persisted State)"

  /usr/local/bin/tailscale up \
    --hostname="${FLY_APP_NAME:-ambit}" \
    --advertise-routes="${SUBNET}"
else
  # First run - need to authenticate
  if [ -n "${TAILSCALE_API_TOKEN}" ]; then
    echo "Router: Creating Auth Key (First Run)"

    TAGS_JSON="[]"
    if [ -n "${TAILSCALE_TAGS}" ]; then
      TAGS_JSON=$(echo "${TAILSCALE_TAGS}" | jq -R 'split(",")')
    fi

    AUTH_KEY_RESPONSE=$(curl -s -X POST \
      -u "${TAILSCALE_API_TOKEN}:" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --argjson tags "${TAGS_JSON}" \
        '{
          capabilities: { devices: { create: {
            reusable: false,
            ephemeral: false,
            preauthorized: true,
            tags: $tags
          }}},
          expirySeconds: 300
        }' | jq 'if .capabilities.devices.create.tags == [] then .capabilities.devices.create |= del(.tags) else . end')" \
      "https://api.tailscale.com/api/v2/tailnet/-/keys")

    TAILSCALE_AUTHKEY=$(echo "${AUTH_KEY_RESPONSE}" | jq -r '.key')

    if [ -z "${TAILSCALE_AUTHKEY}" ] || [ "${TAILSCALE_AUTHKEY}" = "null" ]; then
      echo "Router: ERROR - Failed to Create Auth Key"
      echo "${AUTH_KEY_RESPONSE}"
      exit 1
    fi

    echo "Router: Auth Key Created"
  elif [ -z "${TAILSCALE_AUTHKEY}" ]; then
    echo "Router: ERROR - No TAILSCALE_API_TOKEN or TAILSCALE_AUTHKEY Provided"
    exit 1
  fi

  echo "Router: Authenticating to Tailscale"
  /usr/local/bin/tailscale up \
    --authkey="${TAILSCALE_AUTHKEY}" \
    --hostname="${FLY_APP_NAME:-ambit}" \
    --advertise-routes="${SUBNET}"
fi

echo "Router: Getting Node Key"
NODE_KEY=$(/usr/local/bin/tailscale status --json | jq -r '.Self.PublicKey')
echo "Router: Node Key ${NODE_KEY}"

# Self-approve routes if we have API access
# This is a fallback — if the user has autoApprovers configured in their
# Tailscale policy file, routes are approved automatically and this block
# is a no-op (routes are already enabled).
if [ -n "${TAILSCALE_API_TOKEN}" ]; then
  echo "Router: Finding Device ID"

  DEVICES_RESPONSE=$(curl -s \
    -u "${TAILSCALE_API_TOKEN}:" \
    "https://api.tailscale.com/api/v2/tailnet/-/devices")

  DEVICE_ID=$(echo "${DEVICES_RESPONSE}" | jq -r ".devices[] | select(.nodeKey == \"${NODE_KEY}\") | .id")

  if [ -n "${DEVICE_ID}" ] && [ "${DEVICE_ID}" != "null" ]; then
    echo "Router: Device ID ${DEVICE_ID}"
    echo "Router: Approving Subnet Routes"

    curl -s -X POST \
      -u "${TAILSCALE_API_TOKEN}:" \
      -H "Content-Type: application/json" \
      -d "{\"routes\": [\"${SUBNET}\"]}" \
      "https://api.tailscale.com/api/v2/device/${DEVICE_ID}/routes" > /dev/null

    echo "Router: Routes Approved"
  else
    echo "Router: WARNING - Could Not Find Device ID"
    echo "Router: Routes May Need Manual Approval"
  fi
fi

echo "Router: Fully Configured"

# Start SOCKS5 proxy for bidirectional tailnet access
PRIVATE_IP=$(grep fly-local-6pn /etc/hosts | awk '{print $1}')
echo "Router: Starting SOCKS5 Proxy on [${PRIVATE_IP}]:1080"
/usr/local/bin/microsocks -i "$PRIVATE_IP" -p 1080 &

echo "Router: Starting DNS Proxy"

# Generate Corefile for CoreDNS
# Rewrites NETWORK_NAME TLD to .flycast before forwarding to Fly DNS.
# When ROUTER_ID is set, workload app names are suffixed: app.network ->
# app-ROUTER_ID.flycast. This ties workloads to their router and avoids
# name collisions across networks.
# .flycast resolves to the Flycast address (private_v6) which routes through
# Fly Proxy — enabling autostart/autostop and load balancing. The Flycast IP
# is within the network's /48 subnet so it's routable through the tailnet.
if [ -n "${NETWORK_NAME}" ] && [ -n "${ROUTER_ID}" ]; then
  echo "Router: DNS Rewrite *.${NETWORK_NAME} -> *-${ROUTER_ID}.flycast"
  cat > /etc/coredns/Corefile <<EOF
.:53 {
    rewrite name regex (.+)\.${NETWORK_NAME}\. {1}-${ROUTER_ID}.flycast. answer auto
    forward . fdaa::3
}
EOF
elif [ -n "${NETWORK_NAME}" ]; then
  echo "Router: DNS Rewrite ${NETWORK_NAME} -> flycast"
  cat > /etc/coredns/Corefile <<EOF
.:53 {
    rewrite name suffix .${NETWORK_NAME}. .flycast. answer auto
    forward . fdaa::3
}
EOF
else
  cat > /etc/coredns/Corefile <<EOF
.:53 {
    forward . fdaa::3
}
EOF
fi

exec /usr/local/bin/coredns -conf /etc/coredns/Corefile
