import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { getKnex } from '../knex.ts';

export class KnexPublicRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  private id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  }

  async findActivePlans() {
    return this.db('plans')
      .select('id', 'code', 'name', 'tagline', 'price_monthly_xof', 'price_yearly_xof',
        'trial_days', 'max_tables', 'max_staff', 'max_menu_items',
        'is_demo_pricing', 'is_featured', 'features_json', 'active')
      .where('active', 1)
      .orderBy('price_monthly_xof', 'asc');
  }

  async findAllPlatformSettings() {
    return this.db('platform_settings').select('key', 'value');
  }

  async createLead(params: {
    leadType: 'CONTACT' | 'DEMO_REQUEST';
    fullName: string;
    email: string;
    phone: string;
    restaurantName: string;
    city: string;
    message: string;
  }): Promise<string> {
    const id = this.id(params.leadType === 'CONTACT' ? 'lead' : 'demo');
    await this.db('contact_leads').insert({
      id, lead_type: params.leadType, full_name: params.fullName,
      email: params.email, phone: params.phone, restaurant_name: params.restaurantName,
      city: params.city, message: params.message, created_at: new Date().toISOString(),
    });
    return id;
  }

  async findQrContextByToken(token: string) {
    return this.db('qr_codes as q')
      .join('dining_tables as t', 't.id', 'q.table_id')
      .join('restaurants as r', 'r.id', 'q.restaurant_id')
      .select({
        qr_id: 'q.id', token: 'q.token', version: 'q.version', qr_status: 'q.status',
        table_id: 't.id', table_label: 't.label', table_zone: 't.zone',
        restaurant_id: 'r.id', restaurant_name: 'r.name', restaurant_slug: 'r.slug',
        city: 'r.city', currency: 'r.currency', tax_rate_percent: 'r.tax_rate_percent',
        opening_hours: 'r.opening_hours', loyalty_enabled: 'r.loyalty_enabled',
        loyalty_points_per_1000_xof: 'r.loyalty_points_per_1000_xof',
        loyalty_xof_per_point: 'r.loyalty_xof_per_point',
        restaurant_status: 'r.status', deleted_at: 'r.deleted_at',
      })
      .where('q.token', token)
      .first();
  }

  async findStorefrontBySlug(slug: string) {
    return this.db('restaurants')
      .select('id', 'name', 'slug', 'city', 'address', 'phone', 'currency', 'tax_rate_percent',
        'opening_hours', 'paydunya_mode', 'storefront_enabled', 'delivery_enabled',
        'delivery_zones_json', 'pickup_slots_json', 'loyalty_enabled',
        'loyalty_points_per_1000_xof', 'loyalty_xof_per_point', 'status', 'deleted_at')
      .where({ slug })
      .first();
  }

  async createQrTableSession(params: {
    restaurantId: string; tableId: string; qrToken: string; expiresAt: string;
  }): Promise<string> {
    const id = this.id('qrs');
    await this.db('qr_table_sessions').insert({
      id, restaurant_id: params.restaurantId, table_id: params.tableId,
      qr_token: params.qrToken, expires_at: params.expiresAt,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async findQrTableSession(sessionId: string) {
    return this.db('qr_table_sessions')
      .select('id', 'restaurant_id', 'table_id', 'expires_at')
      .where({ id: sessionId })
      .first();
  }

  async findActiveCategories(restaurantId: string) {
    return this.db('menu_categories')
      .select('id', 'name', 'station', 'sort_order')
      .where({ restaurant_id: restaurantId, active: 1 })
      .orderBy('sort_order', 'asc');
  }

  async findAvailableMenuItems(restaurantId: string) {
    return this.db('menu_items as m')
      .join('menu_categories as c', 'c.id', 'm.category_id')
      .select('m.id', 'm.category_id', 'm.name', 'm.description', 'm.price_xof',
        'm.image_url', 'm.options_json', 'm.option_groups_json', 'c.station')
      .where('m.restaurant_id', restaurantId)
      .where('m.available', 1)
      .where('c.active', 1)
      .orderBy('c.sort_order', 'asc')
      .orderBy('m.sort_order', 'asc')
      .orderBy('m.name', 'asc');
  }

  async findOrderByIdempotencyKey(restaurantId: string, idempotencyKey: string) {
    return this.db('orders')
      .select('id', 'order_number', 'total_xof', 'status', 'order_type')
      .where({ restaurant_id: restaurantId, idempotency_key: idempotencyKey })
      .first();
  }

  async countOrdersForRestaurant(restaurantId: string): Promise<number> {
    const row = await this.db('orders').where({ restaurant_id: restaurantId }).count({ c: '*' }).first();
    return Number(row?.c || 0);
  }

  async findMenuItemWithStation(menuItemId: string, restaurantId: string) {
    return this.db('menu_items as m')
      .join('menu_categories as c', 'c.id', 'm.category_id')
      .select('m.id', 'm.category_id', 'm.name', 'm.price_xof', 'm.available',
        'm.options_json', 'm.option_groups_json', { station: 'c.station' },
        { category_active: 'c.active' })
      .where('m.id', menuItemId)
      .where('m.restaurant_id', restaurantId)
      .first();
  }

  async findTrackedQrOrder(token: string, orderId: string) {
    const order = await this.db('orders as o')
      .join('qr_codes as q', function () {
        this.on('q.table_id', '=', 'o.table_id').andOn('q.restaurant_id', '=', 'o.restaurant_id');
      })
      .join('dining_tables as t', 't.id', 'o.table_id')
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', order_number: 'o.order_number', order_type: 'o.order_type',
        status: 'o.status', discount_xof: 'o.discount_xof', total_xof: 'o.total_xof',
        paid_xof: 'o.paid_xof', notes: 'o.notes', customer_name: 'o.customer_name',
        customer_phone: 'o.customer_phone', promo_code: 'o.promo_code',
        loyalty_points_used: 'o.loyalty_points_used', loyalty_points_earned: 'o.loyalty_points_earned',
        created_at: 'o.created_at', updated_at: 'o.updated_at', table_label: 't.label',
        restaurant_name: 'r.name', loyalty_enabled: 'r.loyalty_enabled',
      })
      .where('q.token', token)
      .where('o.id', orderId)
      .first();
    if (!order) return null;
    const items = await this.db('order_items')
      .select('id', 'name', 'station', 'quantity', 'options_summary', 'line_total_xof', 'notes', 'prep_status')
      .where({ order_id: orderId });
    const review = await this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  async findTrackedStorefrontOrder(slug: string, orderId: string) {
    const order = await this.db('orders as o')
      .join('restaurants as r', 'r.id', 'o.restaurant_id')
      .select({
        id: 'o.id', order_number: 'o.order_number', order_type: 'o.order_type',
        status: 'o.status', discount_xof: 'o.discount_xof', total_xof: 'o.total_xof',
        paid_xof: 'o.paid_xof', notes: 'o.notes', customer_name: 'o.customer_name',
        customer_phone: 'o.customer_phone', delivery_address: 'o.delivery_address',
        delivery_zone: 'o.delivery_zone', delivery_fee_xof: 'o.delivery_fee_xof',
        scheduled_slot: 'o.scheduled_slot', promo_code: 'o.promo_code',
        loyalty_points_used: 'o.loyalty_points_used', loyalty_points_earned: 'o.loyalty_points_earned',
        created_at: 'o.created_at', updated_at: 'o.updated_at', restaurant_name: 'r.name',
        restaurant_slug: 'r.slug', restaurant_phone: 'r.phone', restaurant_address: 'r.address',
        restaurant_city: 'r.city', loyalty_enabled: 'r.loyalty_enabled',
      })
      .where('r.slug', slug)
      .where('o.id', orderId)
      .whereIn('o.order_type', ['CLICK_COLLECT', 'DELIVERY'])
      .first();
    if (!order) return null;
    const items = await this.db('order_items')
      .select('id', 'name', 'station', 'quantity', 'options_summary', 'line_total_xof', 'notes', 'prep_status')
      .where({ order_id: orderId });
    const review = await this.findReviewByOrderId(orderId);
    return { order, items, review };
  }

  async findReviewByOrderId(orderId: string) {
    const r = await this.db('customer_reviews')
      .select({
        id: 'id', restaurantId: 'restaurant_id', orderId: 'order_id',
        orderNumber: 'order_number', tableLabel: 'table_label',
        customerName: 'customer_name', rating: 'rating',
        serviceRating: this.db.raw('COALESCE(service_rating, rating)'),
        foodRating: this.db.raw('COALESCE(food_rating, rating)'),
        speedRating: this.db.raw('COALESCE(speed_rating, rating)'),
        waiterName: this.db.raw("COALESCE(waiter_name, '')"),
        channel: this.db.raw("COALESCE(channel, 'QR_ORDER')"),
        comment: 'comment', reply: 'reply', createdAt: 'created_at',
      })
      .where({ order_id: orderId })
      .first();
    if (!r) return null;
    const rating = Number(r.rating);
    return {
      id: String(r.id), restaurantId: String(r.restaurantId),
      orderId: r.orderId ? String(r.orderId) : null,
      orderNumber: String(r.orderNumber || ''), tableLabel: String(r.tableLabel || ''),
      customerName: String(r.customerName || 'Client'), rating,
      serviceRating: Number(r.serviceRating || rating),
      foodRating: Number(r.foodRating || rating),
      speedRating: Number(r.speedRating || rating),
      waiterName: String(r.waiterName || ''), channel: String(r.channel || 'QR_ORDER'),
      comment: String(r.comment || ''), reply: String(r.reply || ''),
      createdAt: String(r.createdAt),
    };
  }

  async findPublicRatingStats(restaurantId: string) {
    const row = await this.db('customer_reviews')
      .where({ restaurant_id: restaurantId })
      .select(
        this.db.raw('COUNT(*)::int as total'),
        this.db.raw('ROUND(AVG(rating)::numeric, 1) as "avgRating"'),
        this.db.raw('ROUND(AVG(COALESCE(service_rating, rating))::numeric, 1) as "avgServiceRating"'),
      )
      .first();
    return {
      total: Number(row?.total || 0),
      avgRating: Number(row?.avgRating || 0),
      avgServiceRating: Number(row?.avgServiceRating || 0),
    };
  }

  async findServiceWaiterNames(restaurantId: string): Promise<string[]> {
    const rows = await this.db('restaurant_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .select('u.full_name')
      .where('rm.restaurant_id', restaurantId)
      .where('rm.status', 'ACTIVE')
      .where('u.status', 'ACTIVE')
      .whereIn('rm.role', ['WAITER', 'CASHIER', 'MANAGER'])
      .orderBy('u.full_name', 'asc')
      .limit(20);
    return rows.map((r) => String(r.full_name || '').trim()).filter(Boolean);
  }
}

export const knexPublicRepository = new KnexPublicRepository();
