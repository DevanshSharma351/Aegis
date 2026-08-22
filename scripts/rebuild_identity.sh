#!/bin/bash
export PATH="/tmp/node-v20.11.1-linux-x64/bin:$PATH"
cd "/mnt/c/Users/ARYAN PALIMKAR/Desktop/Aryan/Aegis/identity"
rm -rf node_modules package-lock.json
npm install --legacy-peer-deps
