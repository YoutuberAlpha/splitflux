# SPLITFLUX

A dark, silent multiplayer cell arena with bots, trick splits, feeding, accounts,
and owner controls. The owner account is `alpha`; regular accounts can upload
their own blob pictures.

## Run Locally

Use Node.js 22. Start with `npm start` and open http://localhost:1000/.
On a fresh server, first set `SPLITFLUX_OWNER_PASSWORD` in the environment.
Existing local accounts and browser preferences are preserved from TRICKSPLIT.
The legacy data-directory name and cookies remain for compatibility.

The password is used only when first creating `alpha`. Accounts contain salted
password hashes and are stored with the signing key in `SPLITFLUX_DATA_DIR`.
Never commit that directory or the environment file.

## GitHub and Vercel

1. Create a GitHub repository named `splitflux` and upload the source files.
2. In Vercel, import the repository using the included `vercel.json`.
3. Connect a free Neon Postgres database through Storage. Set the environment
   variable prefix to `DATABASE`, producing `DATABASE_URL`.
4. Privately add `SPLITFLUX_OWNER_PASSWORD` as a Secret in Production.
5. Deploy. Test `/api/health`, then two players joining through the public URL.

The API loads the shared arena under a Postgres transaction and row lock, advances
the simulation, applies the request, and commits before returning its response.
Cloud account hashes, signing keys, sessions, and bans are private database data.
Local private files are never uploaded automatically. Cloud accounts are separate
from accounts on localhost. No Render service or public backend origin is needed.

The build publishes only game assets and licenses into `public/`. Vercel compiles
`api/index.js` separately; private runtime files are not static downloads.

These files alone do not create either service.

## Standalone Backend Alternative

`render.yaml` defines one paid Node.js web service with a 1 GB persistent disk.
Review Render's current price before deploying; this configuration is not free.
Use a single instance because all players share one in-memory arena.

1. In Render, create a Blueprint from this repository and review its resources.
2. Enter `SPLITFLUX_OWNER_PASSWORD` privately when prompted. Never add it to YAML.
3. Deploy after approving the hosting cost. `/health` should return HTTP 200.
4. Open the service's HTTPS address directly; the standalone server also serves
   the game page. This is separate from the Vercel/Postgres configuration above.

Accounts, bans, and signing keys live under `/var/data/splitflux` on the disk.
The live arena resets on a backend deployment or restart. Cloud accounts start
separately from local accounts; local private files are not uploaded automatically.
The backend continues running independently of the owner's browser or PC.
Free Vercel and Neon plans have usage limits; this setup does not promise unlimited
traffic. When the public arena is empty, no background simulation is billed.

## Checks

Run `npm test`. Tests use isolated temporary account data and a test-only owner
password, rather than the real owner credentials.

## Credits

See [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and `licenses/` for the
agar.io-clone and MultiOgar code credits and licenses.
