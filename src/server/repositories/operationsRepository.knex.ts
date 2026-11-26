import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { AppError } from '../services/errors.ts';
import { getKnex } from '../knex.ts';
import { mapPromotionRow } from '../services/pricingEngine.ts';
import type { B2bInvoice, CashRegisterSession, CustomerReview, InventoryCount, MenuCombo, Promotion, StaffShift, StaffTimeClock, TableCall } from '../../types/index.ts';

export class KnexOperationsReadRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  private id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  }

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

  async findComboById(id: string, rid: string, executor: Knex | Knex.Transaction = this.db): Promise<MenuCombo | null> {
    const r = await executor('menu_combos').where({ id, restaurant_id: rid }).first();
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
      image_url: params.imageUrl, is_daily_special: params.isDailySpecial ? 1 : 0,
      items_json: JSON.stringify(params.items), active: 1,
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
    if (updates.isDailySpecial !== undefined) patch.is_daily_special = updates.isDailySpecial ? 1 : 0;
    if (updates.active !== undefined) patch.active = updates.active ? 1 : 0;
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
      max_uses: params.maxUses, uses_count: 0, active: 1,
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
    if (updates.active !== undefined) patch.active = updates.active ? 1 : 0;
    if (updates.discountValue !== undefined) patch.discount_value = updates.discountValue;
    if (updates.startTime !== undefined) patch.start_time = updates.startTime;
    if (updates.endTime !== undefined) patch.end_time = updates.endTime;
    if (!Object.keys(patch).length) return 0;
    return this.db('promotions').where({ id, restaurant_id: rid }).update(patch);
  }

  async deletePromotion(id: string, rid: string): Promise<number> {
    return this.db('promotions').where({ id, restaurant_id: rid }).del();
  }

  private mapRegisterRow(r: Record<string, unknown>): CashRegisterSession {
    return {
      id: String(r.id), restaurantId: String(r.restaurant_id),
      zNumber: String(r.z_number || ''),
      openedByUserId: r.opened_by_user_id ? String(r.opened_by_user_id) : null,
      openedByName: String(r.opened_by_name || ''),
      openingFloatXof: Number(r.opening_float_xof || 0),
      openedAt: String(r.opened_at),
      closedByUserId: r.closed_by_user_id ? String(r.closed_by_user_id) : null,
      closedByName: r.closed_by_name ? String(r.closed_by_name) : null,
      closedAt: r.closed_at ? String(r.closed_at) : null,
      status: r.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
      expectedCashXof: Number(r.expected_cash_xof || 0),
      expectedMobileXof: Number(r.expected_mobile_xof || 0),
      expectedCardXof: Number(r.expected_card_xof || 0),
      countedCashXof: Number(r.counted_cash_xof || 0),
      countedMobileXof: Number(r.counted_mobile_xof || 0),
      countedCardXof: Number(r.counted_card_xof || 0),
      varianceXof: Number(r.variance_xof || 0),
      totalSalesXof: Number(r.total_sales_xof || 0),
      refundsXof: Number(r.refunds_xof || 0),
      ordersCount: Number(r.orders_count || 0),
      notes: String(r.notes || ''),
    };
  }

  async findOpenRegister(rid: string): Promise<CashRegisterSession | null> {
    const row = await this.db('cash_register_sessions')
      .where({ restaurant_id: rid, status: 'OPEN' })
      .orderBy('opened_at', 'desc')
      .first();
    return row ? this.mapRegisterRow(row) : null;
  }

  async findClosedRegisters(rid: string, limit = 30): Promise<CashRegisterSession[]> {
    const rows = await this.db('cash_register_sessions')
      .where({ restaurant_id: rid, status: 'CLOSED' })
      .orderBy('closed_at', 'desc')
      .limit(Math.max(1, Math.min(100, Math.floor(limit))));
    return rows.map((row) => this.mapRegisterRow(row));
  }

  async computeRegisterLiveTotals(
    rid: string, sinceIso: string, openingFloatXof: number,
    executor: Knex | Knex.Transaction = this.db,
  ) {
    const payRows = await executor('payments')
      .where({ restaurant_id: rid })
      .where('created_at', '>=', sinceIso)
      .select('method', 'status')
      .sum({ total: 'amount_xof' })
      .groupBy('method', 'status');
    let cashSales = 0;
    let mobileSales = 0;
    let cardSales = 0;
    let cashRefunds = 0;
    let totalRefunds = 0;
    for (const row of payRows) {
      const amount = Number(row.total || 0);
      if (row.status === 'REFUNDED') {
        totalRefunds += amount;
        if (row.method === 'CASH') cashRefunds += amount;
        continue;
      }
      if (row.status !== 'PAID') continue;
      if (row.method === 'CASH') cashSales += amount;
      else if (row.method === 'CARD') cardSales += amount;
      else mobileSales += amount;
    }
    const ordersRow = await executor('orders')
      .where({ restaurant_id: rid })
      .where('created_at', '>=', sinceIso)
      .whereNot('status', 'CANCELLED')
      .count({ c: '*' })
      .first();
    return {
      expectedCashXof: openingFloatXof + cashSales - cashRefunds,
      expectedMobileXof: mobileSales,
      expectedCardXof: cardSales,
      totalSalesXof: cashSales + mobileSales + cardSales,
      refundsXof: totalRefunds,
      ordersCount: Number(ordersRow?.c || 0),
    };
  }


  async findOpenRegisterForUpdate(trx: Knex.Transaction, rid: string): Promise<CashRegisterSession | null> {
    const row = await trx('cash_register_sessions')
      .where({ restaurant_id: rid, status: 'OPEN' })
      .orderBy('opened_at', 'desc')
      .forUpdate()
      .first();
    return row ? this.mapRegisterRow(row) : null;
  }

  async openRegisterSession(
    trx: Knex.Transaction,
    params: { rid: string; userId: string; userName: string; openingFloatXof: number; notes: string },
  ): Promise<CashRegisterSession> {
    await trx('restaurants').select('id').where({ id: params.rid }).forUpdate().first();
    const existing = await trx('cash_register_sessions')
      .where({ restaurant_id: params.rid, status: 'OPEN' })
      .first();
    if (existing) {
      throw new AppError(409, 'Une caisse est déjà ouverte pour cet établissement.');
    }
    const id = this.id('reg');
    const now = new Date().toISOString();
    await trx('cash_register_sessions').insert({
      id, restaurant_id: params.rid, z_number: '',
      opened_by_user_id: params.userId, opened_by_name: params.userName,
      opening_float_xof: params.openingFloatXof, opened_at: now,
      status: 'OPEN', notes: params.notes,
    });
    const row = await trx('cash_register_sessions').where({ id, restaurant_id: params.rid }).first();
    if (!row) throw new Error('La session de caisse créée est introuvable.');
    return this.mapRegisterRow(row);
  }

  async closeRegisterSession(
    trx: Knex.Transaction,
    params: {
      id: string; rid: string; zNumber: string; userId: string; userName: string;
      expectedCashXof: number; expectedMobileXof: number; expectedCardXof: number;
      countedCashXof: number; countedMobileXof: number; countedCardXof: number;
      varianceXof: number; totalSalesXof: number; refundsXof: number;
      ordersCount: number; notes: string;
    },
  ): Promise<CashRegisterSession> {
    const updated = await trx('cash_register_sessions')
      .where({ id: params.id, restaurant_id: params.rid, status: 'OPEN' })
      .update({
        status: 'CLOSED', z_number: params.zNumber,
        closed_by_user_id: params.userId, closed_by_name: params.userName,
        closed_at: new Date().toISOString(),
        expected_cash_xof: params.expectedCashXof,
        expected_mobile_xof: params.expectedMobileXof,
        expected_card_xof: params.expectedCardXof,
        counted_cash_xof: params.countedCashXof,
        counted_mobile_xof: params.countedMobileXof,
        counted_card_xof: params.countedCardXof,
        variance_xof: params.varianceXof,
        total_sales_xof: params.totalSalesXof,
        refunds_xof: params.refundsXof,
        orders_count: params.ordersCount, notes: params.notes,
      });
    if (updated !== 1) throw new AppError(409, 'La session de caisse a déjà été clôturée ou modifiée.');
    const row = await trx('cash_register_sessions')
      .where({ id: params.id, restaurant_id: params.rid }).first();
    if (!row) throw new Error('La session de caisse clôturée est introuvable.');
    return this.mapRegisterRow(row);
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

  async adjustCustomerLoyalty(
    trx: Knex.Transaction,
    params: { restaurantId: string; customerId: string; pointsDelta: number; reason: string; now: string },
  ) {
    const customer = await trx('customers')
      .select('id', 'full_name', 'loyalty_points')
      .where({ id: params.customerId, restaurant_id: params.restaurantId })
      .forUpdate()
      .first();
    if (!customer) return null;
    const currentPoints = Number(customer.loyalty_points || 0);
    const nextPoints = Math.max(0, currentPoints + params.pointsDelta);
    const appliedDelta = nextPoints - currentPoints;
    if (appliedDelta === 0) {
      throw new AppError(409, 'Le solde de points ne permet pas cet ajustement.');
    }
    await trx('customers')
      .where({ id: params.customerId, restaurant_id: params.restaurantId })
      .update({ loyalty_points: nextPoints });
    await trx('loyalty_transactions').insert({
      id: this.id('ltx'), restaurant_id: params.restaurantId,
      customer_id: params.customerId, order_id: null,
      points_delta: appliedDelta, reason: params.reason, created_at: params.now,
    });
    return {
      fullName: String(customer.full_name || ''),
      loyaltyPoints: nextPoints,
      appliedDelta,
    };
  }

  async createInventoryCount(
    trx: Knex.Transaction,
    params: {
      restaurantId: string; title: string; stockSection: 'ALL' | 'KITCHEN' | 'BEVERAGE';
      notes: string; createdByName: string; userId: string | null;
      lines: Array<{ stockId: string; countedQty: number }>;
    },
  ): Promise<{ id: string; totalVarianceXof: number }> {
    const id = this.id('inv_cnt');
    const now = new Date().toISOString();
    let totalVarianceXof = 0;
    await trx('inventory_counts').insert({
      id, restaurant_id: params.restaurantId, title: params.title,
      stock_section: params.stockSection, status: 'VALIDATED',
      notes: params.notes, total_variance_xof: 0,
      created_by_name: params.createdByName, validated_at: now, created_at: now,
    });
    for (const line of params.lines) {
      if (!line.stockId || !Number.isFinite(line.countedQty) || line.countedQty < 0) {
        throw new AppError(400, 'Quantité comptée invalide.');
      }
      const stock = await trx('stocks')
        .select('id', 'name', 'unit', 'stock_section', 'quantity', 'unit_cost_xof')
        .where({ id: line.stockId, restaurant_id: params.restaurantId })
        .forUpdate()
        .first();
      if (!stock) throw new AppError(404, 'Ingrédient introuvable pour cet établissement.');
      const section = String(stock.stock_section || 'KITCHEN');
      if (params.stockSection !== 'ALL' && section !== params.stockSection) {
        throw new AppError(400, `L’article « ${String(stock.name)} » n’appartient pas à la section ${params.stockSection === 'BEVERAGE' ? 'Boissons' : 'Cuisine'}.`);
      }
      const expectedQty = Number(stock.quantity || 0);
      const countedQty = Math.round(line.countedQty * 1000) / 1000;
      const varianceQty = Math.round((countedQty - expectedQty) * 1000) / 1000;
      const unitCostXof = Number(stock.unit_cost_xof || 0);
      const varianceXof = Math.round(varianceQty * unitCostXof);
      totalVarianceXof += varianceXof;
      await trx('inventory_count_lines').insert({
        id: this.id('icl'), inventory_count_id: id,
        stock_id: String(stock.id), stock_name: String(stock.name),
        unit: String(stock.unit), expected_qty: expectedQty,
        counted_qty: countedQty, variance_qty: varianceQty,
        unit_cost_xof: unitCostXof, variance_xof: varianceXof,
      });
      if (varianceQty !== 0) {
        await trx('stocks').where({ id: stock.id, restaurant_id: params.restaurantId })
          .update({ quantity: countedQty, updated_at: now });
        await trx('stock_movements').insert({
          id: this.id('smv'), restaurant_id: params.restaurantId,
          stock_id: String(stock.id), movement_type: 'INVENTORY',
          quantity_delta: varianceQty, reason: `Inventaire : ${params.title}`,
          waste_category: '', created_by_user_id: params.userId, created_at: now,
        });
      }
    }
    await trx('inventory_counts')
      .where({ id, restaurant_id: params.restaurantId })
      .update({ total_variance_xof: totalVarianceXof });
    return { id, totalVarianceXof };
  }

  async recordTypedWaste(
    trx: Knex.Transaction,
    params: { restaurantId: string; stockId: string; quantity: number; category: string; reason: string; userId: string | null },
  ): Promise<{ quantity: number; stockName: string }> {
    const stock = await trx('stocks')
      .select('id', 'name', 'quantity')
      .where({ id: params.stockId, restaurant_id: params.restaurantId })
      .forUpdate()
      .first();
    if (!stock) throw new AppError(404, 'Ingrédient introuvable.');
    const delta = Math.round(params.quantity * 1000) / 1000;
    const current = Number(stock.quantity || 0);
    if (delta > current) {
      throw new AppError(409, `Stock insuffisant pour enregistrer cette perte : disponible ${current}, demandé ${delta}.`);
    }
    const next = Math.round((current - delta) * 1000) / 1000;
    const now = new Date().toISOString();
    const updated = await trx('stocks')
      .where({ id: params.stockId, restaurant_id: params.restaurantId })
      .where('quantity', '>=', delta)
      .update({ quantity: next, updated_at: now });
    if (updated !== 1) throw new AppError(409, 'Le stock a changé pendant l’enregistrement de la perte. Réessayez.');
    await trx('stock_movements').insert({
      id: this.id('smv'), restaurant_id: params.restaurantId,
      stock_id: params.stockId, movement_type: 'WASTE',
      quantity_delta: -delta, reason: params.reason,
      waste_category: params.category, created_by_user_id: params.userId,
      created_at: now,
    });
    return { quantity: next, stockName: String(stock.name) };
  }

  async findClockMember(restaurantId: string, userId: string) {
    const row = await this.db('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .select({
        userId: 'u.id', fullName: 'u.full_name', pinHash: 'u.pin_hash',
        userStatus: 'u.status', role: 'rm.role', memberStatus: 'rm.status',
      })
      .where('rm.restaurant_id', restaurantId)
      .where('rm.user_id', userId)
      .first();
    return row || null;
  }

  async toggleStaffClock(
    trx: Knex.Transaction,
    params: {
      restaurantId: string; userId: string; action: string;
      notes: string; actorUserId: string | null; actorEmail: string; actorRole: string;
    },
  ): Promise<{ action: 'CLOCK_IN' | 'CLOCK_OUT'; staffName: string; durationMinutes: number; clock: StaffTimeClock }> {
    // Serialize clock actions per employee, including the first clock-in where no clock row exists yet.
    const user = await trx('users').select('id').where({ id: params.userId }).forUpdate().first();
    if (!user) throw new AppError(404, 'Employé introuvable.');
    const member = await trx('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .select({ fullName: 'u.full_name', userStatus: 'u.status', role: 'rm.role', memberStatus: 'rm.status' })
      .where('rm.restaurant_id', params.restaurantId)
      .where('rm.user_id', params.userId)
      .first();
    if (!member || member.userStatus !== 'ACTIVE' || member.memberStatus !== 'ACTIVE') {
      throw new AppError(403, 'Compte employé suspendu ou non rattaché à cet établissement.');
    }
    const open = await trx('staff_time_clocks')
      .where({ restaurant_id: params.restaurantId, user_id: params.userId })
      .whereNull('clock_out_at')
      .orderBy('clock_in_at', 'desc')
      .forUpdate()
      .first();
    if (params.action === 'IN' && open) throw new AppError(409, `${String(member.fullName)} a déjà pointé son entrée.`);
    if (params.action === 'OUT' && !open) throw new AppError(409, `${String(member.fullName)} n’a pas de pointage d’entrée actif.`);
    const now = new Date();
    const nowIso = now.toISOString();
    let action: 'CLOCK_IN' | 'CLOCK_OUT';
    let id: string;
    let durationMinutes = 0;
    if (open) {
      id = String(open.id);
      durationMinutes = Math.max(1, Math.round((now.getTime() - new Date(String(open.clock_in_at)).getTime()) / 60000));
      await trx('staff_time_clocks')
        .where({ id, restaurant_id: params.restaurantId, user_id: params.userId })
        .whereNull('clock_out_at')
        .update({
          clock_out_at: nowIso, duration_minutes: durationMinutes,
          notes: params.notes || String(open.notes || ''),
        });
      action = 'CLOCK_OUT';
    } else {
      id = this.id('clk');
      await trx('staff_time_clocks').insert({
        id, restaurant_id: params.restaurantId, user_id: params.userId,
        staff_name: String(member.fullName), role: String(member.role),
        clock_in_at: nowIso, duration_minutes: 0, notes: params.notes,
      });
      action = 'CLOCK_IN';
    }
    const row = await trx('staff_time_clocks')
      .where({ id, restaurant_id: params.restaurantId, user_id: params.userId }).first();
    if (!row) throw new Error('Pointage introuvable après écriture.');
    return {
      action, staffName: String(member.fullName), durationMinutes,
      clock: {
        id: String(row.id), restaurantId: String(row.restaurant_id),
        userId: String(row.user_id), staffName: String(row.staff_name),
        role: String(row.role) as StaffTimeClock['role'],
        clockInAt: String(row.clock_in_at),
        clockOutAt: row.clock_out_at ? String(row.clock_out_at) : null,
        durationMinutes: Number(row.duration_minutes || 0), notes: String(row.notes || ''),
      },
    };
  }

  async createB2bInvoice(
    trx: Knex.Transaction,
    params: {
      restaurantId: string; id: string; docType: 'PROFORMA' | 'INVOICE';
      clientName: string; clientCompany: string; clientTaxId: string;
      clientEmail: string; clientPhone: string; clientAddress: string;
      items: B2bInvoice['items']; subtotalHtXof: number; taxRatePercent: number;
      taxXof: number; totalTtcXof: number; status: B2bInvoice['status'];
      dueDate: string | null; notes: string;
    },
  ): Promise<B2bInvoice> {
    const restaurant = await trx('restaurants').select('id').where({ id: params.restaurantId }).forUpdate().first();
    if (!restaurant) throw new AppError(404, 'Établissement introuvable.');
    const sequenceRow = await trx('b2b_invoices')
      .where({ restaurant_id: params.restaurantId, doc_type: params.docType })
      .whereRaw('EXTRACT(YEAR FROM CAST(created_at AS timestamp)) = ?', [new Date().getFullYear()])
      .count({ count: '*' }).first();
    const sequence = Number(sequenceRow?.count || 0) + 1;
    const prefix = params.docType === 'INVOICE' ? 'FACT' : 'PROF';
    const tenantCode = params.restaurantId.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
    const invoiceNumber = `${prefix}-${new Date().getFullYear()}-${tenantCode}-${String(sequence).padStart(4, '0')}`;
    const now = new Date().toISOString();
    await trx('b2b_invoices').insert({
      id: params.id, restaurant_id: params.restaurantId,
      invoice_number: invoiceNumber, doc_type: params.docType,
      client_name: params.clientName, client_company: params.clientCompany,
      client_tax_id: params.clientTaxId, client_email: params.clientEmail,
      client_phone: params.clientPhone, client_address: params.clientAddress,
      items_json: JSON.stringify(params.items), subtotal_ht_xof: params.subtotalHtXof,
      tax_rate_percent: params.taxRatePercent, tax_xof: params.taxXof,
      total_ttc_xof: params.totalTtcXof, status: params.status,
      due_date: params.dueDate, notes: params.notes, created_at: now,
    });
    const row = await trx('b2b_invoices').where({ id: params.id, restaurant_id: params.restaurantId }).first();
    if (!row) throw new Error('Document B2B créé introuvable.');
    return this.mapB2bInvoiceRow(row);
  }

  async updateB2bInvoiceStatus(restaurantId: string, id: string, status: B2bInvoice['status'], trx: Knex | Knex.Transaction = this.db): Promise<number> {
    return trx('b2b_invoices').where({ id, restaurant_id: restaurantId }).update({ status });
  }

  async convertProformaToInvoice(
    trx: Knex.Transaction,
    params: { restaurantId: string; proformaId: string; newId: string },
  ): Promise<{ invoice: B2bInvoice; sourceInvoiceNumber: string }> {
    const restaurant = await trx('restaurants').select('id').where({ id: params.restaurantId }).forUpdate().first();
    if (!restaurant) throw new AppError(404, 'Établissement introuvable.');
    const source = await trx('b2b_invoices')
      .where({ id: params.proformaId, restaurant_id: params.restaurantId })
      .forUpdate().first();
    if (!source) throw new AppError(404, 'Devis proforma introuvable.');
    if (source.doc_type === 'INVOICE') throw new AppError(409, 'Ce document est déjà une facture définitive.');
    const sequenceRow = await trx('b2b_invoices')
      .where({ restaurant_id: params.restaurantId, doc_type: 'INVOICE' })
      .whereRaw('EXTRACT(YEAR FROM CAST(created_at AS timestamp)) = ?', [new Date().getFullYear()])
      .count({ count: '*' }).first();
    const sequence = Number(sequenceRow?.count || 0) + 1;
    const tenantCode = params.restaurantId.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
    const invoiceNumber = `FACT-${new Date().getFullYear()}-${tenantCode}-${String(sequence).padStart(4, '0')}`;
    const now = new Date().toISOString();
    await trx('b2b_invoices').where({ id: params.proformaId, restaurant_id: params.restaurantId, doc_type: 'PROFORMA' })
      .update({ status: 'ACCEPTED' });
    await trx('b2b_invoices').insert({
      id: params.newId, restaurant_id: params.restaurantId,
      invoice_number: invoiceNumber, doc_type: 'INVOICE',
      client_name: source.client_name, client_company: source.client_company,
      client_tax_id: source.client_tax_id, client_email: source.client_email,
      client_phone: source.client_phone, client_address: source.client_address,
      items_json: source.items_json, subtotal_ht_xof: source.subtotal_ht_xof,
      tax_rate_percent: source.tax_rate_percent, tax_xof: source.tax_xof,
      total_ttc_xof: source.total_ttc_xof, status: 'SENT',
      due_date: source.due_date,
      notes: `Convertie depuis ${String(source.invoice_number)}${source.notes ? ` · ${String(source.notes)}` : ''}`,
      created_at: now,
    });
    const invoiceRow = await trx('b2b_invoices')
      .where({ id: params.newId, restaurant_id: params.restaurantId }).first();
    if (!invoiceRow) throw new Error('Facture convertie introuvable.');
    return { invoice: this.mapB2bInvoiceRow(invoiceRow), sourceInvoiceNumber: String(source.invoice_number) };
  }

  async findInventoryCounts(rid: string): Promise<InventoryCount[]> {
    const headers = await this.db('inventory_counts')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc')
      .limit(30);
    if (!headers.length) return [];
    const headerIds = headers.map((row) => String(row.id));
    const lineRows = await this.db('inventory_count_lines as l')
      .join('inventory_counts as h', 'h.id', 'l.inventory_count_id')
      .leftJoin('stocks as s', function () {
        this.on('s.id', '=', 'l.stock_id')
          .andOn('s.restaurant_id', '=', 'h.restaurant_id');
      })
      .select({
        id: 'l.id', inventoryCountId: 'l.inventory_count_id',
        stockId: 'l.stock_id', stockName: 'l.stock_name',
        stockSection: 's.stock_section', unit: 'l.unit',
        expectedQty: 'l.expected_qty', countedQty: 'l.counted_qty',
        varianceQty: 'l.variance_qty', unitCostXof: 'l.unit_cost_xof',
        varianceXof: 'l.variance_xof',
      })
      .where('h.restaurant_id', rid)
      .whereIn('l.inventory_count_id', headerIds)
      .orderBy('l.stock_name', 'asc');
    const byHeader = new Map<string, InventoryCount['lines']>();
    for (const row of lineRows) {
      const key = String(row.inventoryCountId);
      const list = byHeader.get(key) || [];
      list.push({
        id: String(row.id), inventoryCountId: key,
        stockId: String(row.stockId), stockName: String(row.stockName),
        stockSection: row.stockSection === 'BEVERAGE' ? 'BEVERAGE' : 'KITCHEN',
        unit: String(row.unit), expectedQty: Number(row.expectedQty || 0),
        countedQty: Number(row.countedQty || 0),
        varianceQty: Number(row.varianceQty || 0),
        unitCostXof: Number(row.unitCostXof || 0),
        varianceXof: Number(row.varianceXof || 0),
      });
      byHeader.set(key, list);
    }
    return headers.map((h) => ({
      id: String(h.id), restaurantId: String(h.restaurant_id),
      title: String(h.title),
      stockSection: h.stock_section === 'KITCHEN' || h.stock_section === 'BEVERAGE'
        ? h.stock_section : 'ALL',
      status: 'VALIDATED',
      notes: String(h.notes || ''),
      totalVarianceXof: Number(h.total_variance_xof || 0),
      createdByName: String(h.created_by_name || ''),
      validatedAt: h.validated_at ? String(h.validated_at) : null,
      createdAt: String(h.created_at),
      lines: byHeader.get(String(h.id)) || [],
    }));
  }

  async createShift(params: {
    restaurantId: string; userId: string; shiftDate: string;
    startTime: string; endTime: string; notes: string;
  }): Promise<StaffShift> {
    const member = await this.db('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .select({ fullName: 'u.full_name', role: 'rm.role' })
      .where('rm.restaurant_id', params.restaurantId)
      .where('rm.user_id', params.userId)
      .where('rm.status', 'ACTIVE')
      .where('u.status', 'ACTIVE')
      .first();
    if (!member) throw new AppError(404, 'Employé introuvable dans cet établissement.');
    const id = this.id('shf');
    const now = new Date().toISOString();
    await this.db('staff_shifts').insert({
      id, restaurant_id: params.restaurantId, user_id: params.userId,
      staff_name: member.fullName, role: member.role,
      shift_date: params.shiftDate, start_time: params.startTime,
      end_time: params.endTime, notes: params.notes, created_at: now,
    });
    const created = (await this.findStaffShifts(params.restaurantId)).find((row) => row.id === id);
    if (!created) throw new Error('Le créneau créé est introuvable.');
    return created;
  }

  async deleteShift(restaurantId: string, shiftId: string): Promise<number> {
    return this.db('staff_shifts')
      .where({ id: shiftId, restaurant_id: restaurantId })
      .del();
  }

  async findStaffShifts(rid: string): Promise<StaffShift[]> {
    const rows = await this.db('staff_shifts')
      .select({
        id: 'id', restaurantId: 'restaurant_id', userId: 'user_id',
        staffName: 'staff_name', role: 'role', shiftDate: 'shift_date',
        startTime: 'start_time', endTime: 'end_time', notes: 'notes',
        createdAt: 'created_at',
      })
      .where({ restaurant_id: rid })
      .orderBy('shift_date', 'desc')
      .orderBy('start_time', 'asc')
      .limit(120);
    return rows as StaffShift[];
  }

  async findStaffTimeClocks(rid: string): Promise<StaffTimeClock[]> {
    const rows = await this.db('staff_time_clocks')
      .select({
        id: 'id', restaurantId: 'restaurant_id', userId: 'user_id',
        staffName: 'staff_name', role: 'role', clockInAt: 'clock_in_at',
        clockOutAt: 'clock_out_at', durationMinutes: 'duration_minutes',
        notes: 'notes',
      })
      .where({ restaurant_id: rid })
      .orderBy('clock_in_at', 'desc')
      .limit(120);
    return rows as StaffTimeClock[];
  }

  private mapB2bInvoiceRow(r: Record<string, unknown>): B2bInvoice {
    return {
      id: String(r.id), restaurantId: String(r.restaurant_id),
      invoiceNumber: String(r.invoice_number),
      docType: r.doc_type === 'INVOICE' ? 'INVOICE' : 'PROFORMA',
      clientName: String(r.client_name), clientCompany: String(r.client_company || ''),
      clientTaxId: String(r.client_tax_id || ''), clientEmail: String(r.client_email || ''),
      clientPhone: String(r.client_phone || ''), clientAddress: String(r.client_address || ''),
      items: JSON.parse(String(r.items_json || '[]')),
      subtotalHtXof: Number(r.subtotal_ht_xof || 0),
      taxRatePercent: Number(r.tax_rate_percent || 18),
      taxXof: Number(r.tax_xof || 0), totalTtcXof: Number(r.total_ttc_xof || 0),
      status: String(r.status || 'DRAFT') as B2bInvoice['status'],
      dueDate: r.due_date ? String(r.due_date) : null,
      notes: String(r.notes || ''), createdAt: String(r.created_at),
    };
  }

  async findB2bInvoices(rid: string): Promise<B2bInvoice[]> {
    const rows = await this.db('b2b_invoices')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc')
      .limit(100);
    return rows.map((row) => this.mapB2bInvoiceRow(row));
  }

  async createBranchVenue(
    trx: Knex.Transaction,
    params: {
      sourceRestaurantId: string; restaurantId: string; name: string; slug: string;
      email: string; phone: string; address: string; city: string;
      ownerUserId: string; planId: string | null; trialEndsAt: string; now: string;
    },
  ): Promise<void> {
    const owner = await trx('restaurant_members')
      .where({
        restaurant_id: params.sourceRestaurantId,
        user_id: params.ownerUserId, role: 'OWNER', status: 'ACTIVE',
      })
      .forUpdate().first();
    if (!owner) throw new AppError(403, 'Le compte ne possède pas les droits de propriétaire sur cet établissement.');
    const user = await trx('users').select('id').where({ id: params.ownerUserId, status: 'ACTIVE' }).first();
    if (!user) throw new AppError(403, 'Compte propriétaire inactif.');
    await trx('tenants').insert({
      id: params.restaurantId, name: params.name, slug: params.slug,
      email: params.email, phone: params.phone, address: params.address,
      city: params.city, country: "Côte d'Ivoire", currency: 'XOF',
      timezone: 'Africa/Abidjan', status: 'ACTIVE', created_at: params.now,
    });
    await trx('restaurants').insert({
      id: params.restaurantId, name: params.name, slug: params.slug,
      email: params.email, phone: params.phone, address: params.address,
      city: params.city, country: "Côte d'Ivoire", currency: 'XOF',
      timezone: 'Africa/Abidjan', status: 'ACTIVE', created_at: params.now,
    });
    await trx('restaurant_members').insert({
      id: this.id('mem'), restaurant_id: params.restaurantId,
      user_id: params.ownerUserId, role: 'OWNER',
      custom_permissions_json: '[]', status: 'ACTIVE', created_at: params.now,
    });
    if (params.planId) {
      await trx('subscriptions').insert({
        id: this.id('sub'), restaurant_id: params.restaurantId,
        plan_id: params.planId, billing_cycle: 'MONTHLY',
        status: 'ACTIVE', trial_ends_at: null,
        current_period_start: params.now, current_period_end: params.trialEndsAt,
        created_at: params.now,
      });
    }
    await trx('menu_categories').insert([
      { id: this.id('cat'), restaurant_id: params.restaurantId, name: 'Plats Principaux', station: 'KITCHEN', sort_order: 1, active: 1 },
      { id: this.id('cat'), restaurant_id: params.restaurantId, name: 'Boissons & Bar', station: 'BAR', sort_order: 2, active: 1 },
    ]);
    const tables: Array<Record<string, unknown>> = [];
    const qrCodes: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 4; i++) {
      const tableId = this.id('tbl');
      tables.push({
        id: tableId, restaurant_id: params.restaurantId,
        zone: 'Salle principale', label: `Table 0${i}`, capacity: 4,
        status: 'AVAILABLE', pos_x: 60 + ((i - 1) % 2) * 180,
        pos_y: 60 + Math.floor((i - 1) / 2) * 160, shape: 'ROUND',
      });
      qrCodes.push({
        id: this.id('qr'), restaurant_id: params.restaurantId,
        table_id: tableId, token: `${params.slug}-t${i}-v1`,
        version: 1, status: 'ACTIVE', created_at: params.now,
      });
    }
    await trx('dining_tables').insert(tables);
    await trx('qr_codes').insert(qrCodes);
  }

  async findConsolidatedOverview(userId: string) {
    const venues = await this.db('restaurant_members as rm')
      .join('restaurants as r', 'r.id', 'rm.restaurant_id')
      .select({
        restaurantId: 'r.id', name: 'r.name', slug: 'r.slug',
        city: 'r.city', status: 'r.status', role: 'rm.role',
      })
      .where('rm.user_id', userId)
      .where('rm.status', 'ACTIVE')
      .whereIn('rm.role', ['OWNER', 'MANAGER'])
      .whereNull('r.deleted_at')
      .whereNot('r.status', 'DELETED')
      .orderBy('rm.created_at', 'asc');
    if (!venues.length) {
      return {
        totals: { venuesCount: 0, totalRevenueXof: 0, totalOrdersCount: 0, totalLowStocksCount: 0 },
        venues: [],
      };
    }
    const ids = venues.map((v) => String(v.restaurantId));
    const [revenueRows, tableRows, stockRows] = await Promise.all([
      this.db('orders').select('restaurant_id')
        .sum({ totalRevenueXof: 'total_xof' }).count({ ordersCount: '*' })
        .whereIn('restaurant_id', ids).whereNot('status', 'CANCELLED').groupBy('restaurant_id'),
      this.db('dining_tables').select('restaurant_id')
        .count({ totalTables: '*' })
        .sum({ occupiedTables: this.db.raw("CASE WHEN status = 'OCCUPIED' THEN 1 ELSE 0 END") })
        .whereIn('restaurant_id', ids).groupBy('restaurant_id'),
      this.db('stocks').select('restaurant_id')
        .count({ lowStocksCount: '*' })
        .whereRaw('quantity <= min_threshold')
        .whereIn('restaurant_id', ids).groupBy('restaurant_id'),
    ]);
    const byId = <T extends { restaurant_id: string }>(rows: T[]) =>
      new Map(rows.map((row) => [String(row.restaurant_id), row]));
    const revenues = byId(revenueRows);
    const tables = byId(tableRows);
    const stocks = byId(stockRows);
    const result = venues.map((venue) => {
      const revenue = revenues.get(String(venue.restaurantId));
      const table = tables.get(String(venue.restaurantId));
      const stock = stocks.get(String(venue.restaurantId));
      return {
        ...venue,
        totalRevenueXof: Number(revenue?.totalRevenueXof || 0),
        ordersCount: Number(revenue?.ordersCount || 0),
        totalTables: Number(table?.totalTables || 0),
        occupiedTables: Number(table?.occupiedTables || 0),
        lowStocksCount: Number(stock?.lowStocksCount || 0),
      };
    });
    return {
      totals: {
        venuesCount: result.length,
        totalRevenueXof: result.reduce((sum, venue) => sum + venue.totalRevenueXof, 0),
        totalOrdersCount: result.reduce((sum, venue) => sum + venue.ordersCount, 0),
        totalLowStocksCount: result.reduce((sum, venue) => sum + venue.lowStocksCount, 0),
      },
      venues: result,
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
