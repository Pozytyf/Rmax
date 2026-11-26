import type { Knex } from 'knex';
import { getKnex } from '../knex.ts';
import { mapPromotionRow } from '../services/pricingEngine.ts';
import type { MenuCombo, Promotion } from '../../types/index.ts';

export class KnexOperationsReadRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  async findCombos(rid: string, onlyActive = false): Promise<MenuCombo[]> {
    let query = this.db('menu_combos').where({ restaurant_id: rid });
    if (onlyActive) query = query.where({ active: 1 });
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

  async findPromotions(rid: string): Promise<Promotion[]> {
    const rows = await this.db('promotions')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc');
    return rows.map(mapPromotionRow);
  }
}

export const knexOperationsReadRepository = new KnexOperationsReadRepository();
