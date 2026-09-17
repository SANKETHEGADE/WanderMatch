FROM node:20-alpine AS deps
WORKDIR /srv
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /srv
# Run unprivileged. The node image ships a `node` user; use it.
RUN apk add --no-cache wget
COPY --from=deps /srv/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=20s \
  CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "src/server.js"]
