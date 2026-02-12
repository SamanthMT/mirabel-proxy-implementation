import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import dotenv from "dotenv";
import fs from "fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

dotenv.config();
const app = express();
// app.use(express.json());

app.set("trust proxy", true);

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

// Initialize DynamoDB client
const dynamoDBClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  // AWS credentials will be automatically picked up from:
  // - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  // - IAM role (when running on ECS/EC2)
  // - ~/.aws/credentials (for local development)
});

const docClient = DynamoDBDocumentClient.from(dynamoDBClient);
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

if (!TABLE_NAME) {
  console.error("❌ DYNAMODB_TABLE_NAME environment variable is required");
  process.exit(1);
}

console.log("✅ DynamoDB client initialized");

const memoryCache = new Map();

async function preloadCacheFromDynamoDB() {
  if (memoryCache.size > 0) {
    console.log("Memory cache already has data, skipping preload.");
    return;
  }

  console.log("Loading DynamoDB data into memory cache...");

  try {
    let lastEvaluatedKey = null;
    let totalItems = 0;

    do {
      const scanParams = {
        TableName: TABLE_NAME,
        ProjectionExpression: "subdomain, domainName",
      };
      
      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }
      
      const result = await docClient.send(new ScanCommand(scanParams));

      if (result.Items) {
        for (const item of result.Items) {
          if (item.subdomain && item.domainName) {
            memoryCache.set(item.subdomain, item.domainName);
          }
        }
        totalItems += result.Items.length;
      }

      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`✅ Preloaded ${totalItems} mappings into memory cache.`);
  } catch (err) {
    console.error("❌ Failed to preload DynamoDB cache:", err);
  }
}

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

function extractIPv4(ip) {
  if (!ip) return null;

  // Case: IPv6 with embedded IPv4 → "::ffff:192.168.1.10"
  const ipv4match = ip.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  return ipv4match ? ipv4match[0] : null;
}

function getClientIp(req) {
  let ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress;

  // convert IPv6 → IPv4 if possible
  const ipv4 = extractIPv4(ip);
  return ipv4 || ip;
}

function setForwardedHeaders(proxyReq, req) {
  const ip = getClientIp(req);

  const existing = proxyReq.getHeader("X-Forwarded-For");
  proxyReq.setHeader(
    "X-Forwarded-For",
    existing ? `${existing}, ${ip}` : ip
  );
}

app.use((req, res, next) => {
  const [_, rawSegment = ""] = req.url.split("/");
  const firstSegment = rawSegment.split("?")[0];

  // already has a valid segment
  if (proxyMap[firstSegment]?.target) {
    req._proxySegment = firstSegment;
    return next();
  }

  const referer = req.headers.referer;
  if (!referer) return next();

  try {
    const refUrl = new URL(referer);

    const refParts = refUrl.pathname.split("/").filter(Boolean);
    const refSegment = refParts[0];

    if (!refSegment || !proxyMap[refSegment]?.target) return next();
    if (refUrl.hostname !== req.hostname) return next();

    const pathPart = req.path || "/";
    const queryPart = req.url.includes("?")
      ? "?" + req.url.split("?").slice(1).join("?")
      : "";

    req._proxySegment = refSegment;

    req.url = `/${refSegment}${pathPart}${queryPart}`;
  } catch (_) {}

  next();
});


function createFlexibleProxy() {
  return async (req, res, next) => {
    try {
      
      const [_, rawSegment = ""] = req.url.split("/");
      const firstSegment = req._proxySegment || rawSegment.split("?")[0];
      const config = proxyMap[firstSegment];
      const host = req.hostname;

      if (config?.target) {
        const proxyOptions = {
          target: config.target,
          changeOrigin: true,
          pathRewrite: { [`^/${firstSegment}`]: "" },
          cookieDomainRewrite: host,
          cookiePathRewrite: "/",
          on: {
            proxyReq: (proxyReq, req, res) => {
              try {
                setForwardedHeaders(proxyReq, req);
                forwardRequestBody(proxyReq, req);
              } catch (err) {
                console.error("Error forwarding body:", err);
              }
            },
            proxyRes: (proxyRes, req, res) => {
              const status = proxyRes.statusCode;
              if (status !== 301 && status !== 302 && status !== 307 && status !== 308) return;
              const location = proxyRes.headers["location"];
              if (!location) return;
              try {
                const targetOrigin = new URL(config.target).origin;
                const locUrl = location.startsWith("/") ? new URL(location, config.target) : new URL(location);
                if (locUrl.origin !== targetOrigin) return;
                const pathAndSearch = (locUrl.pathname.replace(/^\//, "") || "") + (locUrl.search || "");
                const protocol = req.get("x-forwarded-proto") || req.protocol;
                const proxyBase = `${protocol}://${req.get("host")}`;
                proxyRes.headers["location"] = pathAndSearch ? `${proxyBase}/${firstSegment}/${pathAndSearch}` : `${proxyBase}/${firstSegment}`;
              } catch (_) {}
            },
          },
        };

        if (firstSegment === "1111") {
          const url = new URL(req.url, `https://${host}`);
          url.searchParams.set("cnamedomain", host);
          req.url = `/${firstSegment}${url.search}`;
        }
        
        if (firstSegment === "3333") {
          const url = new URL(req.url, `https://${host}`);
          url.searchParams.set("isnew", "1");
          const isEqual = req.url.split("?")[0] === `/${firstSegment}`;
          req.url = `${isEqual ? `/${firstSegment}` : req.url}${url.search}`;
        }

        return createProxyMiddleware(proxyOptions)(req, res, next);
      }

      let dynamoTarget = memoryCache.get(host);

      if (!dynamoTarget) {
        try {
          const result = await docClient.send(
            new GetCommand({
              TableName: TABLE_NAME,
              Key: { subdomain: host },
            })
          );
          
          if (result.Item?.domainName) {
            dynamoTarget = result.Item.domainName;
            memoryCache.set(host, dynamoTarget);
          }
        } catch (err) {
          console.error("Error fetching from DynamoDB:", err);
        }
      }

      if (dynamoTarget) {
        return createProxyMiddleware({
          target: `https://${dynamoTarget}`,
          changeOrigin: true,
          pathRewrite: (path) => path,
          cookieDomainRewrite: host,
          cookiePathRewrite: "/",
          on: {
            proxyReq: (proxyReq, req, res) => {
              setForwardedHeaders(proxyReq, req);
            },
          },
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

    
    try {
      const existingMapping = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { subdomain: subdomain },
        })
      );
      
      if (existingMapping.Item?.domainName) {
        memoryCache.set(subdomain, existingMapping.Item.domainName);
        console.log(`Found existing mapping in DynamoDB: ${subdomain} -> ${existingMapping.Item.domainName}`);
        return res.status(200).json({ 
          message: "Mapping already exists in DynamoDB", 
          cached: true 
        });
      }
    } catch (err) {
      console.error("Error checking DynamoDB:", err);
    }

    
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          subdomain: subdomain,
          domainName: domainName,
          updatedAt: new Date().toISOString(),
        },
      })
    );
    
    memoryCache.set(subdomain, domainName);
    console.log(`Saved new mapping: ${subdomain} -> ${domainName}`);

    res.status(200).json({ message: "Mapping saved successfully" });
  } catch (err) {
    console.error("Error saving to DynamoDB:", err);
    res.status(500).json({ 
      error: "Failed to save mapping", 
      details: err.message 
    });
  }
});

app.get("/dynamodb-test", async (req, res) => {
  try {
    // Test DynamoDB connection by attempting to describe the table
    const { DynamoDBClient: TestClient } = await import("@aws-sdk/client-dynamodb");
    const { DescribeTableCommand } = await import("@aws-sdk/client-dynamodb");
    
    const testClient = new TestClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    
    const result = await testClient.send(
      new DescribeTableCommand({ TableName: TABLE_NAME })
    );
    
    res.json({ 
      status: "ok", 
      dynamodb: "connected",
      tableName: TABLE_NAME,
      tableStatus: result.Table?.TableStatus 
    });
  } catch (err) {
    console.error("DynamoDB test error:", err);
    res.status(500).json({ 
      error: "DynamoDB test failed", 
      details: err.message 
    });
  }
});

app.use("/", createFlexibleProxy());

const PORT = process.env.PORT || 3000;

(async () => {
  await preloadCacheFromDynamoDB();
  app.listen(PORT, () => {
    console.log(
      `Proxy server running at http://localhost:${PORT}, ENV=${isProd ? "PROD" : "DEV"}`
    );
  });
})();

