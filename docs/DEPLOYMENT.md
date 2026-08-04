# Deployment — Windows server + Cloudflare Tunnel

Server: `DESKTOP-I8QM0ET` (Windows 10, Proxmox VM) at `192.168.100.48`.
Public entry is a **single Cloudflare Tunnel** (`smartx-main`, id
`7043a447-b5e4-4fa2-92f0-75c6730e6468`) installed as the `Cloudflared`
Windows service.

All services listen on **local ports only**; the tunnel forwards public
hostnames to them. DNS CNAMEs were created with `cloudflared tunnel route dns`.

## Subdomain map (fixed, do not change without updating config.yml)

| Hostname | Service | Local port |
| --- | --- | --- |
| `whatsapp.smartx.business` | WhatsApp (Baileys) service | `3002` |
| `api.smartx.business` | API (Taqfeela sync, future) | `4000` |
| `app.smartx.business` | Web app (future) | `5000` |
| `admin.smartx.business` | Admin dashboard (future) | `5001` |
| `smartx.business` | Company site (future) | `8080` |

Unbuilt services return `502` until a process starts on their reserved port
— no config change needed then.

## Tunnel config

`C:\Users\Ai-LLM\.cloudflared\config.yml`:

```yaml
tunnel: 7043a447-b5e4-4fa2-92f0-75c6730e6468
credentials-file: C:\Users\Ai-LLM\.cloudflared\7043a447-b5e4-4fa2-92f0-75c6730e6468.json

ingress:
  - hostname: whatsapp.smartx.business
    service: http://localhost:3002
  - hostname: api.smartx.business
    service: http://localhost:4000
  - hostname: app.smartx.business
    service: http://localhost:5000
  - hostname: admin.smartx.business
    service: http://localhost:5001
  - hostname: smartx.business
    service: http://localhost:8080
  - service: http_status:404
```

## Windows services on the server

| Service | Binary / task | Config |
| --- | --- | --- |
| `Cloudflared` (AUTO) | `cloudflared.exe tunnel --config ... run` | `C:\Users\Ai-LLM\.cloudflared\config.yml` |
| `ClinicOS-WhatsApp-Service` | Scheduled task at startup, runs as SYSTEM, restart on failure | `C:\Users\Ai-LLM\ClinicOS-WhatsApp-Service\.env` |

WhatsApp service details:
- Code: `C:\Users\Ai-LLM\ClinicOS-WhatsApp-Service`
- Session data: `C:\Users\Ai-LLM\ClinicOS-WhatsApp-Service\data`
- Runs `node dist/index.js` via scheduled task `ClinicOS-WhatsApp-Service`.

## Env vars used on the server

```
PORT=3002
API_KEY=wapp-svc-fadel-2026
WEBHOOK_SECRET=526759cb05ce40c280610261102f663b40e6724161194875af7229e286b9c353
CLINICOS_WEB_URL=https://clinicoseg.vercel.app
DATA_DIR=C:\Users\Ai-LLM\ClinicOS-WhatsApp-Service\data
LOG_LEVEL=info
CORS_ORIGINS=https://clinicoseg.vercel.app
```

Notes:
- `CLINICOS_WEB_URL` is the inbound webhook target (`<url>/api/whatsapp/inbound`).
- `CORS_ORIGINS` (comma-separated) is what the WhatsApp dashboard page in the
  browser is allowed to call; keep it to the real web origin, not `*`.

## Next / pending

- Server: keep `data/` backed up (session loss = re-scan QR).
