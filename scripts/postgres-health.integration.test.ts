import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnexMigrationsCurrent, getKnex } from '../src/server/knex.ts';
import { checkSupabaseHealth } from '../src/server/lib/supabase.ts';
import crypto from 'node:crypto';
import { knexAuthRepository } from '../src/server/repositories/authRepository.knex.ts';
import { recordAuditWithKnex, resolveAuthContextWithKnex, signSessionToken } from '../src/server/auth.ts';
import { knexPublicRepository } from '../src/server/repositories/publicRepository.knex.ts';
import { knexOperationsReadRepository } from '../src/server/repositories/operationsRepository.knex.ts';
import { knexRestaurantStockRepository } from '../src/server/repositories/restaurantRepository.knex.ts';
import { knexSuperadminSettingsRepository } from '../src/server/repositories/superadminRepository.knex.ts';

test('selected PostgreSQL pool is reachable and schema is fully migrated', async () => {
  const health = await checkSupabaseHealth();
  assert.equal(health.postgresConnected, true);
  assert.ok(typeof health.latencyMs === 'number');
  await assertKnexMigrationsCurrent();

  const db = getKnex();
  const requiredOperationsTables = [
    'menu_combos',
    'promotions',
    'cash_register_sessions',
    'table_calls',
    'loyalty_transactions',
    'customer_reviews',
    'inventory_counts',
    'inventory_count_lines',
    'staff_shifts',
    'staff_time_clocks',
    'b2b_invoices',
  ];
  assert.equal(await db.schema.hasColumn('stocks', 'stock_section'), true);
  assert.equal(await db.schema.hasColumn('stock_movements', 'waste_category'), true);
  assert.equal(await db.schema.hasColumn('users', 'pin_hash'), true);

  for (const table of requiredOperationsTables) {
    assert.equal(await db.schema.hasTable(table), true, `Missing PostgreSQL table: ${table}`);
    const rls = await db.raw(
      'SELECT relrowsecurity FROM pg_class WHERE oid = ?::regclass',
      [table],
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true, `RLS is disabled on ${table}`);
  }

  const requiredForeignKeys = [
    ['restaurant_members', 'restaurant_id', 'restaurants'],
    ['restaurant_members', 'user_id', 'users'],
    ['orders', 'restaurant_id', 'restaurants'],
    ['order_items', 'order_id', 'orders'],
    ['order_items', 'menu_item_id', 'menu_items'],
    ['payments', 'order_id', 'orders'],
    ['stock_movements', 'stock_id', 'stocks'],
    ['menu_item_recipes', 'menu_item_id', 'menu_items'],
    ['menu_item_recipes', 'stock_id', 'stocks'],
    ['loyalty_transactions', 'customer_id', 'customers'],
    ['inventory_count_lines', 'inventory_count_id', 'inventory_counts'],
  ] as const;

  for (const [table, column, target] of requiredForeignKeys) {
    const fk = await db.raw(
      `SELECT 1
       FROM pg_constraint c
       JOIN pg_class target_table ON target_table.oid = c.confrelid
       JOIN pg_attribute source_column
         ON source_column.attrelid = c.conrelid
        AND source_column.attnum = ANY(c.conkey)
       WHERE c.contype = 'f'
         AND c.conrelid = ?::regclass
         AND source_column.attname = ?
         AND target_table.relname = ?
       LIMIT 1`,
      [table, column, target],
    );
    assert.equal(fk.rows.length, 1, `Missing foreign key ${table}.${column} -> ${target}`);
  }

  const orderNumberIndex = await db.raw(
    "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'orders' AND indexname = 'uq_orders_restaurant_order_number'",
  );
  assert.equal(orderNumberIndex.rows.length, 1, 'Order number unique index is missing');
});


test('PostgreSQL authentication repository persists tenant, user, session and one-time tokens', async () => {
  const db = getKnex();
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const restaurantId = `it_rest_${suffix}`;
  const userId = `it_user_${suffix}`;
  const memberId = `it_member_${suffix}`;
  const subscriptionId = `it_sub_${suffix}`;
  const sessionId = `it_session_${suffix}`;
  const slug = `it-${suffix}`;
  const email = `it-${suffix}@example.invalid`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  try {
    const plan = await knexAuthRepository.findPlanForRegistration('ESSENTIEL');
    assert.ok(plan?.id, 'Default SaaS plan must be seeded before registration');

    await db.transaction(async (trx) => {
      await knexAuthRepository.createRestaurantWithOwnerAndStarterData({
        restaurantId,
        restaurantName: 'Integration Test Restaurant',
        slug,
        email,
        phone: '+22500000000',
        city: 'Abidjan',
        userId,
        ownerName: 'Integration Test Owner',
        passwordHash: 'test-hash-not-used-for-login',
        memberId,
        subId: subscriptionId,
        planId: plan.id,
        trialEndsAt: expiresAt,
        sessionId,
        sessionExpiresAt: expiresAt,
        userAgent: 'postgres-integration-test',
        now,
      }, trx);

      await recordAuditWithKnex(trx, {
        actorUserId: userId,
        actorEmail: email,
        actorRole: 'OWNER',
        restaurantId,
        action: 'POSTGRES_AUTH_INTEGRATION_TEST',
        targetType: 'SESSION',
        targetId: sessionId,
      });
    });

    const user = await knexAuthRepository.findUserByEmail(email);
    assert.equal(user?.id, userId);
    assert.equal(user?.email, email);

    const membership = await knexAuthRepository.findPrimaryMembershipForUser(userId);
    assert.equal(membership?.restaurant_id, restaurantId);
    assert.equal(membership?.member_status, 'ACTIVE');

    const venues = await knexAuthRepository.findUserVenues(userId);
    assert.equal(venues.length, 1);
    assert.equal(venues[0]?.restaurantId, restaurantId);

    const tokenHash = crypto.createHash('sha256').update(suffix).digest('hex');
    const authTokenId = await knexAuthRepository.createAuthToken({
      userId,
      email,
      tokenHash,
      tokenType: 'PASSWORD_RESET',
      expiresAt,
    });
    const validToken = await knexAuthRepository.findValidAuthToken(tokenHash, 'PASSWORD_RESET');
    assert.equal(validToken?.id, authTokenId);

    const sessionToken = signSessionToken({ sessionId, userId });
    const context = await resolveAuthContextWithKnex(sessionToken);
    assert.equal(context?.userId, userId);
    assert.equal(context?.restaurantId, restaurantId);
    assert.equal(context?.role, 'OWNER');

    await knexAuthRepository.markAuthTokenUsed(authTokenId);
    const consumedToken = await knexAuthRepository.findValidAuthToken(tokenHash, 'PASSWORD_RESET');
    assert.ok(consumedToken?.used_at);

    await knexAuthRepository.revokeSession(sessionId);
    const revokedContext = await resolveAuthContextWithKnex(sessionToken);
    assert.equal(revokedContext, null);
  } finally {
    await db('audit_logs').where({ target_id: sessionId }).del();
    await db('auth_tokens').where({ user_id: userId }).del();
    await db('sessions').where({ user_id: userId }).del();
    await db('restaurant_members').where({ user_id: userId }).del();
    await db('subscriptions').where({ restaurant_id: restaurantId }).del();
    await db('qr_codes').where({ restaurant_id: restaurantId }).del();
    await db('dining_tables').where({ restaurant_id: restaurantId }).del();
    await db('menu_categories').where({ restaurant_id: restaurantId }).del();
    await db('users').where({ id: userId }).del();
    await db('restaurants').where({ id: restaurantId }).del();
    await db('tenants').where({ id: restaurantId }).del();
  }
});


test('PostgreSQL public catalog and order tracking reads are tenant/table scoped', async () => {
  const db = getKnex();
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const restaurantId = `it_pub_rest_${suffix}`;
  const userId = `it_pub_user_${suffix}`;
  const memberId = `it_pub_member_${suffix}`;
  const subscriptionId = `it_pub_sub_${suffix}`;
  const sessionId = `it_pub_session_${suffix}`;
  const slug = `it-pub-${suffix}`;
  const email = `it-pub-${suffix}@example.invalid`;
  const qrToken = `${slug}-t1-v1`;
  const orderId = `it_pub_order_${suffix}`;
  const storefrontOrderId = `it_pub_store_order_${suffix}`;
  const menuItemId = `it_pub_item_${suffix}`;
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  let tableId = '';
  let tableCallId = '';

  try {
    const plan = await knexAuthRepository.findPlanForRegistration('ESSENTIEL');
    assert.ok(plan?.id);
    await db.transaction(async (trx) => {
      await knexAuthRepository.createRestaurantWithOwnerAndStarterData({
        restaurantId, restaurantName: 'Public Repository Integration',
        slug, email, phone: '+22500000001', city: 'Abidjan',
        userId, ownerName: 'Public Test Owner', passwordHash: 'not-used',
        memberId, subId: subscriptionId, planId: plan.id,
        trialEndsAt: future, sessionId, sessionExpiresAt: future,
        userAgent: 'public-repository-test', now,
      }, trx);
    });

    const table = await db('dining_tables').where({ restaurant_id: restaurantId }).orderBy('label').first();
    assert.ok(table?.id);
    tableId = String(table.id);

    await db('menu_items').insert({
      id: menuItemId, restaurant_id: restaurantId,
      category_id: (await db('menu_categories').where({ restaurant_id: restaurantId }).first()).id,
      name: 'Plat de test', description: 'Test PostgreSQL', price_xof: 2500,
      available: 1, sort_order: 1, options_json: '[]', option_groups_json: '[]',
      created_at: now,
    });

    await db('orders').insert({
      id: orderId, restaurant_id: restaurantId, order_number: `IT-${suffix}-1`,
      order_type: 'QR_TABLE', table_id: tableId, customer_name: 'Client QR',
      customer_phone: '+22500000002', status: 'PENDING', subtotal_xof: 2500,
      discount_xof: 0, tax_xof: 0, total_xof: 2500, paid_xof: 0,
      idempotency_key: `it-${suffix}`, notes: '', created_at: now, updated_at: now,
    });
    await db('order_items').insert({
      id: `it_pub_line_${suffix}`, order_id: orderId, menu_item_id: menuItemId,
      name: 'Plat de test', station: 'KITCHEN', unit_price_xof: 2500,
      options_summary: '', options_delta_xof: 0, quantity: 1,
      line_total_xof: 2500, notes: '', prep_status: 'PENDING',
    });

    await db('orders').insert({
      id: storefrontOrderId, restaurant_id: restaurantId,
      order_number: `IT-${suffix}-2`, order_type: 'DELIVERY', table_id: null,
      customer_name: 'Client livraison', customer_phone: '+22500000003',
      delivery_address: 'Abidjan', delivery_zone: 'Cocody', delivery_fee_xof: 500,
      scheduled_slot: '', status: 'PENDING', subtotal_xof: 2500, discount_xof: 0,
      tax_xof: 0, total_xof: 3000, paid_xof: 0, notes: '',
      created_at: now, updated_at: now,
    });

    const qrContext = await knexPublicRepository.findQrContextByToken(qrToken);
    assert.equal(qrContext?.restaurant_id, restaurantId);
    assert.equal(qrContext?.table_id, tableId);

    const storefront = await knexPublicRepository.findStorefrontBySlug(slug);
    assert.equal(storefront?.id, restaurantId);

    const categories = await knexPublicRepository.findActiveCategories(restaurantId);
    assert.equal(categories.length, 2);
    const items = await knexPublicRepository.findAvailableMenuItems(restaurantId);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, menuItemId);

    const item = await knexPublicRepository.findMenuItemWithStation(menuItemId, restaurantId);
    assert.equal(item?.station, 'KITCHEN');
    assert.equal(Number(item?.category_active), 1);

    const qrSessionId = await knexPublicRepository.createQrTableSession({
      restaurantId, tableId, qrToken, expiresAt: future,
    });
    assert.equal((await knexPublicRepository.findQrTableSession(qrSessionId))?.table_id, tableId);

    const trackedQr = await knexPublicRepository.findTrackedQrOrder(qrToken, orderId);
    assert.equal(trackedQr?.order.id, orderId);
    assert.equal(trackedQr?.items.length, 1);

    const call = await knexPublicRepository.createTableCall({
      restaurantId, tableId, tableLabel: String(table.label),
      callType: 'WAITER', note: `Integration table call ${suffix}`,
    });
    tableCallId = call.id;
    assert.ok(await db('table_calls').where({ id: tableCallId }).first());
    assert.ok(await db('notifications').where({ restaurant_id: restaurantId, message: call.note }).first());

    const review = await knexPublicRepository.insertCustomerReview({
      restaurantId, orderId, orderNumber: `IT-${suffix}-1`,
      tableLabel: String(table.label), customerName: 'Test Guest',
      rating: 5, serviceRating: 5, foodRating: 4, speedRating: 5,
      waiterName: 'Test Waiter', channel: 'QR_ORDER', comment: 'Test review',
    });
    assert.ok(review.id);
    const trackedQrWithReview = await knexPublicRepository.findTrackedQrOrder(qrToken, orderId);
    assert.equal(trackedQrWithReview?.review?.id, review.id);

    const trackedStorefront = await knexPublicRepository.findTrackedStorefrontOrder(slug, storefrontOrderId);
    assert.equal(trackedStorefront?.order.id, storefrontOrderId);

    assert.equal(await knexPublicRepository.countOrdersForRestaurant(restaurantId), 2);
    assert.equal((await knexPublicRepository.findOrderByIdempotencyKey(restaurantId, `it-${suffix}`))?.id, orderId);
    assert.equal((await knexPublicRepository.findPublicRatingStats(restaurantId)).total, 1);

    const leadId = await knexPublicRepository.createLead({
      leadType: 'CONTACT', fullName: 'Test Lead', email,
      phone: '+22500000004', restaurantName: 'Test', city: 'Abidjan',
      message: 'Integration test lead',
    });
    assert.ok(await db('contact_leads').where({ id: leadId }).first());
  } finally {
    await db('contact_leads').where({ email }).del();
    await db('qr_table_sessions').where({ restaurant_id: restaurantId }).del();
    await db('table_calls').where({ restaurant_id: restaurantId }).del();
    await db('notifications').where({ restaurant_id: restaurantId, message: `Integration table call ${suffix}` }).del();
    await db('customer_reviews').where({ order_id: orderId }).del();
    await db('order_items').whereIn('order_id', [orderId, storefrontOrderId]).del();
    await db('orders').where({ restaurant_id: restaurantId }).del();
    await db('menu_items').where({ id: menuItemId }).del();
    await db('restaurant_members').where({ restaurant_id: restaurantId }).del();
    await db('subscriptions').where({ restaurant_id: restaurantId }).del();
    await db('qr_codes').where({ restaurant_id: restaurantId }).del();
    await db('dining_tables').where({ restaurant_id: restaurantId }).del();
    await db('menu_categories').where({ restaurant_id: restaurantId }).del();
    await db('sessions').where({ user_id: userId }).del();
    await db('users').where({ id: userId }).del();
    await db('restaurants').where({ id: restaurantId }).del();
    await db('tenants').where({ id: restaurantId }).del();
  }
});


test('PostgreSQL menu and operations repositories support tenant-scoped combo and promotion CRUD', async () => {
  const db = getKnex();
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const restaurantId = `it_menu_rest_${suffix}`;
  const userId = `it_menu_user_${suffix}`;
  const memberId = `it_menu_member_${suffix}`;
  const subscriptionId = `it_menu_sub_${suffix}`;
  const sessionId = `it_menu_session_${suffix}`;
  const slug = `it-menu-${suffix}`;
  const email = `it-menu-${suffix}@example.invalid`;
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  let menuItemId = `it_menu_item_${suffix}`;
  let comboId = '';
  let promotionId = '';

  try {
    const plan = await knexAuthRepository.findPlanForRegistration('ESSENTIEL');
    assert.ok(plan?.id);
    await db.transaction(async (trx) => {
      await knexAuthRepository.createRestaurantWithOwnerAndStarterData({
        restaurantId, restaurantName: 'Menu Repository Integration',
        slug, email, phone: '+22500000004', city: 'Abidjan',
        userId, ownerName: 'Menu Test Owner', passwordHash: 'not-used',
        memberId, subId: subscriptionId, planId: plan.id,
        trialEndsAt: future, sessionId, sessionExpiresAt: future,
        userAgent: 'menu-repository-test', now,
      }, trx);
    });

    const category = await db('menu_categories')
      .where({ restaurant_id: restaurantId }).first();
    assert.ok(category?.id);
    await db('menu_items').insert({
      id: menuItemId, restaurant_id: restaurantId,
      category_id: category.id, name: 'Plat PostgreSQL',
      description: 'Fixture integration', price_xof: 3200,
      cost_price_xof: 900, image_url: null, available: 1,
      sort_order: 1, options_json: '[]', option_groups_json: '[]',
      created_at: now,
    });

    const orderId = `it_order_${suffix}`;
    const diningTable = await db('dining_tables').where({ restaurant_id: restaurantId }).first();
    const orderDeduction = await db.transaction(async (trx) => {
      await knexRestaurantStockRepository.insertPosOrder(trx, {
        orderId, rid: restaurantId, orderNumber: `IT-${suffix.slice(0, 6)}`,
        orderType: 'DINE_IN', tableId: String(diningTable.id),
        customerName: 'Client integration', customerPhone: '',
        subtotalXof: 3200, discountXof: 0, taxXof: 0, totalXof: 3200,
        notes: '', idempotencyKey: `it-idem-${suffix}`,
        userId, now,
        lines: [{
          id: `it_order_item_${suffix}`, menuItemId,
          name: 'Plat PostgreSQL', station: 'KITCHEN',
          unitPriceXof: 3200, optionsSummary: '', optionsDeltaXof: 0,
          quantity: 1, lineTotalXof: 3200, notes: '',
        }],
      });
      return knexRestaurantStockRepository.deductStocksForOrderItems(trx, {
        rid: restaurantId, orderNumber: `IT-${suffix.slice(0, 6)}`,
        items: [{ menuItemId, quantity: 1 }], userId, now,
      });
    });
    assert.equal(orderDeduction.deductedCount, 1);
    assert.equal(Number((await db('stocks').select('quantity').where({ id: stockId, restaurant_id: restaurantId }).first())?.quantity), 9.5);
    assert.equal((await knexRestaurantStockRepository.findOrderByIdempotencyKey(
      restaurantId, `it-idem-${suffix}`,
    ))?.id, orderId);
    const orderList = await knexRestaurantStockRepository.findOrdersWithItems(restaurantId);
    assert.equal(orderList.find((row) => row.id === orderId)?.items.length, 1);
    await db.transaction(async (trx) => {
      const order = await knexRestaurantStockRepository.findOrderForUpdate(orderId, restaurantId, trx);
      assert.equal(order?.status, 'PENDING');
      assert.equal(await knexRestaurantStockRepository.updateOrderAndPrepStatus(
        trx, orderId, restaurantId, 'IN_PREPARATION', String(order?.table_id),
      ), 1);
    });
    assert.equal(String((await db('order_items').where({ order_id: orderId }).first())?.prep_status), 'PREPARING');

    const register = await db.transaction((trx) =>
      knexOperationsReadRepository.openRegisterSession(trx, {
        rid: restaurantId, userId, userName: 'Menu Test Owner',
        openingFloatXof: 10000, notes: 'integration',
      }),
    );
    assert.equal(register.status, 'OPEN');
    const liveTotals = await knexOperationsReadRepository.computeRegisterLiveTotals(
      restaurantId, register.openedAt, register.openingFloatXof,
    );
    assert.equal(liveTotals.expectedCashXof, 10000);
    const closedRegister = await db.transaction((trx) =>
      knexOperationsReadRepository.closeRegisterSession(trx, {
        id: register.id, rid: restaurantId, zNumber: 'Z-IT-001',
        userId, userName: 'Menu Test Owner',
        expectedCashXof: liveTotals.expectedCashXof,
        expectedMobileXof: liveTotals.expectedMobileXof,
        expectedCardXof: liveTotals.expectedCardXof,
        countedCashXof: 10000, countedMobileXof: 0, countedCardXof: 0,
        varianceXof: 0, totalSalesXof: 0, refundsXof: 0,
        ordersCount: 0, notes: 'integration close',
      }),
    );
    assert.equal(closedRegister.status, 'CLOSED');

    const shift = await knexOperationsReadRepository.createShift({
      restaurantId, userId, shiftDate: now.slice(0, 10),
      startTime: '08:00', endTime: '16:00', notes: 'integration shift',
    });
    assert.equal(shift.userId, userId);
    assert.equal((await knexOperationsReadRepository.findStaffShifts(restaurantId)).some((row) => row.id === shift.id), true);
    assert.equal(await knexOperationsReadRepository.deleteShift(restaurantId, shift.id), 1);

    const stockId = `it_stock_${suffix}`;
    await db('stocks').insert({
      id: stockId, restaurant_id: restaurantId, name: 'Stock integration',
      unit: 'kg', stock_section: 'KITCHEN', quantity: 5,
      min_threshold: 1, unit_cost_xof: 1000, supplier_name: '',
      updated_at: now,
    });
    const recipeCost = await db.transaction((trx) =>
      knexRestaurantStockRepository.replaceMenuItemRecipe(trx, restaurantId, menuItemId, [
        { stockId, quantityPerUnit: 1.5 },
      ]),
    );
    assert.equal(recipeCost, 1500);
    assert.equal((await knexRestaurantStockRepository.findMenuRecipes(restaurantId, menuItemId)).length, 1);

    const extraCategoryId = await knexRestaurantStockRepository.createCategory(
      restaurantId, 'Catégorie CRUD', 'KITCHEN', 10,
    );
    assert.ok(await knexRestaurantStockRepository.findCategory(extraCategoryId, restaurantId));
    assert.equal(await knexRestaurantStockRepository.updateCategory(extraCategoryId, restaurantId, {
      name: 'Catégorie modifiée', active: false,
    }), 1);
    assert.equal((await knexRestaurantStockRepository.findCategory(extraCategoryId, restaurantId))?.name, 'Catégorie modifiée');
    assert.equal(await knexRestaurantStockRepository.countItemsInCategory(extraCategoryId, restaurantId), 0);
    assert.equal(await knexRestaurantStockRepository.deleteCategory(extraCategoryId, restaurantId), 1);

    const extraMenuItemId = await knexRestaurantStockRepository.createMenuItem({
      rid: restaurantId, categoryId: String(category.id),
      name: 'Article CRUD', description: 'fixture', priceXof: 1500,
      costPriceXof: 400, imageUrl: null, available: true,
      sortOrder: 5, optionsJson: '[]', optionGroupsJson: '[]',
    });
    assert.ok(await knexRestaurantStockRepository.findMenuItemById(extraMenuItemId, restaurantId));
    assert.equal(await knexRestaurantStockRepository.updateMenuItem(extraMenuItemId, restaurantId, {
      name: 'Article CRUD modifié', available: false,
    }), 1);
    assert.equal((await knexRestaurantStockRepository.findMenuItems(restaurantId)).find((row) => row.id === extraMenuItemId)?.name, 'Article CRUD modifié');
    assert.equal(await knexRestaurantStockRepository.countOrderReferencesForMenuItem(extraMenuItemId, restaurantId), 0);
    assert.equal(await knexRestaurantStockRepository.deleteMenuItem(extraMenuItemId, restaurantId), 1);

    const inventory = await db.transaction((trx) =>
      knexOperationsReadRepository.createInventoryCount(trx, {
        restaurantId, title: 'Inventaire test', stockSection: 'KITCHEN',
        notes: 'integration', createdByName: 'Menu Test Owner', userId,
        lines: [{ stockId, countedQty: 8 }],
      }),
    );
    assert.equal(inventory.totalVarianceXof, 3000);
    const inventoryRead = await knexOperationsReadRepository.findInventoryCounts(restaurantId);
    assert.equal(inventoryRead.find((row) => row.id === inventory.id)?.lines[0]?.varianceQty, 3);

    const waste = await db.transaction((trx) =>
      knexOperationsReadRepository.recordTypedWaste(trx, {
        restaurantId, stockId, quantity: 2, category: 'EXPIRED',
        reason: 'integration waste', userId,
      }),
    );
    assert.equal(waste.quantity, 6);
    await assert.rejects(
      db.transaction((trx) => knexOperationsReadRepository.recordTypedWaste(trx, {
        restaurantId, stockId, quantity: 7, category: 'BROKEN',
        reason: 'overdraw should fail', userId,
      })),
      /Stock insuffisant/,
    );

    const movementIn = await db.transaction((trx) =>
      knexRestaurantStockRepository.applyStockMovement(trx, {
        rid: restaurantId, stockId, movementType: 'IN', quantity: 4,
        reason: 'integration receipt', userId,
      }),
    );
    assert.equal(movementIn.quantity, 10);
    const movementOut = await db.transaction((trx) =>
      knexRestaurantStockRepository.applyStockMovement(trx, {
        rid: restaurantId, stockId, movementType: 'OUT', quantity: 2,
        reason: 'integration issue', userId,
      }),
    );
    assert.equal(movementOut.quantity, 8);
    await assert.rejects(
      db.transaction((trx) => knexRestaurantStockRepository.applyStockMovement(trx, {
        rid: restaurantId, stockId, movementType: 'LOSS', quantity: 9,
        reason: 'overdraw should fail', userId,
      })),
      /Stock insuffisant/,
    );
    const stockSummary = await knexRestaurantStockRepository.findStocksAndMovements(restaurantId);
    assert.ok(stockSummary.stocks.some((row) => row.id === stockId));
    assert.ok(stockSummary.movements.some((row) => row.movementType === 'OUT'));

    const deletableStockId = await knexRestaurantStockRepository.createStockItem({
      rid: restaurantId, name: 'Stock sans historique', unit: 'piece',
      stockSection: 'BEVERAGE', quantity: 0, minThreshold: 0,
      unitCostXof: 0, supplierName: '',
    });
    await db.transaction((trx) =>
      knexRestaurantStockRepository.deleteStockItem(trx, deletableStockId, restaurantId),
    );
    await assert.rejects(
      db.transaction((trx) => knexRestaurantStockRepository.deleteStockItem(trx, stockId, restaurantId)),
      /historique ou est utilisé/,
    );

    const purchaseOrder = await db.transaction((trx) =>
      knexRestaurantStockRepository.createPurchaseOrder(trx, {
        id: `it_po_${suffix}`, rid: restaurantId,
        supplierName: 'Fournisseur test', status: 'ORDERED',
        totalCostXof: 3000, notes: 'integration purchase',
        expectedDate: future, userId,
        items: [{
          id: `it_poi_${suffix}`, stockId, stockName: 'Stock integration',
          unit: 'kg', quantity: 3, unitCostXof: 1000, lineTotalXof: 3000,
        }],
      }),
    );
    assert.match(purchaseOrder.poNumber, /^PO-/);
    assert.equal((await knexRestaurantStockRepository.findPurchaseOrders(restaurantId)).some((row) => row.id === `it_po_${suffix}`), true);
    const receivedPo = await db.transaction((trx) =>
      knexRestaurantStockRepository.updatePurchaseOrderStatus(trx, {
        poId: `it_po_${suffix}`, rid: restaurantId, status: 'RECEIVED', userId,
      }),
    );
    assert.equal(receivedPo.supplierName, 'Fournisseur test');
    assert.equal(Number((await db('stocks').select('quantity').where({ id: stockId, restaurant_id: restaurantId }).first())?.quantity), 11);
    await assert.rejects(
      db.transaction((trx) => knexRestaurantStockRepository.updatePurchaseOrderStatus(trx, {
        poId: `it_po_${suffix}`, rid: restaurantId, status: 'RECEIVED', userId,
      })),
      /déjà clôturé/,
    );

    await knexRestaurantStockRepository.upsertStockAlertSettings({
      rid: restaurantId, inAppEnabled: true, emailEnabled: false,
      recipientEmails: '', smtpHost: '', smtpPort: 587,
      smtpSecure: false, smtpUser: '', smtpPass: 'secret-test', smtpFrom: '',
    });
    const alertSettings = await knexRestaurantStockRepository.findStockAlertSettings(restaurantId);
    assert.equal(alertSettings.emailEnabled, false);
    assert.equal(alertSettings.smtpPass, 'secret-test');
    assert.ok((await knexRestaurantStockRepository.findManagerEmailsForRestaurant(restaurantId)).includes(email));
    const notification = await knexRestaurantStockRepository.createNotification({
      rid: restaurantId, type: 'STOCK_CRITICAL', title: 'Test alert',
      message: 'Integration alert', stockId, emailDispatched: false,
      emailRecipients: '', emailStatus: 'SKIPPED',
    });
    assert.equal((await knexRestaurantStockRepository.findNotificationsForRestaurant(restaurantId)).some((row) => row.id === notification.id), true);
    assert.equal(await knexRestaurantStockRepository.markNotificationsRead(restaurantId, notification.id), 1);
    assert.equal((await knexRestaurantStockRepository.findNotificationsForRestaurant(restaurantId)).find((row) => row.id === notification.id)?.isRead, true);

    const clockIn = await db.transaction((trx) =>
      knexOperationsReadRepository.toggleStaffClock(trx, {
        restaurantId, userId, action: 'AUTO', notes: 'integration in',
        actorUserId: userId, actorEmail: email, actorRole: 'OWNER',
      }),
    );
    assert.equal(clockIn.action, 'CLOCK_IN');
    const clockOut = await db.transaction((trx) =>
      knexOperationsReadRepository.toggleStaffClock(trx, {
        restaurantId, userId, action: 'AUTO', notes: 'integration out',
        actorUserId: userId, actorEmail: email, actorRole: 'OWNER',
      }),
    );
    assert.equal(clockOut.action, 'CLOCK_OUT');
    assert.ok(clockOut.durationMinutes >= 1);

    const proforma = await db.transaction((trx) =>
      knexOperationsReadRepository.createB2bInvoice(trx, {
        restaurantId, id: `it_b2b_${suffix}`, docType: 'PROFORMA',
        clientName: 'Client test', clientCompany: '', clientTaxId: '',
        clientEmail: '', clientPhone: '', clientAddress: '',
        items: [{ description: 'Prestation', quantity: 2, unitPriceXof: 1000, lineTotalXof: 2000 }],
        subtotalHtXof: 2000, taxRatePercent: 18, taxXof: 360,
        totalTtcXof: 2360, status: 'SENT', dueDate: null, notes: 'integration',
      }),
    );
    assert.match(proforma.invoiceNumber, /^PROF-/);
    assert.equal(await knexOperationsReadRepository.updateB2bInvoiceStatus(restaurantId, proforma.id, 'ACCEPTED'), 1);
    const converted = await db.transaction((trx) =>
      knexOperationsReadRepository.convertProformaToInvoice(trx, {
        restaurantId, proformaId: proforma.id, newId: `it_b2b_invoice_${suffix}`,
      }),
    );
    assert.equal(converted.invoice.docType, 'INVOICE');
    assert.match(converted.invoice.invoiceNumber, /^FACT-/);

    const branchId = `it_branch_${suffix}`;
    await db.transaction((trx) =>
      knexOperationsReadRepository.createBranchVenue(trx, {
        sourceRestaurantId: restaurantId, restaurantId: branchId,
        name: 'Branch Integration', slug: `it-branch-${suffix}`,
        email: `branch-${suffix}@example.invalid`, phone: '+22500000005',
        address: 'Abidjan', city: 'Abidjan', ownerUserId: userId,
        planId: plan.id, trialEndsAt: future, now,
      }),
    );
    const consolidated = await knexOperationsReadRepository.findConsolidatedOverview(userId);
    assert.equal(consolidated.venues.some((venue) => venue.restaurantId === branchId), true);
    assert.equal(await db('dining_tables').where({ restaurant_id: branchId }).count({ c: '*' }).first().then((row) => Number(row?.c || 0)), 4);
    assert.equal(await db('qr_codes').where({ restaurant_id: branchId }).count({ c: '*' }).first().then((row) => Number(row?.c || 0)), 4);

    const categories = await knexRestaurantStockRepository.findMenuCategories(restaurantId);
    const items = await knexRestaurantStockRepository.findMenuItems(restaurantId);
    assert.ok(categories.some((row) => String(row.id) === String(category.id)));
    assert.ok(items.some((row) => String(row.id) === menuItemId));

    comboId = await knexOperationsReadRepository.createCombo({
      rid: restaurantId, name: 'Menu test combo', description: 'Fixture',
      priceXof: 5000, imageUrl: null, isDailySpecial: false,
      items: [{ label: 'Plat PostgreSQL', quantity: 1, menuItemId }],
    });
    assert.ok(await knexOperationsReadRepository.findComboById(comboId, restaurantId));
    assert.equal((await knexOperationsReadRepository.findCombos(restaurantId, true)).some((row) => row.id === comboId), true);
    await knexOperationsReadRepository.updateCombo(comboId, restaurantId, { active: false });
    assert.equal((await knexOperationsReadRepository.findCombos(restaurantId, true)).some((row) => row.id === comboId), false);

    promotionId = await knexOperationsReadRepository.createPromotion({
      rid: restaurantId, name: 'Promotion test', code: 'ITMENU',
      promoType: 'PROMO_CODE', discountType: 'PERCENT',
      discountValue: 10, minOrderXof: 1000, days: [0, 1, 2, 3, 4, 5, 6],
      startTime: '00:00', endTime: '23:59', categoryId: null, maxUses: 20,
    });
    assert.ok((await knexOperationsReadRepository.findPromotions(restaurantId)).some((row) => row.id === promotionId));
    await knexOperationsReadRepository.updatePromotion(promotionId, restaurantId, { active: false });
    assert.equal((await knexOperationsReadRepository.findPromotions(restaurantId)).find((row) => row.id === promotionId)?.active, false);

    assert.equal((await knexOperationsReadRepository.findCombos(`other_${suffix}`)).length, 0);
    assert.equal((await knexOperationsReadRepository.findPromotions(`other_${suffix}`)).length, 0);
  } finally {
    if (promotionId) await db('promotions').where({ id: promotionId, restaurant_id: restaurantId }).del();
    await db('qr_codes').where({ restaurant_id: `it_branch_${suffix}` }).del();
    await db('dining_tables').where({ restaurant_id: `it_branch_${suffix}` }).del();
    await db('menu_categories').where({ restaurant_id: `it_branch_${suffix}` }).del();
    await db('restaurant_members').where({ restaurant_id: `it_branch_${suffix}` }).del();
    await db('subscriptions').where({ restaurant_id: `it_branch_${suffix}` }).del();
    await db('restaurants').where({ id: `it_branch_${suffix}` }).del();
    await db('tenants').where({ id: `it_branch_${suffix}` }).del();
    await db('purchase_order_items').whereIn('purchase_order_id', db('purchase_orders').select('id').where({ restaurant_id: restaurantId })).del();
    await db('purchase_orders').where({ restaurant_id: restaurantId }).del();
    await db('notifications').where({ restaurant_id: restaurantId }).del();
    await db('stock_alert_settings').where({ restaurant_id: restaurantId }).del();
    await db('order_items').whereIn('order_id', db('orders').select('id').where({ restaurant_id: restaurantId })).del();
    await db('orders').where({ restaurant_id: restaurantId }).del();
    await db('b2b_invoices').where({ restaurant_id: restaurantId }).del();
    await db('staff_time_clocks').where({ restaurant_id: restaurantId }).del();
    await db('inventory_count_lines').whereIn('inventory_count_id', db('inventory_counts').select('id').where({ restaurant_id: restaurantId })).del();
    await db('inventory_counts').where({ restaurant_id: restaurantId }).del();
    await db('stock_movements').where({ restaurant_id: restaurantId }).del();
    await db('stocks').where({ restaurant_id: restaurantId }).del();
    await db('cash_register_sessions').where({ restaurant_id: restaurantId }).del();
    if (comboId) await db('menu_combos').where({ id: comboId, restaurant_id: restaurantId }).del();
    await db('menu_items').where({ id: menuItemId, restaurant_id: restaurantId }).del();
    await db('audit_logs').where({ restaurant_id: restaurantId }).del();
    await db('auth_tokens').where({ user_id: userId }).del();
    await db('sessions').where({ user_id: userId }).del();
    await db('restaurant_members').where({ user_id: userId }).del();
    await db('subscriptions').where({ restaurant_id: restaurantId }).del();
    await db('qr_codes').where({ restaurant_id: restaurantId }).del();
    await db('dining_tables').where({ restaurant_id: restaurantId }).del();
    await db('menu_categories').where({ restaurant_id: restaurantId }).del();
    await db('users').where({ id: userId }).del();
    await db('restaurants').where({ id: restaurantId }).del();
    await db('tenants').where({ id: restaurantId }).del();
  }
});


test('PostgreSQL superadmin platform settings upsert and read are persistent', async () => {
  const key = `it_platform_setting_${crypto.randomUUID().replace(/-/g, '')}`;
  const db = getKnex();
  try {
    await knexSuperadminSettingsRepository.upsertPlatformSettings([[key, 'first']]);
    assert.equal((await knexSuperadminSettingsRepository.findPlatformSettings()).find((row) => row.key === key)?.value, 'first');
    await knexSuperadminSettingsRepository.upsertPlatformSettings([[key, 'updated']]);
    assert.equal((await knexSuperadminSettingsRepository.findPlatformSettings()).find((row) => row.key === key)?.value, 'updated');
  } finally {
    await db('platform_settings').where({ key }).del();
  }
});

