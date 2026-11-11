select relrowsecurity as rls_activo,
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'invoices') as numero_politicas
from pg_class
where oid = 'public.invoices'::regclass;

select rol,
  has_table_privilege(rol, 'public.invoices', 'SELECT') as puede_leer,
  has_table_privilege(rol, 'public.invoices', 'INSERT') as puede_insertar,
  has_table_privilege(rol, 'public.invoices', 'UPDATE') as puede_actualizar,
  has_table_privilege(rol, 'public.invoices', 'DELETE') as puede_borrar
from (values ('anon'), ('authenticated'), ('service_role')) as roles(rol);
