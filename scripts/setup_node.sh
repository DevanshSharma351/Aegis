#!/bin/bash
set -e
cd /tmp
if [ ! -d "node-v20.11.1-linux-x64" ]; then
  curl -fsSLO https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz
  tar -xf node-v20.11.1-linux-x64.tar.xz
fi
export PATH="/tmp/node-v20.11.1-linux-x64/bin:$PATH"
node -v
npm -v
