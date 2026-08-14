FROM docker.io/debian:bookworm-slim AS offload-launcher
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY bin/offload-launch.c /tmp/offload-launch.c
RUN gcc -O2 -static -Wall -Wextra -Werror /tmp/offload-launch.c -o /offload-launch

FROM docker.io/cloudflare/sandbox:0.10.3

# One bundled Jingler/pi command runner is shared with owned devices. Provider
# credentials and endpoints are injected per explicit connection at runtime;
# provider-owned harness CLIs and project dependency trees are never shipped.
COPY dist/jingler-device.mjs /opt/jingler/jingler-device.mjs
COPY bin/offload-exec.mjs /opt/jingler/offload-exec.mjs
COPY --from=offload-launcher /offload-launch /opt/jingler/offload-launch
RUN chmod 0555 /opt/jingler/jingler-device.mjs /opt/jingler/offload-exec.mjs /opt/jingler/offload-launch
WORKDIR /workspace
EXPOSE 3000
