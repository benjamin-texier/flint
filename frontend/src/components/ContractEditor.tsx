import { useMemo } from 'react'

import {
  parseContract,
  quoted,
  unkeepablePromises,
  type Contract,
  type ParamRule,
} from '../lib/publish'

/** The promises a revision makes, as something a person can type.
 *
 *  The whole feature turns on this form being *narrower* than free JSON. A
 *  contract is what a caller is pinned to and what the OpenAPI document
 *  promises, so a field here that accepts anything is a field that will
 *  eventually promise something Flint cannot keep — and the caller finds out
 *  by getting a 400 from an endpoint whose own document said the call was
 *  fine.
 *
 *  So every rule here hangs off a parameter the statement actually declares.
 *  There is no way to write a rule for `regoin`, because the list of rows is
 *  the list of placeholders and nothing else. */
export function ContractEditor({
  raw,
  onChange,
  params,
  columns,
  disabled,
}: {
  /** The stored JSON. Unparseable reads as empty — the same rule the server
   *  follows, because a form that refused to open over bad JSON would hide the
   *  very contract somebody needs to go and fix. */
  raw: string
  onChange: (raw: string) => void
  /** The placeholders the statement declares, with their ClickHouse types. A
   *  rule can only ever be written against one of these. */
  params: { name: string; type: string }[]
  /** What the statement returns, where Flint could describe it. Empty means it
   *  could not, and the column controls say so rather than offering an
   *  allow-list built from nothing. */
  columns: string[]
  disabled?: boolean
}) {
  const contract = useMemo(() => parseContract(raw), [raw])
  const stale = useMemo(() => unkeepablePromises(contract, columns), [contract, columns])

  const emit = (next: Contract) => {
    // An empty contract is written as an empty string rather than as `{}`,
    // because empty is the state that means "promises only what the
    // placeholders say" everywhere else — and two spellings of the same state
    // is one spelling too many.
    const bare =
      next.params.length === 0 &&
      !next.columns.only?.length &&
      !next.columns.never?.length &&
      next.order_by.length === 0 &&
      next.max_limit === undefined
    onChange(bare ? '' : JSON.stringify(next))
  }

  const setRule = (name: string, patch: Partial<ParamRule>) => {
    const rest = contract.params.filter((r) => r.name !== name)
    const current = contract.params.find((r) => r.name === name) ?? { name }
    const merged: ParamRule = { ...current, ...patch }
    // A rule whose every field is empty is not a rule. Dropping it keeps the
    // stored JSON honest: what is in there is what is promised.
    const empty =
      !merged.min &&
      !merged.max &&
      !merged.one_of?.length &&
      !merged.window_days &&
      !merged.note
    emit({
      ...contract,
      params: empty
        ? rest
        : [...rest, merged].sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  const list = (value: string): string[] =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)

  return (
    <section className="ctr" aria-label="What a caller may change">
      <div className="ctr__head">
        <span className="label">WHAT A CALLER MAY CHANGE</span>
        <span className="mono-dim">values, exposed columns, sort — nothing else</span>
      </div>

      {params.length === 0 ? (
        <p className="ctr__none">
          This statement declares no parameters, so there are no values to constrain. The column
          and sort rules below still apply.
        </p>
      ) : (
        <ul className="ctr__rules">
          {params.map(({ name, type }) => {
            const rule = contract.params.find((r) => r.name === name)
            /* A date floor is written as a date and a number floor as a
               number, and the placeholder says which — the field itself
               cannot, because ClickHouse's type is the only thing that
               knows and it is right there in the next column. */
            const dateish = /Date/.test(type)
            return (
              <li className="ctr__rule" key={name}>
                <code className="ctr__name">{name}</code>
                <span className="ctr__type">{type}</span>
                <label className="ctr__field">
                  <span className="label">NO EARLIER THAN</span>
                  <input
                    className="input"
                    value={rule?.min ?? ''}
                    disabled={disabled}
                    onChange={(e) => setRule(name, { min: e.target.value })}
                    placeholder={dateish ? '2024-01-01' : 'no floor'}
                  />
                </label>
                <label className="ctr__field">
                  <span className="label">NO LATER THAN</span>
                  <input
                    className="input"
                    value={rule?.max ?? ''}
                    disabled={disabled}
                    onChange={(e) => setRule(name, { max: e.target.value })}
                    placeholder={dateish ? '2030-12-31' : 'no ceiling'}
                  />
                </label>
                <label className="ctr__field">
                  <span className="label">ONE OF</span>
                  <input
                    className="input"
                    value={rule?.one_of?.join(', ') ?? ''}
                    disabled={disabled}
                    onChange={(e) => setRule(name, { one_of: list(e.target.value) })}
                    placeholder="anything the type accepts"
                  />
                </label>
                <label className="ctr__field ctr__field--pair">
                  <span className="label">WINDOW TO</span>
                  <select
                    className="input"
                    value={rule?.window_to ?? ''}
                    disabled={disabled}
                    onChange={(e) => setRule(name, { window_to: e.target.value })}
                  >
                    <option value="">not a window</option>
                    {params
                      .filter((p) => p.name !== name)
                      .map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="ctr__field ctr__field--tiny">
                  <span className="label">DAYS</span>
                  <input
                    className="input"
                    value={rule?.window_days ?? ''}
                    disabled={disabled || !rule?.window_to}
                    onChange={(e) =>
                      setRule(name, { window_days: Number(e.target.value) || undefined })
                    }
                    inputMode="numeric"
                    placeholder="90"
                  />
                </label>
                <label className="ctr__field ctr__field--wide">
                  <span className="label">AND SAY</span>
                  <input
                    className="input"
                    value={rule?.note ?? ''}
                    disabled={disabled}
                    onChange={(e) => setRule(name, { note: e.target.value })}
                    placeholder="a sentence the rules above cannot express"
                  />
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {/* One list, shared by the three column fields. A datalist rather than a
          select: every one of these takes several names, and the fields have
          to keep working when Flint has not been asked what the statement
          returns. */}
      {columns.length ? (
        <datalist id="ctr-columns">
          {columns.map((name) => (
            <option value={name} key={name} />
          ))}
        </datalist>
      ) : null}

      <div className="ctr__cols">
        <label className="ctr__field ctr__field--wide">
          <span className="label">ONLY THESE COLUMNS LEAVE</span>
          <input
            className="input"
            value={contract.columns.only?.join(', ') ?? ''}
            disabled={disabled}
            onChange={(e) =>
              emit({ ...contract, columns: { ...contract.columns, only: list(e.target.value) } })
            }
            placeholder={
              columns.length ? `every one of the ${columns.length} it returns` : 'every column'
            }
            list={columns.length ? 'ctr-columns' : undefined}
          />
        </label>
        <label className="ctr__field ctr__field--wide">
          <span className="label">AND THESE NEVER DO</span>
          <input
            className="input"
            value={contract.columns.never?.join(', ') ?? ''}
            disabled={disabled}
            onChange={(e) =>
              emit({ ...contract, columns: { ...contract.columns, never: list(e.target.value) } })
            }
            placeholder={columns[columns.length - 1] ?? 'device_id'}
            list={columns.length ? 'ctr-columns' : undefined}
          />
        </label>
        <label className="ctr__field ctr__field--wide">
          <span className="label">SORTABLE BY</span>
          <input
            className="input"
            value={contract.order_by.join(', ')}
            disabled={disabled}
            onChange={(e) => emit({ ...contract, order_by: list(e.target.value) })}
            placeholder="sorting is not offered"
            list={columns.length ? 'ctr-columns' : undefined}
          />
        </label>
        <label className="ctr__field ctr__field--tiny">
          <span className="label">MAX LIMIT</span>
          <input
            className="input"
            value={contract.max_limit ?? ''}
            disabled={disabled}
            onChange={(e) =>
              emit({ ...contract, max_limit: Number(e.target.value) || undefined })
            }
            inputMode="numeric"
            placeholder="the row cap"
          />
        </label>
      </div>

      {stale.offered.length ? (
        <p className="says says--watch says--wide">
          This statement does not return {quoted(stale.offered)}, so the endpoint would be
          offering something it cannot produce: the document and the tool definition drop it, the
          page shows it, and a caller who asks for it by name gets an error about an unknown
          identifier.
        </p>
      ) : null}
      {stale.guarding.length ? (
        <p className="says says--watch says--wide">
          {quoted(stale.guarding)} {stale.guarding.length === 1 ? 'is' : 'are'} kept in by the
          deny-list and {stale.guarding.length === 1 ? 'is' : 'are'} not among the columns this
          statement returns, so {stale.guarding.length === 1 ? 'it guards' : 'they guard'} nothing.
          Harmless on its own — and almost never what somebody meant. Check the spelling against
          the list below: a rule written for a name that does not exist leaves the column it was
          meant to keep inside leaving on every call.
        </p>
      ) : null}

      <p className="ctr__foot">
        A value outside a rule is <strong>refused</strong>, with the rule in the sentence — it is
        never quietly narrowed. A column that does not leave is refused <em>by name</em> rather
        than dropped from the answer, because a caller who asked for it and got a page without it
        would conclude the column is empty.
        {columns.length === 0 ? (
          <>
            {' '}
            Nobody has asked what this statement returns yet, so the column names above are yours
            to type. Run the check below and this will know them — and will say so if one of these
            is not among them.
          </>
        ) : (
          <>
            {' '}
            It returns{' '}
            {columns.map((name, at) => (
              <span key={name}>
                {at > 0 ? ', ' : ''}
                <code>{name}</code>
              </span>
            ))}
            .
          </>
        )}
      </p>
    </section>
  )
}
