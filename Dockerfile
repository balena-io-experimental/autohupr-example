FROM node:22-alpine3.20

WORKDIR /usr/src/app

COPY package.json package-lock.json tsconfig.json ./

COPY src/ ./src/

RUN npm install && npm run build && npm prune --omit=dev

CMD [ "node", "./build/main.js" ]
