# Nairly API

Standalone REST API backend for the [Nairly](https://nairly.mn) event-planning marketplace. Built with [Hono](https://hono.dev) + TypeScript, backed by Supabase (PostgreSQL).

## Ecosystem

```
event-planning/        → Next.js customer/provider frontend
event-planning-admin/  → Admin dashboard (separate project)
event-planning-api/    → This project — single API consumed by both frontends
```

## Stack

| Layer | Tech |
|---|---|
| Framework | [Hono](https://hono.dev) |
| Runtime | Node.js 20+ |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase JWT (Bearer token) |
| Validation | Zod + @hono/zod-validator |
| Dev | tsx watch |

## Getting started

```bash
cp .env.example .env

npm install
npm run dev        # http://localhost:4000
```

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (never expose to clients) |
| `PORT` | Port to listen on (default: 4000) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |

## API routes

### Public

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/venues` | List venues (filters: category, district, capacity, search, featured, page, limit) |
| GET | `/venues/:slug` | Single venue by slug |
| GET | `/venues/:id/availability?month=2026-05` | Weekly time slots for a venue (month bounds for `startDate`/`endDate`) |
| GET | `/time-slots/:venueId` | Weekly pricing config for a venue |

### Authenticated (Bearer token required)

| Method | Path | Description |
|---|---|---|
| POST | `/orders/make-order` | Create checkout order |
| GET | `/orders` | Current user’s orders (paginated) |
| GET | `/orders/:id` | Single order (owner or admin) |
| POST | `/venues` | Create a venue (provider+) |
| PATCH | `/venues/:id` | Update own venue (admin can update any) |
| PUT | `/time-slots/:venueId/:day` | Upsert day-of-week pricing (provider+) |
| DELETE | `/time-slots/:venueId/:day` | Remove day pricing override (provider+) |

### Admin only

| Method | Path | Description |
|---|---|---|
| GET | `/admin/orders` | All orders with filters (status, `created_at` range, pagination) |
| GET | `/admin/orders/stats` | Order counts + confirmed revenue (`total`) |
| PATCH | `/admin/orders/:id` | Update order status |
| GET | `/admin/providers` | All providers with venue counts |
| GET | `/admin/providers/:id` | Provider detail with venues + recent orders for those venues |
| PATCH | `/admin/providers/:id/verify` | Approve or revoke provider |
| PATCH | `/admin/providers/:id/role` | Change user role |

## Auth

Roles are stored in `app_metadata.role` in Supabase Auth:

- `customer` — browse and book
- `provider` — manage own venues/pricing (requires admin verification)  
- `admin` — full access

Every protected route expects:

```
Authorization: Bearer <supabase-access-token>
```

The token is obtained from Supabase Auth in the frontend (`supabase.auth.getSession()`).

## Frontend integration

In your Next.js `.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Usage:

```typescript
const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/venues?category=restaurant`)
const { data, meta } = await res.json()
```

Authenticated:

```typescript
const { data: { session } } = await supabase.auth.getSession()

const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/orders/make-order`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${session?.access_token}`,
  },
  body: JSON.stringify(payload),
})
```

## Project structure

```
src/
  index.ts                  ← Hono app, CORS, global error handler
  types/index.ts            ← AuthUser type, Hono context extension
  lib/
    supabase.ts             ← service-role + per-user scoped clients
  middleware/
    auth.ts                 ← authenticate · requireAdmin · requireProvider
  routes/
    venues.ts
    orders.ts
    categories.ts
    time-slots.ts
    admin/
      orders.ts
      providers.ts
```
