import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <h1 className="text-4xl font-semibold">404</h1>
      <p className="mt-2 text-muted">
        That link doesn&rsquo;t point at anything — it may have been deleted or never existed.
      </p>
      <Link href="/" className="btn-ghost mt-6">
        Go home
      </Link>
    </main>
  )
}
