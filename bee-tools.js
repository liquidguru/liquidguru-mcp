
  // ── liquidBee tools (SSH to 192.168.1.9) ─────────────────────────────────────

  const BEE_HOST = 'kaj@192.168.1.9';
  const BEE_KEY  = '/volume1/homes/kaj/.ssh/id_ed25519';
  const SSH_OPTS = '-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5';

  function beeExec(cmd) {
    return safeExec(`ssh ${SSH_OPTS} -i ${BEE_KEY} ${BEE_HOST} "${cmd.replace(/"/g, '\\"')}"`);
  }

  server.tool('bee_run_command',
    'Run a shell command on liquidBee (192.168.1.9) via SSH.',
    {
      command: z.string().describe('Shell command to run on liquidBee'),
    },
    async ({ command }) => {
      const blocked = ['rm -rf /', 'mkfs', 'dd if='];
      if (blocked.some(b => command.includes(b))) {
        return { content: [{ type: 'text', text: 'Error: Command blocked for safety' }] };
      }
      return { content: [{ type: 'text', text: beeExec(command) || '(no output)' }] };
    }
  );

  server.tool('bee_docker_ps',
    'List Docker containers on liquidBee.',
    {
      all: z.boolean().default(false).describe('Include stopped containers'),
    },
    async ({ all }) => {
      const allArg = all ? '-a' : '';
      const raw = beeExec(`docker ps ${allArg} --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"`);
      if (raw.startsWith('Error:') || raw.includes('Cannot connect')) {
        return { content: [{ type: 'text', text: `Docker error: ${raw}` }] };
      }
      const lines = raw.split('\n').filter(Boolean).map(line => {
        const [name, image, status, ports] = line.split('|');
        return `${name.padEnd(28)} ${status.padEnd(30)} ${image}\n${' '.repeat(28)} ${ports || '(no ports)'}`;
      });
      return { content: [{ type: 'text', text: `liquidBee containers:\n\n${lines.join('\n\n') || '(none)'}` }] };
    }
  );

  server.tool('bee_docker_logs',
    'Get recent logs from a Docker container on liquidBee.',
    {
      container: z.string(),
      lines: z.number().int().min(10).max(500).default(50),
      since: z.string().optional().describe('e.g. "1h", "30m"'),
    },
    async ({ container, lines, since }) => {
      const sinceArg = since ? `--since ${since}` : '';
      return { content: [{ type: 'text', text: `Logs: ${container} (liquidBee)\n${'─'.repeat(50)}\n${beeExec(`docker logs ${container} ${sinceArg} --tail ${lines} 2>&1`)}` }] };
    }
  );

  server.tool('bee_system_info',
    'Get system information from liquidBee.',
    {},
    async () => {
      return { content: [{ type: 'text', text: [
        `=== liquidBee (192.168.1.9) ===`,
        `OS:     ${beeExec('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d\\" -f2 || uname -a')}`,
        `CPU:    ${beeExec('cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2')} (${beeExec('nproc')} cores)`,
        `Uptime: ${beeExec('uptime')}`,
        `\nMemory:\n${beeExec('free -h')}`,
        `\nDisk:\n${beeExec('df -h / /mnt 2>/dev/null || df -h /')}`,
      ].join('\n') }] };
    }
  );

