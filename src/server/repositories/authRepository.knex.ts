import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { getKnex } from '../knex.ts';

type Executor = Knex | Knex.Transaction;

export interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  phone: string | null;
  global_role: string;
  status: string;
  email_verified: boolean | number;
  pin_hash: string | null;
}

export class KnexAuthRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  private id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  }

  async findUserByEmail(email: string, trx: Executor = this.db): Promise<AuthUserRow | undefined> {
    return trx('users')
      .select('id', 'email', 'password_hash', 'full_name', 'phone', 'global_role', 'status', 'email_verified', 'pin_hash')
      .whereRaw('LOWER(email) = LOWER(?)', [email])
      .first() as Promise<AuthUserRow | undefined>;
  }

  async findUserSecurityStatus(userId: string, trx: Executor = this.db) {
    return trx('users')
      .select('id', 'email', 'full_name', 'phone', 'email_verified', 'pin_hash')
      .where({ id: userId })
      .first();
  }

  async findPrimaryMembershipForUser(userId: string, trx: Executor = this.db) {
    return trx('restaurant_members as rm')
      .join('restaurants as r', 'r.id', 'rm.restaurant_id')
      .select({
        restaurant_id: 'rm.restaurant_id',
        role: 'rm.role',
        custom_permissions_json: 'rm.custom_permissions_json',
        member_status: 'rm.status',
        restaurant_name: 'r.name',
        restaurant_slug: 'r.slug',
        restaurant_status: 'r.status',
        deleted_at: 'r.deleted_at',
      })
      .where('rm.user_id', userId)
      .where('rm.status', 'ACTIVE')
      .whereNull('r.deleted_at')
      .whereNot('r.status', 'DELETED')
      .orderBy('rm.created_at', 'asc')
      .first();
  }

  async findUserVenues(userId: string, trx: Executor = this.db) {
    return trx('restaurant_members as rm')
      .join('restaurants as r', 'r.id', 'rm.restaurant_id')
      .select({
        restaurantId: 'r.id',
        name: 'r.name',
        slug: 'r.slug',
        city: 'r.city',
        status: 'r.status',
        role: 'rm.role',
      })
      .where('rm.user_id', userId)
      .where('rm.status', 'ACTIVE')
      .whereNull('r.deleted_at')
      .whereNot('r.status', 'DELETED')
      .orderBy('rm.created_at', 'asc');
  }

  async findMembershipForVenue(userId: string, restaurantId: string, trx: Executor = this.db) {
    return trx('restaurant_members')
      .select('role', 'custom_permissions_json')
      .where({ user_id: userId, restaurant_id: restaurantId, status: 'ACTIVE' })
      .first();
  }

  async switchSessionRestaurant(sessionId: string, userId: string, restaurantId: string, trx: Executor = this.db): Promise<number> {
    return trx('sessions')
      .where({ id: sessionId, user_id: userId })
      .whereNull('revoked_at')
      .update({ restaurant_id: restaurantId });
  }

  async findMemberForPinLogin(restaurantId: string, userId: string, trx: Executor = this.db) {
    return trx('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .join('restaurants as r', 'r.id', 'rm.restaurant_id')
      .select({
        user_id: 'u.id',
        email: 'u.email',
        full_name: 'u.full_name',
        phone: 'u.phone',
        user_status: 'u.status',
        email_verified: 'u.email_verified',
        pin_hash: 'u.pin_hash',
        restaurant_id: 'rm.restaurant_id',
        role: 'rm.role',
        custom_permissions_json: 'rm.custom_permissions_json',
        member_status: 'rm.status',
        restaurant_name: 'r.name',
        restaurant_slug: 'r.slug',
        restaurant_status: 'r.status',
        deleted_at: 'r.deleted_at',
      })
      .where({ 'rm.restaurant_id': restaurantId, 'rm.user_id': userId })
      .first();
  }

  async createSession(params: {
    sessionId: string; userId: string; restaurantId: string | null;
    expiresAt: string; userAgent: string; now: string;
  }, trx: Executor = this.db): Promise<void> {
    await trx('sessions').insert({
      id: params.sessionId,
      user_id: params.userId,
      restaurant_id: params.restaurantId,
      expires_at: params.expiresAt,
      user_agent: params.userAgent,
      created_at: params.now,
    });
  }

  async updateLastLogin(userId: string, now: string, trx: Executor = this.db): Promise<number> {
    return trx('users').where({ id: userId }).update({ last_login_at: now });
  }

  async revokeSession(sessionId: string, trx: Executor = this.db): Promise<number> {
    return trx('sessions')
      .where({ id: sessionId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date().toISOString() });
  }

  async revokeAllUserSessions(userId: string, trx: Executor = this.db): Promise<number> {
    return trx('sessions')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date().toISOString() });
  }

  async findPlanForRegistration(planCode: string, trx: Executor = this.db) {
    const selected = await trx('plans')
      .select('id', 'trial_days')
      .where({ code: planCode, active: 1 })
      .first();
    if (selected) return selected;
    return trx('plans').select('id', 'trial_days').where({ active: 1 }).orderBy('created_at', 'asc').first();
  }

  async createRestaurantWithOwnerAndStarterData(params: {
    restaurantId: string; restaurantName: string; slug: string; email: string;
    phone: string; city: string; userId: string; ownerName: string;
    passwordHash: string; memberId: string; subId: string; planId: string;
    trialEndsAt: string; sessionId: string; sessionExpiresAt: string;
    userAgent: string; now: string;
  }, trx: Executor): Promise<void> {
    // The users.tenant_id foreign key targets tenants, not restaurants.
    // Keep the tenant root and the application-facing restaurant row aligned.
    await trx('tenants').insert({
      id: params.restaurantId,
      name: params.restaurantName,
      slug: params.slug,
      email: params.email,
      phone: params.phone,
      city: params.city,
      country: "Côte d'Ivoire",
      currency: 'XOF',
      timezone: 'Africa/Abidjan',
      status: 'TRIAL',
      created_at: params.now,
    });

    await trx('restaurants').insert({
      id: params.restaurantId,
      name: params.restaurantName,
      slug: params.slug,
      email: params.email,
      phone: params.phone,
      city: params.city,
      country: "Côte d'Ivoire",
      currency: 'XOF',
      timezone: 'Africa/Abidjan',
      status: 'TRIAL',
      created_at: params.now,
    });

    await trx('users').insert({
      id: params.userId,
      tenant_id: params.restaurantId,
      email: params.email,
      password_hash: params.passwordHash,
      full_name: params.ownerName,
      phone: params.phone,
      role: 'OWNER',
      global_role: 'USER',
      permissions_json: '[]',
      status: 'ACTIVE',
      email_verified: false,
      created_at: params.now,
    });

    await trx('restaurant_members').insert({
      id: params.memberId,
      restaurant_id: params.restaurantId,
      user_id: params.userId,
      role: 'OWNER',
      custom_permissions_json: '[]',
      status: 'ACTIVE',
      created_at: params.now,
    });

    await trx('subscriptions').insert({
      id: params.subId,
      restaurant_id: params.restaurantId,
      plan_id: params.planId,
      billing_cycle: 'MONTHLY',
      status: 'TRIAL',
      trial_ends_at: params.trialEndsAt,
      current_period_start: params.now,
      current_period_end: params.trialEndsAt,
      created_at: params.now,
    });

    const categoryKitchenId = this.id('cat');
    const categoryBarId = this.id('cat');
    await trx('menu_categories').insert([
      { id: categoryKitchenId, restaurant_id: params.restaurantId, name: 'Plats Principaux', station: 'KITCHEN', sort_order: 1, active: 1 },
      { id: categoryBarId, restaurant_id: params.restaurantId, name: 'Boissons & Bar', station: 'BAR', sort_order: 2, active: 1 },
    ]);

    const tables = [];
    const qrCodes = [];
    for (let i = 1; i <= 4; i++) {
      const tableId = this.id('tbl');
      tables.push({
        id: tableId,
        restaurant_id: params.restaurantId,
        zone: 'Salle principale',
        label: `Table 0${i}`,
        capacity: 4,
        status: 'AVAILABLE',
        pos_x: 60 + ((i - 1) % 2) * 180,
        pos_y: 60 + Math.floor((i - 1) / 2) * 160,
        shape: 'ROUND',
      });
      qrCodes.push({
        id: this.id('qr'),
        restaurant_id: params.restaurantId,
        table_id: tableId,
        token: `${params.slug}-t${i}-v1`,
        version: 1,
        status: 'ACTIVE',
        created_at: params.now,
      });
    }
    await trx('dining_tables').insert(tables);
    await trx('qr_codes').insert(qrCodes);

    await this.createSession({
      sessionId: params.sessionId,
      userId: params.userId,
      restaurantId: params.restaurantId,
      expiresAt: params.sessionExpiresAt,
      userAgent: params.userAgent,
      now: params.now,
    }, trx);
  }

  async findUserPasswordHash(userId: string, trx: Executor = this.db) {
    return trx('users').select('password_hash').where({ id: userId }).first();
  }

  async updateUserPasswordHash(userId: string, passwordHash: string, trx: Executor = this.db): Promise<number> {
    return trx('users').where({ id: userId }).update({
      password_hash: passwordHash,
      updated_at: new Date().toISOString(),
      token_version: trx.raw('token_version + 1'),
    });
  }

  async updateUserPinHash(userId: string, pinHash: string | null, trx: Executor = this.db): Promise<number> {
    return trx('users').where({ id: userId }).update({ pin_hash: pinHash, updated_at: new Date().toISOString() });
  }

  async markUserEmailVerified(userId: string, trx: Executor = this.db): Promise<number> {
    const now = new Date().toISOString();
    return trx('users').where({ id: userId }).update({ email_verified: true, email_verified_at: now, updated_at: now });
  }

  async createAuthToken(params: {
    userId: string; email: string; tokenHash: string;
    tokenType: 'PASSWORD_RESET' | 'EMAIL_VERIFY'; expiresAt: string;
  }, trx: Executor = this.db): Promise<string> {
    const id = this.id('atok');
    await trx('auth_tokens').insert({
      id, user_id: params.userId, email: params.email, token_hash: params.tokenHash,
      token_type: params.tokenType, expires_at: params.expiresAt,
      used_at: null, created_at: new Date().toISOString(),
    });
    return id;
  }

  async findValidAuthToken(
    tokenHash: string,
    tokenType: 'PASSWORD_RESET' | 'EMAIL_VERIFY',
    trx: Executor = this.db,
    lock = false,
  ) {
    let query = trx('auth_tokens')
      .select('id', 'user_id', 'email', 'expires_at', 'used_at')
      .where({ token_hash: tokenHash, token_type: tokenType });
    if (lock && trx.client.config.client === 'pg') query = query.forUpdate();
    return query.first();
  }

  async markAuthTokenUsed(id: string, trx: Executor = this.db): Promise<number> {
    return trx('auth_tokens').where({ id }).whereNull('used_at').update({ used_at: new Date().toISOString() });
  }

  async invalidateUnusedAuthTokens(
    userId: string,
    tokenType: 'PASSWORD_RESET' | 'EMAIL_VERIFY',
    trx: Executor = this.db,
  ): Promise<number> {
    return trx('auth_tokens')
      .where({ user_id: userId, token_type: tokenType })
      .whereNull('used_at')
      .update({ used_at: new Date().toISOString() });
  }

  async resolveTransactionalSmtpConfig(userId?: string): Promise<{
    host?: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string;
  } | undefined> {
    if (process.env.SMTP_HOST?.trim()) return undefined;

    const platformRows = await this.db('platform_settings')
      .select('key', 'value')
      .where('key', 'like', 'smtp_%');
    const platform = Object.fromEntries(platformRows.map((row) => [row.key, row.value])) as Record<string, string>;

    if (platform.smtp_host?.trim()) {
      const port = Number(platform.smtp_port || 587);
      return {
        host: platform.smtp_host.trim(),
        port,
        secure: platform.smtp_secure === 'true' || port === 465,
        user: (platform.smtp_user || '').trim(),
        pass: platform.smtp_pass || '',
        from: (platform.smtp_from || '').trim(),
      };
    }

    if (userId) {
      const row = await this.db('restaurant_members as rm')
        .join('stock_alert_settings as sas', 'sas.restaurant_id', 'rm.restaurant_id')
        .select('sas.smtp_host', 'sas.smtp_port', 'sas.smtp_secure', 'sas.smtp_user', 'sas.smtp_pass', 'sas.smtp_from')
        .where('rm.user_id', userId)
        .whereNot('sas.smtp_host', '')
        .orderBy('rm.created_at', 'asc')
        .first();
      if (row?.smtp_host?.trim()) {
        return {
          host: row.smtp_host.trim(),
          port: Number(row.smtp_port || 587),
          secure: Boolean(row.smtp_secure),
          user: String(row.smtp_user || '').trim(),
          pass: String(row.smtp_pass || ''),
          from: String(row.smtp_from || '').trim(),
        };
      }
    }
    return undefined;
  }
}

export const knexAuthRepository = new KnexAuthRepository();
