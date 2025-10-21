import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import dotenv from "dotenv";
import fs from "fs";
import Redis from "ioredis";

dotenv.config();
const app = express();
// app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); 
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, secret_key');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

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

function forwardRequestBody(proxyReq, req) {
  if (!req.body || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return;
  }

  const contentType = req.headers["content-type"];

  if (typeof req.body === "object" && !(req.body instanceof Buffer)) {
    let bodyData;

    if (contentType?.includes("application/json")) {
      bodyData = JSON.stringify(req.body);
    } else if (contentType?.includes("application/x-www-form-urlencoded")) {
      bodyData = new URLSearchParams(req.body).toString();
    } else {
      bodyData = JSON.stringify(req.body);
    }

    proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
    proxyReq.write(bodyData);
  } else if (req.body instanceof Buffer) {
    proxyReq.setHeader("Content-Length", req.body.length);
    proxyReq.write(req.body);
  } else if (typeof req.body === "string") {
    proxyReq.setHeader("Content-Length", Buffer.byteLength(req.body));
    proxyReq.write(req.body);
  }
  proxyReq.end();
}


function createFlexibleProxy() {
  return async (req, res, next) => {
    try {
      
      const [_, rawSegment = ""] = req.url.split("/");
      const firstSegment = rawSegment.split("?")[0];
      const config = proxyMap[firstSegment];
      const host = req.hostname;

      if (config?.target) {
        const proxyOptions = {
          target: config.target,
          changeOrigin: true,
          pathRewrite: { [`^/${firstSegment}`]: "" },
          on: {
            proxyReq: (proxyReq, req, res) => {
              try {
                forwardRequestBody(proxyReq, req);
              } catch (err) {
                console.error("Error forwarding body:", err);
            }
            },
          },
        };

        if (firstSegment === "1111") {
          const url = new URL(req.url, `https://${host}`);
          url.searchParams.set("cnamedomain", host);
          req.url = `${req.url}${url.search}`;
        }

        
        if (firstSegment === "3333") {
          const url = new URL(req.url, `https://${host}`);
          url.searchParams.set("isnew", "1");
          req.url = `${req.url}${url.search}`;
        }

        return createProxyMiddleware(proxyOptions)(req, res, next);
      }

      let redisTarget = memoryCache.get(host);

      if (!redisTarget) {
        redisTarget = await redisClient.get(host);
        if (redisTarget) memoryCache.set(host, redisTarget);
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

app.post("/save", express.json(), async (req, res) => {
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
