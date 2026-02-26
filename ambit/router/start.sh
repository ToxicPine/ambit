#!/bin/bash
set -e

# =============================================================================
# ambit - Self-Configuring Tailscale Subnet Router
# =============================================================================
# State is persisted to /var/lib/tailscale via Fly volume.
# On first run: authenticates with a pre-minted auth key, advertises routes.
# On restart: reuses existing state, no new device created.
# The router never receives the user's API token — only a single-use,
# tag-scoped auth key that expires after 5 minutes.
# =============================================================================

echo "Router: Enabling IP Forwarding"
echo 'net.ipv4.ip_forward = 1' | tee -a /etc/sysctl.conf
echo 'net.ipv6.conf.all.forwarding = 1' | tee -a /etc/sysctl.conf
sysctl -p /etc/sysctl.conf

PRIVATE_IP=$(grep fly-local-6pn /etc/hosts | awk '{print $1}')

# tailscaled's built-in SOCKS5 proxy routes through the WireGuard tunnel
# directly (no tun device needed). This handles both TCP routing and DNS
# resolution through the tailnet — MagicDNS, split DNS, everything.
echo "Router: Starting Tailscaled with SOCKS5 Proxy on [${PRIVATE_IP}]:1080"
/usr/local/bin/tailscaled \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --socks5-server=[${PRIVATE_IP}]:1080 &

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
  # First run - authenticate with pre-minted auth key
  if [ -z "${TAILSCALE_AUTHKEY}" ]; then
    echo "Router: ERROR - No TAILSCALE_AUTHKEY Provided"
    exit 1
  fi

  echo "Router: Authenticating to Tailscale"
  /usr/local/bin/tailscale up \
    --authkey="${TAILSCALE_AUTHKEY}" \
    --hostname="${FLY_APP_NAME:-ambit}" \
    --advertise-routes="${SUBNET}"
fi

echo "Router: Fully Configured"

# Get Tailscale IPv4 for CoreDNS bind — split DNS queries arrive here
TAILSCALE_IP=$(/usr/local/bin/tailscale ip -4)
echo "Router: Tailscale IP ${TAILSCALE_IP}"

echo "Router: Starting DNS Proxy"

# Generate Corefile for CoreDNS
# Binds to the Fly private IP and the Tailscale IP. Split DNS queries from
# tailnet clients arrive on the Tailscale IP. Does NOT bind to all interfaces,
# so tailscaled's MagicDNS resolver on 100.100.100.100:53 remains unblocked.
#
# Rewrites NETWORK_NAME TLD to .flycast before forwarding to Fly DNS.
# When ROUTER_ID is set, workload app names are suffixed: app.network ->
# app-ROUTER_ID.flycast. This ties workloads to their router and avoids
# name collisions across networks.
if [ -n "${NETWORK_NAME}" ] && [ -n "${ROUTER_ID}" ]; then
  echo "Router: DNS Rewrite *.${NETWORK_NAME} -> *-${ROUTER_ID}.flycast"
  cat > /etc/coredns/Corefile <<EOF
.:53 {
    bind ${PRIVATE_IP} ${TAILSCALE_IP}
    rewrite name regex (.+)\.${NETWORK_NAME}\. {1}-${ROUTER_ID}.flycast. answer auto
    forward . fdaa::3
}
EOF
elif [ -n "${NETWORK_NAME}" ]; then
  echo "Router: DNS Rewrite ${NETWORK_NAME} -> flycast"
  cat > /etc/coredns/Corefile <<EOF
.:53 {
    bind ${PRIVATE_IP} ${TAILSCALE_IP}
    rewrite name suffix .${NETWORK_NAME}. .flycast. answer auto
    forward . fdaa::3
}
EOF
else
  cat > /etc/coredns/Corefile <<EOF
.:53 {
    bind ${PRIVATE_IP} ${TAILSCALE_IP}
    forward . fdaa::3
}
EOF
fi

exec /usr/local/bin/coredns -conf /etc/coredns/Corefile
