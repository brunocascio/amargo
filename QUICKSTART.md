# 🚀 Quick Start Checklist

## Prerequisites
- [ ] Node.js 20+ installed
- [ ] Docker Desktop running
- [ ] Git installed

## Setup Steps

### 1. Install & Configure
```bash
# Install dependencies
npm install

# Copy environment file (if not exists)
cp .env.example .env
```

### 2. Start Infrastructure
```bash
# Start PostgreSQL + MinIO + Redis
docker compose up -d

# Verify services are running
docker compose ps
```

Expected output:
- ✅ postgres (healthy)
- ✅ minio (healthy)
- ✅ redis (healthy)
- ✅ minio-setup (completed)

### 3. Database Setup
```bash
# Generate Prisma client
npx prisma generate

# Create and apply initial migration
npx prisma migrate dev --name init
```

### 4. Start Application
```bash
# Development mode with hot reload
npm run start:dev
```

## ✅ Verification

### Test Endpoints
```bash
# Health check
curl http://localhost:3000/health

# Admin UI (open in browser)
open http://localhost:3000/admin

# MinIO Console (open in browser)
open http://localhost:9001
# Login: amargo / amargo123
```

### Test NPM Proxy

**Option 1: Project-specific registry**
```bash
# In a test project directory
npm config set registry http://localhost:3000/npm
npm install express
```

**Option 2: One-time test**
```bash
npm install express --registry http://localhost:3000/npm
```

**Verify caching:**
1. First install → Check logs for "Cache MISS"
2. Delete node_modules
3. Install again → Check logs for "Cache HIT"

### Check MinIO
1. Open http://localhost:9001
2. Login: `amargo` / `amargo123`
3. Navigate to `amargo-artifacts` bucket
4. Look for `repositories/npm/...` directories

### Check Database
```bash
# Open Prisma Studio
npx prisma studio
```

Browse:
- `Repository` → Should have "npm" entry
- `Artifact` → Should have cached packages
- `CacheEntry` → Should have expiration times
- `DownloadStats` → Should have download records

## 🎯 What Should Work

### NPM Proxy Features
- [x] Package metadata: `GET /npm/express`
- [x] Tarball download: `GET /npm/express/-/express-4.18.2.tgz`
- [x] Cache HIT on second request
- [x] HTTP cache headers (Cache-Control, ETag)
- [x] X-Amargo-Cache header (HIT/MISS)
- [x] Background storage while streaming to client
- [x] SHA256 checksum calculation
- [x] Download statistics tracking

### Admin Features
- [x] Health check endpoint
- [x] Admin UI showing YAML config
- [x] Read-only configuration display

### Background Jobs
- [x] Cache cleanup service (runs every hour by default)
- [x] TTL-based expiration
- [x] Automatic artifact deletion

## 📊 Expected Log Output

When starting the app, you should see:
```
[Nest] INFO [AmargoConfigService] Initialized storage adapter: minio
[Nest] INFO [AmargoConfigService] Default storage adapter set to: minio
[Nest] INFO [PrismaService] Database connected successfully
[Nest] INFO [S3StorageAdapter] S3StorageAdapter initialized for bucket: amargo-artifacts at http://localhost:9000
[Nest] INFO [CacheCleanupService] Starting cache cleanup job (interval: 3600s)
[Nest] INFO [NestApplication] Nest application successfully started
[Nest] INFO Amargo running on http://localhost:3000
```

When installing a package (first time):
```
[Nest] DEBUG [NpmController] Fetching tarball: express@4.18.2
[Nest] DEBUG [NpmController] Cache MISS: express@4.18.2
[Nest] LOG [ArtifactService] Stored artifact express@4.18.2 in repository npm
[Nest] LOG [NpmController] Cached express@4.18.2
```

When installing same package again:
```
[Nest] DEBUG [NpmController] Fetching tarball: express@4.18.2
[Nest] DEBUG [NpmController] Cache HIT: express@4.18.2
```

## 🐛 Troubleshooting

### Docker services not starting
```bash
# Check Docker is running
docker info

# Check logs
docker compose logs postgres
docker compose logs minio
```

### Prisma migration fails
```bash
# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Then run migrations again
npx prisma migrate dev --name init
```

### MinIO connection error
```bash
# Check MinIO is running
docker compose ps minio

# Check MinIO logs
docker compose logs minio

# Verify bucket was created
docker compose logs minio-setup
```

### NPM proxy not working
```bash
# Check the registry setting
npm config get registry

# Should output: http://localhost:3000/npm

# Reset to default
npm config delete registry
```

### App won't start
```bash
# Check if port 3000 is already in use
lsof -ti:3000

# Kill process if needed
kill -9 $(lsof -ti:3000)

# Check node_modules
rm -rf node_modules package-lock.json
npm install
```

## 🎨 Optional: VS Code Tasks

Add to `.vscode/tasks.json`:
```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Start Amargo Dev",
      "type": "npm",
      "script": "start:dev",
      "problemMatcher": [],
      "isBackground": true
    },
    {
      "label": "Start Docker Services",
      "type": "shell",
      "command": "docker compose up -d",
      "problemMatcher": []
    },
    {
      "label": "Prisma Studio",
      "type": "shell",
      "command": "npx prisma studio",
      "problemMatcher": [],
      "isBackground": true
    }
  ]
}
```

## 📚 Next Steps

Once everything is working:

1. **Test different packages**:
   ```bash
   npm install lodash --registry http://localhost:3000/npm
   npm install react --registry http://localhost:3000/npm
   ```

2. **Monitor cache**:
   - Watch MinIO console for new files
   - Check Prisma Studio for new artifacts
   - Monitor logs for HIT/MISS patterns

3. **Test TTL expiration**:
   - Edit `config/amargo.yaml` → Set `cacheTtl: 60` (1 minute)
   - Restart app
   - Install package
   - Wait 2 minutes
   - Check logs for cache cleanup

4. **Test horizontal scaling**:
   - Start second instance on different port
   - Both should share same PostgreSQL + MinIO
   - Both should serve cached artifacts

## 🎉 Success Criteria

You know it's working when:
- ✅ Health endpoint returns `{ status: 'ok' }`
- ✅ Admin UI shows your configuration
- ✅ npm install downloads through Amargo
- ✅ Second install is faster (cache HIT)
- ✅ MinIO shows artifacts in bucket
- ✅ Prisma Studio shows artifact records
- ✅ Logs show "Cache HIT" on repeat downloads

---

**Ready to go!** If you encounter any issues, check `IMPLEMENTATION.md` for detailed architecture info.
