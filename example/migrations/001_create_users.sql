create table users (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);

create index users_created_at_idx on users (created_at desc);
