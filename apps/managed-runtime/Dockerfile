FROM docker.io/cloudflare/sandbox:0.10.3

# One bundled Jingler/pi command runner is shared with owned devices. Provider
# credentials and endpoints are injected per explicit connection at runtime;
# provider-owned harness CLIs and project dependency trees are never shipped.
COPY dist/jingler-device.mjs /opt/jingler/jingler-device.mjs
COPY bin/offload-exec.mjs /opt/jingler/offload-exec.mjs
RUN chmod 0555 /opt/jingler/jingler-device.mjs /opt/jingler/offload-exec.mjs
WORKDIR /workspace
EXPOSE 3000
