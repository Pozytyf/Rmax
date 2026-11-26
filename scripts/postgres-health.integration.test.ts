import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnexMigrationsCurrent, getKnex } from '../src/server/knex.ts';
import { checkSupabaseHealth } from '../src/server/lib/supabase.ts';
import crypto from 'node:crypto';
import { knexAuthRepository } from '../src/server/repositories/authRepository.knex.ts';
import { recordAuditWithKnex, resolveAuthContextWithKnex, signSessionToken } from '../src/server/auth.ts';

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
