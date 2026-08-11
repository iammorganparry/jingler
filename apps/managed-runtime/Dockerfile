FROM docker.io/cloudflare/sandbox:0.10.3

# One bundled Jingler command runner is shared with owned devices. The Codex
# package is the only provider dependency in the initial allowlisted rollout;
# project node_modules remain lazy and are never baked into or checkpointed from
# a workspace.
COPY dist/jingler-device.mjs /opt/jingler/jingler-device.mjs
RUN npm install --global --omit=dev @openai/codex@0.144.1 \
  && npm cache clean --force \
  && chmod 0555 /opt/jingler/jingler-device.mjs
WORKDIR /workspace
EXPOSE 3000
