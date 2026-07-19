import type { DeliveryStore } from '@starter/core';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

export class D1DeliveryStore implements DeliveryStore {
  constructor(private readonly db: D1Database) {}
  async accept(input: {
    installationId: string;
    eventId: string;
    eventType: string;
    acceptedAt: Date;
  }): Promise<{ accepted: boolean }> {
    if (
      !(input.acceptedAt instanceof Date) ||
      Number.isNaN(input.acceptedAt.valueOf())
    )
      throw new Error('acceptedAt must be a valid Date');
    const result = await this.db
      .prepare(
        'INSERT OR IGNORE INTO deliveries (installation_id, event_id, received_at, event_type) VALUES (?, ?, ?, ?)',
      )
      .bind(
        requireText(input.installationId, 'installationId'),
        requireText(input.eventId, 'eventId'),
        input.acceptedAt.toISOString(),
        requireText(input.eventType, 'eventType'),
      )
      .run();
    return { accepted: result.meta.changes === 1 };
  }
}
