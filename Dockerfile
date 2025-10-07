# Use Node.js official image
FROM node:18

# Create app directory
WORKDIR /usr/src/app

# Copy package.json first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the app
COPY . .

# Expose the port your server listens on (e.g., 3000)
EXPOSE 3000

# Run the server
CMD ["node", "server.js"]
