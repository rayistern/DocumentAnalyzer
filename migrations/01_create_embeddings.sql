create extension if not exists vector;

create table if not exists embeddings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table text not null,
  source_pk bigint not null,
  source_column text not null,
  group text not null default 'default',
  model text not null,
  dim smallint not null,
  embedding vector(1536) not null,
  created_at timestamp with time zone default now(),
  unique (source_table, source_pk, source_column, group, model)
);

create index on embeddings using ivfflat (embedding vector_cosine_ops)
with (lists = 100); 