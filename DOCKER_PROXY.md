# Docker Registry Proxy - Testing Guide

## Overview

Amargo now supports Docker Registry API v2 with pull-through caching for container images.

## How It Works

### Architecture

```
Docker Client → Amargo (/v2) → Docker Hub
                  ↓
              Cache in MinIO
              (manifests + blobs)
```

### Endpoints

- **Ping**: `GET /v2/` - Version check
- **Manifests**: `GET/HEAD /v2/:name/manifests/:reference`
- **Blobs**: `GET/HEAD /v2/:name/blobs/:digest`

### Caching Strategy

1. **Manifests**: JSON metadata describing image layers
   - Cached with key: `{image}:manifest:{tag}`
   - Small files (~few KB)
   - TTL: 30 minutes (default)

2. **Blobs**: Actual layer data (compressed tar files)
   - Cached with key: `{image}:blob:{sha256:digest}`
   - Large files (can be hundreds of MB)
   - TTL: 30 minutes (default)
   - Immutable (content-addressable by digest)

### Authentication

- Amargo automatically obtains Docker Hub tokens
- No authentication required from client for public images
- Private images: not yet supported (coming soon)

## Setup

### 1. Configure Docker Daemon

Edit Docker daemon config to use Amargo as a registry mirror.

**macOS/Linux** (`/etc/docker/daemon.json` or `~/.docker/daemon.json`):
```json
{
  "registry-mirrors": ["http://localhost:3000"],
  "insecure-registries": ["localhost:3000"]
}
```

**Docker Desktop**:
1. Open Docker Desktop → Settings → Docker Engine
2. Add configuration:
```json
{
  "registry-mirrors": ["http://localhost:3000"],
  "insecure-registries": ["localhost:3000"]
}
```
3. Click "Apply & Restart"

### 2. Restart Docker

```bash
# Linux
sudo systemctl restart docker

# macOS/Windows Docker Desktop
# Use GUI to restart or:
osascript -e 'quit app "Docker"'
open -a Docker
```

### 3. Verify Amargo is Running

```bash
# Check v2 endpoint
curl http://localhost:3000/v2/
# Should return: {}
# Header: Docker-Distribution-API-Version: registry/2.0

# Check health
curl http://localhost:3000/health
```

## Testing

### Test 1: Pull a Small Official Image

```bash
# Pull nginx (official image)
docker pull nginx:alpine

# First pull: Cache MISS (proxied from Docker Hub)
# Subsequent pulls: Cache HIT (served from MinIO)
```

**Check Amargo logs**:
```
[DockerController] Cache MISS: manifest library/nginx:alpine
[DockerController] Cached manifest library/nginx:alpine
[DockerController] Cache MISS: blob sha256:...
[DockerController] Cached blob sha256:...
```

### Test 2: Pull Again (Cache HIT)

```bash
# Remove local image
docker rmi nginx:alpine

# Pull again
docker pull nginx:alpine

# Should be faster - served from cache
```

**Check Amargo logs**:
```
[DockerController] Cache HIT: manifest library/nginx:alpine
[DockerController] Cache HIT: blob sha256:...
```

### Test 3: Non-Official Image

```bash
# Pull a user/org image
docker pull grafana/grafana:latest
```

### Test 4: Verify Storage

1. **Check MinIO Console**:
   - Open http://localhost:9001
   - Login: `amargo` / `amargo123`
   - Navigate to bucket: `amargo-artifacts`
   - Look for: `repositories/docker/`

2. **Check Database**:
   ```bash
   npx prisma studio
   ```
   - Open `Artifact` table
   - Filter by: `name contains "manifest"` or `name contains "blob"`
   - Should see cached manifests and blobs

3. **Check via API**:
   ```bash
   # Get manifest (should return cached version)
   curl -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
        http://localhost:3000/v2/library/nginx/manifests/alpine
   ```

## Cache Headers

Amargo returns proper Docker headers:

- **X-Amargo-Cache**: `HIT` or `MISS`
- **Docker-Content-Digest**: `sha256:...`
- **Content-Type**: 
  - Manifests: `application/vnd.docker.distribution.manifest.v2+json`
  - Blobs: `application/octet-stream`

## Troubleshooting

### Docker Client Can't Connect

**Error**: `Error response from daemon: Get "http://localhost:3000/v2/": dial tcp: connect: connection refused`

**Fix**:
1. Check Amargo is running: `curl http://localhost:3000/health`
2. Verify Docker daemon.json has correct config
3. Restart Docker

### 401 Unauthorized

**Error**: `unauthorized: authentication required`

**Fix**:
- Add `"insecure-registries": ["localhost:3000"]` to daemon.json
- Restart Docker

### Slow Initial Pull

**Expected**: First pull is slow (fetching from Docker Hub)
**Expected**: Subsequent pulls are fast (served from cache)

If BOTH are slow:
- Check network connectivity
- Check Amargo logs for errors
- Verify MinIO is accessible

### Image Not Found

**Error**: `manifest for X not found`

**Possible causes**:
1. Image doesn't exist on Docker Hub
2. Typo in image name
3. Private image (not yet supported)

Check Amargo logs for upstream response.

### Cache Not Working

**Symptoms**: Every pull shows "Cache MISS"

**Debug**:
```bash
# Check if artifacts are being stored
npx prisma studio
# Look at Artifact table

# Check MinIO
# Open http://localhost:9001
# Verify files exist in amargo-artifacts bucket

# Check TTL hasn't expired
# config/amargo.yaml → repositories.docker.cacheTtl
```

## Advanced Usage

### Pull Specific Digest

```bash
# Pull by digest (immutable)
docker pull nginx@sha256:4c0fdaa8b6341bfdeca5f18f7837462c80cff90527ee35ef185571e1c327beac
```

### Inspect Manifest

```bash
# Get manifest as JSON
curl -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
     http://localhost:3000/v2/library/nginx/manifests/latest | jq
```

### Check Blob

```bash
# HEAD request for blob
curl -I http://localhost:3000/v2/library/nginx/blobs/sha256:abc123...
```

## Performance Metrics

### Cache HIT Performance

- **Manifest**: ~10-50ms (small JSON)
- **Blob**: ~100-500ms (depends on size, served from MinIO)

### Cache MISS Performance

- **Manifest**: ~500-2000ms (fetch from Docker Hub + cache)
- **Blob**: ~10-60s (depends on size, streamed from Docker Hub + cached)

### Storage Estimates

- **Nginx Alpine**: ~7MB (5 layers)
- **Node.js Latest**: ~300MB (multiple layers)
- **Ubuntu Latest**: ~30MB
- **Large app**: Can be 1GB+

**Recommendation**: Configure larger TTL for Docker in `config/amargo.yaml`:
```yaml
repositories:
  docker:
    cacheTtl: 86400  # 24 hours
```

## What's Cached

### Per Image Pull

1. **Manifest** (JSON, ~2-10KB):
   - Image configuration
   - Layer digests
   - Platform info

2. **Blobs** (tar.gz, varies):
   - Base OS layer (largest, 20-100MB)
   - Package layer
   - App layer (smallest)
   - Each blob cached separately by SHA256 digest

### Shared Layers

Docker images share layers. If you pull:
- `nginx:alpine`
- `nginx:latest`

Common layers are only cached once (content-addressable by digest).

## Monitoring

### Check Cache Size

```bash
# MinIO console
# http://localhost:9001 → amargo-artifacts bucket → repositories/docker/

# Or via Prisma Studio
npx prisma studio
# Check Artifact table, sum of size column
```

### Download Statistics

```bash
# Prisma Studio → DownloadStats table
# Filter by repositoryId = 'docker'
```

### Logs

```bash
# Docker compose logs
docker compose logs -f app | grep Docker

# Look for:
# - Cache HIT/MISS
# - Token acquisition
# - Upstream errors
```

## Production Recommendations

1. **Increase TTL**: Docker images are typically immutable
   ```yaml
   cacheTtl: 604800  # 7 days
   ```

2. **Increase Storage**: Docker images are large
   ```yaml
   cache:
     repositories:
       docker:
         maxSize: "1TB"
   ```

3. **Pre-warm Cache**: Pull common base images after deploy
   ```bash
   docker pull nginx:alpine
   docker pull node:20-alpine
   docker pull postgres:16-alpine
   ```

4. **Monitor Disk**: Set up alerts for MinIO storage usage

5. **CDN**: Put CloudFront or similar in front of `/v2/` endpoints

## Known Limitations

- ❌ Private registries (coming soon)
- ❌ Image push (read-only proxy for now)
- ❌ Registry authentication (coming soon)
- ❌ Multi-arch manifest lists (partially supported)
- ✅ Public Docker Hub images
- ✅ Official images
- ✅ User/org images
- ✅ Tag-based pulls
- ✅ Digest-based pulls
- ✅ Layer deduplication

## Next Steps

1. Test with your commonly used base images
2. Monitor cache hit rate
3. Adjust TTL based on update frequency
4. Set up monitoring/alerts for storage

---

**Questions?** Check the main AMARGO_README.md or open an issue.
