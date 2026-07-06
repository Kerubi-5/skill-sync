FROM node:22-slim

ARG TARGETARCH

# git + gh CLI. gh is installed from its official release tarball rather
# than the cli.github.com apt repo, which has proven flaky to resolve in
# Docker builds (its Release file 404s intermittently).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates \
    && GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
        | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/') \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
        -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv /tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz /tmp/gh_${GH_VERSION}_linux_${TARGETARCH} \
    && apt-get remove -y curl \
    && rm -rf /var/lib/apt/lists/*

COPY bin/skill-sync.mjs /app/bin/skill-sync.mjs
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# CI runners mount the checked-out repo here (GitHub Actions' default
# GITHUB_WORKSPACE is /github/workspace for container actions).
WORKDIR /github/workspace

ENTRYPOINT ["/app/entrypoint.sh"]
