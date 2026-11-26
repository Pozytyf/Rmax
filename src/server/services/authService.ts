import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb, generateId } from '../db.ts';
import { type AuthContext, recordAuditWithKnex, resolveAuthContextWithKnex, signSessionToken } from '../auth.ts';
import { getKnex } from '../knex.ts';
import { resolveEffectivePermissions } from '../rbac.ts';
import { knexAuthRepository, type KnexAuthRepository } from '../repositories/authRepository.knex.ts';
import { authRepository as sqliteAuthRepository } from '../repositories/authRepository.ts';
import type { Knex } from 'knex';
import {
  isEnvSmtpConfigured,
  isSmtpAvailable,
  sendAuthTransactionalEmail,
} from './mailer.ts';
import { AppError } from './errors.ts';
import {
  assertWithinRateLimit,
  clearRateLimit,
  recordRateLimitHit,
} from '../rateLimit.ts';
import type { Role } from '../../types/index.ts';

export function hashAuthToken(raw: string): string {
  return crypto.createHash('sha256').update(raw.trim()).digest('hex');
}

export function generateSecureTokenCode(): string {
  return crypto.randomBytes(24).toString('hex');
}

function isLegacyTestRuntime(): boolean {
  const client = (process.env.DATABASE_CLIENT || 'sqlite').toLowerCase();
  return process.env.NODE_ENV === 'test' && !['pg', 'postgres', 'postgresql'].includes(client);
}

// Existing route tests deliberately share a synchronous SQLite fixture across
// repositories. Production and PostgreSQL integration runs always use Knex.
const authRepository: KnexAuthRepository = (
  isLegacyTestRuntime() ? sqliteAuthRepository : knexAuthRepository
) as unknown as KnexAuthRepository;

async function runAuthTransaction<T>(
  callback: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if (isLegacyTestRuntime()) {
    // Legacy SQLite route tests exercise the same business repository fixture.
    // Real transactional guarantees are covered against PostgreSQL in CI.
    return callback(undefined as unknown as Knex.Transaction);
  }
  return getKnex().transaction(callback);
}

export class AuthService {

  async login(body: Record<string, unknown>, userAgent: string) {
    const { email, password } = body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new AppError(400, 'Email et mot de passe requis.');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const loginRateKey = `login:${normalizedEmail}`;
    assertWithinRateLimit(
      loginRateKey,
      15,
      15 * 60_000,
      'Trop de tentatives de connexion. Réessayez dans quelques minutes.',
    );

    const user = await authRepository.findUserByEmail(email.trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      recordRateLimitHit(loginRateKey, 15 * 60_000);
      throw new AppError(401, 'Identifiants incorrects.');
    }
    clearRateLimit(loginRateKey);

    if (user.status !== 'ACTIVE') {
      throw new AppError(403, 'Ce compte utilisateur est suspendu ou révoqué.');
    }

    let restaurantId: string | null = null;
    let restaurantName: string | null = null;
    let restaurantSlug: string | null = null;
    let restaurantStatus: string | null = null;
    let effectiveRole: Role = 'OWNER';
    let customPerms: string[] = [];

    if (user.global_role === 'SUPER_ADMIN') {
      effectiveRole = 'SUPER_ADMIN';
    } else {
      const member = await authRepository.findPrimaryMembershipForUser(user.id);
      if (!member || member.member_status !== 'ACTIVE') {
        throw new AppError(403, 'Aucun accès actif à un restaurant.');
      }
      if (member.deleted_at || member.restaurant_status === 'DELETED') {
        throw new AppError(403, 'Établissement supprimé.');
      }
      if (member.restaurant_status === 'SUSPENDED') {
        throw new AppError(
          403,
          'Votre établissement est temporairement suspendu. Contactez le support Resto’MAX.',
        );
      }

      restaurantId = String(member.restaurant_id);
      restaurantName = String(member.restaurant_name);
      restaurantSlug = String(member.restaurant_slug);
      restaurantStatus = String(member.restaurant_status);
      effectiveRole = member.role as Role;
      try {
        customPerms = JSON.parse(String(member.custom_permissions_json || '[]'));
      } catch {
        customPerms = [];
      }
    }

    const sessionId = generateId('ses');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

    await runAuthTransaction(async (trx) => {
      await authRepository.createSession({ sessionId, userId: user.id, restaurantId, expiresAt, userAgent: userAgent.slice(0, 200), now }, trx);
      await authRepository.updateLastLogin(user.id, now, trx);
      await recordAuditWithKnex(trx, { actorUserId: user.id, actorEmail: user.email, actorRole: effectiveRole, restaurantId, action: 'USER_LOGIN', targetType: 'SESSION', targetId: sessionId, details: 'Connexion réussie' });
    });

    const token = signSessionToken({ sessionId, userId: user.id });
    const venues =
      effectiveRole === 'SUPER_ADMIN'
        ? []
        : await authRepository.findUserVenues(user.id);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        phone: user.phone,
        role: effectiveRole,
        status: user.status,
        emailVerified: Boolean(user.email_verified),
        hasPin: Boolean(user.pin_hash),
        restaurantId,
        restaurantName,
        restaurantSlug,
        restaurantStatus,
        permissions: resolveEffectivePermissions(
          effectiveRole,
          customPerms as never[],
        ),
        venues,
      },
    };
  }

  async registerRestaurant(
    body: Record<string, unknown>,
    userAgent: string,
    baseUrl = '',
  ) {
    const {
      restaurantName,
      city,
      ownerName,
      email,
      phone,
      password,
      planCode,
    } = body || {};

    if (
      typeof restaurantName !== 'string' ||
      restaurantName.trim().length < 2 ||
      typeof ownerName !== 'string' ||
      ownerName.trim().length < 2 ||
      typeof email !== 'string' ||
      !email.includes('@') ||
      typeof password !== 'string' ||
      password.length < 8
    ) {
      throw new AppError(
        400,
        'Veuillez fournir le nom du restaurant, votre nom, un email valide et un mot de passe (min. 8 caractères).',
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await authRepository.findUserByEmail(normalizedEmail);
    if (existing) {
      throw new AppError(409, 'Un compte existe déjà avec cet email.');
    }

    const selectedPlan = await authRepository.findPlanForRegistration(
      String(planCode || 'ESSENTIEL').toUpperCase(),
    );
    if (!selectedPlan) {
      throw new AppError(503, 'Aucun plan SaaS actif n’est configuré. Contactez le support.');
    }

    const now = new Date().toISOString();
    const trialDays = selectedPlan?.trial_days || 14;
    const trialEndsAt = new Date(Date.now() + trialDays * 86400000).toISOString();
    const restaurantId = generateId('rest');
    const userId = generateId('usr');
    const memberId = generateId('mem');
    const subId = generateId('sub');
    const sessionId = generateId('ses');

    const slugBase = restaurantName
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const slug = `${slugBase || 'restaurant'}-${Math.floor(1000 + Math.random() * 9000)}`;
    const passwordHash = bcrypt.hashSync(password, 10);

    try {
      await runAuthTransaction(async (trx) => {
        await authRepository.createRestaurantWithOwnerAndStarterData({
          restaurantId, restaurantName: restaurantName.trim(), slug, email: normalizedEmail,
          phone: String(phone || '').trim(), city: String(city || 'Abidjan').trim(),
          userId, ownerName: ownerName.trim(), passwordHash, memberId, subId, planId: selectedPlan.id,
          trialEndsAt, sessionId, sessionExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          userAgent: userAgent.slice(0, 200), now,
        }, trx);
        await recordAuditWithKnex(trx, { actorUserId: userId, actorEmail: normalizedEmail, actorRole: 'OWNER', restaurantId, action: 'RESTAURANT_REGISTERED', targetType: 'RESTAURANT', targetId: restaurantId, details: `Création restaurant ${restaurantName.trim()} (${trialDays} jours essai)` });
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors de la création du restaurant.');
    }

    const rawVerifyCode = generateSecureTokenCode();
    await authRepository.createAuthToken({
      userId,
      email: normalizedEmail,
      tokenHash: hashAuthToken(rawVerifyCode),
      tokenType: 'EMAIL_VERIFY',
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    });
    const cleanBase = (baseUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const smtpConfig = await authRepository.resolveTransactionalSmtpConfig(userId);
    void sendAuthTransactionalEmail({
      to: normalizedEmail,
      fullName: ownerName.trim(),
      type: 'EMAIL_VERIFY',
      actionUrl: `${cleanBase}/verifier-email?token=${encodeURIComponent(rawVerifyCode)}`,
      tokenCode: rawVerifyCode,
      smtpConfig,
    });

    const token = signSessionToken({ sessionId, userId });
    return {
      token,
      emailVerificationRequired: true,
      ...(process.env.NODE_ENV !== 'production' && !isSmtpAvailable(smtpConfig)
        ? { previewVerifyToken: rawVerifyCode }
        : {}),
      user: {
        id: userId,
        email: normalizedEmail,
        fullName: ownerName.trim(),
        phone: String(phone || '').trim() || null,
        role: 'OWNER' as Role,
        status: 'ACTIVE',
        emailVerified: false,
        hasPin: false,
        restaurantId,
        restaurantName: restaurantName.trim(),
        restaurantSlug: slug,
        restaurantStatus: 'TRIAL',
        permissions: resolveEffectivePermissions('OWNER'),
        venues: [
          {
            restaurantId,
            name: restaurantName.trim(),
            slug,
            city: String(city || 'Abidjan').trim(),
            status: 'TRIAL',
            role: 'OWNER',
          },
        ],
      },
    };
  }

  async getMe(token: string | null) {
    if (!token) {
      throw new AppError(401, 'Non authentifié.');
    }
    const ctx = await resolveAuthContextWithKnex(token);
    if (!ctx) {
      throw new AppError(401, 'Session invalide ou expirée.');
    }
    const sec = await authRepository.findUserSecurityStatus(ctx.userId);
    const venues =
      ctx.role === 'SUPER_ADMIN' ? [] : await authRepository.findUserVenues(ctx.userId);
    return {
      id: ctx.userId,
      email: ctx.email,
      fullName: ctx.fullName,
      phone: sec?.phone || null,
      role: ctx.role,
      status: ctx.userStatus,
      emailVerified: Boolean(sec?.email_verified),
      hasPin: Boolean(sec?.pin_hash),
      restaurantId: ctx.restaurantId,
      restaurantName: ctx.restaurantName,
      restaurantSlug: ctx.restaurantSlug,
      restaurantStatus: ctx.restaurantStatus,
      permissions: ctx.permissions,
      venues,
    };
  }

  async getUserVenues(auth: AuthContext) {
    if (auth.role === 'SUPER_ADMIN') return [];
    return await authRepository.findUserVenues(auth.userId);
  }

  async switchVenue(auth: AuthContext, restaurantId: string) {
    if (auth.role === 'SUPER_ADMIN') {
      throw new AppError(403, 'Opération réservée aux comptes établissements.');
    }
    const cleanId = typeof restaurantId === 'string' ? restaurantId.trim() : '';
    if (!cleanId) {
      throw new AppError(400, 'Identifiant d’établissement requis.');
    }
    const venues = await authRepository.findUserVenues(auth.userId);
    const target = venues.find((v) => v.restaurantId === cleanId);
    if (!target) {
      throw new AppError(403, 'Accès refusé à cet établissement.');
    }
    if (target.status === 'SUSPENDED') {
      throw new AppError(403, 'Cet établissement est actuellement suspendu.');
    }

    const row = await authRepository.findMembershipForVenue(auth.userId, cleanId);
    await runAuthTransaction(async (trx) => {
      const updated = await authRepository.switchSessionRestaurant(auth.sessionId, auth.userId, cleanId, trx);
      if (updated !== 1) throw new AppError(401, 'Session invalide ou expirée.');
      await recordAuditWithKnex(trx, { actorUserId: auth.userId, actorEmail: auth.email, actorRole: target.role, restaurantId: cleanId, action: 'VENUE_SWITCHED', targetType: 'RESTAURANT', targetId: cleanId, details: `Bascule vers ${target.name}` });
    });
    let customPerms: string[] = [];
    try { customPerms = JSON.parse(String(row?.custom_permissions_json || '[]')); } catch { customPerms = []; }

    const sec = await authRepository.findUserSecurityStatus(auth.userId);
    const effectiveRole = (row?.role || target.role) as Role;
    return {
      user: {
        id: auth.userId,
        email: auth.email,
        fullName: auth.fullName,
        phone: sec?.phone || null,
        role: effectiveRole,
        status: auth.userStatus,
        emailVerified: Boolean(sec?.email_verified),
        hasPin: Boolean(sec?.pin_hash),
        restaurantId: target.restaurantId,
        restaurantName: target.name,
        restaurantSlug: target.slug,
        restaurantStatus: target.status,
        permissions: resolveEffectivePermissions(
          effectiveRole,
          customPerms as never[],
        ),
        venues,
      },
    };
  }

  async logout(auth?: AuthContext) {
    if (!auth) return;
    await runAuthTransaction(async (trx) => {
      await authRepository.revokeSession(auth.sessionId, trx);
      await recordAuditWithKnex(trx, { actorUserId: auth.userId, actorEmail: auth.email, actorRole: auth.role, restaurantId: auth.restaurantId, action: 'USER_LOGOUT', targetType: 'SESSION', targetId: auth.sessionId });
    });
  }

  async changePassword(auth: AuthContext, body: Record<string, unknown>) {
    const { currentPassword, newPassword } = body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) throw new AppError(400, 'Nouveau mot de passe trop court (min 8).');
    const user = await authRepository.findUserPasswordHash(auth.userId);
    if (!user || !bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) throw new AppError(400, 'Mot de passe actuel incorrect.');
    await runAuthTransaction(async (trx) => {
      await authRepository.updateUserPasswordHash(auth.userId, bcrypt.hashSync(newPassword, 10), trx);
      await authRepository.revokeAllUserSessions(auth.userId, trx);
      await recordAuditWithKnex(trx, { actorUserId: auth.userId, actorEmail: auth.email, actorRole: auth.role, restaurantId: auth.restaurantId, action: 'PASSWORD_CHANGED', targetType: 'USER', targetId: auth.userId });
    });
  }

  async forgotPassword(body: Record<string, unknown>, baseUrl = '') {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) {
      throw new AppError(400, 'Veuillez saisir une adresse e-mail valide.');
    }

    const forgotRateKey = `forgot:${email}`;
    assertWithinRateLimit(
      forgotRateKey,
      8,
      15 * 60_000,
      'Trop de demandes de réinitialisation. Patientez quelques minutes.',
    );
    recordRateLimitHit(forgotRateKey, 15 * 60_000);

    const user = await authRepository.findUserByEmail(email);
    if (!user || user.status !== 'ACTIVE') {
      return {
        ok: true,
        message:
          'Si un compte actif correspond à cet e-mail, un lien de réinitialisation a été généré.',
      };
    }

    const smtpConfig = await authRepository.resolveTransactionalSmtpConfig(user.id);
    const smtpConfigured = isSmtpAvailable(smtpConfig);

    await authRepository.invalidateUnusedAuthTokens(user.id, 'PASSWORD_RESET');
    const rawToken = generateSecureTokenCode();
    await authRepository.createAuthToken({
      userId: user.id,
      email: user.email,
      tokenHash: hashAuthToken(rawToken),
      tokenType: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    });

    const cleanBase = (baseUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const emailResult = await sendAuthTransactionalEmail({
      to: user.email,
      fullName: user.full_name,
      type: 'PASSWORD_RESET',
      actionUrl: `${cleanBase}/reinitialiser-mot-de-passe?token=${encodeURIComponent(rawToken)}`,
      tokenCode: rawToken,
      smtpConfig,
    });

    await recordAuditWithKnex(getKnex(), {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: 'USER',
      restaurantId: null,
      action: 'PASSWORD_RESET_REQUESTED',
      targetType: 'USER',
      targetId: user.id,
      details: `Statut e-mail: ${emailResult.status}`,
    });

    return {
      ok: true,
      emailStatus: emailResult.status,
      smtpConfigured,
      message:
        'Si un compte actif correspond à cet e-mail, un lien de réinitialisation a été généré.',
      ...(process.env.NODE_ENV !== 'production' && !smtpConfigured
        ? { previewResetToken: rawToken }
        : {}),
    };
  }

  async validateResetToken(rawToken: string) {
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!token) {
      return { valid: false, reason: 'MISSING' as const };
    }
    const record = await authRepository.findValidAuthToken(
      hashAuthToken(token),
      'PASSWORD_RESET',
    );
    if (!record) {
      return { valid: false, reason: 'INVALID' as const };
    }
    if (record.used_at) {
      return { valid: false, reason: 'USED' as const };
    }
    if (new Date(record.expires_at).getTime() < Date.now()) {
      return { valid: false, reason: 'EXPIRED' as const };
    }
    return {
      valid: true,
      expiresAt: record.expires_at,
    };
  }

  async resetPassword(body: Record<string, unknown>) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const newPassword =
      typeof body?.newPassword === 'string' ? body.newPassword : '';
    if (!token || newPassword.length < 8) {
      throw new AppError(
        400,
        'Code de réinitialisation valide et mot de passe (min. 8 caractères) requis.',
      );
    }

    const record = await authRepository.findValidAuthToken(
      hashAuthToken(token),
      'PASSWORD_RESET',
    );
    if (
      !record ||
      record.used_at ||
      new Date(record.expires_at).getTime() < Date.now()
    ) {
      throw new AppError(400, 'Lien ou code de réinitialisation invalide ou expiré.');
    }

    await runAuthTransaction(async (trx) => {
      const lockedRecord = await authRepository.findValidAuthToken(hashAuthToken(token), 'PASSWORD_RESET', trx, true);
      if (!lockedRecord || lockedRecord.used_at || new Date(lockedRecord.expires_at).getTime() < Date.now()) throw new AppError(400, 'Lien ou code de réinitialisation invalide ou expiré.');
      await authRepository.updateUserPasswordHash(lockedRecord.user_id, bcrypt.hashSync(newPassword, 10), trx);
      if (await authRepository.markAuthTokenUsed(lockedRecord.id, trx) !== 1) throw new AppError(409, 'Ce lien de réinitialisation a déjà été utilisé.');
      await authRepository.invalidateUnusedAuthTokens(lockedRecord.user_id, 'PASSWORD_RESET', trx);
      await authRepository.revokeAllUserSessions(lockedRecord.user_id, trx);
      await recordAuditWithKnex(trx, { actorUserId: lockedRecord.user_id, actorEmail: lockedRecord.email, actorRole: 'USER', restaurantId: null, action: 'PASSWORD_RESET_COMPLETED', targetType: 'USER', targetId: lockedRecord.user_id });
    });
  }

  async sendVerificationEmail(auth: AuthContext, baseUrl = '') {
    const sec = await authRepository.findUserSecurityStatus(auth.userId);
    if (!sec) {
      throw new AppError(404, 'Utilisateur introuvable.');
    }
    if (sec.email_verified) {
      return { ok: true, alreadyVerified: true };
    }

    const verifyRateKey = `verify-email:${auth.userId}`;
    assertWithinRateLimit(
      verifyRateKey,
      6,
      15 * 60_000,
      'Trop de demandes de vérification e-mail. Patientez quelques minutes.',
    );
    recordRateLimitHit(verifyRateKey, 15 * 60_000);

    await authRepository.invalidateUnusedAuthTokens(auth.userId, 'EMAIL_VERIFY');
    const rawCode = generateSecureTokenCode();
    await authRepository.createAuthToken({
      userId: auth.userId,
      email: auth.email,
      tokenHash: hashAuthToken(rawCode),
      tokenType: 'EMAIL_VERIFY',
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    });

    const cleanBase = (baseUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const smtpConfig = await authRepository.resolveTransactionalSmtpConfig(auth.userId);
    const emailResult = await sendAuthTransactionalEmail({
      to: auth.email,
      fullName: auth.fullName,
      type: 'EMAIL_VERIFY',
      actionUrl: `${cleanBase}/verifier-email?token=${encodeURIComponent(rawCode)}`,
      tokenCode: rawCode,
      smtpConfig,
    });

    return {
      ok: true,
      emailStatus: emailResult.status,
      ...(process.env.NODE_ENV !== 'production' &&
      !isEnvSmtpConfigured() &&
      !isSmtpAvailable(smtpConfig)
        ? { previewVerifyToken: rawCode }
        : {}),
    };
  }

  async verifyEmail(body: Record<string, unknown>) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) {
      throw new AppError(400, 'Code de vérification requis.');
    }
    const record = await authRepository.findValidAuthToken(
      hashAuthToken(token),
      'EMAIL_VERIFY',
    );
    if (
      !record ||
      record.used_at ||
      new Date(record.expires_at).getTime() < Date.now()
    ) {
      throw new AppError(400, 'Lien ou code de vérification invalide ou expiré.');
    }

    await runAuthTransaction(async (trx) => {
      const lockedRecord = await authRepository.findValidAuthToken(hashAuthToken(token), 'EMAIL_VERIFY', trx, true);
      if (!lockedRecord || lockedRecord.used_at || new Date(lockedRecord.expires_at).getTime() < Date.now()) throw new AppError(400, 'Lien ou code de vérification invalide ou expiré.');
      await authRepository.markUserEmailVerified(lockedRecord.user_id, trx);
      if (await authRepository.markAuthTokenUsed(lockedRecord.id, trx) !== 1) throw new AppError(409, 'Ce code de vérification a déjà été utilisé.');
      await authRepository.invalidateUnusedAuthTokens(lockedRecord.user_id, 'EMAIL_VERIFY', trx);
      await recordAuditWithKnex(trx, { actorUserId: lockedRecord.user_id, actorEmail: lockedRecord.email, actorRole: 'USER', restaurantId: null, action: 'EMAIL_VERIFIED', targetType: 'USER', targetId: lockedRecord.user_id });
    });
    return { ok: true, email: record.email };
  }

  async setPin(auth: AuthContext, body: Record<string, unknown>) {
    const { currentPassword, pin } = body || {};
    const cleanPin = typeof pin === 'string' ? pin.trim() : '';
    if (!/^\d{4,6}$/.test(cleanPin)) {
      throw new AppError(
        400,
        'Le code PIN doit contenir entre 4 et 6 chiffres.',
      );
    }

    const user = await authRepository.findUserPasswordHash(auth.userId);
    if (
      !user ||
      !bcrypt.compareSync(String(currentPassword || ''), user.password_hash)
    ) {
      throw new AppError(400, 'Mot de passe actuel incorrect.');
    }

    await runAuthTransaction(async (trx) => {
      await authRepository.updateUserPinHash(auth.userId, bcrypt.hashSync(cleanPin, 10), trx);
      await recordAuditWithKnex(trx, { actorUserId: auth.userId, actorEmail: auth.email, actorRole: auth.role, restaurantId: auth.restaurantId, action: 'USER_PIN_UPDATED', targetType: 'USER', targetId: auth.userId });
    });
  }

  async pinLogin(
    body: Record<string, unknown>,
    userAgent: string,
    activeRestaurantId?: string | null,
    options?: { allowedRoles?: Role[] },
  ) {
    const requestedRestaurantId =
      typeof body?.restaurantId === 'string' && body.restaurantId.trim()
        ? body.restaurantId.trim()
        : '';
    if (
      activeRestaurantId &&
      requestedRestaurantId &&
      requestedRestaurantId !== activeRestaurantId
    ) {
      throw new AppError(
        403,
        'Accès interdit : bascule PIN limitée à votre établissement actif.',
      );
    }
    const restaurantId = activeRestaurantId || requestedRestaurantId;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const pin = typeof body?.pin === 'string' ? body.pin.trim() : '';

    if (!restaurantId || !userId || !/^\d{4,6}$/.test(pin)) {
      throw new AppError(
        400,
        'Établissement, membre et code PIN (4 à 6 chiffres) requis.',
      );
    }

    const pinRateKey = `pin:${restaurantId}:${userId}`;
    assertWithinRateLimit(
      pinRateKey,
      10,
      15 * 60_000,
      'Trop de codes PIN erronés. Patientez 15 minutes ou utilisez votre mot de passe.',
    );

    const member = await authRepository.findMemberForPinLogin(restaurantId, userId);
    if (!member || !member.pin_hash || !bcrypt.compareSync(pin, member.pin_hash)) {
      recordRateLimitHit(pinRateKey, 15 * 60_000);
      throw new AppError(401, 'Code PIN invalide.');
    }
    clearRateLimit(pinRateKey);

    if (member.user_status !== 'ACTIVE' || member.member_status !== 'ACTIVE') {
      throw new AppError(403, 'Ce compte est suspendu ou révoqué.');
    }
    if (member.deleted_at || member.restaurant_status === 'DELETED') {
      throw new AppError(403, 'Établissement supprimé.');
    }
    if (member.restaurant_status === 'SUSPENDED') {
      throw new AppError(403, 'Établissement suspendu.');
    }

    const effectiveRole = member.role as Role;
    let customPerms: string[] = [];
    try {
      customPerms = JSON.parse(String(member.custom_permissions_json || '[]'));
    } catch {
      customPerms = [];
    }

    const resolvedPermissions = resolveEffectivePermissions(
      effectiveRole,
      customPerms as never[],
    );

    if (
      options?.allowedRoles &&
      (!options.allowedRoles.includes(effectiveRole) ||
        !resolvedPermissions.includes('pos:use'))
    ) {
      throw new AppError(
        403,
        'Seuls les serveurs, caissiers et responsables habilités peuvent basculer sur le terminal POS.',
      );
    }

    const sessionId = generateId('ses');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

    await runAuthTransaction(async (trx) => {
      await authRepository.createSession({ sessionId, userId: member.user_id, restaurantId: member.restaurant_id, expiresAt, userAgent: userAgent.slice(0, 200), now }, trx);
      await authRepository.updateLastLogin(member.user_id, now, trx);
      await recordAuditWithKnex(trx, { actorUserId: member.user_id, actorEmail: member.email, actorRole: effectiveRole, restaurantId: member.restaurant_id, action: 'USER_PIN_LOGIN', targetType: 'SESSION', targetId: sessionId, details: 'Bascule rapide par code PIN' });
    });

    const token = signSessionToken({ sessionId, userId: member.user_id });
    return {
      token,
      user: {
        id: member.user_id,
        email: member.email,
        fullName: member.full_name,
        phone: member.phone,
        role: effectiveRole,
        status: member.user_status,
        emailVerified: Boolean(member.email_verified),
        hasPin: true,
        restaurantId: member.restaurant_id,
        restaurantName: member.restaurant_name,
        restaurantSlug: member.restaurant_slug,
        restaurantStatus: member.restaurant_status,
        permissions: resolveEffectivePermissions(
          effectiveRole,
          customPerms as never[],
        ),
        venues: await authRepository.findUserVenues(member.user_id),
      },
    };
  }
}

export const authService = new AuthService();
