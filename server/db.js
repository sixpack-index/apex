/* =========================================================================
   The database. Postgres on Railway, with a volume mounted, so the data
   survives a redeploy.

   Why this matters enough to go into the very first comment: on the previous
   project the storage was not durable, and spent payments were forgotten on
   every restart, so an old transaction became valid all over again. Here the
   epochs table plays the same role: a payout once seen has to stay seen.
   ========================================================================= */

import pg from 'pg';

/* The pool is small on purpose. Railway on a cheap plan hands out few
   connections, and a greedy pool eats them away from itself on a restart:
   the old connections are still hanging, the new ones are already asking. */
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', e => console.error('database pool:', e.message));

export const q = (text, params) => pool.query(text, params);

/**
 * The schema. Runs on every start: `if not exists` makes that safe, and a
 * separate migration step for four tables would cost more than it is worth.
 * Once there are more tables, rewrite this into numbered steps.
 */
export async function migrate() {
  /* The basket became a six, and the table `ten` stopped naming what is
     inside it. The rename goes BEFORE the tables are created: `create table
     if not exists basket` below would create an empty one, there would be
     nowhere left to move anything, and the old snapshots would stay in a
     dead table nobody remembers a month later.

     The condition is double: we rename only if the old one is there and the
     new one is not yet. Otherwise the second start of the server would fall
     over trying to rename something that does not exist, and the service
     would not come up at all. */
  await q(`
    do $$
    begin
      if exists (select from information_schema.tables
                  where table_schema = 'public' and table_name = 'ten')
         and not exists (select from information_schema.tables
                  where table_schema = 'public' and table_name = 'basket') then
        alter table ten rename to basket;
        alter index if exists ten_at rename to basket_at;
      end if;
    end $$;
  `);

  await q(`
    /* Settings: the token and vault addresses, the chosen theme. One row per
       key. This table is what the whole thing was started for: the address
       changes in the console, not with a push to the repository. */
    create table if not exists settings (
      key        text primary key,
      value      text not null,
      updated_at timestamptz not null default now()
    );

    /* Market snapshots of our own token. The history is not there for
       decoration: it shows that the turnover really was there when the epoch
       was counted. */
    create table if not exists market (
      id         bigserial primary key,
      token      text not null,
      price      double precision,
      market_cap double precision,
      liq        double precision,
      vol24      double precision,
      pools      integer,
      holders    integer,
      pair_id    text,
      at         timestamptz not null default now()
    );
    create index if not exists market_token_at on market (token, at desc);
    /* The column was added later than the table: on the live database the
       table already exists, and create table will not touch it. A separate
       alter, because otherwise the pair address would never appear for
       anyone whose database is older than this line. */
    alter table market add column if not exists pair_id text;

    /* The whole basket in a single snapshot: it is always read whole, and
       splitting it into rows would mean assembling it back on every
       request. */
    create table if not exists basket (
      id      bigserial primary key,
      at      timestamptz not null default now(),
      source  text not null,
      scanned integer,
      priced  integer,
      rows    jsonb not null
    );
    create index if not exists basket_at on basket (at desc);

    /* Vault payouts. The key is the transaction hash, so reading the same
       history again doubles nothing: the collector may overlap its windows
       as much as it likes. A race between two collectors is settled by the
       database itself. */
    create table if not exists epochs (
      hash    text primary key,
      at      timestamptz not null,
      block   bigint,
      symbol  text,
      token   text,
      amount  double precision,
      raw     jsonb
    );
    create index if not exists epochs_at on epochs (at desc);

    /* Holder snapshots: without the history there is no honest way to say
       how many addresses passed the cut off, and the eligible supply card
       promises exactly that. */
    create table if not exists holders (
      token text not null,
      at    timestamptz not null,
      count integer not null,
      primary key (token, at)
    );
  `);
}

/** All the settings as a single object. */
export async function settings() {
  const r = await q('select key, value from settings');
  const out = {};
  r.rows.forEach(row => { out[row.key] = row.value; });
  return out;
}

/**
 * Write a setting. An empty value erases the key instead of writing an empty
 * string: "the off switch is designed together with the launch", and taking
 * the token address away has to be as easy as typing it in, and leave no
 * trace.
 */
export async function setSetting(key, value) {
  if (value === '' || value === null || value === undefined) {
    await q('delete from settings where key = $1', [key]);
    return;
  }
  await q(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, String(value)]
  );
}
