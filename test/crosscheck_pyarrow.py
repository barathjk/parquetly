"""Validate Parquetly-written files with pyarrow, an independent Parquet implementation.

Usage: python test/crosscheck_pyarrow.py <roundtrip-output-dir> <repo-root>

The roundtrip suite writes these files; this script checks that a reader other
than hyparquet agrees they are valid and match their sources.
"""
import os
import sys

import pyarrow.parquet as pq

out_dir, root = sys.argv[1], sys.argv[2]
failures = []
checks = 0


def check(name, ok, detail=""):
    global checks
    checks += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -> ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


def read(name):
    return pq.read_table(os.path.join(out_dir, name))


src = pq.read_table(os.path.join(root, "inputs", "titanic.parquet"))
out = read("titanic_edited.parquet")
check("titanic: schema identical to source", src.schema.equals(out.schema))
check("titanic: every value identical to source", src.equals(out), f"{out.num_rows} rows")

big_src = pq.read_table(os.path.join(root, "inputs", "sample-large.parquet"))
big = read("big.parquet")
check("sample-large: schema identical to source", big_src.schema.equals(big.schema))
check("sample-large: every value identical to source", big_src.equals(big), f"{big.num_rows} rows")

widened = read("widened.parquet")
check(
    "widened: only the offending column changes type",
    str(widened.schema.field("Survived").type) == "string"
    and str(widened.schema.field("Pclass").type) == "int64",
)

edited = read("edited-values.parquet")
last_row = [edited.column(i)[-1].as_py() for i in range(edited.num_columns)]
check("edited: added all-null row reads back as nulls", all(v is None for v in last_row))
check("edited: int edit keeps INT64", str(edited.schema.field("Survived").type) == "int64")

print(f"{checks - len(failures)}/{checks} pyarrow checks passed")
sys.exit(1 if failures else 0)
