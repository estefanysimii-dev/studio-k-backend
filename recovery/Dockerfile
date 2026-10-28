# Recovery-only image for temporarily mounting the EXISTING Railway volume.
# Does not start the Discord bot or open /app/data, SQLite, or encryption.key.
FROM node:24-alpine
WORKDIR /opt/recovery
COPY recovery/health-server.mjs ./health-server.mjs
EXPOSE 8080
CMD ["node", "/opt/recovery/health-server.mjs"]
