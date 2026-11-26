import type { Knex } from 'knex';
import { getKnex } from '../knex.ts';

export class KnexSuperadminSettingsRepository {
  constructor(private readonly db: Knex = getKnex()) {}

  async findPlatformSettings(): Promise<Array<{ key: string; value: string }>> {
    const rows = await this.db('platform_settings').select('key', 'value').orderBy('key', 'asc');
    return rows.map((row) => ({ key: String(row.key), value: String(row.value) }));
  }

  async upsertPlatformSettings(entries: Array<[string, string]>, executor: Knex | Knex.Transaction = this.db): Promise<void> {
    if (!entries.length) return;
    const now = new Date().toISOString();
    await executor('platform_settings')
      .insert(entries.map(([key, value]) => ({ key, value, updated_at: now })))
      .onConflict('key')
      .merge(['value', 'updated_at']);
  }
}

export const knexSuperadminSettingsRepository = new KnexSuperadminSettingsRepository();
