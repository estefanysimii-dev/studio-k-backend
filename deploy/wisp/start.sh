#!/bin/sh
set -eu

cd /home/container/app
: "${SERVER_PORT:?Wispbyte SERVER_PORT is required}"
export PORT="$SERVER_PORT"
export HOST=0.0.0.0
export DATA_DIR=/home/container/data
export OMP_NUM_THREADS=1
export OPENBLAS_NUM_THREADS=1

env_file=/home/container/.env
tools_env=/home/container/.studio-host-tools/active-env.sh
if [ ! -f "$env_file" ] || [ -L "$env_file" ]; then
  echo 'Private runtime environment is missing or unsafe.' >&2
  exit 1
fi
if [ ! -f "$tools_env" ] || [ -L "$tools_env" ]; then
  echo 'Validated converter environment is missing or unsafe.' >&2
  exit 1
fi
chmod 600 "$env_file"
. "$tools_env"
export PATH="/home/container:$PATH"
for converter in blender convert studio-k-fivem-preview; do
  if ! command -v "$converter" >/dev/null 2>&1; then
    echo "Required converter is missing: $converter" >&2
    exit 1
  fi
done

/usr/local/bin/node --no-warnings --env-file="$env_file" deploy/verify-data.mjs "$DATA_DIR" --require-env
exec /usr/local/bin/node --no-warnings --env-file="$env_file" server/index.js
