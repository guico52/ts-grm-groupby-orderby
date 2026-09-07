# [BUG] - `orderBy(...)` after `groupBy(...)` emits invalid SQL: the `order by` clause is rendered *before* `group by`, so PostgreSQL fails with `syntax error at or near "group"`

> Suggested label: `bug`.

---

### ts-grm Version

`@ts-grm/core` 0.0.12 / `@ts-grm/sql` 0.0.12 (npm latest) — also reproduced on local `main`
(HEAD `c7bbc06`, verified 2026-09-07)

### Node Version

Node v24.15.0 (any Node >= 20, ESM)

### Database

PostgreSQL (reproduced with PGlite 0.5.x, real executable PG dialect); the invalid SQL is
produced before any database access, so any `@ts-grm/sql` driver will see it when executing.

### OS

Linux

### Expected behavior

Calling `orderBy()` after `groupBy()` on the same mutable query should produce valid SQL with
`group by` before `order by`:

```
select tb_1_.edition, count(1) from book_g tb_1_ group by tb_1_.edition order by tb_1_.edition desc
```

### Actual behavior

The generated SQL places `order by` **before** `group by`:

```
select tb_1_.edition, count(1) from book_g tb_1_ order by tb_1_.edition desc group by tb_1_.edition
```

PostgreSQL rejects it with:

```
syntax error at or near "group"
```

(the `order by` clause reads the reserved word `group` → parser error).

### Description

**Scenario**: a grouped aggregate query that also orders by the grouping key:

```ts
client.createQuery(Book, (q, book) => {
    q.groupBy(book.edition);
    q.orderBy(book.edition.desc());
    return q.select({ edition: book.edition, count: dsl.count() });
})
```

**Root cause** (source review of `main`): in
`packages/sql/src/sql/fragment_gen_visitor.ts`, the `orders` array (`order by`) is written to
the SQL builder **before** `groupByExprs` (`group by`):

```ts
if (orders.length !== 0 && !query.options.countMode) {
    // ... "\norder by " ...
}
const groupByExprs = query.groupByExprs;
if (groupByExprs != null) {
    // ... "\ngroup by " ...
}
```

SQL grammar requires `group by` to precede `order by`; the two clauses are wired in the wrong
order.

**Control experiment**: removing the `orderBy` call produces a valid group-by query — the
framework's group-by support itself works; the defect is specifically combining `orderBy`
after `groupBy` on the same query.

### Reproduction steps

Standard project with `@ts-grm/core@0.0.12` + `@ts-grm/sql@0.0.12`:

```ts
import { model, prop, dsl } from "@ts-grm/core";
// client = newSqlClient(new PostgresDriver(pool), options)

const Book = model("Book", "id", class {
    id = prop.i64()
    name = prop.str(50)
    edition = prop.i32()
    price = prop.num(10, 2)
});

const q = client.createQuery(Book, (query, book) => {
    query.groupBy(book.edition);
    query.orderBy(book.edition.desc());
    return query.select({ edition: book.edition, count: dsl.count() });
});
await q.fetchList();
// generated SQL: select tb_1_.edition, count(1) from book_g tb_1_ order by tb_1_.edition desc group by tb_1_.edition
// PostgreSQL:    syntax error at or near "group"
```

Test harness in this repo (`repro.test.mjs`) captures the generated SQL with a fake pool and
asserts the illegal clause order; the real PG error was confirmed with PGlite.