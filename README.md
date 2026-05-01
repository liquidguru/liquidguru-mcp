# liquidguru-mcp

Custom MCP (Model Context Protocol) server giving Claude total knowledge of the liquidguru homelab. Runs on the Synology NAS via Docker, exposed via Nginx Proxy Manager + DDNS.

## What it exposes

| Tool | What it does |
|---|---|
| `list_directory` | Browse the NAS filesystem (depth 1–4) |
| `read_file` | Read any file by absolute path |
| `search_files` | Find files by name pattern or content |
| `read_env_file` | Read .env files with secrets redacted |
| `git_log` | Recent commits for any repo |
| `git_diff` | Diff any commit or current changes |
| `list_repos` | Discover all git repos under a root |
| `docker_ps` | Running containers |
| `docker_logs` | Tail container logs |
| `docker_compose_list` | All compose stacks |
| `system_info` | CPU, RAM, disk, network |
| `network_check` | Ping/TCP reachability checks |

Plus a static `homelab-overview` resource summarising the environment.

## Setup

### 1. Generate an auth token

```bash
openssl rand -hex 32
```

Save this — you'll need it in two places: the .env file and the claude.ai connector config.

### 2. Create the .env file

```bash
cp .env.example .env
# Edit .env and paste your token
nano .env
```

### 3. Deploy on NAS

```bash
# SSH to liquidNAS
ssh kaj@192.168.1.100

# Clone or copy the project
cd /volume1/docker
git clone https://github.com/liquidguru/liquidguru-mcp.git
cd liquidguru-mcp

cp .env.example .env
nano .env    # paste your AUTH_TOKEN

docker compose up -d --build

# Verify it started
docker logs liquidguru-mcp
curl http://localhost:3000/health
```

### 4. Configure Nginx Proxy Manager

1. Open NPM at your local URL
2. **Proxy Hosts → Add Proxy Host**
3. Settings:
   - Domain: `mcp.liquidguru.synology.me`
   - Forward to: `liquidguru-mcp:3000`
   - Websockets: **ON**
4. SSL tab: Let's Encrypt, Force SSL: **ON**
5. Advanced tab: paste contents of `npm-proxy-config.nginx`

Test from outside your LAN:
```bash
curl https://mcp.liquidguru.synology.me/health
```

### 5. Add to claude.ai

1. Go to **claude.ai → Settings → Integrations** (or the MCP connector section)
2. Add Custom Integration / MCP Server
3. Enter:
   - **URL**: `https://mcp.liquidguru.synology.me/mcp`
   - **Auth type**: Bearer token
   - **Token**: your AUTH_TOKEN from .env
4. Claude will probe the endpoint and enumerate the tools

Every new chat will now automatically have access to all tools listed above.

## Expanding / adding tools

All tools are in `src/server.js`. The pattern is:

```js
server.tool(
  'tool_name',
  'Description visible to Claude',
  { param: z.string().describe('What this param does') },
  async ({ param }) => {
    // ... do the thing
    return { content: [{ type: 'text', text: 'result' }] };
  }
);
```

After adding tools, redeploy with:
```bash
docker compose up -d --build
```

## Allowed paths

Configured via the `ALLOWED_ROOTS` env var in docker-compose.yml. All file reads are validated against this list — paths outside it are rejected. Adjust to match your volume layout:

```yaml
ALLOWED_ROOTS=/volume1/docker,/volume1/homes,/volume1/Media
```

## Security notes

- Auth token is required for all `/mcp` requests
- All file paths are validated against `ALLOWED_ROOTS` before reading
- The Docker socket is mounted read-only (`ro`)
- All filesystem mounts are read-only — the server cannot write anything
- `.env` files have secret values redacted by default (`show_values: false`)
- No external network calls are made by the server itself

## Directory structure

```
liquidguru-mcp/
├── src/
│   └── server.js          # All MCP tools and server logic
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── npm-proxy-config.nginx  # Paste into NPM Advanced tab
└── README.md
```
