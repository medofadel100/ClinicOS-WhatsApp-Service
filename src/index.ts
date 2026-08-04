import express, { type Request, type Response } from 'express'
import { Boom } from '@hapi/boom'
import { config } from './config'
import { logger } from './logger'
import { requireApiKey } from './auth'
import { SessionManager } from './sessions'
import { SendQueueManager, type SendJob } from './send-queue'

const app = express()
const sessions = new SessionManager(config.dataDir)
const sendQueue = new SendQueueManager()

app.use(express.json({ limit: '1mb' }))

app.use((req: Request, res: Response, next) => {
  const origin = req.headers.origin
  const allowed = config.corsOrigins.includes('*') || (origin && config.corsOrigins.includes(origin))
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigins.includes('*') ? '*' : origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-key,Authorization')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

app.post('/sessions/:clinicId/init', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { clinicId } = req.params
    const result = await sessions.init(clinicId)
    res.json(result)
  } catch (err) {
    logger.error({ clinicId: req.params.clinicId, err: (err as Error).message }, 'init failed')
    res.status(500).json({ error: 'failed to init session' })
  }
})

app.get('/sessions/:clinicId/status', requireApiKey, (req: Request, res: Response) => {
  const { clinicId } = req.params
  const status = sessions.status(clinicId)
  if (!status) {
    res.status(404).json({ error: 'no session for clinic' })
    return
  }
  res.json(status)
})

app.delete('/sessions/:clinicId', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { clinicId } = req.params
    const removed = await sessions.disconnect(clinicId)
    if (!removed) {
      res.status(404).json({ error: 'no session for clinic' })
      return
    }
    res.status(204).end()
  } catch (err) {
    logger.error({ clinicId: req.params.clinicId, err: (err as Error).message }, 'disconnect failed')
    res.status(500).json({ error: 'failed to disconnect session' })
  }
})

app.post('/sessions/:clinicId/send', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { clinicId } = req.params
    const { recipient, message, mediaUrl } = req.body || {}

    if (!recipient || typeof recipient !== 'string' || recipient.trim() === '') {
      res.status(400).json({ error: 'recipient is required' })
      return
    }
    if ((!message || typeof message !== 'string') && !mediaUrl) {
      res.status(400).json({ error: 'message or mediaUrl is required' })
      return
    }

    const status = sessions.status(clinicId)
    if (!status || !status.connected) {
      res.status(409).json({ error: 'session is not connected' })
      return
    }

    const sendExecutor = async (job: SendJob): Promise<void> => {
      const session = sessions.get(clinicId)
      if (!session) throw new Error('session not found')
      await session.send(job.to, job.text, job.mediaUrl)
    }

    const id = sendQueue.enqueue(clinicId, {
      to: recipient.trim(),
      text: message as string | undefined,
      mediaUrl: mediaUrl as string | undefined,
    }, sendExecutor)
    res.json({ queued: true, id })
  } catch (err) {
    logger.error({ clinicId: req.params.clinicId, err: (err as Error).message }, 'send failed')
    res.status(500).json({ error: 'failed to queue message' })
  }
})

app.use(
  (err: unknown, _req: Request, res: Response, _next: (e?: unknown) => void): void => {
    const boom = err as Boom
    if (boom?.isBoom) {
      const { statusCode } = boom.output
      res.status(statusCode).json({ error: boom.message })
      return
    }
    logger.error({ err }, 'unhandled error')
    res.status(500).json({ error: 'internal server error' })
  }
)

const port = config.port
const server = app.listen(port, () => {
  logger.info(`whatsapp service listening on :${port}`)
  sessions.restoreAll()
})

async function shutdown(): Promise<void> {
  logger.info('shutting down')
  server.close()
  await sessions.shutdown()
  process.exit(0)
}

process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})
