# Minecraft Bedrock 3D Model Lab

An interactive browser-based Minecraft Bedrock 3D model renderer, bone inspector, lightweight geometry editor, and live Altay/PMMP player skin editor built with Three.js and Cloudflare Workers.

🌐 **[Live Demo](https://zulfahmifjr.github.io/Bedrock3DLab/)**

---

## 📁 Repository Structure

- **Root (`/`, `index.html`, `main.js`, `style.css`, `assets/`)** — Static web frontend hosted on **GitHub Pages**.
- **[`relay/`](relay/)** — **Cloudflare Workers + Durable Objects** WebSocket relay (`ServerRoom` with WebSocket Hibernation API and per-server pairing codes).

---

## ✨ Key Features

- **Dynamic Model Loading & Multi-Geometry Support** — Load local `model.json` and `texture.png` files or preview built-in sample models (`?model=boat`, `player`, `sniffer`).
- **Bone Hierarchy & Transform Tools** — Inspect parent-child bone trees and transform bones with `W` (Move), `E` (Rotate), `R` (Scale), `Q` (Local/World), `Esc` (Deselect), `Ctrl+Z` / `Ctrl+Y` (Undo/Redo).
- **Edited JSON Export & Transparent Auto-Crop Screenshots** — Export updated bone pivots/rotations back into Bedrock geometry JSON or capture clean model-only PNG screenshots.
- **Zero-Config Server Pairing (`Bedrock3DLabBridge`)** — Install the plugin on your Altay/PMMP server, run `/b3dlab link`, and open the generated URL (`https://zulfahmifjr.github.io/Bedrock3DLab/?server=...&code=...`) to connect without exposing IPs or configuring ports.
- **Live 2-Way Skin Inspection & Editing** — Click any online player in the relay list to fetch and inspect their skin/geometry in 3D, edit it in the browser, and push changes back to the server (**Apply to Server**) or restore (**Revert Skin**).

---

## 🚀 Hosting & Deployment

### 1. Web Frontend (GitHub Pages)
Served directly from the repository root (`/`) on GitHub Pages (`https://zulfahmifjr.github.io/Bedrock3DLab/`).

### 2. Relay Server (Cloudflare Workers)
```bash
cd relay
npm install
npx wrangler login
npx wrangler deploy
```

Run relay unit & Durable Object WebSocket tests locally:
```bash
cd relay
npm test
```
