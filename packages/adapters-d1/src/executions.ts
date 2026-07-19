import type {
  JobClaimResult,
  JobExecutionStore,
  JobFinishResult,
} from '@starter/core';
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
        "UPDATE jobs SET status='processing', attempt=?, updated_at=?, lease_expires_at=? WHERE job_id=? AND ((status IN ('pending','retry') AND ?=attempt+1) OR (status='processing' AND lease_expires_at <= ? AND ?=attempt)) RETURNING job_id",
      )
      .bind(
        input.attempt,
        now,
        lease,
        requireText(input.jobId, 'jobId'),
        input.attempt,
        now,
        input.attempt,
      )
      .first();
    if (row !== null) return 'claimed';
    const existing = await this.db
      .prepare('SELECT status, attempt FROM jobs WHERE job_id=?')
      .bind(input.jobId)
      .first<{ status: string; attempt: number }>();
    if (existing !== null && input.attempt <= existing.attempt)
      return 'duplicate';
    return 'unavailable';
  }
  async finish(input: {
    jobId: string;
    attempt: number;
    status: 'completed' | 'retry' | 'failed';
    now: Date;
  }): Promise<JobFinishResult> {
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
    if (result.meta.changes === 1) return 'finished';
    const existing = await this.db
      .prepare('SELECT status FROM jobs WHERE job_id=? AND attempt=?')
      .bind(input.jobId, input.attempt)
      .first<{ status: string }>();
    return existing?.status === 'cancelled' ? 'cancelled' : 'stale';
  }
}
