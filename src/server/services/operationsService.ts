import bcrypt from 'bcryptjs';
import { getDb, generateId } from '../db.ts';
import { type AuthContext, recordAudit, recordAuditWithKnex } from '../auth.ts';
import {
  operationsRepository,
  OperationsRepository,
} from '../repositories/operationsRepository.ts';
import { broadcastRestaurantEvent } from '../ws.ts';
import { getKnex } from '../knex.ts';
import { knexOperationsReadRepository } from '../repositories/operationsRepository.knex.ts';
import {
  assertWithinRateLimit,
  clearRateLimit,
  recordRateLimitHit,
} from '../rateLimit.ts';
import { BaseService } from './BaseService.ts';
import { AppError } from './errors.ts';
import type { B2bInvoice } from '../../types/index.ts';

function usesPostgresRepositories(): boolean {
  return ['pg', 'postgres', 'postgresql'].includes((process.env.DATABASE_CLIENT || '').toLowerCase());
}

export class OperationsService extends BaseService<OperationsRepository> {
  constructor(repo = operationsRepository) {
    super(repo);
  }

  // ── 1. Combos / Formules ─────────────────────────────────────────────────
  async listCombos(rid: string) {
    this.ensureTenantId(rid);
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findCombos(rid, false)
      : operationsRepository.findCombos(rid, false);
  }

  async createCombo(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const priceXof = Math.round(Number(body?.priceXof));
    if (name.length < 2 || !Number.isFinite(priceXof) || priceXof < 0) {
      throw new AppError(400, 'Nom et prix de formule valides requis.');
    }
    const rawItems = Array.isArray(body?.items) ? body.items : [];
    const items = rawItems
      .map((it) => {
        const obj = (it || {}) as Record<string, unknown>;
        const label = String(obj.label || '').trim();
        if (!label) return null;
        return {
          label,
          quantity: Math.max(1, Math.min(20, Math.floor(Number(obj.quantity || 1)))),
          ...(typeof obj.menuItemId === 'string' && obj.menuItemId.trim()
            ? { menuItemId: obj.menuItemId.trim() }
            : {}),
        };
      })
      .filter(
        (x): x is { label: string; quantity: number; menuItemId?: string } =>
          x !== null,
      );

    if (items.length === 0) {
      throw new AppError(400, 'Ajoutez au moins un plat ou composant à la formule.');
    }

    const comboParams = {
      rid,
      name,
      description: String(body?.description || '').trim(),
      priceXof,
      imageUrl:
        typeof body?.imageUrl === 'string' && body.imageUrl.trim()
          ? body.imageUrl.trim()
          : null,
      isDailySpecial: Boolean(body?.isDailySpecial),
      items,
    };
    const id = usesPostgresRepositories()
      ? await knexOperationsReadRepository.createCombo(comboParams)
      : operationsRepository.createCombo(comboParams);

    const auditParams = {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'MENU_COMBO_CREATED',
      targetType: 'MENU_COMBO',
      targetId: id,
      details: `${name} (${priceXof} FCFA)`,
    };
    if (usesPostgresRepositories()) await recordAuditWithKnex(getKnex(), auditParams);
    else recordAudit(getDb(), auditParams);
    broadcastRestaurantEvent(rid, 'menu:updated', { comboId: id });
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findComboById(id, rid)
      : operationsRepository.findComboById(id, rid);
  }

  async updateCombo(auth: AuthContext, id: string, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const existing = usesPostgresRepositories()
      ? await knexOperationsReadRepository.findComboById(id, rid)
      : operationsRepository.findComboById(id, rid);
    if (!existing) throw new AppError(404, 'Formule introuvable.');

    const updates: Parameters<typeof operationsRepository.updateCombo>[2] = {};
    if (typeof body?.name === 'string' && body.name.trim().length >= 2) {
      updates.name = body.name.trim();
    }
    if (typeof body?.description === 'string') {
      updates.description = body.description.trim();
    }
    if (
      body?.priceXof !== undefined &&
      Number.isFinite(Number(body.priceXof)) &&
      Number(body.priceXof) >= 0
    ) {
      updates.priceXof = Math.round(Number(body.priceXof));
    }
    if (typeof body?.isDailySpecial === 'boolean') {
      updates.isDailySpecial = body.isDailySpecial;
    }
    if (typeof body?.active === 'boolean') {
      updates.active = body.active;
    }
    if (Array.isArray(body?.items)) {
      updates.items = body.items
        .map((it) => {
          const obj = (it || {}) as Record<string, unknown>;
          const label = String(obj.label || '').trim();
          if (!label) return null;
          return {
            label,
            quantity: Math.max(1, Math.min(20, Math.floor(Number(obj.quantity || 1)))),
            ...(typeof obj.menuItemId === 'string' && obj.menuItemId.trim()
              ? { menuItemId: obj.menuItemId.trim() }
              : {}),
          };
        })
        .filter(
          (x): x is { label: string; quantity: number; menuItemId?: string } =>
            x !== null,
        );
    }
    if (usesPostgresRepositories()) await knexOperationsReadRepository.updateCombo(id, rid, updates);
    else operationsRepository.updateCombo(id, rid, updates);
    broadcastRestaurantEvent(rid, 'menu:updated', { comboId: id });
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findComboById(id, rid)
      : operationsRepository.findComboById(id, rid);
  }

  async deleteCombo(auth: AuthContext, id: string) {
    const rid = auth.restaurantId!;
    const changes = usesPostgresRepositories()
      ? await knexOperationsReadRepository.deleteCombo(id, rid)
      : operationsRepository.deleteCombo(id, rid);
    if (!changes) throw new AppError(404, 'Formule introuvable.');
    broadcastRestaurantEvent(rid, 'menu:updated', { comboId: id });
  }

  // ── 2. Promotions & Happy Hour ───────────────────────────────────────────
  async listPromotions(rid: string) {
    this.ensureTenantId(rid);
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findPromotions(rid)
      : operationsRepository.findPromotions(rid);
  }

  async createPromotion(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const promoType =
      body?.promoType === 'HAPPY_HOUR' ? 'HAPPY_HOUR' : 'PROMO_CODE';
    const discountType =
      body?.discountType === 'FIXED_XOF' ? 'FIXED_XOF' : 'PERCENT';
    const discountValue = Math.round(Number(body?.discountValue || 0));

    if (name.length < 2 || !Number.isFinite(discountValue) || discountValue <= 0) {
      throw new AppError(400, 'Libellé et valeur de remise valides requis.');
    }
    if (discountType === 'PERCENT' && discountValue > 90) {
      throw new AppError(400, 'La remise en pourcentage ne peut excéder 90 %.');
    }

    let code: string | null = null;
    if (promoType === 'PROMO_CODE') {
      const rawCode = String(body?.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,24}$/.test(rawCode)) {
        throw new AppError(
          400,
          'Le code promo doit contenir 3 à 24 caractères alphanumériques.',
        );
      }
      code = rawCode;
    }

    const daysRaw = Array.isArray(body?.days)
      ? body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [0, 1, 2, 3, 4, 5, 6];
    const days = daysRaw.length > 0 ? daysRaw : [0, 1, 2, 3, 4, 5, 6];

    const startTime = /^\d{2}:\d{2}$/.test(String(body?.startTime || ''))
      ? String(body.startTime)
      : promoType === 'HAPPY_HOUR'
        ? '17:00'
        : '00:00';
    const endTime = /^\d{2}:\d{2}$/.test(String(body?.endTime || ''))
      ? String(body.endTime)
      : promoType === 'HAPPY_HOUR'
        ? '20:00'
        : '23:59';

    const maxUses =
      body?.maxUses !== undefined &&
      body.maxUses !== null &&
      body.maxUses !== '' &&
      Number.isFinite(Number(body.maxUses))
        ? Math.max(1, Math.floor(Number(body.maxUses)))
        : null;

    const promotionParams = {
      rid,
      name,
      code,
      promoType,
      discountType,
      discountValue,
      minOrderXof: Math.max(0, Math.round(Number(body?.minOrderXof || 0))),
      days,
      startTime,
      endTime,
      categoryId:
        typeof body?.categoryId === 'string' && body.categoryId.trim()
          ? body.categoryId.trim()
          : null,
      maxUses,
    };
    const id = usesPostgresRepositories()
      ? await knexOperationsReadRepository.createPromotion(promotionParams)
      : operationsRepository.createPromotion(promotionParams);

    const auditParams = {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'PROMOTION_CREATED',
      targetType: 'PROMOTION',
      targetId: id,
      details: `${promoType} ${code || name} (-${discountValue}${discountType === 'PERCENT' ? '%' : ' FCFA'})`,
    };
    if (usesPostgresRepositories()) await recordAuditWithKnex(getKnex(), auditParams);
    else recordAudit(getDb(), auditParams);
    broadcastRestaurantEvent(rid, 'menu:updated', { promoId: id });
    return (await this.listPromotions(rid)).find((p) => p.id === id);
  }

  async updatePromotion(auth: AuthContext, id: string, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const existing = (await this.listPromotions(rid)).find((p) => p.id === id);
    if (!existing) throw new AppError(404, 'Promotion introuvable.');
    const updates = {
      name: typeof body?.name === 'string' ? body.name.trim() : undefined,
      active: typeof body?.active === 'boolean' ? body.active : undefined,
      discountValue:
        body?.discountValue !== undefined && Number(body.discountValue) > 0
          ? Math.round(Number(body.discountValue))
          : undefined,
      startTime:
        typeof body?.startTime === 'string' && /^\d{2}:\d{2}$/.test(body.startTime)
          ? body.startTime
          : undefined,
      endTime:
        typeof body?.endTime === 'string' && /^\d{2}:\d{2}$/.test(body.endTime)
          ? body.endTime
          : undefined,
    };
    if (usesPostgresRepositories()) await knexOperationsReadRepository.updatePromotion(id, rid, updates);
    else operationsRepository.updatePromotion(id, rid, updates);
    broadcastRestaurantEvent(rid, 'menu:updated', { promoId: id });
  }

  async deletePromotion(auth: AuthContext, id: string) {
    const rid = auth.restaurantId!;
    const changes = usesPostgresRepositories()
      ? await knexOperationsReadRepository.deletePromotion(id, rid)
      : operationsRepository.deletePromotion(id, rid);
    if (!changes) throw new AppError(404, 'Promotion introuvable.');
    broadcastRestaurantEvent(rid, 'menu:updated', { promoId: id });
  }

  // ── 3. Cash Register & Z-Reports ─────────────────────────────────────────
  async getRegisterState(rid: string) {
    this.ensureTenantId(rid);
    const usePostgres = usesPostgresRepositories();
    const [open, history] = usePostgres
      ? await Promise.all([
          knexOperationsReadRepository.findOpenRegister(rid),
          knexOperationsReadRepository.findClosedRegisters(rid),
        ])
      : [
          operationsRepository.findOpenRegister(rid),
          operationsRepository.findClosedRegisters(rid),
        ];
    const liveTotals = open
      ? usePostgres
        ? await knexOperationsReadRepository.computeRegisterLiveTotals(
            rid, open.openedAt, open.openingFloatXof,
          )
        : operationsRepository.computeRegisterLiveTotals(
            rid, open.openedAt, open.openingFloatXof,
          )
      : null;
    return {
      activeSession: open,
      liveTotals,
      history,
      currentSession: open
        ? {
            ...open,
            ...liveTotals,
          }
        : null,
      zReports: history,
    };
  }

  async openRegister(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    if (usesPostgresRepositories()) {
      const openingFloatXof = Math.max(0, Math.round(Number(body?.openingFloatXof || 0)));
      const session = await getKnex().transaction(async (trx) => {
        const created = await knexOperationsReadRepository.openRegisterSession(trx, {
          rid, userId: auth.userId, userName: auth.fullName,
          openingFloatXof, notes: String(body?.notes || '').slice(0, 300),
        });
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: 'CASH_REGISTER_OPENED', targetType: 'CASH_REGISTER',
          targetId: created.id,
          details: `Fond de caisse initial : ${openingFloatXof} FCFA`,
        });
        return created;
      });
      broadcastRestaurantEvent(rid, 'register:updated', { status: 'OPEN', id: session.id });
      return session;
    }
    const existing = operationsRepository.findOpenRegister(rid);
    if (existing) {
      throw new AppError(
        409,
        `Une caisse est déjà ouverte par ${existing.openedByName}. Clôturez-la avant d’ouvrir une nouvelle session.`,
      );
    }
    const openingFloatXof = Math.max(
      0,
      Math.round(Number(body?.openingFloatXof || 0)),
    );
    const session = operationsRepository.openRegisterSession({
      rid,
      userId: auth.userId,
      userName: auth.fullName,
      openingFloatXof,
      notes: String(body?.notes || '').slice(0, 300),
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'CASH_REGISTER_OPENED',
      targetType: 'CASH_REGISTER',
      targetId: session.id,
      details: `Fond de caisse initial : ${openingFloatXof} FCFA`,
    });
    broadcastRestaurantEvent(rid, 'register:updated', { status: 'OPEN', id: session.id });
    return session;
  }

  async closeRegister(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    if (usesPostgresRepositories()) {
      const countedCashXof = Math.max(0, Math.round(Number(body?.countedCashXof || 0)));
      const countedMobileXof = Math.max(0, Math.round(Number(body?.countedMobileXof || 0)));
      const countedCardXof = Math.max(0, Math.round(Number(body?.countedCardXof || 0)));
      const report = await getKnex().transaction(async (trx) => {
        const open = await knexOperationsReadRepository.findOpenRegisterForUpdate(trx, rid);
        if (!open) throw new AppError(404, 'Aucune session de caisse ouverte à clôturer.');
        const closedRow = await trx('cash_register_sessions')
          .where({ restaurant_id: rid, status: 'CLOSED' })
          .count({ c: '*' }).first();
        const live = await knexOperationsReadRepository.computeRegisterLiveTotals(
          rid, open.openedAt, open.openingFloatXof, trx,
        );
        const totalExpected = live.expectedCashXof + live.expectedMobileXof + live.expectedCardXof;
        const totalCounted = countedCashXof + countedMobileXof + countedCardXof;
        const varianceXof = totalCounted - totalExpected;
        const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const zNumber = `Z-${ymd}-${String(Number(closedRow?.c || 0) + 1).padStart(3, '0')}`;
        const closed = await knexOperationsReadRepository.closeRegisterSession(trx, {
          id: open.id, rid, zNumber, userId: auth.userId, userName: auth.fullName,
          expectedCashXof: live.expectedCashXof,
          expectedMobileXof: live.expectedMobileXof,
          expectedCardXof: live.expectedCardXof,
          countedCashXof, countedMobileXof, countedCardXof,
          varianceXof, totalSalesXof: live.totalSalesXof,
          refundsXof: live.refundsXof, ordersCount: live.ordersCount,
          notes: String(body?.notes || open.notes || '').slice(0, 500),
        });
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: 'CASH_REGISTER_CLOSED', targetType: 'CASH_REGISTER',
          targetId: closed.id,
          details: `${zNumber} · Ventes ${live.totalSalesXof} FCFA · Écart ${varianceXof} FCFA`,
        });
        return { closed, zNumber };
      });
      broadcastRestaurantEvent(rid, 'register:updated', {
        status: 'CLOSED', zNumber: report.zNumber, id: report.closed.id,
      });
      return report.closed;
    }
    const open = operationsRepository.findOpenRegister(rid);
    if (!open) {
      throw new AppError(404, 'Aucune session de caisse ouverte à clôturer.');
    }

    const countedCashXof = Math.max(
      0,
      Math.round(Number(body?.countedCashXof || 0)),
    );
    const countedMobileXof = Math.max(
      0,
      Math.round(Number(body?.countedMobileXof || 0)),
    );
    const countedCardXof = Math.max(
      0,
      Math.round(Number(body?.countedCardXof || 0)),
    );

    const db = getDb();
    const closedCount = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM cash_register_sessions WHERE restaurant_id = ? AND status = 'CLOSED'",
        )
        .get(rid) as { c: number }
    ).c;

    const live = operationsRepository.computeRegisterLiveTotals(
      rid,
      open.openedAt,
      open.openingFloatXof,
    );
    const totalExpected =
      live.expectedCashXof + live.expectedMobileXof + live.expectedCardXof;
    const totalCounted = countedCashXof + countedMobileXof + countedCardXof;
    const varianceXof = totalCounted - totalExpected;

    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const zNumber = `Z-${ymd}-${String(closedCount + 1).padStart(3, '0')}`;

    const report = operationsRepository.closeRegisterSession({
      id: open.id,
      rid,
      zNumber,
      userId: auth.userId,
      userName: auth.fullName,
      expectedCashXof: live.expectedCashXof,
      expectedMobileXof: live.expectedMobileXof,
      expectedCardXof: live.expectedCardXof,
      countedCashXof,
      countedMobileXof,
      countedCardXof,
      varianceXof,
      totalSalesXof: live.totalSalesXof,
      refundsXof: live.refundsXof,
      ordersCount: live.ordersCount,
      notes: String(body?.notes || open.notes || '').slice(0, 500),
    });

    recordAudit(db, {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'CASH_REGISTER_CLOSED',
      targetType: 'CASH_REGISTER',
      targetId: report.id,
      details: `${zNumber} · Ventes ${live.totalSalesXof} FCFA · Écart ${varianceXof} FCFA`,
    });
    broadcastRestaurantEvent(rid, 'register:updated', {
      status: 'CLOSED',
      zNumber,
      id: report.id,
    });
    return report;
  }

  // ── 4. Table Calls ───────────────────────────────────────────────────────
  async listTableCalls(rid: string) {
    this.ensureTenantId(rid);
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findTableCalls(rid)
      : operationsRepository.findTableCalls(rid);
  }

  async acknowledgeTableCall(auth: AuthContext, callId: string) {
    const rid = auth.restaurantId!;
    const changes = usesPostgresRepositories()
      ? await knexOperationsReadRepository.acknowledgeTableCall(callId, rid, auth.fullName)
      : operationsRepository.acknowledgeTableCall(callId, rid, auth.fullName);
    if (!changes) throw new AppError(404, 'Appel de table introuvable.');
    broadcastRestaurantEvent(rid, 'table:call_ack', {
      id: callId,
      acknowledgedByName: auth.fullName,
    });
  }

  // ── 5. Loyalty History & Manual Adjustments ──────────────────────────────
  async getCustomerLoyaltyHistory(rid: string, customerId: string) {
    this.ensureTenantId(rid);
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findLoyaltyTransactions(rid, customerId)
      : operationsRepository.findLoyaltyTransactions(rid, customerId);
  }

  async adjustCustomerLoyalty(
    auth: AuthContext,
    customerId: string,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const delta = Math.round(Number(body?.pointsDelta || 0));
    const reason = String(body?.reason || 'Ajustement manuel caisse').trim();
    if (!Number.isFinite(delta) || delta === 0) {
      throw new AppError(400, 'Nombre de points non nul requis.');
    }

    const now = new Date().toISOString();
    if (usesPostgresRepositories()) {
      return getKnex().transaction(async (trx) => {
        const result = await knexOperationsReadRepository.adjustCustomerLoyalty(trx, {
          restaurantId: rid, customerId, pointsDelta: delta, reason, now,
        });
        if (!result) throw new AppError(404, 'Client introuvable.');
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: 'LOYALTY_ADJUSTED', targetType: 'CUSTOMER',
          targetId: customerId,
          details: `${result.fullName} : ${result.appliedDelta > 0 ? `+${result.appliedDelta}` : result.appliedDelta} pts (${reason})`,
        });
        return { customerId, loyaltyPoints: result.loyaltyPoints };
      });
    }

    const db = getDb();
    const cust = db
      .prepare(
        'SELECT id, loyalty_points, full_name FROM customers WHERE id = ? AND restaurant_id = ?',
      )
      .get(customerId, rid) as
      | { id: string; loyalty_points: number; full_name: string }
      | undefined;
    if (!cust) throw new AppError(404, 'Client introuvable.');

    const nextPoints = Math.max(0, Number(cust.loyalty_points || 0) + delta);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'UPDATE customers SET loyalty_points = ? WHERE id = ? AND restaurant_id = ?',
      ).run(nextPoints, customerId, rid);
      db.prepare(
        `INSERT INTO loyalty_transactions (
          id, restaurant_id, customer_id, order_id, points_delta, reason, created_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      ).run(generateId('ltx'), rid, customerId, delta, reason, now);
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'LOYALTY_ADJUSTED',
        targetType: 'CUSTOMER',
        targetId: customerId,
        details: `${cust.full_name} : ${delta > 0 ? `+${delta}` : delta} pts (${reason})`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors de la mise à jour de fidélité.');
    }
    return { customerId, loyaltyPoints: nextPoints };
  }

  // ── 6. Customer Reviews ──────────────────────────────────────────────────
  async listReviews(rid: string) {
    this.ensureTenantId(rid);
    const reviews = usesPostgresRepositories()
      ? await knexOperationsReadRepository.findCustomerReviews(rid)
      : operationsRepository.findCustomerReviews(rid);
    const total = reviews.length;
    const round1 = (val: number) => Math.round(val * 10) / 10;
    const avgRating =
      total > 0
        ? round1(reviews.reduce((s, r) => s + r.rating, 0) / total)
        : 0;
    const avgServiceRating =
      total > 0
        ? round1(reviews.reduce((s, r) => s + r.serviceRating, 0) / total)
        : 0;
    const avgFoodRating =
      total > 0
        ? round1(reviews.reduce((s, r) => s + r.foodRating, 0) / total)
        : 0;
    const avgSpeedRating =
      total > 0
        ? round1(reviews.reduce((s, r) => s + r.speedRating, 0) / total)
        : 0;

    const breakdown: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    const waiterMap = new Map<
      string,
      { waiterName: string; count: number; sumService: number; sumRating: number }
    >();
    for (const r of reviews) {
      if (breakdown[r.rating] !== undefined) breakdown[r.rating] += 1;
      const wName = r.waiterName.trim();
      if (wName) {
        const key = wName.toLowerCase();
        const cur = waiterMap.get(key) || {
          waiterName: wName,
          count: 0,
          sumService: 0,
          sumRating: 0,
        };
        cur.count += 1;
        cur.sumService += r.serviceRating;
        cur.sumRating += r.rating;
        waiterMap.set(key, cur);
      }
    }
    const waiterStats = Array.from(waiterMap.values())
      .map((w) => ({
        waiterName: w.waiterName,
        count: w.count,
        avgServiceRating: round1(w.sumService / w.count),
        avgRating: round1(w.sumRating / w.count),
      }))
      .sort((a, b) => b.avgServiceRating - a.avgServiceRating || b.count - a.count);

    return {
      reviews,
      summary: {
        total,
        avgRating,
        avgServiceRating,
        avgFoodRating,
        avgSpeedRating,
        breakdown,
        waiterStats,
      },
    };
  }

  async replyReview(auth: AuthContext, reviewId: string, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const reply = String(body?.reply || '').trim();
    if (reply.length < 2) {
      throw new AppError(400, 'Veuillez saisir une réponse client.');
    }
    const changes = usesPostgresRepositories()
      ? await knexOperationsReadRepository.replyToReview(reviewId, rid, reply)
      : operationsRepository.replyToReview(reviewId, rid, reply);
    if (!changes) throw new AppError(404, 'Avis client introuvable.');
    const auditParams = {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'CUSTOMER_REVIEW_REPLIED',
      targetType: 'REVIEW',
      targetId: reviewId,
    };
    if (usesPostgresRepositories()) await recordAuditWithKnex(getKnex(), auditParams);
    else recordAudit(getDb(), auditParams);
  }

  // ── 7. Inventory Counts & Typed Waste ────────────────────────────────────
  async listInventoryCounts(rid: string) {
    this.ensureTenantId(rid);
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findInventoryCounts(rid)
      : operationsRepository.findInventoryCounts(rid);
  }

  async createInventoryCount(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const rawSection = String(body?.stockSection || 'ALL').toUpperCase();
    const stockSection: 'ALL' | 'KITCHEN' | 'BEVERAGE' =
      rawSection === 'KITCHEN' || rawSection === 'BEVERAGE'
        ? rawSection
        : 'ALL';
    const title =
      typeof body?.title === 'string' && body.title.trim().length >= 2
        ? body.title.trim()
        : `Inventaire ${stockSection === 'BEVERAGE' ? 'Boissons' : stockSection === 'KITCHEN' ? 'Cuisine' : 'complet'} du ${new Date().toLocaleDateString('fr-FR')}`;
    const rawLines = Array.isArray(body?.lines) ? body.lines : [];
    if (rawLines.length === 0) {
      throw new AppError(400, 'Saisissez au moins une ligne de comptage.');
    }

    if (usesPostgresRepositories()) {
      const result = await getKnex().transaction(async (trx) => {
        const created = await knexOperationsReadRepository.createInventoryCount(trx, {
          restaurantId: rid, title, stockSection,
          notes: String(body?.notes || '').slice(0, 400),
          createdByName: auth.fullName, userId: auth.userId,
          lines: rawLines.map((raw) => {
            const line = (raw || {}) as { stockId?: unknown; countedQty?: unknown };
            return { stockId: String(line.stockId || '').trim(), countedQty: Number(line.countedQty) };
          }),
        });
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: 'INVENTORY_COUNT_VALIDATED', targetType: 'INVENTORY_COUNT',
          targetId: created.id,
          details: `${title} (${stockSection}) · Écart valorisé ${created.totalVarianceXof} FCFA`,
        });
        return created;
      });
      broadcastRestaurantEvent(rid, 'stock:updated', { inventoryCountId: result.id });
      return (await knexOperationsReadRepository.findInventoryCounts(rid)).find((item) => item.id === result.id);
    }

    const db = getDb();
    const countId = generateId('inv_cnt');
    const now = new Date().toISOString();
    let totalVarianceXof = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO inventory_counts (
          id, restaurant_id, title, stock_section, status, notes, total_variance_xof,
          created_by_name, validated_at, created_at
        ) VALUES (?, ?, ?, ?, 'VALIDATED', ?, 0, ?, ?, ?)`,
      ).run(
        countId,
        rid,
        title,
        stockSection,
        String(body?.notes || '').slice(0, 400),
        auth.fullName,
        now,
        now,
      );

      const insLine = db.prepare(
        `INSERT INTO inventory_count_lines (
          id, inventory_count_id, stock_id, stock_name, unit,
          expected_qty, counted_qty, variance_qty, unit_cost_xof, variance_xof
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updStock = db.prepare(
        'UPDATE stocks SET quantity = ?, updated_at = ? WHERE id = ? AND restaurant_id = ?',
      );
      const insMove = db.prepare(
        `INSERT INTO stock_movements (
          id, restaurant_id, stock_id, movement_type, quantity_delta,
          reason, waste_category, created_by_user_id, created_at
        ) VALUES (?, ?, ?, 'INVENTORY', ?, ?, '', ?, ?)`,
      );

      for (const raw of rawLines) {
        const line = (raw || {}) as { stockId?: unknown; countedQty?: unknown };
        const stockId = String(line.stockId || '').trim();
        const countedQty = Number(line.countedQty);
        if (!stockId || !Number.isFinite(countedQty) || countedQty < 0) {
          throw new AppError(400, 'Quantité comptée invalide.');
        }

        const stock = db
          .prepare(
            `SELECT id, name, unit, COALESCE(stock_section, 'KITCHEN') as stock_section, quantity, unit_cost_xof
             FROM stocks WHERE id = ? AND restaurant_id = ?`,
          )
          .get(stockId, rid) as
          | {
              id: string;
              name: string;
              unit: string;
              stock_section: string;
              quantity: number;
              unit_cost_xof: number;
            }
          | undefined;
        if (!stock) {
          throw new AppError(404, 'Ingrédient introuvable pour cet établissement.');
        }
        if (stockSection !== 'ALL' && stock.stock_section !== stockSection) {
          throw new AppError(
            400,
            `L’article « ${stock.name} » n’appartient pas à la section ${stockSection === 'BEVERAGE' ? 'Boissons' : 'Cuisine'}.`,
          );
        }

        const expectedQty = Number(stock.quantity || 0);
        const roundedCounted = Math.round(countedQty * 1000) / 1000;
        const varianceQty =
          Math.round((roundedCounted - expectedQty) * 1000) / 1000;
        const unitCost = Number(stock.unit_cost_xof || 0);
        const varianceXof = Math.round(varianceQty * unitCost);
        totalVarianceXof += varianceXof;

        insLine.run(
          generateId('icl'),
          countId,
          stock.id,
          stock.name,
          stock.unit,
          expectedQty,
          roundedCounted,
          varianceQty,
          unitCost,
          varianceXof,
        );

        if (varianceQty !== 0) {
          updStock.run(roundedCounted, now, stock.id, rid);
          insMove.run(
            generateId('smv'),
            rid,
            stock.id,
            varianceQty,
            `Inventaire : ${title}`,
            auth.userId,
            now,
          );
        }
      }

      db.prepare(
        'UPDATE inventory_counts SET total_variance_xof = ? WHERE id = ? AND restaurant_id = ?',
      ).run(totalVarianceXof, countId, rid);

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'INVENTORY_COUNT_VALIDATED',
        targetType: 'INVENTORY_COUNT',
        targetId: countId,
        details: `${title} (${stockSection}) · Écart valorisé ${totalVarianceXof} FCFA`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur validation session d’inventaire.');
    }

    broadcastRestaurantEvent(rid, 'stock:updated', { inventoryCountId: countId });
    return operationsRepository.findInventoryCounts(rid).find((c) => c.id === countId);
  }

  async recordTypedWaste(
    auth: AuthContext,
    stockId: string,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const qty = Number(body?.quantity);
    const cat = String(body?.wasteCategory || 'BROKEN').toUpperCase();
    const validCategories = ['EXPIRED', 'BROKEN', 'COMPLIMENTARY'];
    if (!validCategories.includes(cat)) {
      throw new AppError(
        400,
        'Catégorie de perte invalide (EXPIRED, BROKEN ou COMPLIMENTARY).',
      );
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new AppError(400, 'Quantité de perte positive requise.');
    }

    const labels: Record<string, string> = {
      EXPIRED: 'Péremption',
      BROKEN: 'Casse / Préparation ratée',
      COMPLIMENTARY: 'Offert client / Dégustation',
    };
    const reasonText = String(body?.reason || '').trim() || `Perte (${labels[cat]})`;
    if (usesPostgresRepositories()) {
      const result = await getKnex().transaction(async (trx) => {
        const created = await knexOperationsReadRepository.recordTypedWaste(trx, {
          restaurantId: rid, stockId, quantity: qty, category: cat,
          reason: reasonText, userId: auth.userId,
        });
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: 'STOCK_WASTE_RECORDED', targetType: 'STOCK',
          targetId: stockId,
          details: `${created.stockName} : -${Math.round(qty * 1000) / 1000} (${cat})`,
        });
        return created;
      });
      broadcastRestaurantEvent(rid, 'stock:updated', { stockId, quantity: result.quantity });
      return { stockId, quantity: result.quantity, wasteCategory: cat };
    }

    const db = getDb();
    const stock = db
      .prepare('SELECT id, name, quantity FROM stocks WHERE id = ? AND restaurant_id = ?')
      .get(stockId, rid) as
      | { id: string; name: string; quantity: number }
      | undefined;
    if (!stock) throw new AppError(404, 'Ingrédient introuvable.');

    const roundedDelta = Math.round(qty * 1000) / 1000;
    if (roundedDelta > Number(stock.quantity)) {
      throw new AppError(409, 'Stock insuffisant pour enregistrer cette perte.');
    }
    const nextQty = Math.round((Number(stock.quantity) - roundedDelta) * 1000) / 1000;
    const now = new Date().toISOString();
    const labels: Record<string, string> = {
      EXPIRED: 'Péremption',
      BROKEN: 'Casse / Préparation ratée',
      COMPLIMENTARY: 'Offert client / Dégustation',
    };
    const reasonText =
      String(body?.reason || '').trim() || `Perte (${labels[cat]})`;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'UPDATE stocks SET quantity = ?, updated_at = ? WHERE id = ? AND restaurant_id = ?',
      ).run(nextQty, now, stockId, rid);
      db.prepare(
        `INSERT INTO stock_movements (
          id, restaurant_id, stock_id, movement_type, quantity_delta,
          reason, waste_category, created_by_user_id, created_at
        ) VALUES (?, ?, ?, 'WASTE', ?, ?, ?, ?, ?)`,
      ).run(
        generateId('smv'),
        rid,
        stockId,
        -roundedDelta,
        reasonText,
        cat,
        auth.userId,
        now,
      );
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'STOCK_WASTE_RECORDED',
        targetType: 'STOCK',
        targetId: stockId,
        details: `${stock.name} : -${roundedDelta} (${cat})`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur enregistrement perte.');
    }

    broadcastRestaurantEvent(rid, 'stock:updated', { stockId, quantity: nextQty });
    return { stockId, quantity: nextQty, wasteCategory: cat };
  }

  // ── 8. Staff Shifts & PIN Time Clock ─────────────────────────────────────
  async listShiftsAndClocks(rid: string) {
    this.ensureTenantId(rid);
    const [shifts, clocks] = usesPostgresRepositories()
      ? await Promise.all([
          knexOperationsReadRepository.findStaffShifts(rid),
          knexOperationsReadRepository.findStaffTimeClocks(rid),
        ])
      : [operationsRepository.findStaffShifts(rid), operationsRepository.findStaffTimeClocks(rid)];
    const activeClocks = clocks.filter((c) => !c.clockOutAt);

    const hoursByUser = new Map<
      string,
      { userId: string; staffName: string; role: string; totalMinutes: number; sessionsCount: number }
    >();
    for (const c of clocks) {
      const entry = hoursByUser.get(c.userId) || {
        userId: c.userId,
        staffName: c.staffName,
        role: c.role,
        totalMinutes: 0,
        sessionsCount: 0,
      };
      entry.totalMinutes += Number(c.durationMinutes || 0);
      entry.sessionsCount += 1;
      hoursByUser.set(c.userId, entry);
    }

    return {
      shifts,
      clocks,
      activeClocks,
      hoursSummary: Array.from(hoursByUser.values()).map((h) => ({
        ...h,
        totalHours: Math.round((h.totalMinutes / 60) * 10) / 10,
      })),
    };
  }

  async createShift(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const shiftDate =
      typeof body?.shiftDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.shiftDate)
        ? body.shiftDate
        : '';
    const startTime =
      typeof body?.startTime === 'string' && /^\d{2}:\d{2}$/.test(body.startTime)
        ? body.startTime
        : '';
    const endTime =
      typeof body?.endTime === 'string' && /^\d{2}:\d{2}$/.test(body.endTime)
        ? body.endTime
        : '';
    if (!userId || !shiftDate || !startTime || !endTime) {
      throw new AppError(400, 'Employé, date et horaires (début/fin) requis.');
    }

    if (usesPostgresRepositories()) {
      return knexOperationsReadRepository.createShift({
        restaurantId: rid, userId, shiftDate, startTime, endTime,
        notes: String(body?.notes || '').slice(0, 200),
      });
    }

    const db = getDb();
    const member = db
      .prepare(
        `SELECT u.full_name, rm.role
         FROM restaurant_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.restaurant_id = ? AND rm.user_id = ? AND rm.status = 'ACTIVE'`,
      )
      .get(rid, userId) as { full_name: string; role: string } | undefined;
    if (!member) {
      throw new AppError(404, 'Employé introuvable dans cet établissement.');
    }

    const id = generateId('shf');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO staff_shifts (
        id, restaurant_id, user_id, staff_name, role, shift_date, start_time, end_time, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      rid,
      userId,
      member.full_name,
      member.role,
      shiftDate,
      startTime,
      endTime,
      String(body?.notes || '').slice(0, 200),
      now,
    );

    return operationsRepository.findStaffShifts(rid).find((s) => s.id === id);
  }

  async deleteShift(auth: AuthContext, shiftId: string) {
    const rid = auth.restaurantId!;
    const changes = usesPostgresRepositories()
      ? await knexOperationsReadRepository.deleteShift(rid, shiftId)
      : getDb()
          .prepare('DELETE FROM staff_shifts WHERE id = ? AND restaurant_id = ?')
          .run(shiftId, rid).changes;
    if (!changes) throw new AppError(404, 'Créneau introuvable.');
  }

  async clockWithPin(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const pin = typeof body?.pin === 'string' ? body.pin.trim() : '';
    if (!userId || !/^\d{4,6}$/.test(pin)) {
      throw new AppError(400, 'Employé et code PIN (4 à 6 chiffres) requis.');
    }

    const rateKey = `clock-pin:${rid}:${userId}`;
    assertWithinRateLimit(
      rateKey,
      10,
      15 * 60_000,
      'Trop de codes PIN erronés. Patientez 15 minutes.',
    );

    if (usesPostgresRepositories()) {
      const member = await knexOperationsReadRepository.findClockMember(rid, userId);
      if (!member || !member.pinHash || !bcrypt.compareSync(pin, String(member.pinHash))) {
        recordRateLimitHit(rateKey, 15 * 60_000);
        throw new AppError(401, 'Code PIN invalide pour cet employé.');
      }
      clearRateLimit(rateKey);
      if (member.userStatus !== 'ACTIVE' || member.memberStatus !== 'ACTIVE') {
        throw new AppError(403, 'Compte employé suspendu.');
      }
      const requested = String(body?.action || 'AUTO').toUpperCase();
      if (!['AUTO', 'IN', 'OUT'].includes(requested)) throw new AppError(400, 'Action de pointage invalide.');
      const result = await getKnex().transaction(async (trx) => {
        const clock = await knexOperationsReadRepository.toggleStaffClock(trx, {
          restaurantId: rid, userId, action: requested,
          notes: String(body?.notes || '').slice(0, 200),
          actorUserId: auth.userId, actorEmail: auth.email, actorRole: auth.role,
        });
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: clock.action === 'CLOCK_IN' ? 'STAFF_CLOCK_IN' : 'STAFF_CLOCK_OUT',
          targetType: 'TIME_CLOCK', targetId: clock.clock.id,
          details: clock.action === 'CLOCK_IN'
            ? `${clock.staffName} · Entrée pointée`
            : `${clock.staffName} · ${clock.durationMinutes} min`,
        });
        return clock;
      });
      return result;
    }

    const db = getDb();
    const member = db
      .prepare(
        `SELECT u.id as user_id, u.full_name, u.pin_hash, u.status as user_status,
                rm.role, rm.status as member_status
         FROM restaurant_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.restaurant_id = ? AND rm.user_id = ?`,
      )
      .get(rid, userId) as
      | {
          user_id: string;
          full_name: string;
          pin_hash: string | null;
          user_status: string;
          role: string;
          member_status: string;
        }
      | undefined;

    if (!member || !member.pin_hash || !bcrypt.compareSync(pin, member.pin_hash)) {
      recordRateLimitHit(rateKey, 15 * 60_000);
      throw new AppError(401, 'Code PIN invalide pour cet employé.');
    }
    clearRateLimit(rateKey);

    if (member.user_status !== 'ACTIVE' || member.member_status !== 'ACTIVE') {
      throw new AppError(403, 'Compte employé suspendu.');
    }

    const openClock = db
      .prepare(
        `SELECT id, clock_in_at FROM staff_time_clocks
         WHERE restaurant_id = ? AND user_id = ? AND clock_out_at IS NULL
         ORDER BY clock_in_at DESC LIMIT 1`,
      )
      .get(rid, userId) as { id: string; clock_in_at: string } | undefined;

    const requested = String(body?.action || 'AUTO').toUpperCase();
    const now = new Date();
    const nowIso = now.toISOString();

    if (requested === 'IN' && openClock) {
      throw new AppError(409, `${member.full_name} a déjà pointé son entrée.`);
    }
    if (requested === 'OUT' && !openClock) {
      throw new AppError(409, `${member.full_name} n’a pas de pointage d’entrée actif.`);
    }

    if (openClock) {
      const durationMinutes = Math.max(
        1,
        Math.round((now.getTime() - new Date(openClock.clock_in_at).getTime()) / 60_000),
      );
      db.prepare(
        `UPDATE staff_time_clocks
         SET clock_out_at = ?, duration_minutes = ?, notes = COALESCE(NULLIF(?, ''), notes)
         WHERE id = ? AND restaurant_id = ?`,
      ).run(
        nowIso,
        durationMinutes,
        String(body?.notes || '').slice(0, 200),
        openClock.id,
        rid,
      );
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'STAFF_CLOCK_OUT',
        targetType: 'TIME_CLOCK',
        targetId: openClock.id,
        details: `${member.full_name} · ${durationMinutes} min`,
      });
      return {
        action: 'CLOCK_OUT' as const,
        staffName: member.full_name,
        durationMinutes,
        clock: operationsRepository.findStaffTimeClocks(rid).find((c) => c.id === openClock.id),
      };
    }

    const id = generateId('clk');
    db.prepare(
      `INSERT INTO staff_time_clocks (
        id, restaurant_id, user_id, staff_name, role, clock_in_at, duration_minutes, notes
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      rid,
      userId,
      member.full_name,
      member.role,
      nowIso,
      String(body?.notes || '').slice(0, 200),
    );
    recordAudit(db, {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'STAFF_CLOCK_IN',
      targetType: 'TIME_CLOCK',
      targetId: id,
      details: `${member.full_name} · Entrée pointée`,
    });
    return {
      action: 'CLOCK_IN' as const,
      staffName: member.full_name,
      durationMinutes: 0,
      clock: operationsRepository.findStaffTimeClocks(rid).find((c) => c.id === id),
    };
  }

  // ── 9. B2B Proforma & Invoices ───────────────────────────────────────────
  async listB2bInvoices(rid: string) {
    this.ensureTenantId(rid);
    return usesPostgresRepositories()
      ? await knexOperationsReadRepository.findB2bInvoices(rid)
      : operationsRepository.findB2bInvoices(rid);
  }

  async createB2bInvoice(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const clientName =
      typeof body?.clientName === 'string' ? body.clientName.trim() : '';
    if (clientName.length < 2) {
      throw new AppError(400, 'Nom du contact ou client B2B requis.');
    }

    const rawItems = Array.isArray(body?.items) ? body.items : [];
    const items = rawItems
      .map((raw) => {
        const line = (raw || {}) as Record<string, unknown>;
        const description = String(line.description || '').trim();
        const quantity = Math.max(1, Math.round(Number(line.quantity || 1)));
        const unitPriceXof = Math.max(
          0,
          Math.round(Number(line.unitPriceXof || 0)),
        );
        if (!description) return null;
        return {
          description,
          quantity,
          unitPriceXof,
          lineTotalXof: quantity * unitPriceXof,
        };
      })
      .filter(
        (
          x,
        ): x is {
          description: string;
          quantity: number;
          unitPriceXof: number;
          lineTotalXof: number;
        } => x !== null,
      );

    if (items.length === 0) {
      throw new AppError(400, 'Ajoutez au moins une ligne de prestation.');
    }

    if (usesPostgresRepositories()) {
      const id = generateId('b2b');
      const docType = body?.docType === 'INVOICE' ? 'INVOICE' : 'PROFORMA';
      const created = await getKnex().transaction(async (trx) => {
        const resto = await trx('restaurants').select('tax_rate_percent').where({ id: rid }).first();
        if (!resto) throw new AppError(404, 'Établissement introuvable.');
        const taxRatePercent = body?.taxRatePercent !== undefined && Number.isFinite(Number(body.taxRatePercent))
          ? Math.max(0, Math.min(30, Number(body.taxRatePercent)))
          : Number(resto.tax_rate_percent ?? 18);
        const subtotalHtXof = items.reduce((sum, line) => sum + line.lineTotalXof, 0);
        const taxXof = Math.round((subtotalHtXof * taxRatePercent) / 100);
        const totalTtcXof = subtotalHtXof + taxXof;
        const status = ['DRAFT', 'SENT', 'ACCEPTED', 'PAID'].includes(String(body?.status))
          ? String(body.status) as B2bInvoice['status'] : 'SENT';
        const invoice = await knexOperationsReadRepository.createB2bInvoice(trx, {
          restaurantId: rid, id, docType, clientName,
          clientCompany: String(body?.clientCompany || '').trim(),
          clientTaxId: String(body?.clientTaxId || '').trim(),
          clientEmail: String(body?.clientEmail || '').trim(),
          clientPhone: String(body?.clientPhone || '').trim(),
          clientAddress: String(body?.clientAddress || '').trim(),
          items, subtotalHtXof, taxRatePercent, taxXof, totalTtcXof,
          status, dueDate: body?.dueDate ? String(body.dueDate) : null,
          notes: String(body?.notes || '').slice(0, 500),
        });
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: 'B2B_DOCUMENT_CREATED', targetType: 'B2B_INVOICE',
          targetId: id, details: `${invoice.invoiceNumber} · ${totalTtcXof} FCFA TTC`,
        });
        return invoice;
      });
      return created;
    }

    const db = getDb();
    const resto = db
      .prepare('SELECT tax_rate_percent FROM restaurants WHERE id = ?')
      .get(rid) as { tax_rate_percent: number } | undefined;

    const docType = body?.docType === 'INVOICE' ? 'INVOICE' : 'PROFORMA';
    const taxRatePercent =
      body?.taxRatePercent !== undefined && Number.isFinite(Number(body.taxRatePercent))
        ? Math.max(0, Math.min(30, Number(body.taxRatePercent)))
        : Number(resto?.tax_rate_percent ?? 18);

    const subtotalHtXof = items.reduce((s, l) => s + l.lineTotalXof, 0);
    const taxXof = Math.round((subtotalHtXof * taxRatePercent) / 100);
    const totalTtcXof = subtotalHtXof + taxXof;

    const existingCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM b2b_invoices WHERE restaurant_id = ?')
        .get(rid) as { c: number }
    ).c;
    const prefix = docType === 'INVOICE' ? 'FACT' : 'PROF';
    const year = new Date().getFullYear();
    const invoiceNumber = `${prefix}-${year}-${String(existingCount + 1).padStart(3, '0')}-${Math.floor(10 + Math.random() * 89)}`;
    const id = generateId('b2b');
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO b2b_invoices (
        id, restaurant_id, invoice_number, doc_type, client_name, client_company,
        client_tax_id, client_email, client_phone, client_address, items_json,
        subtotal_ht_xof, tax_rate_percent, tax_xof, total_ttc_xof,
        status, due_date, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      rid,
      invoiceNumber,
      docType,
      clientName,
      String(body?.clientCompany || '').trim(),
      String(body?.clientTaxId || '').trim(),
      String(body?.clientEmail || '').trim(),
      String(body?.clientPhone || '').trim(),
      String(body?.clientAddress || '').trim(),
      JSON.stringify(items),
      subtotalHtXof,
      taxRatePercent,
      taxXof,
      totalTtcXof,
      ['DRAFT', 'SENT', 'ACCEPTED', 'PAID'].includes(String(body?.status))
        ? String(body.status)
        : 'SENT',
      body?.dueDate ? String(body.dueDate) : null,
      String(body?.notes || '').slice(0, 500),
      now,
    );

    recordAudit(db, {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'B2B_DOCUMENT_CREATED',
      targetType: 'B2B_INVOICE',
      targetId: id,
      details: `${invoiceNumber} · ${totalTtcXof} FCFA TTC`,
    });

    return operationsRepository.findB2bInvoices(rid).find((d) => d.id === id);
  }

  async updateB2bInvoiceStatus(auth: AuthContext, id: string, status: unknown) {
    const rid = auth.restaurantId!;
    const clean = String(status || '').toUpperCase();
    if (!['DRAFT', 'SENT', 'ACCEPTED', 'PAID', 'CANCELLED'].includes(clean)) {
      throw new AppError(400, 'Statut B2B invalide.');
    }
    const changes = usesPostgresRepositories()
      ? await getKnex().transaction(async (trx) => {
          const updated = await knexOperationsReadRepository.updateB2bInvoiceStatus(rid, id, clean as B2bInvoice['status'], trx);
          if (updated) await recordAuditWithKnex(trx, {
            actorUserId: auth.userId, actorEmail: auth.email,
            actorRole: auth.role, restaurantId: rid,
            action: 'B2B_DOCUMENT_STATUS_UPDATED', targetType: 'B2B_INVOICE',
            targetId: id, details: `Nouveau statut : ${clean}`,
          });
          return updated;
        })
      : getDb()
          .prepare('UPDATE b2b_invoices SET status = ? WHERE id = ? AND restaurant_id = ?')
          .run(clean, id, rid).changes;
    if (!changes) throw new AppError(404, 'Document B2B introuvable.');
  }

  async convertProformaToInvoice(auth: AuthContext, proformaId: string) {
    const rid = auth.restaurantId!;
    if (usesPostgresRepositories()) {
      const converted = await getKnex().transaction(async (trx) => {
        const result = await knexOperationsReadRepository.convertProformaToInvoice(trx, {
          restaurantId: rid, proformaId, newId: generateId('b2b'),
        });
        await recordAuditWithKnex(trx, {
          actorUserId: auth.userId, actorEmail: auth.email,
          actorRole: auth.role, restaurantId: rid,
          action: 'B2B_PROFORMA_CONVERTED', targetType: 'B2B_INVOICE',
          targetId: result.invoice.id,
          details: `${result.sourceInvoiceNumber} -> ${result.invoice.invoiceNumber}`,
        });
        return result;
      });
      return { sourceProformaId: proformaId, invoice: converted.invoice };
    }
    const db = getDb();
    const existing = operationsRepository
      .findB2bInvoices(rid)
      .find((d) => d.id === proformaId);
    if (!existing) throw new AppError(404, 'Devis proforma introuvable.');
    if (existing.docType === 'INVOICE') {
      throw new AppError(409, 'Ce document est déjà une facture définitive.');
    }

    const existingCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM b2b_invoices WHERE restaurant_id = ?')
        .get(rid) as { c: number }
    ).c;
    const year = new Date().getFullYear();
    const invoiceNumber = `FACT-${year}-${String(existingCount + 1).padStart(3, '0')}-${Math.floor(10 + Math.random() * 89)}`;
    const newId = generateId('b2b');
    const now = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE b2b_invoices SET status = 'ACCEPTED' WHERE id = ? AND restaurant_id = ?`,
      ).run(proformaId, rid);

      db.prepare(
        `INSERT INTO b2b_invoices (
          id, restaurant_id, invoice_number, doc_type, client_name, client_company,
          client_tax_id, client_email, client_phone, client_address, items_json,
          subtotal_ht_xof, tax_rate_percent, tax_xof, total_ttc_xof,
          status, due_date, notes, created_at
        ) VALUES (?, ?, ?, 'INVOICE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?)`,
      ).run(
        newId,
        rid,
        invoiceNumber,
        existing.clientName,
        existing.clientCompany,
        existing.clientTaxId,
        existing.clientEmail,
        existing.clientPhone,
        existing.clientAddress,
        JSON.stringify(existing.items),
        existing.subtotalHtXof,
        existing.taxRatePercent,
        existing.taxXof,
        existing.totalTtcXof,
        existing.dueDate,
        `Convertie depuis ${existing.invoiceNumber}${existing.notes ? ` · ${existing.notes}` : ''}`,
        now,
      );

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'B2B_PROFORMA_CONVERTED',
        targetType: 'B2B_INVOICE',
        targetId: newId,
        details: `${existing.invoiceNumber} -> ${invoiceNumber}`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur conversion proforma en facture.');
    }

    return {
      sourceProformaId: proformaId,
      invoice: operationsRepository.findB2bInvoices(rid).find((d) => d.id === newId),
    };
  }

  // ── 10. Multi-Venue Branch Creation & Consolidated KPIs ──────────────────
  createBranchVenue(auth: AuthContext, body: Record<string, unknown>) {
    if (auth.role !== 'OWNER') {
      throw new AppError(
        403,
        'Seul le propriétaire peut créer un nouvel établissement rattaché.',
      );
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const city = typeof body?.city === 'string' && body.city.trim()
      ? body.city.trim()
      : 'Abidjan';
    const address = String(body?.address || '').trim();
    const phone = String(body?.phone || '').trim();
    if (name.length < 2) {
      throw new AppError(400, 'Nom du nouvel établissement requis.');
    }

    const db = getDb();
    const slugBase = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const slug = `${slugBase || 'site'}-${Math.floor(1000 + Math.random() * 9000)}`;
    const newRid = generateId('rest');
    const now = new Date().toISOString();
    const trialEnds = new Date(Date.now() + 14 * 86_400_000).toISOString();

    const plan = db
      .prepare('SELECT id FROM plans WHERE active = 1 ORDER BY price_monthly_xof ASC LIMIT 1')
      .get() as { id: string } | undefined;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO restaurants (
          id, name, slug, email, phone, address, city, country, currency, timezone, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Côte d''Ivoire', 'XOF', 'Africa/Abidjan', 'ACTIVE', ?)`,
      ).run(newRid, name, slug, auth.email, phone, address, city, now);

      db.prepare(
        `INSERT INTO restaurant_members (id, restaurant_id, user_id, role, custom_permissions_json, status, created_at)
         VALUES (?, ?, ?, 'OWNER', '[]', 'ACTIVE', ?)`,
      ).run(generateId('mem'), newRid, auth.userId, now);

      if (plan) {
        db.prepare(
          `INSERT INTO subscriptions (id, restaurant_id, plan_id, billing_cycle, status, trial_ends_at, current_period_start, current_period_end, created_at)
           VALUES (?, ?, ?, 'MONTHLY', 'ACTIVE', NULL, ?, ?, ?)`,
        ).run(generateId('sub'), newRid, plan.id, now, trialEnds, now);
      }

      const catK = generateId('cat');
      const catB = generateId('cat');
      db.prepare(
        `INSERT INTO menu_categories (id, restaurant_id, name, station, sort_order, active)
         VALUES (?, ?, 'Plats Principaux', 'KITCHEN', 1, 1)`,
      ).run(catK, newRid);
      db.prepare(
        `INSERT INTO menu_categories (id, restaurant_id, name, station, sort_order, active)
         VALUES (?, ?, 'Boissons & Bar', 'BAR', 2, 1)`,
      ).run(catB, newRid);

      for (let i = 1; i <= 4; i++) {
        const tblId = generateId('tbl');
        db.prepare(
          `INSERT INTO dining_tables (id, restaurant_id, zone, label, capacity, status, pos_x, pos_y, shape)
           VALUES (?, ?, 'Salle principale', ?, 4, 'AVAILABLE', ?, ?, 'ROUND')`,
        ).run(tblId, newRid, `Table 0${i}`, 60 + ((i - 1) % 2) * 180, 60 + Math.floor((i - 1) / 2) * 160);
        db.prepare(
          `INSERT INTO qr_codes (id, restaurant_id, table_id, token, version, status, created_at)
           VALUES (?, ?, ?, ?, 1, 'ACTIVE', ?)`,
        ).run(generateId('qr'), newRid, tblId, `${slug}-t${i}-v1`, now);
      }

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: newRid,
        action: 'BRANCH_VENUE_CREATED',
        targetType: 'RESTAURANT',
        targetId: newRid,
        details: `Nouveau point de vente rattaché : ${name} (${city})`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur création point de vente.');
    }

    return {
      restaurantId: newRid,
      name,
      slug,
      city,
      status: 'ACTIVE',
      role: 'OWNER',
    };
  }

  getConsolidatedOverview(auth: AuthContext) {
    const db = getDb();
    const venues = db
      .prepare(
        `SELECT r.id as restaurantId, r.name, r.slug, r.city, r.status, rm.role
         FROM restaurant_members rm
         JOIN restaurants r ON r.id = rm.restaurant_id
         WHERE rm.user_id = ? AND rm.status = 'ACTIVE' AND r.deleted_at IS NULL AND r.status != 'DELETED'
           AND rm.role IN ('OWNER', 'MANAGER')
         ORDER BY rm.created_at ASC`,
      )
      .all(auth.userId) as Array<{
      restaurantId: string;
      name: string;
      slug: string;
      city: string;
      status: string;
      role: string;
    }>;

    const perVenue = venues.map((v) => {
      const rev = db
        .prepare(
          `SELECT COALESCE(SUM(total_xof), 0) as totalRevenueXof,
                  COUNT(*) as ordersCount
           FROM orders WHERE restaurant_id = ? AND status != 'CANCELLED'`,
        )
        .get(v.restaurantId) as { totalRevenueXof: number; ordersCount: number };

      const tables = db
        .prepare(
          `SELECT COUNT(*) as totalTables,
                  SUM(CASE WHEN status = 'OCCUPIED' THEN 1 ELSE 0 END) as occupiedTables
           FROM dining_tables WHERE restaurant_id = ?`,
        )
        .get(v.restaurantId) as { totalTables: number; occupiedTables: number };

      const lowStocks = db
        .prepare(
          `SELECT COUNT(*) as c FROM stocks WHERE restaurant_id = ? AND quantity <= min_threshold`,
        )
        .get(v.restaurantId) as { c: number };

      return {
        ...v,
        totalRevenueXof: Number(rev?.totalRevenueXof || 0),
        ordersCount: Number(rev?.ordersCount || 0),
        totalTables: Number(tables?.totalTables || 0),
        occupiedTables: Number(tables?.occupiedTables || 0),
        lowStocksCount: Number(lowStocks?.c || 0),
      };
    });

    return {
      totals: {
        venuesCount: perVenue.length,
        totalRevenueXof: perVenue.reduce((s, v) => s + v.totalRevenueXof, 0),
        totalOrdersCount: perVenue.reduce((s, v) => s + v.ordersCount, 0),
        totalLowStocksCount: perVenue.reduce((s, v) => s + v.lowStocksCount, 0),
      },
      venues: perVenue,
    };
  }
}

export const operationsService = new OperationsService();
