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

