FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY server.js .
COPY index.html .
COPY user-spots.json .
COPY images/ ./images/
EXPOSE 5000
CMD ["node", "server.js"]
