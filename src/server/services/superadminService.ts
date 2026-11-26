import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb, generateId } from '../db.ts';
import { type AuthContext, recordAudit, recordAuditWithKnex } from '../auth.ts';
import { broadcastRestaurantEvent, broadcastSuperAdminEvent } from '../ws.ts';
import { authRepository } from '../repositories/authRepository.ts';
import {
  SuperadminRepository,
  superadminRepository,
} from '../repositories/superadminRepository.ts';
import { BaseService } from './BaseService.ts';
import { getKnex } from '../knex.ts';
import { knexSuperadminSettingsRepository } from '../repositories/superadminRepository.knex.ts';
import { AppError } from './errors.ts';
import {
  isEnvSmtpConfigured,
  isSmtpAvailable,
  sendAuthTransactionalEmail,
  sendSmtpTestEmail,
  type SmtpRuntimeConfig,
} from './mailer.ts';
import {
  generateSecureTokenCode,
  hashAuthToken,
} from './authService.ts';
import { isDisallowedInternalHost } from './printerRelay.ts';

const PLATFORM_SETTINGS_ALLOWED_KEYS = new Set([
  'contact_email',
  'contact_phone',
  'commercial_region',
  'default_trial_days',
  'platform_currency',
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'paydunya_mode',
  'paydunya_master_key',
  'paydunya_private_key',
  'paydunya_token',
  'maintenance_mode',
  'platform_announcement',
]);

function usesPostgresRepositories(): boolean {
  return ['pg', 'postgres', 'postgresql'].includes((process.env.DATABASE_CLIENT || '').toLowerCase());
}

async function resolvePlatformSmtpConfig(): Promise<SmtpRuntimeConfig | undefined> {
  const rows = usesPostgresRepositories()
    ? await knexSuperadminSettingsRepository.findPlatformSettings()
    : superadminRepository.findPlatformSettings();
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  if (!map.smtp_host?.trim()) return undefined;
  const port = Number(map.smtp_port || 587);
  return {
    host: map.smtp_host.trim(),
    port: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : 587,
    secure: map.smtp_secure === 'true' || port === 465,
    user: (map.smtp_user || '').trim(),
    pass: map.smtp_pass || '',
    from: (map.smtp_from || '').trim(),
  };
}

export class SuperadminService extends BaseService<SuperadminRepository> {
  constructor(repo = superadminRepository) {
    super(repo);
  }

  getDashboard() {
    const {
      counts,
      activeSubs,
      mrrRow,
      trialExpiringRow,
      platformRev,
      openTickets,
      usersCount,
      leadsCount,
      recentRestaurants,
      recentAudit,
      monthlyPlatformSeries,
    } = superadminRepository.getPlatformDashboardData();

    const activeCount = Number(counts.active || 0);
    const totalCount = Number(counts.total || 0);
    const conversionRatePct =
      totalCount > 0 ? Math.round((activeCount / totalCount) * 100) : 0;

    return {
      kpis: {
        totalRestaurants: totalCount,
        activeRestaurants: activeCount,
        trialRestaurants: Number(counts.trial || 0),
        suspendedRestaurants: Number(counts.suspended || 0),
        activeSubscriptions: Number(activeSubs.c || 0),
        mrrXof: Number(mrrRow.mrr_xof || 0),
        trialExpiringSoonCount: Number(trialExpiringRow.c || 0),
        conversionRatePct,
        platformRevenueXof: Number(platformRev.paid_xof || 0),
        pendingPaymentsXof: Number(platformRev.pending_xof || 0),
        openTicketsCount: Number(openTickets.c || 0),
        activeUsersCount: Number(usersCount.c || 0),
        leadsCount: Number(leadsCount.c || 0),
      },
      recentRestaurants,
      recentAudit,
      monthlyPlatformSeries,
    };
  }

  listRestaurants() {
    return superadminRepository.findAllRestaurants();
  }

  getRestaurantDetail(rid: string) {
    const detail = superadminRepository.findRestaurantDetail(rid);
    if (!detail) {
      throw new AppError(404, 'Établissement introuvable.');
    }
    return detail;
  }

  updateRestaurant(
    auth: AuthContext,
    rid: string,
    body: Record<string, unknown>,
  ) {
    const detail = superadminRepository.findRestaurantDetail(rid);
    if (!detail) {
      throw new AppError(404, 'Établissement introuvable.');
    }

    const name =
      typeof body?.name === 'string' && body.name.trim()
        ? body.name.trim()
        : undefined;
    const city =
      typeof body?.city === 'string' && body.city.trim()
        ? body.city.trim()
        : undefined;
    const phone =
      typeof body?.phone === 'string' ? body.phone.trim() : undefined;
    const email =
      typeof body?.email === 'string' && body.email.includes('@')
        ? body.email.trim().toLowerCase()
        : undefined;
    const address =
      typeof body?.address === 'string' ? body.address.trim() : undefined;
    const country =
      typeof body?.country === 'string' && body.country.trim()
        ? body.country.trim()
        : undefined;

    superadminRepository.updateRestaurantProfile(rid, {
      name,
      city,
      phone,
      email,
      address,
      country,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: rid,
      action: 'RESTAURANT_UPDATED_BY_ADMIN',
      targetType: 'RESTAURANT',
      targetId: rid,
      details: name || city || 'Mise à jour établissement',
    });

    broadcastSuperAdminEvent('restaurant:updated', { restaurantId: rid });
  }

  async createRestaurant(
    auth: AuthContext,
    body: Record<string, unknown>,
    baseUrl?: string,
  ) {
    const { name, city, ownerName, ownerEmail, phone, planCode } = body || {};
    if (
      typeof name !== 'string' ||
      name.trim().length < 2 ||
      typeof ownerName !== 'string' ||
      ownerName.trim().length < 2 ||
      typeof ownerEmail !== 'string' ||
      !ownerEmail.includes('@')
    ) {
      throw new AppError(400, 'Nom, propriétaire et email valide requis.');
    }

    const cleanEmail = ownerEmail.trim().toLowerCase();
    const existing = superadminRepository.findUserByEmail(cleanEmail);
    if (existing) {
      throw new AppError(409, 'Email propriétaire déjà utilisé.');
    }

    const plan = superadminRepository.findPlanByCodeOrDefault(
      String(planCode || 'PROFESSIONNEL').toUpperCase(),
    );
    const now = new Date().toISOString();
    const rid = generateId('rest');
    const uid = generateId('usr');
    const slugBase = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const slug = `${slugBase || 'restaurant'}-${Math.floor(100 + Math.random() * 900)}`;
    const tempPassword = crypto.randomBytes(9).toString('base64url');
    const resetCode = generateSecureTokenCode();

    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      superadminRepository.createRestaurantAdmin({
        rid,
        uid,
        name: name.trim(),
        slug,
        cleanEmail,
        phone: String(phone || '').trim(),
        city: String(city || 'Abidjan').trim() || 'Abidjan',
        ownerName: ownerName.trim(),
        passwordHash: bcrypt.hashSync(tempPassword, 10),
        planId: plan.id,
        now,
        periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });

      authRepository.createAuthToken({
        userId: uid,
        email: cleanEmail,
        tokenHash: hashAuthToken(resetCode),
        tokenType: 'PASSWORD_RESET',
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      });

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: 'SUPER_ADMIN',
        restaurantId: rid,
        action: 'RESTAURANT_CREATED_BY_ADMIN',
        targetType: 'RESTAURANT',
        targetId: rid,
        details: `${name.trim()} (${plan.code})`,
      });

      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      throw new AppError(500, 'Erreur création restaurant.');
    }

    const cleanBase = (baseUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const smtpConfig = await resolvePlatformSmtpConfig();
    const emailResult = await sendAuthTransactionalEmail({
      to: cleanEmail,
      fullName: ownerName.trim(),
      type: 'PASSWORD_RESET',
      actionUrl: `${cleanBase}/reinitialiser-mot-de-passe?token=${encodeURIComponent(resetCode)}`,
      tokenCode: resetCode,
      smtpConfig,
    });

    broadcastSuperAdminEvent('restaurant:created', { restaurantId: rid });

    return {
      id: rid,
      planCode: plan.code,
      tempPassword,
      emailStatus: emailResult.status,
      ...(process.env.NODE_ENV !== 'production' &&
      !isEnvSmtpConfigured() &&
      !isSmtpAvailable(smtpConfig)
        ? { previewResetToken: resetCode }
        : {}),
    };
  }

  updateRestaurantStatus(
    auth: AuthContext,
    rid: string,
    body: Record<string, unknown>,
  ) {
    const { status, reason } = body || {};
    if (
      !['ACTIVE', 'TRIAL', 'SUSPENDED', 'DELETED'].includes(String(status))
    ) {
      throw new AppError(400, 'Statut invalide.');
    }
    const detail = superadminRepository.findRestaurantDetail(rid);
    if (!detail) {
      throw new AppError(404, 'Établissement introuvable.');
    }

    superadminRepository.updateRestaurantStatus(rid, String(status));

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: rid,
      action: `RESTAURANT_${status}`,
      targetType: 'RESTAURANT',
      targetId: rid,
      details: String(reason || ''),
    });

    broadcastSuperAdminEvent('restaurant:updated', {
      restaurantId: rid,
      status,
    });
  }

  listPlans() {
    const plans = superadminRepository.findAllPlans();
    return plans.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      tagline: p.tagline,
      priceMonthlyXof: Number(p.price_monthly_xof),
      priceYearlyXof: Number(p.price_yearly_xof),
      trialDays: Number(p.trial_days),
      maxTables: Number(p.max_tables),
      maxStaff: Number(p.max_staff),
      maxMenuItems: Number(p.max_menu_items),
      isDemoPricing: Boolean(p.is_demo_pricing),
      isFeatured: Boolean(p.is_featured),
      features: JSON.parse(String(p.features_json || '[]')),
      active: Boolean(p.active),
    }));
  }

  createPlan(auth: AuthContext, body: Record<string, unknown>) {
    const code = String(body?.code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_');
    const name = String(body?.name || '').trim();
    const tagline = String(body?.tagline || '').trim();
    const priceMonthlyXof = Math.max(0, Math.round(Number(body?.priceMonthlyXof ?? 0)));
    const priceYearlyXof = Math.max(0, Math.round(Number(body?.priceYearlyXof ?? 0)));
    const trialDays = Math.max(0, Math.round(Number(body?.trialDays ?? 14)));
    const maxTables = Math.max(1, Math.round(Number(body?.maxTables ?? 15)));
    const maxStaff = Math.max(1, Math.round(Number(body?.maxStaff ?? 5)));
    const maxMenuItems = Math.max(1, Math.round(Number(body?.maxMenuItems ?? 60)));
    const features = Array.isArray(body?.features)
      ? body.features.map((f) => String(f).trim()).filter(Boolean)
      : [];
    const isFeatured = body?.isFeatured ? 1 : 0;
    const active = body?.active === false ? 0 : 1;

    if (!code || code.length < 2 || !name) {
      throw new AppError(400, 'Code et nom du plan requis.');
    }

    const id = generateId('plan');
    try {
      superadminRepository.createPlan({
        id,
        code,
        name,
        tagline,
        priceMonthlyXof,
        priceYearlyXof,
        trialDays,
        maxTables,
        maxStaff,
        maxMenuItems,
        isFeatured,
        featuresJson: JSON.stringify(features),
        active,
        now: new Date().toISOString(),
      });
    } catch {
      throw new AppError(409, 'Un plan avec ce code existe déjà.');
    }

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'PLAN_CREATED',
      targetType: 'PLAN',
      targetId: id,
      details: `${code} (${name})`,
    });

    return { id };
  }

  updatePlan(
    auth: AuthContext,
    planId: string,
    body: Record<string, unknown>,
  ) {
    const existing = superadminRepository.findPlanById(planId);
    if (!existing) {
      throw new AppError(404, 'Plan introuvable.');
    }

    const {
      name,
      tagline,
      priceMonthlyXof,
      priceYearlyXof,
      trialDays,
      maxTables,
      maxStaff,
      maxMenuItems,
      features,
      isFeatured,
      active,
    } = body || {};

    const featuresJson = Array.isArray(features)
      ? JSON.stringify(features.map((f) => String(f).trim()).filter(Boolean))
      : null;

    superadminRepository.updatePlan(planId, {
      name: typeof name === 'string' && name.trim() ? name.trim() : null,
      tagline: typeof tagline === 'string' ? tagline.trim() : null,
      priceMonthlyXof: Number.isFinite(Number(priceMonthlyXof))
        ? Math.max(0, Math.round(Number(priceMonthlyXof)))
        : null,
      priceYearlyXof: Number.isFinite(Number(priceYearlyXof))
        ? Math.max(0, Math.round(Number(priceYearlyXof)))
        : null,
      trialDays: Number.isFinite(Number(trialDays))
        ? Math.max(0, Math.round(Number(trialDays)))
        : null,
      maxTables: Number.isFinite(Number(maxTables))
        ? Math.max(1, Math.round(Number(maxTables)))
        : null,
      maxStaff: Number.isFinite(Number(maxStaff))
        ? Math.max(1, Math.round(Number(maxStaff)))
        : null,
      maxMenuItems: Number.isFinite(Number(maxMenuItems))
        ? Math.max(1, Math.round(Number(maxMenuItems)))
        : null,
      featuresJson,
      isFeatured: typeof isFeatured === 'boolean' ? (isFeatured ? 1 : 0) : null,
      active: typeof active === 'boolean' ? (active ? 1 : 0) : null,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'PLAN_UPDATED',
      targetType: 'PLAN',
      targetId: planId,
      details: 'Mise à jour tarif/limites',
    });
  }

  listSubscriptions() {
    return superadminRepository.findAllSubscriptions().map((s) => ({
      ...s,
      autoRenew: Boolean(s.autoRenew),
      effectiveAmountXof:
        s.billingCycle === 'YEARLY'
          ? Number(s.priceYearlyXof || 0)
          : Number(s.priceMonthlyXof || 0),
    }));
  }

  updateSubscription(
    auth: AuthContext,
    subId: string,
    body: Record<string, unknown>,
  ) {
    const sub = superadminRepository.findSubscriptionById(subId);
    if (!sub) {
      throw new AppError(404, 'Abonnement introuvable.');
    }

    const planId =
      typeof body?.planId === 'string' && body.planId.trim()
        ? body.planId.trim()
        : undefined;
    if (planId && !superadminRepository.findPlanById(planId)) {
      throw new AppError(400, 'Plan sélectionné introuvable.');
    }

    const billingCycle = body?.billingCycle
      ? String(body.billingCycle).toUpperCase()
      : undefined;
    if (billingCycle && !['MONTHLY', 'YEARLY'].includes(billingCycle)) {
      throw new AppError(400, 'Cycle de facturation invalide.');
    }

    const status = body?.status ? String(body.status).toUpperCase() : undefined;
    if (
      status &&
      !['ACTIVE', 'TRIAL', 'PAST_DUE', 'CANCELLED'].includes(status)
    ) {
      throw new AppError(400, 'Statut d’abonnement invalide.');
    }

    let currentPeriodEnd: string | undefined;
    if (typeof body?.extendDays === 'number' && Number.isFinite(body.extendDays)) {
      const days = Math.round(body.extendDays);
      const baseMs = Math.max(
        Date.now(),
        new Date(sub.current_period_end).getTime() || Date.now(),
      );
      currentPeriodEnd = new Date(baseMs + days * 86_400_000).toISOString();
    } else if (
      typeof body?.currentPeriodEnd === 'string' &&
      !Number.isNaN(Date.parse(body.currentPeriodEnd))
    ) {
      currentPeriodEnd = new Date(body.currentPeriodEnd).toISOString();
    }

    const autoRenew =
      typeof body?.autoRenew === 'boolean' ? (body.autoRenew ? 1 : 0) : undefined;

    superadminRepository.updateSubscription(subId, {
      planId,
      billingCycle,
      status,
      currentPeriodEnd,
      autoRenew,
    });

    if (status === 'ACTIVE' || status === 'TRIAL') {
      const detail = superadminRepository.findRestaurantDetail(sub.restaurant_id);
      if (detail && detail.restaurant.status !== 'DELETED') {
        superadminRepository.updateRestaurantStatus(sub.restaurant_id, status);
      }
    }

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: sub.restaurant_id,
      action: 'SUBSCRIPTION_UPDATED_BY_ADMIN',
      targetType: 'SUBSCRIPTION',
      targetId: subId,
      details: `${status || sub.status} · ${billingCycle || sub.billing_cycle}`,
    });

    broadcastRestaurantEvent(sub.restaurant_id, 'subscription:updated', {
      subscriptionId: subId,
      status: status || sub.status,
    });
  }

  listInvoices() {
    return superadminRepository.findPlatformInvoices();
  }

  markInvoicePaid(auth: AuthContext, invoiceId: string) {
    const existing = superadminRepository.findInvoiceById(invoiceId);
    if (!existing) {
      throw new AppError(404, 'Facture introuvable.');
    }
    if (existing.status === 'PAID') {
      return { alreadyPaid: true };
    }

    const db = getDb();
    let result: ReturnType<typeof superadminRepository.markInvoicePaidAndActivate>;
    db.exec('BEGIN IMMEDIATE');
    try {
      result = superadminRepository.markInvoicePaidAndActivate(invoiceId);
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: 'SUPER_ADMIN',
        restaurantId: existing.restaurant_id,
        action: 'PLATFORM_INVOICE_PAID',
        targetType: 'INVOICE',
        targetId: invoiceId,
        details: `Facture ${existing.invoice_number} validée et abonnement activé`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors de la validation de facture.');
    }

    if (result) {
      broadcastRestaurantEvent(result.restaurantId, 'subscription:updated', {
        subscriptionId: result.subscriptionId,
        invoiceId,
        status: 'ACTIVE',
      });
      broadcastSuperAdminEvent('billing:updated', { invoiceId, status: 'PAID' });
    }
    return { alreadyPaid: false };
  }

  createManualInvoice(auth: AuthContext, body: Record<string, unknown>) {
    const restaurantId = String(body?.restaurantId || '').trim();
    const detail = superadminRepository.findRestaurantDetail(restaurantId);
    if (!detail) {
      throw new AppError(404, 'Restaurant introuvable.');
    }

    const planId =
      typeof body?.planId === 'string' && body.planId.trim()
        ? body.planId.trim()
        : String(detail.restaurant.planId || 'plan_essentiel');
    const billingCycle: 'MONTHLY' | 'YEARLY' =
      String(body?.billingCycle || 'MONTHLY').toUpperCase() === 'YEARLY'
        ? 'YEARLY'
        : 'MONTHLY';
    const paymentMethod = String(body?.paymentMethod || 'CASH').trim().toUpperCase();
    const status: 'PENDING' | 'PAID' =
      String(body?.status || 'PENDING').toUpperCase() === 'PAID'
        ? 'PAID'
        : 'PENDING';

    const plan = superadminRepository.findPlanById(planId);
    const computedAmount = plan
      ? billingCycle === 'YEARLY'
        ? Number(plan.price_yearly_xof)
        : Number(plan.price_monthly_xof)
      : 0;
    const amountXof = Number.isFinite(Number(body?.amountXof)) && Number(body?.amountXof) > 0
      ? Math.round(Number(body?.amountXof))
      : computedAmount;

    if (!Number.isFinite(amountXof) || amountXof <= 0) {
      throw new AppError(400, 'Montant de facture invalide.');
    }

    const id = generateId('pinv');
    const invoiceNumber = `INV-SA-${Date.now().toString().slice(-6)}`;
    const now = new Date().toISOString();

    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      superadminRepository.createManualInvoice({
        id,
        invoiceNumber,
        restaurantId,
        subscriptionId: (detail.restaurant.subscriptionId as string | null) || null,
        planId,
        billingCycle,
        amountXof,
        paymentMethod,
        status,
        now,
      });

      if (status === 'PAID') {
        superadminRepository.markInvoicePaidAndActivate(id);
      }

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: 'SUPER_ADMIN',
        restaurantId,
        action: 'PLATFORM_INVOICE_CREATED',
        targetType: 'INVOICE',
        targetId: id,
        details: `${invoiceNumber} (${amountXof} FCFA · ${status})`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur création facture manuelle.');
    }

    return { id, invoiceNumber };
  }

  updateInvoiceStatus(
    auth: AuthContext,
    invoiceId: string,
    body: Record<string, unknown>,
  ) {
    const status = String(body?.status || '').toUpperCase();
    if (!['PENDING', 'FAILED', 'CANCELLED'].includes(status)) {
      throw new AppError(400, 'Statut facture invalide.');
    }
    const existing = superadminRepository.findInvoiceById(invoiceId);
    if (!existing) {
      throw new AppError(404, 'Facture introuvable.');
    }
    if (existing.status === 'PAID') {
      throw new AppError(409, 'Une facture déjà payée ne peut pas être annulée.');
    }
    superadminRepository.updateInvoiceStatus(invoiceId, status);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: existing.restaurant_id,
      action: `PLATFORM_INVOICE_${status}`,
      targetType: 'INVOICE',
      targetId: invoiceId,
      details: existing.invoice_number,
    });
  }

  listUsers() {
    return superadminRepository.findAllUsers().map((u) => {
      const row = u as Record<string, unknown>;
      return {
        ...row,
        emailVerified: Boolean(row.emailVerified),
        activeSessionsCount: Number(row.activeSessionsCount || 0),
      };
    });
  }

  updateUserStatus(
    auth: AuthContext,
    targetUserId: string,
    status: unknown,
  ) {
    if (!['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(String(status))) {
      throw new AppError(400, 'Statut invalide.');
    }
    if (targetUserId === auth.userId) {
      throw new AppError(
        400,
        'Impossible de modifier votre propre compte actif.',
      );
    }

    superadminRepository.updateUserStatus(targetUserId, String(status));
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: `USER_${status}`,
      targetType: 'USER',
      targetId: targetUserId,
    });
  }

  revokeUserSessions(auth: AuthContext, targetUserId: string) {
    if (targetUserId === auth.userId) {
      throw new AppError(
        400,
        'Utilisez la déconnexion classique pour votre session courante.',
      );
    }
    const target = superadminRepository.findUserById(targetUserId);
    if (!target) {
      throw new AppError(404, 'Utilisateur introuvable.');
    }

    authRepository.revokeAllUserSessions(targetUserId);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'USER_SESSIONS_REVOKED_BY_ADMIN',
      targetType: 'USER',
      targetId: targetUserId,
      details: target.email,
    });
  }

  verifyUserEmail(auth: AuthContext, targetUserId: string) {
    const target = superadminRepository.findUserById(targetUserId);
    if (!target) {
      throw new AppError(404, 'Utilisateur introuvable.');
    }
    authRepository.markUserEmailVerified(targetUserId);
    authRepository.invalidateUnusedAuthTokens(targetUserId, 'EMAIL_VERIFY');
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'USER_EMAIL_VERIFIED_BY_ADMIN',
      targetType: 'USER',
      targetId: targetUserId,
      details: target.email,
    });
  }

  async triggerUserPasswordReset(
    auth: AuthContext,
    targetUserId: string,
    baseUrl?: string,
  ) {
    const target = superadminRepository.findUserById(targetUserId);
    if (!target) {
      throw new AppError(404, 'Utilisateur introuvable.');
    }
    const rawToken = generateSecureTokenCode();
    authRepository.invalidateUnusedAuthTokens(targetUserId, 'PASSWORD_RESET');
    authRepository.createAuthToken({
      userId: targetUserId,
      email: target.email,
      tokenHash: hashAuthToken(rawToken),
      tokenType: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    const cleanBase = (baseUrl || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const smtpConfig = resolvePlatformSmtpConfig();
    const emailResult = await sendAuthTransactionalEmail({
      to: target.email,
      fullName: target.full_name,
      type: 'PASSWORD_RESET',
      actionUrl: `${cleanBase}/reinitialiser-mot-de-passe?token=${encodeURIComponent(rawToken)}`,
      tokenCode: rawToken,
      smtpConfig,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'ADMIN_PASSWORD_RESET_SENT',
      targetType: 'USER',
      targetId: targetUserId,
      details: target.email,
    });

    return {
      ok: true,
      emailStatus: emailResult.status,
      ...(process.env.NODE_ENV !== 'production' &&
      !isEnvSmtpConfigured() &&
      !isSmtpAvailable(smtpConfig)
        ? { previewResetToken: rawToken }
        : {}),
    };
  }

  createSuperAdmin(auth: AuthContext, body: Record<string, unknown>) {
    const fullName = String(body?.fullName || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const phone = String(body?.phone || '').trim();
    const password = String(body?.password || '');

    if (fullName.length < 2 || !email.includes('@') || password.length < 8) {
      throw new AppError(
        400,
        'Nom complet, e-mail valide et mot de passe (min. 8 caractères) requis.',
      );
    }

    if (superadminRepository.findUserByEmail(email)) {
      throw new AppError(409, 'Un compte avec cet e-mail existe déjà.');
    }

    const id = generateId('usr');
    superadminRepository.createSuperAdminUser({
      id,
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      fullName,
      phone,
      now: new Date().toISOString(),
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'SUPERADMIN_CREATED',
      targetType: 'USER',
      targetId: id,
      details: email,
    });

    return { id };
  }

  listTicketsAndLeads() {
    return superadminRepository.findAllTicketsAndLeads();
  }

  createTicket(auth: AuthContext, body: Record<string, unknown>) {
    const subject = String(body?.subject || '').trim();
    const messageBody = String(body?.body || '').trim();
    const category = String(body?.category || 'Support & Opérations').trim();
    const priority = String(body?.priority || 'MEDIUM').toUpperCase();
    const restaurantId =
      typeof body?.restaurantId === 'string' && body.restaurantId.trim()
        ? body.restaurantId.trim()
        : null;

    if (subject.length < 3 || messageBody.length < 3) {
      throw new AppError(400, 'Sujet et message requis.');
    }
    if (!['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(priority)) {
      throw new AppError(400, 'Priorité invalide.');
    }

    const ticketId = generateId('tkt');
    superadminRepository.createSupportTicket({
      ticketId,
      msgId: generateId('tmsg'),
      restaurantId,
      createdByEmail: auth.email,
      author: auth.fullName,
      subject,
      category,
      priority,
      body: messageBody,
      now: new Date().toISOString(),
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId,
      action: 'SUPPORT_TICKET_CREATED',
      targetType: 'TICKET',
      targetId: ticketId,
      details: subject,
    });

    return { id: ticketId };
  }

  updateLead(
    auth: AuthContext,
    leadId: string,
    body: Record<string, unknown>,
  ) {
    const lead = superadminRepository.findLeadById(leadId);
    if (!lead) {
      throw new AppError(404, 'Prospect introuvable.');
    }
    const status = body?.status ? String(body.status).toUpperCase() : undefined;
    if (
      status &&
      !['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED'].includes(status)
    ) {
      throw new AppError(400, 'Statut prospect invalide.');
    }
    const adminNotes =
      typeof body?.adminNotes === 'string'
        ? body.adminNotes.slice(0, 1000)
        : undefined;

    superadminRepository.updateLead(leadId, { status, adminNotes });
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'LEAD_UPDATED',
      targetType: 'LEAD',
      targetId: leadId,
      details: status || 'notes',
    });
  }

  async convertLeadToRestaurant(
    auth: AuthContext,
    leadId: string,
    body: Record<string, unknown>,
    baseUrl?: string,
  ) {
    const lead = superadminRepository.findLeadById(leadId);
    if (!lead) {
      throw new AppError(404, 'Prospect introuvable.');
    }
    if (lead.converted_restaurant_id) {
      return {
        restaurantId: lead.converted_restaurant_id,
        alreadyConverted: true,
      };
    }

    const restaurantName =
      String(body?.name || lead.restaurant_name || '').trim() ||
      `Restaurant ${lead.full_name}`;
    const rawPlanCode = String(body?.planCode || 'PROFESSIONNEL').toUpperCase();
    const planCode = rawPlanCode === 'PRO' ? 'PROFESSIONNEL' : rawPlanCode;

    const created = await this.createRestaurant(
      auth,
      {
        name: restaurantName,
        city: String(body?.city || lead.city || 'Abidjan'),
        ownerName: lead.full_name,
        ownerEmail: lead.email,
        phone: lead.phone,
        planCode,
      },
      baseUrl,
    );

    superadminRepository.updateLead(leadId, {
      status: 'CONVERTED',
      convertedRestaurantId: created.id,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: created.id,
      action: 'LEAD_CONVERTED',
      targetType: 'LEAD',
      targetId: leadId,
      details: `Converti en restaurant ${restaurantName} (${created.planCode})`,
    });

    return {
      restaurantId: created.id,
      alreadyConverted: false,
      planCode: created.planCode,
      tempPassword: created.tempPassword,
      emailStatus: created.emailStatus,
      ...(created.previewResetToken
        ? { previewResetToken: created.previewResetToken }
        : {}),
    };
  }

  replyToTicket(
    auth: AuthContext,
    ticketId: string,
    body: Record<string, unknown>,
  ) {
    const { body: messageBody, status } = body || {};
    superadminRepository.addTicketReply(
      ticketId,
      auth.fullName,
      typeof messageBody === 'string' ? messageBody : undefined,
      status ? String(status) : undefined,
    );
  }

  listAuditLogs(filters?: {
    q?: string;
    action?: string;
    targetType?: string;
    restaurantId?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) {
    return superadminRepository.findAuditLogs(filters);
  }

  async getPlatformSettings(): Promise<Record<string, string>> {
    const rows = usesPostgresRepositories()
      ? await knexSuperadminSettingsRepository.findPlatformSettings()
      : superadminRepository.findPlatformSettings();
    const secretKeys = new Set([
      'smtp_pass',
      'paydunya_master_key',
      'paydunya_private_key',
      'paydunya_token',
    ]);
    const settings: Record<string, string> = {};
    for (const r of rows) {
      if (secretKeys.has(r.key)) {
        settings[`${r.key}_configured`] = r.value.trim() ? 'true' : 'false';
      } else {
        settings[r.key] = r.value;
      }
    }
    settings.env_smtp_configured = isEnvSmtpConfigured() ? 'true' : 'false';
    return settings;
  }

  async updatePlatformSettings(
    auth: AuthContext,
    updates: Record<string, unknown>,
  ) {
    const secretKeys = new Set([
      'smtp_pass',
      'paydunya_master_key',
      'paydunya_private_key',
      'paydunya_token',
    ]);

    const entries: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(updates || {})) {
      if (!PLATFORM_SETTINGS_ALLOWED_KEYS.has(k) || typeof v !== 'string') {
        continue;
      }
      const trimmed = v.trim();
      if (secretKeys.has(k) && !trimmed) continue;

      if (k === 'smtp_host' && trimmed && isDisallowedInternalHost(trimmed)) {
        throw new AppError(
          400,
          'Hôte SMTP non autorisé (adresses locales ou métadonnées bloquées).',
        );
      }
      if (k === 'smtp_port' && trimmed) {
        const port = Number(trimmed);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new AppError(400, 'Port SMTP invalide (1–65535).');
        }
      }
      if (k === 'paydunya_mode' && !['TEST', 'LIVE'].includes(trimmed.toUpperCase())) {
        throw new AppError(400, 'Mode PayDunya invalide.');
      }
      if (k === 'maintenance_mode' && !['true', 'false'].includes(trimmed.toLowerCase())) {
        throw new AppError(400, 'Valeur mode maintenance invalide.');
      }
      if (k === 'default_trial_days' && trimmed) {
        const d = Number(trimmed);
        if (!Number.isInteger(d) || d < 1 || d > 365) {
          throw new AppError(400, 'Durée d’essai invalide (1–365 jours).');
        }
      }

      entries.push([
        k,
        k === 'paydunya_mode'
          ? trimmed.toUpperCase()
          : k === 'maintenance_mode' || k === 'smtp_secure'
            ? trimmed.toLowerCase()
            : trimmed,
      ]);
    }

    const auditParams = {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: 'SUPER_ADMIN',
      restaurantId: null,
      action: 'PLATFORM_SETTINGS_UPDATED',
      targetType: 'SETTINGS',
      targetId: 'global',
    };
    if (usesPostgresRepositories()) {
      await getKnex().transaction(async (trx) => {
        await knexSuperadminSettingsRepository.upsertPlatformSettings(entries, trx);
        await recordAuditWithKnex(trx, auditParams);
      });
    } else {
      superadminRepository.upsertPlatformSettings(entries);
      recordAudit(getDb(), auditParams);
    }
  }

  async testPlatformSmtp(auth: AuthContext, body: Record<string, unknown>) {
    const rawRecipient =
      typeof body?.recipient === 'string' && body.recipient.includes('@')
        ? body.recipient.trim().toLowerCase()
        : auth.email;

    const smtpConfig = resolvePlatformSmtpConfig();

    return sendSmtpTestEmail({
      restaurantName: "Plateforme Resto'MAX",
      recipients: [rawRecipient],
      smtpConfig,
    });
  }
}

export const superadminService = new SuperadminService();
