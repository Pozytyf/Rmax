import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { AppError } from '../services/errors.ts';
import { getKnex } from '../knex.ts';
import { mapPromotionRow } from '../services/pricingEngine.ts';
import type { B2bInvoice, CashRegisterSession, CustomerReview, InventoryCount, MenuCombo, Promotion, StaffShift, StaffTimeClock, TableCall } from '../../types/index.ts';

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

  async findB2bInvoices(rid: string): Promise<B2bInvoice[]> {
    const rows = await this.db('b2b_invoices')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc')
      .limit(100);
    return rows.map((r) => ({
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
    }));
  }

  async findPromotions(rid: string): Promise<Promotion[]> {
    const rows = await this.db('promotions')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc');
    return rows.map(mapPromotionRow);
  }
}

export const knexOperationsReadRepository = new KnexOperationsReadRepository();
