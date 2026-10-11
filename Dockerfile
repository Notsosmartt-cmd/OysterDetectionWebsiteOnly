# 1. Build stage
FROM node:18-alpine AS build-stage
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install
COPY . .
RUN yarn build

# 2. Production stage (serve with Nginx)
FROM nginx:alpine AS production-stage
COPY --from=build-stage /app/dist /usr/share/nginx/html
# Custom Nginx config: cross-origin isolation headers (multi-threaded WASM) + gzip.
# Still listens on port 80, same as the stock image.
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
