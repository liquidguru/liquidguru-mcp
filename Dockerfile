FROM node:20-alpine

# Install git, docker-cli, and network tools
RUN apk add --no-cache git docker-cli iputils netcat-openbsd bash

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/server.js"]
