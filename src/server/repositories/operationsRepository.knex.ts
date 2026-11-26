import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { getKnex } from '../knex.ts';
import { mapPromotionRow } from '../services/pricingEngine.ts';
import type { CustomerReview, MenuCombo, Promotion, TableCall } from '../../types/index.ts';

export class KnexOperationsReadRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  async findCombos(rid: string, onlyActive = false): Promise<MenuCombo[]> {
    let query = this.db('menu_combos').where({ restaurant_id: rid });
    if (onlyActive) query = query.where({ active: true });
    const rows = await query.orderBy('is_daily_special', 'desc').orderBy('created_at', 'desc');
    return rows.map((r) => ({
      id: String(r.id),
      restaurantId: String(r.restaurant_id),
      name: String(r.name),
      description: String(r.description || ''),
      priceXof: Number(r.price_xof),
      imageUrl: r.image_url ? String(r.image_url) : null,
      isDailySpecial: Boolean(r.is_daily_special),
      active: Boolean(r.active),
      items: JSON.parse(String(r.items_json || '[]')),
      createdAt: String(r.created_at),
    }));
  }

  async findComboById(id: string, rid: string): Promise<MenuCombo | null> {
    const r = await this.db('menu_combos').where({ id, restaurant_id: rid }).first();
    if (!r) return null;
    return {
      id: String(r.id),
      restaurantId: String(r.restaurant_id),
      name: String(r.name),
      description: String(r.description || ''),
      priceXof: Number(r.price_xof),
      imageUrl: r.image_url ? String(r.image_url) : null,
      isDailySpecial: Boolean(r.is_daily_special),
      active: Boolean(r.active),
      items: JSON.parse(String(r.items_json || '[]')),
      createdAt: String(r.created_at),
    };
  }

  private id(prefix: string) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  }

  async createCombo(params: {
    rid: string; name: string; description: string; priceXof: number;
    imageUrl: string | null; isDailySpecial: boolean;
    items: Array<{ label: string; quantity: number; menuItemId?: string }>;
  }): Promise<string> {
    const id = this.id('cmb');
    await this.db('menu_combos').insert({
      id, restaurant_id: params.rid, name: params.name,
      description: params.description, price_xof: params.priceXof,
      image_url: params.imageUrl, is_daily_special: params.isDailySpecial,
      items_json: JSON.stringify(params.items), active: true,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async updateCombo(
    id: string, rid: string,
    updates: {
      name?: string; description?: string; priceXof?: number;
      isDailySpecial?: boolean; active?: boolean;
      items?: Array<{ label: string; quantity: number; menuItemId?: string }>;
    },
  ): Promise<number> {
    const patch: Record<string, unknown> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.priceXof !== undefined) patch.price_xof = updates.priceXof;
    if (updates.isDailySpecial !== undefined) patch.is_daily_special = updates.isDailySpecial;
    if (updates.active !== undefined) patch.active = updates.active;
    if (updates.items !== undefined) patch.items_json = JSON.stringify(updates.items);
    if (!Object.keys(patch).length) return 0;
    return this.db('menu_combos').where({ id, restaurant_id: rid }).update(patch);
  }

  async deleteCombo(id: string, rid: string): Promise<number> {
    return this.db('menu_combos').where({ id, restaurant_id: rid }).del();
  }

  async createPromotion(params: {
    rid: string; name: string; code: string | null;
    promoType: 'HAPPY_HOUR' | 'PROMO_CODE';
    discountType: 'PERCENT' | 'FIXED_XOF'; discountValue: number;
    minOrderXof: number; days: number[]; startTime: string; endTime: string;
    categoryId: string | null; maxUses: number | null;
  }): Promise<string> {
    const id = this.id('prm');
    await this.db('promotions').insert({
      id, restaurant_id: params.rid, name: params.name, code: params.code,
      promo_type: params.promoType, discount_type: params.discountType,
      discount_value: params.discountValue, min_order_xof: params.minOrderXof,
      days_json: JSON.stringify(params.days), start_time: params.startTime,
      end_time: params.endTime, category_id: params.categoryId,
      max_uses: params.maxUses, uses_count: 0, active: true,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async updatePromotion(
    id: string, rid: string,
    updates: { name?: string; active?: boolean; discountValue?: number; startTime?: string; endTime?: string },
  ): Promise<number> {
    const patch: Record<string, unknown> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.active !== undefined) patch.active = updates.active;
    if (updates.discountValue !== undefined) patch.discount_value = updates.discountValue;
    if (updates.startTime !== undefined) patch.start_time = updates.startTime;
    if (updates.endTime !== undefined) patch.end_time = updates.endTime;
    if (!Object.keys(patch).length) return 0;
    return this.db('promotions').where({ id, restaurant_id: rid }).update(patch);
  }

  async deletePromotion(id: string, rid: string): Promise<number> {
    return this.db('promotions').where({ id, restaurant_id: rid }).del();
  }

  async findTableCalls(rid: string): Promise<TableCall[]> {
    const rows = await this.db('table_calls')
      .where({ restaurant_id: rid })
      .orderByRaw("CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END")
      .orderBy('created_at', 'desc')
      .limit(50);
    return rows.map((r) => ({
      id: String(r.id), restaurantId: String(r.restaurant_id),
      tableId: String(r.table_id), tableLabel: String(r.table_label),
      callType: r.call_type === 'BILL' ? 'BILL' : 'WAITER',
      note: String(r.note || ''),
      status: r.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'PENDING',
      acknowledgedByName: r.acknowledged_by_name ? String(r.acknowledged_by_name) : null,
      acknowledgedAt: r.acknowledged_at ? String(r.acknowledged_at) : null,
      createdAt: String(r.created_at),
    }));
  }

  async acknowledgeTableCall(id: string, rid: string, userName: string): Promise<number> {
    return this.db('table_calls')
      .where({ id, restaurant_id: rid })
      .update({
        status: 'ACKNOWLEDGED', acknowledged_by_name: userName,
        acknowledged_at: new Date().toISOString(),
      });
  }

  async findLoyaltyTransactions(rid: string, customerId: string) {
    return this.db('loyalty_transactions')
      .select({
        id: 'id', restaurantId: 'restaurant_id', customerId: 'customer_id',
        orderId: 'order_id', pointsDelta: 'points_delta',
        reason: 'reason', createdAt: 'created_at',
      })
      .where({ restaurant_id: rid, customer_id: customerId })
      .orderBy('created_at', 'desc')
      .limit(50);
  }

  async findCustomerReviews(rid: string): Promise<CustomerReview[]> {
    const rows = await this.db('customer_reviews')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc')
      .limit(100);
    return rows.map((r) => {
      const rating = Number(r.rating);
      return {
        id: String(r.id), restaurantId: String(r.restaurant_id),
        orderId: r.order_id ? String(r.order_id) : null,
        orderNumber: String(r.order_number || ''),
        tableLabel: String(r.table_label || ''),
        customerName: String(r.customer_name || 'Client'), rating,
        serviceRating: Number(r.service_rating || rating),
        foodRating: Number(r.food_rating || rating),
        speedRating: Number(r.speed_rating || rating),
        waiterName: String(r.waiter_name || ''),
        channel: String(r.channel || 'QR_ORDER'),
        comment: String(r.comment || ''), reply: String(r.reply || ''),
        createdAt: String(r.created_at),
      };
    });
  }

  async replyToReview(id: string, rid: string, reply: string): Promise<number> {
    return this.db('customer_reviews')
      .where({ id, restaurant_id: rid })
      .update({ reply });
  }

  async findPromotions(rid: string): Promise<Promotion[]> {
    const rows = await this.db('promotions')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc');
    return rows.map(mapPromotionRow);
  }
}

export const knexOperationsReadRepository = new KnexOperationsReadRepository();
