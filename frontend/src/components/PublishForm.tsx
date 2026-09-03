import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { ContractEditor } from './ContractEditor'
import {
  contractIsFrozen,
  declaredParams,
  declaredParamsTyped,
  endpointPath,
  parseDefaults,
  problemWithPublished,
  requiredParams,
  serialiseDefaults,
  slugify,
  type Published,
} from '../lib/publish'
import { ErrorNote } from './Note'
import { CheckPanel } from './CheckPanel'
import { suggestName, type Handoff } from '../lib/handoff'

/** Publishing a statement, and editing one that is already published.
 *
 *  Shared by the list page — which only ever creates — and the endpoint page,
 *  which only ever edits. One form, because the fields are the same fields and
 *  two of them would drift apart on the first change.
 *
 *  What it will *not* let somebody do is change the statement or the contract
 *  of a revision that is live: callers pinned to it pinned to a shape, and
 *  changing that under them without changing the number is worse than no
 *  versioning at all. The server refuses it; this says so before anyone types.
 */
export function PublishForm({
  existing,
  handoff,
  defaultDatabase,
  delegatableRoles,
  timezone,
  onDone,
}: {
  existing: Published | null
  /** A statement the editor sent over. Its name seeds the address too. */
  handoff: Handoff | null
  defaultDatabase: string
  /** Called with the token that was minted, where one was — this is the only
   *  moment anything can read it. */
  /** What this deployment is willing to hand out. Empty means the control is
   *  not offered at all — a select whose every value the server would refuse
   *  is worse than no select. */
  delegatableRoles: string[]
  /** The server's own, because that is the clock an expiry is measured by. */
  timezone: string | undefined
  onDone: (minted: string | null, slug: string) => void
}) {
  /* A live revision's statement and contract are what its callers are pinned
     to. The server refuses to change them; the form greys them and says why,
     because finding out from a red error after typing a paragraph is a worse
     way to learn a rule than reading it beforehand. */
  const frozen = existing ? contractIsFrozen(existing) : false
  const client = useQueryClient()
  const handedName = handoff ? suggestName(handoff, '') : ''
  const [name, setName] = useState(existing?.name ?? handedName)
  const [slug, setSlug] = useState(existing?.slug ?? slugify(handedName))
  const [slugTouched, setSlugTouched] = useState(Boolean(existing))
  const [sql, setSql] = useState(existing?.sql ?? handoff?.sql ?? '')
  const [database, setDatabase] = useState(
    existing?.database ?? handoff?.database ?? defaultDatabase,
  )
  const [defaults, setDefaults] = useState<Record<string, string>>(() =>
    parseDefaults(existing?.defaults ?? '{}'),
  )
  const [isPublic, setPublic] = useState(existing?.public ?? false)
  const [maxRows, setMaxRows] = useState(existing?.max_rows ?? 1000)
  const [expiresAt, setExpiresAt] = useState(existing?.expires_at ?? '')
  const [runAs, setRunAs] = useState(existing?.run_as ?? '')
  const [zone, setZone] = useState(existing?.timezone ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [cacheTtl, setCacheTtl] = useState(existing?.cache_ttl ?? 0)
  const [contract, setContract] = useState(existing?.contract ?? '')
  /* The question behind the statement, where there is one.
     
     An endpoint published from the Builder answers a question, and the
     statement below it is what that question rendered to on the server. It is
     shown, because a reviewer reading a draft needs to see what will run, and
     it is not editable, because a statement typed over its question would
     leave the address running one thing and reopening as another. Taking it
     over is a deliberate act with its own button, and it is one-way. */
  const [document, setDocument] = useState(existing?.document ?? handoff?.document ?? '')
  const asks = document.trim() !== ''
  /* What the statement turned out to return, learned from the check below the
     first time somebody runs it. Empty until then, and the editor says so
     rather than presenting an empty list as "this returns nothing". */
  const [columns, setColumns] = useState<string[]>([])
  /* The server's list, because the server is what reads this zone back when a
     call arrives. Fetched only while the form is open. */
  const zones = useQuery({ queryKey: ['timezones'], queryFn: () => api.timezones() })

  // A question declares no parameters: its values were settled when it was
  // published, and the placeholders in the statement it rendered to are the
  // renderer's own. Reading them off the SQL would offer a default for
  // `flint_f0`, which is not a thing anybody can fill in.
  const params = asks ? [] : declaredParams(sql)
  /* Testable here only when every placeholder has a value to stand in for the
     caller's. A made-up value would answer a question nobody asked. */
  const missingDefaults = asks ? [] : requiredParams(sql, defaults)
  const problem = problemWithPublished({ name, slug, sql })

  const save = useMutation({
    mutationFn: () =>
      api.savePublished({
        id: existing?.id,
        name,
        slug: slug.trim(),
        // One or the other, never both: the server renders the question into
        // the statement it stores, so a body carrying a statement *and* a
        // question would be one that runs and one that reopens, with nothing
        // on either screen saying which. `''` is how taking the statement over
        // says the question is gone.
        ...(asks ? { document } : { sql, document: existing?.document ? '' : undefined }),
        database,
        defaults: serialiseDefaults(defaults),
        public: isPublic,
        enabled: existing?.enabled ?? true,
        max_rows: maxRows,
        expires_at: expiresAt.trim(),
        run_as: runAs,
        timezone: zone,
        description,
        cache_ttl: cacheTtl,
        // Not sent for a frozen revision: the server would refuse it, and
        // sending a value it will refuse turns "you did not change this" into
        // an error message.
        contract: frozen ? undefined : contract,
      }),
    onSuccess: (saved) => {
      client.invalidateQueries({ queryKey: ['published'] })
      onDone(saved.minted ?? null, slug.trim())
    },
  })

  return (
    <section className="aform">
      <header className="aform__head">
        <h2 className="diag__title">{existing ? 'Edit this endpoint' : 'A new endpoint'}</h2>
      </header>

      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">NAME</span>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              // The address follows the name until someone edits it, so
              // nobody has to learn the rule to get a working URL.
              if (!slugTouched) setSlug(slugify(e.target.value))
            }}
            placeholder="Events by city"
          />
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">ADDRESS</span>
          <input
            className="input"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value)
            }}
            placeholder="events-by-city"
          />
        </label>
      </div>

      <p className="aform__hint">
        Will answer at <code>{endpointPath(slug || 'your-address')}</code>
      </p>

      <label className="aform__field">
        <span className="label">{asks ? 'STATEMENT, FROM THE QUESTION' : 'STATEMENT'}</span>
        <textarea
          className="input input--area"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={4}
          spellCheck={false}
          disabled={frozen || asks}
          aria-describedby={frozen ? 'pub-frozen' : asks ? 'pub-asks' : undefined}
          placeholder="SELECT city, count() AS n FROM events WHERE city = {city:String} GROUP BY city"
        />
      </label>

      {asks && !frozen ? (
        <>
          <p className="aform__hint" id="pub-asks">
            This address answers a question built in the form, so it can be reopened as the form
            that wrote it and the statement above is written for it. Saving writes that statement
            again from the question, so anything typed here would be written over. Taking it over
            keeps what is above and drops the question — after which the address can no longer be
            reopened in the form, which is why it is a button rather than something the form does
            on your behalf.
          </p>
          <div className="aform__actions">
            <button
              type="button"
              className="btn btn--soft"
              onClick={() => setDocument('')}
              title="Keep the statement and drop the question"
            >
              Take over the statement
            </button>
          </div>
        </>
      ) : null}

      {frozen ? (
        <p className="says says--watch says--wide" id="pub-frozen">
          v{existing?.revision} is {existing?.state} and callers are pinned to what it returns, so
          its statement and its contract are fixed. Start a new revision to change them — the
          change lands on the new number and this one goes on answering exactly as it does.
        </p>
      ) : null}

      <label className="aform__field">
        <span className="label">WHAT IT IS FOR</span>
        <textarea
          className="input input--area"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Daily event count and p95 latency per device fleet, by region."
        />
      </label>
      <p className="aform__hint">
        The one sentence in the OpenAPI document written by somebody who knows what this is{' '}
        <em>for</em>. Everything else in it is Flint describing mechanics — an agent or a notebook
        reads this and nothing else.
      </p>

      <ContractEditor
        raw={contract}
        onChange={setContract}
        params={asks ? [] : declaredParamsTyped(sql)}
        columns={columns}
        disabled={frozen}
      />

      {params.length ? (
        <div className="pub__params">
          <span className="label">PARAMETERS THIS STATEMENT DECLARES</span>
          {params.map((p) => (
            <label className="pub__param" key={p}>
              <code>{p}</code>
              <input
                className="input"
                value={defaults[p] ?? ''}
                onChange={(e) => setDefaults((d) => ({ ...d, [p]: e.target.value }))}
                placeholder="no default — a caller must supply it"
              />
            </label>
          ))}
        </div>
      ) : null}

      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">DATABASE</span>
          <input
            className="input"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="default"
          />
        </label>
        <label className="aform__field aform__field--tiny">
          <span className="label">CACHE (S)</span>
          <input
            className="input"
            value={cacheTtl}
            onChange={(e) => setCacheTtl(Math.max(0, Number(e.target.value) || 0))}
            inputMode="numeric"
            aria-describedby="pub-cache"
          />
        </label>
        <label className="aform__field aform__field--tiny">
          <span className="label">MAX ROWS</span>
          <input
            className="input"
            value={maxRows}
            onChange={(e) => setMaxRows(Math.max(1, Number(e.target.value) || 1))}
            inputMode="numeric"
          />
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">
            EXPIRES{timezone ? <span className="mono-dim"> {timezone}</span> : null}
          </span>
          <input
            className="input"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            placeholder="never"
            aria-describedby="pub-expires"
          />
        </label>
        {/* Only where the deployment delegates something. A select whose every
            value the server would refuse teaches people to distrust the form. */}
        {delegatableRoles.length && !isPublic ? (
          <label className="aform__field aform__field--narrow">
            <span className="label">RUNS AS</span>
            <select className="input" value={runAs} onChange={(e) => setRunAs(e.target.value)}>
              {/* Short enough for a narrow field: the long version was clipped
                  to "this Flint's own accoun", which reads as a bug. */}
              <option value="">Flint's account</option>
              {delegatableRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {/* Beside the other things a caller inherits rather than chooses. Not
            conditional on the statement mentioning a date: a statement is
            edited above this field, and a picker that appeared and vanished as
            somebody typed `toStartOfDay` would be a worse thing than a field
            that occasionally does nothing. The OpenAPI document is where the
            zone goes unmentioned when there is no date to place. */}
        <label className="aform__field aform__field--narrow">
          <span className="label">DAYS BEGIN IN</span>
          <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">{timezone ? `the server's (${timezone})` : "the server's"}</option>
            {(zones.data ?? []).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">ACCESS</span>
          <select
            className="input"
            value={isPublic ? 'public' : 'token'}
            onChange={(e) => setPublic(e.target.value === 'public')}
          >
            <option value="token">needs its token</option>
            <option value="public">anyone with the address</option>
          </select>
        </label>
      </div>

      {/* With the defaults filled in, this is what a caller will get. A
          statement with a parameter that has no default cannot be run here,
          and the check says so rather than pretending.

          Not offered for a question, and not because it would be awkward: the
          statement a question renders to binds its values rather than writing
          them in, and this panel has no way to supply one — it would offer a
          box for `flint_f0` and refuse to run until somebody typed something
          into it. The question was answered in the form it was built in, and
          the server checks it again against the dataset when it is saved. */}
      {asks ? (
        <p className="aform__hint">
          This question was answered in the form it was built in. Saving it here checks it once
          more against the dataset — a column that has since gone is refused now rather than on
          somebody's first call.
        </p>
      ) : (
        <CheckPanel
          sql={sql}
          database={database}
          params={params.map((p) => [p, defaults[p] ?? ''] as [string, string])}
          blocked={
            missingDefaults.length
              ? `Give ${missingDefaults.map((p) => `\`${p}\``).join(', ')} a default above to test it here — a caller would supply ${missingDefaults.length === 1 ? 'it' : 'them'}.`
              : undefined
          }
          label="What will a caller get?"
          onColumns={setColumns}
        />
      )}

      <p className="aform__hint" id="pub-cache">
        {cacheTtl > 0
          ? `An answer may be served from memory for ${cacheTtl} second${cacheTtl === 1 ? '' : 's'}, so a caller can be handed a figure that old. Held in this process only — two Flints behind a load balancer each keep their own, so one caller can see an answer up to ${cacheTtl} seconds older than another.`
          : 'No cache: every call runs the statement. Turn it on for a dashboard tile that forty browsers ask the same question within the same minute — and only where a figure being a few seconds stale is something you would say out loud to whoever reads it.'}
      </p>

      <p className="aform__hint" id="pub-expires">
        Leave EXPIRES empty and the endpoint answers for ever. A moment is read in{' '}
        {timezone ?? 'the server’s own timezone'}, because ClickHouse is what compares it against
        now — not the clock on the machine you are typing this on. A date — <code>2026-12-31</code>,
        or a timestamp — retires it at that moment, after which it answers exactly as an address
        that never existed. Worth setting for anything handed to somebody outside the team: a
        token pasted into a spreadsheet formula otherwise outlives the person who pasted it.
      </p>

      {isPublic ? (
        <p className="says says--watch says--wide">
          Anyone who can reach this Flint and knows the address will get this data. Flint has no
          login of its own, so "public" means public to the whole network it is on.
        </p>
      ) : (
        <p className="aform__hint">
          A token is minted for you and shown once — it is stored hashed, so nothing can read it
          back afterwards. Editing the endpoint keeps it, so callers do not break; rotating it
          from the card gives you a new one and refuses the old.
        </p>
      )}

      {problem ? <p className="says says--watch says--wide">{problem}</p> : null}
      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="aform__actions">
        <button
          className="btn btn--spark"
          disabled={!!problem || save.isPending}
          onClick={() => save.mutate()}
        >
          {existing ? 'Save changes' : 'Publish it'}
        </button>
        {/* Nothing was minted, so nothing is carried across. */}
        <button className="btn" onClick={() => onDone(null, slug.trim())}>
          Cancel
        </button>
      </div>
    </section>
  )
}
