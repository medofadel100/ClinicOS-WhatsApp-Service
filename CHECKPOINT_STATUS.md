# CHECKPOINT_STATUS

Last updated: 2026-08-04

## Status: buildable and locally verified; not yet deployed

## What works

- Express server with all four endpoints (`init`, `status`, `delete`, `send`)
  plus `/health`.
- API key auth on every non-health endpoint (`x-api-key` or Bearer header,
  fail-closed when `API_KEY` is unset) — verified locally: 401 without key,
  401 with wrong key.
- Per-clinic Baileys session manager (`src/sessions.ts`) with:
  - isolated auth state per clinic under `DATA_DIR/sessions/<clinicId>/`;
  - QR generation as base64 data URL (`init` returns `qr_pending` + QR);
  - reconnect with backoff on close, re-scan needed only on logout;
  - `restoreAll()` on boot re-opens persisted sessions (restart-safe);
  - inbound message relay to `POST {CLINICOS_WEB_URL}/api/whatsapp/inbound`
    with `x-webhook-secret`, media as base64 up to ~800 KB;
  - text + media sending (`text` / `image` / `video` / `audio` / `document`
    by file extension).
- Per-clinic send queue (`src/send-queue.ts`): FIFO, one message at a time,
  1.5–3s randomized gap.
- `tsc` typecheck and build pass. `node dist/index.js` connects to WhatsApp
  and produces a real QR (verified locally with a throwaway session).

## Verified locally (throwaway clinic `testclinic`)

- `/health` → 200 ok
- `status` without/wrong key → 401
- `status` with valid key, no session → 404
- `init` → `{ connected: false, qr: <data url>, state: 'qr_pending' }`
  (real WhatsApp connection + QR render)

## Not done yet

- Deploy (Railway initial target; Oracle Cloud/VPS long term). Needs a
  persistent volume for `DATA_DIR`.
- Set real `API_KEY` + `WEBHOOK_SECRET` + `CLINICOS_WEB_URL` on the host.
- ClinicOS Web side (separate repo, out of scope here): `lib/whatsapp-client.ts`
  currently sends no `x-api-key` header — add it when Web is wired to this
  service; its `WHATSAPP_WEBHOOK_SECRET` must equal this service's
  `WEBHOOK_SECRET`.

## Security notes

- No secrets in code; all through env vars. `.env`, `dist/`, `node_modules/`,
  `data/` are gitignored.
- The service knows only `clinic_id`, phone numbers, and message text — no
  business logic by design.
