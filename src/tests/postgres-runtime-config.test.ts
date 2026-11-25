import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnexConfig, buildPostgresKnexConfig } from '../server/db/knexfile.ts';

test('PostgreSQL configuration fails closed when the connection URL is missing', () => {
  const previous = {
    client: process.env.DATABASE_CLIENT,
    databaseUrl: process.env.DATABASE_URL,
    supabaseDbUrl: process.env.SUPABASE_DB_URL,
    nodeEnv: process.env.NODE_ENV,
    vercel: process.env.VERCEL,
  };

  try {
    process.env.DATABASE_CLIENT = 'pg';
    delete process.env.DATABASE_URL;
    delete process.env.SUPABASE_DB_URL;
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';

    assert.throws(
      () => buildKnexConfig('/tmp/restomax-test.db'),
      /DATABASE_CLIENT=pg exige/,
    );
  } finally {
    if (previous.client === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previous.client;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.supabaseDbUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = previous.supabaseDbUrl;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
  }
});

test('PostgreSQL configuration selects the pg driver when configured', () => {
  const previous = {
    client: process.env.DATABASE_CLIENT,
    databaseUrl: process.env.DATABASE_URL,
    supabaseDbUrl: process.env.SUPABASE_DB_URL,
  };

  try {
    process.env.DATABASE_CLIENT = 'pg';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/restomax';
    delete process.env.SUPABASE_DB_URL;

    const config = buildKnexConfig('/tmp/unused-restomax.db');
    assert.equal(config.client, 'pg');
    assert.equal(buildPostgresKnexConfig('postgresql://u:p@localhost/db').client, 'pg');
  } finally {
    if (previous.client === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previous.client;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.supabaseDbUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = previous.supabaseDbUrl;
  }
});

test('Vercel production refuses SQLite configuration', () => {
  const previous = {
    client: process.env.DATABASE_CLIENT,
    nodeEnv: process.env.NODE_ENV,
    vercel: process.env.VERCEL,
  };

  try {
    process.env.DATABASE_CLIENT = 'sqlite';
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';
    assert.throws(
      () => buildKnexConfig('/tmp/restomax-test.db'),
      /SQLite ne peut pas être utilisé/,
    );
  } finally {
    if (previous.client === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previous.client;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
  }
});
