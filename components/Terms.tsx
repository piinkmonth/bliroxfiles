import { TERMS, TERMS_VERSION } from '@/lib/terms'

/**
 * The full terms, rendered inline.
 *
 * `scroll` constrains it to a fixed height for the invite flow, where it sits
 * above a form; the standalone /terms page renders it at full length.
 */
export function Terms({ scroll = false }: { scroll?: boolean }) {
  return (
    <div
      className={
        scroll
          ? 'max-h-[22rem] overflow-y-auto border border-border bg-raised/40 p-5'
          : ''
      }
    >
      <div className="space-y-6">
        {TERMS.map((section) => (
          <section key={section.id}>
            <h3
              className={`font-mono text-xs uppercase tracking-wide ${
                section.severity === 'critical' ? 'text-danger' : 'text-accent'
              }`}
            >
              {section.title}
            </h3>

            {section.paragraphs.map((p, i) => (
              <p key={i} className="mt-2 text-sm leading-relaxed text-muted">
                {p}
              </p>
            ))}

            {section.bullets && (
              <ul className="mt-3 space-y-1.5">
                {section.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-muted">
                    <span className="select-none text-accent">—</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <p className="border-t border-border pt-4 font-mono text-[11px] text-muted">
          version {TERMS_VERSION}
        </p>
      </div>
    </div>
  )
}
