FROM node:18-slim

# Install ffmpeg via apt — available on PATH as 'ffmpeg'
RUN apt-get update && apt-get install -y ffmpeg --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3005

CMD ["node", "server.js"]
