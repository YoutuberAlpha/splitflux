# SPLITFLUX

A dark, silent multiplayer cell arena with bots, trick splits, feeding, accounts,
and owner controls. The owner account is `alpha`; regular accounts can upload
their own blob pictures.

# Play online at splitflux-agario.vercel.app

## How it is hosted

- **Vercel** serves the game files and passes requests on to the live server.
- **Render** (`live-runtime.cjs`) runs the arena in real time over a WebSocket and saves it to the
  database every 30 s while people play.
- **Neon** (Postgres) keeps the saved arena, accounts, bans and the login key. If Render can't be
  reached for 150 s, Vercel runs the arena from the database until Render is back ("backup mode").

## Restoring accounts from a backup

Every change to accounts, bans or the login key is copied into the `splitflux_backups` table
(the newest 50 are kept). To restore one, suspend the Render service, then in the Neon SQL editor:

```sql
SELECT id, created_at FROM splitflux_backups ORDER BY id DESC LIMIT 30;
UPDATE splitflux_arena SET payload = jsonb_set(payload, '{files}', (SELECT files FROM splitflux_backups WHERE id = 123)) WHERE id = 1;
```

Replace `123` with the backup's id, then resume Render.


See [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and `licenses/` for the
agar.io-clone and MultiOgar code credits and licenses.
