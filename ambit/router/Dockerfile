# =============================================================================
# ambit - Tailscale Subnet Router for Fly.io Custom Networks
# =============================================================================

FROM alpine:3.24.2

ARG TAILSCALE_VERSION=1.104.1
ARG COREDNS_VERSION=1.14.7

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    iptables \
    ip6tables

RUN cd /tmp \
    && curl -fsSLo tailscale.tgz "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
    && curl -fsSLo tailscale.sha256 "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz.sha256" \
    && echo "$(cat tailscale.sha256)  tailscale.tgz" | sha256sum -c - \
    && tar -xzf tailscale.tgz -C /usr/local/bin --strip-components=1 \
        tailscale_${TAILSCALE_VERSION}_amd64/tailscale \
        tailscale_${TAILSCALE_VERSION}_amd64/tailscaled \
    && rm tailscale.tgz tailscale.sha256

RUN cd /tmp \
    && curl -fsSLO "https://github.com/coredns/coredns/releases/download/v${COREDNS_VERSION}/coredns_${COREDNS_VERSION}_linux_amd64.tgz" \
    && curl -fsSLO "https://github.com/coredns/coredns/releases/download/v${COREDNS_VERSION}/coredns_${COREDNS_VERSION}_linux_amd64.tgz.sha256" \
    && sha256sum -c coredns_${COREDNS_VERSION}_linux_amd64.tgz.sha256 \
    && tar -xzf coredns_${COREDNS_VERSION}_linux_amd64.tgz \
    && mv coredns /usr/local/bin/coredns \
    && chmod +x /usr/local/bin/coredns \
    && rm coredns_${COREDNS_VERSION}_linux_amd64.tgz coredns_${COREDNS_VERSION}_linux_amd64.tgz.sha256

RUN mkdir -p /var/lib/tailscale /var/run/tailscale /etc/coredns

COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
