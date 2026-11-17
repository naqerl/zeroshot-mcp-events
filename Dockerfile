# syntax=docker/dockerfile:1
FROM node:22-alpine

# Non-root runtime user; the bridge writes nothing to disk.
RUN addgroup -g 10001 zs && adduser -D -u 10001 -G zs -h /home/zs zs

WORKDIR /app
COPY zeroshot-mcp-events.mjs /app/zeroshot-mcp-events.mjs
RUN chmod 0755 /app/zeroshot-mcp-events.mjs && chown -R zs:zs /app

USER 10001:10001

# No ENV defaults on purpose: NTFY_TOPIC is required and the token must be
# injected at runtime, never baked into the image.
ENTRYPOINT ["node", "/app/zeroshot-mcp-events.mjs"]
CMD ["--help"]
