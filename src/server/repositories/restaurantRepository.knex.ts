import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { AppError } from '../services/errors.ts';

export class KnexRestaurantStockRepository {
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
