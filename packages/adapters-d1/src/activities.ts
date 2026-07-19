import { activitySchema, type Activity } from '@starter/contracts';
import type { ActivityStore } from '@starter/core';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

type Row = Record<string, unknown>;
const map = (row: Row): Activity =>
  activitySchema.parse({
    activityId: row.activity_id,
    installationId: row.installation_id,
    ...(row.event_id == null ? {} : { eventId: row.event_id }),
    ...(row.job_id == null ? {} : { jobId: row.job_id }),
    type: row.type,
    status: row.status,
    result: row.result,
    attempt: row.attempt,
    ...(row.message == null ? {} : { message: row.message }),
    ...(row.code == null ? {} : { code: row.code }),
    createdAt: row.created_at,
  });

export class D1ActivityStore implements ActivityStore {
  constructor(private readonly db: D1Database) {}
  async append(value: Activity): Promise<void> {
    const item = activitySchema.parse(value);
    await this.db
      .prepare(
        'INSERT INTO activities (activity_id, installation_id, event_id, job_id, type, status, result, attempt, message, code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(activity_id) DO NOTHING',
      )
      .bind(
        item.activityId,
        item.installationId,
        item.eventId ?? null,
        item.jobId ?? null,
        item.type,
        item.status,
        item.result,
        item.attempt,
        item.message ?? null,
        item.code ?? null,
        item.createdAt,
      )
      .run();
  }
  async list(input: {
    installationId: string;
    limit: number;
  }): Promise<Activity[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error('limit must be an integer from 1 to 100');
    const result = await this.db
      .prepare(
        'SELECT activity_id, installation_id, event_id, job_id, type, status, result, attempt, message, code, created_at FROM activities WHERE installation_id = ? ORDER BY created_at DESC, activity_id DESC LIMIT ?',
      )
      .bind(requireText(input.installationId, 'installationId'), input.limit)
      .all<Row>();
    return result.results.map(map);
  }
}
