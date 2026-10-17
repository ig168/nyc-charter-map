# Stage 1: bundle the React front end (web/src → public/app/app.js)
FROM node:22-alpine AS web
WORKDIR /src
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY web ./web
COPY public ./public
COPY scripts/build-web.js ./scripts/build-web.js
RUN node scripts/build-web.js

# Stage 2: the server — Node built-ins only, no runtime dependencies
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY . .
COPY --from=web /src/public/app ./public/app
# Fail the build if the seed data is invalid (DATA-01)
RUN node scripts/validate-seed.js
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server.js"]
