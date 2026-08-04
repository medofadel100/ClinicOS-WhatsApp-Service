import 'dotenv/config'

export const config = {
  port: Number(process.env.PORT || 3002),
  apiKey: process.env.API_KEY || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  clinicosWebUrl: (process.env.CLINICOS_WEB_URL || '').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || './data',
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
}
