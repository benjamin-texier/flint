import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import type { AccessReport } from '../lib/access'
import {
  costOfDropping,
  grantableRoles,
  grantedOn,
  heldRoles,
  saysCost,
  scopeProblem,
  whyUnmanageable,
  type Grantee,
} from '../lib/rbac'

/** One panel open at a time.
 *
 *  Four controls in one cell wrapped to three lines the last time this shape was
 *  built, and two groups of controls beside each other turned a 33px row into a
 *  113px one. One strip, one mode. */
type Mode = null | 'password' | 'drop' | 'grant' | 'role' | 'when' | 'where' | 'defaults'

/** Change what an account may do.
 *
 *  Every button here is one statement with no options, and the statement is
 *  recorded in the job list beside a sentence saying what it was — because "what
 *  did that button actually run" is the first question anybody asks of a tool
 *  that grants privileges on their behalf.
 *
 *  Nothing is drawn for an account SQL cannot write. The reason is drawn
 *  instead, naming the storage, because "defined in users.xml" tells somebody
 *  where to go and "cannot be changed" leaves them clicking. */
export function Manage({
  subject,
  storage,
  report,
}: {
  subject: Grantee
  storage: string
  report: AccessReport
}) {
  const [mode, setMode] = useState<Mode>(null)
  const why = whyUnmanageable(storage)
  if (why) return <span className="says">{why}</span>

  const close = () => setMode(null)
  return (
    <>
      <span className="rbac__strip">
        <Toggle mode="role" open={mode} set={setMode}>
          Roles
        </Toggle>
        <Toggle mode="grant" open={mode} set={setMode}>
          Privileges
        </Toggle>
        {subject.is_user ? (
          <>
            <Toggle mode="password" open={mode} set={setMode}>
              Password
            </Toggle>
            <Toggle mode="when" open={mode} set={setMode}>
              Expiry
            </Toggle>
            <Toggle mode="where" open={mode} set={setMode}>
              Hosts
            </Toggle>
            <Toggle mode="defaults" open={mode} set={setMode}>
              Default roles
            </Toggle>
          </>
        ) : null}
        <Toggle mode="drop" open={mode} set={setMode}>
          Drop
        </Toggle>
      </span>
      {mode === 'role' ? <Roles subject={subject} report={report} done={close} /> : null}
      {mode === 'grant' ? <Privileges subject={subject} report={report} done={close} /> : null}
      {mode === 'password' ? <Password subject={subject} done={close} /> : null}
      {mode === 'when' ? <Expiry subject={subject} done={close} /> : null}
      {mode === 'where' ? <Hosts subject={subject} done={close} /> : null}
      {mode === 'defaults' ? (
        <Defaults subject={subject} report={report} done={close} />
      ) : null}
      {mode === 'drop' ? <Drop subject={subject} report={report} done={close} /> : null}
    </>
  )
}

function Toggle({
  mode,
  open,
  set,
  children,
}: {
  mode: Exclude<Mode, null>
  open: Mode
  set: (m: Mode) => void
  children: React.ReactNode
}) {
  const on = open === mode
  return (
    <button
      className={`btn${on ? ' is-on' : ''}`}
      aria-expanded={on}
      onClick={() => set(on ? null : mode)}
    >
      {children}
    </button>
  )
}

/** Every change goes through one mutation, so every one reports the server's
 *  refusal the same way — and the same set of queries goes stale afterwards. */
function useChange(done: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change: Record<string, unknown>) => api.accessAct(change),
    onSuccess: () => {
      // The access lists, and the job list the statement was recorded in.
      queryClient.invalidateQueries({ queryKey: ['access'] })
      queryClient.invalidateQueries({ queryKey: ['limits'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      done()
    },
  })
}

function Refusal({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="says says--throw">
      {error instanceof Error ? error.message : 'the server refused it'}
    </p>
  )
}

function Roles({
  subject,
  report,
  done,
}: {
  subject: Grantee
  report: AccessReport
  done: () => void
}) {
  const act = useChange(done)
  const grantable = grantableRoles(report, subject)
  const held = heldRoles(report, subject)
  const [role, setRole] = useState('')

  return (
    <div className="rbac__panel">
      {grantable.length ? (
        <form
          className="rbac__row"
          onSubmit={(e) => {
            e.preventDefault()
            if (role) act.mutate({ action: 'grant-role', role, to: subject })
          }}
        >
          <label className="rbac__field">
            <span className="label">GIVE IT A ROLE</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">choose one</option>
              {grantable.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" disabled={!role || act.isPending}>
            Grant
          </button>
        </form>
      ) : (
        /* Offering a role somebody already holds produces a statement the server
           accepts and that changes nothing, which reads as a broken button. */
        <p className="says">
          {report.roles.length
            ? 'It already holds every role there is.'
            : 'No roles are defined yet.'}
        </p>
      )}

      {held.length ? (
        <p className="rbac__row">
          <span className="label">HOLDS</span>
          {held.map((r) => (
            <span className="rbac__chip" key={r}>
              {r}
              <button
                className="btn"
                disabled={act.isPending}
                onClick={() => act.mutate({ action: 'revoke-role', role: r, to: subject })}
              >
                revoke
              </button>
            </span>
          ))}
        </p>
      ) : null}
      <Refusal error={act.error} />
    </div>
  )
}

function Privileges({
  subject,
  report,
  done,
}: {
  subject: Grantee
  report: AccessReport
  done: () => void
}) {
  const act = useChange(done)
  const [access, setAccess] = useState('SELECT')
  const [database, setDatabase] = useState('')
  const [table, setTable] = useState('*')
  const problem = scopeProblem(database, table)
  const already = problem ? [] : grantedOn(report, subject, database, table)

  const send = (action: 'grant' | 'revoke', one = access) =>
    act.mutate({ action, access: [one], database, table, to: subject })

  return (
    <div className="rbac__panel">
      <form
        className="rbac__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!problem) send('grant')
        }}
      >
        <label className="rbac__field">
          <span className="label">PRIVILEGE</span>
          {/* A native datalist rather than a combobox: 241 privileges filter as
              you type, the keyboard behaviour is the browser's, and free text
              still reaches the server — which is what validates it, against its
              own list rather than one written here. */}
          <input
            list="flint-privileges"
            value={access}
            onChange={(e) => setAccess(e.target.value.toUpperCase())}
            spellCheck={false}
          />
          <datalist id="flint-privileges">
            {report.privileges.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label className="rbac__field">
          <span className="label">ON DATABASE</span>
          <input
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="* for every one"
            spellCheck={false}
          />
        </label>
        <label className="rbac__field">
          <span className="label">TABLE</span>
          <input value={table} onChange={(e) => setTable(e.target.value)} spellCheck={false} />
        </label>
        <button className="btn" disabled={!!problem || !access || act.isPending}>
          Grant
        </button>
      </form>
      {problem ? <p className="says">{problem}</p> : null}
      {already.length ? (
        <p className="rbac__row">
          <span className="label">ALREADY THERE</span>
          {already.map((one) => (
            <span className="rbac__chip" key={one}>
              {one}
              <button
                className="btn"
                disabled={act.isPending}
                onClick={() => send('revoke', one)}
              >
                revoke
              </button>
            </span>
          ))}
        </p>
      ) : null}
      <Refusal error={act.error} />
    </div>
  )
}

function Password({ subject, done }: { subject: Grantee; done: () => void }) {
  const act = useChange(done)
  const [password, setPassword] = useState('')

  return (
    <div className="rbac__panel">
      <form
        className="rbac__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (password) act.mutate({ action: 'set-password', user: subject.name, password })
        }}
      >
        <label className="rbac__field">
          <span className="label">NEW PASSWORD</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <button className="btn" disabled={!password || act.isPending}>
          Set it
        </button>
      </form>
      {/* Said before the button rather than discovered afterwards. The password
          reaches ClickHouse in the text of a statement — there is no other way,
          the protocol has no parameter for it — and ClickHouse hashes it on
          arrival, so `sha256_password` is what Flint always sends. */}
      <p className="says">
        It travels in the statement, which is the only way ClickHouse takes one, and is stored
        hashed. Flint records the statement without it.
      </p>
      <Refusal error={act.error} />
    </div>
  )
}

function Drop({
  subject,
  report,
  done,
}: {
  subject: Grantee
  report: AccessReport
  done: () => void
}) {
  const act = useChange(done)
  const cost = costOfDropping(report, subject)

  return (
    <div className="rbac__panel">
      {/* The cost is the decision. A drop button with nothing beside it hides
          what it takes away until afterwards. */}
      <p>
        Drop {subject.is_user ? 'user' : 'role'} <strong>{subject.name}</strong>? {saysCost(cost)}
        {cost.heldBy.length ? ` They are ${cost.heldBy.join(', ')}.` : ''}
      </p>
      <p className="rbac__row">
        <button
          className="btn"
          disabled={act.isPending}
          onClick={() =>
            act.mutate(
              subject.is_user
                ? { action: 'drop-user', user: subject.name }
                : { action: 'drop-role', role: subject.name },
            )
          }
        >
          {act.isPending ? 'Dropping…' : 'Drop it'}
        </button>
        <button className="btn" onClick={done}>
          Keep it
        </button>
      </p>
      <Refusal error={act.error} />
    </div>
  )
}

/** Make an account or a role.
 *
 *  At the top of the page rather than beside a list, because it belongs to
 *  neither list — and both statements are short enough that the form is the
 *  whole of it. */
export function Create() {
  const [mode, setMode] = useState<'user' | 'role' | null>(null)
  const act = useChange(() => setMode(null))
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')

  return (
    <div className="rbac__create">
      <span className="rbac__strip">
        <button
          className={`btn${mode === 'user' ? ' is-on' : ''}`}
          aria-expanded={mode === 'user'}
          onClick={() => setMode(mode === 'user' ? null : 'user')}
        >
          New user
        </button>
        <button
          className={`btn${mode === 'role' ? ' is-on' : ''}`}
          aria-expanded={mode === 'role'}
          onClick={() => setMode(mode === 'role' ? null : 'role')}
        >
          New role
        </button>
      </span>
      {mode ? (
        <div className="rbac__panel">
          <form
            className="rbac__row"
            onSubmit={(e) => {
              e.preventDefault()
              if (mode === 'user') {
                act.mutate({ action: 'create-user', user: name, password })
              } else {
                act.mutate({ action: 'create-role', role: name })
              }
            }}
          >
            <label className="rbac__field">
              <span className="label">NAME</span>
              <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            </label>
            {mode === 'user' ? (
              <label className="rbac__field">
                <span className="label">PASSWORD</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            ) : null}
            <button
              className="btn"
              disabled={!name.trim() || (mode === 'user' && !password) || act.isPending}
            >
              Create it
            </button>
          </form>
          {mode === 'user' ? (
            /* A user with no password is one anybody who knows the name can
               connect as, and the read side of this page flags exactly that as a
               problem — so Flint will not create one. */
            <p className="says">
              A password is required. Flint will not make an account anybody who knows its name
              can connect as, and it grants the new account nothing — until it holds a role or a
              privilege it can log in and see an empty server.
            </p>
          ) : null}
          <Refusal error={act.error} />
        </div>
      ) : null}
    </div>
  )
}

/** When the account stops working.
 *
 *  The warning is the point. A date in the past stops it *now*, and the server
 *  reports that as `AUTHENTICATION_FAILED` — so somebody whose account expired is
 *  told their password is wrong. `infinity` is the server's own word for never,
 *  and it stores that as the epoch, which is why the list above shows no expiry
 *  rather than a date in 1970. */
function Expiry({ subject, done }: { subject: Grantee; done: () => void }) {
  const act = useChange(done)
  const [until, setUntil] = useState('')

  return (
    <div className="rbac__panel">
      <form
        className="rbac__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (until.trim()) {
            act.mutate({ action: 'set-valid-until', user: subject.name, until: until.trim() })
          }
        }}
      >
        <label className="rbac__field">
          <span className="label">STOPS WORKING AFTER</span>
          <input
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            placeholder="2027-01-01, or infinity"
            spellCheck={false}
          />
        </label>
        <button className="btn" disabled={!until.trim() || act.isPending}>
          Set it
        </button>
        <button
          className="btn"
          type="button"
          disabled={act.isPending}
          onClick={() =>
            act.mutate({ action: 'set-valid-until', user: subject.name, until: 'infinity' })
          }
        >
          No expiry
        </button>
      </form>
      <p className="says">
        A date already past stops the account immediately, and the server reports that as a wrong
        password rather than an expiry — which is why it is worth setting deliberately.
      </p>
      <Refusal error={act.error} />
    </div>
  )
}

/** Where the account may connect from.
 *
 *  Addresses and names are separate clauses in the statement, so they are
 *  separate fields here: guessing which one a string is would sometimes guess
 *  wrong, and the server would refuse a host somebody spelled correctly. */
function Hosts({ subject, done }: { subject: Grantee; done: () => void }) {
  const act = useChange(done)
  const [ips, setIps] = useState('')
  const [names, setNames] = useState('')
  const list = (t: string) =>
    t
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  const any = !list(ips).length && !list(names).length

  return (
    <div className="rbac__panel">
      <form
        className="rbac__row"
        onSubmit={(e) => {
          e.preventDefault()
          act.mutate({
            action: 'set-hosts',
            user: subject.name,
            ips: list(ips),
            names: list(names),
          })
        }}
      >
        <label className="rbac__field">
          <span className="label">ADDRESSES OR RANGES</span>
          <input
            value={ips}
            onChange={(e) => setIps(e.target.value)}
            placeholder="10.0.0.0/8"
            spellCheck={false}
          />
        </label>
        <label className="rbac__field">
          <span className="label">HOST NAMES</span>
          <input
            value={names}
            onChange={(e) => setNames(e.target.value)}
            placeholder="reports.corp"
            spellCheck={false}
          />
        </label>
        <button className="btn" disabled={act.isPending}>
          {any ? 'Allow anywhere' : 'Restrict it'}
        </button>
      </form>
      {/* Empty is not "no change": it is `HOST ANY`, which widens. Said, because
          an empty form that does something is worse than one that does nothing. */}
      <p className="says">
        {any
          ? 'Both fields empty means HOST ANY — it will be allowed to connect from anywhere.'
          : 'It will be able to connect from these and nowhere else. The server reports being locked out this way as a wrong password.'}
      </p>
      <Refusal error={act.error} />
    </div>
  )
}

/** Which of the account's roles are active without a `SET ROLE`.
 *
 *  The one that surprises: `NONE` leaves every granted role in place and inert.
 *  A user holding a role that grants a read loses the read entirely, with "Not
 *  enough privileges" and the grant still visible in the list above — so the
 *  panel says it rather than leaving it to be discovered. */
function Defaults({
  subject,
  report,
  done,
}: {
  subject: Grantee
  report: AccessReport
  done: () => void
}) {
  const act = useChange(done)
  const held = heldRoles(report, subject)
  const [chosen, setChosen] = useState<string[]>([])

  return (
    <div className="rbac__panel">
      {held.length ? (
        <>
          <p className="rbac__row">
            <span className="label">ACTIVE BY DEFAULT</span>
            {held.map((r) => (
              <label className="rbac__check" key={r}>
                <input
                  type="checkbox"
                  checked={chosen.includes(r)}
                  onChange={(e) =>
                    setChosen(e.target.checked ? [...chosen, r] : chosen.filter((x) => x !== r))
                  }
                />
                <span>{r}</span>
              </label>
            ))}
          </p>
          <p className="rbac__row">
            <button
              className="btn"
              disabled={act.isPending}
              onClick={() =>
                act.mutate({ action: 'set-default-roles', user: subject.name, all: true })
              }
            >
              All of them
            </button>
            <button
              className="btn"
              disabled={act.isPending}
              onClick={() =>
                act.mutate({
                  action: 'set-default-roles',
                  user: subject.name,
                  all: false,
                  roles: chosen,
                })
              }
            >
              {chosen.length ? `Just these ${chosen.length}` : 'None of them'}
            </button>
          </p>
          <p className="says">
            None does not revoke anything. The roles stay granted and go inert: the account keeps
            them in the list above and cannot use them until it sets one per session.
          </p>
        </>
      ) : (
        <p className="says">It holds no roles, so there is nothing to make active.</p>
      )}
      <Refusal error={act.error} />
    </div>
  )
}
