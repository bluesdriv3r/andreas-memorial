#!/usr/bin/env bash
#
# Post-deploy verification for the memorial upload page.
#
# The public and negative checks need no credentials and always run. With the admin
# password it also logs in, checks the admin pages, performs one real end-to-end
# multipart upload (uploader "verify-sh"), including a part of the wrong length that
# S3 must refuse, and logs out again. The test object is removed again when AWS
# credentials are available.
#
#   moon run memorial:verify
#   MEMORIAL_USER='…' MEMORIAL_PASSWORD='…' moon run memorial:verify
#
# Exits non-zero if any check fails.

set -euo pipefail

tf_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/terraform"
fails=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s — %s\n' "$1" "$2"; fails=$((fails + 1)); }
info() { printf '  ....  %s\n' "$1"; }

command -v curl >/dev/null || { echo "curl not found." >&2; exit 1; }
[[ -f "$tf_dir/terraform.tfstate" ]] || { echo "No Terraform state — deploy first." >&2; exit 1; }

tf_out() { terraform -chdir="$tf_dir" output -raw "$1"; }
url="$(tf_out site_url)"
site_bucket="$(tf_out site_bucket)"
uploads_bucket="$(tf_out uploads_bucket)"
region="$(tf_out aws_region)"
function_url="$(tf_out function_url)"

status() { curl -so /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo 000; }

# check <label> <comma-separated acceptable codes> <curl args...>
check() {
    local label=$1 expect=$2 got
    shift 2
    got="$(status "$@")"
    if [[ ",$expect," == *",$got,"* ]]; then
        pass "$label [$got]"
    else
        fail "$label" "expected $expect, got $got"
    fi
}

# redirects_to_login <label> <curl args...> — expects a 302 to the login page.
redirects_to_login() {
    local label=$1 got
    shift
    got="$(curl -so /dev/null -w '%{http_code} %header{location}' --max-time 20 "$@" 2>/dev/null || echo 000)"
    if [[ "$got" == "302 /login/index.html?next="* ]]; then
        pass "$label [302 → login]"
    else
        fail "$label" "expected 302 to the login page, got $got"
    fi
}

sha256() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }

# post_api <path> <json body> — POST to the guest API with the body hash OAC requires.
post_api() {
    curl -sS --max-time 20 -X POST "$url$1" \
        -H 'content-type: application/json' \
        -H "x-amz-content-sha256: $(sha256 "$2")" \
        --data-raw "$2"
}

printf '==> Target: %s\n\n' "$url"

printf 'Guest side\n'
check "guest page"                  200 "$url/"
check "page stylesheet"             200 "$url/stylesheets/colors.css"
config="$(curl -fsS --max-time 20 "$url/api/config" 2>/dev/null || echo '')"
if [[ "$config" == *'"open":true'* ]]; then
    pass "/api/config reports uploads open"
else
    fail "/api/config" "expected \"open\":true, got ${config:-no response}"
fi

# The page must not make guests' browsers contact Google (fonts are self-hosted).
if curl -fsS --max-time 20 "$url/" | grep -qE 'fonts\.(googleapis|gstatic)\.com'; then
    fail "no third-party font requests" "the guest page still references Google Fonts"
else
    pass "no third-party font requests"
fi

oversize='{"files":[{"name":"big.jpg","type":"image/jpeg","size":999999999999}]}'
check "oversized file refused"      400 -X POST "$url/api/upload" -H 'content-type: application/json' \
    -H "x-amz-content-sha256: $(sha256 "$oversize")" --data-raw "$oversize"
notmedia='{"files":[{"name":"x.exe","type":"application/octet-stream","size":10}]}'
check "non-media file refused"      400 -X POST "$url/api/upload" -H 'content-type: application/json' \
    -H "x-amz-content-sha256: $(sha256 "$notmedia")" --data-raw "$notmedia"

forged='{"key":"uploads/../index.html","uploadId":"x","size":10}'
check "complete with forged key refused" 400 -X POST "$url/api/upload/complete" -H 'content-type: application/json' \
    -H "x-amz-content-sha256: $(sha256 "$forged")" --data-raw "$forged"
# Without the body hash, CloudFront's signature to Lambda cannot match.
check "POST without body hash refused" 403 -X POST "$url/api/upload" -H 'content-type: application/json' \
    --data-raw "$notmedia"

printf '\nAdmin boundary (no session)\n'
for path in /admin /admin/ /admin/index.html /admin/gallery/ /admin/files/x.jpg; do
    redirects_to_login "$path" "$url$path"
done
check "/admin/api/list"             401 "$url/admin/api/list"
forged_cookie="__Host-mem_admin=markus.$(( $(date +%s) + 3600 )).$(printf '0%.0s' {1..64})"
redirects_to_login "forged session cookie" -b "$forged_cookie" "$url/admin/gallery/"
check "forged cookie on API"        401 -b "$forged_cookie" "$url/admin/api/list"
redirects_to_login "old Basic Auth header" -u 'user:password' "$url/admin/"
check "login page"                  200 "$url/login/index.html"
wrong='{"username":"nobody","password":"definitely-not-the-password"}'
check "wrong password rejected"     401 -X POST "$url/api/login" -H 'content-type: application/json' \
    -H "x-amz-content-sha256: $(sha256 "$wrong")" --data-raw "$wrong"
# The guest API must not expose admin routes or the bucket.
check "/api/admin/list not routed"  404 "$url/api/admin/list"
check "/uploads/ not public"        403,404 "$url/uploads/x.jpg"

printf '\nOrigin isolation and transport\n'
check "site bucket not reachable directly"    403 "https://$site_bucket.s3.$region.amazonaws.com/index.html"
check "uploads bucket not listable"           403 "https://$uploads_bucket.s3.$region.amazonaws.com/"
check "Lambda URL not reachable directly"     403 "${function_url}api/config"
check "HTTP redirects to HTTPS"               301 "${url/https:/http:}/"
for header in strict-transport-security x-content-type-options content-security-policy; do
    if curl -sI --max-time 20 "$url/" | tr -d '\r' | grep -qi "^$header:"; then
        pass "$header sent"
    else
        fail "$header sent" "header missing"
    fi
done

printf '\nAdmin side and end-to-end upload\n'
user="${MEMORIAL_USER:-}"
password="${MEMORIAL_PASSWORD:-}"
# Prompt only when both streams are a terminal; under a task runner the prompt
# would be invisible while `read` blocked.
if [[ -z "$user" && -t 0 && -t 1 ]]; then
    printf '  admin username (blank to skip) > '
    read -r -t 120 user || true
fi
if [[ -n "$user" && -z "$password" && -t 0 && -t 1 ]]; then
    printf '  admin password > '
    IFS= read -rs -t 120 password || true
    printf '\n'
fi

if [[ -z "$user" || -z "$password" ]]; then
    info "skipped — no username or password supplied"
elif ! command -v node >/dev/null; then
    info "skipped — node is needed to build the login request and parse the upload grant"
else
    # The session cookie and the login body live only in these temporary files
    # (mktemp: mode 600), so the password never appears in a process list.
    jar="$(mktemp -t memorial-verify-jar)"
    login_body="$(mktemp -t memorial-verify-login)"
    probe="$(mktemp -t memorial-verify)"
    longer="$(mktemp -t memorial-verify-long)"
    trap 'rm -f "$jar" "$login_body" "$probe" "$longer"' EXIT

    # JSON-encode the password via stdin, so quotes or backslashes in it cannot break the body.
    printf '%s' "$password" | ADMIN_USER="$user" node -e '
        const password = require("node:fs").readFileSync(0, "utf8");
        process.stdout.write(JSON.stringify({ username: process.env.ADMIN_USER, password, next: "/admin/gallery/" }));
    ' | tail -n 1 > "$login_body"
    unset password
    started=$(date +%s)
    check "login"               200 -c "$jar" -X POST "$url/api/login" -H 'content-type: application/json' \
        -H "x-amz-content-sha256: $(shasum -a 256 < "$login_body" | cut -d' ' -f1)" \
        --data-binary @"$login_body"
    rm -f "$login_body"
    info "login took $(( $(date +%s) - started )) s (PBKDF2; raise the Lambda memory if well above 3 s)"
    check "admin page"          200 -b "$jar" "$url/admin/"
    check "gallery page"        200 -b "$jar" "$url/admin/gallery/"
    check "admin list"          200 -b "$jar" "$url/admin/api/list"

    # A few bytes are enough: S3 checks the signed length, not the image. The test
    # object is removed again below when AWS credentials are available.
    printf 'memorial-upload verify.sh test object\n' > "$probe"
    printf 'memorial-upload verify.sh test object, one part too long\n' > "$longer"
    size="$(wc -c < "$probe" | tr -d ' ')"

    grant="$(post_api /api/upload \
        "{\"uploader\":\"verify-sh\",\"files\":[{\"name\":\"verify.jpg\",\"type\":\"image/jpeg\",\"size\":$size}]}")"
    # key, uploadId and the one part URL, one per line.
    fields=()
    while IFS= read -r line; do fields+=("$line"); done < <(node -e '
        const u = JSON.parse(process.argv[1]).uploads[0];
        console.log(u.key); console.log(u.uploadId); console.log(u.parts[0].url);
    ' "$grant" 2>/dev/null)

    if (( ${#fields[@]} != 3 )); then
        fail "upload grant" "unexpected response: $grant"
    else
        key="${fields[0]}" upload_id="${fields[1]}" part_url="${fields[2]}"
        target="{\"key\":\"$key\",\"uploadId\":\"$upload_id\",\"size\":$size}"

        # The part URL signs Content-Length: a body of any other size must be refused.
        check "part with wrong length refused by S3" 403 -X PUT --upload-file "$longer" "$part_url"
        check "part upload to S3"                     200 -X PUT --upload-file "$probe" "$part_url"
        check "complete assembles the object"         200 -X POST "$url/api/upload/complete" \
            -H 'content-type: application/json' -H "x-amz-content-sha256: $(sha256 "$target")" \
            --data-raw "$target"

        if curl -fsS --max-time 20 -b "$jar" "$url/admin/api/list" | grep -q "${key#uploads/}"; then
            pass "uploaded file appears in admin list"
            check "original served with session" 200 -b "$jar" "$url/admin/files/${key#uploads/}"
            if command -v aws >/dev/null && aws s3 rm "s3://$uploads_bucket/$key" >/dev/null 2>&1; then
                info "test object removed again"
            else
                info "remove the test object: aws s3 rm s3://$uploads_bucket/$key"
            fi
        else
            fail "uploaded file appears in admin list" "${key#uploads/} not listed"
        fi
    fi

    # Logout clears the cookie in the jar; the admin area must be closed again.
    check "logout"              303 -b "$jar" -c "$jar" "$url/api/logout"
    redirects_to_login "gallery after logout" -b "$jar" "$url/admin/gallery/"
    check "admin list after logout" 401 -b "$jar" "$url/admin/api/list"
fi

printf '\n'
if (( fails == 0 )); then
    printf '==> All checks passed.\n'
else
    printf '==> %d check(s) FAILED.\n' "$fails"
    exit 1
fi
