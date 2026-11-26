import type { Knex } from 'knex';

const plans = [
  {
    id: 'plan_essentiel',
    code: 'ESSENTIEL',
    name: 'Essentiel',
    tagline: 'Pour les maquis, cafés et petits restaurants en lancement',
    price_monthly_xof: 25000,
    price_yearly_xof: 250000,
    trial_days: 14,
    max_tables: 15,
    max_staff: 6,
    max_menu_items: 80,
    is_demo_pricing: 1,
    is_featured: 0,
    features_json: JSON.stringify([
      'Caisse POS tactile & reçus',
      'Gestion jusqu’à 15 tables',
      'Menu digital QR Code par table',
      'Suivi des commandes en temps réel',
      'Jusqu’à 6 comptes employés',
      'Support email en français',
    ]),
    active: 1,
  },
  {
    id: 'plan_pro',
    code: 'PROFESSIONNEL',
    name: 'Professionnel',
    tagline: 'Pour les restaurants structurés, lounges et brasseries',
    price_monthly_xof: 55000,
    price_yearly_xof: 550000,
    trial_days: 14,
    max_tables: 60,
    max_staff: 25,
    max_menu_items: 350,
    is_demo_pricing: 1,
    is_featured: 1,
    features_json: JSON.stringify([
      'Toutes les fonctions Essentiel',
      'Écrans KDS Cuisine & Bar séparés',
      'Gestion avancée des stocks & alertes',
      'Paiements partiels, partagés & Mobile Money (PayDunya)',
      'Fidélité clients & réservations',
      'Rapports financiers & marges FCFA',
    ]),
    active: 1,
  },
  {
    id: 'plan_premium',
    code: 'PREMIUM',
    name: 'Premium',
    tagline: 'Pour les groupes multi-sites et établissements à fort volume',
    price_monthly_xof: 110000,
    price_yearly_xof: 1100000,
    trial_days: 14,
    max_tables: 250,
    max_staff: 100,
    max_menu_items: 1500,
    is_demo_pricing: 1,
    is_featured: 0,
    features_json: JSON.stringify([
      'Toutes les fonctions Professionnel',
      'Tables, personnel & catalogue étendus',
      'Permissions granulaires personnalisées',
      'Exports comptables & audit sécurité complet',
      'Accompagnement déploiement prioritaire',
      'API & intégrations marchandes dédiées',
    ]),
    active: 1,
  },
] as const;

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('plans'))) {
    throw new Error('La table plans doit exister avant le seed des plans SaaS.');
  }

  const now = new Date().toISOString();
  for (const plan of plans) {
    await knex('plans')
      .insert({ ...plan, created_at: now })
      .onConflict('code')
      .ignore();
  }
}

export async function down(knex: Knex): Promise<void> {
  // Preserve plans already referenced by subscriptions; remove only unused
  // rows created by this seed migration.
  await knex('plans')
    .whereIn('id', plans.map((plan) => plan.id))
    .whereNotIn('id', knex('subscriptions').select('plan_id'))
    .del();
}
