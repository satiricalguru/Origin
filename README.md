<div align="center">
<br/>
  <br/><br/>
# Origin ⦰

### A self-hosted AI workspace — local-first, privacy-first, no trojan.

The full UI experience of ChatGPT and Claude, running on your own hardware with your own data.

<br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11+-3b82f6?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-latest-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://docker.com)
[![PWA](https://img.shields.io/badge/PWA-mobile--ready-a855f7?style=for-the-badge&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)

<br/>

[**Quick Start**](#-quick-start) · [**Features**](#-features) · [**Demo**](#-demo) · [**Config**](#-configuration) · [**Contributing**](#-contributing)

<br/>

</div>

---

## ✦ Overview

Origin is a **self-hosted AI workspace** that puts you back in control. No subscriptions, no data leaving your machine, no black box. Bring your own models — local or API — and get a full-featured interface with agents, email, research, documents, a calendar, memory, and more.

> "Running on your own hardware, with your own data."

---

## ✦ Demo

A full hover-to-play tour lives on the landing page at [`docs/index.html`](docs/index.html).

<details>
<summary>📸 Screenshots & Clips</summary>
<br/>

| Chat & Agents | Deep Research |
|---|---|
| ![Chat](docs/chat.gif) | ![Research](docs/research.gif) |

| Compare Models | Documents |
|---|---|
| ![Compare](docs/compare.gif) | ![Documents](docs/document.gif) |

| Notes & Tasks | |
|---|---|
| ![Notes](docs/notes.gif) | |

</details>

---

## ✦ Features

<table>
<tr>
<td width="50%" valign="top">

**💬 Chat**
Chat with any local model or cloud API. Adding providers takes seconds.
`vLLM` · `llama.cpp` · `Ollama` · `OpenRouter` · `OpenAI`

---

**🤖 Agent**
Hand it tools and let it run the whole task. Web, files, shell, skills, memory.
Built on [`opencode`](https://github.com/anomalyco/opencode) · `MCP` · full tool loop

---

**📚 Cookbook**
Scans your hardware, recommends models, click to download and serve.
[`llmfit`](https://github.com/AlexsJones/llmfit) · VRAM-aware · GGUF / FP8 / AWQ · vLLM / llama.cpp

---

**🔬 Deep Research**
Multi-step runs that gather, read, and synthesize sources into a visual report.
Adapted from [Tongyi DeepResearch](https://github.com/Alibaba-NLP/DeepResearch)

---

**⚖️ Compare**
Compare models side-by-side, completely blind — no label bias.
Multi-model · blind test · synthesis

---

**📝 Documents**
*You* write the text. AI assists, not dominates.
Multi-tab editor · Markdown · HTML · CSV · AI edits · syntax highlighting

</td>
<td width="50%" valign="top">

**🖥️ Workspace IDE**
Full Monaco Editor environment integrated directly into Origin.
File explorer · outline · tabs · global search · Git timeline · terminal

---

**🧠 Memory & Skills**
Your agent evolves over time, learning your preferences and mastering your tasks.
`ChromaDB` · `fastembed` (ONNX) · vector + keyword retrieval · import/export

---

**📧 Email**
IMAP/SMTP inbox with AI triage: urgency detection, auto-tag, auto-summary, reply drafts, spam filtering.
Per-account routing · `CalDAV`-aware

---

**📅 Calendar**
Local-first calendar with CalDAV sync to Radicale, Nextcloud, Apple, or Fastmail.
`.ics` import/export · per-calendar colors · agent-aware

---

**📌 Notes & Tasks**
Quick notes with reminders, a checklist, and cron-style scheduled tasks the agent can act on.
`ntfy` · browser · email notification channels

---

**📱 Mobile Ready**
Looks and runs great on your phone — installable as a PWA.
Responsive · touch gestures · installable

</td>
</tr>
</table>

---

## ✦ Quick Start

Defaults work out of the box: clone, run, then configure models, search, and email inside **Settings**. Only touch `.env` for deployment-level overrides like `APP_PORT`, `AUTH_ENABLED`, or a pre-seeded admin password.

### 🐳 Docker (Recommended)

```bash
git clone https://github.com/satiricalguru/Origin.git
cd Origin
cp .env.example .env       # optional — explicit defaults
docker compose up -d --build
```

Open **http://localhost:7000** once the containers are healthy. If the port is taken, set `APP_PORT=7001` in `.env` and recreate.

---

### 🐧 Native Linux / macOS

```bash
git clone https://github.com/satiricalguru/Origin.git
cd Origin
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python setup.py
python -m uvicorn app:app --host 0.0.0.0 --port 7000
```

> **Requirements:** Python 3.11+. Cookbook also needs `tmux` for background model downloads and serves.

---

### 🍎 Apple Silicon (GPU-accelerated)

Docker on macOS cannot use Metal. For GPU-accelerated Cookbook on M-series:

```bash
git clone https://github.com/satiricalguru/Origin.git
cd Origin
./start-macos.sh
```

Launches at **http://127.0.0.1:7860**. To build a clickable `.app` wrapper:

```bash
./build-macos-app.sh
```

---

### 🪟 Native Windows

**One-command launcher** — creates the venv, installs deps, runs setup, starts the server. Safe to re-run:

```powershell
git clone https://github.com/satiricalguru/Origin.git
cd Origin
powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1
```

<details>
<summary>Manual Windows install</summary>

```powershell
git clone https://github.com/satiricalguru/Origin.git
cd Origin
python -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt
python setup.py
python -m uvicorn app:app --host 127.0.0.1 --port 7000
```

</details>

For local GPU serving on Windows, [Ollama](https://ollama.com/download) is the easiest path — point Origin at `http://localhost:11434/v1` in Settings. Full vLLM/SGLang GPU serving requires Linux/WSL2.

---

<details>
<summary>🔧 GPU, Ollama, Docker & Troubleshooting Notes</summary>

<br/>

**Bundled Docker services.** Compose starts Origin, ChromaDB, SearXNG, and ntfy. All three bind to `127.0.0.1` by default — reachable from the host but not exposed to your LAN unless you opt in.

**Cookbook storage.** Downloads live in `./data/huggingface` (`~/.cache/huggingface` in container). Installed CLIs and serve engines live in `./data/local` (`~/.local` in container) — both survive container recreation.

**Remote servers.** In **Cookbook → Settings → Servers**, generate the Origin SSH key and add it to the remote's `~/.ssh/authorized_keys`:

```bash
ssh-copy-id -i data/ssh/id_ed25519.pub user@server
```

**NVIDIA / AMD GPU overlays.** Install the host runtime, then add one line to `.env`:

```bash
# NVIDIA
COMPOSE_FILE=docker-compose.yml:docker/gpu.nvidia.yml

# AMD ROCm
COMPOSE_FILE=docker-compose.yml:docker/gpu.amd.yml
```

Verify:

```bash
docker compose exec origin nvidia-smi -L
docker compose exec origin rocm-smi
```

**Ollama with Docker.** Add this endpoint in Settings:

```
http://host.docker.internal:11434/v1
```

Ollama must bind outside loopback: `OLLAMA_HOST=0.0.0.0:11434 ollama serve`

**Quick diagnostics:**

```bash
docker compose ps
docker compose logs --tail=120 origin
docker compose logs origin | grep -E 'ChromaDB|MemoryVectorStore|DEGRADED'
```

</details>

---

## ✦ Security Notes

Origin is a self-hosted workspace with powerful local tools: shell access, file uploads, model downloads, web research, email/calendar integrations, and API tokens. **Treat it like an admin console.**

| ✅ Do | ❌ Avoid |
|---|---|
| Keep `AUTH_ENABLED=true` on any networked deployment | Exposing to the public internet without HTTPS + reverse proxy |
| Keep `data/`, `.env`, logs, and databases out of Git (ignored by default) | Committing any live data, API keys, or password hashes |
| Review `data/auth.json` after first boot — disable open signup, keep only your account as admin | Leaving demo/test accounts as admin |
| Rotate any API keys ever pasted into a shared chat, log, or screenshot | Reusing tokens across integrations |
| Bind dev runs to `127.0.0.1` | Binding to `0.0.0.0` without intent |

### HTTPS

Origin serves plain HTTP. Fine for `localhost` and trusted LAN/VPN — but put a TLS-terminating proxy in front for anything else.

**Caddy** (auto-renews Let's Encrypt):

```caddy
origin.example.com {
  reverse_proxy localhost:7000
}
```

For Tailscale: use Caddy + [tailscale-cert](https://caddyserver.com/docs/caddyfile/options#auto-https) or MagicDNS HTTPS. nginx/Traefik configs are equivalent — proxy `localhost:7000`, terminate TLS at the proxy.

---

## ✦ Configuration

Most setup is done inside the app via `/setup` or **Settings**. Use `.env` for deployment-level defaults and secrets you want present before first boot.

| Variable | Default | Description |
|---|---|---|
| `LLM_HOST` | `localhost` | Primary LLM server host |
| `LLM_HOSTS` | — | Comma-separated list for multi-host model discovery |
| `OPENAI_API_KEY` | — | OpenAI key (prefer in-app unless pre-seeding) |
| `SEARXNG_INSTANCE` | `http://localhost:8080` | SearXNG URL (Docker overrides to `http://searxng:8080`) |
| `SEARXNG_SECRET` | auto-generated | Cookie/CSRF secret. Leave blank to auto-generate on first boot. |
| `AUTH_ENABLED` | `true` | Enable / disable login |
| `LOCALHOST_BYPASS` | `false` | Dev-only loopback auth bypass — keep false for any shared deployment |
| `DATABASE_URL` | `sqlite:///./data/app.db` | Database connection string |
| `CHROMADB_HOST` | `localhost` | ChromaDB host (Docker overrides to `chromadb`) |
| `CHROMADB_PORT` | `8100` | ChromaDB port for manual runs (Docker overrides to `8000`) |
| `EMBEDDING_URL` | — | OpenAI-compatible embeddings endpoint |
| `ORIGIN_INPROCESS_POLLERS` | `1` | Set to `0` to drive email polling externally via cron |
| `ORIGIN_INPROCESS_TASKS` | `1` | Set to `0` to drive scheduled tasks externally |

### Built-in MCP Servers

Origin auto-registers built-in MCP servers at startup. `npx`-based servers (like `@playwright/mcp`) only start if their package is already cached — a fresh install won't hang on a download.

To enable the browser MCP (navigation, screenshots, vision), run once:

```bash
npx -y @playwright/mcp@latest --version
```

Restart Origin and the server registers automatically.

---

## ✦ Architecture

```
app.py                   # FastAPI entry point
├── core/                # auth, database, middleware, constants
├── src/                 # llm_core, agent_loop, agent_tools, chat_processor, search/
├── routes/              # chat, session, document, memory, model … REST endpoints
├── services/            # docs, memory, search, hwfit (Cookbook) …
├── static/              # index.html + app.js + style.css + js/ (modular front-end)
└── docs/                # landing page (index.html) + preview clips
```

**Data** — all user data lives in `data/` (gitignored):
`app.db` · `memory.json` · `presets.json` · `uploads/` · `personal_docs/` · `chroma/` · `settings.json` · `ide_workspace.json`

---

## ✦ Contributing

Help is welcome. Best entry points: fresh-install testing, provider setup bugs, mobile/editor polish, docs, and small focused refactors.

See [**CONTRIBUTING.md**](CONTRIBUTING.md) for setup, testing, and pull request guidelines.
See [**ROADMAP.md**](ROADMAP.md) for the current help-wanted list.

---

## ✦ Star History

<div align="center">

<a href="https://www.star-history.com/?repos=satiricalguru%2FOrigin&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=satiricalguru/Origin&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=satiricalguru/Origin&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=satiricalguru/Origin&type=date&legend=top-left" width="600" />
  </picture>
</a>

</div>

---

## ✦ License

MIT — see [LICENSE](LICENSE) and [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).

---

<div align="center">

**Built with care. Runs on your machine. Stays yours.**

[⭐ Star on GitHub](https://github.com/satiricalguru/Origin) · [🐛 Report an Issue](https://github.com/satiricalguru/Origin/issues) · [🤝 Contribute](CONTRIBUTING.md)

</div>
