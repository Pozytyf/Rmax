import { getDb, generateId } from '../db.ts';
import { BaseRepository } from './BaseRepository.ts';

export class AuthRepository extends BaseRepository {
  constructor() {
    super({ tableName: 'users', tenantColumn: 'tenant_id' });
  }

  findUserByEmail(email: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, email, password_hash, full_name, phone, global_role, status, email_verified, pin_hash
         FROM users WHERE lower(email) = lower(?)`,
      )
      .get(email) as
      | {
          id: string;
          email: string;
          password_hash: string;
          full_name: string;
          phone: string | null;
          global_role: string;
          status: string;
          email_verified: number;
          pin_hash: string | null;
        }
      | undefined;
  }

  findUserSecurityStatus(userId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, email, full_name, phone, email_verified, pin_hash
         FROM users WHERE id = ?`,
      )
      .get(userId) as
      | {
          id: string;
          email: string;
          full_name: string;
          phone: string | null;
          email_verified: number;
          pin_hash: string | null;
        }
      | undefined;
  }

  findPrimaryMembershipForUser(userId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT rm.restaurant_id, rm.role, rm.custom_permissions_json, rm.status as member_status,
                r.name as restaurant_name, r.slug as restaurant_slug, r.status as restaurant_status, r.deleted_at
         FROM restaurant_members rm
         JOIN restaurants r ON r.id = rm.restaurant_id
         WHERE rm.user_id = ? AND rm.status = 'ACTIVE' AND r.deleted_at IS NULL AND r.status != 'DELETED'
         ORDER BY rm.created_at ASC
         LIMIT 1`,
      )
      .get(userId) as Record<string, unknown> | undefined;
  }

  findUserVenues(userId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT r.id as restaurantId, r.name, r.slug, r.city, r.status, rm.role
         FROM restaurant_members rm
         JOIN restaurants r ON r.id = rm.restaurant_id
         WHERE rm.user_id = ? AND rm.status = 'ACTIVE' AND r.deleted_at IS NULL AND r.status != 'DELETED'
         ORDER BY rm.created_at ASC`,
      )
      .all(userId) as Array<{
      restaurantId: string;
      name: string;
      slug: string;
      city: string;
      status: string;
      role: string;
    }>;
  }

  findMembershipForVenue(userId: string, restaurantId: string) {
    return this.db
      .prepare(
        "SELECT role, custom_permissions_json FROM restaurant_members WHERE user_id = ? AND restaurant_id = ? AND status = 'ACTIVE'",
      )
      .get(userId, restaurantId) as
      | { role: string; custom_permissions_json: string }
      | undefined;
  }

  switchSessionRestaurant(sessionId: string, userId: string, restaurantId: string) {
    const db = getDb();
    return db.prepare(
      'UPDATE sessions SET restaurant_id = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ).run(restaurantId, sessionId, userId).changes;
  }

  findMembershipForVenue(userId: string, restaurantId: string) {
    const db = getDb();
    return db.prepare(
      `SELECT role, custom_permissions_json
       FROM restaurant_members
       WHERE user_id = ? AND restaurant_id = ? AND status = 'ACTIVE'
       LIMIT 1`,
    ).get(userId, restaurantId) as
      | { role: string; custom_permissions_json: string | null }
      | undefined;
  }

  findMemberForPinLogin(restaurantId: string, userId: string) {
    const db = getDb();
    return db
      .prepare(
        `SELECT u.id as user_id, u.email, u.full_name, u.phone, u.status as user_status,
                u.email_verified, u.pin_hash,
                rm.restaurant_id, rm.role, rm.custom_permissions_json, rm.status as member_status,
                r.name as restaurant_name, r.slug as restaurant_slug, r.status as restaurant_status, r.deleted_at
         FROM restaurant_members rm
         JOIN users u ON u.id = rm.user_id
         JOIN restaurants r ON r.id = rm.restaurant_id
         WHERE rm.restaurant_id = ? AND rm.user_id = ?`,
      )
      .get(restaurantId, userId) as
      | {
          user_id: string;
          email: string;
          full_name: string;
          phone: string | null;
          user_status: string;
          email_verified: number;
          pin_hash: string | null;
          restaurant_id: string;
          role: string;
          custom_permissions_json: string;
          member_status: string;
          restaurant_name: string;
          restaurant_slug: string;
          restaurant_status: string;
          deleted_at: string | null;
        }
      | undefined;
  }

  createSession(params: {
    sessionId: string;
    userId: string;
    restaurantId: string | null;
    expiresAt: string;
    userAgent: string;
    now: string;
  }) {
    const db = getDb();
    db.prepare(
      `INSERT INTO sessions (id, user_id, restaurant_id, expires_at, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      params.sessionId,
      params.userId,
      params.restaurantId,
      params.expiresAt,
      params.userAgent,
      params.now,
    );
  }

  updateLastLogin(userId: string, now: string) {
    const db = getDb();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(
      now,
      userId,
    );
  }

  revokeSession(sessionId: string) {
    const db = getDb();
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      sessionId,
    );
  }

  revokeAllUserSessions(userId: string) {
    const db = getDb();
    db.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).run(new Date().toISOString(), userId);
  }

  findPlanForRegistration(planCode: string) {
    const db = getDb();
    return (
      (db
        .prepare('SELECT id, trial_days FROM plans WHERE code = ? AND active = 1')
        .get(planCode) as { id: string; trial_days: number } | undefined) ||
      (db
        .prepare('SELECT id, trial_days FROM plans WHERE active = 1 LIMIT 1')
        .get() as { id: string; trial_days: number })
    );
  }

  createRestaurantWithOwnerAndStarterData(params: {
    restaurantId: string;
    restaurantName: string;
    slug: string;
    email: string;
    phone: string;
    city: string;
    userId: string;
    ownerName: string;
    passwordHash: string;
    memberId: string;
    subId: string;
    planId: string;
    trialEndsAt: string;
    sessionId: string;
    sessionExpiresAt: string;
    userAgent: string;
    now: string;
  }) {
    const db = getDb();
    db.prepare(
      `INSERT INTO restaurants (
        id, name, slug, email, phone, city, country, currency, timezone, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'Côte d''Ivoire', 'XOF', 'Africa/Abidjan', 'TRIAL', ?)`,
    ).run(
      params.restaurantId,
      params.restaurantName,
      params.slug,
      params.email,
      params.phone,
      params.city,
      params.now,
    );

    db.prepare(
      `INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role, global_role, permissions_json, status, email_verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OWNER', 'USER', '[]', 'ACTIVE', 0, ?)`,
    ).run(
      params.userId,
      params.restaurantId,
      params.email,
      params.passwordHash,
      params.ownerName,
      params.phone,
      params.now,
    );

    db.prepare(
      `INSERT INTO restaurant_members (id, restaurant_id, user_id, role, custom_permissions_json, status, created_at)
       VALUES (?, ?, ?, 'OWNER', '[]', 'ACTIVE', ?)`,
    ).run(params.memberId, params.restaurantId, params.userId, params.now);

    db.prepare(
      `INSERT INTO subscriptions (id, restaurant_id, plan_id, billing_cycle, status, trial_ends_at, current_period_start, current_period_end, created_at)
       VALUES (?, ?, ?, 'MONTHLY', 'TRIAL', ?, ?, ?, ?)`,
    ).run(
      params.subId,
      params.restaurantId,
      params.planId,
      params.trialEndsAt,
      params.now,
      params.trialEndsAt,
      params.now,
    );

    const catK = generateId('cat');
    const catB = generateId('cat');
    db.prepare(
      `INSERT INTO menu_categories (id, restaurant_id, name, station, sort_order, active)
       VALUES (?, ?, 'Plats Principaux', 'KITCHEN', 1, 1)`,
    ).run(catK, params.restaurantId);
    db.prepare(
      `INSERT INTO menu_categories (id, restaurant_id, name, station, sort_order, active)
       VALUES (?, ?, 'Boissons & Bar', 'BAR', 2, 1)`,
    ).run(catB, params.restaurantId);

    for (let i = 1; i <= 4; i++) {
      const tblId = generateId('tbl');
      const posX = 60 + ((i - 1) % 2) * 180;
      const posY = 60 + Math.floor((i - 1) / 2) * 160;
      db.prepare(
        `INSERT INTO dining_tables (id, restaurant_id, zone, label, capacity, status, pos_x, pos_y, shape)
         VALUES (?, ?, 'Salle principale', ?, 4, 'AVAILABLE', ?, ?, 'ROUND')`,
      ).run(tblId, params.restaurantId, `Table 0${i}`, posX, posY);
      db.prepare(
        `INSERT INTO qr_codes (id, restaurant_id, table_id, token, version, status, created_at)
         VALUES (?, ?, ?, ?, 1, 'ACTIVE', ?)`,
      ).run(
        generateId('qr'),
        params.restaurantId,
        tblId,
        `${params.slug}-t${i}-v1`,
        params.now,
      );
    }

    db.prepare(
      `INSERT INTO sessions (id, user_id, restaurant_id, expires_at, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      params.sessionId,
      params.userId,
      params.restaurantId,
      params.sessionExpiresAt,
      params.userAgent,
      params.now,
    );
  }

  findUserPasswordHash(userId: string) {
    const db = getDb();
    return db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(userId) as { password_hash: string } | undefined;
  }

  updateUserPasswordHash(userId: string, passwordHash: string) {
    const db = getDb();
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      passwordHash,
      new Date().toISOString(),
      userId,
    );
  }

  updateUserPinHash(userId: string, pinHash: string | null) {
    const db = getDb();
    db.prepare('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?').run(
      pinHash,
      new Date().toISOString(),
      userId,
    );
  }

  markUserEmailVerified(userId: string) {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE users SET email_verified = 1, email_verified_at = ?, updated_at = ? WHERE id = ?',
    ).run(now, now, userId);
  }

  createAuthToken(params: {
    userId: string;
    email: string;
    tokenHash: string;
    tokenType: 'PASSWORD_RESET' | 'EMAIL_VERIFY';
    expiresAt: string;
  }) {
    const db = getDb();
    const id = generateId('atok');
    db.prepare(
      `INSERT INTO auth_tokens (id, user_id, email, token_hash, token_type, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      params.userId,
      params.email,
      params.tokenHash,
      params.tokenType,
      params.expiresAt,
      new Date().toISOString(),
    );
    return id;
  }

  findValidAuthToken(
    tokenHash: string,
    tokenType: 'PASSWORD_RESET' | 'EMAIL_VERIFY',
  ) {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, user_id, email, expires_at, used_at
         FROM auth_tokens
         WHERE token_hash = ? AND token_type = ?`,
      )
      .get(tokenHash, tokenType) as
      | {
          id: string;
          user_id: string;
          email: string;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;
  }

  markAuthTokenUsed(id: string) {
    const db = getDb();
    return db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(
      new Date().toISOString(),
      id,
    ).changes;
  }

  invalidateUnusedAuthTokens(
    userId: string,
    tokenType: 'PASSWORD_RESET' | 'EMAIL_VERIFY',
  ) {
    const db = getDb();
    db.prepare(
      `UPDATE auth_tokens
       SET used_at = ?
       WHERE user_id = ? AND token_type = ? AND used_at IS NULL`,
    ).run(new Date().toISOString(), userId, tokenType);
  }

  resolveTransactionalSmtpConfig(userId?: string): {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    pass?: string;
    from?: string;
  } | undefined {
    if (process.env.SMTP_HOST?.trim()) {
      return undefined;
    }

    const db = getDb();
    const platRows = db
      .prepare(
        "SELECT key, value FROM platform_settings WHERE key LIKE 'smtp_%'",
      )
      .all() as Array<{ key: string; value: string }>;
    const platMap: Record<string, string> = {};
    for (const r of platRows) platMap[r.key] = r.value;

    if (platMap.smtp_host?.trim()) {
      const port = Number(platMap.smtp_port || 587);
      return {
        host: platMap.smtp_host.trim(),
        port,
        secure: platMap.smtp_secure === 'true' || port === 465,
        user: (platMap.smtp_user || '').trim(),
        pass: platMap.smtp_pass || '',
        from: (platMap.smtp_from || '').trim(),
      };
    }

    if (userId) {
      const restSmtp = db
        .prepare(
          `SELECT sas.smtp_host, sas.smtp_port, sas.smtp_secure, sas.smtp_user, sas.smtp_pass, sas.smtp_from
           FROM restaurant_members rm
           JOIN stock_alert_settings sas ON sas.restaurant_id = rm.restaurant_id
           WHERE rm.user_id = ? AND sas.smtp_host != ''
           ORDER BY rm.created_at ASC
           LIMIT 1`,
        )
        .get(userId) as
        | {
            smtp_host: string;
            smtp_port: number;
            smtp_secure: number;
            smtp_user: string;
            smtp_pass: string;
            smtp_from: string;
          }
        | undefined;

      if (restSmtp && restSmtp.smtp_host.trim()) {
        return {
          host: restSmtp.smtp_host.trim(),
          port: Number(restSmtp.smtp_port || 587),
          secure: Boolean(restSmtp.smtp_secure),
          user: restSmtp.smtp_user.trim(),
          pass: restSmtp.smtp_pass,
          from: restSmtp.smtp_from.trim(),
        };
      }
    }

    return undefined;
  }
}

export const authRepository = new AuthRepository();
