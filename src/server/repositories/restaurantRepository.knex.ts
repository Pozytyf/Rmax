import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { getKnex } from '../knex.ts';
import { AppError } from '../services/errors.ts';

export class KnexRestaurantStockRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  private id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  }

  async countCategories(rid: string, executor: Knex | Knex.Transaction = this.db): Promise<number> {
    const row = await executor('menu_categories').where({ restaurant_id: rid }).count({ count: '*' }).first();
    return Number(row?.count || 0);
  }

  async createCategory(rid: string, name: string, station: string, sortOrder: number, executor: Knex | Knex.Transaction = this.db): Promise<string> {
    const id = this.id('cat');
    await executor('menu_categories').insert({
      id, restaurant_id: rid, name, station, sort_order: sortOrder, active: 1,
    });
    return id;
  }

  async findCategory(categoryId: string, rid: string, executor: Knex | Knex.Transaction = this.db) {
    const row = await executor('menu_categories')
      .select({ id: 'id', name: 'name', station: 'station', sortOrder: 'sort_order', active: 'active' })
      .where({ id: categoryId, restaurant_id: rid }).first();
    return row || null;
  }

  async updateCategory(
    categoryId: string, rid: string,
    updates: { name?: string; station?: string; sortOrder?: number; active?: boolean },
    executor: Knex | Knex.Transaction = this.db,
  ): Promise<number> {
    const patch: Record<string, unknown> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.station !== undefined) patch.station = updates.station;
    if (updates.sortOrder !== undefined) patch.sort_order = updates.sortOrder;
    if (updates.active !== undefined) patch.active = updates.active ? 1 : 0;
    if (!Object.keys(patch).length) return 0;
    return executor('menu_categories').where({ id: categoryId, restaurant_id: rid }).update(patch);
  }

  async countItemsInCategory(categoryId: string, rid: string, executor: Knex | Knex.Transaction = this.db): Promise<number> {
    const row = await executor('menu_items').where({ category_id: categoryId, restaurant_id: rid }).count({ count: '*' }).first();
    return Number(row?.count || 0);
  }

  async deleteCategory(categoryId: string, rid: string, executor: Knex | Knex.Transaction = this.db): Promise<number> {
    return executor('menu_categories').where({ id: categoryId, restaurant_id: rid }).del();
  }

  async createMenuItem(params: {
    rid: string; categoryId: string; name: string; description: string;
    priceXof: number; costPriceXof: number; imageUrl: string | null;
    available: boolean; sortOrder: number; optionsJson: string; optionGroupsJson?: string;
  }, executor: Knex | Knex.Transaction = this.db): Promise<string> {
    const category = await this.findCategory(params.categoryId, params.rid, executor);
    if (!category) throw new AppError(404, 'Catégorie introuvable pour cet établissement.');
    const id = this.id('itm');
    await executor('menu_items').insert({
      id, restaurant_id: params.rid, category_id: params.categoryId,
      name: params.name, description: params.description,
      price_xof: params.priceXof, cost_price_xof: params.costPriceXof,
      image_url: params.imageUrl, available: params.available ? 1 : 0,
      sort_order: params.sortOrder, options_json: params.optionsJson,
      option_groups_json: params.optionGroupsJson || '[]',
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async findMenuItemById(itemId: string, rid: string, executor: Knex | Knex.Transaction = this.db) {
    const row = await executor('menu_items')
      .select('id', 'name').where({ id: itemId, restaurant_id: rid }).first();
    return row || null;
  }

  async countOrderReferencesForMenuItem(itemId: string, rid: string, executor: Knex | Knex.Transaction = this.db): Promise<number> {
    const row = await executor('order_items as oi')
      .join('orders as o', 'o.id', 'oi.order_id')
      .where('o.restaurant_id', rid)
      .where('oi.menu_item_id', itemId)
      .count({ count: '*' }).first();
    return Number(row?.count || 0);
  }

  async deleteMenuItem(itemId: string, rid: string, executor: Knex | Knex.Transaction = this.db): Promise<number> {
    return executor('menu_items').where({ id: itemId, restaurant_id: rid }).del();
  }

  async updateMenuItem(
    itemId: string, rid: string,
    updates: {
      categoryId?: string; available?: boolean; priceXof?: number;
      costPriceXof?: number; name?: string; description?: string;
      imageUrl?: string | null; sortOrder?: number;
      optionsJson?: string; optionGroupsJson?: string;
    }, executor: Knex | Knex.Transaction = this.db,
  ): Promise<number> {
    const patch: Record<string, unknown> = {};
    if (updates.categoryId !== undefined) {
      const category = await this.findCategory(updates.categoryId, rid, executor);
      if (!category) throw new AppError(404, 'Catégorie introuvable pour cet établissement.');
      patch.category_id = updates.categoryId;
    }
    if (updates.available !== undefined) patch.available = updates.available ? 1 : 0;
    if (updates.priceXof !== undefined) patch.price_xof = updates.priceXof;
    if (updates.costPriceXof !== undefined) patch.cost_price_xof = updates.costPriceXof;
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.imageUrl !== undefined) patch.image_url = updates.imageUrl;
    if (updates.sortOrder !== undefined) patch.sort_order = updates.sortOrder;
    if (updates.optionsJson !== undefined) patch.options_json = updates.optionsJson;
    if (updates.optionGroupsJson !== undefined) patch.option_groups_json = updates.optionGroupsJson;
    if (!Object.keys(patch).length) return 0;
    return executor('menu_items').where({ id: itemId, restaurant_id: rid }).update(patch);
  }

  async findStockById(stockId: string, rid: string, executor: Knex | Knex.Transaction = this.db) {
    const row = await executor('stocks')
      .select({
        id: 'id', name: 'name', unit: 'unit', stockSection: 'stock_section',
        quantity: 'quantity', min_threshold: 'min_threshold',
        unit_cost_xof: 'unit_cost_xof', supplier_name: 'supplier_name',
      })
      .where({ id: stockId, restaurant_id: rid }).first();
    return row || null;
  }

  async replaceMenuItemRecipe(
    trx: Knex.Transaction, rid: string, menuItemId: string,
    lines: Array<{ stockId: string; quantityPerUnit: number }>,
  ): Promise<number> {
    const item = await trx('menu_items')
      .select('id').where({ id: menuItemId, restaurant_id: rid }).forUpdate().first();
    if (!item) throw new AppError(404, 'Article du menu introuvable.');
    const stockIds = Array.from(new Set(lines.map((line) => line.stockId)));
    const stocks = stockIds.length
      ? await trx('stocks').select('id', 'unit_cost_xof')
          .where({ restaurant_id: rid }).whereIn('id', stockIds).forUpdate()
      : [];
    if (stocks.length !== stockIds.length) {
      throw new AppError(404, 'Ingrédient introuvable pour cet établissement.');
    }
    const costByStock = new Map(stocks.map((stock) => [String(stock.id), Number(stock.unit_cost_xof || 0)]));
    const now = new Date().toISOString();
    await trx('menu_item_recipes').where({
      restaurant_id: rid, menu_item_id: menuItemId,
    }).del();
    let computedCostXof = 0;
    if (lines.length) {
      await trx('menu_item_recipes').insert(lines.map((line) => {
        computedCostXof += (costByStock.get(line.stockId) || 0) * line.quantityPerUnit;
        return {
          id: this.id('rec'), restaurant_id: rid, menu_item_id: menuItemId,
          stock_id: line.stockId, quantity_per_unit: line.quantityPerUnit,
          created_at: now, updated_at: now,
        };
      }));
    }
    if (lines.length > 0 && computedCostXof > 0) {
      await trx('menu_items').where({ id: menuItemId, restaurant_id: rid })
        .update({ cost_price_xof: Math.round(computedCostXof) });
    }
    return Math.round(computedCostXof);
  }

  async findMenuCategories(rid: string) {
    return this.db('menu_categories')
      .select({
        id: 'id', restaurantId: 'restaurant_id', name: 'name',
        station: 'station', sortOrder: 'sort_order', active: 'active',
      })
      .where({ restaurant_id: rid })
      .orderBy('sort_order', 'asc');
  }

  async findMenuItems(rid: string) {
    return this.db('menu_items as m')
      .join('menu_categories as c', function () {
        this.on('c.id', '=', 'm.category_id').andOn('c.restaurant_id', '=', 'm.restaurant_id');
      })
      .select({
        id: 'm.id', restaurantId: 'm.restaurant_id', categoryId: 'm.category_id',
        categoryName: 'c.name', station: 'c.station', name: 'm.name',
        description: 'm.description', priceXof: 'm.price_xof',
        costPriceXof: 'm.cost_price_xof', imageUrl: 'm.image_url',
        available: 'm.available', sortOrder: 'm.sort_order',
        options_json: 'm.options_json',
      })
      .select(this.db.raw("COALESCE(m.option_groups_json, '[]') AS option_groups_json"))
      .where('m.restaurant_id', rid)
      .orderBy('m.sort_order', 'asc')
      .orderBy('m.name', 'asc');
  }

  async findMenuRecipes(rid: string, menuItemId?: string) {
    let query = this.db('menu_item_recipes as r')
      .join('stocks as s', function () {
        this.on('s.id', '=', 'r.stock_id').andOn('s.restaurant_id', '=', 'r.restaurant_id');
      })
      .select({
        id: 'r.id', menuItemId: 'r.menu_item_id', stockId: 'r.stock_id',
        quantityPerUnit: 'r.quantity_per_unit', stockName: 's.name',
        unit: 's.unit', unitCostXof: 's.unit_cost_xof',
        currentStockQty: 's.quantity',
      })
      .where('r.restaurant_id', rid);
    if (menuItemId) query = query.where('r.menu_item_id', menuItemId);
    const rows = await query.orderBy('s.name', 'asc');
    return rows.map((row) => ({
      id: String(row.id), menuItemId: String(row.menuItemId),
      stockId: String(row.stockId), stockName: String(row.stockName),
      unit: String(row.unit), quantityPerUnit: Number(row.quantityPerUnit),
      unitCostXof: Number(row.unitCostXof || 0),
      currentStockQty: Number(row.currentStockQty || 0),
    }));
  }

  async findStocksAndMovements(rid: string) {
    const stocks = await this.db('stocks as s')
      .leftJoin('menu_item_recipes as r', function () {
        this.on('r.stock_id', '=', 's.id').andOn('r.restaurant_id', '=', 's.restaurant_id');
      })
      .select({
        id: 's.id', restaurantId: 's.restaurant_id', name: 's.name',
        unit: 's.unit', stockSection: 's.stock_section',
        quantity: 's.quantity', minThreshold: 's.min_threshold',
        unitCostXof: 's.unit_cost_xof', supplierName: 's.supplier_name',
        updatedAt: 's.updated_at',
      })
      .count({ usedInRecipesCount: 'r.id' })
      .where('s.restaurant_id', rid)
      .groupBy('s.id')
      .orderBy('s.name', 'asc');
    const movements = await this.db('stock_movements as m')
      .join('stocks as s', function () {
        this.on('s.id', '=', 'm.stock_id').andOn('s.restaurant_id', '=', 'm.restaurant_id');
      })
      .select({
        id: 'm.id', stockName: 's.name', stockSection: 's.stock_section',
        stockUnit: 's.unit', movementType: 'm.movement_type',
        wasteCategory: 'm.waste_category', quantityDelta: 'm.quantity_delta',
        reason: 'm.reason', createdAt: 'm.created_at',
      })
      .where('m.restaurant_id', rid)
      .orderBy('m.created_at', 'desc')
      .limit(40);
    return {
      stocks: stocks.map((row) => ({
        ...row, stockSection: row.stockSection || 'KITCHEN',
        quantity: Number(row.quantity || 0),
        minThreshold: Number(row.minThreshold || 0),
        unitCostXof: Number(row.unitCostXof || 0),
        usedInRecipesCount: Number(row.usedInRecipesCount || 0),
      })),
      movements: movements.map((row) => ({
        ...row, quantityDelta: Number(row.quantityDelta || 0),
        wasteCategory: String(row.wasteCategory || ''),
        stockSection: row.stockSection || 'KITCHEN',
      })),
    };
  }

  async createStockItem(params: {
    rid: string; name: string; unit: string; stockSection: 'KITCHEN' | 'BEVERAGE';
    quantity: number; minThreshold: number; unitCostXof: number; supplierName: string;
  }): Promise<string> {
    const id = this.id('stk');
    await this.db('stocks').insert({
      id, restaurant_id: params.rid, name: params.name, unit: params.unit,
      stock_section: params.stockSection, quantity: params.quantity,
      min_threshold: params.minThreshold, unit_cost_xof: params.unitCostXof,
      supplier_name: params.supplierName, updated_at: new Date().toISOString(),
    });
    return id;
  }

  async updateStockItem(
    stockId: string, rid: string,
    updates: {
      name?: string; unit?: string; stockSection?: 'KITCHEN' | 'BEVERAGE';
      minThreshold?: number; unitCostXof?: number; supplierName?: string;
    },
    trx: Knex | Knex.Transaction = this.db,
  ): Promise<number> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.unit !== undefined) patch.unit = updates.unit;
    if (updates.stockSection !== undefined) patch.stock_section = updates.stockSection;
    if (updates.minThreshold !== undefined) patch.min_threshold = updates.minThreshold;
    if (updates.unitCostXof !== undefined) patch.unit_cost_xof = updates.unitCostXof;
    if (updates.supplierName !== undefined) patch.supplier_name = updates.supplierName;
    return trx('stocks').where({ id: stockId, restaurant_id: rid }).update(patch);
  }

  async deleteStockItem(
    trx: Knex.Transaction, stockId: string, rid: string,
  ): Promise<void> {
    const stock = await trx('stocks').select('id').where({ id: stockId, restaurant_id: rid }).forUpdate().first();
    if (!stock) throw new AppError(404, 'Ingrédient introuvable.');
    const [recipes, movements] = await Promise.all([
      trx('menu_item_recipes').where({ stock_id: stockId, restaurant_id: rid }).count({ count: '*' }).first(),
      trx('stock_movements').where({ stock_id: stockId, restaurant_id: rid }).count({ count: '*' }).first(),
    ]);
    if (Number(recipes?.count || 0) > 0 || Number(movements?.count || 0) > 0) {
      throw new AppError(409, 'Cet ingrédient possède un historique ou est utilisé dans une recette. Désactivez-le plutôt que de le supprimer.');
    }
    await trx('stocks').where({ id: stockId, restaurant_id: rid }).del();
  }

  async applyStockMovement(
    trx: Knex.Transaction,
    params: {
      rid: string; stockId: string; movementType: 'IN' | 'OUT' | 'LOSS' | 'INVENTORY';
      quantity: number; reason: string; userId: string | null; unitCostXof?: number;
    },
  ) {
    const stock = await trx('stocks')
      .select('id', 'name', 'quantity', 'min_threshold', 'unit', 'supplier_name')
      .where({ id: params.stockId, restaurant_id: params.rid })
      .forUpdate().first();
    if (!stock) throw new AppError(404, 'Article de stock introuvable.');
    const current = Number(stock.quantity || 0);
    const quantity = Math.round(params.quantity * 1000) / 1000;
    const delta = params.movementType === 'IN'
      ? quantity
      : params.movementType === 'INVENTORY' ? quantity - current : -quantity;
    const next = Math.round((current + delta) * 1000) / 1000;
    if (next < 0) {
      throw new AppError(409, `Stock insuffisant : disponible ${current}, demandé ${quantity} ${String(stock.unit)}.`);
    }
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { quantity: next, updated_at: now };
    if (params.unitCostXof !== undefined && params.unitCostXof > 0) patch.unit_cost_xof = params.unitCostXof;
    const updated = await trx('stocks').where({ id: params.stockId, restaurant_id: params.rid })
      .where('quantity', '=', current).update(patch);
    if (updated !== 1) throw new AppError(409, 'Le stock a changé pendant le mouvement. Réessayez.');
    await trx('stock_movements').insert({
      id: this.id('smv'), restaurant_id: params.rid, stock_id: params.stockId,
      movement_type: params.movementType, quantity_delta: delta,
      reason: params.reason, waste_category: '',
      created_by_user_id: params.userId, created_at: now,
    });
    return {
      quantity: next, delta, previousQuantity: current,
      stockName: String(stock.name), minThreshold: Number(stock.min_threshold || 0),
      unit: String(stock.unit), supplierName: String(stock.supplier_name || ''),
    };
  }

  async findRestaurantNameById(rid: string): Promise<string> {
    const row = await this.db('restaurants').select('name').where({ id: rid }).first();
    return row?.name ? String(row.name) : 'Établissement Resto’MAX';
  }

  async findStockAlertSettings(rid: string) {
    const row = await this.db('stock_alert_settings').where({ restaurant_id: rid }).first();
    if (!row) {
      return {
        restaurantId: rid, inAppEnabled: true, emailEnabled: true,
        recipientEmails: '', smtpHost: '', smtpPort: 587,
        smtpSecure: false, smtpUser: '', smtpPass: '',
        smtpFrom: '', updatedAt: new Date().toISOString(),
      };
    }
    return {
      restaurantId: rid, inAppEnabled: Boolean(row.in_app_enabled),
      emailEnabled: Boolean(row.email_enabled),
      recipientEmails: String(row.recipient_emails || ''),
      smtpHost: String(row.smtp_host || ''), smtpPort: Number(row.smtp_port || 587),
      smtpSecure: Boolean(row.smtp_secure), smtpUser: String(row.smtp_user || ''),
      smtpPass: String(row.smtp_pass || ''), smtpFrom: String(row.smtp_from || ''),
      updatedAt: String(row.updated_at || ''),
    };
  }

  async upsertStockAlertSettings(params: {
    rid: string; inAppEnabled: boolean; emailEnabled: boolean;
    recipientEmails: string; smtpHost: string; smtpPort: number;
    smtpSecure: boolean; smtpUser: string; smtpPass?: string; smtpFrom: string;
  }, trx: Knex | Knex.Transaction = this.db) {
    const current = await trx('stock_alert_settings').select('smtp_pass')
      .where({ restaurant_id: params.rid }).first();
    const password = params.smtpPass && params.smtpPass.trim()
      ? params.smtpPass : String(current?.smtp_pass || '');
    const now = new Date().toISOString();
    await trx('stock_alert_settings').insert({
      restaurant_id: params.rid,
      in_app_enabled: params.inAppEnabled ? 1 : 0,
      email_enabled: params.emailEnabled ? 1 : 0,
      recipient_emails: params.recipientEmails, smtp_host: params.smtpHost,
      smtp_port: params.smtpPort, smtp_secure: params.smtpSecure ? 1 : 0,
      smtp_user: params.smtpUser, smtp_pass: password,
      smtp_from: params.smtpFrom, updated_at: now,
    }).onConflict('restaurant_id').merge([
      'in_app_enabled', 'email_enabled', 'recipient_emails', 'smtp_host',
      'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'updated_at',
    ]);
    return this.findStockAlertSettings(rid);
  }

  async findManagerEmailsForRestaurant(rid: string): Promise<string[]> {
    const rows = await this.db('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .distinct('u.email')
      .where('rm.restaurant_id', rid)
      .where('rm.status', 'ACTIVE')
      .where('u.status', 'ACTIVE')
      .whereIn('rm.role', ['OWNER', 'MANAGER']);
    return rows.map((row) => String(row.email));
  }

  async createNotification(params: {
    rid: string; type: string; title: string; message: string;
    stockId: string | null; emailDispatched: boolean; emailRecipients: string;
    emailStatus: 'SENT' | 'QUEUED_NO_SMTP' | 'SKIPPED' | 'FAILED';
  }, trx: Knex | Knex.Transaction = this.db) {
    const id = this.id('ntf');
    const now = new Date().toISOString();
    await trx('notifications').insert({
      id, restaurant_id: params.rid, type: params.type,
      title: params.title, message: params.message, stock_id: params.stockId,
      email_dispatched: params.emailDispatched ? 1 : 0,
      email_recipients: params.emailRecipients, email_status: params.emailStatus,
      is_read: 0, created_at: now,
    });
    return {
      id, restaurantId: params.rid, type: params.type, title: params.title,
      message: params.message, stockId: params.stockId,
      emailDispatched: params.emailDispatched,
      emailRecipients: params.emailRecipients, emailStatus: params.emailStatus,
      isRead: false, createdAt: now,
    };
  }

  async findNotificationsForRestaurant(rid: string, limit = 30) {
    const rows = await this.db('notifications')
      .where({ restaurant_id: rid })
      .orderBy('created_at', 'desc')
      .limit(Math.max(1, Math.min(100, Math.floor(limit))));
    return rows.map((row) => ({
      id: String(row.id), restaurantId: String(row.restaurant_id),
      type: String(row.type), title: String(row.title), message: String(row.message),
      stockId: row.stock_id ? String(row.stock_id) : null,
      emailDispatched: Boolean(row.email_dispatched),
      emailRecipients: String(row.email_recipients || ''),
      emailStatus: String(row.email_status || 'SKIPPED') as 'SENT' | 'QUEUED_NO_SMTP' | 'SKIPPED' | 'FAILED',
      isRead: Boolean(row.is_read), createdAt: String(row.created_at),
    }));
  }

  async markNotificationsRead(rid: string, notificationId?: string): Promise<number> {
    const query = this.db('notifications').where({ restaurant_id: rid });
    if (notificationId) query.where({ id: notificationId });
    return query.update({ is_read: 1 });
  }

  async findRecentStockAlerts(rid: string, limit = 15) {
    const rows = await this.db('notifications')
      .where({ restaurant_id: rid, type: 'STOCK_CRITICAL' })
      .orderBy('created_at', 'desc')
      .limit(Math.max(1, Math.min(50, Math.floor(limit))));
    return rows.map((row) => ({
      id: String(row.id), restaurantId: String(row.restaurant_id),
      type: String(row.type), title: String(row.title), message: String(row.message),
      stockId: row.stock_id ? String(row.stock_id) : null,
      emailDispatched: Boolean(row.email_dispatched),
      emailRecipients: String(row.email_recipients || ''),
      emailStatus: String(row.email_status || 'SKIPPED') as 'SENT' | 'QUEUED_NO_SMTP' | 'SKIPPED' | 'FAILED',
      isRead: Boolean(row.is_read), createdAt: String(row.created_at),
    }));
  }

  async findPurchaseOrders(rid: string) {
    const orders = await this.db('purchase_orders')
      .where({ restaurant_id: rid }).orderBy('created_at', 'desc');
    if (!orders.length) return [];
    const ids = orders.map((row) => String(row.id));
    const items = await this.db('purchase_order_items')
      .whereIn('purchase_order_id', ids).orderBy('purchase_order_id', 'asc');
    const byOrder = new Map<string, Array<Record<string, unknown>>>();
    for (const item of items) {
      const key = String(item.purchase_order_id);
      const list = byOrder.get(key) || [];
      list.push({
        id: String(item.id), purchaseOrderId: key,
        stockId: String(item.stock_id), stockName: String(item.stock_name),
        unit: String(item.unit), quantity: Number(item.quantity || 0),
        unitCostXof: Number(item.unit_cost_xof || 0),
        lineTotalXof: Number(item.line_total_xof || 0),
      });
      byOrder.set(key, list);
    }
    return orders.map((po) => ({
      id: String(po.id), restaurantId: String(po.restaurant_id),
      poNumber: String(po.po_number), supplierName: String(po.supplier_name),
      status: String(po.status), totalCostXof: Number(po.total_cost_xof || 0),
      notes: String(po.notes || ''), expectedDate: po.expected_date ? String(po.expected_date) : null,
      receivedAt: po.received_at ? String(po.received_at) : null,
      createdAt: String(po.created_at), updatedAt: String(po.updated_at || ''),
      items: byOrder.get(String(po.id)) || [],
    }));
  }

  async findPurchaseOrderById(poId: string, rid: string, executor: Knex | Knex.Transaction = this.db) {
    const po = await executor('purchase_orders')
      .select('id', 'po_number', 'supplier_name', 'status', 'total_cost_xof')
      .where({ id: poId, restaurant_id: rid }).first();
    if (!po) return null;
    const items = await executor('purchase_order_items')
      .select('id', 'stock_id', 'stock_name', 'unit', 'quantity', 'unit_cost_xof', 'line_total_xof')
      .where({ purchase_order_id: poId });
    return { po, items };
  }

  async createPurchaseOrder(
    trx: Knex.Transaction,
    params: {
      id: string; rid: string; supplierName: string; status: string;
      totalCostXof: number; notes: string; expectedDate: string | null;
      userId: string; items: Array<{
        id: string; stockId: string; stockName: string; unit: string;
        quantity: number; unitCostXof: number; lineTotalXof: number;
      }>;
    },
  ): Promise<{ poNumber: string; totalCostXof: number; status: string }> {
    const restaurant = await trx('restaurants').select('id').where({ id: params.rid }).forUpdate().first();
    if (!restaurant) throw new AppError(404, 'Établissement introuvable.');
    const countRow = await trx('purchase_orders').where({ restaurant_id: params.rid }).count({ count: '*' }).first();
    const poNumber = `PO-${1001 + Number(countRow?.count || 0)}`;
    const now = new Date().toISOString();
    await trx('purchase_orders').insert({
      id: params.id, restaurant_id: params.rid, po_number: poNumber,
      supplier_name: params.supplierName, status: params.status,
      total_cost_xof: params.totalCostXof, notes: params.notes,
      expected_date: params.expectedDate, created_by_user_id: params.userId,
      created_at: now, updated_at: now,
    });
    if (params.items.length) {
      await trx('purchase_order_items').insert(params.items.map((item) => ({
        id: item.id, purchase_order_id: params.id, stock_id: item.stockId,
        stock_name: item.stockName, unit: item.unit, quantity: item.quantity,
        unit_cost_xof: item.unitCostXof, line_total_xof: item.lineTotalXof,
      })));
    }
    return { poNumber, totalCostXof: params.totalCostXof, status: params.status };
  }

  async updatePurchaseOrderStatus(
    trx: Knex.Transaction,
    params: { poId: string; rid: string; status: 'ORDERED' | 'RECEIVED' | 'CANCELLED'; userId: string },
  ): Promise<{ poNumber: string; supplierName: string }> {
    const po = await trx('purchase_orders')
      .where({ id: params.poId, restaurant_id: params.rid })
      .forUpdate().first();
    if (!po) throw new AppError(404, 'Bon de commande introuvable.');
    if (po.status === 'RECEIVED' || po.status === 'CANCELLED') {
      throw new AppError(409, 'Ce bon de commande est déjà clôturé.');
    }
    if (params.status === 'RECEIVED') {
      const items = await trx('purchase_order_items')
        .where({ purchase_order_id: params.poId });
      for (const item of items) {
        const stock = await trx('stocks')
          .select('id', 'quantity', 'name')
          .where({ id: item.stock_id, restaurant_id: params.rid })
          .forUpdate().first();
        if (!stock) throw new AppError(409, `L’ingrédient « ${String(item.stock_name)} » n’existe plus dans cet établissement.`);
        const quantity = Number(item.quantity || 0);
        const next = Math.round((Number(stock.quantity || 0) + quantity) * 1000) / 1000;
        const updated = await trx('stocks')
          .where({ id: item.stock_id, restaurant_id: params.rid })
          .update({
            quantity: next, updated_at: new Date().toISOString(),
            ...(Number(item.unit_cost_xof || 0) > 0 ? { unit_cost_xof: Number(item.unit_cost_xof) } : {}),
          });
        if (updated !== 1) throw new AppError(409, 'Le stock a changé pendant la réception du bon de commande.');
        await trx('stock_movements').insert({
          id: this.id('smv'), restaurant_id: params.rid,
          stock_id: String(item.stock_id), movement_type: 'PURCHASE',
          quantity_delta: quantity,
          reason: `Réception bon ${String(po.po_number)} (${String(po.supplier_name)})`,
          waste_category: '', created_by_user_id: params.userId,
          created_at: new Date().toISOString(),
        });
      }
    }
    await trx('purchase_orders')
      .where({ id: params.poId, restaurant_id: params.rid })
      .update({
        status: params.status,
        received_at: params.status === 'RECEIVED' ? new Date().toISOString() : po.received_at,
        updated_at: new Date().toISOString(),
      });
    return { poNumber: String(po.po_number), supplierName: String(po.supplier_name) };
  }

  async findOrderByIdempotencyKey(rid: string, key: string, executor: Knex | Knex.Transaction = this.db) {
    return executor('orders')
      .select('id', 'order_number', 'total_xof')
      .where({ restaurant_id: rid, idempotency_key: key }).first();
  }

  async findRestaurantTaxAndMode(rid: string, executor: Knex | Knex.Transaction = this.db) {
    return executor('restaurants')
      .select('tax_rate_percent', 'paydunya_mode')
      .where({ id: rid }).first();
  }

  async findTableById(tableId: string, rid: string, executor: Knex | Knex.Transaction = this.db) {
    return executor('dining_tables')
      .select('id', 'label', 'status')
      .where({ id: tableId, restaurant_id: rid }).first();
  }

  async countOrders(rid: string, executor: Knex | Knex.Transaction = this.db): Promise<number> {
    const row = await executor('orders').where({ restaurant_id: rid }).count({ count: '*' }).first();
    return Number(row?.count || 0);
  }

  async findMenuItemWithStation(menuItemId: string, rid: string, executor: Knex | Knex.Transaction = this.db) {
    return executor('menu_items as m')
      .join('menu_categories as c', function () {
        this.on('c.id', '=', 'm.category_id').andOn('c.restaurant_id', '=', 'm.restaurant_id');
      })
      .select({
        id: 'm.id', category_id: 'm.category_id', name: 'm.name',
        price_xof: 'm.price_xof', available: 'm.available',
        options_json: 'm.options_json', option_groups_json: 'm.option_groups_json',
        station: 'c.station',
      })
      .where('m.id', menuItemId)
      .where('m.restaurant_id', rid)
      .first();
  }

  async insertPosOrder(trx: Knex.Transaction, params: {
    orderId: string; rid: string; orderNumber: string; orderType: string;
    tableId: string | null; customerName: string; customerPhone?: string;
    deliveryAddress?: string; deliveryZone?: string; deliveryFeeXof?: number;
    scheduledSlot?: string; promoCode?: string; loyaltyPointsUsed?: number;
    subtotalXof: number; discountXof: number; taxXof: number; totalXof: number;
    notes: string; idempotencyKey: string | null; userId: string; now: string;
    lines: Array<{
      id: string; menuItemId: string; name: string; station: string;
      unitPriceXof: number; optionsSummary: string; optionsDeltaXof: number;
      quantity: number; lineTotalXof: number; notes: string;
    }>;
  }): Promise<void> {
    await trx('orders').insert({
      id: params.orderId, restaurant_id: params.rid,
      order_number: params.orderNumber, order_type: params.orderType,
      table_id: params.tableId, customer_name: params.customerName,
      customer_phone: params.customerPhone || '',
      delivery_address: params.deliveryAddress || '',
      delivery_zone: params.deliveryZone || '',
      delivery_fee_xof: params.deliveryFeeXof || 0,
      scheduled_slot: params.scheduledSlot || '',
      promo_code: params.promoCode || '',
      loyalty_points_used: params.loyaltyPointsUsed || 0,
      status: 'PENDING', subtotal_xof: params.subtotalXof,
      discount_xof: params.discountXof, tax_xof: params.taxXof,
      total_xof: params.totalXof, paid_xof: 0, notes: params.notes,
      idempotency_key: params.idempotencyKey,
      created_by_user_id: params.userId, created_at: params.now, updated_at: params.now,
    });
    if (params.lines.length) {
      await trx('order_items').insert(params.lines.map((line) => ({
        id: line.id, order_id: params.orderId, menu_item_id: line.menuItemId,
        name: line.name, station: line.station, unit_price_xof: line.unitPriceXof,
        options_summary: line.optionsSummary, options_delta_xof: line.optionsDeltaXof,
        quantity: line.quantity, line_total_xof: line.lineTotalXof,
        notes: line.notes, prep_status: 'PENDING',
      })));
    }
    if (params.tableId) {
      const updated = await trx('dining_tables')
        .where({ id: params.tableId, restaurant_id: params.rid })
        .whereIn('status', ['AVAILABLE', 'RESERVED', 'OCCUPIED'])
        .update({ status: 'OCCUPIED' });
      if (updated !== 1) throw new AppError(409, 'La table a changé d’état. Actualisez puis réessayez.');
    }
  }

  async findPayments(rid: string) {
    const rows = await this.db('payments as p')
      .join('orders as o', function () {
        this.on('o.id', '=', 'p.order_id').andOn('o.restaurant_id', '=', 'p.restaurant_id');
      })
      .select({
        id: 'p.id', restaurantId: 'p.restaurant_id', orderId: 'p.order_id',
        orderNumber: 'o.order_number', amountXof: 'p.amount_xof',
        method: 'p.method', status: 'p.status', mode: 'p.mode',
        reference: 'p.reference', createdAt: 'p.created_at',
      })
      .where('p.restaurant_id', rid)
      .orderBy('p.created_at', 'desc')
      .limit(100);
    return rows.map((row) => ({ ...row, amountXof: Number(row.amountXof || 0) }));
  }

  async findPaymentByIdempotencyKey(rid: string, key: string, executor: Knex | Knex.Transaction = this.db) {
    return executor('payments')
      .select('id', 'reference', 'amount_xof')
      .where({ restaurant_id: rid, idempotency_key: key }).first();
  }

  async insertPaymentAndSettleOrder(
    trx: Knex.Transaction,
    params: {
      paymentId: string; rid: string; orderId: string; amountXof: number;
      method: string; mode: string; reference: string;
      idempotencyKey: string | null; userId: string;
      newPaid: number; fullyPaid: boolean; tableId: string | null; now: string;
    },
  ): Promise<void> {
    await trx('payments').insert({
      id: params.paymentId, restaurant_id: params.rid, order_id: params.orderId,
      amount_xof: params.amountXof, method: params.method, status: 'PAID',
      mode: params.mode, reference: params.reference,
      idempotency_key: params.idempotencyKey,
      created_by_user_id: params.userId, created_at: params.now,
    });
    const updated = await trx('orders')
      .where({ id: params.orderId, restaurant_id: params.rid })
      .update({
        paid_xof: params.newPaid,
        ...(params.fullyPaid ? { status: 'PAID' } : {}),
        updated_at: params.now,
      });
    if (updated !== 1) throw new AppError(404, 'Commande introuvable pendant l’encaissement.');
    if (params.fullyPaid && params.tableId) {
      await trx('dining_tables')
        .where({ id: params.tableId, restaurant_id: params.rid })
        .update({ status: 'AVAILABLE' });
    }
  }

  async findPaymentForRefund(paymentId: string, rid: string, trx: Knex.Transaction) {
    return trx('payments')
      .select('id', 'order_id', 'amount_xof', 'status')
      .where({ id: paymentId, restaurant_id: rid })
      .forUpdate().first();
  }

  async markPaymentRefunded(
    trx: Knex.Transaction,
    paymentId: string, rid: string, orderId: string, amountXof: number,
  ): Promise<void> {
    const updated = await trx('payments')
      .where({ id: paymentId, restaurant_id: rid })
      .whereNot('status', 'REFUNDED')
      .update({ status: 'REFUNDED' });
    if (updated !== 1) throw new AppError(409, 'Ce paiement a déjà été remboursé.');
    await trx('orders')
      .where({ id: orderId, restaurant_id: rid })
      .update({
        paid_xof: trx.raw('GREATEST(0, paid_xof - ?)', [amountXof]),
        status: 'SERVED', updated_at: new Date().toISOString(),
      });
  }

  async findOrdersWithItems(rid: string) {
    const orders = await this.db('orders as o')
      .leftJoin('dining_tables as t', function () {
        this.on('t.id', '=', 'o.table_id').andOn('t.restaurant_id', '=', 'o.restaurant_id');
      })
      .select({
        id: 'o.id', restaurantId: 'o.restaurant_id',
        orderNumber: 'o.order_number', orderType: 'o.order_type',
        tableId: 'o.table_id', tableLabel: 't.label', tableZone: 't.zone',
        customerName: 'o.customer_name', customerPhone: 'o.customer_phone',
        deliveryAddress: 'o.delivery_address', deliveryZone: 'o.delivery_zone',
        deliveryFeeXof: 'o.delivery_fee_xof', scheduledSlot: 'o.scheduled_slot',
        promoCode: 'o.promo_code', loyaltyPointsUsed: 'o.loyalty_points_used',
        loyaltyPointsEarned: 'o.loyalty_points_earned', status: 'o.status',
        subtotalXof: 'o.subtotal_xof', discountXof: 'o.discount_xof',
        taxXof: 'o.tax_xof', totalXof: 'o.total_xof', paidXof: 'o.paid_xof',
        notes: 'o.notes', createdByUserId: 'o.created_by_user_id',
        createdAt: 'o.created_at', updatedAt: 'o.updated_at',
      })
      .where('o.restaurant_id', rid)
      .orderBy('o.created_at', 'desc')
      .limit(100);
    if (!orders.length) return [];
    const orderIds = orders.map((order) => String(order.id));
    const items = await this.db('order_items')
      .select({
        id: 'id', orderId: 'order_id', menuItemId: 'menu_item_id',
        name: 'name', station: 'station', unitPriceXof: 'unit_price_xof',
        optionsSummary: 'options_summary', optionsDeltaXof: 'options_delta_xof',
        quantity: 'quantity', lineTotalXof: 'line_total_xof',
        notes: 'notes', prepStatus: 'prep_status',
      })
      .whereIn('order_id', orderIds)
      .orderBy('id', 'asc');
    const byOrder = new Map<string, Array<Record<string, unknown>>>();
    for (const item of items) {
      const key = String(item.orderId);
      const list = byOrder.get(key) || [];
      list.push(item);
      byOrder.set(key, list);
    }
    return orders.map((order) => ({
      ...order,
      customerPhone: String(order.customerPhone || ''),
      deliveryAddress: String(order.deliveryAddress || ''),
      deliveryZone: String(order.deliveryZone || ''),
      deliveryFeeXof: Number(order.deliveryFeeXof || 0),
      scheduledSlot: String(order.scheduledSlot || ''),
      promoCode: String(order.promoCode || ''),
      loyaltyPointsUsed: Number(order.loyaltyPointsUsed || 0),
      loyaltyPointsEarned: Number(order.loyaltyPointsEarned || 0),
      items: byOrder.get(String(order.id)) || [],
    }));
  }

  async findOrderForUpdate(orderId: string, rid: string, trx: Knex | Knex.Transaction = this.db) {
    return trx('orders')
      .select('id', 'table_id', 'total_xof', 'paid_xof', 'status')
      .where({ id: orderId, restaurant_id: rid })
      .forUpdate().first();
  }

  async updateOrderAndPrepStatus(
    trx: Knex.Transaction, orderId: string, rid: string, status: string, tableId: string | null,
  ): Promise<number> {
    const updated = await trx('orders')
      .where({ id: orderId, restaurant_id: rid })
      .update({ status, updated_at: new Date().toISOString() });
    if (updated !== 1) return 0;
    if (status === 'IN_PREPARATION') {
      await trx('order_items').where({ order_id: orderId, prep_status: 'PENDING' }).update({ prep_status: 'PREPARING' });
    } else if (status === 'READY' || status === 'SERVED') {
      await trx('order_items').where({ order_id: orderId }).update({ prep_status: status });
    } else if (status === 'CANCELLED' && tableId) {
      await trx('dining_tables').where({ id: tableId, restaurant_id: rid }).update({ status: 'AVAILABLE' });
    }
    return updated;
  }

  async deductStocksForOrderItems(
    trx: Knex.Transaction,
    params: {
      rid: string;
      orderNumber: string;
      items: Array<{ menuItemId: string; quantity: number }>;
      userId: string | null;
      now: string;
    },
  ) {
    const qtyByMenuItem = new Map<string, number>();
    for (const item of params.items) {
      qtyByMenuItem.set(
        item.menuItemId,
        (qtyByMenuItem.get(item.menuItemId) || 0) + Number(item.quantity || 0),
      );
    }

    const deductionByStock = new Map<string, number>();
    for (const [menuItemId, orderedQty] of qtyByMenuItem.entries()) {
      if (orderedQty <= 0) continue;
      const recipes = await trx('menu_item_recipes')
        .select('stock_id', 'quantity_per_unit')
        .where({ restaurant_id: params.rid, menu_item_id: menuItemId });
      for (const recipe of recipes) {
        const amount = Number(recipe.quantity_per_unit) * orderedQty;
        if (amount > 0) {
          deductionByStock.set(
            String(recipe.stock_id),
            (deductionByStock.get(String(recipe.stock_id)) || 0) + amount,
          );
        }
      }
    }

    const lowStocksTriggered: Array<{
      id: string; name: string; quantity: number; minThreshold: number;
      unit: string; supplierName: string;
    }> = [];

    for (const [stockId, rawDeduct] of deductionByStock.entries()) {
      const stock = await trx('stocks')
        .select('id', 'name', 'quantity', 'min_threshold', 'unit', 'supplier_name')
        .where({ id: stockId, restaurant_id: params.rid })
        .forUpdate()
        .first();
      if (!stock) {
        throw new AppError(409, 'Un ingrédient de la recette référence un stock introuvable. La commande a été annulée.');
      }

      const deduct = Math.round(rawDeduct * 1000) / 1000;
      const currentQty = Number(stock.quantity);
      if (currentQty < deduct) {
        throw new AppError(
          409,
          `Stock insuffisant pour ${String(stock.name)} : disponible ${currentQty}, requis ${deduct} ${String(stock.unit)}.`,
        );
      }
      const nextQty = Math.round((currentQty - deduct) * 1000) / 1000;
      const updated = await trx('stocks')
        .where({ id: stockId, restaurant_id: params.rid })
        .where('quantity', '>=', deduct)
        .update({ quantity: nextQty, updated_at: params.now });
      if (updated !== 1) {
        throw new AppError(409, 'Le stock a changé pendant la validation de la commande. Réessayez.');
      }
      await trx('stock_movements').insert({
        id: `smv_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
        restaurant_id: params.rid, stock_id: stockId,
        movement_type: 'AUTO_ORDER', quantity_delta: -deduct,
        reason: `Déduction auto · ${params.orderNumber}`,
        created_by_user_id: params.userId, created_at: params.now,
      });
      if (nextQty <= Number(stock.min_threshold) && nextQty !== currentQty) {
        lowStocksTriggered.push({
          id: String(stock.id), name: String(stock.name), quantity: nextQty,
          minThreshold: Number(stock.min_threshold), unit: String(stock.unit),
          supplierName: String(stock.supplier_name || ''),
        });
      }
    }

    return { deductedCount: deductionByStock.size, lowStocksTriggered };
  }
}

export const knexRestaurantStockRepository = new KnexRestaurantStockRepository();
