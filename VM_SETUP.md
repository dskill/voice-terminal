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
3. Pre-accept Claude Code's first-run dialogs (see below)
4. Clone or hard-reset the `voice-terminal` repo
5. Install Node.js and npm (via apt if not present)
6. Install npm dependencies
7. Create Python venv and install STT (faster-whisper) requirements
8. Update Claude Code (`claude update`)
9. Install latest Codex via npm (removes native binary if present)
10. Provision Piper TTS models (copies from source VM if available, otherwise downloads from HuggingFace)
11. Build the frontend (`npm run build`)
12. Start the `voice-terminal` tmux session

Once complete, access the app at `https://<hostname>:3456/`.

## Pre-accepting Claude Code's first-run dialogs

Step 3 sets two config keys on the target VM:

- `skipDangerousModePermissionPrompt: true` in `~/.claude/settings.json`
- `projects["$HOME"].hasTrustDialogAccepted: true` and the same for
  `~/voice-terminal`, in `~/.claude.json`

Both suppress an arrow-key selection dialog that a newly created tmux session
would otherwise sit on. This matters because `tmux-broker send-input` cannot
answer a menu — it pastes text the dialog discards, then sends Enter, which
confirms whichever option is highlighted. On the bypass-permissions warning the
pre-highlighted option is **"No, exit"**, so the session dies instead of
receiving its first briefing.

The step is idempotent and merges into the existing files rather than replacing
them. It runs *after* the credential copy, which overwrites both. It sets the
keys explicitly rather than relying on that copy: the source VM's config is
unversioned, so a fresh VM would otherwise inherit whatever state that machine
happened to be in.

If a session does land on a dialog anyway, `tmux-broker status` now reports it
as `blocked` (not `idle`) with the parsed options, `send-input` refuses rather
than pressing Enter blind, and `tmux-broker send-keys --key Down --key Enter`
can answer it.

## Notes

- SSH host keys are accepted automatically (`StrictHostKeyChecking=accept-new`), so no manual `ssh-keyscan` needed.
- Steps run sequentially and stop on first failure. Check the summary output for details.
- To restart just the app later: `tmux kill-session -t voice-terminal` then re-run step 11's command (see README).
