# ClinicOS WhatsApp Service

Standalone Node.js service that owns the WhatsApp connection for every
clinic (one isolated Baileys session per `clinic_id`). It has **no business
logic** — it only starts sessions, relays inbound messages to ClinicOS Web,
and sends whatever ClinicOS Web tells it to send.

This is a separate repo and deployable from `ClinicOS Web` because it
needs a persistent, always-on process (Vercel can't run Baileys).

## API

All endpoints except `/health` require the shared API key via header
`x-api-key` (or `Authorization: Bearer <key>`). Requests fail closed if
`API_KEY` is not set.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness check (no auth). |
| `POST` | `/sessions/:clinicId/init` | Start/restart a session. Returns `{ connected }` or `{ connected: false, qr, state: 'qr_pending' }` where `qr` is a base64 data URL for the owner to scan. |
| `GET` | `/sessions/:clinicId/status` | `{ connected, state: 'connected' \| 'qr_pending' \| 'disconnected', user? }`. `404` if no session was ever started. |
| `DELETE` | `/sessions/:clinicId` | Log out the session and delete its persisted auth state. `204` on success, `404` if none. |
| `POST` | `/sessions/:clinicId/send` | Body: `{ recipient, message?, mediaUrl? }`. Queues the message; returns `{ queued: true, id }`. `409` if the session is not connected. |

## Inbound webhook

Every inbound WhatsApp message is forwarded to
`POST {CLINICOS_WEB_URL}/api/whatsapp/inbound` with body:

```json
{
  "clinicId": "<uuid>",
  "clinic_id": "<uuid>",
  "from": "<sender phone>",
  "message": "<text>",
  "mediaBase64": "<optional base64, omitted if too large>",
  "mimeType": "<optional>"
}
```

The request carries header `x-webhook-secret` (must match the secret
ClinicOS Web verifies). Media larger than ~800 KB is skipped and the text
is forwarded alone.

## Rate limiting

Every outbound send goes through a per-clinic FIFO queue: one message at a
time, with a randomized 1.5–3s gap. The service refuses to send faster than
this no matter how fast ClinicOS Web calls `/send`.

## Session persistence

Auth state is stored per clinic under `DATA_DIR/sessions/<clinicId>/`
(multi-file auth state). On startup, `restoreAll()` re-opens every session
that has saved `creds.json`, so a restart does not force clinics to rescan
QR codes. A clean `logout` (or WhatsApp-side logout) deletes the state so a
fresh QR is required next time.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | no | Default `3002`. |
| `API_KEY` | yes | Shared secret for calls into this service. Never expose to the browser. |
| `WEBHOOK_SECRET` | yes | Shared secret sent to ClinicOS Web's inbound webhook; must match ClinicOS Web's `WHATSAPP_WEBHOOK_SECRET`. |
| `CLINICOS_WEB_URL` | yes | Base URL of ClinicOS Web, used for the inbound webhook. |
| `DATA_DIR` | no | Where session auth state lives. Default `./data`. Use a persistent volume in production. |
| `LOG_LEVEL` | no | pino level. Default `info`. |

## Development

```bash
npm install
cp .env.example .env   # then fill in values
npm run dev            # tsx watch
npm run typecheck
npm run build          # tsc -> dist/
npm start              # node dist/index.js
```

## Deployment

Railway (or a VPS) with a persistent volume mounted at `/data` — this is
required so sessions survive restarts. Set all env vars above; never commit
`.env`. `railway.json` is included — Railway will auto-detect and mount the
volume at `/data`. Set `DATA_DIR=/data` in Railway's environment variables
(the default `./data` only works locally).
