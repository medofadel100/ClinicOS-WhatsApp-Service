import type { NextFunction, Request, Response } from 'express'
import { config } from './config'
import { logger } from './logger'

/**
 * Rejects every request unless it carries the shared API key
 * (header `x-api-key` or `Authorization: Bearer <key>`).
 * Fails closed when API_KEY is not configured.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!config.apiKey) {
    logger.error('API_KEY is not configured — refusing all requests')
    return res.status(500).json({ error: 'Server misconfigured' })
  }

  const header = req.header('x-api-key')
  const authHeader = req.header('authorization') || ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const provided = header || bearer

  if (!provided || provided !== config.apiKey) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}
