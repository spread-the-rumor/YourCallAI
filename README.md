<div align="center">

<img src="assets/icon.png" alt="Your Call AI" width="140" height="140" />

# Your Call AI

**Local-first meeting notetaker for macOS & Windows.**

Records your screen and meeting audio, transcribes it, resolves who said what, writes an AI summary, and sends it to Slack or GetOverview — with your recordings staying on your own machine.

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)](#install)
[![Electron](https://img.shields.io/badge/built%20with-Electron-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Release](https://img.shields.io/github/v/release/spread-the-rumor/YourCallAI?display_name=tag)](https://github.com/spread-the-rumor/YourCallAI/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

---

## What it does

- 🎙️ **Records** screen + meeting audio locally.
- ✍️ **Transcribes** with [Deepgram](https://deepgram.com/), then resolves speaker names.
- 🧠 **Summarizes** each meeting with an LLM.
- 📤 **Shares** the summary to **Slack** (as yourself, via per-user OAuth) or **GetOverview**.
- 🔒 **Keeps recordings on your machine** — only meeting metadata and transcripts sync per user.
- 🔑 **Holds no API keys in the app.** Every third-party secret lives on a serverless backend; the desktop app only talks to proxy routes.

## How it works

Your Call AI is an [Electron](https://www.electronjs.org/) desktop app paired with a thin serverless backend.

```
┌─────────────────────┐        proxy routes         ┌──────────────────────────┐
│   Electron app      │  ───────────────────────▶   │   Vercel backend (api/)  │
│   (src/)            │   no secrets on client      │   injects secrets server-  │
│                     │                             │   side: Deepgram, LLM,    │
│   • records local   │  ◀───────────────────────   │   Slack, GetOverview      │
│   • local storage   │        results              └──────────────────────────┘
└──────────┬──────────┘
           │  Google SSO + per-user sync
           ▼
      ┌──────────┐
      │ Supabase │   auth + meeting metadata/transcript sync (last-write-wins)
      └──────────┘
```

## Integrations

### Slack (per-user OAuth)

Each user connects their own workspace and posts **as themselves** — no shared bot token. The real Slack token never rides the deep link (only a single-use, 120-second one-time code does), CSRF is guarded with a random `state`, and the token is stored locally and never synced.

- Send summaries to **channels or people** (DMs) from the meeting Slack panel.
- Supports **external / Slack Connect** channels and DM contacts.

### Project Management

Push meeting summaries straight to PM App.

## Install

Download the latest installer for your platform from the [**Releases**](https://github.com/spread-the-rumor/YourCallAI/releases) page:

- **Windows** — `.exe` (Squirrel) installer
- **macOS** — `.dmg`


## License

[MIT](LICENSE) © Rumor Avenue
