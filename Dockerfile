FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY server.js README.md styles.css ./

CMD ["node", "server.js"]
