import knex, { type Knex } from 'knex';
import knexConfig, { buildKnexConfig } from './db/knexfile.ts';
import { AppError } from './services/errors.ts';

let singletonKnex: Knex | null = null;

export function createKnexInstance(dbPath?: string): Knex {
  if (dbPath) {
    return knex(buildKnexConfig(dbPath));
  }

  const env = (process.env.NODE_ENV || 'development') as keyof typeof knexConfig;
  const config = knexConfig[env] ?? knexConfig.development;
  return knex(config);
}

export function getKnex(): Knex {
  if (!singletonKnex) {
    singletonKnex = createKnexInstance();
  }
  return singletonKnex;
}

export function setKnexInstance(instance: Knex): void {
  singletonKnex = instance;
}

export async function runKnexMigrations(instance: Knex = getKnex()) {
  return instance.migrate.latest();
}

/**
 * Vérifie l'état du schéma sans modifier la base. Les migrations sont exécutées
 * par une étape de déploiement contrôlée, jamais au démarrage de chaque instance.
 */
export async function assertKnexMigrationsCurrent(
  instance: Knex = getKnex(),
): Promise<void> {
  const [, pending] = await instance.migrate.list();
  if (pending.length > 0) {
    const names = pending
      .map((migration: unknown) =>
        typeof migration === 'string'
          ? migration
          : String((migration as { name?: unknown }).name ?? 'migration inconnue'),
      )
      .join(', ');
    throw new Error(
      `Migrations PostgreSQL manquantes : ${names}. Exécutez le job de migration avant de démarrer l'application.`,
    );
  }
}

/**
 * Helper d'isolation multi-tenant pour Knex :
 * impose un `tenantId` valide et applique systématiquement le filtre sur la colonne tenant.
 */
export function scopeByTenant<TRecord extends Record<string, unknown>, TResult>(
  qb: Knex.QueryBuilder<TRecord, TResult>,
  tenantId: string | null | undefined,
  tenantColumn = 'tenant_id',
): Knex.QueryBuilder<TRecord, TResult> {
  if (!tenantId || tenantId.trim().length === 0) {
    throw new AppError(
      403,
      'Isolation multi-tenant : identifiant tenant requis.',
    );
  }
  return qb.where(tenantColumn, tenantId);
}

/**
 * Construit un QueryBuilder Knex déjà isolé sur un tenant donné.
 */
export function forTenant(
  tableName: string,
  tenantId: string | null | undefined,
  tenantColumn = 'tenant_id',
  instance: Knex = getKnex(),
) {
  return scopeByTenant(instance(tableName), tenantId, tenantColumn);
}

/**
 * Vérifie qu'une ressource appartient bien au tenant courant avant toute opération.
 */
export function assertSameTenant(
  recordTenantId: string | null | undefined,
  activeTenantId: string | null | undefined,
): void {
  if (
    !activeTenantId ||
    !recordTenantId ||
    recordTenantId !== activeTenantId
  ) {
    throw new AppError(403, 'Accès inter-tenant interdit.');
  }
}
