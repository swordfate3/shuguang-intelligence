# syntax=docker/dockerfile:1
# Override with an approved digest-pinned Node 24 image when stronger reproducibility is needed.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG PI_VERSION=1.3.0
ENV HOME=/home/node \
    PATH=/opt/pi/bin:$PATH \
    DAWN_DATA_DIR=/data \
    NODE_ENV=production

# Pi runs shell/git tools inside the container. No host Docker socket or WSL tools are required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --prefix /opt/pi "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

# Deliberate allow-list COPY: never bake a local model config, token, env file, DB or .git into the image.
WORKDIR /app
COPY package.json ./
COPY packages/dawn/package.json ./packages/dawn/
COPY packages/dawn/src/ ./packages/dawn/src/
COPY packages/pi-extension/package.json ./packages/pi-extension/
COPY packages/pi-extension/src/ ./packages/pi-extension/src/
COPY config/learning-pack.example.json ./config/learning-pack.example.json
COPY docker/ ./docker/
RUN chmod 755 /app/docker/entrypoint.sh \
    && ln -s /app/docker/entrypoint.sh /usr/local/bin/dawn-container \
    && mkdir -p /data /work /home/node/.pi \
    && chown node:node /data /work /home/node/.pi \
    && chmod 700 /data /work /home/node/.pi

USER node
WORKDIR /work
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
