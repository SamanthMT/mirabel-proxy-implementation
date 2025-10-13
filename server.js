import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import dotenv from "dotenv";
import fs from "fs";
import Redis from "ioredis";

dotenv.config();
const app = express();
app.use(express.json());

const isProd = process.env.NODE_ENV === "production";

const proxyMapFile = isProd ? "./proxy-map.prod.json" : "./proxy-map.dev.json";
const proxyMap = JSON.parse(fs.readFileSync(proxyMapFile, "utf-8"));

// For local development, use Redis standalone ----> new Redis(process.env.REDIS_HOST, process.env.REDIS_PORT)
// For production, use Redis Cluster ----> new Redis.Cluster([])

const redisClient = new Redis.Cluster(
  [{ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) }],
  {
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: {
      tls: {},
    },
  });

redisClient.on("connect", () => console.log("✅ Connected to Redis "));
redisClient.on("error", (err) => console.error("❌ Redis error:", err));   

const memoryCache = new Map();

function createFlexibleProxy() {
  return async (req, res, next) => {
    try {
      let firstSegment = req.url.split("/")[1];
      const questionMarkIndex = firstSegment.indexOf("?");
      if(questionMarkIndex !== -1){
        firstSegment = firstSegment.substring(0, questionMarkIndex);
      }

      const config = proxyMap[firstSegment];

      if (config?.target) {
        if (firstSegment === "1111") {
          const url = new URL(req.url, `https://${req.headers.host}`);
        
          url.searchParams.set("cnamedomain", req.headers.host);
        
          req.url = `/${firstSegment}${url.search}`;
        
          return createProxyMiddleware({
            target: config.target,
            changeOrigin: true,
            pathRewrite: { [`^/${firstSegment}`]: "" }, 
          })(req, res, next);
        }

        return createProxyMiddleware({
          target: config.target,
          changeOrigin: true,
          pathRewrite: { [`^/${firstSegment}`]: "" },
        })(req, res, next);
      }

      const host = req.hostname;
      
     
      let redisTarget = memoryCache.get(host);
      
     
      if (!redisTarget) {
        redisTarget = await redisClient.get(host);
        
        if (redisTarget) {
          memoryCache.set(host, redisTarget);
        }
      }

      if (redisTarget) {
        return createProxyMiddleware({
          target: `https://${redisTarget}`,
          changeOrigin: true,
          pathRewrite: (path) => path,
        })(req, res, next);
      }

      return res
        .status(404)
        .send(`No proxy target found for host=${host} segment=${firstSegment}`);
    } catch (err) {
      console.error("Proxy error:", err);
      res.status(500).send("Internal Server Error");
    }
  };
}

app.get("/health", (req, res) => {
  res
    .status(200)
    .json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.post("/save", async (req, res) => {
  try {
    const clientSecret = req.headers["secret_key"];
    if (!clientSecret || clientSecret !== process.env.SECRET_KEY) {
      return res.status(403).json({ error: "Forbidden: Invalid SECRET_KEY" });
    }

    const { subdomain, domainName } = req.body;
    if (!subdomain || !domainName) {
      return res.status(400).json({ error: "subdomain and domainName are required" });
    }

    
    if (memoryCache.has(subdomain)) {
      console.log(`Mapping already exists in cache: ${subdomain} -> ${memoryCache.get(subdomain)}`);
      return res.status(200).json({ 
        message: "Mapping already exists in cache", 
        cached: true 
      });
    }

    
    const existingMapping = await redisClient.get(subdomain);
    if (existingMapping) {
      
      memoryCache.set(subdomain, existingMapping);
      console.log(`Found existing mapping in Redis: ${subdomain} -> ${existingMapping}`);
      return res.status(200).json({ 
        message: "Mapping already exists in Redis", 
        cached: true 
      });
    }

    
    await redisClient.set(subdomain, domainName);
    memoryCache.set(subdomain, domainName);
    console.log(`Saved new mapping: ${subdomain} -> ${domainName}`);

    res.status(200).json({ message: "Mapping saved successfully" });
  } catch (err) {
    console.error("Error saving to Redis:", err);
    let msg = "";
    redisClient.ping().then((pong) => {
      msg = pong;
    }).catch((err) => {
      msg = err;
    });

    res.status(500).json({ error: "Failed to save mapping", msg });
  }
});

app.get("/redis-test", async (req, res) => {
  try {
    const pong = await redisClient.ping();
    res.json({ status: "ok", redis: pong });
  } catch (err) {
    console.error("Redis test error:", err);
    res.status(500).json({ error: "Redis test failed", details: err.message });
  }
});

app.use("/", createFlexibleProxy());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `Proxy server running at http://localhost:${PORT}, ENV=${isProd ? "PROD" : "DEV"}`
  );
});
