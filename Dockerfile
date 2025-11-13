# Multi-stage Dockerfile for production and development

# Base stage with common dependencies
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl curl
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Development stage
FROM node:20-alpine AS development
WORKDIR /app
RUN apk add --no-cache openssl curl git
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# Build stage
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl curl
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --production

# Production stage
FROM node:20-alpine AS production
WORKDIR /app
RUN apk add --no-cache openssl curl dumb-init
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

COPY --from=build --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/dist ./dist
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/config ./config
COPY --from=build --chown=nextjs:nodejs /app/package*.json ./

USER nextjs
EXPOSE 3000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["dumb-init", "node", "dist/main"]