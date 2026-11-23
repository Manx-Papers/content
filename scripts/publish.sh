#!/usr/bin/env bash
# Control #244: publish the validated posts to the content store, the R2 bucket manxpapers-content
# under blog/. Runs only from the workflow on main. Order: images and posts, then index.json (so
# the index never names a post that is not there yet), then delete what is no longer in the repo
# (a reverted merge unpublishes). Only the blog/ prefix of this one bucket is ever written.
set -euo pipefail

BUCKET=manxpapers-content
PREFIX=blog/

# CONTENT_PUBLISH_TEST=1 is the test harness (tests/content.test.mjs). It is never honoured inside
# GitHub Actions, so the workflow always uses the real aws CLI and the real main tip.
testing=
if [ "${CONTENT_PUBLISH_TEST:-}" = 1 ] && [ -z "${GITHUB_ACTIONS:-}" ]; then testing=1; fi

# Fail before doing anything if a secret is missing or malformed. Values are never printed.
missing=()
for name in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CF_ACCOUNT_ID; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing repository Actions secret(s): ${missing[*]}. Nothing was published."
  exit 1
fi
if ! [[ "$CF_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]]; then
  echo "::error::CF_ACCOUNT_ID is not a 32-character Cloudflare account ID. Nothing was published."
  exit 1
fi

# Never roll the store back: publish only the commit that is main's tip now. Re-running an older
# run, or a queued run overtaken by a newer merge, publishes nothing (the newest run publishes).
tip=
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  if ! tip=$(curl -fsS --max-time 20 -H "Authorization: Bearer ${GH_TOKEN:-}" -H "Accept: application/vnd.github.sha" \
      "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/main"); then
    echo "::error::Could not read the current tip of main. Nothing was published."
    exit 1
  fi
elif [ -n "$testing" ]; then
  tip="${MAIN_TIP:-}"
fi
if [ -n "$tip" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  if ! [[ "$tip" =~ ^[0-9a-f]{40}$ ]] || [ "$tip" != "${GITHUB_SHA:-}" ]; then
    echo "::notice::This run's commit ${GITHUB_SHA:-unknown} is not the current tip of main (${tip:-unknown}). Nothing was published; the run for the tip publishes."
    exit 0
  fi
fi

out=$(mktemp -d)
node scripts/validate.mjs --build "$out"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
# R2 does not accept the newer default request checksums of AWS CLI v2.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
aws=aws
if [ -n "$testing" ]; then aws="${AWS_CLI:-aws}"; fi
s3=("$aws" s3 --endpoint-url "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" --only-show-errors)
target="s3://${BUCKET}/${PREFIX}"

if [ -d "$out/blog/images" ]; then "${s3[@]}" sync "$out/blog/images" "${target}images"; fi
"${s3[@]}" sync "$out/blog/posts" "${target}posts" --content-type application/json
"${s3[@]}" cp "$out/blog/index.json" "${target}index.json" --content-type application/json
"${s3[@]}" sync "$out/blog/" "$target" --delete

posts=$(find "$out/blog/posts" -name '*.json' | wc -l)
images=$( [ -d "$out/blog/images" ] && find "$out/blog/images" -type f | wc -l || echo 0)
echo "Published ${posts} post(s) and ${images} image(s) to ${BUCKET}/${PREFIX}"
{
  echo "### Blog published"
  echo "- ${posts} post(s), ${images} image(s) in \`${BUCKET}/${PREFIX}\`"
  echo "- Source: \`${GITHUB_SHA:-local}\`"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
