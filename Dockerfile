FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY database ./database
CMD ["node", "--experimental-strip-types", "src/bench.ts"]
