# Nouva Agent

[![CI](https://github.com/nouvalabs/nouva-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/nouvalabs/nouva-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Docker Image](https://img.shields.io/badge/ghcr.io-nouvalabs%2Fnouva--agent-blue)](https://ghcr.io/nouvalabs/nouva-agent)

> This repository is an automatically mirrored public release surface.
> The writable source of truth for `nouva-agent` lives in the Nouva Cloud monorepo.
> GitHub Releases and published images still ship from this repository.

A containerized edge agent that runs on your infrastructure to execute deployment and service management tasks on behalf of [Nouva Cloud](https://nouvacloud.com). It communicates with the Nouva control plane to lease work, process it locally via Docker, and report results back.

Production container images are published only from a published GitHub Release in this repository.
Merges to `main` and plain tag pushes do not publish `ghcr.io/nouvalabs/nouva-agent`. See
[docs/releasing.md](docs/releasing.md) for the release flow.

## Features

- **Application deployments** — build from Git with [Railpack](https://railpack.io)/BuildKit, deploy, redeploy, rollback, and restart containers
- **Database provisioning** — create and manage database service containers with configurable images and volumes
- **Volume backups** — create, restore, and manage volume backups including PostgreSQL point-in-time recovery
- **Routing** — automatic Traefik route configuration for deployed services
- **Metrics & monitoring** — host and container metrics collection reported to the control plane
- **Self-updates** — pull and apply new agent versions with zero manual intervention
- **Zero production dependencies** — built entirely on Node.js built-in APIs

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.5
- [Docker](https://docs.docker.com/get-docker/)
- Git

## Quick Start

```bash
# Clone and install
git clone https://github.com/nouvalabs/nouva-agent.git
cd nouva-agent
bun install

# Build the Docker image
bun run build:agent-image

# Run the agent
docker run -d \
  --name nouva-agent \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e NOUVA_API_URL=https://api.nouvacloud.com \
  -e NOUVA_SERVER_ID=your-server-id \
  -e NOUVA_REGISTRATION_TOKEN=your-token \
  nouva-agent:dev
```

## Configuration

### Required

| Variable | Description |
|---|---|
| `NOUVA_API_URL` | Nouva control plane API endpoint |
| `NOUVA_SERVER_ID` | Unique server identifier |

### Optional

| Variable | Default | Description |
|---|---|---|
| `NOUVA_REGISTRATION_TOKEN` | — | Initial registration token |
| `NOUVA_APP_DOMAIN` | `up.nouva.cloud` | Base domain for deployed apps |
| `NOUVA_AGENT_DATA_VOLUME` | `nouva-agent-data` | Agent data volume name |
| `NOUVA_AGENT_BUILDKIT_CONTAINER` | `nouva-buildkitd` | Legacy shared BuildKit container name, removed on start |
| `NOUVA_AGENT_REGISTRY_CONTAINER` | `nouva-registry` | Local registry container name |
| `NOUVA_AGENT_TRAEFIK_CONTAINER` | `nouva-traefik` | Traefik container name |
| `NOUVA_AGENT_BUILDKIT_GC_KEEP_STORAGE` | `1000,4000,8000` | Build cache GC budget, `Reserved,Free,Maximum` in MB |
| `NOUVA_HOST_OS_ID` | — | Host OS identifier |
| `NOUVA_HOST_OS_VERSION_ID` | — | Host OS version |
| `NOUVA_IMAGE_REGISTRY` | — | Custom image registry |
| `NOUVA_POSTGRES_IMAGE` | — | PostgreSQL image URL |

The agent reports its version from `agent/package.json`, normalized to the release tag format
(`v${version}`). Publish releases with a matching GitHub release tag.

## Architecture

The agent runs a single long-lived process with three concurrent loops:

1. **Heartbeat** — periodic health check with the control plane
2. **Metrics** — collects host and container stats, reports upstream
3. **Work polling** — leases tasks from the API, executes them sequentially, and reports completion or failure

All Docker operations go through the Docker Engine API via `/var/run/docker.sock`. Application builds use Git + Railpack + BuildKit, with images pushed to a local registry.

### Source Layout

```
agent/src/
├── index.ts            # Main control loop and work dispatch
├── docker-api.ts       # Docker Engine API client
├── build.ts            # Git clone + Railpack/BuildKit build helper
├── protocol.ts         # Wire contract types and helpers
├── service-runtime.ts  # Database provisioning helpers
└── update-agent.ts     # Agent self-update logic
```

## Development

```bash
bun install              # Install dependencies
bun run check-types      # Type-check
bun run test             # Run tests
bun run format           # Format with Biome
bun run build:agent-image # Build Docker image
```

For local development with watch mode:

```bash
bun run --filter nouva-agent dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on opening issues and pull requests.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
