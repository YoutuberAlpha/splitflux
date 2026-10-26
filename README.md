# SPLITFLUX

A dark, silent multiplayer cell arena with bots, trick splits, feeding, accounts,
and owner controls. The owner account is `alpha`; regular accounts can upload
their own blob pictures.

## Run Locally

Use Node.js 18 or newer. Start with `npm start` and open http://localhost:1000/.
On a fresh server, first set `SPLITFLUX_OWNER_PASSWORD` in the environment.
Existing local accounts and browser preferences are preserved from TRICKSPLIT.
The legacy data-directory name and cookies remain for compatibility.

The password is used only when first creating `alpha`. Accounts contain salted
password hashes and are stored with the signing key in `SPLITFLUX_DATA_DIR`.
Never commit that directory or the environment file.

## GitHub and Vercel

1. Create a GitHub repository named `splitflux` and upload the source files.
2. Host `server.cjs` as a single continuously running Node.js process with a
   persistent disk for `SPLITFLUX_DATA_DIR`. Set `SPLITFLUX_OWNER_PASSWORD`
   privately in that backend's environment settings.
3. In Vercel, import the GitHub repository. Use the included `vercel.json`.
4. Set `SPLITFLUX_BACKEND_ORIGIN` in Vercel to the backend's public HTTPS origin.
5. Deploy. `/api/*` is proxied to that backend on the same public site, while
   Vercel serves the frontend. GitHub pushes can then trigger Vercel deployments.

The build deliberately fails without a backend origin. The current game server
uses an in-memory shared arena and local account files, so simply wrapping it
in a standard Vercel Function would not provide a reliable multiplayer world.
The Vercel frontend build publishes only the game assets and license notices;
it does not publish account files, server source, logs, or desktop executables.

These files alone do not create either service.

## Always-On Backend

`render.yaml` defines one paid Node.js web service with a 1 GB persistent disk.
Review Render's current price before deploying; this configuration is not free.
Use a single instance because all players share one in-memory arena.

1. In Render, create a Blueprint from this repository and review its resources.
2. Enter `SPLITFLUX_OWNER_PASSWORD` privately when prompted. Never add it to YAML.
3. Deploy after approving the hosting cost. `/health` should return HTTP 200.
4. Put the service's HTTPS origin in Vercel's `SPLITFLUX_BACKEND_ORIGIN`, then
   redeploy Vercel. Test two players joining through the Vercel address.

Accounts, bans, and signing keys live under `/var/data/splitflux` on the disk.
The live arena resets on a backend deployment or restart. Cloud accounts start
separately from local accounts; local private files are not uploaded automatically.
The backend continues running independently of the owner's browser or PC.

## Checks

Run `npm test`. Tests use isolated temporary account data and a test-only owner
password, rather than the real owner credentials.

## Credits

See [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and `licenses/` for the
agar.io-clone and MultiOgar code credits and licenses.
