FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data
ENV HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "server/index.js"]
