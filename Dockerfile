FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Coolify passes SOURCE_COMMIT as a build arg; bake it in so /health reports the live commit.
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
