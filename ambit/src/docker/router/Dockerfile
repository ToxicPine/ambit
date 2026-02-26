# =============================================================================
# ambit - Tailscale Subnet Router for Fly.io Custom Networks
# =============================================================================

FROM alpine:3.23.3

ARG TAILSCALE_VERSION=1.94.1
ARG COREDNS_VERSION=1.14.1

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    iptables \
    ip6tables

RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
    | tar -xzf - -C /usr/local/bin --strip-components=1 \
    tailscale_${TAILSCALE_VERSION}_amd64/tailscale \
    tailscale_${TAILSCALE_VERSION}_amd64/tailscaled

RUN cd /tmp \
    && curl -fsSL "https://github.com/coredns/coredns/releases/download/v${COREDNS_VERSION}/coredns_${COREDNS_VERSION}_linux_amd64.tgz" | tar -xzf - \
    && mv coredns /usr/local/bin/coredns \
    && chmod +x /usr/local/bin/coredns

RUN mkdir -p /var/lib/tailscale /var/run/tailscale /etc/coredns

COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
