import { connectorJobSchema, type ConnectorJob } from '@starter/contracts';
import type { D1Database } from './database.js';

export class D1WebhookAcceptanceStore {
  constructor(private readonly db: D1Database) {}
  async accept(
    value: ConnectorJob,
  ): Promise<{ accepted: boolean; enqueueRequired: boolean }> {
    const job = connectorJobSchema.parse(value);
    const reference = JSON.stringify(job.event);
    const results = await this.db.batch([
      this.db
        .prepare(
          'INSERT OR IGNORE INTO deliveries (installation_id,event_id,received_at,event_type) VALUES (?,?,?,?)',
        )
        .bind(job.installationId, job.event.id, job.createdAt, job.event.type),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO jobs (job_id,installation_id,payload_reference,attempt,status,scheduled_at,created_at,updated_at) VALUES (?,?,?,0,'pending',?,?,?)",
        )
        .bind(
          job.jobId,
          job.installationId,
          reference,
          job.createdAt,
          job.createdAt,
          job.createdAt,
        ),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO activities (activity_id,installation_id,event_id,job_id,type,status,result,attempt,message,code,created_at) VALUES (?,?,?,?,'event_received','completed','success',0,NULL,'EVENT_ACCEPTED',?)",
        )
        .bind(
          JSON.stringify(['event_received', job.installationId, job.event.id]),
          job.installationId,
          job.event.id,
          job.jobId,
          job.createdAt,
        ),
    ]);
    const stored = await this.db
      .prepare(
        'SELECT installation_id,payload_reference,queue_published_at FROM jobs WHERE job_id=?',
      )
      .bind(job.jobId)
      .first<{
        installation_id: string;
        payload_reference: string;
        queue_published_at: string | null;
      }>();
    if (
      stored?.installation_id !== job.installationId ||
      stored.payload_reference !== reference
    )
      throw new Error('Duplicate event payload does not match accepted job');
    return {
      accepted: results[0]?.meta.changes === 1,
      enqueueRequired: stored.queue_published_at === null,
    };
  }

  async markEnqueued(jobId: string, publishedAt: Date): Promise<void> {
    const result = await this.db
      .prepare(
        'UPDATE jobs SET queue_published_at=? WHERE job_id=? AND queue_published_at IS NULL',
      )
      .bind(publishedAt.toISOString(), jobId)
      .run();
    if (result.meta.changes !== 1) {
      const existing = await this.db
        .prepare('SELECT queue_published_at FROM jobs WHERE job_id=?')
        .bind(jobId)
        .first<{ queue_published_at: string | null }>();
      if (existing?.queue_published_at == null)
        throw new Error('Accepted job was not found');
    }
  }
}
