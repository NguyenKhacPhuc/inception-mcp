FROM oven/bun:1.1-alpine

WORKDIR /app
COPY package.json ./
RUN bun install --production --frozen-lockfile || bun install --production
COPY . .

ENV NODE_ENV=production
EXPOSE 8787
CMD ["bun", "src/server.ts"]
