import QRCode from 'qrcode';
import { getDb, generateId } from '../db.ts';
import { recordAudit } from '../auth.ts';
import {
  PublicRepository,
  publicRepository,
} from '../repositories/publicRepository.ts';
import { restaurantRepository } from '../repositories/restaurantRepository.ts';
import { operationsRepository } from '../repositories/operationsRepository.ts';
import { restaurantService } from './restaurantService.ts';
import {
  applyOrderPromoAndLoyaltyDiscounts,
  awardLoyaltyPointsOnPaidOrder,
  computeHappyHourForItem,
  loadActivePromotions,
  normalizePhoneKey,
  parseDeliveryZones,
  parseOptionGroups,
  parsePickupSlots,
  resolveItemOptionsSelection,
  resolveLoyaltyForPhone,
} from './pricingEngine.ts';
import { broadcastOrderTrackerEvent, broadcastRestaurantEvent } from '../ws.ts';
import { verifyPaydunyaIpnSignature } from './paydunyaService.ts';
import { knexPublicRepository } from '../repositories/publicRepository.knex.ts';
import { knexOperationsReadRepository } from '../repositories/operationsRepository.knex.ts';
import { BaseService } from './BaseService.ts';
import { AppError } from './errors.ts';

function isLegacyPublicTestRuntime(): boolean {
  const client = (process.env.DATABASE_CLIENT || 'sqlite').toLowerCase();
  return process.env.NODE_ENV === 'test' && !['pg', 'postgres', 'postgresql'].includes(client);
}

const publicReadRepository = (
  isLegacyPublicTestRuntime() ? publicRepository : knexPublicRepository
) as unknown as typeof publicRepository;

export class PublicService extends BaseService<PublicRepository> {
  constructor(repo = publicRepository) {
    super(repo);
  }

  async getActivePlans() {
    const rows = await publicReadRepository.findActivePlans();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      tagline: r.tagline,
      priceMonthlyXof: Number(r.price_monthly_xof),
      priceYearlyXof: Number(r.price_yearly_xof),
      trialDays: Number(r.trial_days),
      maxTables: Number(r.max_tables),
      maxStaff: Number(r.max_staff),
      maxMenuItems: Number(r.max_menu_items),
      isDemoPricing: Boolean(r.is_demo_pricing),
      isFeatured: Boolean(r.is_featured),
      features: JSON.parse(String(r.features_json || '[]')),
      active: Boolean(r.active),
    }));
  }

  async getPlatformSettings(): Promise<Record<string, string>> {
    const allowedPublicKeys = new Set([
      'contact_email',
      'contact_phone',
      'commercial_region',
      'default_trial_days',
      'platform_currency',
      'maintenance_mode',
      'platform_announcement',
    ]);
    const rows = await publicReadRepository.findAllPlatformSettings();
    const settings: Record<string, string> = {};
    for (const row of rows) {
      if (allowedPublicKeys.has(row.key)) {
        settings[row.key] = row.value;
      }
    }
    return settings;
  }

  async submitContactLead(body: Record<string, unknown>) {
    const { fullName, email, phone, restaurantName, city, message, website } =
      body || {};
    if (website) {
      return { ok: true, honeypot: true };
    }
    if (
      typeof fullName !== 'string' ||
      fullName.trim().length < 2 ||
      typeof email !== 'string' ||
      !email.includes('@') ||
      typeof message !== 'string' ||
      message.trim().length < 5
    ) {
      throw new AppError(
        400,
        'Veuillez renseigner votre nom, un email valide et un message.',
      );
    }

    const id = await publicReadRepository.createLead({
      leadType: 'CONTACT',
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: String(phone || '').trim(),
      restaurantName: String(restaurantName || '').trim(),
      city: String(city || '').trim(),
      message: message.trim(),
    });

    return {
      ok: true,
      id,
      message:
        'Votre message a bien été enregistré. Notre équipe vous répondra rapidement.',
    };
  }

  async submitDemoRequest(body: Record<string, unknown>) {
    const { fullName, email, phone, restaurantName, city, message, website } =
      body || {};
    if (website) {
      return { ok: true, honeypot: true };
    }
    if (
      typeof fullName !== 'string' ||
      fullName.trim().length < 2 ||
      typeof email !== 'string' ||
      !email.includes('@') ||
      typeof restaurantName !== 'string' ||
      restaurantName.trim().length < 2
    ) {
      throw new AppError(
        400,
        'Veuillez renseigner votre nom, email et le nom du restaurant.',
      );
    }

    const id = await publicReadRepository.createLead({
      leadType: 'DEMO_REQUEST',
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: String(phone || '').trim(),
      restaurantName: restaurantName.trim(),
      city: String(city || 'Abidjan').trim(),
      message: String(message || 'Demande de démonstration guidée').trim(),
    });

    return {
      ok: true,
      id,
      message: 'Demande de démonstration enregistrée avec succès.',
    };
  }

  async generateQrSvg(token: string, baseUrl: string): Promise<string> {
    const qrRow = await publicReadRepository.findQrContextByToken(token);
    if (!qrRow) {
      throw new AppError(404, 'QR code introuvable ou invalide.');
    }
    if (qrRow.qr_status !== 'ACTIVE') {
      throw new AppError(410, 'Ce QR code a été révoqué.');
    }

    try {
      const cleanBase = baseUrl.replace(/\/+$/, '');
      const targetUrl = `${cleanBase}/q/${encodeURIComponent(token)}`;
      return await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 2,
        color: { dark: '#182333', light: '#FFFFFF' },
      });
    } catch {
      throw new AppError(500, 'Impossible de générer le QR code.');
    }
  }

  private async mapPublicCatalog(restaurantId: string) {
    const categories = await publicReadRepository.findActiveCategories(restaurantId);
    const itemsRaw = await publicReadRepository.findAvailableMenuItems(restaurantId);
    const activePromos = isLegacyPublicTestRuntime()
      ? loadActivePromotions(getDb(), restaurantId)
      : (await knexOperationsReadRepository.findPromotions(restaurantId)).filter((promo) => promo.active);
    const items = itemsRaw.map((it) => {
      const basePrice = Number(it.price_xof);
      const hh = computeHappyHourForItem({
        basePriceXof: basePrice,
        categoryId: String(it.category_id),
        promotions: activePromos,
      });
      return {
        id: String(it.id),
        categoryId: String(it.category_id),
        name: String(it.name),
        description: String(it.description || ''),
        priceXof: basePrice,
        effectivePriceXof: hh.effectivePriceXof,
        promoLabel: hh.promoLabel,
        imageUrl: it.image_url ? String(it.image_url) : null,
        station: String(it.station || 'KITCHEN'),
        options: JSON.parse(String(it.options_json || '[]')),
        optionGroups: parseOptionGroups(it.option_groups_json),
      };
    });
    const combos = isLegacyPublicTestRuntime()
      ? operationsRepository.findCombos(restaurantId, true)
      : await knexOperationsReadRepository.findCombos(restaurantId, true);
    return { categories, items, combos };
  }

  private assertRestaurantOpen(row: Record<string, unknown>) {
    if (
      row.deleted_at ||
      row.restaurant_status === 'SUSPENDED' ||
      row.restaurant_status === 'DELETED' ||
      row.status === 'SUSPENDED' ||
      row.status === 'DELETED'
    ) {
      throw new AppError(
        403,
        'Cet établissement n’accepte pas de commandes en ligne actuellement.',
      );
    }
  }

  async getQrMenuContext(token: string) {
    const qrRow = await publicReadRepository.findQrContextByToken(token);
    if (!qrRow) {
      throw new AppError(404, 'QR code introuvable ou invalide.');
    }
    if (qrRow.qr_status !== 'ACTIVE') {
      throw new AppError(
        410,
        'Ce QR code a été révoqué. Veuillez demander le nouveau QR code de votre table.',
      );
    }
    this.assertRestaurantOpen(qrRow);

    const restaurantId = String(qrRow.restaurant_id);
    const tableId = String(qrRow.table_id);
    const expiresAt = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    const sessionId = await publicReadRepository.createQrTableSession({
      restaurantId,
      tableId,
      qrToken: token,
      expiresAt,
    });

    const catalog = await this.mapPublicCatalog(restaurantId);
    const ratingSummary = await publicReadRepository.findPublicRatingStats(restaurantId);
    const waiters = await publicReadRepository.findServiceWaiterNames(restaurantId);

    return {
      sessionId,
      restaurant: {
        id: restaurantId,
        name: qrRow.restaurant_name,
        slug: qrRow.restaurant_slug,
        city: qrRow.city,
        currency: qrRow.currency,
        taxRatePercent: Number(qrRow.tax_rate_percent),
        openingHours: qrRow.opening_hours,
        loyaltyEnabled: Boolean(qrRow.loyalty_enabled ?? 1),
        loyaltyPointsPer1000Xof: Number(qrRow.loyalty_points_per_1000_xof || 10),
        loyaltyXofPerPoint: Number(qrRow.loyalty_xof_per_point || 25),
      },
      table: {
        id: tableId,
        label: qrRow.table_label,
        zone: qrRow.table_zone,
      },
      ratingSummary,
      waiters,
      categories: catalog.categories,
      items: catalog.items,
      combos: catalog.combos,
    };
  }

  async getStorefrontContext(slug: string) {
    const resto = await publicReadRepository.findStorefrontBySlug(slug);
    if (!resto) {
      throw new AppError(404, 'Vitrine restaurant introuvable.');
    }
    this.assertRestaurantOpen(resto);
    if (!resto.storefront_enabled) {
      throw new AppError(
        403,
        'La commande en ligne (Click & Collect / Livraison) est désactivée pour cet établissement.',
      );
    }

    const restaurantId = String(resto.id);
    const catalog = await this.mapPublicCatalog(restaurantId);
    const ratingSummary = await publicReadRepository.findPublicRatingStats(restaurantId);

    return {
      restaurant: {
        id: restaurantId,
        name: String(resto.name),
        slug: String(resto.slug),
        city: String(resto.city || ''),
        address: String(resto.address || ''),
        phone: String(resto.phone || ''),
        currency: String(resto.currency || 'XOF'),
        taxRatePercent: Number(resto.tax_rate_percent || 18),
        openingHours: String(resto.opening_hours || ''),
        storefrontEnabled: Boolean(resto.storefront_enabled),
        deliveryEnabled: Boolean(resto.delivery_enabled),
        deliveryZones: parseDeliveryZones(resto.delivery_zones_json),
        pickupSlots: parsePickupSlots(resto.pickup_slots_json),
        loyaltyEnabled: Boolean(resto.loyalty_enabled ?? 1),
        loyaltyPointsPer1000Xof: Number(resto.loyalty_points_per_1000_xof || 10),
        loyaltyXofPerPoint: Number(resto.loyalty_xof_per_point || 25),
      },
      ratingSummary,
      categories: catalog.categories,
      items: catalog.items,
      combos: catalog.combos,
    };
  }

  async lookupPublicLoyaltyByQr(token: string, phone: string) {
    const qrRow = await publicReadRepository.findQrContextByToken(token);
    if (!qrRow || qrRow.qr_status !== 'ACTIVE') {
      throw new AppError(404, 'QR code introuvable ou révoqué.');
    }
    const info = isLegacyPublicTestRuntime()
      ? resolveLoyaltyForPhone(getDb(), String(qrRow.restaurant_id), phone)
      : await knexPublicRepository.resolveLoyaltyForPhone(String(qrRow.restaurant_id), normalizePhoneKey(phone));
    if (!info) {
      throw new AppError(400, 'Numéro de téléphone invalide.');
    }
    return info;
  }

  async lookupPublicLoyaltyBySlug(slug: string, phone: string) {
    const resto = await publicReadRepository.findStorefrontBySlug(slug);
    if (!resto) {
      throw new AppError(404, 'Restaurant introuvable.');
    }
    const info = isLegacyPublicTestRuntime()
      ? resolveLoyaltyForPhone(getDb(), String(resto.id), phone)
      : await knexPublicRepository.resolveLoyaltyForPhone(String(resto.id), normalizePhoneKey(phone));
    if (!info) {
      throw new AppError(400, 'Numéro de téléphone invalide.');
    }
    return info;
  }

  private buildPublicOrderLines(params: {
    restaurantId: string;
    rawItems: unknown[];
    rawCombos: unknown[];
  }) {
    const db = getDb();
    const activePromos = loadActivePromotions(db, params.restaurantId);
    let grossXof = 0;
    const preparedLines: Array<{
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
    const recipeDeductItems: Array<{ menuItemId: string; quantity: number }> = [];
    const combosQueue = [...params.rawCombos];

    for (const rawLine of params.rawItems) {
      const line = rawLine as {
        menuItemId?: unknown;
        comboId?: unknown;
        quantity?: unknown;
        optionIds?: unknown;
        notes?: unknown;
      };
      if (line.comboId) {
        combosQueue.push({
          comboId: line.comboId,
          quantity: line.quantity,
          notes: line.notes,
        });
        continue;
      }

      const parsedQty = Number(line.quantity ?? 1);
      if (!Number.isFinite(parsedQty) || parsedQty < 1) {
        throw new AppError(400, 'Quantité d’article invalide.');
      }
      const qty = Math.max(1, Math.min(50, Math.floor(parsedQty)));
      const menuItem = publicRepository.findMenuItemWithStation(
        String(line.menuItemId),
        params.restaurantId,
      );

      if (!menuItem || !menuItem.available || !menuItem.category_active) {
        throw new AppError(
          400,
          'Un ou plusieurs articles sélectionnés ne sont plus disponibles.',
        );
      }

      const selectedOptionIds: string[] = Array.isArray(line.optionIds)
        ? line.optionIds.map(String)
        : [];
      const { optionsSummary, optionsDeltaXof } = resolveItemOptionsSelection({
        itemName: String(menuItem.name),
        legacyOptionsJson: menuItem.options_json,
        optionGroupsJson: menuItem.option_groups_json,
        selectedOptionIds,
      });

      const hh = computeHappyHourForItem({
        basePriceXof: Number(menuItem.price_xof),
        categoryId: String(menuItem.category_id),
        promotions: activePromos,
      });
      const unitPriceXof = hh.effectivePriceXof;
      const lineTotalXof = (unitPriceXof + optionsDeltaXof) * qty;
      grossXof += lineTotalXof;

      preparedLines.push({
        id: generateId('oi'),
        menuItemId: String(menuItem.id),
        name: hh.promoLabel
          ? `${String(menuItem.name)} (${hh.promoLabel})`
          : String(menuItem.name),
        station: String(menuItem.station || 'KITCHEN'),
        unitPriceXof,
        optionsSummary,
        optionsDeltaXof,
        quantity: qty,
        lineTotalXof,
        notes: String(line.notes || '').slice(0, 200),
      });
      recipeDeductItems.push({ menuItemId: String(menuItem.id), quantity: qty });
    }

    if (combosQueue.length > 0) {
      const fallbackItem = db
        .prepare('SELECT id FROM menu_items WHERE restaurant_id = ? LIMIT 1')
        .get(params.restaurantId) as { id: string } | undefined;

      for (const rawCombo of combosQueue) {
        const cObj = (rawCombo || {}) as {
          comboId?: unknown;
          quantity?: unknown;
          notes?: unknown;
        };
        const combo = operationsRepository.findComboById(
          String(cObj.comboId || ''),
          params.restaurantId,
        );
        if (!combo || !combo.active) {
          throw new AppError(400, 'Une formule sélectionnée n’est plus disponible.');
        }
        const qty = Math.max(1, Math.min(50, Math.floor(Number(cObj.quantity || 1))));
        const linkedMenuItemId =
          combo.items.find((ci) => ci.menuItemId)?.menuItemId ||
          fallbackItem?.id;
        if (!linkedMenuItemId) {
          throw new AppError(
            400,
            'La formule doit être rattachée à au moins un plat du catalogue.',
          );
        }
        const lineTotalXof = combo.priceXof * qty;
        grossXof += lineTotalXof;
        preparedLines.push({
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
          lineTotalXof,
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

    if (preparedLines.length === 0) {
      throw new AppError(400, 'Votre panier est vide.');
    }

    return { grossXof, preparedLines, recipeDeductItems };
  }

  async submitQrOrder(token: string, body: Record<string, unknown>) {
    const {
      sessionId,
      customerName,
      customerPhone,
      notes,
      items,
      combos,
      promoCode,
      loyaltyPointsToUse,
      idempotencyKey,
    } = body || {};

    const rawItems = Array.isArray(items) ? items : [];
    const rawCombos = Array.isArray(combos) ? combos : [];
    if (rawItems.length === 0 && rawCombos.length === 0) {
      throw new AppError(400, 'Votre panier est vide.');
    }

    const qrRow = publicRepository.findQrContextByToken(token);
    if (!qrRow || qrRow.qr_status !== 'ACTIVE') {
      throw new AppError(410, 'QR code révoqué ou invalide.');
    }
    this.assertRestaurantOpen(qrRow);

    const restaurantId = String(qrRow.restaurant_id);
    const tableId = String(qrRow.table_id);

    if (sessionId) {
      const sess = publicRepository.findQrTableSession(String(sessionId));
      if (
        !sess ||
        sess.restaurant_id !== restaurantId ||
        sess.table_id !== tableId ||
        new Date(String(sess.expires_at)).getTime() < Date.now()
      ) {
        throw new AppError(
          403,
          'Session de table invalide ou expirée. Veuillez rescanner le QR code.',
        );
      }
    }

    if (idempotencyKey) {
      const existing = publicRepository.findOrderByIdempotencyKey(
        restaurantId,
        String(idempotencyKey),
      );
      if (existing) {
        return {
          deduplicated: true,
          order: {
            id: existing.id,
            orderNumber: existing.order_number,
            totalXof: Number(existing.total_xof),
            status: existing.status,
          },
        };
      }
    }

    const db = getDb();
    const now = new Date().toISOString();
    const orderId = generateId('ord');
    const orderCount = publicRepository.countOrdersForRestaurant(restaurantId);
    const orderNumber = `CMD-${1001 + orderCount}`;

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

      const { grossXof, preparedLines, recipeDeductItems } =
        this.buildPublicOrderLines({
          restaurantId,
          rawItems,
          rawCombos,
        });

      const cleanPhone = normalizePhoneKey(String(customerPhone || '')).slice(
        0,
        30,
      );
      const promoLoyalty = applyOrderPromoAndLoyaltyDiscounts({
        db,
        restaurantId,
        grossXof,
        promoCode: promoCode ? String(promoCode) : undefined,
        customerPhone: cleanPhone || undefined,
        loyaltyPointsToUse: Number(loyaltyPointsToUse || 0),
        orderId,
        orderNumber,
        nowIso: now,
      });

      const discountXof = promoLoyalty.discountXof;
      const totalXof = Math.max(0, grossXof - discountXof);
      const taxRate = Number(qrRow.tax_rate_percent || 18);
      const ht = Math.round(totalXof / (1 + taxRate / 100));
      const taxXof = totalXof - ht;

      publicRepository.insertPublicOrderTransaction({
        orderId,
        restaurantId,
        orderNumber,
        orderType: 'QR_TABLE',
        tableId,
        customerName: String(
          customerName || `${qrRow.table_label} (Client QR)`,
        ).slice(0, 80),
        customerPhone: cleanPhone,
        deliveryAddress: '',
        deliveryZone: '',
        deliveryFeeXof: 0,
        scheduledSlot: '',
        promoCode: promoLoyalty.appliedPromoCode,
        loyaltyPointsUsed: promoLoyalty.loyaltyPointsUsed,
        subtotalHtXof: ht,
        discountXof,
        taxXof,
        totalXof,
        notes: String(notes || '').slice(0, 300),
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
        now,
        lines: preparedLines,
      });

      deductionResult = restaurantRepository.deductStocksForOrderItems({
        rid: restaurantId,
        orderNumber,
        items: recipeDeductItems,
        userId: null,
        now,
      });

      db.exec('COMMIT');
      createdTotalXof = totalXof;
      createdDiscountXof = discountXof;
      createdLines = preparedLines;
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(500, 'Erreur lors de l’envoi de la commande.');
    }

    if (deductionResult.deductedCount > 0) {
      broadcastRestaurantEvent(restaurantId, 'stock:updated', {
        orderId,
        orderNumber,
        deductedCount: deductionResult.deductedCount,
      });
      for (const low of deductionResult.lowStocksTriggered) {
        await restaurantService.dispatchCriticalStockAlert({
          restaurantId,
          stockId: low.id,
          stockName: low.name,
          quantity: low.quantity,
          minThreshold: low.minThreshold,
          unit: low.unit,
          supplierName: low.supplierName,
        });
      }
    }

    broadcastRestaurantEvent(restaurantId, 'order:created', {
      orderId,
      orderNumber,
      orderType: 'QR_TABLE',
      tableId,
      totalXof: createdTotalXof,
    });
    broadcastRestaurantEvent(restaurantId, 'table:updated', {
      tableId,
      status: 'OCCUPIED',
    });

    return {
      deduplicated: false,
      order: {
        id: orderId,
        orderNumber,
        tableLabel: qrRow.table_label,
        discountXof: createdDiscountXof,
        totalXof: createdTotalXof,
        status: 'PENDING',
        createdAt: now,
        items: createdLines,
      },
    };
  }

  async submitStorefrontOrder(slug: string, body: Record<string, unknown>) {
    const {
      orderType,
      customerName,
      customerPhone,
      deliveryAddress,
      deliveryZoneId,
      deliveryZone,
      scheduledSlot,
      notes,
      items,
      combos,
      promoCode,
      loyaltyPointsToUse,
      payNow,
      paymentMethod,
      paymentPhone,
      idempotencyKey,
    } = body || {};

    const rawItems = Array.isArray(items) ? items : [];
    const rawCombos = Array.isArray(combos) ? combos : [];
    if (rawItems.length === 0 && rawCombos.length === 0) {
      throw new AppError(400, 'Votre panier est vide.');
    }

    const resto = publicRepository.findStorefrontBySlug(slug);
    if (!resto) {
      throw new AppError(404, 'Vitrine restaurant introuvable.');
    }
    this.assertRestaurantOpen(resto);
    if (!resto.storefront_enabled) {
      throw new AppError(
        403,
        'La commande en ligne est désactivée pour cet établissement.',
      );
    }

    const restaurantId = String(resto.id);
    const resolvedType: 'CLICK_COLLECT' | 'DELIVERY' =
      orderType === 'DELIVERY' ? 'DELIVERY' : 'CLICK_COLLECT';

    if (resolvedType === 'DELIVERY' && !resto.delivery_enabled) {
      throw new AppError(
        400,
        'La livraison n’est pas activée sur cet établissement.',
      );
    }

    const cleanName = String(customerName || '').trim();
    const cleanPhone = normalizePhoneKey(String(customerPhone || '')).slice(0, 30);
    if (cleanName.length < 2 || cleanPhone.length < 6) {
      throw new AppError(
        400,
        'Veuillez renseigner votre nom et un numéro de téléphone valide.',
      );
    }

    let resolvedZoneName = '';
    let deliveryFeeXof = 0;
    let zoneMinOrder = 0;
    const cleanAddress = String(deliveryAddress || '').trim().slice(0, 300);

    if (resolvedType === 'DELIVERY') {
      if (cleanAddress.length < 5) {
        throw new AppError(
          400,
          'Veuillez indiquer votre adresse précise de livraison.',
        );
      }
      const zones = parseDeliveryZones(resto.delivery_zones_json);
      if (zones.length > 0) {
        const matched =
          zones.find(
            (z) =>
              (deliveryZoneId && z.id === String(deliveryZoneId)) ||
              (deliveryZone &&
                z.name.toLowerCase() === String(deliveryZone).trim().toLowerCase()),
          ) || null;
        if (!matched) {
          throw new AppError(
            400,
            'Veuillez sélectionner une zone de livraison valide.',
          );
        }
        resolvedZoneName = matched.name;
        deliveryFeeXof = matched.feeXof;
        zoneMinOrder = matched.minOrderXof;
      } else {
        resolvedZoneName = String(deliveryZone || 'Livraison standard').trim();
      }
    }

    const cleanSlot = String(scheduledSlot || '').trim().slice(0, 80);
    if (resolvedType === 'CLICK_COLLECT' && !cleanSlot) {
      throw new AppError(400, 'Veuillez choisir un créneau de retrait.');
    }

    const shouldPayNow = Boolean(payNow);
    const payMethod = String(paymentMethod || '').toUpperCase();
    const validPayMethods = ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'CARD'];
    if (shouldPayNow && !validPayMethods.includes(payMethod)) {
      throw new AppError(400, 'Moyen de paiement en ligne invalide.');
    }
    const payPhoneClean = normalizePhoneKey(
      String(paymentPhone || cleanPhone),
    ).slice(0, 20);
    if (shouldPayNow && payMethod !== 'CARD' && payPhoneClean.length < 6) {
      throw new AppError(
        400,
        'Numéro Mobile Money requis pour le paiement en ligne.',
      );
    }

    if (idempotencyKey) {
      const existing = publicRepository.findOrderByIdempotencyKey(
        restaurantId,
        String(idempotencyKey),
      );
      if (existing) {
        return {
          deduplicated: true,
          order: {
            id: existing.id,
            orderNumber: existing.order_number,
            totalXof: Number(existing.total_xof),
            status: existing.status,
          },
        };
      }
    }

    const db = getDb();
    const now = new Date().toISOString();
    const orderId = generateId('ord');
    const orderCount = publicRepository.countOrdersForRestaurant(restaurantId);
    const orderNumber = `CMD-${1001 + orderCount}`;

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
    let createdStatus = 'PENDING';
    let createdPayment: Record<string, unknown> | null = null;
    let pointsEarned = 0;
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

      const { grossXof, preparedLines, recipeDeductItems } =
        this.buildPublicOrderLines({
          restaurantId,
          rawItems,
          rawCombos,
        });

      if (resolvedType === 'DELIVERY' && zoneMinOrder > 0 && grossXof < zoneMinOrder) {
        throw new AppError(
          400,
          `Minimum de commande pour ${resolvedZoneName} : ${zoneMinOrder} FCFA.`,
        );
      }

      const promoLoyalty = applyOrderPromoAndLoyaltyDiscounts({
        db,
        restaurantId,
        grossXof,
        promoCode: promoCode ? String(promoCode) : undefined,
        customerPhone: cleanPhone,
        loyaltyPointsToUse: Number(loyaltyPointsToUse || 0),
        orderId,
        orderNumber,
        nowIso: now,
      });

      const discountXof = promoLoyalty.discountXof;
      const netFoodXof = Math.max(0, grossXof - discountXof);
      const totalXof = netFoodXof + deliveryFeeXof;
      const taxRate = Number(resto.tax_rate_percent || 18);
      const ht = Math.round(totalXof / (1 + taxRate / 100));
      const taxXof = totalXof - ht;

      publicRepository.insertPublicOrderTransaction({
        orderId,
        restaurantId,
        orderNumber,
        orderType: resolvedType,
        tableId: null,
        customerName: cleanName.slice(0, 80),
        customerPhone: cleanPhone,
        deliveryAddress: cleanAddress,
        deliveryZone: resolvedZoneName,
        deliveryFeeXof,
        scheduledSlot: cleanSlot,
        promoCode: promoLoyalty.appliedPromoCode,
        loyaltyPointsUsed: promoLoyalty.loyaltyPointsUsed,
        subtotalHtXof: ht,
        discountXof,
        taxXof,
        totalXof,
        notes: String(notes || '').slice(0, 300),
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
        now,
        lines: preparedLines,
      });

      deductionResult = restaurantRepository.deductStocksForOrderItems({
        rid: restaurantId,
        orderNumber,
        items: recipeDeductItems,
        userId: null,
        now,
      });

      if (shouldPayNow && totalXof > 0) {
        const paymentId = generateId('pay');
        const mode = resto.paydunya_mode === 'LIVE' ? 'LIVE' : 'TEST';
        const reference = `WEB-${mode}-${payMethod.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`;
        publicRepository.insertPublicOrderPayment({
          paymentId,
          restaurantId,
          orderId,
          amountXof: totalXof,
          method: payMethod,
          mode,
          reference,
          idempotencyKey: idempotencyKey ? `${String(idempotencyKey)}#pay` : null,
          newPaidXof: totalXof,
          fullyPaid: true,
          now,
        });
        createdStatus = 'PAID';
        pointsEarned = awardLoyaltyPointsOnPaidOrder(db, restaurantId, orderId);
        createdPayment = {
          id: paymentId,
          amountXof: totalXof,
          method: payMethod,
          mode,
          reference,
          status: 'PAID',
        };
      }

      recordAudit(db, {
        actorUserId: null,
        actorEmail: cleanPhone,
        actorRole: 'GUEST_WEB',
        restaurantId,
        action:
          resolvedType === 'DELIVERY'
            ? 'STOREFRONT_DELIVERY_ORDER_CREATED'
            : 'STOREFRONT_PICKUP_ORDER_CREATED',
        targetType: 'ORDER',
        targetId: orderId,
        details: `${orderNumber} · ${totalXof} FCFA${shouldPayNow ? ' (Payé en ligne)' : ''}`,
      });

      db.exec('COMMIT');
      createdTotalXof = totalXof;
      createdDiscountXof = discountXof;
      createdLines = preparedLines;
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) {
        throw err;
      }
      throw new AppError(500, 'Erreur lors de la validation de votre commande.');
    }

    if (deductionResult.deductedCount > 0) {
      broadcastRestaurantEvent(restaurantId, 'stock:updated', {
        orderId,
        orderNumber,
        deductedCount: deductionResult.deductedCount,
      });
      for (const low of deductionResult.lowStocksTriggered) {
        await restaurantService.dispatchCriticalStockAlert({
          restaurantId,
          stockId: low.id,
          stockName: low.name,
          quantity: low.quantity,
          minThreshold: low.minThreshold,
          unit: low.unit,
          supplierName: low.supplierName,
        });
      }
    }

    broadcastRestaurantEvent(restaurantId, 'order:created', {
      orderId,
      orderNumber,
      orderType: resolvedType,
      totalXof: createdTotalXof,
    });
    if (createdPayment) {
      broadcastRestaurantEvent(restaurantId, 'payment:created', {
        orderId,
        paymentId: createdPayment.id,
        amountXof: createdTotalXof,
        fullyPaid: true,
        channel: 'STOREFRONT_ONLINE',
      });
    }

    return {
      deduplicated: false,
      order: {
        id: orderId,
        orderNumber,
        orderType: resolvedType,
        deliveryZone: resolvedZoneName,
        deliveryFeeXof,
        scheduledSlot: cleanSlot,
        discountXof: createdDiscountXof,
        totalXof: createdTotalXof,
        paidXof: createdPayment ? createdTotalXof : 0,
        status: createdStatus,
        pointsEarned,
        createdAt: now,
        items: createdLines,
      },
      payment: createdPayment,
    };
  }

  async trackQrOrder(token: string, orderId: string) {
    const result = await publicReadRepository.findTrackedQrOrder(token, orderId);
    if (!result) {
      throw new AppError(404, 'Commande introuvable pour cette table.');
    }
    const { order, items, review } = result;
    const statusStr = String(order.status);
    return {
      id: order.id,
      orderNumber: order.order_number,
      orderType: order.order_type || 'QR_TABLE',
      status: statusStr,
      discountXof: Number(order.discount_xof || 0),
      totalXof: Number(order.total_xof),
      paidXof: Number(order.paid_xof),
      customerName: String(order.customer_name || ''),
      customerPhone: String(order.customer_phone || ''),
      promoCode: String(order.promo_code || ''),
      loyaltyPointsUsed: Number(order.loyalty_points_used || 0),
      loyaltyPointsEarned: Number(order.loyalty_points_earned || 0),
      loyaltyEnabled: Boolean(order.loyalty_enabled ?? 1),
      notes: String(order.notes || ''),
      tableLabel: order.table_label,
      restaurantName: order.restaurant_name,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      canReview:
        !review && (statusStr === 'PAID' || statusStr === 'SERVED'),
      review,
      items,
    };
  }

  async trackStorefrontOrder(slug: string, orderId: string) {
    const result = await publicReadRepository.findTrackedStorefrontOrder(slug, orderId);
    if (!result) {
      throw new AppError(404, 'Commande introuvable.');
    }
    const { order, items, review } = result;
    const statusStr = String(order.status);
    return {
      id: order.id,
      orderNumber: order.order_number,
      orderType: order.order_type,
      status: statusStr,
      discountXof: Number(order.discount_xof || 0),
      deliveryFeeXof: Number(order.delivery_fee_xof || 0),
      deliveryZone: String(order.delivery_zone || ''),
      deliveryAddress: String(order.delivery_address || ''),
      scheduledSlot: String(order.scheduled_slot || ''),
      totalXof: Number(order.total_xof),
      paidXof: Number(order.paid_xof),
      customerName: String(order.customer_name || ''),
      customerPhone: String(order.customer_phone || ''),
      promoCode: String(order.promo_code || ''),
      loyaltyPointsUsed: Number(order.loyalty_points_used || 0),
      loyaltyPointsEarned: Number(order.loyalty_points_earned || 0),
      loyaltyEnabled: Boolean(order.loyalty_enabled ?? 1),
      notes: String(order.notes || ''),
      restaurantName: order.restaurant_name,
      restaurantSlug: order.restaurant_slug,
      restaurantAddress: order.restaurant_address,
      restaurantPhone: order.restaurant_phone,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      canReview:
        !review && (statusStr === 'PAID' || statusStr === 'SERVED'),
      review,
      items,
    };
  }

  payQrOrder(
    token: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const method = String(body?.method || '').toUpperCase();
    const validMethods = ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'CARD'];
    if (!validMethods.includes(method)) {
      throw new AppError(400, 'Moyen de paiement mobile ou carte invalide.');
    }

    const order = publicRepository.findOrderForQrPayment(token, orderId);
    if (!order) {
      throw new AppError(404, 'Commande introuvable pour cette table.');
    }
    if (order.qr_status !== 'ACTIVE') {
      throw new AppError(410, 'Ce QR code a été révoqué.');
    }
    if (
      order.deleted_at ||
      order.restaurant_status === 'SUSPENDED' ||
      order.restaurant_status === 'DELETED'
    ) {
      throw new AppError(403, 'Restaurant indisponible.');
    }
    if (order.status === 'CANCELLED') {
      throw new AppError(400, 'Cette commande a été annulée.');
    }

    const idempotencyKey = body?.idempotencyKey
      ? String(body.idempotencyKey)
      : null;
    if (idempotencyKey) {
      const existing = publicRepository.findQrPaymentByIdempotencyKey(
        order.restaurant_id,
        idempotencyKey,
      );
      if (existing) {
        return { payment: existing, deduplicated: true };
      }
    }

    const remaining = Number(order.total_xof) - Number(order.paid_xof);
    if (remaining <= 0) {
      throw new AppError(409, 'Cette commande est déjà intégralement réglée.');
    }

    const requestedAmount = body?.amountXof
      ? Math.round(Number(body.amountXof))
      : remaining;
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new AppError(400, 'Montant de règlement invalide.');
    }
    if (requestedAmount > remaining) {
      throw new AppError(400, 'Le montant dépasse le solde restant dû.');
    }

    const phoneClean = normalizePhoneKey(String(body?.phoneNumber || '')).slice(
      0,
      20,
    );
    if (method !== 'CARD' && phoneClean.length < 6) {
      throw new AppError(
        400,
        'Veuillez saisir votre numéro Mobile Money pour valider le paiement.',
      );
    }

    const newPaid = Number(order.paid_xof) + requestedAmount;
    const fullyPaid = newPaid >= Number(order.total_xof);
    const now = new Date().toISOString();
    const paymentId = generateId('pay');
    const mode = order.paydunya_mode === 'LIVE' ? 'LIVE' : 'TEST';
    const reference = `QR-${mode}-${method.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`;

    const db = getDb();
    let pointsEarned = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const loyaltyPhone = normalizePhoneKey(
        String(body?.customerPhone || phoneClean || order.customer_phone || ''),
      );
      if (!order.customer_phone && loyaltyPhone.length >= 6) {
        publicRepository.updateOrderCustomerPhone(
          order.id,
          order.restaurant_id,
          loyaltyPhone,
        );
      }

      publicRepository.insertPublicOrderPayment({
        paymentId,
        restaurantId: order.restaurant_id,
        orderId: order.id,
        amountXof: requestedAmount,
        method,
        mode,
        reference,
        idempotencyKey,
        newPaidXof: newPaid,
        fullyPaid,
        now,
      });

      if (fullyPaid) {
        pointsEarned = awardLoyaltyPointsOnPaidOrder(
          db,
          order.restaurant_id,
          order.id,
        );
      }

      recordAudit(db, {
        actorUserId: null,
        actorEmail: phoneClean || 'client-qr@table',
        actorRole: 'GUEST_QR',
        restaurantId: order.restaurant_id,
        action: 'QR_PAYMENT_RECORDED',
        targetType: 'ORDER',
        targetId: order.id,
        details: `${requestedAmount} FCFA via ${method} (${mode})`,
      });

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors du paiement en ligne.');
    }

    broadcastRestaurantEvent(order.restaurant_id, 'payment:created', {
      orderId: order.id,
      paymentId,
      amountXof: requestedAmount,
      fullyPaid,
      channel: 'QR_CLIENT',
    });
    broadcastOrderTrackerEvent(order.id, 'order:updated', {
      orderId: order.id,
      status: fullyPaid ? 'PAID' : order.status,
    });

    return {
      deduplicated: false,
      pointsEarned,
      payment: {
        id: paymentId,
        orderId: order.id,
        amountXof: requestedAmount,
        method,
        mode,
        reference,
        status: 'PAID',
        fullyPaid,
        createdAt: now,
      },
    };
  }

  payStorefrontOrder(
    slug: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const method = String(body?.method || '').toUpperCase();
    const validMethods = ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'CARD'];
    if (!validMethods.includes(method)) {
      throw new AppError(400, 'Moyen de paiement mobile ou carte invalide.');
    }

    const order = publicRepository.findOrderForStorefrontPayment(slug, orderId);
    if (!order) {
      throw new AppError(404, 'Commande en ligne introuvable.');
    }
    if (
      order.deleted_at ||
      order.restaurant_status === 'SUSPENDED' ||
      order.restaurant_status === 'DELETED'
    ) {
      throw new AppError(403, 'Restaurant indisponible.');
    }
    if (order.status === 'CANCELLED') {
      throw new AppError(400, 'Cette commande a été annulée.');
    }

    const idempotencyKey = body?.idempotencyKey
      ? String(body.idempotencyKey)
      : null;
    if (idempotencyKey) {
      const existing = publicRepository.findQrPaymentByIdempotencyKey(
        order.restaurant_id,
        idempotencyKey,
      );
      if (existing) {
        return { payment: existing, deduplicated: true };
      }
    }

    const remaining = Number(order.total_xof) - Number(order.paid_xof);
    if (remaining <= 0) {
      throw new AppError(409, 'Cette commande est déjà intégralement réglée.');
    }

    const phoneClean = normalizePhoneKey(
      String(body?.phoneNumber || order.customer_phone || ''),
    ).slice(0, 20);
    if (method !== 'CARD' && phoneClean.length < 6) {
      throw new AppError(
        400,
        'Veuillez saisir votre numéro Mobile Money pour valider le paiement.',
      );
    }

    const now = new Date().toISOString();
    const paymentId = generateId('pay');
    const mode = order.paydunya_mode === 'LIVE' ? 'LIVE' : 'TEST';
    const reference = `WEB-${mode}-${method.slice(0, 4)}-${Math.floor(100000 + Math.random() * 900000)}`;
    const newPaid = Number(order.paid_xof) + remaining;

    const db = getDb();
    let pointsEarned = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      publicRepository.insertPublicOrderPayment({
        paymentId,
        restaurantId: order.restaurant_id,
        orderId: order.id,
        amountXof: remaining,
        method,
        mode,
        reference,
        idempotencyKey,
        newPaidXof: newPaid,
        fullyPaid: true,
        now,
      });

      pointsEarned = awardLoyaltyPointsOnPaidOrder(
        db,
        order.restaurant_id,
        order.id,
      );

      recordAudit(db, {
        actorUserId: null,
        actorEmail: phoneClean || 'client-web@store',
        actorRole: 'GUEST_WEB',
        restaurantId: order.restaurant_id,
        action: 'STOREFRONT_PAYMENT_RECORDED',
        targetType: 'ORDER',
        targetId: order.id,
        details: `${remaining} FCFA via ${method} (${mode})`,
      });

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur lors du paiement en ligne.');
    }

    broadcastRestaurantEvent(order.restaurant_id, 'payment:created', {
      orderId: order.id,
      paymentId,
      amountXof: remaining,
      fullyPaid: true,
      channel: 'STOREFRONT_ONLINE',
    });
    broadcastOrderTrackerEvent(order.id, 'order:updated', {
      orderId: order.id,
      status: 'PAID',
    });

    return {
      deduplicated: false,
      pointsEarned,
      payment: {
        id: paymentId,
        orderId: order.id,
        amountXof: remaining,
        method,
        mode,
        reference,
        status: 'PAID',
        fullyPaid: true,
        createdAt: now,
      },
    };
  }

  callWaiterOrBill(token: string, body: Record<string, unknown>) {
    const qrRow = publicRepository.findQrContextByToken(token);
    if (!qrRow) {
      throw new AppError(404, 'QR code introuvable ou invalide.');
    }
    if (qrRow.qr_status !== 'ACTIVE') {
      throw new AppError(410, 'Ce QR code a été révoqué.');
    }
    this.assertRestaurantOpen(qrRow);

    const callType = body?.callType === 'BILL' ? 'BILL' : 'WAITER';
    const note = String(body?.note || '').trim().slice(0, 200);
    const restaurantId = String(qrRow.restaurant_id);
    const tableId = String(qrRow.table_id);
    const tableLabel = String(qrRow.table_label);

    const call = publicRepository.createTableCall({
      restaurantId,
      tableId,
      tableLabel,
      callType,
      note,
    });

    broadcastRestaurantEvent(restaurantId, 'table:call', { call });
    return { call };
  }

  private parseReviewRatings(body: Record<string, unknown>) {
    const parseStar = (raw: unknown): number | null => {
      if (raw === undefined || raw === null || raw === '') return null;
      const n = Math.round(Number(raw));
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new AppError(400, 'Chaque note doit être comprise entre 1 et 5 étoiles.');
      }
      return n;
    };

    const explicitRating = parseStar(body?.rating);
    const explicitService = parseStar(body?.serviceRating);
    const explicitFood = parseStar(body?.foodRating);
    const explicitSpeed = parseStar(body?.speedRating);

    const base = explicitRating ?? explicitService;
    if (!base) {
      throw new AppError(400, 'Veuillez choisir une note entre 1 et 5 étoiles.');
    }

    const serviceRating = explicitService ?? base;
    const foodRating = explicitFood ?? base;
    const speedRating = explicitSpeed ?? base;
    const rating =
      explicitRating ??
      Math.max(
        1,
        Math.min(5, Math.round((serviceRating + foodRating + speedRating) / 3)),
      );

    return {
      rating,
      serviceRating,
      foodRating,
      speedRating,
      waiterName: String(body?.waiterName || '').trim().slice(0, 80),
      comment: String(body?.comment || '').trim().slice(0, 600),
    };
  }

  submitQrReview(token: string, orderId: string, body: Record<string, unknown>) {
    const tracked = publicRepository.findTrackedQrOrder(token, orderId);
    if (!tracked) {
      throw new AppError(404, 'Commande introuvable pour cette table.');
    }
    return this.createReviewForTrackedOrder(tracked, body);
  }

  submitStorefrontReview(
    slug: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const tracked = publicRepository.findTrackedStorefrontOrder(slug, orderId);
    if (!tracked) {
      throw new AppError(404, 'Commande introuvable.');
    }
    return this.createReviewForTrackedOrder(tracked, body);
  }

  submitQrServiceRating(token: string, body: Record<string, unknown>) {
    const qrRow = publicRepository.findQrContextByToken(token);
    if (!qrRow) {
      throw new AppError(404, 'QR code introuvable ou invalide.');
    }
    if (qrRow.qr_status !== 'ACTIVE') {
      throw new AppError(410, 'Ce QR code a été révoqué.');
    }
    this.assertRestaurantOpen(qrRow);

    const parsed = this.parseReviewRatings(body);
    const customerName = String(body?.customerName || 'Client salle')
      .trim()
      .slice(0, 80) || 'Client salle';
    const restaurantId = String(qrRow.restaurant_id);

    const created = publicRepository.insertCustomerReview({
      restaurantId,
      orderId: null,
      orderNumber: '',
      tableLabel: String(qrRow.table_label || ''),
      customerName,
      rating: parsed.rating,
      serviceRating: parsed.serviceRating,
      foodRating: parsed.foodRating,
      speedRating: parsed.speedRating,
      waiterName: parsed.waiterName,
      channel: 'QR_SERVICE',
      comment: parsed.comment,
    });

    broadcastRestaurantEvent(restaurantId, 'review:created', {
      review: created,
    });
    return {
      review: created,
      ratingSummary: publicRepository.findPublicRatingStats(restaurantId),
    };
  }

  submitStorefrontServiceRating(slug: string, body: Record<string, unknown>) {
    const resto = publicRepository.findStorefrontBySlug(slug);
    if (!resto) {
      throw new AppError(404, 'Vitrine restaurant introuvable.');
    }
    this.assertRestaurantOpen(resto);
    if (!resto.storefront_enabled) {
      throw new AppError(403, 'Vitrine en ligne désactivée.');
    }

    const parsed = this.parseReviewRatings(body);
    const customerName = String(body?.customerName || 'Client en ligne')
      .trim()
      .slice(0, 80) || 'Client en ligne';
    const restaurantId = String(resto.id);

    const created = publicRepository.insertCustomerReview({
      restaurantId,
      orderId: null,
      orderNumber: '',
      tableLabel: 'En ligne',
      customerName,
      rating: parsed.rating,
      serviceRating: parsed.serviceRating,
      foodRating: parsed.foodRating,
      speedRating: parsed.speedRating,
      waiterName: parsed.waiterName,
      channel: 'STOREFRONT_SERVICE',
      comment: parsed.comment,
    });

    broadcastRestaurantEvent(restaurantId, 'review:created', {
      review: created,
    });
    return {
      review: created,
      ratingSummary: publicRepository.findPublicRatingStats(restaurantId),
    };
  }

  private createReviewForTrackedOrder(
    tracked: {
      order: Record<string, unknown>;
      review: Record<string, unknown> | null;
    },
    body: Record<string, unknown>,
  ) {
    const { order, review } = tracked;
    if (review) {
      throw new AppError(
        409,
        'Un avis a déjà été déposé pour cette commande. Merci !',
      );
    }
    const status = String(order.status);
    if (status !== 'PAID' && status !== 'SERVED') {
      throw new AppError(
        400,
        'Vous pourrez laisser votre avis dès que la commande sera servie ou réglée.',
      );
    }

    const parsed = this.parseReviewRatings(body);
    const customerName = String(
      body?.customerName || order.customer_name || 'Client',
    )
      .trim()
      .slice(0, 80);

    // Fetch restaurant_id securely from orders row
    const ordRow = getDb()
      .prepare('SELECT restaurant_id FROM orders WHERE id = ?')
      .get(String(order.id)) as { restaurant_id: string } | undefined;
    if (!ordRow) {
      throw new AppError(404, 'Commande introuvable.');
    }

    const orderType = String(order.order_type || 'QR_TABLE');
    const channel =
      orderType === 'CLICK_COLLECT' || orderType === 'DELIVERY'
        ? 'STOREFRONT_ORDER'
        : 'QR_ORDER';

    const created = publicRepository.insertCustomerReview({
      restaurantId: ordRow.restaurant_id,
      orderId: String(order.id),
      orderNumber: String(order.order_number),
      tableLabel: String(order.table_label || orderType || ''),
      customerName,
      rating: parsed.rating,
      serviceRating: parsed.serviceRating,
      foodRating: parsed.foodRating,
      speedRating: parsed.speedRating,
      waiterName: parsed.waiterName,
      channel,
      comment: parsed.comment,
    });

    broadcastRestaurantEvent(ordRow.restaurant_id, 'review:created', {
      review: created,
    });
    return { review: created };
  }

  handlePaydunyaSubscriptionWebhook(
    body: Record<string, unknown>,
    signatureHeader?: string,
  ) {
    if (!verifyPaydunyaIpnSignature(body || {}, signatureHeader)) {
      throw new AppError(401, 'Signature IPN PayDunya invalide.');
    }

    const dataObj =
      body?.data && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : body || {};
    const status = String(dataObj.status || '').toLowerCase();
    if (status !== 'completed') {
      return { ok: true, ignored: true, status };
    }

    const invoiceObj =
      dataObj.invoice && typeof dataObj.invoice === 'object'
        ? (dataObj.invoice as Record<string, unknown>)
        : {};
    const customData =
      dataObj.custom_data && typeof dataObj.custom_data === 'object'
        ? (dataObj.custom_data as Record<string, unknown>)
        : {};

    const invoiceId =
      typeof customData.invoice_id === 'string'
        ? customData.invoice_id.trim()
        : '';
    const pdxToken =
      typeof invoiceObj.token === 'string'
        ? invoiceObj.token.trim()
        : typeof dataObj.token === 'string'
          ? dataObj.token.trim()
          : '';

    const invoice = restaurantRepository.findSubscriptionInvoiceByIdOrToken({
      invoiceId: invoiceId || undefined,
      paydunyaToken: pdxToken || undefined,
    });
    if (!invoice) {
      throw new AppError(404, 'Facture PayDunya introuvable.');
    }
    if (String(invoice.status) === 'PAID') {
      return { ok: true, alreadyPaid: true, invoiceId: String(invoice.id) };
    }

    const reportedTotal = Number(invoiceObj.total_amount || invoice.amount_xof);
    if (
      !Number.isFinite(reportedTotal) ||
      reportedTotal < Number(invoice.amount_xof)
    ) {
      throw new AppError(400, 'Montant IPN PayDunya incohérent.');
    }

    const rid = String(invoice.restaurant_id);
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
    const planId = String(
      invoice.plan_id || existingSub?.plan_id || 'plan_essentiel',
    );

    const db = getDb();
    let subscriptionId: string;
    db.exec('BEGIN IMMEDIATE');
    try {
      subscriptionId = restaurantRepository.completePendingSubscriptionInvoice({
        invoiceId: String(invoice.id),
        rid,
        planId,
        billingCycle: cycle,
        paymentMethod: String(invoice.payment_method || 'WAVE'),
        paydunyaToken: pdxToken || String(invoice.paydunya_token || ''),
        periodStart: now.toISOString(),
        periodEnd,
        now: now.toISOString(),
      });
      recordAudit(db, {
        actorUserId: null,
        actorEmail: 'webhook@paydunya.com',
        actorRole: 'SYSTEM',
        restaurantId: rid,
        action: 'SAAS_PAYDUNYA_IPN_PAID',
        targetType: 'INVOICE',
        targetId: String(invoice.id),
        details: `IPN PayDunya confirmé · ${invoice.invoice_number}`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'Erreur traitement webhook PayDunya.');
    }

    broadcastRestaurantEvent(rid, 'subscription:updated', {
      subscriptionId,
      invoiceId: String(invoice.id),
      status: 'ACTIVE',
    });

    return {
      ok: true,
      alreadyPaid: false,
      subscriptionId,
      invoiceId: String(invoice.id),
    };
  }
}

export const publicService = new PublicService();
