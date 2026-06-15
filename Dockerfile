# ─────────────────────────────────────────────────────────────────────────────
# MagoFonte — lancia branch — production Dockerfile
# Multi-stage: builder installs deps, runner is a lean Alpine image.
# ─────────────────────────────────────────────────────────────────────────────

# Stage 1 — install production deps only
FROM node:20-alpine AS builder
WORKDIR /build
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# Stage 2 — lean runtime image
FROM node:20-alpine AS runner

# Non-root user
RUN addgroup -S magofonte && adduser -S magofonte -G magofonte

WORKDIR /app

# Copy deps from builder
COPY --from=builder /build/node_modules ./node_modules

# Copy source
COPY --chown=magofonte:magofonte . .

# Pre-create vault dir so wallet data can persist via a mounted volume
RUN mkdir -p /app/vault && chown magofonte:magofonte /app/vault

ENV NODE_ENV=production \
    PORT=8080

USER magofonte

EXPOSE 8080
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "core/index.js"]
