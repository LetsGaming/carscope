FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY package.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/collector/package.json packages/collector/
RUN npm install --no-audit --no-fund --ignore-scripts
COPY . .
RUN npm -w @carscope/web run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/collector/package.json packages/collector/

# SQLite is built into Node, so nothing here compiles. Chromium is the only
# system dependency, and Playwright installs it with the libraries it needs.
RUN npm install --omit=dev --workspace @carscope/api --include-workspace-root \
      --no-audit --no-fund --ignore-scripts \
 && npx --yes playwright install --with-deps chromium chrome \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY packages ./packages
COPY apps/api ./apps/api
COPY --from=web /build/apps/web/dist ./web

ENV DATA_DIR=/data WEB_ROOT=/app/web PORT=8080 HOST=0.0.0.0 \
    COLLECT_BROWSER_PROFILE_DIR=/data/browser-profile
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
