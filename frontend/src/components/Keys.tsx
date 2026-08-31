import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { type Address, type ApiKey } from '../lib/publish'
import { ErrorNote } from './Note'
import { relativeTime } from '../lib/format'

/** Who may call, and how much.
 *
 *  Global rather than per-endpoint, because that is the shape of the thing
 *  being named: `app-frontend` is one program and it calls four addresses. A
 *  key owned by an endpoint would have to be minted four times and rotated
 *  four times, and the call log would show four strangers instead of one
 *  caller.
 *
 *  The secret is readable exactly once, at the moment it is minted. Everything
 *  here is arranged around that: the row that just produced one holds it until
 *  the page is left, and there is no control anywhere that offers to show a key
 *  again — because there is nothing to show. */
export function Keys({
  addresses,
  defaultOpen,
}: {
  addresses: Address[]
  /** Open from the start, because the URL said so. `?keys` is a link somebody
   *  sends when the answer to "who can call this" is the thing being asked
   *  about, and folding it shut on arrival makes that link useless. */
  defaultOpen?: boolean
}) {
  const client = useQueryClient()
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => api.keys(), retry: false })
  const [open, setOpen] = useState(defaultOpen ?? false)
  /** Secrets minted in this page's lifetime, by key id. Never fetched, never
   *  persisted: if this is lost, so is the secret. */
  const [minted, setMinted] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.saveKey>[0]) => api.saveKey(body),
    onSuccess: (out, body) => {
      if (out.minted) {
        const id = body.id ?? out.keys.find((k) => k.name === body.name)?.id
        if (id) setMinted((held) => ({ ...held, [id]: out.minted as string }))
      }
      setAdding(false)
      client.invalidateQueries({ queryKey: ['keys'] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteKey(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['keys'] }),
  })

  const rows = keys.data ?? []

  return (
    <section className="keys">
      <h2 className="keys__title">
        <button
          className="keys__toggle"
          aria-expanded={open}
          aria-controls="keys-body"
          onClick={() => setOpen((o) => !o)}
        >
          Keys
        </button>
        <span className="mono-dim">
          {rows.length === 0
            ? 'nobody is named — every call is anonymous'
            : `${rows.length} caller${rows.length === 1 ? '' : 's'}, named`}
        </span>
      </h2>

      {open ? (
        <div id="keys-body">
          <p className="keys__lead">
            A key names a caller. Without one an endpoint still answers — to its own token, or to
            anyone at all if it is public — but the call log cannot say who is calling, a quota has
            nothing to count against, and rotating locks out everybody at once.
          </p>

          {keys.error ? <ErrorNote error={keys.error} retry={() => keys.refetch()} /> : null}
          {save.error ? <ErrorNote error={save.error} /> : null}
          {remove.error ? <ErrorNote error={remove.error} /> : null}

          <ul className="keys__list">
            {rows.map((key) => (
              <KeyRow
                key={key.id}
                held={key}
                addresses={addresses}
                minted={minted[key.id]}
                onSave={(body) => save.mutate(body)}
                onDelete={() => remove.mutate(key.id)}
                busy={save.isPending || remove.isPending}
              />
            ))}
          </ul>

          {adding ? (
            <KeyForm
              addresses={addresses}
              onSave={(body) => save.mutate(body)}
              onCancel={() => setAdding(false)}
              busy={save.isPending}
            />
          ) : (
            <button className="btn" onClick={() => setAdding(true)}>
              A new key
            </button>
          )}
        </div>
      ) : null}
    </section>
  )
}

function KeyRow({
  held,
  addresses,
  minted,
  onSave,
  onDelete,
  busy,
}: {
  held: ApiKey
  addresses: Address[]
  minted?: string
  onSave: (body: Parameters<typeof api.saveKey>[0]) => void
  onDelete: () => void
  busy: boolean
}) {
  const [editing, setEditing] = useState(false)
  return (
    <li className={`keys__row${held.enabled ? '' : ' is-off'}`}>
      <div className="keys__head">
        <span className="keys__name">{held.name}</span>
        {held.owner ? <span className="mono-dim">{held.owner}</span> : null}
        {!held.enabled ? <span className="flag flag--idle">Disabled</span> : null}
        <span className="panel__spacer" />
        <button
          className="btn"
          onClick={() => setEditing((e) => !e)}
          aria-expanded={editing}
          disabled={busy}
        >
          {editing ? 'Close' : 'Edit'}
        </button>
        {/* Not "show": there is nothing to show. The secret is hashed on its
            way in and readable exactly once, so what this can offer is a new
            one — which is a real act with a real cost, and says so. */}
        <button
          className="btn"
          onClick={() =>
            onSave({
              id: held.id,
              name: held.name,
              owner: held.owner,
              scope: held.scope,
              quota_per_day: held.quota_per_day,
              enabled: held.enabled,
              rotate: true,
            })
          }
          disabled={busy}
        >
          Rotate
        </button>
        <button className="btn" onClick={onDelete} disabled={busy}>
          Delete
        </button>
      </div>

      <p className="keys__says">
        {held.scope.length === 0 ? (
          <span className="says says--watch">
            every address, including ones published after today
          </span>
        ) : (
          <span className="mono-dim">{held.scope.join(', ')}</span>
        )}
        <span className="mono-dim">
          {held.quota_per_day > 0
            ? `${held.quota_per_day} calls per day, per address`
            : 'no quota'}
        </span>
        <span className="mono-dim">made {relativeTime(held.created_at)}</span>
      </p>

      {minted ? (
        <p className="pub__token">
          <code>{minted}</code>
          <span className="mono-dim">
            Copy this now — it is stored hashed, so this is the only time anyone can read it. Every
            caller using the old one is already refused.
          </span>
        </p>
      ) : null}

      {editing ? (
        <KeyForm
          existing={held}
          addresses={addresses}
          onSave={(body) => {
            onSave(body)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
          busy={busy}
        />
      ) : null}
    </li>
  )
}

function KeyForm({
  existing,
  addresses,
  onSave,
  onCancel,
  busy,
}: {
  existing?: ApiKey
  addresses: Address[]
  onSave: (body: Parameters<typeof api.saveKey>[0]) => void
  onCancel: () => void
  busy: boolean
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [owner, setOwner] = useState(existing?.owner ?? '')
  const [scope, setScope] = useState<string[]>(existing?.scope ?? [])
  const [quota, setQuota] = useState(existing?.quota_per_day ?? 0)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)

  const toggle = (slug: string) =>
    setScope((held) => (held.includes(slug) ? held.filter((s) => s !== slug) : [...held, slug]))

  return (
    <div className="aform keys__form">
      <div className="aform__row">
        <label className="aform__field aform__field--narrow">
          <span className="label">NAME</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="app-frontend"
          />
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">WHO TO TALK TO</span>
          <input
            className="input"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="the web team"
          />
        </label>
        <label className="aform__field aform__field--tiny">
          <span className="label">CALLS / DAY</span>
          <input
            className="input"
            value={quota}
            onChange={(e) => setQuota(Math.max(0, Number(e.target.value) || 0))}
            inputMode="numeric"
            aria-describedby="key-quota"
          />
        </label>
        <label className="aform__field aform__field--narrow">
          <span className="label">STATE</span>
          <select
            className="input"
            value={enabled ? 'on' : 'off'}
            onChange={(e) => setEnabled(e.target.value === 'on')}
          >
            <option value="on">may call</option>
            <option value="off">disabled</option>
          </select>
        </label>
      </div>

      <p className="aform__hint" id="key-quota">
        {quota > 0
          ? `Counted per address, so one noisy tile cannot spend the budget this program's other calls depend on. Answered calls only — a refusal does not eat the allowance it was refused by. The count resets at midnight in the server's own timezone.`
          : 'No limit. Worth a number for anything that retries in a loop, which is every agent.'}
      </p>

      <div className="keys__scope">
        <span className="label">MAY CALL</span>
        {addresses.length === 0 ? (
          <p className="mono-dim">Nothing is published yet.</p>
        ) : (
          <div className="keys__chips">
            {addresses.map((address) => (
              <label className="keys__chip" key={address.slug}>
                <input
                  type="checkbox"
                  checked={scope.includes(address.slug)}
                  onChange={() => toggle(address.slug)}
                />
                <code>{address.slug}</code>
              </label>
            ))}
          </div>
        )}
        <p className="aform__hint">
          {scope.length === 0
            ? 'Nothing ticked means every address — including ones published after today, which is the part worth pausing on.'
            : `${scope.length} of ${addresses.length} addresses. Anything else is refused with the key named, and that refusal does not become true again tomorrow.`}
        </p>
      </div>

      <div className="aform__actions">
        <button
          className="btn btn--spark"
          disabled={busy || !name.trim()}
          onClick={() =>
            onSave({
              id: existing?.id,
              name: name.trim(),
              owner: owner.trim(),
              scope,
              quota_per_day: quota,
              enabled,
            })
          }
        >
          {existing ? 'Save the key' : 'Mint it'}
        </button>
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
