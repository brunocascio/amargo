# Amargo

**Universal Artifact Repository Manager with Pull-Through Cache**

Amargo is an open-source, scalable artifact repository manager that supports multiple package ecosystems (npm, PyPI, Docker, Maven, NuGet, Go) with intelligent pull-through caching. Built for performance and flexibility, it uses object storage for artifacts and provides a clean admin UI.

## Features

- 🚀 **Pull-Through Cache**: On-demand caching with configurable TTL at repository and artifact levels
- 📦 **Multi-Registry Support**: npm, PyPI, Docker, Maven, NuGet, Go modules
- ☁️ **Object Storage**: Multiple S3-compatible providers (MinIO, AWS S3, GCS, Azure Blob)
- 🎯 **No Size Limits**: Unlimited artifact storage
- 🔄 **Horizontal Scaling**: Designed for distributed deployments
- 🐳 **Docker Ready**: Complete Docker Compose setup for local development
- 📈 **Download Analytics**: Track package downloads and usage statistics
- 🎨 **HTTP Cache Headers**: CDN-friendly with proper ETag, Cache-Control headers
- 📄 **MIT Licensed**: Free and open source

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 16 (provided via Docker)
- MinIO or S3-compatible storage (MinIO provided via Docker)

### Local Setup

1. **Clone and install dependencies**:
```bash
npm install
```

2. **Copy environment file**:
```bash
cp .env.example .env
```

3. **Start infrastructure** (PostgreSQL + MinIO):
```bash
docker compose up -d
```

4. **Generate Prisma client and run migrations**:
```bash
npx prisma generate
npx prisma migrate dev
```

5. **Start the development server**:
```bash
npm run start:dev
```

6. **Access the application**:
- **API**: http://localhost:3000
- **Health Check**: http://localhost:3000/health
- **MinIO Console**: http://localhost:9001 (amargo / amargo123)

## Configuration

Configuration is managed via `config/amargo.yaml`. You can customize:

### Server Settings
```yaml
server:
  port: 3000
  host: "0.0.0.0"
  cache:
    enabled: true
    maxAge: 3600
```

### Storage Providers
```yaml
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

Supported storage backends:
- **MinIO**: S3-compatible, self-hosted (default for development)
- **AWS S3**: Amazon S3
- **GCS**: Google Cloud Storage
- **Azure Blob**: Microsoft Azure Blob Storage

### Repository Configuration
```yaml
repositories:
  npm:
    format: "npm"
    type: "proxy"
    enabled: true
    upstream: "https://registry.npmjs.org"
    cacheTtl: 3600  # 1 hour
    path: "/npm"
```

## Proxy Configuration

### NPM Proxy

Configure your npm client to use Amargo:

```bash
# Set registry globally
npm config set registry http://localhost:3000/npm

# Or use per-project (.npmrc)
registry=http://localhost:3000/npm

# Or use per-command
npm install express --registry http://localhost:3000/npm
```

### PyPI Proxy

Configure pip to use Amargo:

**Global configuration** (`~/.pip/pip.conf` on Linux/macOS or `%APPDATA%\pip\pip.ini` on Windows):
```ini
[global]
index-url = http://localhost:3000/pypi/simple/
```

**Per-project** (`requirements.txt`):
```
--index-url http://localhost:3000/pypi/simple/
requests==2.28.1
django>=4.2.0
```

**With Poetry** (`pyproject.toml`):
```toml
[[tool.poetry.source]]
name = "amargo"
url = "http://localhost:3000/pypi/simple/"
priority = "primary"
```

### Docker Proxy

Configure Docker daemon to use Amargo as a registry mirror:

**Edit `/etc/docker/daemon.json` (or `~/.docker/daemon.json` on macOS/Windows):**
```json
{
  "registry-mirrors": ["http://localhost:3000"],
  "insecure-registries": ["localhost:3000"]
}
```

Then restart Docker and pull images:
```bash
docker pull nginx:alpine
```

### Go Modules Proxy

Configure Go to use Amargo:

```bash
# Set GOPROXY environment variable
export GOPROXY=http://localhost:3000/go

# Or use per-project
go env -w GOPROXY=http://localhost:3000/go
```

### Maven Proxy

Configure Maven in `~/.m2/settings.xml`:

```xml
<settings>
  <mirrors>
    <mirror>
      <id>amargo</id>
      <mirrorOf>central</mirrorOf>
      <url>http://localhost:3000/maven</url>
    </mirror>
  </mirrors>
</settings>
```

### NuGet Proxy

Configure NuGet to use Amargo:

```bash
# Add source
dotnet nuget add source http://localhost:3000/nuget -n amargo

# Or in nuget.config
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="amargo" value="http://localhost:3000/nuget" />
  </packageSources>
</configuration>
```

## Architecture

```
┌─────────────┐
│   Clients   │
│(npm/pip/etc)│
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│         Amargo (NestJS)             │
│  ┌──────────┐      ┌─────────────┐ │
│  │   npm    │      │    PyPI     │ │
│  │Controller│ ...  │  Controller │ │
│  └────┬─────┘      └──────┬──────┘ │
│       │                   │         │
│       ▼                   ▼         │
│  ┌────────────────────────────┐    │
│  │    Artifact Service        │    │
│  │  (Metadata + Streaming)    │    │
│  └────────┬───────────────────┘    │
│           │                         │
│           ▼                         │
│  ┌────────────────┐  ┌──────────┐  │
│  │ Storage Service│  │  Prisma  │  │
│  │  (S3/MinIO)    │  │   (PG)   │  │
│  └────────┬───────┘  └────┬─────┘  │
└───────────┼─────────────────┼───────┘
            │                 │
            ▼                 ▼
     ┌───────────┐     ┌──────────┐
     │   MinIO   │     │PostgreSQL│
     │ (Objects) │     │(Metadata)│
     └───────────┘     └──────────┘
```

## Development

### Running Tests

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

### Database Management

```bash
# Create migration
npx prisma migrate dev --name migration_name

# Apply migrations
npx prisma migrate deploy

# Open Prisma Studio
npx prisma studio
```

### Docker Development

Run the entire stack in Docker:

```bash
docker compose up --build
```

## Cache Strategy

- **Repository-level TTL**: Default expiration time from `config/amargo.yaml`
- **Artifact-level TTL**: Override per-artifact (stored in database)
- **Cleanup Job**: Runs periodically to remove expired artifacts
- **No Size Limits**: Store as much as your object storage allows

### HTTP Cache Headers

Amargo sets appropriate cache headers:

- **Immutable artifacts**: `Cache-Control: public, max-age=31536000, immutable`
- **Metadata**: `Cache-Control: public, max-age=300`
- **ETags**: SHA256 checksum of artifacts
- **X-Amargo-Cache**: HIT or MISS header for debugging

## Production Deployment

1. Build the application:
```bash
npm run build
```

2. Build production Docker image:
```bash
docker build -t amargo:latest .
```

3. Configure environment variables for production storage (S3, GCS, etc.)

4. Run with production compose:
```bash
docker compose up -d
```

## Troubleshooting

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
npx prisma migrate dev
```

### Proxy not working
Check the proxy configuration in your client (npm, pip, docker, etc.) and ensure Amargo is running on the expected port.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Built With

- [NestJS](https://nestjs.com/) - Progressive Node.js framework
- [Prisma](https://www.prisma.io/) - Next-generation ORM
- [MinIO](https://min.io/) - High-performance object storage
- [PostgreSQL](https://www.postgresql.org/) - Advanced open source database
