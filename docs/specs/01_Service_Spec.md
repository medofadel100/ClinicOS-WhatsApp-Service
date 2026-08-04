# ClinicOS WhatsApp Service — Spec

This is a **separate repo and separate deployable service** from
`ClinicOS Web`, because it needs a persistent, always-on process — which
Vercel (serverless) cannot provide. Deploy target: Railway for initial
testing, with Oracle Cloud Free Tier or a small VPS as the long-term free
or low-cost home once the prototype is proven (see the reasoning discussed
with Ahmed — this file assumes that decision is made separately, not
re-litigated here).

## Purpose

This service does exactly one job: **own the WhatsApp connection for every
clinic**, and nothing else. It has no business logic, no AI, no knowledge
of appointments or patients — see `02_Rules_and_Constraints.md` section D
in ClinicOS Web for why that boundary matters.

## Responsibilities

1. **One Baileys session per clinic.** Each clinic gets its own isolated
   WhatsApp Web session (its own auth state, its own connected number).
   Sessions are identified by `clinic_id` (the same UUID used everywhere
   else in ClinicOS).
2. **QR generation per clinic.** `POST /sessions/:clinicId/init` starts (or
   restarts) a session and returns a QR code (as a data URL/base64 image)
   for that clinic's owner to scan. `GET /sessions/:clinicId/status`
   reports `disconnected | qr_pending | connected`.
3. **Sending messages.** `POST /sessions/:clinicId/send` — body: recipient
   phone number, message text (or media URL for sending x-rays/
   prescriptions). This is the only way ClinicOS Web sends anything —
   it never talks to Baileys directly itself.
4. **Receiving messages.** Every inbound WhatsApp message for a clinic's
   session is forwarded via webhook to ClinicOS Web:
   `POST {CLINICOS_WEB_URL}/api/whatsapp/inbound` with `clinic_id`, sender
   number, message body, and any attached media URL. This service does
   not attempt to interpret or respond to the message itself — it just
   relays it and waits for ClinicOS Web to call `/send` back.
5. **Session persistence.** Auth state for each clinic's session is
   persisted to disk (or a small database — SQLite is enough for this
   service) so a service restart doesn't force every clinic to re-scan a
   QR code. This is the single most important reliability requirement —
   losing session state means every connected clinic loses WhatsApp until
   they rescan.

## Rate limiting (hard requirement, not optional)

Every outbound send goes through a per-clinic queue with an enforced delay
between messages (a small fixed delay, e.g. 1–3 seconds, or slightly
randomized to look less bot-like — exact value is an implementation
detail, but a delay must exist). This service must **refuse** to send
faster than that regardless of how fast ClinicOS Web calls `/send` — the
protection belongs here, at the layer that actually talks to WhatsApp, not
just as a promise upstream. This directly protects against the number-ban
risk discussed in ClinicOS Admin's and ClinicOS Web's Rules_and_Constraints
files.

## Authentication between the two services

- ClinicOS Web → this service: a shared secret API key, sent as a header,
  checked on every request. Never exposed to the browser.
- This service → ClinicOS Web (the inbound webhook): same pattern, a
  shared secret header, verified on receipt.
- Neither service exposes anything to the public internet without this
  key check — this service's endpoints are not meant to be called by
  anyone except ClinicOS Web.

## Tech

Node.js + TypeScript, `@whiskeysockets/baileys` (or whichever actively
maintained Baileys fork Ahmed is already using in prior projects, for
consistency), a lightweight HTTP framework (Express/Fastify), SQLite (or
flat files) for session auth-state persistence. Keep dependencies minimal
— this service's job is narrow and it should stay easy to redeploy or
restart without ceremony.

## What this service explicitly does NOT do

- No AI calls, no prompt construction, no reading `whatsapp_bot_config`.
- No database access to the main Supabase project — it doesn't know what a
  patient or appointment is. It only knows `clinic_id` as an opaque
  identifier and phone numbers/message text.
- No decision-making about what to send — it only sends what ClinicOS Web
  tells it to, when told to.
