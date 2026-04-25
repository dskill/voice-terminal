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
  const localClaudeSettings = join(home, '.claude', 'settings.json');
  const localCodexAuth = join(home, '.codex', 'auth.json');
  const localGhHosts = join(home, '.config', 'gh', 'hosts.yml');
  const localPiperModel = join(home, 'voice-terminal', 'models', 'piper', 'en_US-lessac-medium.onnx');
  const localPiperConfig = `${localPiperModel}.json`;

  const summary = [];
  const totalSteps = 11;
  let shouldRestartService = false;

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
        await runCommand(`2/${totalSteps}`, 'scp', [...sshOptions, localClaudeSettings, `${hostname}:~/.claude/settings.json`]),
        await runCommand(`2/${totalSteps}`, 'scp', [...sshOptions, localCodexAuth, `${hostname}:~/.codex/auth.json`]),
        await runCommand(`2/${totalSteps}`, 'scp', [...sshOptions, localGhHosts, `${hostname}:~/.config/gh/hosts.yml`])
      ];
      const ok = scpRuns.every((r) => r.ok);
      const detail = scpRuns.map((r, i) => `file${i + 1}: ${r.ok ? 'ok' : (combinedOutput(r) || r.error)}`).join(' | ');
      summary.push({ step: 'Copy credentials', ok, detail });
      return ok;
    },
    async () => {
      const cmd = "if [ -d ~/voice-terminal/.git ]; then cd ~/voice-terminal && git fetch -q origin main && LOCAL=$(git rev-parse HEAD 2>/dev/null || echo \"\") && REMOTE=$(git rev-parse origin/main 2>/dev/null || echo \"\") && if [ -n \"$LOCAL\" ] && [ \"$LOCAL\" = \"$REMOTE\" ]; then echo \"SKIP:repo-up-to-date\"; else git reset --hard origin/main && git clean -fd && echo \"CHANGED:repo-updated\"; fi; else git clone https://github.com/dskill/voice-terminal.git ~/voice-terminal && echo \"CHANGED:repo-cloned\"; fi";
      const result = await runCommand(`3/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      if ((combinedOutput(result) || '').includes('CHANGED:')) {
        shouldRestartService = true;
      }
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
      const cmd = `cd ~/voice-terminal
STAMP=".npm-deps-lock.sha256"
LOCK_HASH=$(sha256sum package-lock.json | awk '{print $1}')
if [ -d node_modules ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$LOCK_HASH" ]; then
  echo "SKIP:npm-deps-current"
else
  npm install --prefer-offline --no-audit --no-fund && printf "%s" "$LOCK_HASH" > "$STAMP" && echo "CHANGED:npm-deps-installed"
fi`;
      const result = await runCommand(`5/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      if ((combinedOutput(result) || '').includes('CHANGED:')) {
        shouldRestartService = true;
      }
      summary.push({ step: 'Install npm deps', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const cmd = `cd ~/voice-terminal
CREATED=0
if [ ! -d .venv ]; then python3 -m venv .venv && CREATED=1; fi
. .venv/bin/activate
MISSING=$(python - <<'PY'
import importlib.util
mods=['faster_whisper','piper','pathvalidate','onnxruntime']
missing=[m for m in mods if importlib.util.find_spec(m) is None]
print(' '.join(missing))
PY
)
if [ "$CREATED" = "1" ]; then echo "CHANGED:venv-created"; fi
if [ -n "$MISSING" ]; then
  pip install -r requirements-stt.txt piper-tts pathvalidate && echo "CHANGED:python-deps-installed:$MISSING"
else
  echo "SKIP:python-deps-current"
fi`;
      const result = await runCommand(`6/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      if ((combinedOutput(result) || '').includes('CHANGED:')) {
        shouldRestartService = true;
      }
      summary.push({ step: 'Create venv and install STT/TTS requirements', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const result = await runCommand(`7/${totalSteps}`, 'ssh', [...sshOptions, hostname, 'claude update || true']);
      summary.push({ step: 'Update Claude Code', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      // Remove any native binary install of codex, then install latest via npm.
      const cmd = 'if command -v codex >/dev/null 2>&1; then echo "SKIP:codex-present $(codex --version 2>/dev/null | head -n 1)"; else sudo rm -f /usr/local/bin/codex && sudo npm install -g @openai/codex && echo "CHANGED:codex-installed"; fi';
      const result = await runCommand(`8/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      summary.push({ step: 'Install/update Codex via npm', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const checkResult = await runCommand(
        `9/${totalSteps}`,
        'ssh',
        [
          ...sshOptions,
          hostname,
          'if [ -s ~/voice-terminal/models/piper/en_US-lessac-medium.onnx ] && [ -s ~/voice-terminal/models/piper/en_US-lessac-medium.onnx.json ]; then echo "SKIP:piper-models-present"; else echo "CHANGED:piper-models-missing"; fi'
        ]
      );
      if (!checkResult.ok) {
        summary.push({ step: 'Check Piper models', ok: false, detail: combinedOutput(checkResult) || checkResult.error });
        return false;
      }
      if ((combinedOutput(checkResult) || '').includes('SKIP:piper-models-present')) {
        summary.push({ step: 'Provision Piper models', ok: true, detail: 'Skipped (already present)' });
        return true;
      }

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
        if (ok) shouldRestartService = true;
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
      if (result.ok) shouldRestartService = true;
      summary.push({ step: 'Provision Piper models (remote wget)', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const cmd = `cd ~/voice-terminal
HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
STAMP="dist/.build-commit"
if [ -n "$HEAD" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$HEAD" ]; then
  echo "SKIP:build-current"
else
  npm run build && mkdir -p dist && printf "%s" "$HEAD" > "$STAMP" && echo "CHANGED:build-ran"
fi`;
      const result = await runCommand(`10/${totalSteps}`, 'ssh', [...sshOptions, hostname, cmd]);
      if ((combinedOutput(result) || '').includes('CHANGED:')) {
        shouldRestartService = true;
      }
      summary.push({ step: 'Build frontend', ok: result.ok, detail: combinedOutput(result) || result.error });
      return result.ok;
    },
    async () => {
      const cmd = shouldRestartService
        ? "cd ~/voice-terminal && tmux kill-session -t voice-terminal 2>/dev/null; tmux new-session -d -s voice-terminal -c ~/voice-terminal 'PIPER_MODEL=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx PIPER_MODEL_CONFIG=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx.json . .venv/bin/activate && npm start' && echo 'CHANGED:service-restarted'"
        : "if tmux has-session -t voice-terminal 2>/dev/null; then echo 'SKIP:service-already-running'; else cd ~/voice-terminal && tmux new-session -d -s voice-terminal -c ~/voice-terminal 'PIPER_MODEL=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx PIPER_MODEL_CONFIG=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx.json . .venv/bin/activate && npm start' && echo 'CHANGED:service-started'; fi";
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
