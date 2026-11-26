CREATE INDEX IF NOT EXISTS idx_cash_register_opened_by ON public.cash_register_sessions(opened_by_user_id);
CREATE INDEX IF NOT EXISTS idx_cash_register_closed_by ON public.cash_register_sessions(closed_by_user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_customer_fk ON public.loyalty_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_order_fk ON public.loyalty_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_table_calls_table_fk ON public.table_calls(table_id);
