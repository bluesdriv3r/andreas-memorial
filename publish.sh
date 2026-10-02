#!/usr/bin/env bash
#
# Builds the memorial upload pages and publishes them to S3 + CloudFront, then
# confirms that the guest API answers and uploads are open.
#
# Bucket, distribution, URL, title and footer all come from `terraform output`, so
# the Terraform state is the single source of truth. Run it from anywhere:
#   moon run memorial:publish        or        ./publish.sh

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tf_dir="$project_dir/terraform"
venv_python="$project_dir/.venv/bin/python"

die() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

command -v aws >/dev/null || die "aws CLI not found. brew install awscli"
command -v terraform >/dev/null || die "terraform not found. brew install terraform"
command -v curl >/dev/null || die "curl not found."
[[ -x "$venv_python" ]] || die "Missing $venv_python. See README.md, Prerequisites."
[[ -f "$tf_dir/terraform.tfstate" ]] || die "No Terraform state. Run terraform apply first — see README.md."

tf_out() { terraform -chdir="$tf_dir" output -raw "$1"; }

bucket="$(tf_out site_bucket)"
distribution="$(tf_out distribution_id)"
site_url="$(tf_out site_url)"

printf '==> Building pages (SITE_URL=%s)\n' "$site_url"
cd "$project_dir"
SITE_URL="$site_url" EVENT_TITLE="$(tf_out event_title)" FOOTER_TEXT="$(tf_out footer_text)" \
    "$venv_python" -m mkdocs build --clean --strict

# Both images are git-ignored and added by hand. The page works without them (no
# portrait, a QR placeholder), but it should not go to the event that way.
if [[ ! -f site/images/portrait.jpg ]]; then
    printf '    warning: web/images/portrait.jpg is missing — the page shows no portrait.\n'
    printf '             See README "Deploying", step 5.\n'
fi
if [[ ! -f site/images/qr.png ]]; then
    printf '    warning: web/images/qr.png is missing — the QR dialog shows a placeholder.\n'
    printf '             See README "Deploying", step 5.\n'
fi

# Guard the --delete below: never sync a half-built directory.
[[ -f site/index.html && -f site/admin/index.html && -f site/admin/gallery/index.html \
    && -f site/admin/photo/index.html \
    && -f site/login/index.html && -f site/stylesheets/colors.css ]] \
    || die "Build output incomplete — refusing to sync with --delete."

export AWS_RETRY_MODE=standard
export AWS_MAX_ATTEMPTS=10

# Cache-Control no-cache: browsers check for a newer version on every visit (a cheap
# 304 when nothing changed), so a publish is visible at once. cp uploads everything,
# because sync would not update the header of unchanged files; sync then deletes what
# the build no longer contains.
printf '==> Uploading to s3://%s\n' "$bucket"
aws s3 cp "$project_dir/site/" "s3://$bucket/" --recursive --cache-control no-cache --only-show-errors
aws s3 sync "$project_dir/site/" "s3://$bucket/" --delete --cache-control no-cache --only-show-errors

# '/*' counts as one invalidation path, well inside the free 1000/month.
printf '==> Invalidating the CloudFront cache\n'
invalidation="$(aws cloudfront create-invalidation \
    --distribution-id "$distribution" \
    --paths '/*' \
    --query 'Invalidation.Id' \
    --output text)"

printf '==> Waiting for invalidation %s\n' "$invalidation"
aws cloudfront wait invalidation-completed \
    --distribution-id "$distribution" \
    --id "$invalidation"

# Readiness gate: the page is only useful if the API behind it answers and the
# deadline has not passed. This catches a missing Lambda permission, an OAC
# misconfiguration or a mistyped deadline before a guest scans the QR code.
printf '==> Checking that uploads are open\n'
config=""
for attempt in 1 2 3 4 5 6; do
    if config="$(curl -fsS --max-time 15 "$site_url/api/config")"; then
        break
    fi
    config=""
    printf '    attempt %d/6: /api/config not answering yet; retrying in 10s\n' "$attempt"
    sleep 10
done

[[ -n "$config" ]] || die "$site_url/api/config does not answer — see README 'Troubleshooting'."
[[ "$config" == *'"open":true'* ]] \
    || die "API answers but uploads are closed: $config — check upload_deadline."

printf '==> Live and accepting uploads at %s\n' "$site_url"
printf '    Admin page: %s/admin/\n' "$site_url"
