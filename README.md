# billing-service

Microservicio de facturación de demostración (AIS86, Semana 11) con Supabase Edge Functions y PostgreSQL.

- `sql/invoices.sql`: tabla `public.invoices` con RLS y permisos mínimos.
- `supabase/functions/billing/index.ts`: Edge Function (`/health`, `POST /invoices`, `GET /invoices/{id}`).
- `crear_secretos.py`: genera tokens locales (no se suben a Git).
- `probar_billing.py`: comprobador HTTP del contrato.

Es facturación de demostración: no cobra dinero ni emite comprobantes SUNAT.
