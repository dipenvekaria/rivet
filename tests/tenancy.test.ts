import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Tenancy guard.
 *
 * The `pg` pool connects as superuser and bypasses RLS, so `where company_id =
 * $n` in each statement is the *primary* access control — there is no framework
 * catching a missing one. A forgotten predicate is a cross-tenant read that
 * compiles, passes review, and looks correct in local testing against a single
 * seeded company.
 *
 * This test extracts every SQL statement in live code and fails on any that is
 * neither self-evidently scoped nor explicitly accounted for below. It cannot
 * prove a query is safe — a statement can carry `company_id` and still be wrong
 * — but it makes an *unscoped* one impossible to add silently.
 *
 * A manual audit on 2026-08-10 reviewed all 53 call sites and found no leaks.
 * The exemptions below are that audit, written down.
 */

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')

/**
 * Statements with no literal `company_id`, each safe for a specific reason.
 *
 * Adding an entry is a deliberate act: state why the statement cannot leak.
 * "It looked fine" is not a reason — the safe pattern is that a preceding query
 * already verified the parent row against the caller's company AND the code
 * bails when that lookup returns nothing.
 */
const EXEMPT: Array<{ file: string; match: string; reason: string }> = [
  {
    file: 'src/app/api/stripe/webhook/route.ts',
    match: 'insert into payments',
    reason: 'Signed Stripe webhook; keyed to the invoice id from the verified event, and the reference-number unique index enforces idempotency.',
  },
  {
    file: 'src/app/api/stripe/webhook/route.ts',
    match: 'update invoices',
    reason: 'Signed Stripe webhook; keyed to the invoice id from the verified event.',
  },
  {
    file: 'src/app/api/stripe/webhook/route.ts',
    match: 'select i.company_id, i.work_item_id',
    reason: 'Signed Stripe webhook; resolves the tenant for the notification from the invoice id in the verified event.',
  },
  {
    file: 'src/app/api/retell/webhook/route.ts',
    match: 'where voice_number = $1',
    reason: 'Signed Retell webhook; the called number IS the tenant lookup — voice_number is unique.',
  },
  {
    file: 'src/app/api/retell/webhook/route.ts',
    match: 'update voice_calls set work_item_id',
    reason: 'Keys off retell_call_id (globally unique), inserted with company_id one statement earlier in the same transaction.',
  },
  {
    file: 'src/app/app/(shell)/integrations/actions.ts',
    match: 'select name, trade, phone, email, retell_agent_id from companies where id = $1',
    reason: '$1 is session.companyId; companies.id is the tenant key itself.',
  },
  {
    file: 'src/app/app/(shell)/calls/page.tsx',
    match: 'select voice_enabled, voice_number, settings from companies where id = $1',
    reason: 'companies row fetched by the session company id itself — the id is the tenant key.',
  },
  {
    file: 'src/lib/billing/access.ts',
    match: 'from companies',
    reason: 'Keys off companies.id — the tenant key — passed from the caller session.',
  },
  {
    file: 'src/lib/scheduling/assess.ts',
    match: 'select address, settings from companies where id = $1',
    reason: 'companyId comes from the session in the calling action; companies.id is the tenant key itself.',
  },
  {
    file: 'src/lib/scheduling/assess.ts',
    match: "jsonb_build_object('office_geo'",
    reason: 'Caches the office geocode on the caller\'s own company row — where id = $1 is the session companyId.',
  },
  {
    file: 'src/app/app/(shell)/dashboard/page.tsx',
    match: 'from companies where id = $1',
    reason: '$1 is companyId from requireSession(); companies.id is the tenant key itself.',
  },
  {
    file: 'src/lib/getting-started.ts',
    match: 'from companies where id = $1',
    reason: '$1 is the companyId the caller passed from its session; companies.id is the tenant key.',
  },
  // Platform-admin surface: cross-tenant by design, gated by the
  // platform_admins allow-list (requirePlatformAdmin) rather than company_id.
  {
    file: 'src/lib/admin/guard.ts',
    match: 'from platform_admins',
    reason: 'Allow-list lookup — the gate itself.',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'as mrr_cents',
    reason: 'Business metrics read for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'as degraded_ai',
    reason: 'Platform health read for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'from companies co',
    reason: 'Platform roster read for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'from ai_conversations a',
    reason: 'Degraded-AI read for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'from quickbooks_connections q',
    reason: 'QBO-errors read for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'from payments p',
    reason: 'Payments read for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'from platform_admins',
    reason: 'Allow-list read for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/app/admin/actions.ts',
    match: 'admin_audit',
    reason: 'Platform audit ledger writes, behind requirePlatformAdmin().',
  },
  {
    file: 'src/app/admin/actions.ts',
    match: 'platform_admins',
    reason: 'Allow-list management; guarded by requirePlatformAdmin().',
  },
  {
    file: 'src/app/admin/actions.ts',
    match: 'from companies where id = $1',
    reason: 'Company management for /admin, behind requirePlatformAdmin(); cross-tenant by design.',
  },
  {
    file: 'src/app/admin/actions.ts',
    match: 'update companies set trial_ends_at',
    reason: 'Trial extension from /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/app/admin/actions.ts',
    match: 'update companies set complimentary',
    reason: 'Comp toggle from /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/app/admin/actions.ts',
    match: 'update companies set admin_notes',
    reason: 'Admin notes from /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/lib/admin/queries.ts',
    match: 'from admin_audit',
    reason: 'Per-company admin history for /admin, behind requirePlatformAdmin().',
  },
  {
    file: 'src/app/app/(shell)/integrations/actions.ts',
    match: 'update companies',
    reason: 'Keys off companies.id — the tenant key — from getSession().',
  },
  {
    file: 'src/app/api/stripe/connect/route.ts',
    match: 'from companies',
    reason: 'Keys off companies.id — the tenant key — from getSession().',
  },
  {
    file: 'src/app/api/stripe/connect/route.ts',
    match: 'update companies',
    reason: 'Keys off companies.id — the tenant key — from getSession().',
  },
  {
    file: 'src/app/api/stripe/connect/refresh/route.ts',
    match: 'from companies',
    reason: 'Keys off companies.id — the tenant key — from getSession().',
  },
  {
    file: 'src/lib/stripe/connect-status.ts',
    match: 'from companies',
    reason: 'Keys off companies.id — the tenant key — passed from the caller session.',
  },
  {
    file: 'src/lib/stripe/connect-status.ts',
    match: 'update companies',
    reason: 'Keys off companies.id — the tenant key — passed from the caller session.',
  },
  {
    file: 'src/app/app/(shell)/dashboard/actions.ts',
    match: 'update companies',
    reason: 'Keys off companies.id — the tenant key — from getSession().',
  },
  {
    file: 'src/lib/stripe/billing.ts',
    match: 'from companies where id = $1',
    reason: 'companyId comes from getSession() in the calling action; companies.id is the tenant key itself.',
  },
  {
    file: 'src/lib/stripe/billing.ts',
    match: 'update companies',
    reason:
      'Writes key off companies.id — the tenant key — supplied by the session (checkout/portal) ' +
      'or by Stripe subscription metadata we wrote at creation (webhook sync).',
  },
  {
    file: 'src/app/app/(shell)/import/actions.ts',
    match: 'insert into customer_addresses',
    reason:
      'customer_id comes from the customer row inserted one statement earlier ' +
      'in the same transaction, itself created with the session companyId.',
  },
  {
    file: 'src/app/waitlist-actions.ts',
    match: 'insert into waitlist',
    reason: 'Global pre-launch interest table; the signer is a stranger, not a tenant.',
  },
  {
    file: 'src/lib/recurring.ts',
    match: "where w.recurrence is not null",
    reason:
      'The cron scan is cross-tenant by design (like reindex/followups); every ' +
      'write it makes derives company_id from the template row it selected.',
  },
  // --- reads scoped by a session-derived company id -------------------------
  {
    file: 'src/app/app/(shell)/layout.tsx',
    match: 'from companies where id = $1',
    reason: '$1 is companyId from requireSession()',
  },
  {
    file: 'src/app/app/(shell)/integrations/page.tsx',
    match: 'from companies',
    reason: '$1 is companyId from requireSession()',
  },
  {
    file: 'src/app/app/(shell)/settings/team-actions.ts',
    match: 'from companies where id = $1',
    reason: '$1 is session.companyId',
  },
  {
    file: 'src/app/app/(shell)/settings/actions.ts',
    match: 'update companies set',
    reason: 'where id = $7 is session.companyId',
  },
  {
    file: 'src/app/app/(shell)/settings/danger-actions.ts',
    match: 'select id, name from companies where id = $1',
    reason: '$1 is session.companyId; companies.id is itself the tenant key',
  },
  {
    file: 'src/lib/ai/estimate.ts',
    match: 'select settings from companies where id = $1',
    reason:
      '$1 is the companyId the estimator was called with, which comes from the session; ' +
      'companies.id is itself the tenant key. Reads labor_rate and materials_markup to price ' +
      'an item the catalog does not carry',
  },
  {
    file: 'src/app/app/(shell)/pipeline/[id]/actions.ts',
    match: 'select settings from companies where id = $1',
    reason:
      '$1 is session.companyId; companies.id is itself the tenant key. Reads quote_valid_days ' +
      'to set an expiry when a quote is sent',
  },
  {
    file: 'src/app/app/(shell)/settings/danger-actions.ts',
    match: 'select archive_and_delete_company($1, $2, $3)',
    reason:
      'closing an account. $1 is the session company, re-read and name-confirmed first; ' +
      'the function scopes every statement inside it by that one company id',
  },
  {
    file: 'src/app/app/(shell)/quotes/new/actions.ts',
    match: 'from customer_addresses where customer_id',
    reason: 'the customer was verified against company_id before the transaction opened',
  },
  {
    file: 'src/app/app/(shell)/quotes/new/actions.ts',
    match: 'insert into customer_addresses',
    reason: 'same verified customer; company_id was checked on the picked id',
  },
  {
    file: 'src/app/app/(shell)/customers/actions.ts',
    match: 'select id from customer_addresses where customer_id = $1',
    reason:
      'updateCustomer. The same transaction has already run "update customers ... and ' +
      'company_id = $5 returning id" and thrown NOT_FOUND on an empty result, so the ' +
      'customer id is proven to belong to the caller before this runs',
  },
  {
    file: 'src/app/app/(shell)/customers/actions.ts',
    match: 'update customer_addresses',
    reason: 'same verified customer, same transaction as the ownership check above',
  },
  {
    file: 'src/app/app/(shell)/quotes/new/actions.ts',
    match: 'update customer_addresses',
    reason:
      'backfills city/state/zip on an address row found by customer_id, where that ' +
      'customer id was already checked against company_id before the transaction opened',
  },
  {
    file: 'src/app/app/(shell)/quotes/new/actions.ts',
    match: "settings->>'tax_rate'",
    reason: 'where id = $1 is session.companyId',
  },
  {
    file: 'src/lib/ai/quote.ts',
    match: "settings->>'tax_rate'",
    reason: 'where id = $1 is the companyId the caller took from getSession()',
  },
  {
    file: 'src/lib/scheduling/availability.ts',
    match: 'business_hours from companies',
    reason: '$1 is the companyId the caller took from getSession()',
  },
  {
    file: 'src/app/app/onboarding/actions.ts',
    match: 'update companies',
    reason: 'where id = $2 is the company bootstrap_company just created for this caller',
  },

  // --- child rows reached through a parent already verified ----------------
  {
    file: 'src/app/app/(shell)/customers/[id]/page.tsx',
    match: 'from customer_addresses',
    reason: 'customer fetched with company_id above; notFound() when missing',
  },
  {
    file: 'src/app/app/(shell)/catalog/actions.ts',
    match: 'delete from promotion_labels',
    reason: 'the promotion was inserted or updated with company_id immediately above',
  },
  {
    file: 'src/app/app/(shell)/catalog/actions.ts',
    match: 'insert into promotion_labels',
    reason:
      'promotion verified against company_id above, and every label id came from resolveLabel which is company-scoped',
  },
  {
    file: 'src/app/app/(shell)/catalog/actions.ts',
    match: 'delete from catalog_item_labels',
    reason: 'the catalog item was verified against company_id earlier in the action',
  },
  {
    file: 'src/app/app/(shell)/catalog/actions.ts',
    match: 'insert into catalog_item_labels',
    reason:
      'item verified against company_id above, and every label id came from resolveLabel which is company-scoped',
  },
  {
    file: 'src/app/app/(shell)/customers/actions.ts',
    match: 'insert into customer_addresses',
    reason:
      'same transaction as the customers insert immediately above, which carried company_id from the session',
  },
  {
    file: 'src/app/app/(shell)/customers/page.tsx',
    match: 'from customer_addresses',
    reason: 'customer ids come from a company-scoped query',
  },
  {
    file: 'src/app/app/(shell)/pipeline/[id]/actions.ts',
    match: 'from quote_items',
    reason: 'work item verified against company_id earlier in the action',
  },
  {
    file: 'src/app/app/(shell)/pipeline/[id]/page.tsx',
    match: 'from quote_items',
    reason: 'work item loaded with w.company_id = $1, then if (!row) notFound()',
  },
  {
    file: 'src/app/app/(shell)/pipeline/[id]/page.tsx',
    match: 'from invoices',
    reason: 'keyed on the already-verified work item id',
  },
  {
    file: 'src/app/app/(shell)/pipeline/[id]/page.tsx',
    match: 'from payments',
    reason: 'keyed on the invoice belonging to the verified work item',
  },
  {
    file: 'src/app/app/(shell)/quotes/new/actions.ts',
    match: 'delete from quote_items',
    reason: 'preceded by an ownership check on work_items',
  },
  {
    file: 'src/app/app/(shell)/quotes/new/actions.ts',
    match: 'insert into quote_items',
    reason: 'preceded by an ownership check on work_items',
  },
  {
    file: 'src/lib/ai/quote-tools.ts',
    match: 'insert into quote_items',
    reason:
      'every tool calls assertOwned() first, which selects the work item by id AND company_id ' +
      'and throws if it is not the caller\'s. quote_items has no company_id of its own — it ' +
      'inherits tenancy from its work item, same as the existing exemptions above',
  },
  {
    file: 'src/app/app/(shell)/quotes/new/actions.ts',
    match: 'update work_items',
    reason: 'preceded by an ownership check on work_items',
  },
  {
    file: 'src/features/invoices/actions.ts',
    match: 'update work_items set invoice_number',
    reason: 'work item loaded with id = $1 and company_id = $2',
  },
  {
    file: 'src/features/invoices/actions.ts',
    match: 'insert into payments',
    reason: 'invoice verified with id = $1 and company_id = $2',
  },
  {
    file: 'src/features/invoices/actions.ts',
    match: 'update invoices set',
    reason: 'invoice verified with id = $1 and company_id = $2',
  },

  {
    file: 'src/app/app/(shell)/pipeline/[id]/photo-actions.ts',
    match: 'from quote_items where id = $1 and work_item_id = $2',
    reason:
      'the work item was verified against company_id immediately above; this only confirms the line belongs to that same quote',
  },

  // --- keyed on an unguessable token rather than a session ------------------
  {
    file: 'src/app/join/[token]/page.tsx',
    match: 'from invitations',
    reason:
      'unauthenticated invite page; the 128-bit token IS the credential and selects its own row',
  },
  {
    file: 'src/app/join/[token]/actions.ts',
    match: 'from invitations',
    reason:
      'same token, same reason: resolves the invited email so the sign-up form can lock it. ' +
      'Cannot be session-scoped — the whole point is that the invitee has no account yet. ' +
      'Returns nothing for a used, expired or unknown token, and only ever the row that token names',
  },

  // --- not tenant data at all -------------------------------------------------
  {
    file: 'src/lib/rate-limit.ts',
    match: 'rate_limits',
    reason:
      'counters, not tenant data. The bucket string encodes who is limited — ai:<companyId>, ' +
      'sign:<token> — so a company only ever increments its own, but the row holds a key and a ' +
      'number and nothing readable. Keying by company_id column instead would mean the ' +
      'unauthenticated sign route had no company to scope by',
  },
  {
    file: 'src/lib/scheduling/travel.ts',
    match: 'from travel_estimates',
    reason:
      'cached drive time between two rounded coordinate pairs. Holds no company data — a ' +
      'distance between two points belongs to nobody — and being shared across companies is ' +
      'what makes the cache worth having: the alternative is paying Google once per tenant ' +
      'for the same answer',
  },
  {
    file: 'src/lib/scheduling/travel.ts',
    match: 'insert into travel_estimates',
    reason: 'same cache, same reason; the row records coordinates and seconds, nothing tenant-owned',
  },

  // --- deliberately cross-tenant ---------------------------------------------
  {
    file: 'src/features/quotes/followups.ts',
    match: 'select distinct w.company_id',
    reason:
      'cron enumeration: returns company ids only, never tenant data, and each id is then passed to the company-scoped sendQuoteFollowUps',
  },
]

/** RPCs that enforce tenancy inside the function body. */
const TENANT_SAFE_RPCS = [
  'create_work_item_with_customer',
  'bootstrap_company',
  'accept_invitation',
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

type Stmt = { file: string; line: number; sql: string }

function extractStatements(): Stmt[] {
  const out: Stmt[] = []
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file)
    if (rel.endsWith('src/lib/db/index.ts')) continue // the helpers themselves
    const text = readFileSync(file, 'utf8')
    // `await query(...)` / `await q(...)`, capturing the SQL template literal
    // Bare `query(` (no await) counts too: Promise.all waves hold unawaited
    // calls, and a scanner that only sees `await query(` goes blind to them.
    // No whitespace before the paren: real calls are `query(`/`query<T>(`,
    // while prose in comments writes "the repair query (`...`)".
    const re = /(?:await\s+)?\b(?:query|q)(?:<[^>]*>)?\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g
    for (const m of text.matchAll(re)) {
      out.push({
        file: rel,
        line: text.slice(0, m.index).split('\n').length,
        sql: m[1].slice(1, -1).replace(/\s+/g, ' ').trim().toLowerCase(),
      })
    }
  }
  return out
}

/**
 * `company_id` used as a filter, not merely mentioned.
 *
 * This used to be `sql.includes('company_id')`, which passed anything that so
 * much as selected the column — `select distinct company_id from work_items`
 * scans every tenant and satisfied it. The predicate has to be in a WHERE, a
 * JOIN, or an INSERT column list to actually confine the statement.
 */
function isScoped(sql: string): boolean {
  // where company_id = $1 / and w.company_id = c.id / company_id in (...)
  if (/\bcompany_id\s*(=|in\s*\()/.test(sql)) return true
  // insert into catalog_items (company_id, ...)
  if (/insert\s+into\s+[\w."]+\s*\([^)]*\bcompany_id\b/.test(sql)) return true
  return false
}

function isAccountedFor(s: Stmt): boolean {
  if (isScoped(s.sql)) return true
  if (TENANT_SAFE_RPCS.some((fn) => s.sql.includes(fn))) return true
  // A user reading their own row: `from users where id = $1`
  if (/from\s+users\s+where\s+id\s*=/.test(s.sql)) return true
  return EXEMPT.some((e) => s.file === e.file && s.sql.includes(e.match))
}

describe('tenancy', () => {
  it('finds SQL to check', () => {
    // Guards against the extractor silently matching nothing after a refactor,
    // which would make every assertion below vacuously true.
    expect(extractStatements().length).toBeGreaterThan(30)
  })

  it('every statement is company-scoped or explicitly exempt', () => {
    const unaccounted = extractStatements().filter((s) => !isAccountedFor(s))
    const report = unaccounted
      .map((s) => `\n  ${s.file}:${s.line}\n    ${s.sql.slice(0, 120)}`)
      .join('')
    expect(
      unaccounted,
      `${unaccounted.length} SQL statement(s) touch company data without a ` +
        `company_id predicate and are not exempt.${report}\n\n` +
        `The pg pool bypasses RLS — an unscoped statement is a cross-tenant leak. ` +
        `Either add "where company_id = $n", or add an entry to EXEMPT in this ` +
        `file stating why it cannot leak.\n`,
    ).toHaveLength(0)
  })

  it('exemptions all still match a real statement', () => {
    // Stops the list rotting into a set of stale rules that quietly permit
    // whatever happens to match them later.
    const stmts = extractStatements()
    const dead = EXEMPT.filter(
      (e) => !stmts.some((s) => s.file === e.file && s.sql.includes(e.match)),
    )
    expect(
      dead,
      `Exemption(s) no longer match any statement — delete them:` +
        dead.map((d) => `\n  ${d.file} :: "${d.match}"`).join(''),
    ).toHaveLength(0)
  })
})
