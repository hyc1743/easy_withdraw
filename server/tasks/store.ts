import { getDb } from "../db.js";
import type {
  TaskJob,
  TaskJobRow,
  TaskJobType,
  TaskLogRecord,
  TaskPayload,
  TaskProgress,
} from "./types.js";

const db = getDb();

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeTaskPayload(row: TaskJobRow): TaskPayload {
  return parseJson<TaskPayload>(
    row.payload_json && row.payload_json !== "{}" ? row.payload_json : row.request_json,
    {} as TaskPayload,
  );
}

function normalizeTaskProgress(row: TaskJobRow): TaskProgress {
  return parseJson<TaskProgress>(row.progress_json, {});
}

export function normalizeTaskJobRow(row: TaskJobRow): TaskJob {
  return {
    id: row.id,
    job_type: row.job_type ?? "withdraw",
    state: row.state,
    interval_sec: row.interval_sec,
    total_count: row.total_count,
    done_count: row.done_count,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payload: normalizeTaskPayload(row),
    progress: normalizeTaskProgress(row),
    logs: loadTaskLogs(row.id),
  };
}

export function loadTaskLogs(jobId: string, limit: number = 200): TaskLogRecord[] {
  const rows = db
    .prepare(
      `SELECT timestamp, ok, message
      FROM schedule_logs
      WHERE job_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    )
    .all(jobId, limit) as Array<{ timestamp: string; ok: number; message: string }>;
  return rows.map((row) => ({
    timestamp: row.timestamp,
    ok: row.ok === 1,
    message: row.message,
  }));
}

export function appendTaskLog(jobId: string, ok: boolean, message: string): void {
  db.prepare(
    "INSERT INTO schedule_logs(job_id, timestamp, ok, message) VALUES (?, ?, ?, ?)",
  ).run(jobId, new Date().toISOString(), ok ? 1 : 0, message);
}

export function deleteTaskJob(jobId: string): void {
  const tx = db.transaction((id: string) => {
    db.prepare("DELETE FROM schedule_logs WHERE job_id = ?").run(id);
    db.prepare("DELETE FROM schedule_jobs WHERE id = ?").run(id);
  });
  tx(jobId);
}

export function persistTaskJob(job: TaskJob): void {
  db.prepare(
    `INSERT INTO schedule_jobs(
      id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      job_type = excluded.job_type,
      state = excluded.state,
      interval_sec = excluded.interval_sec,
      total_count = excluded.total_count,
      done_count = excluded.done_count,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json,
      progress_json = excluded.progress_json,
      request_json = excluded.request_json`,
  ).run(
    // `request_json` is kept for backward compatibility with existing user DBs.
    // Some older installations still have a NOT NULL constraint on this column,
    // so every task type must write a JSON string here.
    job.id,
    job.job_type,
    job.state,
    job.interval_sec,
    job.total_count,
    job.done_count,
    job.next_run_at,
    job.created_at,
    job.updated_at,
    JSON.stringify(job.payload),
    JSON.stringify(job.progress),
    JSON.stringify(job.payload),
  );
}

function loadTaskJobByQuery(
  query: string,
  params: unknown[] = [],
): TaskJob | null {
  const row = db.prepare(query).get(...params) as TaskJobRow | undefined;
  return row ? normalizeTaskJobRow(row) : null;
}

export function loadTaskJob(jobId: string): TaskJob | null {
  return loadTaskJobByQuery(
    `SELECT
      id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
    FROM schedule_jobs
    WHERE id = ?`,
    [jobId],
  );
}

export function loadLatestRunningTask(
  jobType?: TaskJobType,
): TaskJob | null {
  if (jobType) {
    return loadTaskJobByQuery(
      `SELECT
        id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
      FROM schedule_jobs
      WHERE state = 'running' AND job_type = ?
      ORDER BY created_at DESC
      LIMIT 1`,
      [jobType],
    );
  }

  return loadTaskJobByQuery(
    `SELECT
      id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
    FROM schedule_jobs
    WHERE state = 'running'
    ORDER BY created_at DESC
    LIMIT 1`,
  );
}

export function loadLatestTask(
  jobType?: TaskJobType,
): TaskJob | null {
  if (jobType) {
    return loadTaskJobByQuery(
      `SELECT
        id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
      FROM schedule_jobs
      WHERE job_type = ?
      ORDER BY created_at DESC
      LIMIT 1`,
      [jobType],
    );
  }

  return loadTaskJobByQuery(
    `SELECT
      id, job_type, state, interval_sec, total_count, done_count, next_run_at, created_at, updated_at, payload_json, progress_json, request_json
    FROM schedule_jobs
    ORDER BY created_at DESC
    LIMIT 1`,
  );
}
