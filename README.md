# Coup Online

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hangyulkimmy/coup-online)

> Free tier: the server sleeps when idle and takes ~30s to wake on the first visit.

Online multiplayer [Coup](https://boardgamegeek.com/boardgame/131357/coup) with jklm.fun-style room codes. Bluff, challenge, and betray your friends from anywhere.

## Play locally

```bash
npm install
npm start
```

Then open http://localhost:3000. Create a room, share the 4-letter code, and friends join from their own devices on the same network.

## Features

- Full Coup rules — challenges, blocks, and bluffing
- 2–6 players, private room codes, refresh-safe rejoin
- **Inquisitor mode** (optional, host toggle) — the official expansion role
- **Turn timer** (optional, host toggle) — auto-acts if a player stalls, so nobody freezes the game
- Custom card art in `public/images/` (auto-loaded, colored fallback if missing)

## Tech

Node + Express + Socket.IO, with a server-authoritative game engine (`game.js`) and a vanilla JS client (`public/`). No build step.

## Deploy (free)

Deploys as a single always-on Node web service. On [Render](https://render.com):
build command `npm install`, start command `npm start`. The free tier is enough
for playing with friends (the server sleeps after idle and takes ~30s to wake).
