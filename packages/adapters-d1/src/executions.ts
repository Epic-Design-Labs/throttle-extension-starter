import type { JobClaimResult, JobExecutionStore } from '@starter/core';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

const LEASE_MS = 5 * 60 * 1000;
export class D1JobExecutionStore implements JobExecutionStore {
  constructor(private readonly db: D1Database) {}
  async claim(input: {
    jobId: string;
    attempt: number;
    now: Date;
  }): Promise<JobClaimResult> {
    const now = input.now.toISOString();
    const lease = new Date(input.now.valueOf() + LEASE_MS).toISOString();
    const row = await this.db
      .prepare(
        "UPDATE jobs SET status='processing', attempt=?, updated_at=?, lease_expires_at=? WHERE job_id=? AND (status IN ('pending','retry') OR (status='processing' AND lease_expires_at <= ?)) RETURNING job_id",
      )
      .bind(input.attempt, now, lease, requireText(input.jobId, 'jobId'), now)
      .first();
    if (row !== null) return 'claimed';
    const existing = await this.db
      .prepare('SELECT status FROM jobs WHERE job_id=?')
      .bind(input.jobId)
      .first<{ status: string }>();
    return existing?.status === 'processing' || existing?.status === 'completed'
      ? 'duplicate'
      : 'unavailable';
  }
  async finish(input: {
    jobId: string;
    attempt: number;
    status: 'completed' | 'retry' | 'failed';
    now: Date;
  }): Promise<void> {
    const result = await this.db
      .prepare(
        "UPDATE jobs SET status=?, updated_at=?, lease_expires_at=NULL WHERE job_id=? AND status='processing' AND attempt=?",
      )
      .bind(
        input.status,
        input.now.toISOString(),
        requireText(input.jobId, 'jobId'),
        input.attempt,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new Error('Claimed job execution not found');
  }
}
