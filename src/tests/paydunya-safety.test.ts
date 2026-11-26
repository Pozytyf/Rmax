import test from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmPaydunyaInvoice,
  createPaydunyaSubscriptionCheckout,
} from '../server/services/paydunyaService.ts';

function restoreEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('a simulated PayDunya token can never confirm a production payment', async () => {
  const keys = ['NODE_ENV', 'PAYMENT_MODE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'TEST';
    const result = await confirmPaydunyaInvoice('pdx_sim_0123456789abcdef');
    assert.equal(result.completed, false);
    assert.equal(result.status, 'failed');
  } finally {
    restoreEnv(previous);
  }
});

test('PayDunya checkout refuses to simulate when production credentials are absent', async () => {
  const keys = [
    'NODE_ENV', 'PAYMENT_MODE', 'PAYDUNYA_MODE',
    'PAYDUNYA_MASTER_KEY', 'PAYDUNYA_PRIVATE_KEY', 'PAYDUNYA_TOKEN',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_MODE = 'TEST';
    delete process.env.PAYDUNYA_MODE;
    delete process.env.PAYDUNYA_MASTER_KEY;
    delete process.env.PAYDUNYA_PRIVATE_KEY;
    delete process.env.PAYDUNYA_TOKEN;
    await assert.rejects(
      () => createPaydunyaSubscriptionCheckout({
        invoiceId: 'test-invoice', invoiceNumber: 'TEST-1',
        restaurantId: 'test-restaurant', restaurantName: 'Test',
        planId: 'plan_essentiel', planName: 'Essentiel',
        billingCycle: 'MONTHLY', amountXof: 25000,
        paymentMethod: 'WAVE', baseUrl: 'https://example.invalid',
        isRenewal: false,
      }),
      /Configuration PayDunya absente/,
    );
  } finally {
    restoreEnv(previous);
  }
});
