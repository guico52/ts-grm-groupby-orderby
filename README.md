# ts-grm-groupby-orderby：groupBy 后直接 orderBy 生成非法 SQL（PG 语法错误）

复现 `@ts-grm/core@0.0.12`（npm 官方包）的发布缺陷：

- **场景**：`createQuery` 内先 `q.groupBy(book.edition)` 再 `q.orderBy(book.edition.desc())`。
- **预期**：生成 `select edition, count(1) ... group by edition order by edition desc`（group by 在前）。
- **实际**：生成的 SQL 是
  `select tb_1_.edition, count(1) from book_g tb_1_ order by tb_1_.edition desc group by tb_1_.edition`
  —— **order by 子句出现在 group by 之前**，PostgreSQL 报 `syntax error at or near "group"`
  （order by 子句里读到保留字 `group`，直接语法错误）。
- **规避**：分组后要排序 → 把分组结果做成子查询/CTE（`derivedModel`/`cteModel`）再排；或按分组列在模型层排序。
- **真实报错**（pglite 实测，PostgreSQL 方言）：`syntax error at or near "group"`。

> 核对基准：本地主分支 `~/code/source/ts-grm`（HEAD `c7bbc06`，2026-09-07 实测）**仍未修复**，
> 生成 SQL 与 0.0.12 完全相同。相关渲染顺序在 `packages/sql/src/sql/fragment_gen_visitor.ts`：
> `orders`（`order by`）先于 `groupByExprs`（`group by`）写入 SQL。

## 运行

```bash
npm install   # 安装 @ts-grm/core@0.0.12 + @ts-grm/sql@0.0.12（官方 npm 原版，未打补丁）
npm test      # node --test repro.test.mjs：1 个缺陷用例 + 1 个对照组
```

预期：缺陷用例断言"SQL 顺序非法"（order by 在 group by 前），对照组正常 —— 全部通过即确认缺陷存在。

## 最小复现（核心片段）

```js
const Book = model("Book", "id", class {
    id = prop.i64()
    name = prop.str(50)
    edition = prop.i32()
    price = prop.num(10, 2)
});

const q = client.createQuery(Book, (query, book) => {
    query.groupBy(book.edition);
    query.orderBy(book.edition.desc());   // ← 分组后直接排序
    return query.select({ edition: book.edition, count: dsl.count() });
});
await q.fetchList();
// 生成 SQL：select ... order by tb_1_.edition desc group by tb_1_.edition
// PostgreSQL：syntax error at or near "group"
```

对照组：去掉 `orderBy`（先分组、后在外层子查询排序）→ SQL 正常。

## 复现主分支（如需核对最新代码）

把 `package.json` 依赖改为本地主分支构建产物并先构建（见 m2m-embedded-subpath 项目 README 的
"复现主分支"一节），随后 `npm install && npm test`。

环境：Node >= 20（ESM）。