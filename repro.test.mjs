// 最小复现：#2 groupBy 后直接 orderBy → 生成非法 SQL（order by 在 group by 之前）
//
// 场景：`q.groupBy(book.edition)` 之后再 `q.orderBy(book.edition.desc())`。
// 预期（缺陷存在时）：生成的 SQL 是
//   select tb_1_.edition, count(1) from book_g tb_1_ order by tb_1_.edition desc group by tb_1_.edition
//   —— order by 子句出现在 group by 之前，PostgreSQL 直接报
//   syntax error at or near "group"（order by 子句里遇到保留字 group）。
//
// 本测试用假连接池捕获 SQL 文本并断言其顺序非法（不依赖真实数据库）；
// PostgreSQL 真实报错见 README / ISSUE（pglite 实测：syntax error at or near "group"）。
//
// 适用版本：@ts-grm/core@0.0.12（npm 发布版）复现；
//           本地主分支 ~/code/source/ts-grm（HEAD c7bbc06，2026-09-07 实测）仍未修复。
import { test } from "node:test";
import assert from "node:assert/strict";
import { model, prop, dsl, spi } from "@ts-grm/core";
import { PostgresDriver, newSqlClient } from "@ts-grm/sql";

function toSnake(name) {
    return name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}
const naming = {
    tableName: (entity) => toSnake(entity.name),
    sequenceName: (entity) => toSnake(entity.name) + "_id_seq",
    columnName: (prop) => toSnake(prop.name),
    middleTableName: (prop) => toSnake(prop.declaringEntity.name) + "_" + toSnake(prop.targetEntity.name) + "_mapping",
    middleTableThisRefColumnName: (prop) => toSnake(prop.declaringEntity.name) + "_" + toSnake(prop.thisKeyProp.name),
    middleTableTargetRefColumnName: (prop) => toSnake(prop.targetEntity.name) + "_" + toSnake(prop.targetKeyProp.name),
};

// 假连接池：只记录 SQL，不执行
const sqlLog = [];
const fakePool = {
    connect: async () => ({
        query: async (cmd) => {
            const text = typeof cmd === "string" ? cmd : cmd?.text ?? String(cmd);
            sqlLog.push(text);
            return { rows: [] };
        },
        release: () => {},
    }),
};
function makeClient(models) {
    return newSqlClient(new PostgresDriver(fakePool), {
        strategy: naming,
        entityManager: { entities: async () => models.map((m) => spi.Entity.of(m)) },
    });
}

const Book = model("Book", "id", class {
    id = prop.i64()
    name = prop.str(50)
    edition = prop.i32()
    price = prop.num(10, 2)
});

test("缺陷：groupBy 后直接 orderBy → SQL 顺序非法（order by 在 group by 之前）", async () => {
    sqlLog.length = 0;
    const client = makeClient([Book]);
    await client.createSchema();
    const q = client.createQuery(Book, (query, book) => {
        query.groupBy(book.edition);
        query.orderBy(book.edition.desc()); // ← 分组后直接排序
        return query.select({ edition: book.edition, count: dsl.count() });
    });
    await q.fetchList();
    const sql = sqlLog.find((s) => s.includes("count") && s.includes("group")) ?? sqlLog[0] ?? "";
    const orderIdx = sql.indexOf("order by");
    const groupIdx = sql.indexOf("group by");
    assert.ok(orderIdx !== -1 && groupIdx !== -1, `SQL 应同时含 order by 与 group by，实际: ${sql}`);
    assert.ok(
        orderIdx < groupIdx,
        `SQL 顺序非法：order by 出现在 group by 之前（PG 报 syntax error at or near "group"）。\nSQL: ${sql}`,
    );
});

test("对照组：无 orderBy 的 groupBy（规避写法）→ SQL 顺序正常", async () => {
    sqlLog.length = 0;
    const client = makeClient([Book]);
    await client.createSchema();
    const q = client.createQuery(Book, (query, book) => {
        query.groupBy(book.edition);
        return query.select({ edition: book.edition, count: dsl.count() });
    });
    await q.fetchList();
    const sql = sqlLog.find((s) => s.includes("count")) ?? sqlLog[0] ?? "";
    const groupIdx = sql.indexOf("group by");
    assert.ok(groupIdx !== -1, `SQL 应含 group by，实际: ${sql}`);
    const orderIdx = sql.indexOf("order by");
    assert.ok(orderIdx === -1 || groupIdx < orderIdx, `无 orderBy 时不应出现 order by 在 group by 后），SQL: ${sql}`);
});