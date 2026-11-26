import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { AppError } from './errors.ts';
import { isScheduleActiveNow, mapPromotionRow, normalizePhoneKey } from './pricingEngine.ts';
import { knexPublicRepository } from '../repositories/publicRepository.knex.ts';

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

export async function applyOrderPromoAndLoyaltyDiscountsKnex(params: {
  trx: Knex.Transaction;
  restaurantId: string;
  grossXof: number;
  manualDiscountXof?: number;
  promoCode?: string;
  customerPhone?: string;
  loyaltyPointsToUse?: number;
  orderId: string;
  orderNumber: string;
  nowIso: string;
}) {
  let discount = Math.max(0, Math.round(Number(params.manualDiscountXof || 0)));
  let appliedPromoCode = '';
  const rawCode = String(params.promoCode || '').trim().toUpperCase();

  if (rawCode) {
    const promoRow = await params.trx('promotions')
      .where({ restaurant_id: params.restaurantId, promo_type: 'PROMO_CODE', active: 1 })
      .whereRaw('UPPER(code) = ?', [rawCode])
      .forUpdate()
      .first();
    if (!promoRow) throw new AppError(400, `Code promo « ${rawCode} » invalide ou expiré.`);
    const promo = mapPromotionRow(promoRow);
    if (!isScheduleActiveNow(promo.days, promo.startTime, promo.endTime)) {
      throw new AppError(400, `Le code promo « ${rawCode} » n’est pas actif sur ce créneau.`);
    }
    if (promo.maxUses !== null && promo.usesCount >= promo.maxUses) {
      throw new AppError(400, `Le code promo « ${rawCode} » a atteint son nombre maximum d’utilisations.`);
    }
    if (params.grossXof < promo.minOrderXof) {
      throw new AppError(400, `Minimum de commande requis pour « ${rawCode} » : ${promo.minOrderXof} FCFA.`);
    }
    const promoDiscount = promo.discountType === 'PERCENT'
      ? Math.round((params.grossXof * promo.discountValue) / 100)
      : promo.discountValue;
    discount += Math.max(0, promoDiscount);
    appliedPromoCode = rawCode;
    await params.trx('promotions').where({ id: promo.id }).increment('uses_count', 1);
  }

  let loyaltyPointsUsed = 0;
  const requestedPts = Math.max(0, Math.floor(Number(params.loyaltyPointsToUse || 0)));
  if (requestedPts > 0) {
    const cleanPhone = normalizePhoneKey(String(params.customerPhone || ''));
    if (cleanPhone.length < 6) {
      throw new AppError(400, 'Numéro de téléphone requis pour utiliser vos points de fidélité.');
    }
    const info = await knexPublicRepository.resolveLoyaltyForPhone(
      params.restaurantId, cleanPhone, params.trx,
    );
    if (!info || !info.loyaltyEnabled) {
      throw new AppError(400, 'Le programme de fidélité n’est pas activé sur cet établissement.');
    }
    if (!info.customer || info.customer.loyaltyPoints < requestedPts) {
      throw new AppError(400, 'Solde de points fidélité insuffisant pour ce numéro.');
    }
    loyaltyPointsUsed = requestedPts;
    discount += requestedPts * info.xofPerPoint;
    const updated = await params.trx('customers')
      .where({ id: info.customer.id, restaurant_id: params.restaurantId })
      .where('loyalty_points', '>=', requestedPts)
      .decrement('loyalty_points', requestedPts);
    if (updated !== 1) {
      throw new AppError(409, 'Le solde de points a changé. Veuillez réessayer.');
    }
    await params.trx('loyalty_transactions').insert({
      id: makeId('ltx'), restaurant_id: params.restaurantId,
      customer_id: info.customer.id, order_id: params.orderId,
      points_delta: -loyaltyPointsUsed,
      reason: `Échange remise · ${params.orderNumber}`,
      created_at: params.nowIso,
    });
  }

  return {
    discountXof: Math.min(params.grossXof, discount),
    appliedPromoCode,
    loyaltyPointsUsed,
  };
}

export async function awardLoyaltyPointsOnPaidOrderKnex(
  trx: Knex.Transaction,
  restaurantId: string,
  orderId: string,
): Promise<number> {
  const order = await trx('orders')
    .select('id', 'order_number', 'customer_name', 'customer_phone', 'total_xof', 'status', 'loyalty_points_earned')
    .where({ id: orderId, restaurant_id: restaurantId })
    .forUpdate()
    .first();
  if (!order || order.status !== 'PAID') return 0;
  if (Number(order.loyalty_points_earned || 0) > 0) return Number(order.loyalty_points_earned);

  const cleanPhone = normalizePhoneKey(String(order.customer_phone || ''));
  if (cleanPhone.length < 6) return 0;
  const info = await knexPublicRepository.resolveLoyaltyForPhone(restaurantId, cleanPhone, trx);
  if (!info || !info.loyaltyEnabled) return 0;

  const earned = Math.floor((Number(order.total_xof || 0) / 1000) * info.pointsPer1000Xof);
  if (earned <= 0) return 0;
  const now = new Date().toISOString();
  let customerId = info.customer?.id;

  if (!customerId) {
    customerId = makeId('cust');
    await trx('customers').insert({
      id: customerId, restaurant_id: restaurantId,
      full_name: String(order.customer_name || 'Client').slice(0, 80),
      phone: cleanPhone, email: '', loyalty_points: earned,
      total_spent_xof: Number(order.total_xof || 0), visits_count: 1,
      preferences: '', created_at: now,
    });
  } else {
    await trx('customers').where({ id: customerId, restaurant_id: restaurantId })
      .increment('loyalty_points', earned)
      .increment('total_spent_xof', Number(order.total_xof || 0))
      .increment('visits_count', 1);
  }

  await trx('loyalty_transactions').insert({
    id: makeId('ltx'), restaurant_id: restaurantId, customer_id: customerId,
    order_id: orderId, points_delta: earned,
    reason: `Commande payée · ${order.order_number}`, created_at: now,
  });
  await trx('orders').where({ id: orderId, restaurant_id: restaurantId })
    .update({ loyalty_points_earned: earned });
  return earned;
}
