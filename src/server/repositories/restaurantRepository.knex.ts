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
