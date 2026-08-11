FROM docker.io/cloudflare/sandbox:0.10.3

# One bundled Jingler command runner is shared with owned devices. The Codex
# provider CLIs are pinned in the image; project node_modules remain lazy and
# are never baked into or checkpointed from a workspace.
COPY dist/jingler-device.mjs /opt/jingler/jingler-device.mjs
RUN npm install --global --omit=dev \
      @openai/codex@0.147.0 \
      @anthropic-ai/claude-code@2.1.227 \
  && npm cache clean --force \
  && chmod 0555 /opt/jingler/jingler-device.mjs
WORKDIR /workspace
EXPOSE 3000
