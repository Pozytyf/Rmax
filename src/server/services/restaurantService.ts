import bcrypt from 'bcryptjs';
import { getDb, generateId } from '../db.ts';
import { type AuthContext, recordAudit } from '../auth.ts';
import { ROLE_PERMISSION_CEILING } from '../rbac.ts';
import {
  broadcastOrderTrackerEvent,
  broadcastRestaurantEvent,
} from '../ws.ts';
import {
  RestaurantRepository,
  restaurantRepository,
} from '../repositories/restaurantRepository.ts';
import { BaseService } from './BaseService.ts';
import { AppError } from './errors.ts';
import {
  isEnvSmtpConfigured,
  sendCriticalStockAlertEmail,
  sendSmtpTestEmail,
} from './mailer.ts';
import { isDisallowedInternalHost, sendRawBytesOverTcp } from './printerRelay.ts';
import { sendWhatsappMessage } from './whatsappService.ts';
import {
  confirmPaydunyaInvoice,
  createPaydunyaSubscriptionCheckout,
  resolvePaydunyaPlatformCredentials,
} from './paydunyaService.ts';
import {
  buildEscPosKitchenPayload,
  buildEscPosReceiptPayload,
} from '../../shared/escpos.ts';
import {
  applyOrderPromoAndLoyaltyDiscounts,
  awardLoyaltyPointsOnPaidOrder,
  computeHappyHourForItem,
  loadActivePromotions,
  parseDeliveryZones,
  parseOptionGroups,
  parsePickupSlots,
  resolveItemOptionsSelection,
  sanitizeOptionGroups,
} from './pricingEngine.ts';
import { operationsRepository } from '../repositories/operationsRepository.ts';
import { knexRestaurantStockRepository } from '../repositories/restaurantRepository.knex.ts';
import { knexOperationsReadRepository } from '../repositories/operationsRepository.knex.ts';
import type { Permission, PrinterSettings, Role } from '../../types/index.ts';

const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  paperWidth: '80mm',
  connectionType: 'BROWSER',
  printerHost: '',
  printerPort: 9100,
  autoPrintReceipt: false,
  autoPrintKitchenTicket: false,
};

function parsePrinterSettings(raw: unknown): PrinterSettings {
  try {
    const parsed = JSON.parse(String(raw || '{}')) as Partial<PrinterSettings>;
    return {
      paperWidth: parsed.paperWidth === '58mm' ? '58mm' : '80mm',
      connectionType:
        parsed.connectionType === 'NETWORK_ESCPOS' ||
        parsed.connectionType === 'WEB_SERIAL'
          ? parsed.connectionType
          : 'BROWSER',
      printerHost: String(parsed.printerHost || '').trim(),
      printerPort: Number(parsed.printerPort || 9100),
      autoPrintReceipt: Boolean(parsed.autoPrintReceipt),
      autoPrintKitchenTicket: Boolean(parsed.autoPrintKitchenTicket),
    };
  } catch {
    return { ...DEFAULT_PRINTER_SETTINGS };
  }
}

function usesPostgresRepositories(): boolean {
  return ['pg', 'postgres', 'postgresql'].includes((process.env.DATABASE_CLIENT || '').toLowerCase());
}

export class RestaurantService extends BaseService<RestaurantRepository> {
  constructor(repo = restaurantRepository) {
    super(repo);
  }

  getDashboard(rid: string) {
    this.ensureTenantId(rid);
    const {
      revenueRow,
      pendingRow,
      tablesStats,
      revenueSeries,
      topItems,
      lowStocks,
      paymentBreakdown,
      recentOrders,
      staffActivity,
      expensesRow,
      collectedRow,
    } = restaurantRepository.getDashboardMetrics(rid);

    return {
      kpis: {
        totalRevenueXof: Number(revenueRow.total_revenue),
        collectedXof: Number(collectedRow.total_paid),
        expensesXof: Number(expensesRow.total_expenses),
        ordersCount: Number(revenueRow.orders_count),
        avgBasketXof: Math.round(Number(revenueRow.avg_basket)),
        pendingOrdersCount: Number(pendingRow.c),
        tablesTotal: Number(tablesStats.total),
        tablesOccupied: Number(tablesStats.occupied || 0),
        tablesReserved: Number(tablesStats.reserved || 0),
      },
      revenueSeries,
      topItems,
      lowStocks,
      paymentBreakdown,
      recentOrders,
      staffActivity,
    };
  }

  async getMenu(rid: string) {
    const usePostgres = usesPostgresRepositories();
    const [categories, itemsRaw, recipes, promos, combos] = usePostgres
      ? await Promise.all([
          knexRestaurantStockRepository.findMenuCategories(rid),
          knexRestaurantStockRepository.findMenuItems(rid),
          knexRestaurantStockRepository.findMenuRecipes(rid),
          knexOperationsReadRepository.findPromotions(rid).then((rows) => rows.filter((promo) => promo.active)),
          knexOperationsReadRepository.findCombos(rid, false),
        ])
      : [
          restaurantRepository.findMenuCategories(rid),
          restaurantRepository.findMenuItems(rid),
          restaurantRepository.findMenuRecipes(rid),
          loadActivePromotions(getDb(), rid),
          operationsRepository.findCombos(rid, false),
        ];
    const recipesByItem = new Map<string, typeof recipes>();
    for (const r of recipes) {
      const list = recipesByItem.get(r.menuItemId) || [];
      list.push(r);
      recipesByItem.set(r.menuItemId, list);
    }
    return {
      categories: categories.map((c) => ({ ...c, active: Boolean(c.active) })),
      items: itemsRaw.map((r) => {
        const basePrice = Number(r.priceXof);
        const hh = computeHappyHourForItem({
          basePriceXof: basePrice,
          categoryId: String(r.categoryId),
          promotions: promos,
        });
        return {
          ...r,
          available: Boolean(r.available),
          options: JSON.parse(String(r.options_json || '[]')),
          optionGroups: parseOptionGroups(r.option_groups_json),
          effectivePriceXof: hh.effectivePriceXof,
          promoLabel: hh.promoLabel,
          recipeLines: recipesByItem.get(String(r.id)) || [],
        };
      }),
      combos,
      promotions: promos,
    };
  }

  getRecipes(rid: string, menuItemId?: string) {
    this.ensureTenantId(rid);
    return restaurantRepository.findMenuRecipes(rid, menuItemId);
  }

  updateMenuItemRecipe(
    auth: AuthContext,
    menuItemId: string,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const item = restaurantRepository.findMenuItemById(menuItemId, rid);
    if (!item) {
      throw new AppError(404, 'Article du menu introuvable.');
    }

    const rawLines = Array.isArray(body?.lines) ? body.lines : [];
    const cleanMap = new Map<string, number>();
    for (const raw of rawLines) {
      const row = raw as { stockId?: unknown; quantityPerUnit?: unknown };
      const stockId = typeof row.stockId === 'string' ? row.stockId.trim() : '';
      const qty = Number(row.quantityPerUnit);
      if (!stockId || !Number.isFinite(qty) || qty <= 0) {
        continue;
      }
      const stock = restaurantRepository.findStockById(stockId, rid);
      if (!stock) {
        throw new AppError(404, 'Ingrédient introuvable pour cet établissement.');
      }
      cleanMap.set(stockId, Math.round(qty * 1000) / 1000);
    }

    const cleanLines = Array.from(cleanMap.entries()).map(
      ([stockId, quantityPerUnit]) => ({ stockId, quantityPerUnit }),
    );
    const saved = restaurantRepository.replaceMenuItemRecipe(
      rid,
      menuItemId,
      cleanLines,
    );

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'MENU_RECIPE_UPDATED',
      targetType: 'MENU_ITEM',
      targetId: menuItemId,
      details: `${saved.length} ingrédient(s) lié(s)`,
    });

    broadcastRestaurantEvent(rid, 'menu:updated', { itemId: menuItemId });
    return saved;
  }

  createCategory(rid: string, body: Record<string, unknown>) {
    const { name, station } = body || {};
    if (typeof name !== 'string' || name.trim().length < 2) {
      throw new AppError(400, 'Nom de catégorie requis.');
    }
    const st = station === 'BAR' ? 'BAR' : 'KITCHEN';
    const count = restaurantRepository.countCategories(rid);
    const id = restaurantRepository.createCategory(
      rid,
      name.trim(),
      st,
      count + 1,
    );
    broadcastRestaurantEvent(rid, 'menu:updated', { categoryId: id });
    return {
      id,
      restaurantId: rid,
      name: name.trim(),
      station: st,
      sortOrder: count + 1,
      active: true,
    };
  }

  updateCategory(rid: string, categoryId: string, body: Record<string, unknown>) {
    const existing = restaurantRepository.findCategory(categoryId, rid);
    if (!existing) {
      throw new AppError(404, 'Catégorie introuvable.');
    }
    const { name, station, sortOrder, active } = body || {};
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2)) {
      throw new AppError(400, 'Nom de catégorie invalide.');
    }
    restaurantRepository.updateCategory(categoryId, rid, {
      name: typeof name === 'string' ? name.trim() : undefined,
      station: station === 'BAR' ? 'BAR' : station === 'KITCHEN' ? 'KITCHEN' : undefined,
      sortOrder:
        sortOrder !== undefined && Number.isFinite(Number(sortOrder))
          ? Math.max(0, Math.round(Number(sortOrder)))
          : undefined,
      active: typeof active === 'boolean' ? active : undefined,
    });
    broadcastRestaurantEvent(rid, 'menu:updated', { categoryId });
  }

  deleteCategory(auth: AuthContext, categoryId: string) {
    const rid = auth.restaurantId!;
    const existing = restaurantRepository.findCategory(categoryId, rid);
    if (!existing) {
      throw new AppError(404, 'Catégorie introuvable.');
    }
    const itemsCount = restaurantRepository.countItemsInCategory(categoryId, rid);
    if (itemsCount > 0) {
      throw new AppError(
        409,
        `Impossible de supprimer cette catégorie : elle contient encore ${itemsCount} article(s). Déplacez ou supprimez ces articles d’abord.`,
      );
    }
    restaurantRepository.deleteCategory(categoryId, rid);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'MENU_CATEGORY_DELETED',
      targetType: 'MENU_CATEGORY',
      targetId: categoryId,
      details: existing.name,
    });
    broadcastRestaurantEvent(rid, 'menu:updated', { categoryId });
  }

  private sanitizeMenuItemImageUrl(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') {
      throw new AppError(400, 'Format de photo invalide.');
    }
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length > 600_000) {
      throw new AppError(400, 'Photo trop volumineuse (max 450 Ko).');
    }
    if (/^\/[a-zA-Z0-9._\-\/]+$/.test(trimmed)) {
      return trimmed;
    }
    if (/^https?:\/\/[^\s<>"]+$/.test(trimmed)) {
      return trimmed;
    }
    if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
      return trimmed;
    }
    throw new AppError(
      400,
      'URL ou format de photo invalide (PNG, JPG, WebP, GIF ou lien HTTPS).',
    );
  }

  private sanitizeMenuOptions(
    rawOptions: unknown,
  ): Array<{ id: string; label: string; priceDeltaXof: number }> {
    if (!Array.isArray(rawOptions)) return [];
    return rawOptions
      .map((raw) => {
        const o = (raw || {}) as {
          id?: unknown;
          label?: unknown;
          priceDeltaXof?: unknown;
        };
        const label = String(o.label || '').trim();
        if (!label) return null;
        const existingId =
          typeof o.id === 'string' && o.id.trim().length > 0
            ? o.id.trim()
            : generateId('opt');
        return {
          id: existingId,
          label,
          priceDeltaXof: Math.max(0, Math.round(Number(o.priceDeltaXof || 0))),
        };
      })
      .filter(
        (
          opt,
        ): opt is { id: string; label: string; priceDeltaXof: number } =>
          opt !== null,
      );
  }

  createMenuItem(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const {
      categoryId,
      name,
      description,
      priceXof,
      costPriceXof,
      imageUrl,
      available,
      sortOrder,
      options,
      optionGroups,
    } = body || {};
    if (
      typeof categoryId !== 'string' ||
      typeof name !== 'string' ||
      name.trim().length < 2 ||
      !Number.isFinite(Number(priceXof)) ||
      Number(priceXof) < 0
    ) {
      throw new AppError(400, 'Données du produit invalides.');
    }

    const cat = restaurantRepository.findCategory(categoryId, rid);
    if (!cat) {
      throw new AppError(404, 'Catégorie introuvable.');
    }

    const sanitizedImageUrl = this.sanitizeMenuItemImageUrl(imageUrl);
    const cleanOptions = this.sanitizeMenuOptions(options);
    const cleanOptionGroups = sanitizeOptionGroups(optionGroups);
    const roundedPrice = Math.round(Number(priceXof));
    const parsedSortOrder = Number.isFinite(Number(sortOrder))
      ? Math.max(0, Math.round(Number(sortOrder)))
      : 99;

    const id = restaurantRepository.createMenuItem({
      rid,
      categoryId,
      name: name.trim(),
      description: String(description || '').trim(),
      priceXof: roundedPrice,
      costPriceXof: Math.max(0, Math.round(Number(costPriceXof || 0))),
      imageUrl: sanitizedImageUrl,
      available: typeof available === 'boolean' ? available : true,
      sortOrder: parsedSortOrder,
      optionsJson: JSON.stringify(cleanOptions),
      optionGroupsJson: JSON.stringify(cleanOptionGroups),
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'MENU_ITEM_CREATED',
      targetType: 'MENU_ITEM',
      targetId: id,
      details: `${name.trim()} (${roundedPrice} FCFA)`,
    });

    broadcastRestaurantEvent(rid, 'menu:updated', { itemId: id });
    return id;
  }

  updateMenuItem(rid: string, itemId: string, body: Record<string, unknown>) {
    const existing = restaurantRepository.findMenuItemById(itemId, rid);
    if (!existing) {
      throw new AppError(404, 'Article introuvable.');
    }

    const {
      categoryId,
      available,
      priceXof,
      costPriceXof,
      name,
      description,
      imageUrl,
      sortOrder,
      options,
      optionGroups,
    } = body || {};

    let validatedCategoryId: string | undefined;
    if (typeof categoryId === 'string' && categoryId.trim()) {
      const cat = restaurantRepository.findCategory(categoryId.trim(), rid);
      if (!cat) {
        throw new AppError(404, 'Catégorie introuvable.');
      }
      validatedCategoryId = categoryId.trim();
    }

    const hasImageUrl =
      body !== null &&
      typeof body === 'object' &&
      Object.prototype.hasOwnProperty.call(body, 'imageUrl');

    restaurantRepository.updateMenuItem(itemId, rid, {
      categoryId: validatedCategoryId,
      available: typeof available === 'boolean' ? available : undefined,
      priceXof:
        priceXof !== undefined &&
        Number.isFinite(Number(priceXof)) &&
        Number(priceXof) >= 0
          ? Math.round(Number(priceXof))
          : undefined,
      costPriceXof:
        costPriceXof !== undefined &&
        Number.isFinite(Number(costPriceXof)) &&
        Number(costPriceXof) >= 0
          ? Math.round(Number(costPriceXof))
          : undefined,
      name:
        typeof name === 'string' && name.trim().length >= 2
          ? name.trim()
          : undefined,
      description:
        typeof description === 'string' ? description.trim() : undefined,
      imageUrl: hasImageUrl
        ? this.sanitizeMenuItemImageUrl(imageUrl)
        : undefined,
      sortOrder:
        sortOrder !== undefined && Number.isFinite(Number(sortOrder))
          ? Math.max(0, Math.round(Number(sortOrder)))
          : undefined,
      optionsJson: Array.isArray(options)
        ? JSON.stringify(this.sanitizeMenuOptions(options))
        : undefined,
      optionGroupsJson: Array.isArray(optionGroups)
        ? JSON.stringify(sanitizeOptionGroups(optionGroups))
        : undefined,
    });

    broadcastRestaurantEvent(rid, 'menu:updated', { itemId });
  }

  deleteMenuItem(auth: AuthContext, itemId: string) {
    const rid = auth.restaurantId!;
    const existing = restaurantRepository.findMenuItemById(itemId, rid);
    if (!existing) {
      throw new AppError(404, 'Article introuvable.');
    }
    const refCount = restaurantRepository.countOrderReferencesForMenuItem(itemId);
    if (refCount > 0) {
      throw new AppError(
        409,
        'Cet article est lié à des commandes existantes ; désactivez sa disponibilité plutôt que de le supprimer.',
      );
    }
    restaurantRepository.deleteMenuItem(itemId, rid);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'MENU_ITEM_DELETED',
      targetType: 'MENU_ITEM',
      targetId: itemId,
      details: existing.name,
    });
    broadcastRestaurantEvent(rid, 'menu:updated', { itemId });
  }

  getOrders(rid: string) {
    return restaurantRepository.findOrdersWithItems(rid);
  }

  async createPosOrder(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const {
      orderType,
      tableId,
      customerName,
      customerPhone,
      discountXof,
      promoCode,
      loyaltyPointsToUse,
      notes,
      items,
      combos,
      idempotencyKey,
    } = body || {};

    const rawItems = Array.isArray(items) ? items : [];
    const rawCombos = Array.isArray(combos) ? combos : [];
    if (rawItems.length === 0 && rawCombos.length === 0) {
      throw new AppError(
        400,
        'La commande doit contenir au moins un article ou une formule.',
      );
    }

    if (idempotencyKey) {
      const existing = restaurantRepository.findOrderByIdempotencyKey(
        rid,
        String(idempotencyKey),
      );
      if (existing) {
        return { order: existing, deduplicated: true };
      }
    }

    const resto = restaurantRepository.findRestaurantTaxAndMode(rid);
    if (tableId) {
      const tbl = restaurantRepository.findTableById(String(tableId), rid);
      if (!tbl) {
        throw new AppError(404, 'Table introuvable pour cet établissement.');
      }
    }

    const now = new Date().toISOString();
    const orderId = generateId('ord');
    const count = restaurantRepository.countOrders(rid);
    const orderNumber = `CMD-${1001 + count}`;

    const db = getDb();
    const activePromos = loadActivePromotions(db, rid);
    let deductionResult: {
      deductedCount: number;
      lowStocksTriggered: Array<{
        id: string;
        name: string;
        quantity: number;
        minThreshold: number;
        unit: string;
        supplierName: string;
      }>;
    } = { deductedCount: 0, lowStocksTriggered: [] };
    let createdTotalXof = 0;
    let createdDiscountXof = 0;
    let createdLines: Array<{
      id: string;
      menuItemId: string;
      name: string;
      station: string;
      unitPriceXof: number;
      optionsSummary: string;
      optionsDeltaXof: number;
      quantity: number;
      lineTotalXof: number;
      notes: string;
    }> = [];

    try {
      db.exec('BEGIN IMMEDIATE');
      let grossXof = 0;
      const lines: typeof createdLines = [];
      const recipeDeductItems: Array<{ menuItemId: string; quantity: number }> = [];

      for (const rawLine of rawItems) {
        const line = rawLine as {
          menuItemId?: unknown;
          comboId?: unknown;
          quantity?: unknown;
          optionIds?: unknown;
          notes?: unknown;
        };
        if (line.comboId) {
          rawCombos.push({
            comboId: line.comboId,
            quantity: line.quantity,
            notes: line.notes,
          });
          continue;
        }
        const qty = Math.max(
          1,
          Math.min(100, Math.floor(Number(line.quantity) || 1)),
        );
        const menuItem = restaurantRepository.findMenuItemWithStation(
          String(line.menuItemId),
          rid,
        );
        if (!menuItem || !menuItem.available) {
          throw new AppError(400, 'Article indisponible dans le catalogue.');
        }

        const reqOptIds: string[] = Array.isArray(line.optionIds)
          ? line.optionIds.map(String)
          : [];
        const { optionsSummary, optionsDeltaXof } = resolveItemOptionsSelection({
          itemName: String(menuItem.name),
          legacyOptionsJson: menuItem.options_json,
          optionGroupsJson: menuItem.option_groups_json,
          selectedOptionIds: reqOptIds,
        });

        const hh = computeHappyHourForItem({
          basePriceXof: Number(menuItem.price_xof),
          categoryId: String(menuItem.category_id),
          promotions: activePromos,
        });
        const unit = hh.effectivePriceXof;
        const lineTotal = (unit + optionsDeltaXof) * qty;
        grossXof += lineTotal;

        lines.push({
          id: generateId('oi'),
          menuItemId: String(menuItem.id),
          name: hh.promoLabel
            ? `${String(menuItem.name)} (${hh.promoLabel})`
            : String(menuItem.name),
          station: String(menuItem.station || 'KITCHEN'),
          unitPriceXof: unit,
          optionsSummary,
          optionsDeltaXof,
          quantity: qty,
          lineTotalXof: lineTotal,
          notes: String(line.notes || '').slice(0, 200),
        });
        recipeDeductItems.push({ menuItemId: String(menuItem.id), quantity: qty });
      }

      if (rawCombos.length > 0) {
        const fallbackItem = db
          .prepare('SELECT id FROM menu_items WHERE restaurant_id = ? LIMIT 1')
          .get(rid) as { id: string } | undefined;

        for (const rawCombo of rawCombos) {
          const cObj = (rawCombo || {}) as {
            comboId?: unknown;
            quantity?: unknown;
            notes?: unknown;
          };
          const combo = operationsRepository.findComboById(
            String(cObj.comboId || ''),
            rid,
          );
          if (!combo || !combo.active) {
            throw new AppError(400, 'Formule indisponible.');
          }
          const qty = Math.max(
            1,
            Math.min(50, Math.floor(Number(cObj.quantity || 1))),
          );
          const linkedMenuItemId =
            combo.items.find((ci) => ci.menuItemId)?.menuItemId ||
            fallbackItem?.id;
          if (!linkedMenuItemId) {
            throw new AppError(
              400,
              'La formule doit être rattachée à au moins un plat du catalogue.',
            );
          }
          const lineTotal = combo.priceXof * qty;
          grossXof += lineTotal;
          lines.push({
            id: generateId('oi'),
            menuItemId: linkedMenuItemId,
            name: `Formule · ${combo.name}`,
            station: 'KITCHEN',
            unitPriceXof: combo.priceXof,
            optionsSummary: combo.items
              .map((ci) => `${ci.quantity}x ${ci.label}`)
              .join(' + '),
            optionsDeltaXof: 0,
            quantity: qty,
            lineTotalXof: lineTotal,
            notes: String(cObj.notes || '').slice(0, 200),
          });
          for (const ci of combo.items) {
            if (ci.menuItemId) {
              recipeDeductItems.push({
                menuItemId: ci.menuItemId,
                quantity: ci.quantity * qty,
              });
            }
          }
        }
      }

      const promoLoyalty = applyOrderPromoAndLoyaltyDiscounts({
        db,
        restaurantId: rid,
        grossXof,
        manualDiscountXof: Number(discountXof || 0),
        promoCode: promoCode ? String(promoCode) : undefined,
        customerPhone: customerPhone ? String(customerPhone) : undefined,
        loyaltyPointsToUse: Number(loyaltyPointsToUse || 0),
        orderId,
        orderNumber,
        nowIso: now,
      });

      const discount = promoLoyalty.discountXof;
      const totalXof = Math.max(0, grossXof - discount);
      const taxRate = Number(resto?.tax_rate_percent || 18);
      const subtotalXof = Math.round(totalXof / (1 + taxRate / 100));
      const taxXof = totalXof - subtotalXof;

      const resolvedOrderType =
        orderType === 'TAKEAWAY' ||
        orderType === 'DELIVERY' ||
        orderType === 'CLICK_COLLECT'
          ? orderType
          : 'DINE_IN';

      restaurantRepository.insertPosOrder({
        orderId,
        rid,
        orderNumber,
        orderType: resolvedOrderType,
        tableId: tableId ? String(tableId) : null,
        customerName: String(customerName || 'Client sur place').slice(0, 80),
        customerPhone: String(customerPhone || '').slice(0, 30),
        promoCode: promoLoyalty.appliedPromoCode,
        loyaltyPointsUsed: promoLoyalty.loyaltyPointsUsed,
        subtotalXof,
        discountXof: discount,
        taxXof,
        totalXof,
        notes: String(notes || '').slice(0, 300),
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
        userId: auth.userId,
        now,
        lines,
      });

      deductionResult = restaurantRepository.deductStocksForOrderItems({
        rid,
        orderNumber,
        items: recipeDeductItems,
        userId: auth.userId,
        now,
      });

      db.exec('COMMIT');
      createdTotalXof = totalXof;
      createdDiscountXof = discount;
      createdLines = lines;
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(500, 'Erreur création commande.');
    }

    if (deductionResult.deductedCount > 0) {
      broadcastRestaurantEvent(rid, 'stock:updated', {
        orderId,
        orderNumber,
        deductedCount: deductionResult.deductedCount,
      });
      for (const low of deductionResult.lowStocksTriggered) {
        await this.dispatchCriticalStockAlert({
          restaurantId: rid,
          auth,
          stockId: low.id,
          stockName: low.name,
          quantity: low.quantity,
          minThreshold: low.minThreshold,
          unit: low.unit,
          supplierName: low.supplierName,
        });
      }
    }

    broadcastRestaurantEvent(rid, 'order:created', {
      orderId,
      orderNumber,
      totalXof: createdTotalXof,
    });

    return {
      deduplicated: false,
      order: {
        id: orderId,
        orderNumber,
        discountXof: createdDiscountXof,
        totalXof: createdTotalXof,
        status: 'PENDING',
        items: createdLines,
      },
    };
  }

  updateOrderStatus(auth: AuthContext, orderId: string, status: unknown) {
    const rid = auth.restaurantId!;
    const valid = [
      'PENDING',
      'IN_PREPARATION',
      'READY',
      'SERVED',
      'CANCELLED',
    ];
    if (!valid.includes(String(status))) {
      throw new AppError(400, 'Statut de commande invalide.');
    }

    const canKitchenOrOrders =
      auth.permissions.includes('kitchen:write') ||
      auth.permissions.includes('orders:write') ||
      auth.permissions.includes('pos:pay');
    if (!canKitchenOrOrders) {
      throw new AppError(403, 'Permission insuffisante.');
    }

    const order = restaurantRepository.findOrderForUpdate(orderId, rid);
    if (!order) {
      throw new AppError(404, 'Commande introuvable.');
    }

    restaurantRepository.updateOrderAndPrepStatus(
      orderId,
      rid,
      String(status),
      order.table_id,
    );

    broadcastRestaurantEvent(rid, 'order:updated', { orderId, status });
    broadcastOrderTrackerEvent(orderId, 'order:updated', { orderId, status });
  }

  getPayments(rid: string) {
    return restaurantRepository.findPayments(rid);
  }

  payOrder(
    auth: AuthContext,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const { amountXof, method, payments: rawParts, idempotencyKey } = body || {};
    const validMethods = ['CASH', 'ORANGE_MONEY', 'MTN_MOMO', 'WAVE', 'CARD'];

    const parts: Array<{ amountXof: number; method: string; label?: string }> = [];
    if (Array.isArray(rawParts) && rawParts.length > 0) {
      for (const p of rawParts) {
        const obj = (p || {}) as { amountXof?: unknown; method?: unknown; label?: unknown };
        const m = String(obj.method || '');
        const amt = Math.round(Number(obj.amountXof || 0));
        if (!validMethods.includes(m)) {
          throw new AppError(400, 'Moyen de paiement invalide dans le partage.');
        }
        if (!Number.isFinite(amt) || amt <= 0) {
          throw new AppError(400, 'Montant de part invalide.');
        }
        parts.push({
          amountXof: amt,
          method: m,
          label: typeof obj.label === 'string' ? obj.label.trim() : undefined,
        });
      }
    } else {
      if (!validMethods.includes(String(method))) {
        throw new AppError(400, 'Moyen de paiement invalide.');
      }
      const payAmount = Math.round(Number(amountXof || 0));
      if (!Number.isFinite(payAmount) || payAmount <= 0) {
        throw new AppError(400, 'Montant invalide.');
      }
      parts.push({ amountXof: payAmount, method: String(method) });
    }

    const totalPayAmount = parts.reduce((s, p) => s + p.amountXof, 0);

    if (idempotencyKey) {
      const existing = restaurantRepository.findPaymentByIdempotencyKey(
        rid,
        String(idempotencyKey),
      );
      if (existing) {
        return { payment: existing, deduplicated: true };
      }
    }

    const resto = restaurantRepository.findRestaurantTaxAndMode(rid);
    const db = getDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      const order = restaurantRepository.findOrderForUpdate(orderId, rid);
      if (!order) {
        throw new AppError(404, 'Commande introuvable.');
      }
      if (order.status === 'CANCELLED') {
        throw new AppError(400, 'Impossible d’encaisser une commande annulée.');
      }

      const remaining = Number(order.total_xof) - Number(order.paid_xof);
      if (remaining <= 0) {
        throw new AppError(409, 'Cette commande est déjà intégralement payée.');
      }
      if (totalPayAmount > remaining) {
        throw new AppError(400, 'Le montant dépasse le solde restant dû.');
      }

      const now = new Date().toISOString();
      const mode = resto?.paydunya_mode === 'LIVE' ? 'LIVE' : 'TEST';
      let runningPaid = Number(order.paid_xof);
      const createdPayments: Array<{
        id: string;
        orderId: string;
        amountXof: number;
        method: string;
        mode: string;
        reference: string;
        fullyPaid: boolean;
      }> = [];

      for (let idx = 0; idx < parts.length; idx++) {
        const part = parts[idx];
        runningPaid += part.amountXof;
        const fullyPaidPart = runningPaid >= Number(order.total_xof);
        const paymentId = generateId('pay');
        const reference = `${mode}-${part.method.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`;
        const partIdemKey = idempotencyKey
          ? parts.length === 1
            ? String(idempotencyKey)
            : `${String(idempotencyKey)}#${idx}`
          : null;

        restaurantRepository.insertPaymentAndSettleOrder({
          paymentId,
          rid,
          orderId,
          amountXof: part.amountXof,
          method: part.method,
          mode,
          reference,
          idempotencyKey: partIdemKey,
          userId: auth.userId,
          newPaid: runningPaid,
          fullyPaid: fullyPaidPart,
          tableId: order.table_id,
          now,
        });

        createdPayments.push({
          id: paymentId,
          orderId,
          amountXof: part.amountXof,
          method: part.method,
          mode,
          reference,
          fullyPaid: fullyPaidPart,
        });
      }

      const fullyPaid = runningPaid >= Number(order.total_xof);
      let pointsEarned = 0;
      if (fullyPaid) {
        pointsEarned = awardLoyaltyPointsOnPaidOrder(db, rid, orderId);
      }

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: parts.length > 1 ? 'MIXED_PAYMENT_RECORDED' : 'PAYMENT_RECORDED',
        targetType: 'ORDER',
        targetId: orderId,
        details: `${totalPayAmount} FCFA (${parts.map((p) => `${p.method}:${p.amountXof}`).join(' + ')})`,
      });

      db.exec('COMMIT');

      for (const cp of createdPayments) {
        broadcastRestaurantEvent(rid, 'payment:created', {
          orderId,
          paymentId: cp.id,
          amountXof: cp.amountXof,
          fullyPaid,
        });
      }
      broadcastOrderTrackerEvent(orderId, 'order:updated', {
        orderId,
        status: fullyPaid ? 'PAID' : order.status,
      });

      return {
        deduplicated: false,
        payment: createdPayments[0],
        payments: createdPayments,
        pointsEarned,
      };
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(500, 'Erreur lors de l’encaissement.');
    }
  }

  refundPayment(auth: AuthContext, paymentId: string) {
    const rid = auth.restaurantId!;
    const db = getDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      const pay = restaurantRepository.findPaymentForRefund(paymentId, rid);
      if (!pay) {
        throw new AppError(404, 'Paiement introuvable.');
      }
      if (pay.status === 'REFUNDED') {
        throw new AppError(409, 'Ce paiement a déjà été remboursé.');
      }

      restaurantRepository.markPaymentRefunded(
        paymentId,
        rid,
        pay.order_id,
        pay.amount_xof,
      );

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'PAYMENT_REFUNDED',
        targetType: 'PAYMENT',
        targetId: paymentId,
        details: `Remboursement de ${pay.amount_xof} FCFA`,
      });

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(500, 'Erreur remboursement.');
    }
  }

  getTables(rid: string) {
    return restaurantRepository.findTablesWithQrAndActiveOrder(rid);
  }

  createTable(rid: string, body: Record<string, unknown>) {
    const { zone, label, capacity, posX, posY, shape } = body || {};
    if (typeof label !== 'string' || label.trim().length < 1) {
      throw new AppError(400, 'Nom de table requis.');
    }
    const cleanPosX = Number.isFinite(Number(posX))
      ? Math.max(0, Math.min(2000, Math.round(Number(posX))))
      : undefined;
    const cleanPosY = Number.isFinite(Number(posY))
      ? Math.max(0, Math.min(2000, Math.round(Number(posY))))
      : undefined;
    const cleanShape = shape === 'RECT' ? 'RECT' : 'ROUND';
    const { tableId, qrToken } = restaurantRepository.createTableWithQr(
      rid,
      String(zone || 'Salle principale').trim(),
      label.trim(),
      Math.max(1, Math.min(24, Number(capacity) || 4)),
      cleanPosX,
      cleanPosY,
      cleanShape,
    );
    broadcastRestaurantEvent(rid, 'table:updated', { tableId });
    return { id: tableId, qrToken };
  }

  updateTable(rid: string, tableId: string, body: Record<string, unknown>) {
    const tbl = restaurantRepository.findTableById(tableId, rid);
    if (!tbl) {
      throw new AppError(404, 'Table introuvable.');
    }
    const { zone, label, capacity, status, posX, posY, shape } = body || {};
    if (status !== undefined && !['AVAILABLE', 'OCCUPIED', 'RESERVED'].includes(String(status))) {
      throw new AppError(400, 'Statut de table invalide.');
    }
    if (label !== undefined && (typeof label !== 'string' || label.trim().length < 1)) {
      throw new AppError(400, 'Nom de table invalide.');
    }

    restaurantRepository.updateTable(tableId, rid, {
      zone: typeof zone === 'string' && zone.trim() ? zone.trim() : undefined,
      label: typeof label === 'string' ? label.trim() : undefined,
      capacity:
        capacity !== undefined && Number.isFinite(Number(capacity))
          ? Math.max(1, Math.min(24, Math.round(Number(capacity))))
          : undefined,
      status: status !== undefined ? String(status) : undefined,
      posX:
        posX !== undefined && Number.isFinite(Number(posX))
          ? Math.max(0, Math.min(2000, Math.round(Number(posX))))
          : undefined,
      posY:
        posY !== undefined && Number.isFinite(Number(posY))
          ? Math.max(0, Math.min(2000, Math.round(Number(posY))))
          : undefined,
      shape: shape === 'RECT' ? 'RECT' : shape === 'ROUND' ? 'ROUND' : undefined,
    });
    broadcastRestaurantEvent(rid, 'table:updated', { tableId });
  }

  deleteTable(auth: AuthContext, tableId: string) {
    const rid = auth.restaurantId!;
    const tbl = restaurantRepository.findTableById(tableId, rid);
    if (!tbl) {
      throw new AppError(404, 'Table introuvable.');
    }
    const activeOrders = restaurantRepository.findActiveOrdersForTable(tableId, rid);
    if (activeOrders.length > 0) {
      throw new AppError(
        409,
        'Impossible de supprimer cette table : elle a une commande en cours. Transférez ou encaissez la commande d’abord.',
      );
    }
    restaurantRepository.deleteTable(tableId, rid);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'TABLE_DELETED',
      targetType: 'TABLE',
      targetId: tableId,
      details: tbl.label,
    });
    broadcastRestaurantEvent(rid, 'table:updated', { tableId });
  }

  transferTable(auth: AuthContext, sourceTableId: string, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const targetTableId = typeof body?.targetTableId === 'string' ? body.targetTableId.trim() : '';
    if (!targetTableId || targetTableId === sourceTableId) {
      throw new AppError(400, 'Veuillez sélectionner une table de destination distincte.');
    }
    const source = restaurantRepository.findTableById(sourceTableId, rid);
    const target = restaurantRepository.findTableById(targetTableId, rid);
    if (!source || !target) {
      throw new AppError(404, 'Table source ou destination introuvable.');
    }
    const sourceOrders = restaurantRepository.findActiveOrdersForTable(sourceTableId, rid);
    if (sourceOrders.length === 0) {
      throw new AppError(400, 'Aucune commande active à transférer sur cette table.');
    }
    const targetOrders = restaurantRepository.findActiveOrdersForTable(targetTableId, rid);
    if (targetOrders.length > 0) {
      throw new AppError(
        409,
        'La table de destination est déjà occupée par une commande active. Utilisez la fusion de tables.',
      );
    }

    const db = getDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      restaurantRepository.transferTableOrders(rid, sourceTableId, targetTableId);
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'TABLE_TRANSFERRED',
        targetType: 'TABLE',
        targetId: sourceTableId,
        details: `${source.label} -> ${target.label}`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors du transfert de table.');
    }

    broadcastRestaurantEvent(rid, 'table:updated', { sourceTableId, targetTableId });
    broadcastRestaurantEvent(rid, 'order:updated', { tableId: targetTableId });
  }

  mergeTables(auth: AuthContext, targetTableId: string, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const sourceTableId = typeof body?.sourceTableId === 'string' ? body.sourceTableId.trim() : '';
    if (!sourceTableId || sourceTableId === targetTableId) {
      throw new AppError(400, 'Veuillez sélectionner une table source distincte à fusionner.');
    }
    const target = restaurantRepository.findTableById(targetTableId, rid);
    const source = restaurantRepository.findTableById(sourceTableId, rid);
    if (!target || !source) {
      throw new AppError(404, 'Table source ou destination introuvable.');
    }

    const sourceOrders = restaurantRepository.findActiveOrdersForTable(sourceTableId, rid);
    if (sourceOrders.length === 0) {
      throw new AppError(400, 'La table source ne possède aucune commande active à fusionner.');
    }
    const targetOrders = restaurantRepository.findActiveOrdersForTable(targetTableId, rid);
    const targetActiveOrderId = targetOrders.length > 0 ? targetOrders[0].id : null;

    const db = getDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      restaurantRepository.mergeTablesOrders(
        rid,
        sourceTableId,
        targetTableId,
        sourceOrders,
        targetActiveOrderId,
      );
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'TABLES_MERGED',
        targetType: 'TABLE',
        targetId: targetTableId,
        details: `${source.label} fusionnée dans ${target.label}`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors de la fusion des tables.');
    }

    broadcastRestaurantEvent(rid, 'table:updated', { sourceTableId, targetTableId });
    broadcastRestaurantEvent(rid, 'order:updated', { tableId: targetTableId });
  }

  updateTableStatus(rid: string, tableId: string, status: unknown) {
    if (!['AVAILABLE', 'OCCUPIED', 'RESERVED'].includes(String(status))) {
      throw new AppError(400, 'Statut de table invalide.');
    }
    restaurantRepository.updateTableStatus(tableId, rid, String(status));
    broadcastRestaurantEvent(rid, 'table:updated', { tableId, status });
  }

  regenerateTableQr(auth: AuthContext, tableId: string) {
    const rid = auth.restaurantId!;
    const tbl = restaurantRepository.findTableById(tableId, rid);
    if (!tbl) {
      throw new AppError(404, 'Table introuvable.');
    }
    const result = restaurantRepository.regenerateTableQr(tableId, rid);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'QR_REGENERATED',
      targetType: 'TABLE',
      targetId: tableId,
      details: `${tbl.label} -> version ${result.version}`,
    });
    return result;
  }

  getStocks(rid: string) {
    return restaurantRepository.findStocksAndMovements(rid);
  }

  private resolveStockAlertRecipients(
    rid: string,
    customEmailsCsv: string,
  ): string[] {
    const parsed = customEmailsCsv
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@'));
    if (parsed.length > 0) {
      return Array.from(new Set(parsed));
    }
    return restaurantRepository.findManagerEmailsForRestaurant(rid);
  }

  async dispatchCriticalStockAlert(params: {
    restaurantId?: string;
    auth?: AuthContext;
    stockId: string;
    stockName: string;
    quantity: number;
    minThreshold: number;
    unit: string;
    supplierName: string;
  }) {
    const rid = params.restaurantId || params.auth?.restaurantId;
    if (!rid) {
      throw new AppError(400, 'Identifiant restaurant requis.');
    }
    const settings = restaurantRepository.findStockAlertSettings(rid);
    const recipients = this.resolveStockAlertRecipients(
      rid,
      settings.recipientEmails,
    );
    const restaurantName = restaurantRepository.findRestaurantNameById(rid);

    let emailResult: {
      dispatched: boolean;
      status: 'SENT' | 'QUEUED_NO_SMTP' | 'SKIPPED' | 'FAILED';
      recipients: string[];
    } = {
      dispatched: false,
      status: 'SKIPPED',
      recipients,
    };

    if (settings.emailEnabled && recipients.length > 0) {
      emailResult = await sendCriticalStockAlertEmail({
        restaurantName,
        stockName: params.stockName,
        quantity: params.quantity,
        minThreshold: params.minThreshold,
        unit: params.unit,
        supplierName: params.supplierName,
        recipients,
        smtpConfig: settings.smtpHost
          ? {
              host: settings.smtpHost,
              port: settings.smtpPort,
              secure: settings.smtpSecure,
              user: settings.smtpUser,
              pass: settings.smtpPass,
              from: settings.smtpFrom,
            }
          : undefined,
      });
    }

    const title = `Stock critique : ${params.stockName}`;
    const message = `${params.stockName} est à ${params.quantity} ${params.unit} (seuil minimal : ${params.minThreshold} ${params.unit}).`;

    let notification = null;
    if (settings.inAppEnabled) {
      notification = restaurantRepository.createNotification({
        rid,
        type: 'STOCK_CRITICAL',
        title,
        message,
        stockId: params.stockId,
        emailDispatched: emailResult.dispatched,
        emailRecipients: emailResult.recipients.join(', '),
        emailStatus: emailResult.status,
      });
    }

    recordAudit(getDb(), {
      actorUserId: params.auth?.userId ?? null,
      actorEmail: params.auth?.email ?? 'system@restomax.ci',
      actorRole: params.auth?.role ?? 'SYSTEM',
      restaurantId: rid,
      action: 'STOCK_CRITICAL_ALERT',
      targetType: 'STOCK',
      targetId: params.stockId,
      details: `${params.stockName}: ${params.quantity}/${params.minThreshold} ${params.unit} (email=${emailResult.status})`,
    });

    broadcastRestaurantEvent(rid, 'stock:alert', {
      stockId: params.stockId,
      name: params.stockName,
      quantity: params.quantity,
      minThreshold: params.minThreshold,
      unit: params.unit,
      notificationId: notification?.id || null,
      emailStatus: emailResult.status,
    });

    return {
      notification,
      emailStatus: emailResult.status,
      recipients: emailResult.recipients,
    };
  }

  async createStockItem(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const {
      name,
      unit,
      stockSection,
      quantity,
      minThreshold,
      unitCostXof,
      supplierName,
    } = body || {};
    if (typeof name !== 'string' || name.trim().length < 2) {
      throw new AppError(400, 'Nom d’ingrédient requis.');
    }
    const cleanName = name.trim().slice(0, 120);
    const cleanUnit = String(unit || 'kg').trim().slice(0, 24);
    if (!cleanUnit) {
      throw new AppError(400, 'Unité de mesure requise.');
    }
    const rawSection = String(stockSection || 'KITCHEN').toUpperCase();
    if (rawSection !== 'KITCHEN' && rawSection !== 'BEVERAGE') {
      throw new AppError(400, 'Section de stock invalide (KITCHEN ou BEVERAGE).');
    }
    const cleanSection: 'KITCHEN' | 'BEVERAGE' =
      rawSection === 'BEVERAGE' ? 'BEVERAGE' : 'KITCHEN';
    const cleanQty = Math.max(0, Number(quantity || 0));
    const cleanThreshold = Math.max(0, Number(minThreshold ?? 5));
    const cleanSupplier = String(supplierName || '').trim().slice(0, 120);

    const id = restaurantRepository.createStockItem({
      rid,
      name: cleanName,
      unit: cleanUnit,
      stockSection: cleanSection,
      quantity: cleanQty,
      minThreshold: cleanThreshold,
      unitCostXof: Math.round(Number(unitCostXof || 0)),
      supplierName: cleanSupplier,
    });

    if (cleanQty <= cleanThreshold) {
      await this.dispatchCriticalStockAlert({
        auth,
        stockId: id,
        stockName: cleanName,
        quantity: cleanQty,
        minThreshold: cleanThreshold,
        unit: cleanUnit,
        supplierName: cleanSupplier,
      });
    }

    return id;
  }

  async moveStock(
    auth: AuthContext,
    stockId: string,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const { movementType, quantity, reason } = body || {};
    const validTypes = ['IN', 'OUT', 'LOSS', 'INVENTORY'];
    if (!validTypes.includes(String(movementType))) {
      throw new AppError(400, 'Type de mouvement invalide.');
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new AppError(400, 'Quantité invalide.');
    }

    const stock = restaurantRepository.findStockById(stockId, rid);
    if (!stock) {
      throw new AppError(404, 'Article de stock introuvable.');
    }

    const delta =
      movementType === 'IN'
        ? qty
        : movementType === 'INVENTORY'
          ? qty - stock.quantity
          : -qty;
    const nextQty = Math.max(0, stock.quantity + delta);

    restaurantRepository.applyStockMovement({
      rid,
      stockId: stock.id,
      nextQty,
      movementType: String(movementType),
      delta,
      reason: String(reason || '').trim(),
      userId: auth.userId,
    });

    let alertTriggered = false;
    if (nextQty <= stock.min_threshold && nextQty !== stock.quantity) {
      alertTriggered = true;
      await this.dispatchCriticalStockAlert({
        auth,
        stockId: stock.id,
        stockName: stock.name,
        quantity: nextQty,
        minThreshold: stock.min_threshold,
        unit: stock.unit,
        supplierName: stock.supplier_name,
      });
    }

    return { quantity: nextQty, alertTriggered };
  }

  updateStockItem(rid: string, stockId: string, body: Record<string, unknown>) {
    const existing = restaurantRepository.findStockById(stockId, rid);
    if (!existing) {
      throw new AppError(404, 'Ingrédient introuvable.');
    }
    const { name, unit, stockSection, minThreshold, unitCostXof, supplierName } =
      body || {};
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2)) {
      throw new AppError(400, 'Nom d’ingrédient invalide.');
    }
    let nextSection: 'KITCHEN' | 'BEVERAGE' | undefined;
    if (stockSection !== undefined) {
      const upper = String(stockSection).toUpperCase();
      if (upper !== 'KITCHEN' && upper !== 'BEVERAGE') {
        throw new AppError(400, 'Section de stock invalide (KITCHEN ou BEVERAGE).');
      }
      nextSection = upper === 'BEVERAGE' ? 'BEVERAGE' : 'KITCHEN';
    }
    restaurantRepository.updateStockItem(stockId, rid, {
      name: typeof name === 'string' ? name.trim().slice(0, 120) : undefined,
      unit:
        typeof unit === 'string' && unit.trim()
          ? unit.trim().slice(0, 24)
          : undefined,
      stockSection: nextSection,
      minThreshold:
        minThreshold !== undefined && Number.isFinite(Number(minThreshold))
          ? Math.max(0, Number(minThreshold))
          : undefined,
      unitCostXof:
        unitCostXof !== undefined && Number.isFinite(Number(unitCostXof))
          ? Math.max(0, Math.round(Number(unitCostXof)))
          : undefined,
      supplierName:
        typeof supplierName === 'string'
          ? supplierName.trim().slice(0, 120)
          : undefined,
    });
    broadcastRestaurantEvent(rid, 'stock:updated', { stockId });
  }

  deleteStockItem(auth: AuthContext, stockId: string) {
    const rid = auth.restaurantId!;
    const existing = restaurantRepository.findStockById(stockId, rid);
    if (!existing) {
      throw new AppError(404, 'Ingrédient introuvable.');
    }
    restaurantRepository.deleteStockItem(stockId, rid);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'STOCK_DELETED',
      targetType: 'STOCK',
      targetId: stockId,
      details: existing.name,
    });
    broadcastRestaurantEvent(rid, 'stock:updated', { stockId });
  }

  getPurchaseOrders(rid: string) {
    this.ensureTenantId(rid);
    return restaurantRepository.findPurchaseOrders(rid);
  }

  createPurchaseOrder(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const { supplierName, notes, expectedDate, status, items } = body || {};
    if (typeof supplierName !== 'string' || supplierName.trim().length < 2) {
      throw new AppError(400, 'Nom du fournisseur requis.');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'Ajoutez au moins une ligne au bon de commande.');
    }

    const cleanItems: Array<{
      id: string;
      stockId: string;
      stockName: string;
      unit: string;
      quantity: number;
      unitCostXof: number;
      lineTotalXof: number;
    }> = [];
    let totalCostXof = 0;

    for (const raw of items) {
      const row = (raw || {}) as {
        stockId?: unknown;
        quantity?: unknown;
        unitCostXof?: unknown;
      };
      const stockId = typeof row.stockId === 'string' ? row.stockId.trim() : '';
      const qty = Number(row.quantity);
      if (!stockId || !Number.isFinite(qty) || qty <= 0) {
        throw new AppError(400, 'Quantité de réapprovisionnement invalide.');
      }
      const stock = restaurantRepository.findStockById(stockId, rid);
      if (!stock) {
        throw new AppError(404, 'Ingrédient introuvable pour ce bon de commande.');
      }
      const unitCost =
        row.unitCostXof !== undefined && Number.isFinite(Number(row.unitCostXof))
          ? Math.max(0, Math.round(Number(row.unitCostXof)))
          : Number(stock.unit_cost_xof || 0);
      const lineTotal = Math.round(qty * unitCost);
      totalCostXof += lineTotal;
      cleanItems.push({
        id: generateId('poi'),
        stockId: stock.id,
        stockName: stock.name,
        unit: stock.unit,
        quantity: Math.round(qty * 1000) / 1000,
        unitCostXof: unitCost,
        lineTotalXof: lineTotal,
      });
    }

    const poId = generateId('po');
    const count = restaurantRepository.countPurchaseOrders(rid);
    const poNumber = `PO-${1001 + count}`;
    const now = new Date().toISOString();
    const initialStatus = status === 'ORDERED' ? 'ORDERED' : 'DRAFT';

    restaurantRepository.insertPurchaseOrder({
      id: poId,
      rid,
      poNumber,
      supplierName: supplierName.trim(),
      status: initialStatus,
      totalCostXof,
      notes: String(notes || '').trim(),
      expectedDate: typeof expectedDate === 'string' && expectedDate.trim() ? expectedDate.trim() : null,
      userId: auth.userId,
      now,
      items: cleanItems,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'PURCHASE_ORDER_CREATED',
      targetType: 'PURCHASE_ORDER',
      targetId: poId,
      details: `${poNumber} · ${supplierName.trim()} (${totalCostXof} FCFA)`,
    });

    return { id: poId, poNumber, totalCostXof, status: initialStatus };
  }

  updatePurchaseOrderStatus(auth: AuthContext, poId: string, status: unknown) {
    const rid = auth.restaurantId!;
    const validStatuses = ['ORDERED', 'RECEIVED', 'CANCELLED'];
    if (!validStatuses.includes(String(status))) {
      throw new AppError(400, 'Statut de bon de commande invalide.');
    }

    const found = restaurantRepository.findPurchaseOrderById(poId, rid);
    if (!found) {
      throw new AppError(404, 'Bon de commande introuvable.');
    }
    if (found.po.status === 'RECEIVED' || found.po.status === 'CANCELLED') {
      throw new AppError(409, 'Ce bon de commande est déjà clôturé.');
    }

    const nextStatus = String(status);
    const now = new Date().toISOString();
    const db = getDb();

    try {
      db.exec('BEGIN IMMEDIATE');
      restaurantRepository.updatePurchaseOrderStatus(
        poId,
        rid,
        nextStatus,
        nextStatus === 'RECEIVED' ? now : null,
      );

      if (nextStatus === 'RECEIVED') {
        for (const item of found.items) {
          const stock = restaurantRepository.findStockById(item.stock_id, rid);
          if (!stock) continue;
          const nextQty = Math.round((Number(stock.quantity) + Number(item.quantity)) * 1000) / 1000;
          restaurantRepository.applyStockMovement({
            rid,
            stockId: stock.id,
            nextQty,
            movementType: 'PURCHASE',
            delta: Number(item.quantity),
            reason: `Réception bon ${found.po.po_number} (${found.po.supplier_name})`,
            userId: auth.userId,
            unitCostXof: item.unit_cost_xof,
          });
        }
      }

      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: `PURCHASE_ORDER_${nextStatus}`,
        targetType: 'PURCHASE_ORDER',
        targetId: poId,
        details: `${found.po.po_number} -> ${nextStatus}`,
      });

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur mise à jour bon de commande.');
    }

    if (nextStatus === 'RECEIVED') {
      broadcastRestaurantEvent(rid, 'stock:updated', { poId });
    }
  }

  getStockAlertConfig(rid: string) {
    this.ensureTenantId(rid);
    const settings = restaurantRepository.findStockAlertSettings(rid);
    const resolvedRecipients = this.resolveStockAlertRecipients(
      rid,
      settings.recipientEmails,
    );
    const recentAlerts = restaurantRepository.findRecentStockAlerts(rid);
    return {
      settings: {
        restaurantId: settings.restaurantId,
        inAppEnabled: settings.inAppEnabled,
        emailEnabled: settings.emailEnabled,
        recipientEmails: settings.recipientEmails,
        resolvedRecipients,
        smtpHost: settings.smtpHost,
        smtpPort: settings.smtpPort,
        smtpSecure: settings.smtpSecure,
        smtpUser: settings.smtpUser,
        smtpFrom: settings.smtpFrom,
        smtpPassConfigured: Boolean(settings.smtpPass && settings.smtpPass.length > 0),
        envSmtpConfigured: isEnvSmtpConfigured(),
        updatedAt: settings.updatedAt,
      },
      recentAlerts,
    };
  }

  updateStockAlertConfig(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const {
      inAppEnabled,
      emailEnabled,
      recipientEmails,
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      smtpPass,
      smtpFrom,
    } = body || {};
    const current = restaurantRepository.findStockAlertSettings(rid);

    const nextSmtpHost =
      typeof smtpHost === 'string' ? smtpHost.trim() : current.smtpHost;
    if (nextSmtpHost && isDisallowedInternalHost(nextSmtpHost)) {
      throw new AppError(
        400,
        'Hôte SMTP refusé pour des raisons de sécurité (boucle locale ou métadonnées).',
      );
    }

    const updated = restaurantRepository.upsertStockAlertSettings({
      rid,
      inAppEnabled:
        typeof inAppEnabled === 'boolean' ? inAppEnabled : current.inAppEnabled,
      emailEnabled:
        typeof emailEnabled === 'boolean' ? emailEnabled : current.emailEnabled,
      recipientEmails:
        typeof recipientEmails === 'string'
          ? recipientEmails.trim()
          : current.recipientEmails,
      smtpHost: nextSmtpHost,
      smtpPort: Number.isFinite(Number(smtpPort))
        ? Math.max(1, Math.min(65535, Number(smtpPort)))
        : current.smtpPort,
      smtpSecure:
        typeof smtpSecure === 'boolean' ? smtpSecure : current.smtpSecure,
      smtpUser:
        typeof smtpUser === 'string' ? smtpUser.trim() : current.smtpUser,
      smtpPass: typeof smtpPass === 'string' ? smtpPass : undefined,
      smtpFrom:
        typeof smtpFrom === 'string' ? smtpFrom.trim() : current.smtpFrom,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'STOCK_ALERT_CONFIG_UPDATED',
      targetType: 'RESTAURANT',
      targetId: rid,
      details: `inApp=${updated.inAppEnabled} email=${updated.emailEnabled} smtp=${updated.smtpHost || 'ENV'}`,
    });

    return {
      restaurantId: updated.restaurantId,
      inAppEnabled: updated.inAppEnabled,
      emailEnabled: updated.emailEnabled,
      recipientEmails: updated.recipientEmails,
      resolvedRecipients: this.resolveStockAlertRecipients(
        rid,
        updated.recipientEmails,
      ),
      smtpHost: updated.smtpHost,
      smtpPort: updated.smtpPort,
      smtpSecure: updated.smtpSecure,
      smtpUser: updated.smtpUser,
      smtpFrom: updated.smtpFrom,
      smtpPassConfigured: Boolean(updated.smtpPass && updated.smtpPass.length > 0),
      envSmtpConfigured: isEnvSmtpConfigured(),
      updatedAt: updated.updatedAt,
    };
  }

  async testStockAlertEmail(auth: AuthContext) {
    const rid = auth.restaurantId!;
    const settings = restaurantRepository.findStockAlertSettings(rid);
    const recipients = this.resolveStockAlertRecipients(
      rid,
      settings.recipientEmails,
    );
    const restaurantName = restaurantRepository.findRestaurantNameById(rid);
    const res = await sendSmtpTestEmail({
      restaurantName,
      recipients,
      smtpConfig: settings.smtpHost
        ? {
            host: settings.smtpHost,
            port: settings.smtpPort,
            secure: settings.smtpSecure,
            user: settings.smtpUser,
            pass: settings.smtpPass,
            from: settings.smtpFrom,
          }
        : undefined,
    });
    return res;
  }

  async triggerManualStockAlert(auth: AuthContext, stockId: string) {
    const rid = auth.restaurantId!;
    const stock = restaurantRepository.findStockById(stockId, rid);
    if (!stock) {
      throw new AppError(404, 'Article de stock introuvable.');
    }
    return this.dispatchCriticalStockAlert({
      auth,
      stockId: stock.id,
      stockName: stock.name,
      quantity: stock.quantity,
      minThreshold: stock.min_threshold,
      unit: stock.unit,
      supplierName: stock.supplier_name,
    });
  }

  getNotifications(rid: string) {
    this.ensureTenantId(rid);
    const notifications =
      restaurantRepository.findNotificationsForRestaurant(rid);
    const unreadCount = notifications.filter((n) => !n.isRead).length;
    return { notifications, unreadCount };
  }

  markNotificationsRead(rid: string, body: Record<string, unknown>) {
    this.ensureTenantId(rid);
    const id = typeof body?.id === 'string' ? body.id : undefined;
    restaurantRepository.markNotificationsRead(rid, id);
    broadcastRestaurantEvent(rid, 'notifications:updated', {
      id: id || null,
    });
  }

  getStaff(rid: string) {
    const rows = restaurantRepository.findStaffMembers(rid);
    const staff = rows.map((r) => ({
      ...r,
      customPermissions: JSON.parse(String(r.custom_permissions_json || '[]')),
    }));
    return { staff, roleCeilings: ROLE_PERMISSION_CEILING };
  }

  getPinDirectory(rid: string) {
    this.ensureTenantId(rid);
    return restaurantRepository.findPinDirectory(rid);
  }

  getPosPinOperators(rid: string) {
    this.ensureTenantId(rid);
    return restaurantRepository.findPosPinOperators(rid);
  }

  createStaff(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const { fullName, email, phone, role, password, pin, customPermissions } =
      body || {};
    const allowedRoles: Role[] = [
      'MANAGER',
      'CASHIER',
      'WAITER',
      'KITCHEN_BAR',
    ];
    if (
      typeof fullName !== 'string' ||
      fullName.trim().length < 2 ||
      typeof email !== 'string' ||
      !email.includes('@') ||
      !allowedRoles.includes(role as Role)
    ) {
      throw new AppError(400, 'Informations employé ou rôle invalide.');
    }

    if (pin !== undefined && pin !== '' && !/^\d{4,6}$/.test(String(pin).trim())) {
      throw new AppError(400, 'Le code PIN caisse doit contenir 4 à 6 chiffres.');
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = restaurantRepository.findUserByEmail(cleanEmail);
    if (existing) {
      throw new AppError(
        409,
        'Un compte utilisateur existe déjà avec cet email.',
      );
    }

    const pwd =
      typeof password === 'string' && password.length >= 8
        ? password
        : 'RestoMax2026!';
    const ceiling = ROLE_PERMISSION_CEILING[role as Role];
    const safeCustom: Permission[] = Array.isArray(customPermissions)
      ? customPermissions.filter((p) => ceiling.includes(p))
      : [];

    const pinHash =
      pin !== undefined && String(pin).trim().length >= 4
        ? bcrypt.hashSync(String(pin).trim(), 10)
        : null;

    const { memberId, userId } = restaurantRepository.createStaffUserAndMember({
      rid,
      email: cleanEmail,
      passwordHash: bcrypt.hashSync(pwd, 10),
      fullName: fullName.trim(),
      phone: String(phone || '').trim() || null,
      role: role as Role,
      customPermissions: safeCustom,
      pinHash,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'STAFF_CREATED',
      targetType: 'USER',
      targetId: userId,
      details: `${fullName.trim()} (${role})`,
    });

    return { id: memberId, userId };
  }

  updateStaff(
    auth: AuthContext,
    memberId: string,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const member = restaurantRepository.findMemberById(memberId, rid);
    if (!member) {
      throw new AppError(404, 'Membre introuvable.');
    }

    const {
      status,
      role,
      customPermissions,
      fullName,
      email,
      phone,
      newPassword,
      pin,
    } = body || {};

    if (member.role === 'OWNER' && (status !== undefined || role !== undefined)) {
      throw new AppError(
        400,
        'Impossible de suspendre ou rétrograder le propriétaire principal.',
      );
    }

    const validStatus =
      status && ['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(String(status))
        ? String(status)
        : undefined;
    const validRole =
      role &&
      ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN_BAR'].includes(String(role))
        ? (String(role) as Role)
        : undefined;

    let cleanEmail: string | undefined;
    if (email !== undefined) {
      if (typeof email !== 'string' || !email.includes('@')) {
        throw new AppError(400, 'Adresse e-mail invalide.');
      }
      const nextEmail = email.trim().toLowerCase();
      if (nextEmail !== member.currentEmail.toLowerCase()) {
        const dup = restaurantRepository.findUserByEmail(nextEmail);
        if (dup && dup.id !== member.user_id) {
          throw new AppError(409, 'Cet e-mail est déjà utilisé par un autre compte.');
        }
        cleanEmail = nextEmail;
      }
    }

    if (fullName !== undefined && (typeof fullName !== 'string' || fullName.trim().length < 2)) {
      throw new AppError(400, 'Nom complet invalide.');
    }

    let passwordHash: string | undefined;
    if (newPassword !== undefined && String(newPassword).trim().length > 0) {
      if (String(newPassword).length < 8) {
        throw new AppError(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères.');
      }
      passwordHash = bcrypt.hashSync(String(newPassword), 10);
    }

    let pinHash: string | null | undefined;
    if (pin !== undefined) {
      const cleanPin = String(pin).trim();
      if (cleanPin === '') {
        pinHash = null;
      } else if (!/^\d{4,6}$/.test(cleanPin)) {
        throw new AppError(400, 'Le code PIN caisse doit contenir 4 à 6 chiffres.');
      } else {
        pinHash = bcrypt.hashSync(cleanPin, 10);
      }
    }

    let boundedPerms: Permission[] | undefined;
    if (Array.isArray(customPermissions)) {
      const targetRole = (validRole || member.role) as Role;
      const ceiling = ROLE_PERMISSION_CEILING[targetRole] || [];
      boundedPerms = customPermissions.filter((p) => ceiling.includes(p));
    }

    restaurantRepository.updateStaffMember(member.id, rid, member.user_id, {
      status: validStatus,
      role: validRole,
      customPermissions: boundedPerms,
      fullName: typeof fullName === 'string' ? fullName.trim() : undefined,
      email: cleanEmail,
      phone: phone !== undefined ? String(phone || '').trim() || null : undefined,
      passwordHash,
      pinHash,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'STAFF_UPDATED',
      targetType: 'MEMBER',
      targetId: member.id,
      details: `status=${status || 'unchanged'} role=${role || 'unchanged'}`,
    });
  }

  deleteStaff(auth: AuthContext, memberId: string) {
    const rid = auth.restaurantId!;
    const member = restaurantRepository.findMemberById(memberId, rid);
    if (!member) {
      throw new AppError(404, 'Membre introuvable.');
    }
    if (member.role === 'OWNER') {
      throw new AppError(400, 'Impossible de supprimer le propriétaire principal.');
    }
    if (member.user_id === auth.userId) {
      throw new AppError(400, 'Vous ne pouvez pas supprimer votre propre compte actif.');
    }

    const db = getDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      restaurantRepository.deleteStaffMember(member.id, rid, member.user_id);
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'STAFF_DELETED',
        targetType: 'MEMBER',
        targetId: member.id,
        details: member.currentEmail,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur suppression membre.');
    }
  }

  getCustomers(rid: string) {
    return restaurantRepository.findCustomers(rid);
  }

  createCustomer(rid: string, body: Record<string, unknown>) {
    const { fullName, phone, email, preferences } = body || {};
    if (typeof fullName !== 'string' || typeof phone !== 'string') {
      throw new AppError(400, 'Nom et téléphone requis.');
    }
    return restaurantRepository.createCustomer({
      rid,
      fullName: fullName.trim(),
      phone: phone.trim(),
      email: String(email || '').trim(),
      preferences: String(preferences || '').trim(),
    });
  }

  updateCustomer(rid: string, customerId: string, body: Record<string, unknown>) {
    const existing = restaurantRepository.findCustomerById(customerId, rid);
    if (!existing) {
      throw new AppError(404, 'Client introuvable.');
    }
    const { fullName, phone, email, preferences } = body || {};
    if (fullName !== undefined && (typeof fullName !== 'string' || fullName.trim().length < 2)) {
      throw new AppError(400, 'Nom du client invalide.');
    }
    if (phone !== undefined && (typeof phone !== 'string' || phone.trim().length < 4)) {
      throw new AppError(400, 'Téléphone invalide.');
    }
    restaurantRepository.updateCustomer(customerId, rid, {
      fullName: typeof fullName === 'string' ? fullName.trim() : undefined,
      phone: typeof phone === 'string' ? phone.trim() : undefined,
      email: typeof email === 'string' ? email.trim() : undefined,
      preferences: typeof preferences === 'string' ? preferences.trim() : undefined,
    });
  }

  deleteCustomer(auth: AuthContext, customerId: string) {
    const rid = auth.restaurantId!;
    const existing = restaurantRepository.findCustomerById(customerId, rid);
    if (!existing) {
      throw new AppError(404, 'Client introuvable.');
    }
    restaurantRepository.deleteCustomer(customerId, rid);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'CUSTOMER_DELETED',
      targetType: 'CUSTOMER',
      targetId: customerId,
    });
  }

  getReservations(rid: string) {
    return restaurantRepository.findReservations(rid);
  }

  async createReservation(rid: string, body: Record<string, unknown>) {
    const {
      customerName,
      customerPhone,
      partySize,
      reservedAt,
      tableId,
      notes,
      notifyWhatsapp,
    } = body || {};
    if (
      typeof customerName !== 'string' ||
      typeof customerPhone !== 'string' ||
      typeof reservedAt !== 'string'
    ) {
      throw new AppError(400, 'Champs de réservation incomplets.');
    }
    const id = restaurantRepository.createReservation({
      rid,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      partySize: Math.max(1, Number(partySize || 2)),
      reservedAt,
      tableId: tableId ? String(tableId) : null,
      notes: String(notes || '').trim(),
    });

    let whatsappResult = null;
    if (notifyWhatsapp === true) {
      whatsappResult = await this.sendReservationWhatsappInternal(rid, id);
    }
    return { id, whatsappResult };
  }

  updateReservationStatus(rid: string, id: string, status: unknown) {
    if (
      !['PENDING', 'CONFIRMED', 'SEATED', 'CANCELLED'].includes(String(status))
    ) {
      throw new AppError(400, 'Statut invalide.');
    }
    restaurantRepository.updateReservationStatus(id, rid, String(status));
  }

  private async sendReservationWhatsappInternal(rid: string, reservationId: string) {
    const reservation = restaurantRepository.findReservationById(reservationId, rid);
    if (!reservation) {
      throw new AppError(404, 'Réservation introuvable.');
    }
    const { resto } = restaurantRepository.findRestaurantSettings(rid);
    const dateText = new Date(reservation.reservedAt).toLocaleString('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const tableInfo = reservation.tableLabel ? ` (Table ${reservation.tableLabel})` : '';
    const statusLabel =
      reservation.status === 'CANCELLED'
        ? 'annulée'
        : reservation.status === 'SEATED'
          ? 'en cours'
          : 'confirmée';
    const messageBody = [
      `Bonjour ${reservation.customerName},`,
      `Votre réservation chez *${String(resto.name || 'Resto’MAX')}* est *${statusLabel}*.`,
      `Date : ${dateText}`,
      `Personnes : ${reservation.partySize}${tableInfo}`,
      resto.address ? `Adresse : ${String(resto.address)}, ${String(resto.city || '')}` : '',
      `À très bientôt !`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await sendWhatsappMessage({
      restaurantId: rid,
      recipientPhone: reservation.customerPhone,
      messageType: 'RESERVATION_CONFIRM',
      body: messageBody,
      config: {
        enabled: Boolean(resto.whatsappEnabled),
        phoneNumberId: String(resto.whatsappPhoneNumberId || ''),
        accessToken: String(resto.whatsappAccessToken || ''),
      },
    });
    return { ...result, body: messageBody };
  }

  async sendReservationWhatsapp(auth: AuthContext, reservationId: string) {
    const rid = auth.restaurantId!;
    const result = await this.sendReservationWhatsappInternal(rid, reservationId);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'WHATSAPP_RESERVATION_SENT',
      targetType: 'RESERVATION',
      targetId: reservationId,
      details: `${result.recipientPhone} -> ${result.status}`,
    });
    return result;
  }

  async sendOrderWhatsappReceipt(
    auth: AuthContext,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const phoneNumber = typeof body?.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
    if (!phoneNumber || phoneNumber.replace(/[^\d]/g, '').length < 6) {
      throw new AppError(400, 'Numéro WhatsApp client valide requis.');
    }
    const found = restaurantRepository.findOrderForReceipt(orderId, rid);
    if (!found) {
      throw new AppError(404, 'Commande introuvable.');
    }
    const { resto } = restaurantRepository.findRestaurantSettings(rid);
    const itemLines = found.items.map(
      (it) =>
        `- ${it.quantity}x ${it.name}${it.optionsSummary ? ` (${it.optionsSummary})` : ''} : ${Number(it.lineTotalXof).toLocaleString('fr-FR')} FCFA`,
    );
    const receiptBody = [
      `*Reçu digital · ${String(resto.name || 'Resto’MAX')}*`,
      `Commande : ${found.order.orderNumber}${found.order.tableLabel ? ` · Table ${found.order.tableLabel}` : ''}`,
      `Client : ${found.order.customerName}`,
      `----------------`,
      ...itemLines,
      `----------------`,
      `Total : *${Number(found.order.totalXof).toLocaleString('fr-FR')} FCFA*`,
      `Payé : ${Number(found.order.paidXof).toLocaleString('fr-FR')} FCFA`,
      `Merci de votre visite !`,
    ].join('\n');

    const result = await sendWhatsappMessage({
      restaurantId: rid,
      recipientPhone: phoneNumber,
      messageType: 'RECEIPT',
      body: receiptBody,
      config: {
        enabled: Boolean(resto.whatsappEnabled),
        phoneNumberId: String(resto.whatsappPhoneNumberId || ''),
        accessToken: String(resto.whatsappAccessToken || ''),
      },
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'WHATSAPP_RECEIPT_SENT',
      targetType: 'ORDER',
      targetId: orderId,
      details: `${result.recipientPhone} -> ${result.status}`,
    });

    return { ...result, body: receiptBody };
  }

  getWhatsappLogs(rid: string) {
    this.ensureTenantId(rid);
    return restaurantRepository.findWhatsappLogs(rid);
  }

  getFinanceSummary(rid: string) {
    const {
      sales,
      todayDate,
      todaySales,
      todayPayments,
      cogsRow,
      expenses,
      byMethod,
    } = restaurantRepository.findFinanceSummary(rid);
    const totalExpenses = expenses.reduce(
      (acc, e) => acc + Number(e.amountXof || 0),
      0,
    );
    return {
      summary: {
        grossSalesXof: Number(sales.gross_sales),
        collectedXof: Number(sales.collected),
        taxCollectedXof: Number(sales.total_tax),
        cogsXof: Number(cogsRow.total_cogs),
        expensesXof: totalExpenses,
        netEstimatedMarginXof:
          Number(sales.gross_sales) - Number(cogsRow.total_cogs) - totalExpenses,
      },
      today: {
        date: todayDate,
        revenueXof: Number(todaySales.revenue_xof),
        collectedXof: Number(todayPayments.collected_xof),
        ordersCount: Number(todaySales.orders_count),
        avgBasketXof: Math.round(Number(todaySales.avg_basket)),
      },
      expenses,
      byMethod,
    };
  }

  createExpense(rid: string, body: Record<string, unknown>) {
    const { category, description, amountXof, expenseDate } = body || {};
    if (
      typeof category !== 'string' ||
      typeof description !== 'string' ||
      !Number.isFinite(Number(amountXof)) ||
      Number(amountXof) <= 0
    ) {
      throw new AppError(400, 'Dépense invalide.');
    }
    return restaurantRepository.createExpense({
      rid,
      category: category.trim(),
      description: description.trim(),
      amountXof: Math.round(Number(amountXof)),
      expenseDate: expenseDate ? String(expenseDate) : undefined,
    });
  }

  updateExpense(rid: string, expenseId: string, body: Record<string, unknown>) {
    const existing = restaurantRepository.findExpenseById(expenseId, rid);
    if (!existing) {
      throw new AppError(404, 'Dépense introuvable.');
    }
    const { category, description, amountXof, expenseDate } = body || {};
    if (
      amountXof !== undefined &&
      (!Number.isFinite(Number(amountXof)) || Number(amountXof) <= 0)
    ) {
      throw new AppError(400, 'Montant de dépense invalide.');
    }
    restaurantRepository.updateExpense(expenseId, rid, {
      category: typeof category === 'string' && category.trim() ? category.trim() : undefined,
      description:
        typeof description === 'string' && description.trim() ? description.trim() : undefined,
      amountXof:
        amountXof !== undefined ? Math.round(Number(amountXof)) : undefined,
      expenseDate:
        typeof expenseDate === 'string' && expenseDate.trim() ? expenseDate.trim() : undefined,
    });
  }

  deleteExpense(auth: AuthContext, expenseId: string) {
    const rid = auth.restaurantId!;
    const existing = restaurantRepository.findExpenseById(expenseId, rid);
    if (!existing) {
      throw new AppError(404, 'Dépense introuvable.');
    }
    restaurantRepository.deleteExpense(expenseId, rid);
    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'EXPENSE_DELETED',
      targetType: 'EXPENSE',
      targetId: expenseId,
    });
  }

  exportOrdersCsv(rid: string): string {
    const rows = restaurantRepository.findOrdersForCsvExport(rid);
    const header = 'Numero,Type,Client,Statut,Total_FCFA,Paye_FCFA,Date';
    const lines = rows.map(
      (r) =>
        `"${r.order_number}","${r.order_type}","${String(r.customer_name).replace(/"/g, '""')}","${r.status}",${r.total_xof},${r.paid_xof},"${r.created_at}"`,
    );
    return [header, ...lines].join('\n');
  }

  getSettings(rid: string) {
    const { resto, sub } = restaurantRepository.findRestaurantSettings(rid);
    return {
      restaurant: {
        id: resto.id,
        name: resto.name,
        slug: resto.slug,
        email: resto.email,
        phone: resto.phone,
        address: resto.address,
        city: resto.city,
        country: resto.country,
        currency: resto.currency,
        timezone: resto.timezone,
        taxRatePercent: resto.taxRatePercent,
        serviceFeePercent: resto.serviceFeePercent,
        openingHours: resto.openingHours,
        paydunyaMode: resto.paydunyaMode,
        paydunyaConfigured: Boolean(
          resto.paydunya_public_key &&
            resto.paydunya_private_key &&
            resto.paydunya_token,
        ),
        whatsappEnabled: Boolean(resto.whatsappEnabled),
        whatsappPhoneNumberId: String(resto.whatsappPhoneNumberId || ''),
        whatsappConfigured: Boolean(
          resto.whatsappPhoneNumberId && resto.whatsappAccessToken,
        ),
        printerSettings: parsePrinterSettings(resto.printerSettingsJson),
        storefrontEnabled: Boolean(resto.storefrontEnabled ?? 1),
        deliveryEnabled: Boolean(resto.deliveryEnabled ?? 1),
        deliveryZones: parseDeliveryZones(resto.deliveryZonesJson),
        pickupSlots: parsePickupSlots(resto.pickupSlotsJson),
        loyaltyEnabled: Boolean(resto.loyaltyEnabled ?? 1),
        loyaltyPointsPer1000Xof: Number(resto.loyaltyPointsPer1000Xof || 10),
        loyaltyXofPerPoint: Number(resto.loyaltyXofPerPoint || 25),
        status: resto.status,
        createdAt: resto.createdAt,
      },
      subscription: sub || null,
    };
  }

  getSubscriptionPortal(rid: string) {
    this.ensureTenantId(rid);
    const portal = restaurantRepository.findSubscriptionPortal(rid);
    const paydunyaCreds = resolvePaydunyaPlatformCredentials();
    return {
      ...portal,
      paydunyaStatus: {
        configured: paydunyaCreds.configured,
        mode: paydunyaCreds.mode,
      },
    };
  }

  async checkoutSubscription(
    auth: AuthContext,
    body: Record<string, unknown>,
    baseUrl = '',
  ) {
    const rid = auth.restaurantId!;
    const { planId, billingCycle, paymentMethod, autoRenew, isRenewal } = body || {};
    if (typeof planId !== 'string' || !planId.trim()) {
      throw new AppError(400, 'Plan d’abonnement requis.');
    }
    const plan = restaurantRepository.findPlanById(planId.trim());
    if (!plan) {
      throw new AppError(404, 'Plan tarifaire introuvable.');
    }
    const cycle: 'MONTHLY' | 'YEARLY' =
      billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    const validMethods = ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'CARD'];
    if (!validMethods.includes(String(paymentMethod))) {
      throw new AppError(400, 'Moyen de paiement SaaS invalide.');
    }
    const amountXof =
      cycle === 'YEARLY'
        ? Number(plan.price_yearly_xof)
        : Number(plan.price_monthly_xof);

    const now = new Date();
    const days = cycle === 'YEARLY' ? 365 : 30;
    const existingSub = restaurantRepository.findCurrentSubscriptionRow(rid);
    const renewalFlag = Boolean(isRenewal);
    const baseStartMs =
      renewalFlag && existingSub?.current_period_end
        ? Math.max(now.getTime(), new Date(existingSub.current_period_end).getTime())
        : now.getTime();
    const periodStart = now.toISOString();
    const periodEnd = new Date(baseStartMs + days * 86_400_000).toISOString();

    const { resto } = restaurantRepository.findRestaurantSettings(rid);
    const invoiceId = generateId('inv');
    const year = now.getFullYear();
    const seq = Math.floor(1000 + Math.random() * 9000);
    const invoiceNumber = `INV-${year}-${seq}`;

    let pdxInit;
    try {
      pdxInit = await createPaydunyaSubscriptionCheckout({
        invoiceId,
        invoiceNumber,
        restaurantId: rid,
        restaurantName: String(resto?.name || 'Restaurant'),
        planId: plan.id,
        planName: plan.name,
        billingCycle: cycle,
        amountXof,
        paymentMethod: String(paymentMethod),
        baseUrl: baseUrl || process.env.APP_URL || 'http://localhost:3000',
        isRenewal: renewalFlag,
      });
    } catch (err) {
      throw new AppError(
        502,
        err instanceof Error
          ? err.message
          : 'Erreur de communication avec PayDunya.',
      );
    }

    const db = getDb();
    if (!pdxInit.simulated && pdxInit.checkoutUrl) {
      // Real PayDunya checkout URL returned: persist PENDING invoice until IPN webhook or manual confirmation
      try {
        db.exec('BEGIN IMMEDIATE');
        restaurantRepository.createPendingSubscriptionInvoice({
          invoiceId,
          invoiceNumber,
          rid,
          subscriptionId: existingSub?.id || null,
          planId: plan.id,
          billingCycle: cycle,
          amountXof,
          paymentMethod: String(paymentMethod),
          mode: pdxInit.mode,
          paydunyaToken: pdxInit.paydunyaToken,
          checkoutUrl: pdxInit.checkoutUrl,
          isRenewal: renewalFlag,
          now: now.toISOString(),
        });
        recordAudit(db, {
          actorUserId: auth.userId,
          actorEmail: auth.email,
          actorRole: auth.role,
          restaurantId: rid,
          action: 'SAAS_PAYDUNYA_INITIATED',
          targetType: 'INVOICE',
          targetId: invoiceId,
          details: `${plan.name} (${cycle}) · ${amountXof} FCFA · ${invoiceNumber}`,
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        if (err instanceof AppError) throw err;
        throw new AppError(500, 'Erreur lors de la création de la facture PayDunya.');
      }

      return {
        status: 'PENDING_PAYMENT',
        providerMode: pdxInit.providerMode,
        invoiceId,
        invoiceNumber,
        paydunyaToken: pdxInit.paydunyaToken,
        checkoutUrl: pdxInit.checkoutUrl,
        planName: plan.name,
        billingCycle: cycle,
        amountXof,
      };
    }

    // Simulated Sandbox mode (no live PayDunya credentials in .env): activate immediately
    let result: { subscriptionId: string; invoiceId: string; invoiceNumber: string };
    try {
      db.exec('BEGIN IMMEDIATE');
      result = restaurantRepository.activateRestaurantSubscriptionCheckout({
        rid,
        planId: plan.id,
        billingCycle: cycle,
        amountXof,
        paymentMethod: String(paymentMethod),
        mode: pdxInit.mode,
        paydunyaToken: pdxInit.paydunyaToken,
        autoRenew: typeof autoRenew === 'boolean' ? autoRenew : undefined,
        isRenewal: renewalFlag,
        periodStart,
        periodEnd,
        now: now.toISOString(),
      });
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: renewalFlag ? 'SAAS_SUBSCRIPTION_RENEWED' : 'SAAS_SUBSCRIPTION_PAID',
        targetType: 'SUBSCRIPTION',
        targetId: result.subscriptionId,
        details: `${plan.name} (${cycle}) · ${amountXof} FCFA · ${result.invoiceNumber} · ${pdxInit.providerMode}`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors du règlement de l’abonnement.');
    }

    return {
      status: 'PAID',
      providerMode: pdxInit.providerMode,
      ...result,
      paydunyaToken: pdxInit.paydunyaToken,
      checkoutUrl: null,
      planName: plan.name,
      billingCycle: cycle,
      amountXof,
      currentPeriodEnd: periodEnd,
    };
  }

  async verifySubscriptionPayment(
    auth: AuthContext,
    body: Record<string, unknown>,
  ) {
    const rid = auth.restaurantId!;
    const invoiceId =
      typeof body?.invoiceId === 'string' ? body.invoiceId.trim() : '';
    const token =
      typeof body?.paydunyaToken === 'string' ? body.paydunyaToken.trim() : '';
    if (!invoiceId && !token) {
      throw new AppError(400, 'Identifiant de facture ou jeton PayDunya requis.');
    }

    const invoice = restaurantRepository.findSubscriptionInvoiceByIdOrToken({
      rid,
      invoiceId: invoiceId || undefined,
      paydunyaToken: token || undefined,
    });
    if (!invoice) {
      throw new AppError(404, 'Facture PayDunya introuvable.');
    }
    if (String(invoice.status) === 'PAID') {
      return {
        status: 'PAID',
        alreadyPaid: true,
        invoiceId: String(invoice.id),
        invoiceNumber: String(invoice.invoice_number),
      };
    }

    const pdxToken = String(invoice.paydunya_token || token);
    const confirm = await confirmPaydunyaInvoice(pdxToken);
    if (!confirm.completed) {
      return {
        status: confirm.status === 'cancelled' ? 'CANCELLED' : 'PENDING_PAYMENT',
        alreadyPaid: false,
        invoiceId: String(invoice.id),
        invoiceNumber: String(invoice.invoice_number),
        message: confirm.providerMessage || 'Paiement encore en attente chez PayDunya.',
      };
    }

    const now = new Date();
    const cycle: 'MONTHLY' | 'YEARLY' =
      invoice.billing_cycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    const days = cycle === 'YEARLY' ? 365 : 30;
    const existingSub = restaurantRepository.findCurrentSubscriptionRow(rid);
    const isRenewal = Boolean(invoice.is_renewal);
    const baseStartMs =
      isRenewal && existingSub?.current_period_end
        ? Math.max(now.getTime(), new Date(existingSub.current_period_end).getTime())
        : now.getTime();
    const periodEnd = new Date(baseStartMs + days * 86_400_000).toISOString();
    const planId = String(invoice.plan_id || existingSub?.plan_id || 'plan_essentiel');

    const db = getDb();
    let subscriptionId: string;
    try {
      db.exec('BEGIN IMMEDIATE');
      subscriptionId = restaurantRepository.completePendingSubscriptionInvoice({
        invoiceId: String(invoice.id),
        rid,
        planId,
        billingCycle: cycle,
        paymentMethod: String(invoice.payment_method || 'WAVE'),
        paydunyaToken: pdxToken,
        periodStart: now.toISOString(),
        periodEnd,
        now: now.toISOString(),
      });
      recordAudit(db, {
        actorUserId: auth.userId,
        actorEmail: auth.email,
        actorRole: auth.role,
        restaurantId: rid,
        action: 'SAAS_PAYDUNYA_CONFIRMED',
        targetType: 'INVOICE',
        targetId: String(invoice.id),
        details: `Facture ${String(invoice.invoice_number)} confirmée via PayDunya`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors de l’activation de l’abonnement.');
    }

    return {
      status: 'PAID',
      alreadyPaid: false,
      subscriptionId,
      invoiceId: String(invoice.id),
      invoiceNumber: String(invoice.invoice_number),
      currentPeriodEnd: periodEnd,
    };
  }

  updateSubscriptionAutoRenew(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    if (typeof body?.autoRenew !== 'boolean') {
      throw new AppError(400, 'Valeur autoRenew booléenne requise.');
    }
    const preferredPaymentMethod =
      typeof body?.preferredPaymentMethod === 'string' &&
      ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'CARD'].includes(
        body.preferredPaymentMethod,
      )
        ? body.preferredPaymentMethod
        : undefined;

    const subId = restaurantRepository.updateSubscriptionAutoRenew(
      rid,
      body.autoRenew,
      preferredPaymentMethod,
    );
    if (!subId) {
      throw new AppError(404, 'Aucun abonnement actif à mettre à jour.');
    }

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'SAAS_AUTORENEW_UPDATED',
      targetType: 'SUBSCRIPTION',
      targetId: subId,
      details: `Renouvellement auto: ${body.autoRenew ? 'ACTIF' : 'INACTIF'}${preferredPaymentMethod ? ` (${preferredPaymentMethod})` : ''}`,
    });

    return { ok: true, autoRenew: body.autoRenew };
  }

  async renewSubscriptionNow(
    auth: AuthContext,
    body: Record<string, unknown>,
    baseUrl = '',
  ) {
    const rid = auth.restaurantId!;
    const current = restaurantRepository.findCurrentSubscriptionRow(rid);
    if (!current) {
      throw new AppError(404, 'Aucun abonnement à renouveler.');
    }
    const method =
      typeof body?.paymentMethod === 'string' &&
      ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'CARD'].includes(body.paymentMethod)
        ? body.paymentMethod
        : current.preferred_payment_method || 'WAVE';

    return this.checkoutSubscription(
      auth,
      {
        planId: current.plan_id,
        billingCycle: current.billing_cycle,
        paymentMethod: method,
        autoRenew: Boolean(current.auto_renew),
        isRenewal: true,
      },
      baseUrl,
    );
  }

  updateSettings(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const {
      name,
      phone,
      address,
      city,
      openingHours,
      taxRatePercent,
      paydunyaMode,
      paydunyaPublicKey,
      paydunyaPrivateKey,
      paydunyaToken,
      printerSettings,
      whatsappEnabled,
      whatsappPhoneNumberId,
      whatsappAccessToken,
      storefrontEnabled,
      deliveryEnabled,
      deliveryZones,
      pickupSlots,
      loyaltyEnabled,
      loyaltyPointsPer1000Xof,
      loyaltyXofPerPoint,
    } = body || {};

    let printerSettingsJson: string | undefined;
    if (printerSettings && typeof printerSettings === 'object') {
      const parsedPrinter = parsePrinterSettings(JSON.stringify(printerSettings));
      if (parsedPrinter.printerHost && isDisallowedInternalHost(parsedPrinter.printerHost)) {
        throw new AppError(
          400,
          'Adresse d’imprimante refusée pour des raisons de sécurité.',
        );
      }
      printerSettingsJson = JSON.stringify(parsedPrinter);
    }

    restaurantRepository.updateRestaurantSettings(rid, {
      name: name ? String(name).trim() : null,
      phone: phone !== undefined ? String(phone).trim() : null,
      address: address !== undefined ? String(address).trim() : null,
      city: city ? String(city).trim() : null,
      openingHours: openingHours ? String(openingHours).trim() : null,
      taxRatePercent: Number.isFinite(Number(taxRatePercent))
        ? Number(taxRatePercent)
        : null,
      paydunyaMode:
        paydunyaMode === 'LIVE' || paydunyaMode === 'TEST'
          ? paydunyaMode
          : null,
      paydunyaPublicKey: paydunyaPublicKey ? String(paydunyaPublicKey) : undefined,
      paydunyaPrivateKey: paydunyaPrivateKey
        ? String(paydunyaPrivateKey)
        : undefined,
      paydunyaToken: paydunyaToken ? String(paydunyaToken) : undefined,
      printerSettingsJson,
      whatsappEnabled: typeof whatsappEnabled === 'boolean' ? whatsappEnabled : undefined,
      whatsappPhoneNumberId:
        whatsappPhoneNumberId !== undefined
          ? String(whatsappPhoneNumberId).replace(/[^\d]/g, '')
          : undefined,
      whatsappAccessToken:
        typeof whatsappAccessToken === 'string' && whatsappAccessToken.trim()
          ? whatsappAccessToken.trim()
          : undefined,
      storefrontEnabled:
        typeof storefrontEnabled === 'boolean' ? storefrontEnabled : undefined,
      deliveryEnabled:
        typeof deliveryEnabled === 'boolean' ? deliveryEnabled : undefined,
      deliveryZonesJson: Array.isArray(deliveryZones)
        ? JSON.stringify(parseDeliveryZones(deliveryZones))
        : undefined,
      pickupSlotsJson: Array.isArray(pickupSlots)
        ? JSON.stringify(parsePickupSlots(pickupSlots))
        : undefined,
      loyaltyEnabled:
        typeof loyaltyEnabled === 'boolean' ? loyaltyEnabled : undefined,
      loyaltyPointsPer1000Xof:
        loyaltyPointsPer1000Xof !== undefined &&
        Number.isFinite(Number(loyaltyPointsPer1000Xof))
          ? Math.max(0, Math.min(200, Math.round(Number(loyaltyPointsPer1000Xof))))
          : undefined,
      loyaltyXofPerPoint:
        loyaltyXofPerPoint !== undefined &&
        Number.isFinite(Number(loyaltyXofPerPoint))
          ? Math.max(1, Math.min(1000, Math.round(Number(loyaltyXofPerPoint))))
          : undefined,
    });

    recordAudit(getDb(), {
      actorUserId: auth.userId,
      actorEmail: auth.email,
      actorRole: auth.role,
      restaurantId: rid,
      action: 'SETTINGS_UPDATED',
      targetType: 'RESTAURANT',
      targetId: rid,
    });
  }

  async printEscposTicket(auth: AuthContext, body: Record<string, unknown>) {
    const rid = auth.restaurantId!;
    const { resto } = restaurantRepository.findRestaurantSettings(rid);
    const printer = parsePrinterSettings(resto.printerSettingsJson);
    const kind = body?.kind === 'KITCHEN' ? 'KITCHEN' : 'RECEIPT';

    const formatted =
      kind === 'KITCHEN'
        ? buildEscPosKitchenPayload({
            paperWidth: printer.paperWidth,
            restaurantName: String(resto.name || 'Resto’MAX'),
            stationLabel: String(body?.stationLabel || 'CUISINE'),
            orderNumber: String(body?.orderNumber || 'TEST-001'),
            tableLabel: body?.tableLabel ? String(body.tableLabel) : null,
            customerName: body?.customerName ? String(body.customerName) : undefined,
            notes: body?.notes ? String(body.notes) : undefined,
            createdAt: new Date().toISOString(),
            items: Array.isArray(body?.items)
              ? (body.items as Array<{
                  name: string;
                  quantity: number;
                  optionsSummary?: string;
                  notes?: string;
                }>)
              : [{ name: 'Test connexion imprimante thermique', quantity: 1 }],
          })
        : buildEscPosReceiptPayload({
            paperWidth: printer.paperWidth,
            restaurantName: String(resto.name || 'Resto’MAX'),
            restaurantCity: String(resto.city || ''),
            restaurantPhone: String(resto.phone || ''),
            orderNumber: String(body?.orderNumber || 'TEST-001'),
            tableLabel: body?.tableLabel ? String(body.tableLabel) : null,
            customerName: body?.customerName ? String(body.customerName) : undefined,
            createdAt: new Date().toISOString(),
            paymentMethod: body?.paymentMethod ? String(body.paymentMethod) : undefined,
            paymentReference: body?.paymentReference ? String(body.paymentReference) : undefined,
            paidAmountXof:
              typeof body?.paidAmountXof === 'number'
                ? body.paidAmountXof
                : undefined,
            totalXof: Number(body?.totalXof || 0),
            items: Array.isArray(body?.items)
              ? (body.items as Array<{
                  name: string;
                  quantity: number;
                  lineTotalXof: number;
                  optionsSummary?: string;
                }>)
              : [
                  {
                    name: 'Test impression thermique ESC/POS',
                    quantity: 1,
                    lineTotalXof: 0,
                  },
                ],
          });

    const canOverridePrinterHost = auth.permissions.includes('settings:write');
    const requestedHost =
      canOverridePrinterHost &&
      typeof body?.printerHost === 'string' &&
      body.printerHost.trim()
        ? body.printerHost.trim()
        : printer.printerHost;
    if (requestedHost && isDisallowedInternalHost(requestedHost)) {
      throw new AppError(
        400,
        'Adresse d’imprimante refusée pour des raisons de sécurité.',
      );
    }
    const overrideHost = requestedHost;
    const overridePort = canOverridePrinterHost
      ? Math.max(1, Math.min(65535, Math.round(Number(body?.printerPort || printer.printerPort || 9100))))
      : printer.printerPort;
    const mode =
      (canOverridePrinterHost && body?.sendNetwork === true) ||
      printer.connectionType === 'NETWORK_ESCPOS'
        ? 'NETWORK_ESCPOS'
        : printer.connectionType;

    let networkResult: { ok: boolean; bytesSent: number; error?: string } | null =
      null;
    if (mode === 'NETWORK_ESCPOS' && overrideHost) {
      networkResult = await sendRawBytesOverTcp(
        overrideHost,
        overridePort,
        formatted.bytes,
      );
    }

    return {
      ok: networkResult ? networkResult.ok : true,
      mode,
      paperWidth: printer.paperWidth,
      previewText: formatted.previewText,
      base64Bytes: Buffer.from(formatted.bytes).toString('base64'),
      networkResult,
    };
  }

  getTickets(rid: string) {
    return restaurantRepository.findTicketsForRestaurant(rid);
  }

  createTicket(auth: AuthContext, body: Record<string, unknown>) {
    const { subject, category, priority, message } = body || {};
    if (typeof subject !== 'string' || typeof message !== 'string') {
      throw new AppError(400, 'Sujet et message requis.');
    }
    return restaurantRepository.createSupportTicket({
      rid: auth.restaurantId!,
      email: auth.email,
      fullName: auth.fullName,
      role: auth.role,
      subject: subject.trim(),
      category: String(category || 'Général'),
      priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(String(priority))
        ? String(priority)
        : 'MEDIUM',
      message: message.trim(),
    });
  }
}

export const restaurantService = new RestaurantService();
