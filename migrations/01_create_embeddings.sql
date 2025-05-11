create extension if not exists vector;

create table if not exists embeddings (
  id uuid default gen_random_uuid() primary key,
  source_table text not null,
  source_pk uuid not null,
  source_column text not null,
  model text not null,
  dim int not null,
  settings jsonb,
  embedding vector not null,
  created_at timestamptz default now(),
  unique (source_table, source_pk, source_column, model)
); 