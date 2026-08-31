/** Durable broker↔runner message disposition ledger. */

import { MessageSchema } from 'csuite-sdk/schemas';
import type { Message, MessageDispositionFrame } from 'csuite-sdk/types';
import type { SqlDriver, SqlStatement } from './sql-driver.js';

export const MESSAGE_DELIVERY_TTL_MS = 24 * 60 * 60_000;

export interface PendingMessageDelivery {
  message: Message;
  recipient: string;
  attempts: number;
  firstSentAt: number | null;
  lastSentAt: number | null;
  expiresAt: number;
}

export interface ExpiredMessageDelivery extends PendingMessageDelivery {
  sender: string | null;
}

export interface MessageDeliveryLedger {
  track(message: Message, recipient: string, now: number): void;
  noteSent(messageId: string, recipient: string, now: number): void;
  settle(recipient: string, frame: MessageDispositionFrame): PendingMessageDelivery | null;
  pending(recipient: string, now: number): PendingMessageDelivery[];
  expire(now: number): ExpiredMessageDelivery[];
  markUnreported(messageId: string, recipient: string, now: number): void;
}

interface MemoryRow extends PendingMessageDelivery {
  state: 'pending' | 'acted' | 'handled' | 'refused' | 'unreported';
  dispositionAt: number | null;
  reason: MessageDispositionFrame['reason'] | null;
}

export class InMemoryMessageDeliveryLedger implements MessageDeliveryLedger {
  private readonly rows = new Map<string, MemoryRow>();

  private key(messageId: string, recipient: string): string {
    return `${messageId}\u0000${recipient}`;
  }

  track(message: Message, recipient: string, now: number): void {
    const key = this.key(message.id, recipient);
    if (this.rows.has(key)) return;
    this.rows.set(key, {
      message,
      recipient,
      state: 'pending',
      attempts: 0,
      firstSentAt: null,
      lastSentAt: null,
      dispositionAt: null,
      reason: null,
      expiresAt: now + MESSAGE_DELIVERY_TTL_MS,
    });
  }

  noteSent(messageId: string, recipient: string, now: number): void {
    const row = this.rows.get(this.key(messageId, recipient));
    if (!row || row.state !== 'pending') return;
    row.attempts += 1;
    row.firstSentAt ??= now;
    row.lastSentAt = now;
  }

  settle(recipient: string, frame: MessageDispositionFrame): PendingMessageDelivery | null {
    const row = this.rows.get(this.key(frame.messageId, recipient));
    if (!row || row.state !== 'pending') return null;
    if (frame.disposition === 'deferred') {
      row.reason = frame.reason ?? null;
      return { ...row };
    }
    row.state = frame.disposition;
    row.dispositionAt = frame.at;
    row.reason = frame.reason ?? null;
    return { ...row };
  }

  pending(recipient: string, now: number): PendingMessageDelivery[] {
    return [...this.rows.values()]
      .filter(
        (row) => row.recipient === recipient && row.state === 'pending' && row.expiresAt > now,
      )
      .sort((a, b) => a.message.ts - b.message.ts);
  }

  expire(now: number): ExpiredMessageDelivery[] {
    const expired: ExpiredMessageDelivery[] = [];
    for (const row of this.rows.values()) {
      if (row.state !== 'pending' || row.expiresAt > now) continue;
      row.state = 'refused';
      row.dispositionAt = now;
      row.reason = { code: 'expired', detail: 'message acknowledgement expired after 24 hours' };
      expired.push({ ...row, sender: row.message.from });
    }
    for (const [key, row] of this.rows) {
      if (row.state !== 'pending' && row.expiresAt <= now) this.rows.delete(key);
    }
    return expired;
  }

  markUnreported(messageId: string, recipient: string, now: number): void {
    const row = this.rows.get(this.key(messageId, recipient));
    if (!row || row.state !== 'pending') return;
    row.state = 'unreported';
    row.dispositionAt = now;
  }
}

interface DeliveryRow {
  message_json: string;
  recipient: string;
  attempts: number;
  first_sent_at: number | null;
  last_sent_at: number | null;
  expires_at: number;
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS message_deliveries (
    message_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    message_json TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    first_sent_at INTEGER,
    last_sent_at INTEGER,
    expires_at INTEGER NOT NULL,
    disposition_at INTEGER,
    reason_json TEXT,
    PRIMARY KEY (message_id, recipient)
  );
  CREATE INDEX IF NOT EXISTS message_deliveries_pending_idx
    ON message_deliveries (recipient, state, expires_at);
  CREATE INDEX IF NOT EXISTS message_deliveries_expiry_idx
    ON message_deliveries (state, expires_at);
`;

export class SqliteMessageDeliveryLedger implements MessageDeliveryLedger {
  private readonly insert: SqlStatement;
  private readonly note: SqlStatement;
  private readonly settleStmt: SqlStatement;
  private readonly deferStmt: SqlStatement;
  private readonly pendingStmt: SqlStatement;
  private readonly expiredStmt: SqlStatement;
  private readonly expireStmt: SqlStatement;
  private readonly purgeTerminalStmt: SqlStatement;
  private readonly unreportedStmt: SqlStatement;

  constructor(db: SqlDriver) {
    db.exec(CREATE_SCHEMA);
    this.insert = db.prepare(
      `INSERT OR IGNORE INTO message_deliveries
       (message_id, recipient, message_json, state, expires_at)
       VALUES (?, ?, ?, 'pending', ?)`,
    );
    this.note = db.prepare(
      `UPDATE message_deliveries SET attempts = attempts + 1,
       first_sent_at = COALESCE(first_sent_at, ?), last_sent_at = ?
       WHERE message_id = ? AND recipient = ? AND state = 'pending'`,
    );
    this.settleStmt = db.prepare(
      `UPDATE message_deliveries SET state = ?, disposition_at = ?, reason_json = ?
       WHERE message_id = ? AND recipient = ? AND state = 'pending'`,
    );
    this.deferStmt = db.prepare(
      `UPDATE message_deliveries SET reason_json = ?
       WHERE message_id = ? AND recipient = ? AND state = 'pending'`,
    );
    this.pendingStmt = db.prepare(
      `SELECT message_json, recipient, attempts, first_sent_at, last_sent_at, expires_at
       FROM message_deliveries
       WHERE recipient = ? AND state = 'pending' AND expires_at > ?
       ORDER BY json_extract(message_json, '$.ts') ASC`,
    );
    this.expiredStmt = db.prepare(
      `SELECT message_json, recipient, attempts, first_sent_at, last_sent_at, expires_at
       FROM message_deliveries WHERE state = 'pending' AND expires_at <= ?`,
    );
    this.expireStmt = db.prepare(
      `UPDATE message_deliveries SET state = 'refused', disposition_at = ?, reason_json = ?
       WHERE state = 'pending' AND expires_at <= ?`,
    );
    this.purgeTerminalStmt = db.prepare(
      `DELETE FROM message_deliveries
       WHERE state IN ('acted', 'handled', 'refused', 'unreported') AND expires_at <= ?`,
    );
    this.unreportedStmt = db.prepare(
      `UPDATE message_deliveries SET state = 'unreported', disposition_at = ?
       WHERE message_id = ? AND recipient = ? AND state = 'pending'`,
    );
  }

  track(message: Message, recipient: string, now: number): void {
    this.insert.run(message.id, recipient, JSON.stringify(message), now + MESSAGE_DELIVERY_TTL_MS);
  }

  noteSent(messageId: string, recipient: string, now: number): void {
    this.note.run(now, now, messageId, recipient);
  }

  settle(recipient: string, frame: MessageDispositionFrame): PendingMessageDelivery | null {
    const row = (
      this.pendingStmt.all(recipient, Number.NEGATIVE_INFINITY) as unknown as DeliveryRow[]
    )
      .map(rowToPending)
      .find((candidate) => candidate.message.id === frame.messageId);
    if (!row) return null;
    const reason = frame.reason ? JSON.stringify(frame.reason) : null;
    const result =
      frame.disposition === 'deferred'
        ? this.deferStmt.run(reason, frame.messageId, recipient)
        : this.settleStmt.run(frame.disposition, frame.at, reason, frame.messageId, recipient);
    return result.changes > 0 ? row : null;
  }

  pending(recipient: string, now: number): PendingMessageDelivery[] {
    return (this.pendingStmt.all(recipient, now) as unknown as DeliveryRow[]).map(rowToPending);
  }

  expire(now: number): ExpiredMessageDelivery[] {
    const rows = (this.expiredStmt.all(now) as unknown as DeliveryRow[]).map(rowToPending);
    if (rows.length === 0) {
      this.purgeTerminalStmt.run(now);
      return [];
    }
    this.expireStmt.run(
      now,
      JSON.stringify({ code: 'expired', detail: 'message acknowledgement expired after 24 hours' }),
      now,
    );
    this.purgeTerminalStmt.run(now);
    return rows.map((row) => ({ ...row, sender: row.message.from }));
  }

  markUnreported(messageId: string, recipient: string, now: number): void {
    this.unreportedStmt.run(now, messageId, recipient);
  }
}

function rowToPending(row: DeliveryRow): PendingMessageDelivery {
  return {
    message: MessageSchema.parse(JSON.parse(row.message_json)),
    recipient: row.recipient,
    attempts: row.attempts,
    firstSentAt: row.first_sent_at,
    lastSentAt: row.last_sent_at,
    expiresAt: row.expires_at,
  };
}
