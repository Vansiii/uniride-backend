FROM node:24-alpine AS construccion
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
COPY --from=construccion /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
