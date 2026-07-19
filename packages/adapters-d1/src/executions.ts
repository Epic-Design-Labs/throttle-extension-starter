import type {
  JobClaimResult,
  JobExecutionStore,
  JobFinishResult,
} from '@starter/core';
import { activitySchema, type Activity } from '@starter/contracts';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

const LEASE_MS = 5 * 60 * 1000;
export class D1JobExecutionStore implements JobExecutionStore {
  constructor(private readonly db: D1Database) {}
  async claim(input: {
    jobId: string;
    now: Date;
    /** @deprecated Queue delivery bodies are not authoritative. */
    attempt?: number;
  }): Promise<JobClaimResult> {
    const now = input.now.toISOString();
    const lease = new Date(input.now.valueOf() + LEASE_MS).toISOString();
    const row = await this.db
      .prepare(
        "UPDATE jobs SET status='processing', attempt=CASE WHEN status IN ('pending','retry') THEN attempt+1 ELSE attempt END, updated_at=?, lease_expires_at=?, lease_token=lower(hex(randomblob(16))) WHERE job_id=? AND (status IN ('pending','retry') OR (status='processing' AND lease_expires_at <= ?)) RETURNING lease_token, attempt",
      )
      .bind(now, lease, requireText(input.jobId, 'jobId'), now)
      .first<{ lease_token: string; attempt: number }>();
    if (row !== null)
      return {
        status: 'claimed',
        token: row.lease_token,
        attempt: row.attempt,
      };
    const existing = await this.db
      .prepare(
        'SELECT status, attempt, lease_expires_at FROM jobs WHERE job_id=?',
      )
      .bind(input.jobId)
      .first<{
        status: string;
        attempt: number;
        lease_expires_at: string | null;
      }>();
    if (
      existing?.status === 'processing' &&
      existing.lease_expires_at !== null
    ) {
      const remaining = Math.ceil(
        (Date.parse(existing.lease_expires_at) - input.now.valueOf()) / 1000,
      );
      if (remaining > 0)
        return { status: 'busy', retryAfterSeconds: Math.min(remaining, 300) };
    }
    if (
      existing !== null &&
      ['completed', 'failed', 'cancelled'].includes(existing.status)
    )
      return { status: 'duplicate' };
    return { status: 'unavailable' };
  }
  async finish(input: {
    jobId: string;
    attempt: number;
    token: string;
    status: 'completed' | 'retry' | 'failed';
    activity: Activity;
    now: Date;
  }): Promise<JobFinishResult> {
    const activity = activitySchema.parse(input.activity);
    if (activity.jobId !== input.jobId || activity.attempt !== input.attempt)
      throw new Error('Activity does not match claimed execution');
    const results = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO activities (activity_id,installation_id,event_id,job_id,type,status,result,attempt,message,code,created_at) SELECT ?,installation_id,?,?,?,?,?,?,?,?,? FROM jobs WHERE job_id=? AND status='processing' AND attempt=? AND lease_token=? ON CONFLICT(activity_id) DO UPDATE SET installation_id=excluded.installation_id,event_id=excluded.event_id,job_id=excluded.job_id,type=excluded.type,status=excluded.status,result=excluded.result,attempt=excluded.attempt,message=excluded.message,code=excluded.code,created_at=excluded.created_at",
        )
        .bind(
          activity.activityId,
          activity.eventId ?? null,
          activity.jobId ?? null,
          activity.type,
          activity.status,
          activity.result,
          activity.attempt,
          activity.message ?? null,
          activity.code ?? null,
          activity.createdAt,
          input.jobId,
          input.attempt,
          input.token,
        ),
      this.db
        .prepare(
          "UPDATE jobs SET status=?, updated_at=?, lease_expires_at=NULL, lease_token=NULL WHERE job_id=? AND status='processing' AND attempt=? AND lease_token=?",
        )
        .bind(
          input.status,
          input.now.toISOString(),
          requireText(input.jobId, 'jobId'),
          input.attempt,
          input.token,
        ),
    ]);
    if (results[1]?.meta.changes === 1) return 'finished';
    const existing = await this.db
      .prepare('SELECT status FROM jobs WHERE job_id=? AND attempt=?')
      .bind(input.jobId, input.attempt)
      .first<{ status: string }>();
    return existing?.status === 'cancelled' ? 'cancelled' : 'stale';
  }
}
