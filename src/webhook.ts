import { config } from './config'
import { logger } from './logger'

/**
 * Payload relayed to ClinicOS Web on every inbound WhatsApp message.
 * Field names follow what the Web inbound route currently reads
 * (`clinicId`, `from`, `message`, `mediaBase64`, `mimeType`) plus the
 * spec's `clinic_id` spelling for forward compatibility.
 */
export type InboundWebhookPayload = {
  clinicId: string
  clinic_id: string
  from: string
  message: string
  mediaBase64?: string
  mimeType?: string
}

export async function sendInboundWebhook(payload: InboundWebhookPayload): Promise<void> {
  if (!config.clinicosWebUrl) {
    logger.warn({ clinicId: payload.clinicId }, 'CLINICOS_WEB_URL not set — skipping inbound webhook')
    return
  }

  try {
    const res = await fetch(`${config.clinicosWebUrl}/api/whatsapp/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': config.webhookSecret,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      logger.error(
        { clinicId: payload.clinicId, status: res.status },
        'inbound webhook rejected by ClinicOS Web'
      )
    }
  } catch (err) {
    logger.error(
      { clinicId: payload.clinicId, err: (err as Error).message },
      'inbound webhook delivery failed'
    )
  }
}
