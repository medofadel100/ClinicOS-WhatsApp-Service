import { logger } from './logger'

export type SendJob = {
  id: string
  to: string
  text?: string
  mediaUrl?: string
}

export type SendExecutor = (job: SendJob) => Promise<void>

const MIN_DELAY_MS = 1500
const MAX_DELAY_MS = 3000

/**
 * Per-clinic FIFO queues. Each clinic sends one message at a time with a
 * randomized 1.5–3s gap, so no amount of upstream calling can outpace
 * WhatsApp's spam threshold. The protection lives here, at the layer that
 * actually talks to WhatsApp.
 */
export class SendQueueManager {
  private queues = new Map<string, ClinicQueue>()

  enqueue(clinicId: string, job: Omit<SendJob, 'id'>, executor: SendExecutor): string {
    const id = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const fullJob: SendJob = { ...job, id }
    let queue = this.queues.get(clinicId)
    if (!queue) {
      queue = new ClinicQueue(clinicId, executor)
      this.queues.set(clinicId, queue)
    }
    queue.push(fullJob)
    return id
  }
}

class ClinicQueue {
  private jobs: SendJob[] = []
  private processing = false

  constructor(
    private clinicId: string,
    private executor: SendExecutor
  ) {}

  push(job: SendJob) {
    this.jobs.push(job)
    if (!this.processing) {
      void this.process()
    }
  }

  private async process() {
    this.processing = true
    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!
      try {
        await this.executor(job)
      } catch (err) {
        logger.error(
          { clinicId: this.clinicId, to: job.to, err: (err as Error).message },
          'message send failed'
        )
      }
      if (this.jobs.length > 0) {
        await sleep(MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)))
      }
    }
    this.processing = false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
