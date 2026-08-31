import { describe, expect, it } from 'vitest'

import {
  addFilter,
  cellOpsFor,
  bodyOf,
  cellPredicate,
  clearOrder,
  cycleOrder,
  dropColumn,
  fromRef,
  groupTerms,
  isDistinct,
  orderTerms,
  removeGroupTerm,
  removeOrderTerm,
  removeTerm,
  rewritable,
  selectItems,
  setLimit,
  setSelectList,
  shapeOf,
  untouched,
  whereTerms,
} from './rewrite'
import { literal } from './query'

const ONE_LINE = 'SELECT a, b FROM db.t WHERE a > 1 ORDER BY b DESC LIMIT 100'
const MULTI = `SELECT ts, host, ms
FROM logs
WHERE ts >= now() - INTERVAL 3 HOUR
ORDER BY ts DESC
LIMIT 500`

describe('shapeOf', () => {
  it('finds the clauses of a one-line select', () => {
    const shape = shapeOf(ONE_LINE)
    expect(shape.isSelect).toBe(true)
    expect(rewritable(shape)).toBe(true)
    expect(bodyOf(shape, 'select')).toBe('a, b')
    expect(bodyOf(shape, 'from')).toBe('db.t')
    expect(bodyOf(shape, 'where')).toBe('a > 1')
    expect(bodyOf(shape, 'orderBy')).toBe('b DESC')
    expect(bodyOf(shape, 'limit')).toBe('100')
  })

  it('ignores clause keywords inside a subquery', () => {
    const shape = shapeOf('SELECT a FROM t WHERE id IN (SELECT id FROM other WHERE x ORDER BY y)')
    expect(bodyOf(shape, 'where')).toBe('id IN (SELECT id FROM other WHERE x ORDER BY y)')
    expect(shape.clauses.orderBy).toBeUndefined()
  })

  it('refuses a compound statement', () => {
    const shape = shapeOf('SELECT a FROM t UNION ALL SELECT b FROM u')
    expect(shape.compound).toBe(true)
    expect(rewritable(shape)).toBe(false)
  })

  it('is not fooled by a select-list EXCEPT', () => {
    const shape = shapeOf('SELECT * EXCEPT (id) FROM t')
    expect(shape.compound).toBe(false)
    expect(rewritable(shape)).toBe(true)
  })

  it('refuses anything that is not a select', () => {
    expect(rewritable(shapeOf('INSERT INTO t VALUES (1)'))).toBe(false)
    expect(rewritable(shapeOf('SHOW TABLES'))).toBe(false)
    // A SELECT with no FROM has no column to order by either.
    expect(rewritable(shapeOf('SELECT 1'))).toBe(false)
  })

  it('keeps a trailing comment out of the clause it follows', () => {
    const shape = shapeOf('SELECT a FROM t -- why\n')
    expect(bodyOf(shape, 'from')).toBe('t')
  })

  it('reads a WITH statement as a select', () => {
    const shape = shapeOf('WITH x AS (SELECT 1) SELECT * FROM t')
    expect(shape.isSelect).toBe(true)
    expect(bodyOf(shape, 'with')).toBe('x AS (SELECT 1)')
    expect(bodyOf(shape, 'from')).toBe('t')
  })

  it('does not take WITH TOTALS for a clause', () => {
    const shape = shapeOf('SELECT a, count() FROM t GROUP BY a WITH TOTALS ORDER BY a')
    expect(bodyOf(shape, 'groupBy')).toBe('a WITH TOTALS')
    expect(bodyOf(shape, 'orderBy')).toBe('a')
  })
})

describe('fromRef', () => {
  it('reads a qualified and an unqualified name', () => {
    expect(fromRef(shapeOf(ONE_LINE))).toEqual({ database: 'db', table: 't' })
    expect(fromRef(shapeOf(MULTI))).toEqual({ table: 'logs' })
  })

  it('reads a backticked name', () => {
    expect(fromRef(shapeOf('SELECT * FROM `my db`.`odd name`'))).toEqual({
      database: 'my db',
      table: 'odd name',
    })
  })

  it('looks past an alias and a FINAL', () => {
    expect(fromRef(shapeOf('SELECT * FROM t FINAL'))).toEqual({ table: 't' })
    expect(fromRef(shapeOf('SELECT * FROM t AS x'))).toEqual({ table: 't' })
  })

  it('answers null for a subquery, a table function and a join', () => {
    expect(fromRef(shapeOf('SELECT * FROM (SELECT 1)'))).toBeNull()
    expect(fromRef(shapeOf('SELECT * FROM numbers(10)'))).toBeNull()
    expect(fromRef(shapeOf('SELECT * FROM a JOIN b ON a.id = b.id'))).toBeNull()
  })
})

describe('selectItems', () => {
  it('splits the list and names each column', () => {
    const items = selectItems(shapeOf('SELECT a, count() AS n, sum(b) FROM t'))!
    expect(items.map((i) => i.resultName)).toEqual(['a', 'n', 'sum(b)'])
    expect(items[1]!.expr).toBe('count()')
    expect(items[1]!.alias).toBe('n')
  })

  it('splits on top-level commas only', () => {
    const items = selectItems(shapeOf('SELECT if(a, 1, 2) AS f, b FROM t'))!
    expect(items.map((i) => i.text)).toEqual(['if(a, 1, 2) AS f', 'b'])
  })

  it('reads a star as one item', () => {
    const items = selectItems(shapeOf('SELECT * FROM t'))!
    expect(items).toHaveLength(1)
    expect(items[0]!.expr).toBe('*')
  })

  it('keeps DISTINCT out of the first item', () => {
    const items = selectItems(shapeOf('SELECT DISTINCT a, b FROM t'))!
    expect(items.map((i) => i.text)).toEqual(['a', 'b'])
  })

  it('names a column that is spelled like a keyword', () => {
    // Half of `system.query_log` is: `query`, `time`, `type`, `tables`.
    const items = selectItems(shapeOf('SELECT query, time, type FROM system.query_log'))!
    expect(items.map((i) => i.resultName)).toEqual(['query', 'time', 'type'])
  })

  it('drops one of those like any other', () => {
    expect(
      dropColumn('SELECT query, time FROM system.query_log', 'query', ['query', 'time']),
    ).toBe('SELECT time FROM system.query_log')
  })

  it('leaves a literal unnamed', () => {
    expect(selectItems(shapeOf("SELECT 'x' FROM t"))![0]!.resultName).toBeNull()
    expect(selectItems(shapeOf('SELECT 42 FROM t'))![0]!.resultName).toBeNull()
  })

  it('recognises a bare alias but not an operator', () => {
    expect(selectItems(shapeOf('SELECT count() n FROM t'))![0]!.alias).toBe('n')
    expect(selectItems(shapeOf('SELECT a + b FROM t'))![0]!.alias).toBeNull()
    expect(selectItems(shapeOf('SELECT a + b FROM t'))![0]!.resultName).toBeNull()
  })
})

describe('cycleOrder', () => {
  it('walks unsorted, ascending, descending, unsorted', () => {
    const none = 'SELECT a, b FROM t'
    const asc = cycleOrder(none, 'a')
    expect(asc).toBe('SELECT a, b FROM t ORDER BY a')
    const desc = cycleOrder(asc, 'a')
    expect(desc).toBe('SELECT a, b FROM t ORDER BY a DESC')
    expect(cycleOrder(desc, 'a')).toBe('SELECT a, b FROM t')
  })

  it('replaces the order when a different column is clicked', () => {
    expect(cycleOrder('SELECT a, b FROM t ORDER BY a DESC', 'b')).toBe(
      'SELECT a, b FROM t ORDER BY b',
    )
  })

  it('adds a level on a shift-click and drops it on the third', () => {
    const two = cycleOrder('SELECT a, b FROM t ORDER BY a', 'b', true)
    expect(two).toBe('SELECT a, b FROM t ORDER BY a, b')
    const flipped = cycleOrder(two, 'b', true)
    expect(flipped).toBe('SELECT a, b FROM t ORDER BY a, b DESC')
    expect(cycleOrder(flipped, 'b', true)).toBe('SELECT a, b FROM t ORDER BY a')
  })

  it('keeps a modifier it does not understand', () => {
    expect(cycleOrder('SELECT a FROM t ORDER BY a NULLS LAST', 'a', true)).toBe(
      'SELECT a FROM t ORDER BY a DESC NULLS LAST',
    )
  })

  it('puts a new ORDER BY before the LIMIT, on its own line when multi-line', () => {
    expect(cycleOrder('SELECT a FROM t LIMIT 10', 'a')).toBe('SELECT a FROM t ORDER BY a LIMIT 10')
    expect(cycleOrder('SELECT a\nFROM t\nLIMIT 10', 'a')).toBe(
      'SELECT a\nFROM t\nORDER BY a\nLIMIT 10',
    )
  })

  it('puts it after the last clause when there is nothing to precede', () => {
    expect(cycleOrder('SELECT a\nFROM t', 'a')).toBe('SELECT a\nFROM t\nORDER BY a')
  })

  it('leaves a statement it cannot read exactly as it was', () => {
    const union = 'SELECT a FROM t UNION ALL SELECT a FROM u'
    expect(cycleOrder(union, 'a')).toBe(union)
    expect(clearOrder(union)).toBe(union)
    expect(addFilter(union, 'a > 1')).toBe(union)
    expect(setLimit(union, 10)).toBe(union)
  })

  it('quotes nothing itself — the caller hands it the expression', () => {
    expect(cycleOrder('SELECT * FROM t', '`odd name`')).toBe('SELECT * FROM t ORDER BY `odd name`')
  })

  it('matches an existing term through its backticks, and keeps how it was written', () => {
    expect(cycleOrder('SELECT * FROM t ORDER BY `a`', 'a')).toBe(
      'SELECT * FROM t ORDER BY `a` DESC',
    )
  })
})

describe('the GROUP BY', () => {
  it('lists its terms and keeps a modifier out of them', () => {
    const shape = shapeOf('SELECT a, b, count() FROM t GROUP BY a, b WITH TOTALS')
    const { terms, modifier } = groupTerms(shape)
    expect(terms.map((t) => t.text)).toEqual(['a', 'b'])
    expect(modifier).toBe('WITH TOTALS')
  })

  it('removes one term, keeps the modifier, and takes that dimension out of the list', () => {
    expect(
      removeGroupTerm('SELECT a, b, count() FROM t GROUP BY a, b WITH TOTALS', 'a'),
    ).toBe('SELECT b, count() FROM t GROUP BY b WITH TOTALS')
  })

  it('takes the projection with it, because a dimension cannot stay projected', () => {
    expect(
      removeGroupTerm(
        'SELECT type, toStartOfHour(ts) AS hour, count() AS n FROM t GROUP BY type, hour',
        'hour',
      ),
    ).toBe('SELECT type, count() AS n FROM t GROUP BY type')
  })

  it('takes the ORDER BY that named it too', () => {
    expect(
      removeGroupTerm('SELECT a, count() AS n FROM t GROUP BY a ORDER BY a, n DESC', 'a'),
    ).toBe('SELECT count() AS n FROM t ORDER BY n DESC')
  })

  it('refuses when the projection is all there is', () => {
    const sql = 'SELECT a FROM t GROUP BY a'
    expect(removeGroupTerm(sql, 'a')).toBe(sql)
  })

  it('removes the clause with the last term', () => {
    expect(removeGroupTerm('SELECT count() FROM t GROUP BY a ORDER BY count()', 'a')).toBe(
      'SELECT count() FROM t ORDER BY count()',
    )
  })

  it('does nothing for a term that is not there', () => {
    expect(removeGroupTerm('SELECT a FROM t GROUP BY a', 'zz')).toBe(
      'SELECT a FROM t GROUP BY a',
    )
  })
})

describe('what the strip must admit to', () => {
  it('sees a DISTINCT', () => {
    expect(isDistinct(shapeOf('SELECT DISTINCT a FROM t'))).toBe(true)
    expect(isDistinct(shapeOf('SELECT a FROM t'))).toBe(false)
  })

  it('names the clauses it will not touch', () => {
    const shape = shapeOf(
      'WITH x AS (SELECT 1) SELECT a FROM t LIMIT 10 OFFSET 5 SETTINGS max_threads = 4',
    )
    expect(untouched(shape)).toEqual(['with', 'offset', 'settings'])
    expect(untouched(shapeOf('SELECT a FROM t'))).toEqual([])
  })
})

describe('removeOrderTerm', () => {
  it('takes one term out and leaves the others in order', () => {
    expect(removeOrderTerm('SELECT * FROM t ORDER BY a, b DESC, c', 'b')).toBe(
      'SELECT * FROM t ORDER BY a, c',
    )
  })

  it('removes the clause with the last term', () => {
    expect(removeOrderTerm('SELECT * FROM t ORDER BY a LIMIT 5', 'a')).toBe(
      'SELECT * FROM t LIMIT 5',
    )
  })

  it('does nothing for a term that is not there', () => {
    expect(removeOrderTerm('SELECT * FROM t ORDER BY a', 'zz')).toBe('SELECT * FROM t ORDER BY a')
  })
})

describe('addFilter', () => {
  it('writes a WHERE where there was none, before the GROUP BY', () => {
    expect(addFilter('SELECT a, count() FROM t GROUP BY a', "a = 'x'")).toBe(
      "SELECT a, count() FROM t WHERE a = 'x' GROUP BY a",
    )
  })

  it('ANDs into an existing WHERE', () => {
    expect(addFilter('SELECT * FROM t WHERE a > 1', 'b < 2')).toBe(
      'SELECT * FROM t WHERE a > 1 AND b < 2',
    )
  })

  it('brackets an existing OR, because a > 1 OR b AND c is not what was meant', () => {
    expect(addFilter('SELECT * FROM t WHERE a = 1 OR b = 2', 'c = 3')).toBe(
      'SELECT * FROM t WHERE (a = 1 OR b = 2) AND c = 3',
    )
  })

  it('lands on its own line in a multi-line statement', () => {
    expect(addFilter(MULTI, "host = 'a'")).toBe(`SELECT ts, host, ms
FROM logs
WHERE ts >= now() - INTERVAL 3 HOUR AND host = 'a'
ORDER BY ts DESC
LIMIT 500`)
    expect(addFilter('SELECT *\nFROM logs\nLIMIT 10', "host = 'a'")).toBe(
      "SELECT *\nFROM logs\nWHERE host = 'a'\nLIMIT 10",
    )
  })
})

describe('whereTerms and removeTerm', () => {
  it('lists the conjuncts', () => {
    const shape = shapeOf("SELECT * FROM t WHERE a > 1 AND b = 'x' AND c IS NULL")
    expect(whereTerms(shape).map((t) => t.text)).toEqual(['a > 1', "b = 'x'", 'c IS NULL'])
  })

  it('does not split across a top-level OR', () => {
    const shape = shapeOf('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3')
    expect(whereTerms(shape).map((t) => t.text)).toEqual(['a = 1 OR b = 2 AND c = 3'])
  })

  it('splits around an OR that is bracketed', () => {
    const shape = shapeOf('SELECT * FROM t WHERE (a = 1 OR b = 2) AND c = 3')
    expect(whereTerms(shape).map((t) => t.text)).toEqual(['(a = 1 OR b = 2)', 'c = 3'])
  })

  it('removes one and keeps the rest', () => {
    const sql = "SELECT * FROM t WHERE a > 1 AND b = 'x' ORDER BY a"
    const terms = whereTerms(shapeOf(sql))
    expect(removeTerm(sql, terms[0]!)).toBe("SELECT * FROM t WHERE b = 'x' ORDER BY a")
  })

  it('removes the clause with the last term', () => {
    const sql = 'SELECT *\nFROM t\nWHERE a > 1\nORDER BY a'
    const terms = whereTerms(shapeOf(sql))
    expect(removeTerm(sql, terms[0]!)).toBe('SELECT *\nFROM t\nORDER BY a')
  })
})

describe('pruning what a dropped column left behind', () => {
  it('drops an ORDER BY that named it', () => {
    expect(dropColumn('SELECT a, b FROM t ORDER BY b', 'b', ['a', 'b'])).toBe(
      'SELECT a FROM t',
    )
  })

  it('drops a HAVING that mentions it', () => {
    expect(
      dropColumn('SELECT a, count() AS n FROM t GROUP BY a HAVING n > 1', 'n', ['a', 'n']),
    ).toBe('SELECT a FROM t GROUP BY a')
  })

  it('leaves the WHERE alone — it filters before the projection', () => {
    expect(dropColumn('SELECT a, b FROM t WHERE b > 1', 'b', ['a', 'b'])).toBe(
      'SELECT a FROM t WHERE b > 1',
    )
  })

  it('is not fooled by a name inside another word or a literal', () => {
    expect(dropColumn("SELECT a, n FROM t ORDER BY now(), a WHERE a = 'n'", 'n', ['a', 'n'])).toContain(
      'now()',
    )
  })
})

describe('the select list and the limit', () => {
  it('narrows a star using the columns the result came back with', () => {
    expect(dropColumn('SELECT * FROM t LIMIT 5', 'b', ['a', 'b', 'c'])).toBe(
      'SELECT a, c FROM t LIMIT 5',
    )
  })

  it('drops a named column and leaves the others as written', () => {
    expect(dropColumn('SELECT a, count() AS n FROM t GROUP BY a', 'n', ['a', 'n'])).toBe(
      'SELECT a FROM t GROUP BY a',
    )
  })

  it('refuses to empty the list', () => {
    expect(dropColumn('SELECT a FROM t', 'a', ['a'])).toBe('SELECT a FROM t')
    expect(dropColumn('SELECT * FROM t', 'a', ['a'])).toBe('SELECT * FROM t')
  })

  it('does nothing for a column that is not in the list', () => {
    expect(dropColumn('SELECT a, b FROM t', 'zz', ['a', 'b'])).toBe('SELECT a, b FROM t')
  })

  it('keeps a DISTINCT', () => {
    expect(setSelectList('SELECT DISTINCT a, b FROM t', ['a'])).toBe('SELECT DISTINCT a FROM t')
  })

  it('sets, adds and removes a limit', () => {
    expect(setLimit('SELECT * FROM t LIMIT 100', 10)).toBe('SELECT * FROM t LIMIT 10')
    expect(setLimit('SELECT * FROM t', 10)).toBe('SELECT * FROM t LIMIT 10')
    expect(setLimit('SELECT * FROM t LIMIT 100', 0)).toBe('SELECT * FROM t')
  })

  it('leaves LIMIT n BY alone', () => {
    const sql = 'SELECT * FROM t LIMIT 1 BY host'
    expect(setLimit(sql, 10)).toBe(sql)
  })

  it('puts a limit last, after the settings it must not precede', () => {
    expect(setLimit('SELECT * FROM t SETTINGS max_threads = 4', 10)).toBe(
      'SELECT * FROM t LIMIT 10 SETTINGS max_threads = 4',
    )
  })
})

describe('orderTerms', () => {
  it('reads direction and keeps the tail', () => {
    const terms = orderTerms(shapeOf('SELECT * FROM t ORDER BY a DESC, b, c ASC NULLS LAST'))
    expect(terms).toEqual([
      { expr: 'a', desc: true, tail: '' },
      { expr: 'b', desc: false, tail: '' },
      { expr: 'c', desc: false, tail: 'NULLS LAST' },
    ])
  })

  it('is not confused by a function call', () => {
    const terms = orderTerms(shapeOf('SELECT * FROM t ORDER BY toStartOfHour(ts) DESC'))
    expect(terms).toEqual([{ expr: 'toStartOfHour(ts)', desc: true, tail: '' }])
  })
})

describe('cellOpsFor', () => {
  it('offers ordering to a number and a time, and containment to a string', () => {
    expect(cellOpsFor('UInt64')).toContain('>=')
    expect(cellOpsFor('DateTime')).toContain('<')
    expect(cellOpsFor('String')).toContain('like')
    expect(cellOpsFor('String')).not.toContain('>=')
    expect(cellOpsFor('Array(String)')).toEqual(['=', '!=', 'isNull', 'isNotNull'])
  })
})

describe('cellPredicate', () => {
  it('encodes through the column type, not the value shape', () => {
    expect(cellPredicate('a', 'String', '=', '12', literal)).toBe("a = '12'")
    expect(cellPredicate('a', 'UInt64', '=', '12', literal)).toBe('a = 12')
    expect(cellPredicate('a', 'String', '=', "'; DROP", literal)).toBe("a = '\\'; DROP'")
  })

  it('reads an empty cell as the null it is', () => {
    expect(cellPredicate('a', 'String', '=', null, literal)).toBe('a IS NULL')
    expect(cellPredicate('a', 'String', '!=', null, literal)).toBe('a IS NOT NULL')
    expect(cellPredicate('a', 'String', '>', null, literal)).toBeNull()
  })

  it('wraps a contains in wildcards', () => {
    expect(cellPredicate('a', 'String', 'like', 'x', literal)).toBe("a LIKE '%x%'")
  })

  it('quotes an identifier that needs it', () => {
    expect(cellPredicate('odd name', 'String', '=', 'x', literal)).toBe("`odd name` = 'x'")
  })
})
