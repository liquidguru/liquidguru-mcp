'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { execSync, exec } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const execAsync = promisify(exec);

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  PORT: parseInt(process.env.PORT || '3333', 10),
  AUTH_TOKEN: process.env.AUTH_TOKEN || '',
  BASE_URL: process.env.BASE_URL || 'https://mcp.liquid.guru',
  ALLOWED_ROOTS: (process.env.ALLOWED_ROOTS || '/volume1/docker,/volume1/homes,/volume1/Media')
    .split(',').map(s => s.trim()).filter(Boolean),
};

if (!CONFIG.AUTH_TOKEN) {
  console.error('ERROR: AUTH_TOKEN environment variable is required');
  process.exit(1);
}

// ─── OAuth state stores ───────────────────────────────────────────────────────
// Simple in-memory stores — fine for a single-user personal server

const clients = new Map();      // clientId -> clientSecret
const authCodes = new Map();    // code -> { clientId, redirectUri, expiresAt }

// Persist tokens to file so they survive container restarts
const TOKEN_FILE = '/data/tokens.json';

function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return new Set(data);
  } catch { return new Set(); }
}

function saveTokens(tokens) {
  try {
    fs.mkdirSync('/data', { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify([...tokens]));
  } catch (e) { console.error('Failed to save tokens:', e.message); }
}

const accessTokens = loadTokens();

// Pre-register a static client for Claude Code / claude.ai
const STATIC_CLIENT_ID = 'claude-mcp-client';
const STATIC_CLIENT_SECRET = randomUUID();
clients.set(STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);

// ─── Security ────────────────────────────────────────────────────────────────

function isPathAllowed(p) {
  const resolved = path.resolve(p);
  return CONFIG.ALLOWED_ROOTS.some(root => resolved.startsWith(path.resolve(root)));
}

function assertPathAllowed(p) {
  if (!isPathAllowed(p)) {
    throw new Error(`Path not in allowed roots: ${p}\nAllowed: ${CONFIG.ALLOWED_ROOTS.join(', ')}`);
  }
}

function requireBearerAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Accept either a valid OAuth access token or the master AUTH_TOKEN directly
  if (accessTokens.has(token) || token === CONFIG.AUTH_TOKEN) {
    return next();
  }
  res.status(401).json({ error: 'unauthorized', error_description: 'Valid Bearer token required' });
}

// ─── Tool helpers ────────────────────────────────────────────────────────────

function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 15000, ...opts }).trim();
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// ─── MCP Server factory ──────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({ name: 'liquidguru-homelab', version: '1.0.0' });

  server.tool('list_directory',
    'List files and directories at a given path on the NAS.',
    {
      path: z.string().describe('Absolute path to list, e.g. /volume1/docker'),
      depth: z.number().int().min(1).max(4).default(1).describe('How many levels deep (1-4)'),
      show_hidden: z.boolean().default(false).describe('Include hidden files'),
    },
    async ({ path: dirPath, depth, show_hidden }) => {
      assertPathAllowed(dirPath);
      function walk(dir, currentDepth) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { return [`  (cannot read: ${e.message})`]; }
        const lines = [];
        for (const entry of entries) {
          if (!show_hidden && entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          const prefix = '  '.repeat(depth - currentDepth);
          if (entry.isDirectory()) {
            lines.push(`${prefix}ߓᠤ{entry.name}/`);
            if (currentDepth > 1) lines.push(...walk(fullPath, currentDepth - 1));
          } else if (entry.isFile()) {
            let size = '';
            try { const s = fs.statSync(fullPath); size = ` (${formatBytes(s.size)}, ${s.mtime.toISOString().slice(0,10)})`; } catch {}
            lines.push(`${prefix}ߓ䠤{entry.name}${size}`);
          } else if (entry.isSymbolicLink()) {
            lines.push(`${prefix}ߔ砤{entry.name} -> ${fs.readlinkSync(fullPath)}`);
          }
        }
        return lines;
      }
      const lines = walk(dirPath, depth);
      return { content: [{ type: 'text', text: `Directory: ${dirPath}\n\n${lines.join('\n') || '(empty)'}` }] };
    }
  );

  server.tool('read_file',
    'Read the contents of a file on the NAS.',
    {
      path: z.string().describe('Absolute file path'),
      max_bytes: z.number().int().min(1).max(500000).default(100000).describe('Maximum bytes to read'),
      encoding: z.enum(['utf8', 'base64']).default('utf8'),
    },
    async ({ path: filePath, max_bytes, encoding }) => {
      assertPathAllowed(filePath);
      let stat;
      try { stat = fs.statSync(filePath); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
      if (!stat.isFile()) return { content: [{ type: 'text', text: `Error: Not a file: ${filePath}` }] };
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(Math.min(max_bytes, stat.size));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const truncated = stat.size > max_bytes ? `\n\n[TRUNCATED: showing ${formatBytes(max_bytes)} of ${formatBytes(stat.size)}]` : '';
      return { content: [{ type: 'text', text: `File: ${filePath} (${formatBytes(stat.size)}, modified ${stat.mtime.toISOString().slice(0,19)})\n\n${buf.slice(0,bytesRead).toString(encoding)}${truncated}` }] };
    }
  );

  server.tool('search_files',
    'Search for files by name pattern or content.',
    {
      root: z.string().describe('Directory to search within'),
      name_pattern: z.string().optional().describe('Filename glob, e.g. "*.py"'),
      content_pattern: z.string().optional().describe('Search file contents for this string'),
      max_results: z.number().int().min(1).max(200).default(50),
      exclude_dirs: z.array(z.string()).default(['node_modules', '.git', '__pycache__', 'dist', 'build']),
    },
    async ({ root, name_pattern, content_pattern, max_results, exclude_dirs }) => {
      assertPathAllowed(root);
      const ex = exclude_dirs.map(d => `-not -path "*/${d}/*"`).join(' ');
      let results = '';
      if (name_pattern && !content_pattern) results = safeExec(`find "${root}" -type f -name "${name_pattern}" ${ex} | head -${max_results}`);
      else if (content_pattern && !name_pattern) results = safeExec(`grep -rl "${content_pattern}" "${root}" 2>/dev/null | head -${max_results}`);
      else if (name_pattern && content_pattern) results = safeExec(`find "${root}" -type f -name "${name_pattern}" ${ex} | xargs grep -l "${content_pattern}" 2>/dev/null | head -${max_results}`);
      else return { content: [{ type: 'text', text: 'Provide name_pattern and/or content_pattern' }] };
      const lines = results.split('\n').filter(Boolean);
      return { content: [{ type: 'text', text: `Search in: ${root}\n${name_pattern ? `Name: ${name_pattern}\n` : ''}${content_pattern ? `Content: ${content_pattern}\n` : ''}\nFound ${lines.length} result(s):\n\n${lines.join('\n') || '(none)'}` }] };
    }
  );

  server.tool('git_log',
    'Show recent git commits for a repository.',
    {
      repo_path: z.string().describe('Absolute path to the git repository'),
      count: z.number().int().min(1).max(100).default(20),
      branch: z.string().default('HEAD'),
      author: z.string().optional(),
    },
    async ({ repo_path, count, branch, author }) => {
      assertPathAllowed(repo_path);
      const authorArg = author ? `--author="${author}"` : '';
      const raw = safeExec(`git -C "${repo_path}" log ${branch} -${count} ${authorArg} --format="%h|%as|%an|%s" 2>&1`);
      if (raw.startsWith('Error:') || raw.includes('fatal:')) return { content: [{ type: 'text', text: raw }] };
      const lines = raw.split('\n').filter(Boolean).map(line => {
        const [hash, date, name, ...msg] = line.split('|');
        return `${hash}  ${date}  ${name.padEnd(15)}  ${msg.join('|')}`;
      });
      const currentBranch = safeExec(`git -C "${repo_path}" branch --show-current 2>&1`);
      const status = safeExec(`git -C "${repo_path}" status --short 2>&1`);
      return { content: [{ type: 'text', text: `Repo: ${repo_path}\nBranch: ${currentBranch}\n${status ? `\nUncommitted:\n${status}` : '\nClean.'}\n\nCommits:\n${'─'.repeat(60)}\n${lines.join('\n')}` }] };
    }
  );

  server.tool('git_diff',
    'Show the diff of a commit or current changes.',
    {
      repo_path: z.string().describe('Absolute path to the git repository'),
      ref: z.string().default('HEAD').describe('Commit hash, or "staged" for staged changes'),
      file_path: z.string().optional(),
    },
    async ({ repo_path, ref, file_path }) => {
      assertPathAllowed(repo_path);
      const fileArg = file_path ? `-- "${file_path}"` : '';
      let cmd;
      if (ref === 'staged') cmd = `git -C "${repo_path}" diff --staged ${fileArg} 2>&1`;
      else if (ref === 'HEAD') cmd = `git -C "${repo_path}" diff ${fileArg} 2>&1`;
      else cmd = `git -C "${repo_path}" show ${ref} ${fileArg} 2>&1`;
      return { content: [{ type: 'text', text: safeExec(cmd) || '(no diff)' }] };
    }
  );

  server.tool('list_repos',
    'Discover all git repositories under a root directory.',
    {
      root: z.string().describe('Directory to search'),
      max_depth: z.number().int().min(1).max(5).default(3),
    },
    async ({ root, max_depth }) => {
      assertPathAllowed(root);
      const found = safeExec(`find "${root}" -maxdepth ${max_depth} -name ".git" -type d 2>/dev/null`).split('\n').filter(Boolean);
      const repos = found.map(gitDir => {
        const repoPath = path.dirname(gitDir);
        const branch = safeExec(`git -C "${repoPath}" branch --show-current 2>/dev/null`);
        const lastCommit = safeExec(`git -C "${repoPath}" log -1 --format="%as %s" 2>/dev/null`);
        const remote = safeExec(`git -C "${repoPath}" remote get-url origin 2>/dev/null`);
        return `${repoPath}\n  branch: ${branch || '(detached)'}\n  last:   ${lastCommit || '(none)'}\n  remote: ${remote || '(none)'}`;
      });
      return { content: [{ type: 'text', text: `Git repos under ${root}:\n\n${repos.join('\n\n') || '(none found)'}` }] };
    }
  );

  server.tool('docker_ps',
    'List Docker containers on the NAS.',
    {
      all: z.boolean().default(false).describe('Include stopped containers'),
      filter_name: z.string().optional(),
    },
    async ({ all, filter_name }) => {
      const allArg = all ? '-a' : '';
      const filterArg = filter_name ? `--filter "name=${filter_name}"` : '';
      const raw = safeExec(`docker ps ${allArg} ${filterArg} --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>&1`);
      if (raw.startsWith('Error:') || raw.includes('Cannot connect')) return { content: [{ type: 'text', text: `Docker error: ${raw}` }] };
      const lines = raw.split('\n').filter(Boolean).map(line => {
        const [name, image, status, ports] = line.split('|');
        return `${name.padEnd(28)} ${status.padEnd(30)} ${image}\n${' '.repeat(28)} ${ports || '(no ports)'}`;
      });
      return { content: [{ type: 'text', text: `Docker containers:\n\n${lines.join('\n\n') || '(none)'}` }] };
    }
  );

  server.tool('docker_logs',
    'Get recent logs from a Docker container.',
    {
      container: z.string(),
      lines: z.number().int().min(10).max(500).default(50),
      since: z.string().optional().describe('e.g. "1h", "30m"'),
    },
    async ({ container, lines, since }) => {
      const sinceArg = since ? `--since "${since}"` : '';
      return { content: [{ type: 'text', text: `Logs: ${container}\n${'─'.repeat(50)}\n${safeExec(`docker logs ${container} ${sinceArg} --tail ${lines} 2>&1`)}` }] };
    }
  );

  server.tool('docker_compose_list',
    'Find all docker-compose stacks on the NAS.',
    { root: z.string().default('/volume1/docker') },
    async ({ root }) => {
      assertPathAllowed(root);
      const files = safeExec(`find "${root}" -maxdepth 3 -name "docker-compose.yml" -o -name "docker-compose.yaml" 2>/dev/null`).split('\n').filter(Boolean);
      const stacks = files.map(f => {
        const stackName = path.basename(path.dirname(f));
        const services = safeExec(`docker compose -f "${f}" ps --services 2>/dev/null`);
        return `${stackName.padEnd(25)} ${f}\n  services: ${services.split('\n').filter(Boolean).join(', ') || '(none)'}`;
      });
      return { content: [{ type: 'text', text: `Compose stacks under ${root}:\n\n${stacks.join('\n\n') || '(none)'}` }] };
    }
  );

  server.tool('system_info',
    'Get NAS system information: CPU, memory, disk, network.',
    {},
    async () => {
      return { content: [{ type: 'text', text: [
        `=== System Info: ${safeExec('hostname')} ===`,
        `OS:     ${safeExec('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d\\" -f2 || uname -a')}`,
        `CPU:    ${safeExec('cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2')} (${safeExec('nproc')} cores)`,
        `Uptime: ${safeExec('uptime')}`,
        `\nMemory:\n${safeExec('free -h')}`,
        `\nDisk:\n${safeExec('df -h /volume1 2>/dev/null || df -h /')}`,
        `\nNetwork:\n${safeExec('ip addr show | grep "inet " | awk \'{print $2, $NF}\' | grep -v "127.0.0.1"')}`,
      ].join('\n') }] };
    }
  );

  server.tool('read_env_file',
    'Read a .env file with secrets redacted.',
    {
      path: z.string().describe('Absolute path to the .env file'),
      show_values: z.boolean().default(false),
    },
    async ({ path: envPath, show_values }) => {
      assertPathAllowed(envPath);
      let content;
      try { content = fs.readFileSync(envPath, 'utf8'); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
      const SECRET_KEYS = ['password', 'secret', 'token', 'key', 'auth', 'pass', 'api_key', 'credential'];
      const lines = content.split('\n').map(line => {
        if (line.startsWith('#') || !line.includes('=')) return line;
        const [k, ...vp] = line.split('=');
        const v = vp.join('=');
        if (!show_values && SECRET_KEYS.some(s => k.toLowerCase().includes(s))) return `${k}=<REDACTED>`;
        return show_values ? line : `${k}=${v.length > 60 ? v.slice(0,60) + '...' : v}`;
      });
      return { content: [{ type: 'text', text: `Env: ${envPath}\n\n${lines.join('\n')}` }] };
    }
  );

  server.tool('network_check',
    'Check reachability of homelab hosts/services.',
    {
      hosts: z.array(z.string()).default([]),
      ports: z.array(z.object({ host: z.string(), port: z.number().int(), label: z.string().optional() })).default([]),
    },
    async ({ hosts, ports }) => {
      const results = [];
      for (const host of hosts) {
        const ping = safeExec(`ping -c 2 -W 2 "${host}" 2>&1 | tail -3`);
        const ok = !ping.toLowerCase().includes('unreachable') && !ping.toLowerCase().includes('0 received');
        results.push(`${ok ? 'OK' : 'FAIL'} ${host}\n   ${ping.replace(/\n/g, '\n   ')}`);
      }
      for (const { host, port, label } of ports) {
        try {
          const { stdout } = await execAsync(`nc -z -w3 "${host}" ${port} 2>&1 && echo "open" || echo "closed"`);
          results.push(`${stdout.trim() === 'open' ? 'OK' : 'FAIL'} ${host}:${port}${label ? ` (${label})` : ''}`);
        } catch { results.push(`FAIL ${host}:${port}${label ? ` (${label})` : ''}`); }
      }
      return { content: [{ type: 'text', text: `Network checks:\n\n${results.join('\n\n') || '(none specified)'}` }] };
    }
  );

  const BEE_HOST = 'liqui@192.168.1.9';
    const BEE_KEY  = '/volume1/homes/kaj/.ssh/id_ed25519';
    const SSH_OPTS = '-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5';
    function beeExec(cmd) {
      return safeExec('ssh ' + SSH_OPTS + ' -i ' + BEE_KEY + ' ' + BEE_HOST + ' "' + cmd + '"');
    }
    server.tool('bee_run_command', 'Run a shell command on liquidBee (192.168.1.9) via SSH.',
      { command: z.string() },
      async ({ command }) => {
        const blocked = ['rm -rf /', 'mkfs', 'dd if='];
        if (blocked.some(b => command.includes(b))) return { content: [{ type: 'text', text: 'Error: blocked' }] };
        return { content: [{ type: 'text', text: beeExec(command) || '(no output)' }] };
      }
    );
    server.tool('bee_docker_ps', 'List Docker containers on liquidBee.',
      { all: z.boolean().default(false) },
      async ({ all }) => {
        const raw = beeExec('docker ps ' + (all ? '-a' : '') + ' --format  "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"');
        const lines = raw.split('\n').filter(Boolean).map(function(l) {
          var parts = l.split('|');
          return parts[0].padEnd(28) + ' ' + parts[2].padEnd(30) + ' ' + parts[1] + '\n' + ' '.repeat(28) + ' ' +
  (parts[3] || '(no ports)');
        });
        return { content: [{ type: 'text', text: 'liquidBee containers:\n\n' + (lines.join('\n\n') || '(none)') }] };
      }
    );
    server.tool('bee_docker_logs', 'Get logs from a Docker container on liquidBee.',
      { container: z.string(), lines: z.number().int().min(10).max(500).default(50), since: z.string().optional() },
      async ({ container, lines, since }) => {
        var sinceArg = since ? '--since ' + since + ' ' : '';
        var cmd = 'docker logs ' + container + ' ' + sinceArg + '--tail ' + lines + ' 2>&1';
        return { content: [{ type: 'text', text: 'Logs: ' + container + ' (liquidBee)\n' + '\u2500'.repeat(50) + '\n' +
  beeExec(cmd) }] };
      }
    );
    server.tool('bee_system_info', 'Get system info from liquidBee.',
      {},
      async () => {
        return { content: [{ type: 'text', text: '=== liquidBee (192.168.1.9) ===\nUptime: ' + beeExec('uptime') +
  '\n\nMemory:\n' + beeExec('free -h') + '\n\nDisk:\n' + beeExec('df -h /') }] };
      }
    );

  server.resource('homelab-overview', 'liquidguru://homelab/overview',
    { mimeType: 'text/plain', description: 'Overview of the liquidguru homelab' },
    async () => ({
      contents: [{ uri: 'liquidguru://homelab/overview', mimeType: 'text/plain', text: [
        '=== liquidguru homelab MCP ===',
        `NAS: ${safeExec('hostname')} | Uptime: ${safeExec('uptime -p')} | Containers: ${safeExec('docker ps -q | wc -l')}`,
        `Paths: ${CONFIG.ALLOWED_ROOTS.join(', ')}`,
        'Tools: list_directory, read_file, search_files, read_env_file, git_log, git_diff, list_repos,',
        '       docker_ps, docker_logs, docker_compose_list, system_info, network_check',
        'Hosts: liquidNAS=192.168.1.100, liquidBee=192.168.1.9',
      ].join('\n') }],
    })
  );

  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use((req, res, next) => {
  if (req.path === '/mcp') return next(); // skip body parsing for MCP
  express.json({ limit: '4mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'liquidguru-homelab-mcp', version: '1.0.0' });
});

// ─── OAuth 2.0 endpoints ──────────────────────────────────────────────────────

// 1. Authorization server metadata
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: CONFIG.BASE_URL,
    authorization_endpoint: `${CONFIG.BASE_URL}/authorize`,
    token_endpoint: `${CONFIG.BASE_URL}/token`,
    registration_endpoint: `${CONFIG.BASE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  });
});

// Also serve at the MCP protected resource path
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: CONFIG.BASE_URL,
    authorization_servers: [CONFIG.BASE_URL],
  });
});

// 2. Dynamic client registration
app.post('/register', (req, res) => {
  const clientId = randomUUID();
  const clientSecret = randomUUID();
  clients.set(clientId, clientSecret);
  console.log(`[OAuth] Registered client: ${clientId}`);
  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: req.body.redirect_uris || [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  });
});

// 3. Authorization endpoint — shows a simple approval page
app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>liquidguru homelab — Authorize</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; background: #0d1117; color: #e6edf3; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    p { color: #8b949e; margin-bottom: 32px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; margin-bottom: 24px; }
    label { display: block; margin-bottom: 8px; font-size: 0.9rem; color: #8b949e; }
    input { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 1rem; box-sizing: border-box; }
    button { width: 100%; padding: 10px; background: #238636; border: none; border-radius: 6px; color: white; font-size: 1rem; cursor: pointer; margin-top: 16px; }
    button:hover { background: #2ea043; }
    .error { color: #f85149; margin-top: 8px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>ߔࠬiquidguru homelab</h1>
  <p>Claude is requesting access to your homelab MCP server.</p>
  <div class="card">
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${client_id || ''}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
      <input type="hidden" name="state" value="${state || ''}">
      <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}">
      <label for="token">Enter your AUTH_TOKEN to approve access:</label>
      <input type="password" id="token" name="token" placeholder="Paste your AUTH_TOKEN" autofocus>
      <button type="submit">Authorize Access</button>
    </form>
  </div>
</body>
</html>`);
});

// 4. Authorization POST — validate token and issue code
app.post('/authorize', (req, res) => {
  const { client_id, redirect_uri, state, token, code_challenge, code_challenge_method } = req.body;

  if (token !== CONFIG.AUTH_TOKEN) {
    return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 24px;background:#0d1117;color:#e6edf3">
      <h2>❌ Invalid token</h2><p>The AUTH_TOKEN you entered is incorrect.</p>
      <a href="javascript:history.back()" style="color:#58a6ff">← Try again</a></body></html>`);
  }

  const code = randomUUID();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  console.log(`[OAuth] Issued auth code for client: ${client_id}`);
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.redirect(redirectUrl.toString());
});

// 5. Token endpoint
app.post('/token', (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const authCode = authCodes.get(code);
  if (!authCode) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code' });
  }

  if (Date.now() > authCode.expiresAt) {
    authCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
  }

  authCodes.delete(code);

  const accessToken = randomUUID();
  accessTokens.add(accessToken);
  saveTokens(accessTokens);

  console.log(`[OAuth] Issued access token for client: ${client_id}`);

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 86400 * 365, // 1 year
    scope: 'mcp',
  });
});

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

app.all('/mcp', requireBearerAuth, async (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} /mcp`);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    res.on('finish', () => { mcpServer.close().catch(() => {}); });
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`liquidguru-mcp started on port ${CONFIG.PORT}`);
  console.log(`Base URL: ${CONFIG.BASE_URL}`);
  console.log(`OAuth: ${CONFIG.BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`MCP:   ${CONFIG.BASE_URL}/mcp`);
});
