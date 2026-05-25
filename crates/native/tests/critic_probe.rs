//! Adversarial critic probe — dumps the raw mongosql v1.8.5 output for a
//! large IN-list query against (1) the YAML fixture and (2) the real
//! Atlas SQL endpoint (gated). This bypasses pipeline_rewrite so we can
//! observe the upstream shape directly.

#![allow(clippy::unwrap_used)]

use std::env;

fn count_nested_or_depth(b: &bson::Bson) -> usize {
    match b {
        bson::Bson::Document(d) => {
            let here = if let Some(bson::Bson::Array(arr)) = d.get("$or") {
                1 + arr.iter().map(count_nested_or_depth).max().unwrap_or(0)
            } else {
                0
            };
            let child = d
                .iter()
                .map(|(_, v)| count_nested_or_depth(v))
                .max()
                .unwrap_or(0);
            here.max(child)
        }
        bson::Bson::Array(a) => a.iter().map(count_nested_or_depth).max().unwrap_or(0),
        _ => 0,
    }
}

fn count_or_arrays_recursive(b: &bson::Bson) -> usize {
    match b {
        bson::Bson::Document(d) => {
            let here = d.iter().filter(|(k, _)| k.as_str() == "$or").count();
            let child: usize = d.iter().map(|(_, v)| count_or_arrays_recursive(v)).sum();
            here + child
        }
        bson::Bson::Array(a) => a.iter().map(count_or_arrays_recursive).sum(),
        _ => 0,
    }
}

fn count_in_arrays_recursive(b: &bson::Bson) -> usize {
    match b {
        bson::Bson::Document(d) => {
            let here = d.iter().filter(|(k, _)| k.as_str() == "$in").count();
            let child: usize = d.iter().map(|(_, v)| count_in_arrays_recursive(v)).sum();
            here + child
        }
        bson::Bson::Array(a) => a.iter().map(count_in_arrays_recursive).sum(),
        _ => 0,
    }
}

/// CRITIC: drive the rewriter on the local-fixture mongosql output and
/// confirm that the post-rewriter pipeline collapses the let-wrapped
/// IN-list down to a single `$in` with zero remaining `$or` arrays.
///
/// Before the let-wrapped collapse was added, mongosql's local fixture
/// emission was untouched by the rewriter — the inner `$or` of `$eq`
/// against `$$desugared_sqlOr_inputN` was rejected by the flat-`$or`
/// collapse (variable LHS), and the outer `$let` envelope hid the
/// inner chain. After the let-wrapped collapse, the ENTIRE `$let` is
/// replaced with `{$cond: [<null-check>, null, {$in: [..]}]}`; the
/// inner `$or` of variable-LHS `$eq`s disappears as part of that
/// replacement (we don't try to collapse the inner `$or` — we replace
/// the whole envelope it lives in).
#[test]
fn probe_local_in_list_post_rewriter_collapses_to_in() {
    use cubejs_mongosql_driver_native::pipeline_rewrite::flatten_or_chains_and_collapse_to_in;
    use cubejs_mongosql_driver_native::schema::{load_from_file, FILE_MODE_DB_PLACEHOLDER};
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = crate_dir
        .join("..")
        .join("..")
        .join("tests")
        .join("integration")
        .join("fixtures")
        .join("mongo-schema.yaml");
    let catalog = load_from_file(&fixture).unwrap();
    let n = 200;
    let mut sql = String::from("SELECT account_id FROM orders WHERE account_id IN (");
    for i in 0..n {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("'v{i}'"));
    }
    sql.push(')');
    let upstream = mongosql::translate_sql(
        FILE_MODE_DB_PLACEHOLDER,
        &sql,
        &catalog,
        mongosql::options::SqlOptions::default(),
    )
    .unwrap();
    let mut pipeline: Vec<bson::Document> = match upstream.pipeline {
        bson::Bson::Array(stages) => stages
            .into_iter()
            .filter_map(|s| {
                if let bson::Bson::Document(d) = s {
                    Some(d)
                } else {
                    None
                }
            })
            .collect(),
        _ => unreachable!(),
    };
    flatten_or_chains_and_collapse_to_in(&mut pipeline);
    let mut total_in = 0;
    let mut total_or = 0;
    for stage in &pipeline {
        let b = bson::Bson::Document(stage.clone());
        total_in += count_in_arrays_recursive(&b);
        total_or += count_or_arrays_recursive(&b);
    }
    eprintln!("[LOCAL post-rewriter] total $or={total_or}, total $in={total_in}");
    // The let-wrapped collapse rewrites the outer `$let` (one envelope
    // per IN-list LHS) into a `$cond`-wrapped `$in`. The inner
    // variable-LHS `$or` is part of the replaced envelope and goes
    // away wholesale — exactly one `$in` remains, no `$or` arrays.
    assert_eq!(total_in, 1, "let-wrapped collapse fires; expected 1 $in");
    assert_eq!(
        total_or, 0,
        "let-wrapped collapse removes the inner $or as part of the envelope replacement"
    );
}

/// CRITIC: probe local OR-chain shape (explicit `OR` operator, not `IN`).
#[test]
fn probe_local_or_chain_shape() {
    use cubejs_mongosql_driver_native::schema::{load_from_file, FILE_MODE_DB_PLACEHOLDER};
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = crate_dir
        .join("..")
        .join("..")
        .join("tests")
        .join("integration")
        .join("fixtures")
        .join("mongo-schema.yaml");
    let catalog = load_from_file(&fixture).unwrap();
    for n in [5_usize, 20, 50, 100] {
        let mut sql = String::from("SELECT account_id FROM orders WHERE ");
        for i in 0..n {
            if i > 0 {
                sql.push_str(" OR ");
            }
            sql.push_str(&format!("account_id = 'v{i}'"));
        }
        let upstream = mongosql::translate_sql(
            FILE_MODE_DB_PLACEHOLDER,
            &sql,
            &catalog,
            mongosql::options::SqlOptions::default(),
        )
        .unwrap();
        let depth = count_nested_or_depth(&upstream.pipeline);
        let total = count_or_arrays_recursive(&upstream.pipeline);
        eprintln!("[LOCAL-OR-CHAIN N={n}] max $or nest depth = {depth}; total $or = {total}");
    }
}

/// CRITIC: confirms the rewriter handles a real 1000-deep right-leaning
/// chain — both for stack safety AND for the specific failure path the
/// implementer cites (`$expr.$let.in.$cond.if.$or.0.$or.0.$or.0…`).
#[test]
fn probe_1000_deep_right_leaning_chain() {
    use bson::{doc, Bson, Document};
    use cubejs_mongosql_driver_native::pipeline_rewrite::flatten_or_chains_and_collapse_to_in;
    let n = 1000_usize;
    // Build 1000-deep right-leaning chain of `$eq: ["$x", literal]`.
    let mut current = doc! {
        "$or": [
            doc! {"$eq": ["$x", (n - 2) as i64]},
            doc! {"$eq": ["$x", (n - 1) as i64]},
        ],
    };
    for i in (0..(n - 2)).rev() {
        let leaf = doc! {"$eq": ["$x", i as i64]};
        current = doc! { "$or": [Bson::Document(leaf), Bson::Document(current)] };
    }
    // The implementer's claimed failure path: wrap in $expr.$let.in.$cond.if.
    let pipeline_doc = doc! {
        "$match": {
            "$expr": {
                "$let": {
                    "vars": { "desugared_sqlAnd_input2": "$x" },
                    "in": {
                        "$let": {
                            "vars": { "inner": "$x" },
                            "in": {
                                "$cond": {
                                    "if": Bson::Document(current),
                                    "then": { "$literal": true },
                                    "else": { "$literal": false },
                                },
                            },
                        },
                    },
                },
            },
        },
    };
    let mut pipeline: Vec<Document> = vec![pipeline_doc];
    flatten_or_chains_and_collapse_to_in(&mut pipeline);
    // Drill down to the if-branch.
    let inner = pipeline[0]
        .get_document("$match")
        .unwrap()
        .get_document("$expr")
        .unwrap()
        .get_document("$let")
        .unwrap()
        .get_document("in")
        .unwrap()
        .get_document("$let")
        .unwrap()
        .get_document("in")
        .unwrap()
        .get_document("$cond")
        .unwrap()
        .get_document("if")
        .unwrap();
    // Must have collapsed to a single $in array of length 1000.
    let arr = inner.get_array("$in").expect("collapsed to $in");
    assert_eq!(arr.len(), 2);
    let vals = arr[1].as_array().unwrap();
    assert_eq!(vals.len(), n, "all leaves preserved");
}

/// CRITIC: the real mongosql output uses `$cond` ARRAY form (`$cond: [if, then, else]`),
/// not OBJECT form (`$cond: {if, then, else}`). The existing test exercises OBJECT form
/// only. Verify array-form descent works.
#[test]
fn probe_cond_array_form_descent() {
    use bson::{doc, Bson, Document};
    use cubejs_mongosql_driver_native::pipeline_rewrite::flatten_or_chains_and_collapse_to_in;
    let n = 50_usize;
    let mut current = doc! {
        "$or": [
            doc! {"$eq": ["$x", (n - 2) as i64]},
            doc! {"$eq": ["$x", (n - 1) as i64]},
        ],
    };
    for i in (0..(n - 2)).rev() {
        let leaf = doc! {"$eq": ["$x", i as i64]};
        current = doc! { "$or": [Bson::Document(leaf), Bson::Document(current)] };
    }
    let pipeline_doc = doc! {
        "$match": {
            "$expr": {
                "$cond": [
                    Bson::Document(current),
                    { "$literal": true },
                    { "$literal": false },
                ],
            },
        },
    };
    let mut pipeline: Vec<Document> = vec![pipeline_doc];
    flatten_or_chains_and_collapse_to_in(&mut pipeline);
    let arr = pipeline[0]
        .get_document("$match")
        .unwrap()
        .get_document("$expr")
        .unwrap()
        .get_array("$cond")
        .unwrap();
    let inner = arr[0].as_document().unwrap();
    let in_args = inner
        .get_array("$in")
        .expect("collapsed to $in via array-form $cond");
    let vals = in_args[1].as_array().unwrap();
    assert_eq!(vals.len(), n);
}

/// CRITIC: the LOCAL fixture pipeline at N=200 contains 200 `$let`-bound variables
/// each with `$$desugared_sqlEq_input0` LHS in the inner $eq. The OUTER `$or` array
/// contains `$eq: [$$desugared_sqlOr_inputN, {$literal: true}]` — variable LHS.
/// Verify the collapse SKIPS this shape (does not produce a `$in`).
#[test]
fn probe_local_fixture_shape_skips_collapse() {
    use bson::{doc, Bson, Document};
    use cubejs_mongosql_driver_native::pipeline_rewrite::flatten_or_chains_and_collapse_to_in;
    let mut leaves: Vec<Bson> = Vec::new();
    for i in 0..50 {
        leaves.push(
            bson::bson!({"$eq": [format!("$$desugared_sqlOr_input{}", i), {"$literal": true}]}),
        );
    }
    let mut pipeline: Vec<Document> = vec![doc! {
        "$match": {"$expr": {"$or": Bson::Array(leaves)}},
    }];
    flatten_or_chains_and_collapse_to_in(&mut pipeline);
    let expr = pipeline[0]
        .get_document("$match")
        .unwrap()
        .get_document("$expr")
        .unwrap();
    // Must NOT have collapsed (variable LHS).
    assert!(
        expr.contains_key("$or") && !expr.contains_key("$in"),
        "local fixture shape must NOT collapse — variable LHS — got {expr:?}"
    );
    let arr = expr.get_array("$or").unwrap();
    assert_eq!(arr.len(), 50);
}

/// CRITIC: unwrap `{$literal: "$some_field"}` would produce a bare
/// string `"$some_field"` in the `$in` values array. At evaluation,
/// MongoDB treats array elements as expressions — so the value becomes
/// a FIELD REFERENCE, not a literal string. This is a semantic bug.
#[test]
fn probe_collapse_literal_with_dollar_string_loses_safety() {
    use bson::{doc, Bson, Document};
    use cubejs_mongosql_driver_native::pipeline_rewrite::flatten_or_chains_and_collapse_to_in;
    let mut pipeline: Vec<Document> = vec![doc! {
        "$match": {
            "$expr": {
                "$or": [
                    doc! {"$eq": ["$x", {"$literal": "$evil_field_ref"}]},
                    doc! {"$eq": ["$x", {"$literal": "ok"}]},
                ],
            },
        },
    }];
    flatten_or_chains_and_collapse_to_in(&mut pipeline);
    let expr = pipeline[0]
        .get_document("$match")
        .unwrap()
        .get_document("$expr")
        .unwrap();
    if let Ok(in_arr) = expr.get_array("$in") {
        let vals = in_arr[1].as_array().unwrap();
        // POST-FIX: `extract_literal` preserves the `{$literal: ...}`
        // wrapper around `$`-prefixed strings so the server evaluates
        // the array element as a literal, not as a field reference. The
        // wrapper must be present.
        let first_is_literal_protected =
            matches!(&vals[0], Bson::Document(d) if d.contains_key("$literal"));
        let first_is_bare_dollar_string = matches!(&vals[0], Bson::String(s) if s.starts_with('$'));
        eprintln!("first value after collapse: {:?}", vals[0]);
        eprintln!("protected by $literal: {first_is_literal_protected}");
        eprintln!("bare $-prefixed string: {first_is_bare_dollar_string}");
        assert!(
            first_is_literal_protected,
            "$literal wrapper MUST be preserved around $-prefixed strings; \
             got vals[0] = {:?}",
            vals[0],
        );
        assert!(
            !first_is_bare_dollar_string,
            "$-prefixed string must NOT be unwrapped (would become field ref); \
             got vals[0] = {:?}",
            vals[0],
        );
    } else {
        // Collapse skipped — safe.
        eprintln!("collapse did not fire; safe.");
    }
}

#[test]
fn probe_local_in_list_shape() {
    use cubejs_mongosql_driver_native::schema::{load_from_file, FILE_MODE_DB_PLACEHOLDER};

    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = crate_dir
        .join("..")
        .join("..")
        .join("tests")
        .join("integration")
        .join("fixtures")
        .join("mongo-schema.yaml");
    let catalog = load_from_file(&fixture).unwrap();

    let n = 200;
    let mut sql = String::from("SELECT account_id FROM orders WHERE account_id IN (");
    for i in 0..n {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("'v{i}'"));
    }
    sql.push(')');

    let upstream = mongosql::translate_sql(
        FILE_MODE_DB_PLACEHOLDER,
        &sql,
        &catalog,
        mongosql::options::SqlOptions::default(),
    )
    .unwrap();

    let max_or_nest = count_nested_or_depth(&upstream.pipeline);
    let total_or = count_or_arrays_recursive(&upstream.pipeline);
    let total_in = count_in_arrays_recursive(&upstream.pipeline);
    eprintln!("[LOCAL/fixture] N={n}");
    eprintln!("[LOCAL/fixture] max $or nest depth = {max_or_nest}");
    eprintln!("[LOCAL/fixture] total $or arrays = {total_or}");
    eprintln!("[LOCAL/fixture] total $in arrays = {total_in}");
    eprintln!(
        "[LOCAL/fixture] pipeline =\n{}",
        serde_json::to_string_pretty(&upstream.pipeline).unwrap()
    );
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB"]
async fn probe_atlas_sql_in_list_shape() {
    use cubejs_mongosql_driver_native::schema::load_from_atlas_sql_with_columns;

    let uri = env::var("ATLAS_SQL_URI").expect("ATLAS_SQL_URI");
    let db = env::var("ATLAS_SQL_DB").expect("ATLAS_SQL_DB");

    let client = mongodb::Client::with_uri_str(&uri)
        .await
        .expect("mongo client");
    let loaded = load_from_atlas_sql_with_columns(&client, &db)
        .await
        .expect("atlas-sql catalog loads");

    // Use a real string field. Find the first non-`_id` string-typed
    // column on any collection.
    let (coll, field) = loaded
        .columns
        .iter()
        .find_map(|((d, c), cols)| {
            if d != &db {
                return None;
            }
            cols.iter().find_map(|col| {
                if col.name == "_id" {
                    return None;
                }
                if col.sql_type == "string" || col.sql_type == "text" {
                    Some((c.clone(), col.name.clone()))
                } else {
                    None
                }
            })
        })
        .expect("at least one string column");
    eprintln!("[ATLAS-SQL] using {coll}.{field}");

    let n = 200;
    let mut sql = format!("SELECT * FROM `{coll}` WHERE `{field}` IN (");
    for i in 0..n {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("'large_in_list_test_v{i}'"));
    }
    sql.push(')');

    let upstream = mongosql::translate_sql(
        &db,
        &sql,
        &loaded.catalog,
        mongosql::options::SqlOptions::default(),
    )
    .expect("translate");

    let max_or_nest = count_nested_or_depth(&upstream.pipeline);
    let total_or = count_or_arrays_recursive(&upstream.pipeline);
    let total_in = count_in_arrays_recursive(&upstream.pipeline);
    eprintln!("[ATLAS-SQL] N={n}");
    eprintln!("[ATLAS-SQL] max $or nest depth = {max_or_nest}");
    eprintln!("[ATLAS-SQL] total $or arrays = {total_or}");
    eprintln!("[ATLAS-SQL] total $in arrays = {total_in}");

    let pretty = serde_json::to_string_pretty(&upstream.pipeline).unwrap();
    if pretty.len() < 6000 {
        eprintln!("[ATLAS-SQL] pipeline =\n{pretty}");
    } else {
        eprintln!(
            "[ATLAS-SQL] pipeline (first 6000 of {} chars) =\n{}",
            pretty.len(),
            &pretty[..6000]
        );
    }
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB"]
async fn probe_atlas_sql_in_list_sweep() {
    use cubejs_mongosql_driver_native::schema::load_from_atlas_sql_with_columns;

    let uri = env::var("ATLAS_SQL_URI").expect("ATLAS_SQL_URI");
    let db = env::var("ATLAS_SQL_DB").expect("ATLAS_SQL_DB");
    let client = mongodb::Client::with_uri_str(&uri)
        .await
        .expect("mongo client");
    let loaded = load_from_atlas_sql_with_columns(&client, &db)
        .await
        .expect("catalog loads");
    let (coll, field) = loaded
        .columns
        .iter()
        .find_map(|((d, c), cols)| {
            if d != &db {
                return None;
            }
            cols.iter().find_map(|col| {
                if col.name == "_id" {
                    return None;
                }
                if col.sql_type == "string" || col.sql_type == "text" {
                    Some((c.clone(), col.name.clone()))
                } else {
                    None
                }
            })
        })
        .expect("at least one string column");

    for n in [50_usize, 100, 200, 500, 1000, 2000] {
        let mut sql = format!("SELECT * FROM `{coll}` WHERE `{field}` IN (");
        for i in 0..n {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&format!("'v{i}'"));
        }
        sql.push(')');
        let upstream = mongosql::translate_sql(
            &db,
            &sql,
            &loaded.catalog,
            mongosql::options::SqlOptions::default(),
        )
        .expect("translate");
        let depth = count_nested_or_depth(&upstream.pipeline);
        let total = count_or_arrays_recursive(&upstream.pipeline);
        eprintln!("[SWEEP N={n}] max $or nest depth = {depth}; total $or = {total}");
    }
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB"]
async fn probe_atlas_sql_or_chain_shape() {
    // SQL form `field=v1 OR field=v2 OR ... field=vN` rather than `IN (...)`.
    // Verifies whether mongosql uses the right-leaning chain for explicit OR.
    use cubejs_mongosql_driver_native::schema::load_from_atlas_sql_with_columns;
    let uri = env::var("ATLAS_SQL_URI").expect("ATLAS_SQL_URI");
    let db = env::var("ATLAS_SQL_DB").expect("ATLAS_SQL_DB");
    let client = mongodb::Client::with_uri_str(&uri).await.expect("client");
    let loaded = load_from_atlas_sql_with_columns(&client, &db)
        .await
        .expect("catalog");
    let (coll, field) = loaded
        .columns
        .iter()
        .find_map(|((d, c), cols)| {
            if d != &db {
                return None;
            }
            cols.iter().find_map(|col| {
                if col.name == "_id" {
                    return None;
                }
                if col.sql_type == "string" || col.sql_type == "text" {
                    Some((c.clone(), col.name.clone()))
                } else {
                    None
                }
            })
        })
        .expect("string column");
    for n in [10_usize, 50, 100, 200] {
        let mut sql = format!("SELECT * FROM `{coll}` WHERE ");
        for i in 0..n {
            if i > 0 {
                sql.push_str(" OR ");
            }
            sql.push_str(&format!("`{field}` = 'v{i}'"));
        }
        let upstream = mongosql::translate_sql(
            &db,
            &sql,
            &loaded.catalog,
            mongosql::options::SqlOptions::default(),
        )
        .expect("translate");
        let depth = count_nested_or_depth(&upstream.pipeline);
        let total = count_or_arrays_recursive(&upstream.pipeline);
        eprintln!("[OR-CHAIN N={n}] max $or nest depth = {depth}; total $or = {total}");
        if n == 10 {
            let pretty = serde_json::to_string_pretty(&upstream.pipeline).unwrap();
            if pretty.len() < 8000 {
                eprintln!("[OR-CHAIN N=10] pipeline =\n{pretty}");
            }
        }
    }
}

/// CRITIC: execute a 200-value NOT IN query against the real Atlas SQL
/// endpoint. The translator output is a flat $and (depth 1) but the
/// proxy/server may re-expand it the same way it re-expands flat $or.
/// This probe forces that question to be answered empirically.
#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB"]
async fn probe_atlas_sql_not_in_execute_200() {
    use cubejs_mongosql_driver_native::schema::load_from_atlas_sql_with_columns;
    use cubejs_mongosql_driver_native::translate::translate;

    let uri = env::var("ATLAS_SQL_URI").expect("ATLAS_SQL_URI");
    let db = env::var("ATLAS_SQL_DB").expect("ATLAS_SQL_DB");
    let client = mongodb::Client::with_uri_str(&uri).await.expect("client");
    let loaded = load_from_atlas_sql_with_columns(&client, &db)
        .await
        .expect("catalog");
    let (coll, field) = loaded
        .columns
        .iter()
        .find_map(|((d, c), cols)| {
            if d != &db {
                return None;
            }
            cols.iter().find_map(|col| {
                if col.name == "_id" {
                    return None;
                }
                if col.sql_type == "string" || col.sql_type == "text" {
                    Some((c.clone(), col.name.clone()))
                } else {
                    None
                }
            })
        })
        .expect("string column");

    // Build a NOT IN with 200 synthetic values.
    let n = 200_usize;
    let mut sql = format!("SELECT COUNT(*) AS n FROM `{coll}` WHERE `{field}` NOT IN (");
    for i in 0..n {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("'large_not_in_test_v{i}'"));
    }
    sql.push(')');

    // Translate WITHOUT the rewriter (raw mongosql output), to see what
    // the proxy does on its own. Bypass our wrapper.
    let upstream = mongosql::translate_sql(
        &db,
        &sql,
        &loaded.catalog,
        mongosql::options::SqlOptions::default(),
    )
    .expect("translate");
    let stages: Vec<bson::Document> = match upstream.pipeline {
        bson::Bson::Array(arr) => arr
            .into_iter()
            .filter_map(|s| {
                if let bson::Bson::Document(d) = s {
                    Some(d)
                } else {
                    None
                }
            })
            .collect(),
        _ => unreachable!(),
    };

    eprintln!(
        "[NOT-IN raw translate] N={n} stages={} first stage keys={:?}",
        stages.len(),
        stages
            .first()
            .map(|d| d.keys().collect::<Vec<_>>())
            .unwrap_or_default(),
    );

    // Execute raw (no rewriter).
    let dbh = client.database(&upstream.target_db);
    let result_raw = match upstream.target_collection.as_deref() {
        Some(c) => {
            dbh.collection::<bson::Document>(c)
                .aggregate(stages.clone())
                .await
        }
        None => dbh.aggregate(stages.clone()).await,
    };
    match result_raw {
        Ok(mut cursor) => {
            use futures_util::TryStreamExt;
            let mut rows = Vec::new();
            while let Ok(Some(doc)) = cursor.try_next().await {
                rows.push(doc);
            }
            eprintln!("[NOT-IN raw execute] OK rows={}", rows.len());
        }
        Err(e) => {
            eprintln!("[NOT-IN raw execute] ERROR: {e:#?}");
        }
    }

    // Execute with the rewriter applied (current behaviour).
    let translation = translate(&sql, &loaded.catalog, &db).expect("translate-via-wrapper");
    let result_post = match translation.target_collection.as_deref() {
        Some(c) => {
            dbh.collection::<bson::Document>(c)
                .aggregate(translation.pipeline.clone())
                .await
        }
        None => dbh.aggregate(translation.pipeline.clone()).await,
    };
    match result_post {
        Ok(mut cursor) => {
            use futures_util::TryStreamExt;
            let mut rows = Vec::new();
            while let Ok(Some(doc)) = cursor.try_next().await {
                rows.push(doc);
            }
            eprintln!("[NOT-IN post-rewriter execute] OK rows={}", rows.len());
        }
        Err(e) => {
            eprintln!("[NOT-IN post-rewriter execute] ERROR: {e:#?}");
        }
    }
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB"]
async fn probe_atlas_sql_not_in_shape() {
    // SQL `NOT IN (v1, ..., vN)` — implementer's note item J mentions checking
    // this. Does it produce a deep `$and` of negations?
    use cubejs_mongosql_driver_native::schema::load_from_atlas_sql_with_columns;
    let uri = env::var("ATLAS_SQL_URI").expect("ATLAS_SQL_URI");
    let db = env::var("ATLAS_SQL_DB").expect("ATLAS_SQL_DB");
    let client = mongodb::Client::with_uri_str(&uri).await.expect("client");
    let loaded = load_from_atlas_sql_with_columns(&client, &db)
        .await
        .expect("catalog");
    let (coll, field) = loaded
        .columns
        .iter()
        .find_map(|((d, c), cols)| {
            if d != &db {
                return None;
            }
            cols.iter().find_map(|col| {
                if col.name == "_id" {
                    return None;
                }
                if col.sql_type == "string" || col.sql_type == "text" {
                    Some((c.clone(), col.name.clone()))
                } else {
                    None
                }
            })
        })
        .expect("string column");
    fn count_nested_and_depth(b: &bson::Bson) -> usize {
        match b {
            bson::Bson::Document(d) => {
                let here = if let Some(bson::Bson::Array(arr)) = d.get("$and") {
                    1 + arr.iter().map(count_nested_and_depth).max().unwrap_or(0)
                } else {
                    0
                };
                let child = d
                    .iter()
                    .map(|(_, v)| count_nested_and_depth(v))
                    .max()
                    .unwrap_or(0);
                here.max(child)
            }
            bson::Bson::Array(a) => a.iter().map(count_nested_and_depth).max().unwrap_or(0),
            _ => 0,
        }
    }
    for n in [50_usize, 100, 200] {
        let mut sql = format!("SELECT * FROM `{coll}` WHERE `{field}` NOT IN (");
        for i in 0..n {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&format!("'v{i}'"));
        }
        sql.push(')');
        let upstream = mongosql::translate_sql(
            &db,
            &sql,
            &loaded.catalog,
            mongosql::options::SqlOptions::default(),
        )
        .expect("translate");
        let depth_or = count_nested_or_depth(&upstream.pipeline);
        let depth_and = count_nested_and_depth(&upstream.pipeline);
        let total_or = count_or_arrays_recursive(&upstream.pipeline);
        eprintln!(
            "[NOT-IN N={n}] $or depth={depth_or}; $and depth={depth_and}; total $or={total_or}"
        );
    }
}
