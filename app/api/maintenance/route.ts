import { requireRole, sweepExpired } from '@/lib/auth'
import { sweepStaging } from '@/lib/storage'
import { purgeExpiredQuarantine } from '@/lib/moderation'
import { sweepRateLimits } from '@/lib/ratelimit'
import { sweepOAuthStates } from '@/lib/oauth'
import { sweepChallenges } from '@/lib/twofactor'
import { audit } from '@/lib/audit'
import { ok, route } from '@/lib/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

/**
 * Housekeeping. Safe to run repeatedly; nothing here touches live data.
 *
 * Wire it to a systemd timer rather than an in-process interval — a timer
 * survives the app crashing, which is exactly when staging is most likely to
 * be full of half-finished uploads.
 */
export const POST = route(async () => {
  const admin = await requireRole('admin')

  const staging = await sweepStaging()
  sweepExpired()
  const purged = await purgeExpiredQuarantine()
  const limits = sweepRateLimits()
  const oauth = sweepOAuthStates()
  const challenges = sweepChallenges()

  audit({
    actorId: admin.id,
    actorName: admin.username,
    action: 'maintenance.run',
    detail: { stagingRemoved: staging, quarantinePurged: purged, rateLimitsSwept: limits, oauthStatesSwept: oauth, challengesSwept: challenges },
  })

  return ok({ stagingRemoved: staging, quarantinePurged: purged, rateLimitsSwept: limits, oauthStatesSwept: oauth, challengesSwept: challenges })
})
