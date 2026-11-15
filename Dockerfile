FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# bcrypt ships a musl prebuild for linux x64/arm64, so this needs no compiler.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 4000
# alpine has no curl; node's fetch does the job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.js"]
