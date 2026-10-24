# Production image: build the frontend, then run the Node server (no runtime dependencies).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm test

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8069 MIZAN_DB=/data/mizan.sqlite
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8069
CMD ["node", "server/index.js"]
