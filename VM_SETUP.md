# New VM Setup Guide

This guide covers setting up a fresh exe.dev VM with the voice terminal app and all required tools authenticated.

## 1. Clone the Repository

```bash
git clone https://github.com/dskill/voice-terminal.git
cd voice-terminal
```

## 2. Install Node Dependencies and Python Environment

```bash
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-stt.txt
```

## 3. Update Claude Code and Codex to Latest

### Claude Code

```bash
claude update
```

### Codex

Codex is installed globally via npm and requires sudo:

```bash
sudo npm install -g @openai/codex
```

## 4. Transfer Credentials from an Existing VM

If you have SSH access to an already-authenticated VM, copy the credential files directly. No browser login needed on the new VM.

### GitHub (`gh` CLI)

```bash
mkdir -p ~/.config/gh
scp sourcevm:~/.config/gh/hosts.yml ~/.config/gh/hosts.yml
```

### Claude Code

```bash
scp sourcevm:~/.claude/.credentials.json ~/.claude/.credentials.json
```

### Codex

```bash
scp sourcevm:~/.codex/auth.json ~/.codex/auth.json
```

## 5. Start the Voice Terminal

```bash
tmux new-session -d -s voice-terminal -c ~/voice-terminal '. .venv/bin/activate && npm start'
```

Access at `https://your-vm.exe.xyz:3456/`

See the main README for full usage, restart, and troubleshooting instructions.
