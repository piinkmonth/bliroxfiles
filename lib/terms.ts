/**
 * Terms of service.
 *
 * Kept as data rather than markup so the same text can be rendered on the
 * standalone /terms page, inlined into the invite flow, and versioned — the
 * `TERMS_VERSION` is recorded against an account when it accepts, so you can
 * tell who agreed to what if it ever matters.
 *
 * On copyright: these terms neither endorse nor police infringement. They put
 * responsibility on the uploader and commit to honouring valid takedown
 * notices, which is what preserves DMCA safe-harbour protection (17 U.S.C.
 * § 512). Advertising infringing use would forfeit that protection and create
 * inducement liability — see SETUP.md.
 */

export const TERMS_VERSION = '2026-07-30'

export interface TermsSection {
  id: string
  title: string
  /** `severity` drives emphasis in the UI, not legal weight. */
  severity?: 'critical' | 'normal'
  paragraphs: string[]
  bullets?: string[]
}

export const TERMS: TermsSection[] = [
  {
    id: 'invite',
    title: 'This is an invite-only service',
    paragraphs: [
      'Accounts exist only by invitation. Whoever invited you is recorded permanently against your account, and that chain is visible to staff. They vouched for you; if you abuse the service, that reflects on them and may cost them their own account.',
      'Do not share your invite links with people you would not personally answer for.',
    ],
  },
  {
    id: 'csam',
    title: 'Child sexual abuse material',
    severity: 'critical',
    paragraphs: [
      'Uploading sexual content involving minors will result in immediate and permanent removal of your account and a report to the National Center for Missing & Exploited Children, including your IP address, your full upload history, and the account that invited you.',
      'There is no warning, no appeal, and no exception. Reported content is preserved rather than deleted, because law requires it. Do not test this.',
    ],
  },
  {
    id: 'malware',
    title: 'Malware and hostile files',
    severity: 'critical',
    paragraphs: [
      'Do not upload malware, and above all do not use this service as hosting infrastructure for distributing it. Storing a sample you are analysing is one thing; pointing a dropper, a botnet, or a phishing campaign at a link here is another, and it is the fastest way to get this domain blacklisted and the server taken offline.',
    ],
    bullets: [
      'No trojans, ransomware, droppers, loaders, stealers, or miners staged for distribution',
      'No phishing kits or credential-harvesting pages',
      'No files whose purpose is to compromise whoever opens them',
      'Uploads are scanned. Detections are quarantined and the uploader is reviewed.',
    ],
  },
  {
    id: 'harassment',
    title: 'Targeting people',
    severity: 'critical',
    paragraphs: [
      'Nothing here may be used to harass, threaten, dox, or impersonate a specific person. That includes hosting someone’s personal information, private images shared without consent, or material assembled to intimidate them.',
    ],
  },
  {
    id: 'content',
    title: 'Your files are your responsibility',
    paragraphs: [
      'You are solely responsible for everything you upload and for having the right to upload it. This service does not review files before they are stored and does not monitor what you keep here.',
      'If a rights holder submits a valid takedown notice, the file will be removed and you will be told. Accounts that accumulate repeated valid complaints will be terminated.',
      'Nothing in these terms should be read as permission to upload material you have no right to distribute.',
    ],
  },
  {
    id: 'fair-use',
    title: 'This runs on a home server',
    paragraphs: [
      'Storage and bandwidth are finite and paid for by one person. Downloads are rate-limited, there is a daily transfer cap per address, and both may be tightened without notice if the connection is being saturated.',
      'Do not hotlink files into high-traffic sites, use this as a CDN for an application, or run automated scrapers against it. Use it to send big files to people.',
    ],
  },
  {
    id: 'encryption',
    title: 'Encrypted folders',
    paragraphs: [
      'Encrypted folders are end-to-end: the key is derived in your browser and never reaches the server. Nobody, including staff, can read their contents or recover them if you lose the password.',
      'Because that content cannot be inspected, it also cannot be shared. Files in encrypted folders have no public links, by design.',
    ],
  },
  {
    id: 'privacy',
    title: 'What is recorded',
    paragraphs: [
      'Your IP address at signup and at each login, your upload and download history, and the invite chain leading to your account are all logged and retained. Moderation actions are written to an append-only audit trail.',
      'This information is not sold or shared, with two exceptions: a lawful legal demand, and a report to NCMEC in the case above.',
    ],
  },
  {
    id: 'availability',
    title: 'No guarantees',
    paragraphs: [
      'This is a hobby service on consumer hardware and a consumer internet connection. It will go down. Drives fail, power cuts happen, and there is no SLA and no compensation.',
      'Keep your own copy of anything you cannot afford to lose. This is a way to move files between people, not a backup.',
    ],
  },
  {
    id: 'enforcement',
    title: 'Enforcement',
    paragraphs: [
      'Accounts may be suspended or removed for breaking these terms. Content removed for abuse is fingerprinted so it cannot be uploaded again by anyone.',
      'Where the reason is not a safety matter, you will be told what happened and can respond. For the categories marked above as critical, removal is immediate and final.',
    ],
  },
]

/** Flattened text, for the audit record of what was accepted. */
export function termsPlainText(): string {
  return TERMS.map((s) => {
    const bullets = s.bullets?.map((b) => `  - ${b}`).join('\n') ?? ''
    return `## ${s.title}\n\n${s.paragraphs.join('\n\n')}${bullets ? `\n\n${bullets}` : ''}`
  }).join('\n\n')
}
