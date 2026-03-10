#!/usr/bin/env node

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const hostname = String(process.argv[2] || '').trim();
if (!hostname) {
  console.error('Usage: node bin/vm-setup.js <hostname>');
  console.error('Example: node bin/vm-setup.js myvm.exe.xyz');
  process.exit(1);
}

const sshOptions = [
  '-o', 'ConnectTimeout=5',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new'
];

function execFileDetailed(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30 * 60 * 1000
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: error ? (error.message || 'command failed') : ''
      });
    });
  });
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

async function runCommand(stepLabel, command, args) {
  console.log(`\n[${stepLabel}] Running: ${command} ${args.join(' ')}`);
  const result = await execFileDetailed(command, args);
  if (result.ok) {
    console.log(`[${stepLabel}] OK`);
  } else {
    console.log(`[${stepLabel}] FAILED`);
  }
  const output = combinedOutput(result);
  if (output) {
    console.log(`[${stepLabel}] Output:\n${output}`);
  }
  return result;
}

async function main() {
  const home = homedir();
  const localClaudeCreds = join(home, '.claude', '.credentials.json');
  const localCodexAuth = join(home, '.codex', 'auth.json');
  const localGhHosts = join(home, '.config', 'gh', 'hosts.yml');
  const localPiperModel = join(home, 'voice-terminal', 'models', 'piper', 'en_US-lessac-medium.onnx');
  const localPiperConfig = `${localPiperModel}.json`;

  const summary = [];
  const totalSteps = 11;

  const steps = [
    async () => {
      const result = await runCommand(
        `1/${totalSteps}`,
        'ssh',
        [...sshOptions, hostname, 'mkdir -p ~/.claude ~/.codex ~/.config/gh']
      );
      summary.push({ step: 'Ensure credential directories', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const scpRuns = [
        await runCommand(`2/${totalSteps}`, 'scp', [...sshOptions, localClaudeCreds, `${hostname}:~/.claude/.credentials.json`]),
        await runCommand(`2/${totalSteps}`, 'scp', [...sshOptions, localCodexAuth, `${hostname}:~/.codex/auth.json`]),
        await runCommand(`2/${totalSteps}`, 'scp', [...sshOptions, localGhHosts, `${hostname}:~/.config/gh/hosts.yml`])
      ];
      const ok = scpRuns.every((r) => r.ok);
      const detail = scpRuns.map((r, i) => `file${i + 1}: ${r.ok ? 'ok' : (combinedOutput(r) || r.error)}`).join(' | ');
      summary.push({ step: 'Copy credentials', ok, detail });
      return ok;
    },
    async () => {
      const cmd = "if [ -d ~/voice-terminal/.git ]; then cd ~/voice-terminal && git fetch origin main && git reset --hard origin/main && git clean -fd; else git clone https://github.com/dskill/voice-terminal.git ~/voice-terminal; fi";
      const result = await runCommand(`3/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      summary.push({ step: 'Clone or pull voice-terminal', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const cmd = 'which node && node --version || (sudo apt-get update -qq && sudo apt-get install -y nodejs npm)';
      const result = await runCommand(`4/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      summary.push({ step: 'Ensure Node.js and npm', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const result = await runCommand(`5/${totalSteps}`, 'ssh', [...sshOptions, hostname, 'cd ~/voice-terminal && npm install --prefer-offline']);
      summary.push({ step: 'Install npm deps', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const result = await runCommand(`6/${totalSteps}`, 'ssh', [...sshOptions, hostname, 'cd ~/voice-terminal && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-stt.txt']);
      summary.push({ step: 'Create venv and install STT requirements', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const result = await runCommand(`7/${totalSteps}`, 'ssh', [...sshOptions, hostname, 'claude update || true']);
      summary.push({ step: 'Update Claude Code', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      // Remove any native binary install of codex, then install latest via npm.
      const cmd = 'sudo rm -f /usr/local/bin/codex && sudo npm install -g @openai/codex';
      const result = await runCommand(`8/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      summary.push({ step: 'Install/update Codex via npm', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      let result;
      if (existsSync(localPiperModel) && existsSync(localPiperConfig)) {
        const mkdirResult = await runCommand(`9/${totalSteps}`, 'ssh', [...sshOptions, hostname, 'mkdir -p ~/voice-terminal/models/piper']);
        const modelResult = mkdirResult.ok
          ? await runCommand(`9/${totalSteps}`, 'scp', [...sshOptions, localPiperModel, `${hostname}:~/voice-terminal/models/piper/en_US-lessac-medium.onnx`])
          : { ok: false, stdout: '', stderr: '', error: 'remote mkdir failed' };
        const configResult = modelResult.ok
          ? await runCommand(`9/${totalSteps}`, 'scp', [...sshOptions, localPiperConfig, `${hostname}:~/voice-terminal/models/piper/en_US-lessac-medium.onnx.json`])
          : { ok: false, stdout: '', stderr: '', error: 'model copy failed' };
        const ok = mkdirResult.ok && modelResult.ok && configResult.ok;
        const detail = [mkdirResult, modelResult, configResult].map((r, i) => `part${i + 1}: ${r.ok ? 'ok' : (combinedOutput(r) || r.error)}`).join(' | ');
        summary.push({ step: 'Provision Piper models (local copy)', ok, detail });
        return ok;
      }

      result = await runCommand(
        `9/${totalSteps}`,
        'ssh',
        [
          ...sshOptions,
          hostname,
          'mkdir -p ~/voice-terminal/models/piper && cd ~/voice-terminal/models/piper && wget -q -O en_US-lessac-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx && wget -q -O en_US-lessac-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json'
        ]
      );
      summary.push({ step: 'Provision Piper models (remote wget)', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const result = await runCommand(`10/${totalSteps}`, 'ssh', [...sshOptions, hostname, 'cd ~/voice-terminal && npm run build']);
      summary.push({ step: 'Build frontend', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const cmd = "cd ~/voice-terminal && tmux kill-session -t voice-terminal 2>/dev/null; tmux new-session -d -s voice-terminal -c ~/voice-terminal 'PIPER_MODEL=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx PIPER_MODEL_CONFIG=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx.json . .venv/bin/activate && npm start'";
      const result = await runCommand(`11/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      summary.push({ step: 'Start voice-terminal tmux session', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    }
  ];

  let allOk = true;
  for (const runStep of steps) {
    const ok = await runStep();
    if (!ok) {
      allOk = false;
      break;
    }
  }

  console.log('\n=== vm-setup summary ===');
  for (const item of summary) {
    console.log(`- ${item.ok ? 'PASS' : 'FAIL'}: ${item.step}`);
    if (!item.ok && item.detail) {
      console.log(`  ${item.detail}`);
    }
  }

  if (allOk) {
    console.log(`\nSetup complete for ${hostname}.`);
    process.exit(0);
  }

  console.log(`\nSetup failed for ${hostname}.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
