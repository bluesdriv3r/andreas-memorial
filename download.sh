#!/usr/bin/env bash
#
# Downloads every guest upload into a local folder for the slideshow and converts
# HEIC/HEIF photos to JPEG with macOS `sips`. Safe to re-run: `aws s3 sync` only
# fetches new files, and photos that already have a JPEG are not converted again.
#
#   moon run memorial:download -- ~/Desktop/slideshow
#   ./download.sh ~/Desktop/slideshow
#
# Converted originals move to <folder>/_heic-originals/ so the slideshow folder
# contains only formats most slideshow tools can show. Needs AWS credentials with read access
# to the uploads bucket (the admin profile you deployed with).

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tf_dir="$project_dir/terraform"
target="${1:-$HOME/Desktop/slideshow}"

die() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

command -v aws >/dev/null || die "aws CLI not found. brew install awscli"
command -v terraform >/dev/null || die "terraform not found. brew install terraform"
[[ -f "$tf_dir/terraform.tfstate" ]] || die "No Terraform state — deploy first."

bucket="$(terraform -chdir="$tf_dir" output -raw uploads_bucket)"
originals="$target/_heic-originals"
mkdir -p "$target"

export AWS_RETRY_MODE=standard
export AWS_MAX_ATTEMPTS=10

printf '==> Syncing s3://%s/uploads/ to %s\n' "$bucket" "$target"
# Converted originals live in _heic-originals/, so excluding the HEIC files at the
# top level stops every re-run from downloading them again.
aws s3 sync "s3://$bucket/uploads/" "$target/" \
    --exclude '_heic-originals/*' \
    --exclude '*.heic' --exclude '*.heif' --exclude '*.HEIC' --exclude '*.HEIF'
aws s3 sync "s3://$bucket/uploads/" "$originals/" \
    --exclude '*' \
    --include '*.heic' --include '*.heif' --include '*.HEIC' --include '*.HEIF'

converted=0
if command -v sips >/dev/null; then
    shopt -s nullglob nocaseglob
    for original in "$originals"/*.heic "$originals"/*.heif; do
        jpeg="$target/$(basename "${original%.*}").jpg"
        [[ -f "$jpeg" ]] && continue
        sips -s format jpeg "$original" --out "$jpeg" >/dev/null
        converted=$((converted + 1))
    done
    shopt -u nullglob nocaseglob
else
    printf '    sips not found (not macOS?) — HEIC files left unconverted in %s\n' "$originals"
fi

count="$(find "$target" -maxdepth 1 -type f ! -name '.*' | wc -l | tr -d ' ')"
printf '==> %s files ready in %s (%d HEIC converted this run)\n' "$count" "$target" "$converted"
