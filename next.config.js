/** @type {import('next').NextConfig} */

// content security policy.
//
// script-src needs 'unsafe-inline' bc next's app router inlines its bootstrap +
// flight-data scripts, and the theme script in <head> has to run before first
// paint or u get a flash. nonces are stricter but next 14 only does those via
// middleware, which would sit in front of the download path and add latency to
// every byte served. not worth it.
//
// the directives that actually pull weight, and hold no matter what:
//   default-src 'self'      nothing loads from third parties
//   object-src 'none'       no flash/embed vectors
//   frame-ancestors 'none'  cant be framed, so no clickjacking
//   base-uri 'self'         cant rewrite how relative urls resolve
//   form-action 'self'      forms cant post creds off-site

// file bytes come off a different hostname than the app, so 'self' doesnt cover
// them. leave the cdn origin out here and the browser silently blocks every
// image preview + inline player. doesnt repro locally bc in dev the cdn origin
// and the page origin are the same.
const cdnOrigins = (
  process.env.BLIROX_CDN_ORIGIN
    ? [process.env.BLIROX_CDN_ORIGIN]
    : (process.env.BLIROX_CDN_HOSTS ?? 'us01.example.com')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
        .map((h) => (h.startsWith('http') ? h : `https://${h}`))
).join(' ')

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // data: for the inline svg mark, blob: for local previews before avatar upload
  `img-src 'self' data: blob: ${cdnOrigins}`,
  "font-src 'self'",
  // cdn origin belongs here too, easy to miss bc the symptom's different: this
  // one governs fetch(), and the encrypted-file page pulls its ciphertext off
  // the byte host before decrypting in the browser. same deal — invisible in dev
  // where everything's same-origin.
  `connect-src 'self' ${cdnOrigins}`,
  `media-src 'self' blob: ${cdnOrigins}`,
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // nothing here needs a camera, mic, or location
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  // https-only through the tunnel. two years, subdomains included
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // isolates us from cross-origin popups we open
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
]

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  // the dev api runs on its own hostname (api.example.com) but in this same app
  // process. instead of duplicating routes, requests to that host get rewritten
  // onto the paths that already exist:
  //   api host /             → the docs page (app/developers)
  //   api host /v1/*         → app/api/v1/*
  //   api host /openapi.json → the generated spec
  // gated on the Host header so files.example.com is totally unaffected (there
  // /developers and /api/v1/* live at their real paths). splitting the host out
  // means the api can move or get its own rate limits later without any app url
  // changing.
  //
  // these go in beforeFiles, not a plain array, and it matters for `/`: a
  // plain-array rewrite runs AFTER filesystem routes, so `/` would resolve to
  // app/page.tsx (the landing) before the rewrite even gets consulted, and the
  // api host would show the pitch instead of the docs. beforeFiles runs ahead of
  // that lookup. the host gate still keeps `/` on files.example.com untouched.
  async rewrites() {
    const apiHost = process.env.BLIROX_API_HOST || 'api.example.com'
    const onApiHost = [{ type: 'host', value: apiHost }]
    return {
      beforeFiles: [
        { source: '/', has: onApiHost, destination: '/developers' },
        { source: '/openapi.json', has: onApiHost, destination: '/api/v1/openapi.json' },
        { source: '/v1/:path*', has: onApiHost, destination: '/api/v1/:path*' },
      ],
    }
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // file bytes are user-supplied content served off a hostname that shares
        // a registrable domain with the app. it must NEVER be able to run as the
        // app, so it gets a sandbox + its own empty policy. the route handler
        // sets matching headers — these are just the backstop.
        source: '/api/dl/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; sandbox" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
        ],
      },
      {
        // thumbs are ours, not the uploader's — re-encoded by sharp so they carry
        // none of the original's structure or metadata. still sandboxed, but
        // unlike the originals theyre deliberately readable cross-origin: a link
        // unfurler grabbing one from discord's side of the world is the whole
        // point of making them.
        source: '/api/thumb/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; sandbox" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
