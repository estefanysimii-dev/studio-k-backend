FROM node:24-bookworm-slim
WORKDIR /rescue
COPY rescue/read-only-export.mjs /rescue/read-only-export.mjs
ENV NODE_ENV=production
CMD ["node", "/rescue/read-only-export.mjs"]
