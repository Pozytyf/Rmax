import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  Gift,
  Moon,
  Receipt,
  RefreshCw,
  Smartphone,
  Star,
  Sun,
  UtensilsCrossed,
  Wifi,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRestaurantTheme } from '../app/hooks/useRestaurantTheme';
import { apiFetch } from '../services/api';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useWebSocketRoom } from '../hooks/useWebSocket';
import { useToast } from '../components/Toast';
import {
  formatFcfa,
  formatTimeFr,
  getDeliveryStatusLabel,
} from '../utils/format';
import { ServiceRatingForm, type ServiceRatingPayload } from './ServiceRatingForm';
import type { CustomerReview } from '../types';

interface TrackedOrderItem {
  id: string;
  name: string;
  station?: 'KITCHEN' | 'BAR';
  quantity: number;
  options_summary: string;
  line_total_xof: number;
  notes?: string;
  prep_status: string;
}

interface TrackedOrder {
  id: string;
  orderNumber: string;
  status: string;
  discountXof?: number;
  totalXof: number;
  paidXof: number;
  customerName?: string;
  customerPhone?: string;
  promoCode?: string;
  loyaltyPointsEarned?: number;
  notes?: string;
  tableLabel: string;
  restaurantName: string;
  createdAt: string;
  updatedAt: string;
  canReview?: boolean;
  review?: CustomerReview | null;
  items: TrackedOrderItem[];
}

interface DeliveryStep {
  key: 'PENDING' | 'IN_PREPARATION' | 'READY' | 'SERVED';
  icon: typeof Clock;
}

const DELIVERY_STEPS: DeliveryStep[] = [
  { key: 'PENDING', icon: Clock },
  { key: 'IN_PREPARATION', icon: ChefHat },
  { key: 'READY', icon: BellRing },
  { key: 'SERVED', icon: CheckCircle2 },
];

function getStoredOrderIds(token: string): string[] {
  try {
    const raw = window.localStorage.getItem(`restomax_qr_orders:${token}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function QrOrderTrackingPage() {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useRestaurantTheme();
  const { token, orderId } = useParams<{ token: string; orderId?: string }>();
  const navigate = useNavigate();
  const { notify } = useToast();

  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [tableOrders, setTableOrders] = useState<TrackedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payMethod, setPayMethod] = useState<'WAVE' | 'ORANGE_MONEY' | 'MTN_MOMO' | 'CARD'>('WAVE');
  const [payerPhone, setPayerPhone] = useState('');
  const [paying, setPaying] = useState(false);
  const [lastPaymentRef, setLastPaymentRef] = useState<string | null>(null);
  const [callingType, setCallingType] = useState<'WAITER' | 'BILL' | null>(null);

  // Review state
  const [submittingReview, setSubmittingReview] = useState(false);

  const payIdempotencyRef = useRef<string>(
    `qrpay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  const prevStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!token || orderId) return;
    const storedIds = getStoredOrderIds(token);
    if (storedIds.length > 0) {
      navigate(
        `/q/${encodeURIComponent(token)}/suivi/${encodeURIComponent(storedIds[0])}`,
        { replace: true },
      );
    } else {
      setLoading(false);
    }
  }, [token, orderId, navigate]);

  useEffect(() => {
    if (!token) return;
    const storedIds = getStoredOrderIds(token);
    const idsToLoad = orderId
      ? Array.from(new Set([orderId, ...storedIds]))
      : storedIds;
    if (idsToLoad.length === 0) {
      setTableOrders([]);
      return;
    }
    let active = true;
    Promise.all(
      idsToLoad.map((id) =>
        apiFetch<{ order: TrackedOrder }>(
          `/api/public/qr/${encodeURIComponent(token)}/orders/${encodeURIComponent(id)}`,
        )
          .then((r) => r.order)
          .catch(() => null),
      ),
    ).then((list) => {
      if (!active) return;
      setTableOrders(list.filter((o): o is TrackedOrder => o !== null));
    });
    return () => {
      active = false;
    };
  }, [token, orderId, order?.status]);

  const load = useCallback(
    (manual = false) => {
      if (!token || !orderId) return;
      if (manual) setRefreshing(true);
      apiFetch<{ order: TrackedOrder }>(
        `/api/public/qr/${encodeURIComponent(token)}/orders/${encodeURIComponent(orderId)}`,
      )
        .then((res) => {
          const next = res.order;
          if (
            prevStatusRef.current &&
            prevStatusRef.current !== next.status
          ) {
            const label = getDeliveryStatusLabel(next.status);
            notify(t('customer.statusUpdateToast', { status: label }), 'info');
          }
          prevStatusRef.current = next.status;
          setOrder(next);
          if (next.customerPhone && !payerPhone) {
            setPayerPhone(next.customerPhone);
          }
          setError(null);
        })
        .catch((err) => {
          setError(
            err instanceof Error ? err.message : t('customer.orderNotFound'),
          );
        })
        .finally(() => {
          setLoading(false);
          setRefreshing(false);
        });
    },
    [token, orderId, notify, t],
  );

  useEffect(() => {
    prevStatusRef.current = null;
    if (orderId) {
      setLoading(true);
      load();
    }
  }, [orderId, load]);

  const { connected } = useWebSocketRoom(
    orderId ? `order:${orderId}` : null,
    () => load(false),
    token,
  );

  useEffect(() => {
    if (!order || order.status === 'PAID' || order.status === 'CANCELLED') {
      return;
    }
    const timer = window.setInterval(() => load(false), 8000);
    return () => window.clearInterval(timer);
  }, [order, load]);

  const elapsedMinutes = useMemo(() => {
    if (!order) return 0;
    return Math.max(
      1,
      Math.round((Date.now() - new Date(order.createdAt).getTime()) / 60000),
    );
  }, [order]);

  const handleCallService = async (callType: 'WAITER' | 'BILL') => {
    if (!token || callingType) return;
    setCallingType(callType);
    try {
      await apiFetch(`/api/public/qr/${encodeURIComponent(token)}/call`, {
        method: 'POST',
        body: JSON.stringify({ callType }),
      });
      notify(
        callType === 'BILL'
          ? 'Votre demande d’addition a été envoyée.'
          : 'Un serveur arrive à votre table.',
        'success',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Erreur appel serveur.', 'error');
    } finally {
      window.setTimeout(() => setCallingType(null), 1500);
    }
  };

  const handleSubmitReview = async (payload: ServiceRatingPayload) => {
    if (!token || !order || submittingReview) return;
    setSubmittingReview(true);
    try {
      await apiFetch(
        `/api/public/qr/${encodeURIComponent(token)}/orders/${encodeURIComponent(order.id)}/review`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            customerName: order.customerName,
          }),
        },
      );
      notify('Merci pour votre avis !', 'success');
      load(true);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Impossible d’enregistrer l’avis.', 'error');
    } finally {
      setSubmittingReview(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--rm-canvas)] flex items-center justify-center p-6 text-sm text-[var(--rm-ink-muted)]">
        {t('customer.trackingLoading')}
      </div>
    );
  }

  if (!orderId && !order) {
    return (
      <div className="min-h-screen bg-[var(--rm-canvas)] flex items-center justify-center p-6">
        <div className="bg-[var(--rm-surface)] rounded-2xl border border-[var(--rm-border)] p-7 max-w-md w-full text-center space-y-4">
          <UtensilsCrossed className="w-8 h-8 text-[#FF8738] mx-auto" />
          <h1 className="text-lg font-bold text-[var(--rm-ink)]">
            {t('customer.noActiveOrderTitle')}
          </h1>
          <p className="text-xs text-[var(--rm-ink-muted)] leading-relaxed">
            {t('customer.noActiveOrderDesc')}
          </p>
          {token && (
            <Link
              to={`/q/${encodeURIComponent(token)}`}
              className="inline-flex items-center justify-center w-full h-11 rounded-xl bg-[#FF8738] hover:bg-[#F07322] text-white text-sm font-semibold"
            >
              {t('customer.openQrMenuBtn')}
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="min-h-screen bg-[var(--rm-canvas)] flex items-center justify-center p-6">
        <div className="bg-[var(--rm-surface)] rounded-2xl border border-[var(--rm-border)] p-7 max-w-md w-full text-center space-y-3">
          <XCircle className="w-8 h-8 text-[#E05252] mx-auto" />
          <h1 className="text-base font-bold text-[var(--rm-ink)]">
            {t('customer.trackingUnavailable')}
          </h1>
          <p className="text-xs text-[var(--rm-ink-muted)]">
            {error || t('customer.orderNotFound')}
          </p>
          {token && (
            <Link
              to={`/q/${encodeURIComponent(token)}`}
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl bg-[#182333] dark:bg-[#FF8738] text-white text-xs font-semibold"
            >
              {t('customer.backToMenu')}
            </Link>
          )}
        </div>
      </div>
    );
  }

  const isPaid = order.status === 'PAID';
  const isCancelled = order.status === 'CANCELLED';
  const stepIndex = isPaid
    ? DELIVERY_STEPS.length - 1
    : Math.max(
        0,
        DELIVERY_STEPS.findIndex((s) => s.key === order.status),
      );
  const progressPercent = isCancelled
    ? 0
    : Math.round(((stepIndex + 1) / DELIVERY_STEPS.length) * 100);
  const remainingXof = Math.max(0, order.totalXof - order.paidXof);

  const handlePayOnline = async () => {
    if (!token || !order || remainingXof <= 0 || paying) return;
    setPaying(true);
    try {
      const res = await apiFetch<{
        payment: { reference: string; amountXof: number; method: string };
        pointsEarned?: number;
      }>(
        `/api/public/qr/${encodeURIComponent(token)}/orders/${encodeURIComponent(order.id)}/pay`,
        {
          method: 'POST',
          body: JSON.stringify({
            method: payMethod,
            phoneNumber: payerPhone.trim(),
            customerPhone: payerPhone.trim() || undefined,
            amountXof: remainingXof,
            idempotencyKey: payIdempotencyRef.current,
          }),
        },
      );
      setLastPaymentRef(res.payment.reference);
      payIdempotencyRef.current = `qrpay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      notify(
        res.pointsEarned && res.pointsEarned > 0
          ? `Paiement confirmé ! +${res.pointsEarned} points fidélité crédités.`
          : 'Paiement confirmé ! Merci pour votre règlement.',
        'success',
      );
      load(true);
    } catch (err) {
      notify(
        err instanceof Error ? err.message : 'Erreur lors du paiement en ligne.',
        'error',
      );
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--rm-canvas)] text-[var(--rm-ink)] pb-24 transition-colors">
      <header className="sticky top-0 z-30 bg-[#182333] dark:bg-[#0F172A] border-b border-white/10 text-white px-4 py-3 shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          {token ? (
            <Link
              to={`/q/${encodeURIComponent(token)}`}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-2 -ml-2 text-xs font-semibold text-slate-200 hover:text-white whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>{t('customer.menuShort')}</span>
            </Link>
          ) : (
            <span className="w-12" />
          )}
          <div className="min-w-0 text-center">
            <h1 className="text-sm font-extrabold truncate">
              {t('customer.deliveryTrackingTitle')}
            </h1>
            <p className="text-[11px] text-slate-300 truncate">
              {order.restaurantName} · {order.tableLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              data-testid="qr-tracking-theme-toggle"
              className="p-2 rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4 text-[#FF8738]" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </button>
            <LanguageSwitcher variant="dark" />
            <button
              type="button"
              onClick={() => load(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
              />
              <span className="hidden sm:inline">{t('common.refresh')}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 pt-5 space-y-5">
        {/* Quick service call buttons */}
        {token && !isCancelled && (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={callingType !== null}
              onClick={() => handleCallService('WAITER')}
              className="min-h-[42px] px-3 py-2 rounded-xl bg-[var(--rm-surface)] border border-[var(--rm-border)] text-xs font-bold text-[var(--rm-ink)] flex items-center justify-center gap-2 cursor-pointer"
            >
              <BellRing className="w-4 h-4 text-[#FF8738]" />
              <span>Appeler le serveur</span>
            </button>
            <button
              type="button"
              disabled={callingType !== null}
              onClick={() => handleCallService('BILL')}
              className="min-h-[42px] px-3 py-2 rounded-xl bg-[var(--rm-surface)] border border-[var(--rm-border)] text-xs font-bold text-[var(--rm-ink)] flex items-center justify-center gap-2 cursor-pointer"
            >
              <Receipt className="w-4 h-4 text-[#14B8A6]" />
              <span>Demander l’addition</span>
            </button>
          </div>
        )}

        {/* Multi-order Switcher */}
        {tableOrders.length > 1 && token && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {tableOrders.map((ord) => {
              const active = ord.id === order.id;
              return (
                <button
                  key={ord.id}
                  type="button"
                  onClick={() =>
                    navigate(
                      `/q/${encodeURIComponent(token)}/suivi/${encodeURIComponent(ord.id)}`,
                    )
                  }
                  className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-[#182333] dark:bg-[#FF8738] text-white'
                      : 'bg-[var(--rm-surface)] border border-[var(--rm-border)] text-[var(--rm-ink-muted)] hover:text-[var(--rm-ink)]'
                  }`}
                >
                  {ord.orderNumber} · {getDeliveryStatusLabel(ord.status)}
                </button>
              );
            })}
          </div>
        )}

        {/* Primary Delivery Status Hero */}
        <section className="bg-[#182333] dark:bg-[var(--rm-surface)] dark:border dark:border-[var(--rm-border)] text-white dark:text-[var(--rm-ink)] rounded-2xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs text-slate-300 font-mono">
                {t('customer.orderNumberAt', {
                  orderNumber: order.orderNumber,
                  time: formatTimeFr(order.createdAt),
                })}
              </p>
              <h2
                className={`text-xl sm:text-2xl font-extrabold ${
                  isCancelled
                    ? 'text-[#E05252]'
                    : isPaid || order.status === 'SERVED'
                      ? 'text-[#14B8A6]'
                      : 'text-[#FF8738]'
                }`}
              >
                {getDeliveryStatusLabel(order.status)}
              </h2>
            </div>

            <div className="flex items-center gap-4 text-xs text-slate-300 tabular-nums">
              <div className="flex items-center gap-1.5">
                <Wifi
                  className={`w-3.5 h-3.5 ${
                    connected ? 'text-[#14B8A6]' : 'text-slate-400'
                  }`}
                />
                <span>
                  {connected
                    ? t('customer.liveUpdates')
                    : t('customer.autoRefresh')}
                </span>
              </div>
              <span aria-hidden="true">·</span>
              <span>{elapsedMinutes} min</span>
            </div>
          </div>

          {!isCancelled && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-300 tabular-nums">
                <span>{t('customer.progressLabel')}</span>
                <span className="font-bold text-white">{progressPercent}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#14B8A6] transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left Column: Timeline & Post-Payment Review */}
          <div className="lg:col-span-7 space-y-5">
            <section className="bg-[var(--rm-surface)] rounded-2xl border border-[var(--rm-border)] p-6 space-y-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-[var(--rm-ink)]">
                  {t('customer.stepsTitle')}
                </h3>
                <span className="text-xs text-[var(--rm-ink-muted)] tabular-nums">
                  {t('customer.updatedAtTime', {
                    time: formatTimeFr(order.updatedAt || order.createdAt),
                  })}
                </span>
              </div>

              {isCancelled ? (
                <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 text-xs text-[#E05252] flex items-start gap-2.5">
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{t('customer.cancelledBanner')}</span>
                </div>
              ) : (
                <ol className="space-y-4">
                  {DELIVERY_STEPS.map((step, idx) => {
                    const Icon = step.icon;
                    const completed =
                      idx < stepIndex || isPaid || order.status === 'SERVED';
                    const current =
                      idx === stepIndex && !isPaid && order.status !== 'SERVED';
                    const reached = idx <= stepIndex;

                    return (
                      <li key={step.key} className="flex items-start gap-3.5">
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                            completed
                              ? 'bg-[#14B8A6]/15 text-[#14B8A6]'
                              : current
                                ? 'bg-[#FF8738] text-white'
                                : 'bg-[var(--rm-surface-muted)] text-[var(--rm-ink-muted)]'
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1 pt-0.5">
                          <div className="flex items-center justify-between gap-2">
                            <p
                              className={`text-sm font-bold ${
                                reached
                                  ? 'text-[var(--rm-ink)]'
                                  : 'text-[var(--rm-ink-muted)]'
                              }`}
                            >
                              {t(`customer.steps.${step.key}.title`)}
                            </p>
                            <span
                              className={`text-[11px] font-semibold whitespace-nowrap ${
                                completed
                                  ? 'text-[#14B8A6]'
                                  : current
                                    ? 'text-[#FF8738]'
                                    : 'text-[var(--rm-ink-muted)]'
                              }`}
                            >
                              {completed
                                ? t('customer.stepCompleted')
                                : current
                                  ? t('customer.stepCurrent')
                                  : t('customer.stepUpcoming')}
                            </span>
                          </div>
                          <p className="text-xs text-[var(--rm-ink-muted)] mt-0.5 leading-relaxed">
                            {t(`customer.steps.${step.key}.desc`)}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {/* Post-Payment Customer Review Card */}
            {(order.canReview || order.review) && (
              <section
                data-testid="qr-customer-review-card"
                className="bg-[var(--rm-surface)] rounded-2xl border border-[var(--rm-border)] p-6 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-[var(--rm-ink)] flex items-center gap-2">
                    <Star className="w-4 h-4 text-[#FF8738] fill-[#FF8738]" />
                    <span>Votre avis compte</span>
                  </h3>
                </div>

                {order.review ? (
                  <div className="space-y-2.5 text-xs">
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star
                          key={n}
                          className={`w-4 h-4 ${
                            n <= order.review!.rating
                              ? 'text-[#FF8738] fill-[#FF8738]'
                              : 'text-slate-300'
                          }`}
                        />
                      ))}
                      <span className="ml-2 font-bold text-[var(--rm-ink)] tabular-nums">
                        {order.review.rating}/5
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3 text-[11px] text-[var(--rm-ink-muted)] tabular-nums">
                      <span>Service : {order.review.serviceRating ?? order.review.rating}/5</span>
                      <span>Plats & Boissons : {order.review.foodRating ?? order.review.rating}/5</span>
                      <span>Rapidité : {order.review.speedRating ?? order.review.rating}/5</span>
                      {order.review.waiterName && (
                        <span>Serveur : {order.review.waiterName}</span>
                      )}
                    </div>
                    {order.review.comment && (
                      <p className="text-[var(--rm-ink-muted)] italic">
                        « {order.review.comment} »
                      </p>
                    )}
                    {order.review.reply && (
                      <div className="p-3 rounded-xl bg-[var(--rm-surface-muted)] text-[var(--rm-ink)]">
                        <span className="font-bold">Réponse de l’établissement : </span>
                        {order.review.reply}
                      </div>
                    )}
                  </div>
                ) : (
                  <ServiceRatingForm
                    submitting={submittingReview}
                    submitLabel="Publier mon avis"
                    testIdPrefix="review"
                    onSubmit={handleSubmitReview}
                  />
                )}
              </section>
            )}
          </div>

          {/* Right Column: Items Preparation & Payment Summary */}
          <section className="lg:col-span-5 bg-[var(--rm-surface)] rounded-2xl border border-[var(--rm-border)] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--rm-ink)]">
                {t('customer.orderDetailsTitle')}
              </h3>
              <span className="text-xs text-[var(--rm-ink-muted)] tabular-nums">
                {t('customer.articlesCount', {
                  count: order.items.reduce((sum, it) => sum + it.quantity, 0),
                })}
              </span>
            </div>

            <div className="divide-y divide-[var(--rm-border-subtle)] text-sm">
              {order.items.map((it) => (
                <div key={it.id} className="py-3 flex justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[var(--rm-ink)] font-medium">
                      <strong className="tabular-nums">{it.quantity}×</strong>{' '}
                      {it.name}
                    </p>
                    <p className="text-[11px] text-[var(--rm-ink-muted)] mt-0.5">
                      {it.station === 'BAR'
                        ? t('common.bar')
                        : t('common.kitchen')}{' '}
                      ·{' '}
                      <span
                        className={
                          it.prep_status === 'SERVED'
                            ? 'text-[#14B8A6] font-semibold'
                            : it.prep_status === 'READY' ||
                                it.prep_status === 'PREPARING'
                              ? 'text-[#FF8738] font-semibold'
                              : 'text-[var(--rm-ink-muted)]'
                        }
                      >
                        {getDeliveryStatusLabel(it.prep_status)}
                      </span>
                    </p>
                    {it.options_summary && (
                      <p className="text-xs text-[var(--rm-ink-muted)] mt-0.5">
                        {it.options_summary}
                      </p>
                    )}
                    {it.notes && (
                      <p className="text-[11px] text-[var(--rm-ink-muted)] italic mt-0.5">
                        {t('common.note')} : {it.notes}
                      </p>
                    )}
                  </div>
                  <span className="tabular-nums font-semibold text-[var(--rm-ink)] shrink-0">
                    {formatFcfa(it.line_total_xof)}
                  </span>
                </div>
              ))}
            </div>

            {order.notes && (
              <div className="p-3 rounded-xl bg-[var(--rm-surface-muted)] text-xs text-[var(--rm-ink-muted)]">
                {t('customer.instructionPrefix', { text: order.notes })}
              </div>
            )}

            <div className="pt-3 border-t border-[var(--rm-border)] space-y-1.5">
              {(order.discountXof || 0) > 0 && (
                <div className="flex justify-between text-xs text-[#14B8A6] font-semibold">
                  <span>
                    Remise{order.promoCode ? ` (${order.promoCode})` : ''}
                  </span>
                  <span className="tabular-nums">
                    -{formatFcfa(order.discountXof!)}
                  </span>
                </div>
              )}
              <div className="flex justify-between font-extrabold text-[var(--rm-ink)]">
                <span>{t('common.totalTtc')}</span>
                <span className="tabular-nums">
                  {formatFcfa(order.totalXof)}
                </span>
              </div>
              <div className="flex justify-between text-xs text-[var(--rm-ink-muted)]">
                <span>{t('customer.alreadyPaidLabel')}</span>
                <span className="tabular-nums font-semibold text-[#14B8A6]">
                  {formatFcfa(order.paidXof)}
                </span>
              </div>
              {remainingXof > 0 && !isCancelled && (
                <div className="flex justify-between text-xs text-[var(--rm-ink-muted)]">
                  <span>{t('customer.remainingAtTableLabel')}</span>
                  <span className="tabular-nums font-semibold text-[#FF8738]">
                    {formatFcfa(remainingXof)}
                  </span>
                </div>
              )}
            </div>

            {/* Online Payment Panel */}
            {remainingXof > 0 && !isCancelled ? (
              <div
                className="pt-4 border-t border-[var(--rm-border)] space-y-3"
                data-testid="qr-online-payment-panel"
              >
                <div className="flex items-center gap-2 text-xs font-bold text-[var(--rm-ink)]">
                  <Smartphone className="w-4 h-4 text-[#FF8738]" />
                  <span>Régler directement depuis votre téléphone</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { id: 'WAVE', label: 'Wave' },
                      { id: 'ORANGE_MONEY', label: 'Orange Money' },
                      { id: 'MTN_MOMO', label: 'MTN MoMo' },
                      { id: 'CARD', label: 'Carte bancaire' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setPayMethod(m.id)}
                      className={`px-3 py-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                        payMethod === m.id
                          ? 'border-[#FF8738] bg-[#FF8738]/12 text-[#FF8738]'
                          : 'border-[var(--rm-border)] bg-[var(--rm-surface-muted)] text-[var(--rm-ink)]'
                      }`}
                    >
                      {m.id === 'CARD' ? (
                        <CreditCard className="w-3.5 h-3.5" />
                      ) : (
                        <Smartphone className="w-3.5 h-3.5" />
                      )}
                      <span>{m.label}</span>
                    </button>
                  ))}
                </div>

                {payMethod !== 'CARD' && (
                  <input
                    type="tel"
                    placeholder="Numéro Mobile Money (ex. 0700000000)"
                    value={payerPhone}
                    onChange={(e) => setPayerPhone(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border border-[var(--rm-border-input)] bg-[var(--rm-surface)] text-xs text-[var(--rm-ink)]"
                  />
                )}

                <button
                  type="button"
                  disabled={paying}
                  onClick={handlePayOnline}
                  data-testid="qr-pay-now-btn"
                  className="w-full h-11 rounded-xl bg-[#14B8A6] hover:bg-[#0D9488] text-white text-xs font-bold cursor-pointer disabled:opacity-60 tabular-nums"
                >
                  {paying
                    ? 'Validation du paiement...'
                    : `Payer maintenant (${formatFcfa(remainingXof)})`}
                </button>
              </div>
            ) : isPaid ? (
              <div className="p-3.5 rounded-xl bg-[#14B8A6]/12 border border-[#14B8A6]/30 text-xs text-[#14B8A6] space-y-1">
                <div className="flex items-center gap-2 font-bold">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>Commande réglée en ligne</span>
                </div>
                {lastPaymentRef && (
                  <p className="text-[11px] font-mono opacity-90 pl-6">
                    Réf. {lastPaymentRef}
                  </p>
                )}
                {(order.loyaltyPointsEarned || 0) > 0 && (
                  <p className="text-[11px] font-semibold flex items-center gap-1 pl-6">
                    <Gift className="w-3.5 h-3.5" />
                    +{order.loyaltyPointsEarned} points fidélité cumulés
                  </p>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </main>

      {token && (
        <div className="fixed bottom-0 left-0 right-0 z-30 p-3 bg-[var(--rm-surface)]/95 backdrop-blur-md border-t border-[var(--rm-border)]">
          <div className="max-w-5xl mx-auto">
            <Link
              to={`/q/${encodeURIComponent(token)}`}
              className="w-full h-12 rounded-xl bg-[#182333] hover:bg-[#223044] dark:bg-[#FF8738] dark:hover:bg-[#F07322] text-white text-sm font-bold flex items-center justify-center"
            >
              {t('customer.orderMoreBtn')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
