import crypto from 'node:crypto';
import { getDb } from '../db.ts';

export interface PaydunyaPlatformCredentials {
  mode: 'TEST' | 'LIVE';
  masterKey: string;
  privateKey: string;
  token: string;
  configured: boolean;
}

export interface PaydunyaInvoiceInitInput {
  invoiceId: string;
  invoiceNumber: string;
  restaurantId: string;
  restaurantName: string;
  planId: string;
  planName: string;
  billingCycle: 'MONTHLY' | 'YEARLY';
  amountXof: number;
  paymentMethod: string;
  baseUrl: string;
  isRenewal: boolean;
}

export interface PaydunyaInvoiceInitResult {
  providerMode: 'PAYDUNYA_API' | 'SANDBOX_SIMULATION';
  mode: 'TEST' | 'LIVE';
  paydunyaToken: string;
  checkoutUrl: string | null;
  simulated: boolean;
}

export interface PaydunyaConfirmResult {
  completed: boolean;
  status: 'completed' | 'pending' | 'cancelled' | 'failed';
  receiptUrl?: string;
  providerMessage?: string;
}

function readPlatformPaydunyaSettings(): Record<string, string> {
  // Production credentials must come from the deployment secret store.
  // Do not read a local/ephemeral SQLite settings table in serverless runtime.
  if (process.env.NODE_ENV === 'production') return {};
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT key, value FROM platform_settings WHERE key LIKE 'paydunya_%'",
    )
    .all() as Array<{ key: string; value: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

export function resolvePaydunyaPlatformCredentials(): PaydunyaPlatformCredentials {
  const dbSettings = readPlatformPaydunyaSettings();
  const rawMode = (
    process.env.PAYDUNYA_MODE ||
    dbSettings.paydunya_mode ||
    process.env.PAYMENT_MODE ||
    'TEST'
  )
    .trim()
    .toUpperCase();
  const mode: 'TEST' | 'LIVE' = rawMode === 'LIVE' ? 'LIVE' : 'TEST';

  const masterKey = (
    process.env.PAYDUNYA_MASTER_KEY ||
    dbSettings.paydunya_master_key ||
    ''
  ).trim();
  const privateKey = (
    process.env.PAYDUNYA_PRIVATE_KEY ||
    dbSettings.paydunya_private_key ||
    ''
  ).trim();
  const token = (
    process.env.PAYDUNYA_TOKEN ||
    dbSettings.paydunya_token ||
    ''
  ).trim();

  const configured = Boolean(masterKey && privateKey && token);
  return { mode, masterKey, privateKey, token, configured };
}

function getPaydunyaApiBase(mode: 'TEST' | 'LIVE'): string {
  // Strict allowlisted PayDunya endpoints only (prevents SSRF)
  return mode === 'LIVE'
    ? 'https://app.paydunya.com/api/v1'
    : 'https://app.paydunya.com/sandbox-api/v1';
}

function buildHeaders(creds: PaydunyaPlatformCredentials): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'PAYDUNYA-MASTER-KEY': creds.masterKey,
    'PAYDUNYA-PRIVATE-KEY': creds.privateKey,
    'PAYDUNYA-TOKEN': creds.token,
  };
}

export async function createPaydunyaSubscriptionCheckout(
  input: PaydunyaInvoiceInitInput,
): Promise<PaydunyaInvoiceInitResult> {
  const creds = resolvePaydunyaPlatformCredentials();
  if (process.env.NODE_ENV === 'production' && creds.mode !== 'LIVE') {
    throw new Error('PAYDUNYA_MODE=LIVE est obligatoire pour encaisser un abonnement en production.');
  }

  if (!creds.configured) {
    if (process.env.NODE_ENV === 'production' || process.env.PAYMENT_MODE === 'LIVE') {
      throw new Error('Configuration PayDunya absente : les paiements réels sont désactivés tant que les clés de production ne sont pas configurées.');
    }
    const simToken = `pdx_sim_${crypto.randomBytes(10).toString('hex')}`;
    return {
      providerMode: 'SANDBOX_SIMULATION',
      mode: 'TEST',
      paydunyaToken: simToken,
      checkoutUrl: null,
      simulated: true,
    };
  }

  const cleanBase = input.baseUrl.replace(/\/+$/, '');
  const endpoint = `${getPaydunyaApiBase(creds.mode)}/checkout-invoice/create`;

  const payload = {
    invoice: {
      total_amount: Math.round(input.amountXof),
      description: `${input.isRenewal ? 'Renouvellement' : 'Abonnement'} Resto'MAX ${input.planName} (${input.billingCycle === 'YEARLY' ? 'Annuel' : 'Mensuel'}) — ${input.restaurantName}`,
    },
    store: {
      name: "Resto'MAX SaaS",
      tagline: 'Plateforme de gestion restaurant',
      website_url: cleanBase,
    },
    custom_data: {
      invoice_id: input.invoiceId,
      invoice_number: input.invoiceNumber,
      restaurant_id: input.restaurantId,
      plan_id: input.planId,
      billing_cycle: input.billingCycle,
      payment_method: input.paymentMethod,
      is_renewal: input.isRenewal ? '1' : '0',
    },
    actions: {
      callback_url: `${cleanBase}/api/public/webhooks/paydunya`,
      return_url: `${cleanBase}/app/subscription?paydunya_status=return&invoice=${encodeURIComponent(input.invoiceId)}`,
      cancel_url: `${cleanBase}/app/subscription?paydunya_status=cancel&invoice=${encodeURIComponent(input.invoiceId)}`,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = (await resp.json().catch(() => ({}))) as {
      response_code?: string;
      response_text?: string;
      token?: string;
      description?: string;
    };
    const responseText = String(data.response_text || '');
    const checkoutUrl =
      responseText.startsWith('https://') ? responseText : null;

    if (!resp.ok || data.response_code !== '00' || !data.token || !checkoutUrl) {
      throw new Error(
        data.description ||
          data.response_text ||
          'PayDunya a refusé la création de la facture de paiement.',
      );
    }

    return {
      providerMode: 'PAYDUNYA_API',
      mode: creds.mode,
      paydunyaToken: String(data.token),
      checkoutUrl,
      simulated: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface PaydunyaOrderCheckoutInput {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  restaurantId: string;
  restaurantName: string;
  amountXof: number;
  paymentMethod: string;
  baseUrl: string;
  returnUrl: string;
  cancelUrl: string;
}

export async function createPaydunyaOrderCheckout(
  input: PaydunyaOrderCheckoutInput,
): Promise<PaydunyaInvoiceInitResult> {
  const creds = resolvePaydunyaPlatformCredentials();
  if (process.env.NODE_ENV === 'production' && creds.mode !== 'LIVE') {
    return {
      completed: false,
      status: 'failed',
      providerMessage: 'Le mode PayDunya LIVE est obligatoire en production.',
    };
  }
  if (!creds.configured) {
    if (process.env.NODE_ENV === 'production' || process.env.PAYMENT_MODE === 'LIVE') {
      throw new Error('Configuration PayDunya absente : les paiements réels sont désactivés.');
    }
    return {
      providerMode: 'SANDBOX_SIMULATION',
      mode: 'TEST',
      paydunyaToken: `pdx_sim_${crypto.randomBytes(10).toString('hex')}`,
      checkoutUrl: null,
      simulated: true,
    };
  }
  if (process.env.NODE_ENV === 'production' && creds.mode !== 'LIVE') {
    throw new Error('PAYDUNYA_MODE=LIVE est obligatoire pour accepter un paiement en production.');
  }
  const base = new URL(input.baseUrl);
  if (base.protocol !== 'https:') {
    throw new Error('APP_URL doit être une URL HTTPS pour le paiement PayDunya.');
  }
  const cleanBase = base.toString().replace(/\\/+$/, '');
  const endpoint = `${getPaydunyaApiBase(creds.mode)}/checkout-invoice/create`;
  const payload = {
    invoice: {
      total_amount: Math.round(input.amountXof),
      description: `Commande ${input.orderNumber} · ${input.restaurantName} · Resto'MAX`,
    },
    store: {
      name: input.restaurantName,
      tagline: 'Commande en ligne',
      website_url: cleanBase,
    },
    custom_data: {
      payment_type: 'ORDER',
      payment_id: input.paymentId,
      order_id: input.orderId,
      order_number: input.orderNumber,
      restaurant_id: input.restaurantId,
      payment_method: input.paymentMethod,
      amount_xof: String(Math.round(input.amountXof)),
      currency: 'XOF',
    },
    actions: {
      callback_url: `${cleanBase}/api/public/webhooks/paydunya`,
      return_url: input.returnUrl,
      cancel_url: input.cancelUrl,
    },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => ({}))) as {
      response_code?: string; response_text?: string; token?: string; description?: string;
    };
    const checkoutUrl = String(data.response_text || '');
    if (
      !response.ok || data.response_code !== '00' ||
      !data.token || !checkoutUrl.startsWith('https://')
    ) {
      throw new Error(data.description || data.response_text || 'PayDunya a refusé la création du paiement.');
    }
    return {
      providerMode: 'PAYDUNYA_API',
      mode: creds.mode,
      paydunyaToken: String(data.token),
      checkoutUrl,
      simulated: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function confirmPaydunyaInvoice(
  paydunyaToken: string,
): Promise<PaydunyaConfirmResult> {
  const cleanToken = paydunyaToken.trim();
  if (!cleanToken || !/^[a-zA-Z0-9_-]{6,128}$/.test(cleanToken)) {
    return {
      completed: false,
      status: 'failed',
      providerMessage: 'Jeton PayDunya invalide.',
    };
  }

  if (cleanToken.startsWith('pdx_sim_')) {
    if (process.env.NODE_ENV === 'production' || process.env.PAYMENT_MODE === 'LIVE') {
      return {
        completed: false,
        status: 'failed',
        providerMessage: 'Un jeton de simulation ne peut jamais confirmer un paiement en production.',
      };
    }
    return { completed: true, status: 'completed' };
  }

  const creds = resolvePaydunyaPlatformCredentials();
  if (!creds.configured) {
    return {
      completed: false,
      status: 'pending',
      providerMessage: 'Clés API PayDunya non configurées sur la plateforme.',
    };
  }

  const endpoint = `${getPaydunyaApiBase(creds.mode)}/checkout-invoice/confirm/${encodeURIComponent(cleanToken)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: buildHeaders(creds),
      signal: controller.signal,
    });
    const data = (await resp.json().catch(() => ({}))) as {
      response_code?: string;
      status?: string;
      receipt_url?: string;
      response_text?: string;
    };
    const st = String(data.status || '').toLowerCase();
    if (resp.ok && data.response_code === '00' && st === 'completed') {
      return {
        completed: true,
        status: 'completed',
        receiptUrl:
          typeof data.receipt_url === 'string' ? data.receipt_url : undefined,
      };
    }
    if (st === 'cancelled' || st === 'canceled') {
      return {
        completed: false,
        status: 'cancelled',
        providerMessage: data.response_text || 'Paiement annulé.',
      };
    }
    return {
      completed: false,
      status: 'pending',
      providerMessage: data.response_text || 'Paiement en attente de confirmation.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Vérifie la signature PayDunya IPN (`data.hash === sha512(PAYDUNYA_MASTER_KEY)`)
 * ou le secret webhook HMAC (`PAYDUNYA_WEBHOOK_SECRET`) en temps constant.
 * Rejette par défaut (fail-closed) si aucun secret n'est configuré.
 */
export function verifyPaydunyaIpnSignature(
  payload: Record<string, unknown>,
  rawHeaderSig?: string,
): boolean {
  const creds = resolvePaydunyaPlatformCredentials();
  if (process.env.NODE_ENV === 'production' && creds.mode !== 'LIVE') return false;
  const dataObj =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : payload;

  const receivedHash = String(
    dataObj.hash || payload.hash || rawHeaderSig || '',
  )
    .trim()
    .toLowerCase();

  if (!receivedHash || !/^[a-f0-9]{64,128}$/.test(receivedHash)) {
    return false;
  }

  if (creds.masterKey) {
    const expectedSha512 = crypto
      .createHash('sha512')
      .update(creds.masterKey)
      .digest('hex')
      .toLowerCase();
    const a = Buffer.from(receivedHash, 'utf8');
    const b = Buffer.from(expectedSha512, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  const webhookSecret = (process.env.PAYDUNYA_WEBHOOK_SECRET || '').trim();
  if (webhookSecret) {
    const expectedHmac = crypto
      .createHmac('sha512', webhookSecret)
      .update(JSON.stringify(dataObj))
      .digest('hex')
      .toLowerCase();
    const a = Buffer.from(receivedHash, 'utf8');
    const b = Buffer.from(expectedHmac, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  return false;
}
