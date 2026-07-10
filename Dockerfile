FROM oven/bun:1.3-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json bunfig.toml* ./

RUN mkdir -p /app/data && chown -R bun:bun /app

USER bun
EXPOSE 3000

CMD ["bun", "src/index.ts"]
