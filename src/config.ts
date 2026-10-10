// Browser API calls intentionally use the current origin. In development Vite
// proxies /api and /preview to the LocalAgent Node server on port 3002. This
// avoids the common failure where an old process on 3002 returns an HTML page
// and the frontend tries to parse it as JSON.
export const BACKEND_URL: string = '';
