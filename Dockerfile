# syntax=docker/dockerfile:1
# Override with an approved digest-pinned Node 24 image when stronger reproducibility is needed.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ENV DAWN_DATA_DIR=/data \
    NODE_ENV=production

# CA certificates are required for the configured model endpoint.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Deliberate allow-list COPY: never bake a local model config, token, env file, DB or .git into the image.
WORKDIR /app
COPY package.json LICENSE ./
COPY packages/dawn/package.json ./packages/dawn/
COPY packages/dawn/src/ ./packages/dawn/src/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/mcp/src/ ./packages/mcp/src/
COPY config/learning-pack.example.json ./config/learning-pack.example.json
COPY docker/ ./docker/
RUN chmod 755 /app/docker/entrypoint.sh \
    && ln -s /app/docker/entrypoint.sh /usr/local/bin/dawn-container \
    && mkdir -p /data \
    && chown node:node /data \
    && chmod 700 /data

USER node
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
