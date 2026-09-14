# `engines.node` do package.json exige >=22.5.0: os dois bancos SQLite do
# projeto (impressoras e histórico de banda) usam `node:sqlite`, que só
# existe a partir do 22.5. A imagem estava em `node:20-alpine` — o build
# passava e o container QUEBRAVA no primeiro import desses módulos.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
