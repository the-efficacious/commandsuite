/** Durable broker↔runner message disposition ledger. */

import { MessageSchema } from 'csuite-sdk/schemas';
import type { Message, MessageDispositionFrame } from 'csuite-sdk/types';
import type { SqlDriver, SqlRunResult, SqlStatement } from './sql-driver.js';

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
  settle(
    recipient: string,
    frame: MessageDispositionFrame,
    owner: string,
    requireAcceptance: boolean,
  ): PendingMessageDelivery | null;
  releaseOwner(recipient: string, owner: string): number;
  pending(recipient: string, now: number): PendingMessageDelivery[];
  expire(now: number): ExpiredMessageDelivery[];
  markUnreported(messageId: string, recipient: string, now: number): void;
}

interface MemoryRow extends PendingMessageDelivery {
  state: 'pending' | 'accepted' | 'acted' | 'handled' | 'refused' | 'unreported';
  acceptedOwner: string | null;
  releasedOwners: Set<string>;
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
      acceptedOwner: null,
      releasedOwners: new Set(),
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
    if (row?.state !== 'pending') return;
    row.attempts += 1;
    row.firstSentAt ??= now;
    row.lastSentAt = now;
  }

  settle(
    recipient: string,
    frame: MessageDispositionFrame,
    owner: string,
    requireAcceptance: boolean,
  ): PendingMessageDelivery | null {
    const row = this.rows.get(this.key(frame.messageId, recipient));
    if (!row) return null;
    if (frame.disposition === 'accepted') {
      if (row.state !== 'pending') return null;
      row.state = 'accepted';
      row.acceptedOwner = owner;
      row.reason = null;
      return { ...row };
    }
    if (frame.disposition === 'deferred') {
      if (row.state === 'accepted' && row.acceptedOwner !== owner) return null;
      if (row.state !== 'pending' && row.state !== 'accepted') return null;
      if (row.state === 'accepted') row.releasedOwners.add(owner);
      row.state = 'pending';
      row.acceptedOwner = null;
      row.reason = frame.reason ?? null;
      return { ...row };
    }
    if (row.state === 'accepted') {
      if (row.acceptedOwner !== owner) return null;
    } else if (row.state !== 'pending' || requireAcceptance || row.releasedOwners.has(owner)) {
      return null;
    }
    row.state = frame.disposition;
    row.acceptedOwner = null;
    row.dispositionAt = frame.at;
    row.reason = frame.reason ?? null;
    return { ...row };
  }

  releaseOwner(recipient: string, owner: string): number {
    let released = 0;
    for (const row of this.rows.values()) {
      if (row.recipient !== recipient || row.state !== 'accepted' || row.acceptedOwner !== owner) {
        continue;
      }
      row.state = 'pending';
      row.acceptedOwner = null;
      row.releasedOwners.add(owner);
      released += 1;
    }
    return released;
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
      if ((row.state !== 'pending' && row.state !== 'accepted') || row.expiresAt > now) continue;
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
    if (row?.state !== 'pending') return;
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
  state?: string;
  accepted_owner?: string | null;
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
    accepted_owner TEXT,
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
  private readonly acceptStmt: SqlStatement;
  private readonly terminalAcceptedStmt: SqlStatement;
  private readonly releaseOwnerStmt: SqlStatement;
  private readonly acceptedByOwner: SqlStatement;
  private readonly byIdStmt: SqlStatement;
  private readonly deferAcceptedStmt: SqlStatement;
  private readonly releasedOwner = new Map<string, Set<string>>();

  constructor(db: SqlDriver) {
    db.exec(CREATE_SCHEMA);
    try {
      db.exec('ALTER TABLE message_deliveries ADD COLUMN accepted_owner TEXT');
    } catch {
      // Existing current-schema databases already have the additive column.
    }
    // Accepted leases are owned by live sockets. A broker restart has no
    // surviving owner, so recovery must not depend on the dead process.
    db.exec(`UPDATE message_deliveries SET state = 'pending', accepted_owner = NULL
             WHERE state = 'accepted'`);
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
    this.acceptStmt = db.prepare(
      `UPDATE message_deliveries SET state = 'accepted', accepted_owner = ?, reason_json = NULL
       WHERE message_id = ? AND recipient = ? AND state = 'pending'`,
    );
    this.terminalAcceptedStmt = db.prepare(
      `UPDATE message_deliveries SET state = ?, disposition_at = ?, reason_json = ?, accepted_owner = NULL
       WHERE message_id = ? AND recipient = ? AND state = 'accepted' AND accepted_owner = ?`,
    );
    this.releaseOwnerStmt = db.prepare(
      `UPDATE message_deliveries SET state = 'pending', accepted_owner = NULL
       WHERE recipient = ? AND state = 'accepted' AND accepted_owner = ?`,
    );
    this.acceptedByOwner = db.prepare(
      `SELECT message_json, recipient, attempts, first_sent_at, last_sent_at, expires_at,
              state, accepted_owner
       FROM message_deliveries
       WHERE recipient = ? AND state = 'accepted' AND accepted_owner = ?`,
    );
    this.byIdStmt = db.prepare(
      `SELECT message_json, recipient, attempts, first_sent_at, last_sent_at, expires_at,
              state, accepted_owner
       FROM message_deliveries WHERE recipient = ? AND message_id = ?`,
    );
    this.deferStmt = db.prepare(
      `UPDATE message_deliveries SET reason_json = ?
       WHERE message_id = ? AND recipient = ? AND state = 'pending'`,
    );
    this.deferAcceptedStmt = db.prepare(
      `UPDATE message_deliveries SET state = 'pending', accepted_owner = NULL, reason_json = ?
       WHERE message_id = ? AND recipient = ? AND state = 'accepted' AND accepted_owner = ?`,
    );
    this.pendingStmt = db.prepare(
      `SELECT message_json, recipient, attempts, first_sent_at, last_sent_at, expires_at
       FROM message_deliveries
       WHERE recipient = ? AND state = 'pending' AND expires_at > ?
       ORDER BY json_extract(message_json, '$.ts') ASC`,
    );
    this.expiredStmt = db.prepare(
      `SELECT message_json, recipient, attempts, first_sent_at, last_sent_at, expires_at
       FROM message_deliveries WHERE state IN ('pending', 'accepted') AND expires_at <= ?`,
    );
    this.expireStmt = db.prepare(
      `UPDATE message_deliveries SET state = 'refused', disposition_at = ?, reason_json = ?
       WHERE state IN ('pending', 'accepted') AND expires_at <= ?`,
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

  settle(
    recipient: string,
    frame: MessageDispositionFrame,
    owner: string,
    requireAcceptance: boolean,
  ): PendingMessageDelivery | null {
    const selected = this.pendingById(recipient, frame.messageId);
    if (!selected) return null;
    const row = rowToPending(selected);
    const reason = frame.reason ? JSON.stringify(frame.reason) : null;
    let result: SqlRunResult;
    if (frame.disposition === 'accepted') {
      result = this.acceptStmt.run(owner, frame.messageId, recipient);
    } else if (frame.disposition === 'deferred') {
      if (selected.state === 'accepted' && selected.accepted_owner !== owner) return null;
      result =
        selected.state === 'accepted'
          ? this.deferAcceptedStmt.run(reason, frame.messageId, recipient, owner)
          : this.deferStmt.run(reason, frame.messageId, recipient);
      if (selected.state === 'accepted') {
        this.noteReleased(recipient, frame.messageId, owner);
      }
    } else if (selected.state === 'accepted') {
      result = this.terminalAcceptedStmt.run(
        frame.disposition,
        frame.at,
        reason,
        frame.messageId,
        recipient,
        owner,
      );
    } else {
      if (requireAcceptance || this.wasReleased(recipient, frame.messageId, owner)) return null;
      result = this.settleStmt.run(frame.disposition, frame.at, reason, frame.messageId, recipient);
    }
    return result.changes > 0 ? row : null;
  }

  releaseOwner(recipient: string, owner: string): number {
    const rows = this.acceptedByOwner.all(recipient, owner) as unknown as DeliveryRow[];
    for (const row of rows) {
      const pending = rowToPending(row);
      this.noteReleased(recipient, pending.message.id, owner);
    }
    return Number(this.releaseOwnerStmt.run(recipient, owner).changes);
  }

  private pendingById(recipient: string, messageId: string): DeliveryRow | null {
    return (this.byIdStmt.get(recipient, messageId) as unknown as DeliveryRow | undefined) ?? null;
  }

  private releaseKey(recipient: string, messageId: string): string {
    return `${recipient}\u0000${messageId}`;
  }

  private noteReleased(recipient: string, messageId: string, owner: string): void {
    const key = this.releaseKey(recipient, messageId);
    const owners = this.releasedOwner.get(key) ?? new Set<string>();
    owners.add(owner);
    this.releasedOwner.set(key, owners);
  }

  private wasReleased(recipient: string, messageId: string, owner: string): boolean {
    return this.releasedOwner.get(this.releaseKey(recipient, messageId))?.has(owner) ?? false;
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
