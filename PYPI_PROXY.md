# PyPI Proxy Implementation

This document describes the PyPI (Python Package Index) proxy implementation in Amargo.

## Overview

The PyPI proxy provides pull-through caching for Python packages, allowing you to:
- Cache Python packages locally to reduce bandwidth and improve install speeds
- Mirror PyPI packages for offline usage
- Track package downloads and usage statistics
- Reduce load on upstream PyPI servers

## Architecture

The PyPI proxy implements the [PEP 503 - Simple Repository API](https://peps.python.org/pep-0503/) specification.

### Endpoints

1. **Package Index** - `GET /pypi/simple/`
   - Lists all available packages
   - Proxied directly from upstream with short cache

2. **Package Page** - `GET /pypi/simple/:package/`
   - Lists all versions and download links for a specific package
   - URLs are rewritten to point to the proxy
   - Package names are normalized (case-insensitive, hyphens/underscores treated as equivalent)

3. **Package Download** - `GET /pypi/packages/*`
   - Downloads package files (wheels, source distributions, eggs)
   - Implements pull-through caching
   - Supports both wheels (.whl) and source distributions (.tar.gz, .zip, etc.)

### Package Name Normalization

Following PEP 503, package names are normalized:
- Converted to lowercase
- Runs of `[._-]` are replaced with a single dash
- Examples:
  - `Django` → `django`
  - `some_package` → `some-package`
  - `some.package` → `some-package`

### File Types Supported

- **Wheels** (`.whl`) - Binary distributions
- **Source archives** (`.tar.gz`, `.tar.bz2`, `.zip`)
- **Eggs** (`.egg`) - Legacy format

## Configuration

Configure the PyPI proxy in `config/amargo.yaml`:

```yaml
repositories:
  pypi:
    format: "pypi"
    type: "proxy"
    enabled: true
    upstream: "https://pypi.org"
    cacheTtl: 7200 # 2 hours
    path: "/pypi"

# Repository groups - combine multiple PyPI proxies
groups:
  pypi:
    format: "pypi"
    enabled: true
    path: "/pypi"
    members:
      - name: "pypi"
        priority: 1  # Check public PyPI first
      # - name: "pypi-private"  # Add private PyPI mirror
      #   priority: 2
```

### Repository Groups

Like Docker and NPM, PyPI supports repository groups that allow you to:
- **Combine multiple PyPI repositories** (public + private mirrors)
- **Set priority order** for artifact lookups
- **Fallback mechanism** - tries each repository in priority order

Benefits:
- Check private/hosted repositories first
- Fall back to public PyPI if not found
- Support multiple upstream PyPI mirrors
- Single endpoint for all Python packages

### Environment Variables

If using environment variables in your configuration:

```yaml
database:
  url: "${DATABASE_URL}"

storage:
  default: "s3"
  providers:
    s3:
      endpoint: "${S3_ENDPOINT}"
      accessKey: "${S3_ACCESS_KEY}"
      secretKey: "${S3_SECRET_KEY}"
      bucket: "${S3_BUCKET}"
      region: "${S3_REGION:-us-east-1}"
```

## Usage

### Configuring pip

To use the PyPI proxy with pip, you can:

#### Option 1: Per-command

```bash
pip install --index-url http://localhost:3000/pypi/simple/ requests
```

#### Option 2: Per-project (requirements.txt)

```
--index-url http://localhost:3000/pypi/simple/
requests==2.28.1
django>=4.2.0
```

#### Option 3: Global configuration

Create or edit `~/.pip/pip.conf` (Linux/macOS) or `%APPDATA%\pip\pip.ini` (Windows):

```ini
[global]
index-url = http://localhost:3000/pypi/simple/
```

#### Option 4: Environment variable

```bash
export PIP_INDEX_URL=http://localhost:3000/pypi/simple/
```

### Using with Poetry

Edit your `pyproject.toml`:

```toml
[[tool.poetry.source]]
name = "amargo"
url = "http://localhost:3000/pypi/simple/"
priority = "primary"
```

### Using with pipenv

Edit your `Pipfile`:

```toml
[[source]]
url = "http://localhost:3000/pypi/simple/"
verify_ssl = false
name = "amargo"
```

## Caching Strategy

### First Request (Cache MISS)

1. Client requests package: `GET /pypi/simple/requests/`
2. Proxy fetches from upstream PyPI
3. URLs in HTML are rewritten to point to proxy
4. Response is sent to client
5. When a package file is downloaded:
   - File is streamed from upstream
   - Simultaneously saved to storage (S3/GCS/Azure)
   - Metadata stored in database
   - Response header: `X-Amargo-Cache: MISS`

### Subsequent Requests (Cache HIT)

1. Client requests same package version
2. Proxy finds it in database
3. File is streamed directly from storage
4. Download stats are recorded
5. Response header: `X-Amargo-Cache: HIT`

### Cache Duration

- **Package index** (`/pypi/simple/`): 10 minutes
- **Package pages** (`/pypi/simple/:package/`): 5 minutes
- **Package files** (`/pypi/packages/*`): Immutable (1 year cache, never expires)

## Storage Structure

Artifacts are stored with the following path structure:

```
repositories/pypi/{normalized-package-name}/{version}/artifact
```

Examples:
- `repositories/pypi/requests/2.28.1/artifact`
- `repositories/pypi/django/4.2.1/artifact`
- `repositories/pypi/numpy/1.24.0/artifact`

## Database Schema

### Repository Record

```typescript
{
  name: "pypi",
  type: "PROXY",
  format: "PYPI",
  upstreamUrl: "https://pypi.org",
  isProxyEnabled: true,
  cacheTtl: 7200
}
```

### Artifact Record

```typescript
{
  repositoryId: "repo-id",
  name: "requests",           // normalized package name
  version: "2.28.1",
  path: "repositories/pypi/requests/2.28.1/artifact",
  size: 123456,
  checksum: "sha256-hash",
  contentType: "application/zip",
  metadata: {
    filename: "requests-2.28.1-py3-none-any.whl",
    originalPath: "ab/cd/ef.../requests-2.28.1-py3-none-any.whl",
    source: "pypi-upstream"
  }
}
```

## Implementation Details

### URL Rewriting

PyPI's simple API uses relative URLs like:

```html
<a href="../../packages/ab/cd/ef.../package-1.0.0.whl">package-1.0.0.whl</a>
```

The proxy rewrites these to:

```html
<a href="/pypi/packages/ab/cd/ef.../package-1.0.0.whl">package-1.0.0.whl</a>
```

### Filename Parsing

The proxy extracts package name and version from filenames:

**Wheel files:**
```
requests-2.28.1-py3-none-any.whl
→ name: requests, version: 2.28.1
```

**Source distributions:**
```
Django-4.2.1.tar.gz
→ name: django, version: 4.2.1
```

### Content Types

- `.whl` → `application/zip`
- `.tar.gz`, `.tgz` → `application/gzip`
- `.tar.bz2` → `application/x-bzip2`
- `.zip` → `application/zip`
- `.egg` → `application/zip`

## Monitoring

### Cache Performance

Check response headers to monitor cache performance:

```bash
curl -I http://localhost:3000/pypi/packages/ab/cd/ef.../requests-2.28.1-py3-none-any.whl
```

Look for:
- `X-Amargo-Cache: HIT` - Package served from cache
- `X-Amargo-Cache: MISS` - Package fetched from upstream

### Download Statistics

Download statistics are automatically recorded in the `download_stats` table:

```sql
SELECT 
  artifactName,
  artifactVersion,
  COUNT(*) as downloads
FROM download_stats
WHERE repositoryId = 'pypi-repo-id'
GROUP BY artifactName, artifactVersion
ORDER BY downloads DESC
LIMIT 10;
```

## Security Considerations

### HTTPS for Upstream

Always use HTTPS for the upstream PyPI URL to ensure package integrity:

```yaml
upstream: "https://pypi.org"  # ✓ Good
upstream: "http://pypi.org"   # ✗ Bad - security risk
```

### Checksum Verification

The proxy calculates SHA256 checksums for all cached packages, which can be used to verify integrity.

### SSL/TLS for Proxy

For production deployments, always use HTTPS:

```bash
# Using a reverse proxy like nginx
server {
    listen 443 ssl;
    server_name pypi.example.com;
    
    location / {
        proxy_pass http://localhost:3000;
    }
}
```

Then configure pip:

```bash
pip install --index-url https://pypi.example.com/pypi/simple/ requests
```

## Troubleshooting

### Package Not Found

If you see 404 errors:

1. Check that the package name is correct (case-insensitive)
2. Verify upstream connectivity: `curl https://pypi.org/simple/package-name/`
3. Check logs: `docker compose logs app`

### Slow Downloads

If downloads are slow:

1. Check cache hit rate in logs
2. Verify storage backend performance (S3/GCS latency)
3. Consider using a CDN in front of the proxy

### Cache Not Working

If cache always shows MISS:

1. Verify database connection
2. Check storage backend configuration
3. Review logs for errors during artifact storage

## Testing

### Manual Testing

```bash
# Test package index
curl http://localhost:3000/pypi/simple/

# Test package page
curl http://localhost:3000/pypi/simple/requests/

# Test package download (cache MISS)
time pip install --index-url http://localhost:3000/pypi/simple/ requests==2.28.1

# Test package download again (cache HIT - should be faster)
pip uninstall -y requests
time pip install --index-url http://localhost:3000/pypi/simple/ requests==2.28.1
```

### Expected Behavior

1. First install: Downloads from PyPI, caches locally
2. Second install: Serves from cache (much faster)
3. Response headers show cache status

## Performance

### Benchmarks

Typical performance improvements with caching:

- **First install (MISS)**: ~same as PyPI (+ small proxy overhead)
- **Cached install (HIT)**: 50-90% faster depending on:
  - Network latency to storage backend
  - Package size
  - Storage backend performance

### Optimization Tips

1. Use a storage backend close to your application (same region)
2. Use SSD-backed storage for better performance
3. Configure appropriate cache TTLs
4. Monitor cache hit rates
5. Consider using a CDN for frequently accessed packages

## Future Enhancements

Potential improvements:

- [ ] Support for private package repositories
- [ ] Package upload support (full repository, not just proxy)
- [ ] Web UI for package browsing
- [ ] Advanced statistics and analytics
- [ ] Package vulnerability scanning
- [ ] Mirror mode (pre-fetch popular packages)
- [ ] Package pinning/freezing
- [ ] Allowlist/blocklist for packages
