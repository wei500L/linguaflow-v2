#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
api="$root/apps/api"
empty=linguaflow_empty_20261011
upgrade=linguaflow_upgrade_20261011
out="$root/scripts/isolation/evidence"
mkdir -p "$out"
dropdb --if-exists "$empty"
createdb "$empty"
(cd "$api" && DATABASE_URL="postgres://oo@localhost:5432/$empty" ./node_modules/.bin/drizzle-kit migrate)
{
  echo "empty database: $empty"
  psql -d "$empty" -c "select count(*) as applied from drizzle.__drizzle_migrations;"
  psql -d "$empty" -c "select column_name from information_schema.columns where table_name = 'summary_requests' and column_name like 'output_%' order by column_name;"
} > "$out/migrate-empty.txt"
dropdb --if-exists "$upgrade"
createdb "$upgrade"
python3 - "$api/drizzle" "$upgrade" <<'PY'
import pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
db = sys.argv[2]
files = sorted(p.name for p in root.glob("*.sql"))
def apply(names):
    sql = "\n".join((root/name).read_text().replace("--> statement-breakpoint", "") for name in names)
    subprocess.run(["psql", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"], input=sql, text=True, check=True)
early = [name for name in files if name[:4] <= "0011"]
apply(early)
subprocess.run(["psql", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"], input="""
insert into users (id, email) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'upgrade-review@example.com');
insert into transcripts (id, user_id, title, language_a, language_b, summary_markdown, summary_status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '旧课', 'ru', 'zh', '见 [[seg:11111111-1111-4111-8111-111111111111]]', 'ready');
insert into transcript_segments (id, transcript_id, idx, source_text) values ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, '原句');
insert into usage_ledger (user_id, transcript_id, seconds, source, kind, status) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 60, 'plan', 'summary', 'settled');
insert into transcript_shares (transcript_id, token_hash) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'upgrade-share-hash');
""", text=True, check=True)
apply(["0012_product_completeness_round.sql"])
subprocess.run(["psql", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"], input="""
insert into note_versions (transcript_id, user_id, author_type, body)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'human', '旧版本 [[seg:11111111-1111-4111-8111-111111111111]]');
""", text=True, check=True)
apply([name for name in files if name[:4] >= "0013"])
PY
{
  echo "upgrade database: $upgrade"
  psql -d "$upgrade" -c "select title, summary_markdown, summary_citation_hashes, summary_citations_verified from transcripts;"
  psql -d "$upgrade" -c "select body, citation_hashes, citations_verified from note_versions;"
  psql -d "$upgrade" -c "select seconds, status, request_id from usage_ledger;"
  psql -d "$upgrade" -c "select token_hash from transcript_shares;"
  psql -d "$upgrade" -c "select column_name from information_schema.columns where table_name = 'summary_requests' and column_name like 'output_%' order by column_name;"
} > "$out/migrate-upgrade.txt"
echo "wrote $out/migrate-empty.txt and $out/migrate-upgrade.txt"
