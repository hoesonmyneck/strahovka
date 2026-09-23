# Stage 1: Build
FROM node:18 as build

WORKDIR /app

COPY package.json vite.config.js ./
RUN npm install

COPY index.html ./
COPY src ./src
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

# Конфиг nginx (HTTP + HTTPS для ЭЦП). Сертификаты монтируются в рантайме
# из ./certs в /etc/nginx/certs (см. docker-compose), в образ не зашиты.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
