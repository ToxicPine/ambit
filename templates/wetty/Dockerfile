# =============================================================================
# Wetty - Web Terminal (Ubuntu)
# =============================================================================

# --- Build stage: compile wetty from source (npm package has broken frontend) ---
FROM node:22 AS builder

RUN apt-get update && apt-get install -y python3 python3-setuptools build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm

RUN git clone --depth 1 https://github.com/butlerx/wetty.git /build
WORKDIR /build
RUN pnpm install && pnpm build

# --- Runtime stage ---
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages + Node.js
RUN apt-get update && apt-get install -y \
    bash \
    curl \
    wget \
    git \
    vim \
    nano \
    htop \
    tmux \
    jq \
    unzip \
    build-essential \
    python3 \
    python3-setuptools \
    ca-certificates \
    sudo \
    locales \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set up locale
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Install wetty from build stage
COPY --from=builder /build /opt/wetty
WORKDIR /opt/wetty
RUN npm install -g pnpm && pnpm install --prod --ignore-scripts

# Create user with sudo access
RUN useradd -m -s /bin/bash user \
  && usermod -aG sudo user \
  && echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/user

# Save skeleton home for first-boot volume init
RUN cp -a /home/user /etc/skel-user

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 3000

CMD ["/start.sh"]
