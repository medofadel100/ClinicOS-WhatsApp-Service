import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { Boom } from '@hapi/boom'
import makeWASocket, {
  Browsers,
  ConnectionState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidStatusBroadcast,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import { logger } from './logger'
import { sendInboundWebhook } from './webhook'

export type SessionState = 'connected' | 'qr_pending' | 'disconnected'

export type SessionStatus = {
  connected: boolean
  state: SessionState
  user?: string
}

export type InitResult = {
  connected: boolean
  user?: string
  qr?: string
  state?: SessionState
}

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage']
// Keep webhook bodies well under the Web route's ~1MB body limit.
const MAX_MEDIA_BYTES = 800 * 1024

class Session {
  socket?: WASocket
  connected = false
  user?: string
  qrDataUrl?: string

  private authDir?: string
  private reconnectTimer?: NodeJS.Timeout

  constructor(private clinicId: string, private dataDir: string) {}

  get state(): SessionState {
    if (this.connected) return 'connected'
    if (this.qrDataUrl) return 'qr_pending'
    return 'disconnected'
  }

  get status(): SessionStatus {
    const status: SessionStatus = { connected: this.connected, state: this.state }
    if (this.user) status.user = this.user
    return status
  }

  async start(): Promise<void> {
    this.stopSocket()

    const dir = path.join(this.dataDir, 'sessions', this.clinicId)
    fs.mkdirSync(dir, { recursive: true })
    this.authDir = dir

    const { state, saveCreds } = await useMultiFileAuthState(dir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('ClinicOS'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })

    this.socket = sock
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(update)
    })
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      void this.handleInbound(messages)
    })
  }

  async logout(): Promise<void> {
    const sock = this.socket
    if (sock) {
      try {
        await sock.logout()
      } catch {
        // socket may already be dead
      }
    }
    this.stopSocket()
    if (this.authDir) {
      fs.rmSync(this.authDir, { recursive: true, force: true })
    }
  }

  async send(to: string, text?: string, mediaUrl?: string): Promise<boolean> {
    const sock = this.socket
    if (!sock || !this.connected) return false
    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`
    let content: AnyMessageContent
    if (mediaUrl) {
      content = buildMediaContent(mediaUrl, text)
    } else {
      content = { text: text || '' }
    }
    await sock.sendMessage(jid, content)
    return true
  }

  async waitForInit(timeoutMs: number): Promise<InitResult> {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const check = () => {
        if (this.connected) {
          resolve({ connected: true, user: this.user })
          return
        }
        if (this.qrDataUrl) {
          resolve({ connected: false, qr: this.qrDataUrl, state: 'qr_pending' })
          return
        }
        if (Date.now() >= deadline) {
          resolve({ connected: false, state: 'disconnected' })
          return
        }
        setTimeout(check, 250)
      }
      check()
    })
  }

  private stopSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const sock = this.socket
    this.socket = undefined
    this.connected = false
    this.qrDataUrl = undefined
    if (sock) {
      try {
        sock.ev.removeAllListeners('creds.update')
      } catch {
        // ignore
      }
      try {
        sock.ev.removeAllListeners('connection.update')
      } catch {
        // ignore
      }
      try {
        sock.ev.removeAllListeners('messages.upsert')
      } catch {
        // ignore
      }
      try {
        sock.end(undefined)
      } catch {
        // ignore
      }
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr)
      } catch (err) {
        logger.error({ clinicId: this.clinicId, err: (err as Error).message }, 'failed to render QR')
      }
    }

    if (connection === 'open') {
      this.connected = true
      const rawUser = this.socket?.user?.id || ''
      this.user = rawUser.split('@')[0] || undefined
      logger.info({ clinicId: this.clinicId, user: this.user }, 'session connected')
      return
    }

    if (connection === 'close') {
      this.connected = false
      this.qrDataUrl = undefined
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      if (loggedOut) {
        logger.info({ clinicId: this.clinicId }, 'session logged out — clearing persisted state')
        if (this.authDir) {
          fs.rmSync(this.authDir, { recursive: true, force: true })
        }
        this.stopSocket()
        return
      }

      const delayMs = 1000 + Math.round(Math.random() * 3000)
      logger.warn({ clinicId: this.clinicId, statusCode }, `connection closed — reconnecting in ${delayMs}ms`)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        void this.start()
      }, delayMs)
    }
  }

  private async handleInbound(messages: WAMessage[]): Promise<void> {
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key?.fromMe) continue
        const remote = msg.key?.remoteJid
        if (!remote || isJidBroadcast(remote) || isJidStatusBroadcast(remote)) continue
        if (!remote.includes('@s.whatsapp.net')) continue

        const from = remote.split('@')[0]
        const type = getContentType(msg.message)
        const content: any = msg.message

        let text = ''
        if (type === 'conversation') text = content.conversation || ''
        else if (type === 'extendedTextMessage') text = content.extendedTextMessage?.text || ''
        else if (type && content[type]?.caption) text = content[type].caption || ''

        let mediaBase64: string | undefined
        let mimeType: string | undefined
        if (type && MEDIA_TYPES.includes(type) && content[type]?.mimetype) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
              reuploadRequest: this.socket!.updateMediaMessage.bind(this.socket!),
              logger,
            })
            if (buffer && buffer.length <= MAX_MEDIA_BYTES) {
              mediaBase64 = buffer.toString('base64')
              mimeType = content[type].mimetype
            } else if (buffer) {
              logger.warn(
                { clinicId: this.clinicId, bytes: buffer.length },
                'incoming media too large for webhook — forwarding text only'
              )
            }
          } catch (err) {
            logger.error({ clinicId: this.clinicId, err: (err as Error).message }, 'failed to download inbound media')
          }
        }

        await sendInboundWebhook({
          clinicId: this.clinicId,
          clinic_id: this.clinicId,
          from,
          message: text,
          mediaBase64,
          mimeType,
        })
      } catch (err) {
        logger.error({ clinicId: this.clinicId, err: (err as Error).message }, 'failed to handle inbound message')
      }
    }
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>()

  constructor(private dataDir: string) {}

  get(clinicId: string): Session | undefined {
    return this.sessions.get(clinicId)
  }

  status(clinicId: string): SessionStatus | undefined {
    const session = this.sessions.get(clinicId)
    return session ? session.status : undefined
  }

  async init(clinicId: string): Promise<InitResult> {
    const existing = this.sessions.get(clinicId)
    if (existing) {
      if (existing.connected) {
        return { connected: true, user: existing.user }
      }
      await existing.start()
      return existing.waitForInit(15000)
    }

    const session = new Session(clinicId, this.dataDir)
    this.sessions.set(clinicId, session)
    void session.start()
    return session.waitForInit(15000)
  }

  async disconnect(clinicId: string): Promise<boolean> {
    const session = this.sessions.get(clinicId)
    if (!session) return false
    await session.logout()
    this.sessions.delete(clinicId)
    return true
  }

  /**
   * Rebuild sockets for every clinic that has persisted auth state, so a
   * service restart does not force any clinic to rescan its QR code.
   */
  restoreAll(): void {
    const baseDir = path.join(this.dataDir, 'sessions')
    if (!fs.existsSync(baseDir)) return

    for (const entry of fs.readdirSync(baseDir)) {
      const full = path.join(baseDir, entry)
      if (!fs.statSync(full).isDirectory()) continue
      if (!fs.existsSync(path.join(full, 'creds.json'))) continue

      const session = new Session(entry, this.dataDir)
      this.sessions.set(entry, session)
      void session.start()
      logger.info({ clinicId: entry }, 'restored persisted session')
    }
  }

  /** Called on shutdown — stops every socket so persisted creds stay valid. */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        await session.logout()
      } catch {
        // ignore
      }
    }
    this.sessions.clear()
  }
}

// Re-exported type so callers (index.ts) can build media/message payloads.
export type { AnyMessageContent }

const DOC_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.m4a', '.opus', '.aac', '.wav'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi'])

const DOC_MIMETYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
}

function buildMediaContent(mediaUrl: string, caption?: string): AnyMessageContent {
  const ext = path.extname(new URL(mediaUrl).pathname).toLowerCase()
  if (DOC_EXTENSIONS.has(ext)) {
    return {
      document: { url: mediaUrl },
      fileName: path.basename(mediaUrl),
      caption,
      mimetype: DOC_MIMETYPES[ext] || 'application/octet-stream',
    }
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return { audio: { url: mediaUrl } }
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return { video: { url: mediaUrl }, caption }
  }
  return { image: { url: mediaUrl }, caption }
}
