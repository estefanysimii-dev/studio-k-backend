FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3210 DATA_DIR=/app/data
EXPOSE 3210
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
