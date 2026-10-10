# API routing fix

The browser now calls `/api/*` and `/preview/*` on its own origin. Vite proxies those requests to the Node backend on `127.0.0.1:3002`.

This prevents `Unexpected token '<'` caused by receiving an HTML Vite page where JSON was expected.

Startup:
1. Run `restart-localagent.bat`.
2. Confirm `check-backend.bat` prints `LocalAgent backend is reachable.`
3. Open `http://localhost:5173`.
