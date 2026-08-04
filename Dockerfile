# Node is PINNED to a digest-less exact version on purpose. This runs on someone else's host (4water's Lyon
# department run the NextCloud box), so "whatever node:22 means today" is not a thing to depend on — a host
# rebuild should never change the runtime under the app.
#
# node:sqlite needs >= 22.13, NOT >= 22.5 as this comment used to say: it was added in 22.5.0 but stayed
# behind --experimental-sqlite until 22.13.0. 22.14 clears that with room to spare, and 22 is the LTS line so
# security updates arrive without a major upgrade. Do not lower this pin below 22.13.
FROM node:22.14-alpine

# No build step, no dependencies, nothing to compile. There is no `npm install` here because there is nothing
# to install — that is the whole point of the zero-dependency rule.
WORKDIR /app

# Copy source only. Everything else is excluded by .dockerignore; see that file for what and why.
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY config ./config
COPY strings ./strings
COPY static ./static

# The data directory is a mount point, owned by the unprivileged user so the app can actually write there.
RUN mkdir -p /data && chown -R node:node /data /app

# Run as the built-in unprivileged user. A scheduling app for 40 volunteers has no business being root, and
# it shares a host with the department's identity provider.
USER node

ENV NODE_ENV=production \
    FOURWATER_DB=/data/4water.db \
    FOURWATER_BACKUP_DIR=/data/backups \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

# The app already answers /healthz without a session, so the probe needs no credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
