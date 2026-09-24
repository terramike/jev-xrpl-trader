FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV NODE_ENV=production MODE=paper NETWORK=testnet
CMD ["bun", "run", "src/cli.ts", "start"]
