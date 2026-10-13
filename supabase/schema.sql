-- Einmalig im Supabase-Dashboard unter "SQL Editor" ausführen.

-- Alle Dateien der App (spieler.csv, spiele.csv, presets.csv, users.json, zahlungen.json)
create table if not exists public.kv (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- RLS an und KEINE Policies: der öffentliche (anon) Key kommt nicht an die Daten.
-- Nur der Server mit dem Service-/Secret-Key darf lesen und schreiben.
alter table public.kv enable row level security;

-- Privater Bucket für Spielerfotos (der Server liefert sie nach Login aus)
insert into storage.buckets (id, name, public)
values ('fotos', 'fotos', false)
on conflict (id) do nothing;
