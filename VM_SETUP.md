# New VM Setup

Use the setup CLI to provision a fresh exe.dev VM in one command:

```bash
node bin/vm-setup.js <hostname>
# Example:
node bin/vm-setup.js myvm.exe.xyz
```

Run this **from an already-configured VM** that has credentials and Piper models. The script will:

1. Ensure credential directories exist on the target VM
2. Copy credentials (Claude, Codex, GitHub CLI)
3. Clone or hard-reset the `voice-terminal` repo
4. Install Node.js and npm (via apt if not present)
5. Install npm dependencies
6. Create Python venv and install STT (faster-whisper) requirements
7. Update Claude Code (`claude update`)
8. Install latest Codex via npm (removes native binary if present)
9. Provision Piper TTS models (copies from source VM if available, otherwise downloads from HuggingFace)
10. Build the frontend (`npm run build`)
11. Start the `voice-terminal` tmux session

Once complete, access the app at `https://<hostname>:3456/`.

## Notes

- SSH host keys are accepted automatically (`StrictHostKeyChecking=accept-new`), so no manual `ssh-keyscan` needed.
- Steps run sequentially and stop on first failure. Check the summary output for details.
- To restart just the app later: `tmux kill-session -t voice-terminal` then re-run step 11's command (see README).
