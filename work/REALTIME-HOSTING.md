# Free Real-Time Hosting

The Vercel website stays at splitflux-agario.vercel.app. A single Render Free Node service runs `node live-runtime.cjs`, with `npm install --omit=dev` as its build command. Do not add a paid disk or paid instance.

Set DATABASE_URL privately in Render to the existing Neon database connection string. Never commit credentials or upload local private files. The runtime loads existing cloud accounts and the arena, runs gameplay in memory, and checkpoints every five seconds. New accounts and bans are saved before successful responses. An instance generation check prevents an old instance from overwriting a newer instance's state.

Publish and verify the updated Vercel API before starting Render. The API recognizes a live-server marker in Neon and forwards requests to it. Set SPLITFLUX_BACKEND_ORIGIN privately in Vercel to the confirmed HTTPS Render origin to bypass even the marker lookup. Do not switch until the backend passes health and two-client tests.

Browsers obtain a short-lived, single-use connection ticket through the Vercel API, then exchange gameplay updates directly over WebSocket. Login cookies stay HTTP-only; login/logout invalidates existing device sockets. HTTP remains available when sockets are unavailable.

Render Free sleeps when unused and has usage limits. Initial connections retry while the service wakes. Localhost continues to use its own account files and local socket server, not the public database.
