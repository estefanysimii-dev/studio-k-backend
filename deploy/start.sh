#!/bin/sh
set -eu
node /opt/studio-k-deploy/verify-data.mjs "${DATA_DIR:-/app/data}" --require-env
exec node /app/server/index.js
