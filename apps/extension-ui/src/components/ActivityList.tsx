import type { Activity } from '@starter/contracts';

const labels = {
  success: 'Success',
  retryable_failure: 'Will retry',
  terminal_failure: 'Needs attention',
  skipped: 'Skipped',
} as const;

export function ActivityList({ activities }: { activities: Activity[] }) {
  return (
    <section className="panel" aria-labelledby="activity-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Operations</p>
          <h2 id="activity-heading">Recent activity</h2>
        </div>
        <span className="count">{activities.length}</span>
      </div>
      {activities.length === 0 ? (
        <p className="empty">No connector activity yet.</p>
      ) : (
        <ol className="activity-list" aria-label="Recent activity">
          {activities.map((activity) => (
            <li
              key={activity.activityId}
              className={`activity ${activity.result}`}
            >
              <div className="activity-title">
                <strong>{labels[activity.result]}</strong>
                <time dateTime={activity.createdAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(activity.createdAt))}
                </time>
              </div>
              {activity.message ? <p>{activity.message}</p> : null}
              {activity.result === 'retryable_failure' ? (
                <p className="guidance">
                  The connector will retry automatically.
                </p>
              ) : null}
              {activity.result === 'terminal_failure' ? (
                <p className="guidance">
                  Review the connector credentials and configuration.
                </p>
              ) : null}
              <div className="activity-meta">
                <span>Attempt {activity.attempt}</span>
                {activity.code ? <code>{activity.code}</code> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
