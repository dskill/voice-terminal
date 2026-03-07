# New VM Setup Guide

This guide covers setting up a fresh exe.dev VM with the voice terminal app and all required tools authenticated.

## 0. Add New VM to Known Hosts (from source VM)

Before you can SSH or SCP to the new VM, add its host key:

```bash
ssh-keyscan -H <newvm>.exe.xyz >> ~/.ssh/known_hosts
```

## 1. Transfer Credentials from an Existing VM

Do this before cloning, so `gh` is authenticated. Run these commands **from the source VM**, pushing credentials to the new VM:

```bash
# Create necessary dirs on new VM
ssh <newvm>.exe.xyz 'mkdir -p ~/.claude ~/.codex ~/.config/gh'

# Push credentials
scp ~/.claude/.credentials.json <newvm>.exe.xyz:~/.claude/.credentials.json
scp ~/.codex/auth.json <newvm>.exe.xyz:~/.codex/auth.json
scp ~/.config/gh/hosts.yml <newvm>.exe.xyz:~/.config/gh/hosts.yml
```

## 2. Clone the Repository

```bash
git clone https://github.com/dskill/voice-terminal.git
cd voice-terminal
```

## 3. Install Node.js and npm (if not present)

exe.dev VMs may not have Node.js pre-installed. Check first:

```bash
npm --version || sudo apt-get install -y nodejs npm
```

## 4. Install Node Dependencies and Python Environment

```bash
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-stt.txt
```

## 5. Update Claude Code and Codex to Latest

### Claude Code

```bash
claude update
```

### Codex

Codex may already be pre-installed as a binary at `/usr/local/bin/codex`. Check first:

```bash
which codex && codex --version
```

If not installed, install via npm (requires sudo):

```bash
sudo npm install -g @openai/codex
```

Note: If a native binary install of Codex exists at `/usr/local/bin/codex`, `sudo npm install -g` will fail. Remove it first, then install via npm to get the latest version:

```bash
sudo rm /usr/local/bin/codex
sudo npm install -g @openai/codex
```

## 6. Set Up Piper TTS

Piper TTS is disabled unless `PIPER_MODEL` points to a local `.onnx` voice model. The recommended model is `en_US-lessac-medium`.

### Option A: Copy from an existing VM (fastest)

```bash
# Run from the source VM
ssh <newvm>.exe.xyz 'mkdir -p ~/voice-terminal/models/piper'
scp ~/voice-terminal/models/piper/en_US-lessac-medium.onnx <newvm>.exe.xyz:~/voice-terminal/models/piper/
scp ~/voice-terminal/models/piper/en_US-lessac-medium.onnx.json <newvm>.exe.xyz:~/voice-terminal/models/piper/
```

### Option B: Download from Hugging Face

```bash
mkdir -p ~/voice-terminal/models/piper
cd ~/voice-terminal/models/piper
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

## 7. Start the Voice Terminal

Start with `PIPER_MODEL` and `PIPER_MODEL_CONFIG` set so TTS is enabled:

```bash
tmux new-session -d -s voice-terminal -c ~/voice-terminal \
  'PIPER_MODEL=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx \
   PIPER_MODEL_CONFIG=$HOME/voice-terminal/models/piper/en_US-lessac-medium.onnx.json \
   . .venv/bin/activate && npm start'
```

Access at `https://your-vm.exe.xyz:3456/`

See the main README for full usage, restart, and troubleshooting instructions.
