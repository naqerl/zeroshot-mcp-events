# syntax=docker/dockerfile:1
FROM node:22-alpine

# The bridge shells out to the Zeroshot CLI (`zeroshot watch`/`list`), so the
# image ships the upstream CLI. The version IS pinned on purpose: `latest`
# resolves at build time and silently drifts away from the platform's event
# wire format. 16.0.0 rejected the `recordedAt` field the platform added to
# `run watch` frames (serde `deny_unknown_fields`), so the bridge looped on
# "invalid JSON-RPC response: unknown field `recordedAt`". 16.1.0+ understands
# it; 17.x cannot be used because it requires hosted target discovery protocol
# `zeroshot.native-v2-target/v3`, which api.app.zeroshot.sh does not serve
# ("hosted target discovery is incompatible").
# `zsp` on a workstation is only a wrapper that exports ZEROSHOT_API_KEY; here
# the key arrives as an environment variable from a Secret.
ARG ZEROSHOT_VERSION=16.2.0
RUN npm install --global --no-fund --no-audit \
      "@the-open-engine-company/zeroshot@${ZEROSHOT_VERSION}" \
 && zeroshot --version

# Non-root runtime user; the bridge writes nothing to disk.
RUN addgroup -g 10001 zs && adduser -D -u 10001 -G zs -h /home/zs zs

WORKDIR /app
COPY zeroshot-mcp-events.mjs /app/zeroshot-mcp-events.mjs
RUN chmod 0755 /app/zeroshot-mcp-events.mjs && chown -R zs:zs /app

USER 10001:10001
ENV HOME=/home/zs \
    ZSP_BIN=zeroshot

# No secret defaults on purpose: NTFY_TOPIC is required and both tokens must be
# injected at runtime, never baked into the image.
ENTRYPOINT ["node", "/app/zeroshot-mcp-events.mjs"]
CMD ["--help"]
