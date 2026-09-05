# ProofWright — container image
#
# Two stages. The dashboard is built with a plain Node image, and the server runs on
# Microsoft's Playwright image, which ships Chromium and its system libraries already
# installed. That choice is not about image size: installing browsers at build time
# means a ~115MB download plus an apt dependency dance that breaks whenever the base
# distribution moves, and the version has to match `playwright` in package.json
# exactly or the client and the browser disagree at runtime in ways that read as
# application faults.
#
# The backend is not compiled. It runs through `tsx`, so `src/` ships as TypeScript.

# ---- stage 1: the dashboard ------------------------------------------------
FROM node:22-bookworm-slim AS web

WORKDIR /build

# Manifests first, so a source-only change does not re-resolve dependencies.
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci

COPY web ./web
RUN cd web && npm run build


# ---- stage 2: the server ---------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-jammy AS server

# Spaces runs the container as a non-root user, and the image's default `pwuser`
# already owns its browser cache. Installing as root and then running as pwuser
# leaves node_modules unreadable, so ownership is set explicitly below.
WORKDIR /app

ENV NODE_ENV=production \
    # Required in the container and nowhere else. The default is 127.0.0.1 so that a
    # developer machine does not expose a browser-driving service to its network; the
    # fix for a container is this line, never a change to the default.
    HOST=0.0.0.0 \
    PORT=7860 \
    # One real Chromium at two viewports per run. Raising this does not degrade
    # gracefully on a small container — it gets OOM-killed the first time two people
    # press Run at once.
    RUN_CONCURRENCY=1 \
    # The browsers are in the image; re-downloading them would double the layer.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY data ./data
COPY tsconfig.json ./
COPY --from=web /build/web/dist ./web/dist

# Writable and ephemeral: a restart is a cold start, which is why the repository
# carries a seeded plan, baseline and heal cache. Without them the first click after
# a restart would need a model call before anything appeared.
RUN mkdir -p data/artifacts && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 7860

# Reports what is actually held in memory rather than re-reading the disk, because
# the bundle is preloaded at boot and a health check that reads the filesystem would
# pass while the served copy was missing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7860/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server/main.ts"]
