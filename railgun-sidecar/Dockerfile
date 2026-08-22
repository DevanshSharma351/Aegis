FROM node:20-alpine

WORKDIR /app

# Install build dependencies required by node-gyp and some snark compilation libs
RUN apk add --no-cache python3 make g++ 

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

EXPOSE 8080

CMD ["node", "dist/server.js"]
