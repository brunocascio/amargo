# Amargo

**Universal Artifact Repository Manager with Pull-Through Cache**

Amargo is an open-source, scalable artifact repository manager that supports multiple package ecosystems (npm, PyPI, Docker, Maven, NuGet) with intelligent pull-through caching. Built for performance and flexibility, it uses object storage for artifacts and provides a clean admin UI.

## Features

- 🚀 **Pull-Through Cache**: On-demand caching with configurable TTL at repository and artifact levels
- 📦 **Multi-Registry Support**: npm, PyPI, Docker, Maven, NuGet (and more coming)
- ☁️ **Object Storage**: Multiple S3-compatible providers (MinIO, AWS S3, GCS, Azure Blob)
- 🎯 **No Size Limits**: Unlimited artifact storage
- 🔄 **Horizontal Scaling**: Designed for distributed deployments
- 📊 **Admin UI**: Server-rendered dashboard with read-only configuration view
- 🐳 **Docker Ready**: Complete Docker Compose setup for local development
- 📈 **Download Analytics**: Track package downloads and usage statistics
- 🎨 **HTTP Cache Headers**: CDN-friendly with proper ETag, Cache-Control headers
- 📄 **MIT Licensed**: Free and open source

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 16 (provided via Docker)
- MinIO (provided via Docker)

### Installation

1. **Install dependencies**:
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
npx prisma migrate dev --name init
```

5. **Start the development server**:
```bash
npm run start:dev
```

6. **Access the application**:
- **API**: http://localhost:3000
- **Admin UI**: http://localhost:3000/admin
- **Health Check**: http://localhost:3000/health
- **MinIO Console**: http://localhost:9001 (amargo / amargo123)

## Usage

### NPM Registry Proxy

Configure your npm client to use Amargo:

```bash
# Set registry
npm config set registry http://localhost:3000/npm

# Install packages (they'll be cached automatically)
npm install express
```

Packages are fetched from the upstream npm registry on first request and cached in MinIO. Subsequent requests are served from cache with immutable cache headers.

### Configuration

Edit `config/amargo.yaml` to customize:

- **Server settings**: Port, host, cache headers
- **Storage providers**: MinIO, S3, GCS, Azure
- **Repositories**: npm, PyPI, Docker configurations
- **Cache policies**: TTL, cleanup intervals, size limits

The configuration is displayed read-only in the Admin UI at `/admin`.

## Architecture

```
┌─────────────┐
│   Client    │
│  (npm/pip)  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│         Amargo (NestJS)             │
│  ┌──────────┐      ┌─────────────┐ │
│  │   npm    │      │    PyPI     │ │
│  │Controller│      │  Controller │ │
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
docker compose -f docker-compose.dev.yml up --build
```

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
docker compose -f docker-compose.yml up -d
```

## Configuration Reference

### Storage Providers

Amargo supports multiple storage backends:

- **MinIO**: S3-compatible, self-hosted (default for development)
- **AWS S3**: Amazon S3
- **GCS**: Google Cloud Storage
- **Azure Blob**: Microsoft Azure Blob Storage

### Cache Strategy

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

## Support

- **GitHub Sponsors**: [Support on GitHub](https://github.com/sponsors/yourusername)
- **OpenCollective**: [Donate via OpenCollective](https://opencollective.com/amargo)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Roadmap

- [x] NPM registry support with pull-through caching
- [ ] PyPI registry support
- [ ] Docker registry support
- [ ] Maven repository support
- [ ] NuGet repository support
- [ ] React-based admin UI with shadcn/ui
- [ ] Authentication & RBAC
- [ ] Metrics & monitoring (Prometheus)
- [ ] Replication across regions
- [ ] Package vulnerability scanning

## Credits

Built with:
- [NestJS](https://nestjs.com/) - Progressive Node.js framework
- [Prisma](https://www.prisma.io/) - Next-generation ORM
- [MinIO](https://min.io/) - High-performance object storage
- [PostgreSQL](https://www.postgresql.org/) - Advanced open source database
