-- Seed the minimal subscription catalog required for restaurant registration.
-- Idempotent: preserve any plan that an operator has already customized.
INSERT INTO public.plans (
  id, code, name, tagline, price_monthly_xof, price_yearly_xof,
  trial_days, max_tables, max_staff, max_menu_items,
  is_demo_pricing, is_featured, features_json, active, created_at
) VALUES
(
  'plan_essentiel', 'ESSENTIEL', 'Essentiel',
  'Pour les maquis, cafés et petits restaurants en lancement',
  25000, 250000, 14, 15, 6, 80, 1, 0,
  '["Caisse POS tactile & reçus","Gestion jusqu’à 15 tables","Menu digital QR Code par table","Suivi des commandes en temps réel","Jusqu’à 6 comptes employés","Support email en français"]',
  1, now()::text
),
(
  'plan_pro', 'PROFESSIONNEL', 'Professionnel',
  'Pour les restaurants structurés, lounges et brasseries',
  55000, 550000, 14, 60, 25, 350, 1, 1,
  '["Toutes les fonctions Essentiel","Écrans KDS Cuisine & Bar séparés","Gestion avancée des stocks & alertes","Paiements partiels, partagés & Mobile Money (PayDunya)","Fidélité clients & réservations","Rapports financiers & marges FCFA"]',
  1, now()::text
),
(
  'plan_premium', 'PREMIUM', 'Premium',
  'Pour les groupes multi-sites et établissements à fort volume',
  110000, 1100000, 14, 250, 100, 1500, 1, 0,
  '["Toutes les fonctions Professionnel","Tables, personnel & catalogue étendus","Permissions granulaires personnalisées","Exports comptables & audit sécurité complet","Accompagnement déploiement prioritaire","API & intégrations marchandes dédiées"]',
  1, now()::text
)
ON CONFLICT (code) DO NOTHING;
