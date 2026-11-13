FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# bcrypt ships a musl prebuild for linux x64/arm64, so this needs no compiler.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
