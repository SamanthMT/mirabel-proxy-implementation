# Mirabel Proxy Service

A flexible Node.js/Express reverse proxy with two routing modes:
- Segment-based routing via `proxy-map.*.json`
- Host-based routing via Redis (with in-memory cache)

## Features
- Segment-based proxy: first URL segment maps to a target from `proxy-map.dev.json` or `proxy-map.prod.json`
- Host-based proxy: if no segment match, resolve target by `req.hostname` from Redis (cached in-memory)
- Special case for segment `1111`: appends `cnamedomain=<host>` query param before proxying
- Health endpoint, Redis test, and an authenticated save endpoint to store mappings

## Requirements
- Node.js 18+
- Redis Cluster endpoint (TLS)
- Docker (optional)

## Environment Variables
Create a `.env` file in the project root:
```env
# Node env: 'production' loads proxy-map.prod.json, otherwise proxy-map.dev.json
NODE_ENV=development

# App port (default 3000)
PORT=3000

# Redis Cluster connection
REDIS_HOST=your-redis-hostname
REDIS_PORT=6379

# Required to call POST /save
SECRET_KEY=your-shared-secret
```

## Proxy Maps
The proxy map used depends on `NODE_ENV`:
- development → `./proxy-map.dev.json`
- production → `./proxy-map.prod.json`

Example `proxy-map.dev.json`:
```json
{
  "1111": { "target": "https://example-service-1111.dev" },
  "api":  { "target": "https://api.dev.example.com" }
}
```

## How Routing Works
1. Segment-based:
   - First path segment is looked up in the proxy map.
   - If found, request is proxied to `config.target` with that segment stripped.
   - Special case: when the segment is `1111`, the server injects `?cnamedomain=<host>` and then proxies.

2. Host-based (fallback when no segment match):
   - `req.hostname` is used as a key to get the target from Redis (and memoized in an in-memory cache).
   - If found, the request is proxied to `https://<redisTarget>` without path rewrite.
   - If not found, responds with `404` and a message indicating missing mapping.

## API Endpoints
- GET `/health`
  - Returns status and timestamp.
- GET `/redis-test`
  - Pings Redis and returns the response.
- POST `/save`
  - Secured by header `secret_key: <SECRET_KEY>`
  - Body: `{ "subdomain": "<key>", "domainName": "<target-domain>" }`
  - Behavior:
    - If mapping exists in cache or Redis, it is returned and cached if needed.
    - If not, it is saved in Redis and cached in memory.

Example:
```bash
curl -X POST http://localhost:3000/save \
  -H "Content-Type: application/json" \
  -H "secret_key: YOUR_SECRET" \
  -d '{"subdomain":"app.example.com","domainName":"service.internal.example.com"}'
```

## Run Locally
```bash
npm install
npm start
# Server: http://localhost:3000
```

## Docker
The included `Dockerfile` builds and runs the service:
```bash
docker build -t mirabel-proxy .
docker run -p 3000:3000 --env-file .env mirabel-proxy
```

## Notes
- For production, ensure `NODE_ENV=production` and that `proxy-map.prod.json` exists and is correct.
- Redis is used in “cluster” mode with TLS; set `REDIS_HOST` and `REDIS_PORT` accordingly.
- The proxy strips only the first segment for mapped routes; host-based routes keep the full path. 
