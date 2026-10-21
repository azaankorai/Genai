FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=10000 DATA_DIR=/var/data
EXPOSE 10000
# The entrypoint initializes the attached disk, then drops root before starting HTTP.
CMD ["node", "scripts/container-entry.mjs"]
