import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createAuth } from './auth';
import { requireScope } from './lib/scope';
import { bootstrap } from './routes/bootstrap';
import { transactionRoutes } from './routes/transactions';
import { cycleRoutes } from './routes/cycles';
import { queueRoutes } from './routes/queue';
import { householdRoutes, memberRoutes, cardRoutes, reminderRoutes } from './routes/household';
import { exportRoutes } from './routes/export';
import { aiRoutes } from './routes/ai';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GEMINI_API_KEY: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OWNER_EMAIL: string;
}

const app = new Hono<{ Bindings: Env }>();

// Security headers apply to every response the app serves, not just /api/*.
// Registered as the very first `app.use('*', ...)` so it wraps the entire
// chain below it, including the static-asset fallback route at the bottom —
// same reasoning as the no-store middleware's comment: a middleware only
// wraps handlers registered after it, in source order.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
});

// Authenticated API responses must never be cached. Registered before the
// routes below: Hono composes matched handlers in registration order, and a
// route handler that doesn't call next() ends the chain — this middleware
// must wrap the routes, not follow them, or it never runs at all.
app.use('/api/*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/api/auth/')) {
    c.header('Cache-Control', 'no-store');
  }
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.on(['GET', 'POST'], '/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));

// Every non-auth API route requires a resolved Scope. requireScope throws
// HTTPException 401/403 before any handler runs — no route below this reaches
// data without going through the ScopedRepository it returns.
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/health') return next();
  await requireScope(c);
  return next();
});

app.route('/api/bootstrap', bootstrap);
app.route('/api/transactions', transactionRoutes);
app.route('/api/cycles', cycleRoutes);
app.route('/api/queue', queueRoutes);
app.route('/api/household', householdRoutes);
app.route('/api/members', memberRoutes);
app.route('/api/cards', cardRoutes);
app.route('/api/reminders', reminderRoutes);
app.route('/api/export', exportRoutes);
app.route('/api/ai', aiRoutes);

// wrangler.jsonc now routes every request through the Worker first (not
// just /api/*), so the security headers above apply everywhere. Non-API
// requests that fall through here are handed to the assets binding, which
// also implements the SPA fallback (not_found_handling). Unmatched /api/*
// paths must NOT fall into this asset fallback, or a bad API path would
// wrongly get back the SPA's index.html instead of a 404.
app.get('*', (c) => {
  if (c.req.path.startsWith('/api/')) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});

export default app;
