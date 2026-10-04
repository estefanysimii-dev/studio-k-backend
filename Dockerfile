FROM rust:1-bookworm AS fivem-builder
WORKDIR /build
COPY server/fivem-preview ./server/fivem-preview
RUN cargo build --manifest-path server/fivem-preview/Cargo.toml --release

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends blender imagemagick && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY tests ./tests
COPY --from=fivem-builder /build/server/fivem-preview/target/release/studio-k-fivem-preview /usr/local/bin/studio-k-fivem-preview
RUN npm run check && npm test
RUN mkdir -p /app/data
ENV HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "server/index.js"]
