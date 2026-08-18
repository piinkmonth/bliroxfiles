import { NextResponse } from 'next/server'
import { buildOpenApi } from '@/lib/apispec'
import { apiOptions } from '@/lib/apiauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /v1/openapi.json — the machine-readable spec.
 *
 * Public and unauthenticated: it describes how to authenticate, so it cannot
 * require authentication. The document is generated from lib/apispec.ts, the
 * same source the human docs render from, so the two never drift. CORS is open
 * for the same reason as the rest of v1 — no cookies ride these responses.
 */
export function GET() {
  return NextResponse.json(buildOpenApi(), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  })
}

export const OPTIONS = apiOptions
