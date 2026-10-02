#!/usr/bin/env bash
#
# Manages the admin logins for the memorial upload admin area (/admin/). Each admin has
# a username and a password; only a PBKDF2-SHA256 hash of the password is stored.
#
#   ./set-password.sh <username>              set or change a password (prompts)
#   ./set-password.sh <username> --generate   generate a password and print it once
#   ./set-password.sh <username> --owner      also allow this admin to delete uploads
#   ./set-password.sh --remove <username>     delete a login (ends that user's sessions)
#   ./set-password.sh --rotate-key            new session key (ends every session)
#
# Writes terraform/auth.auto.tfvars.json (loaded automatically, git-ignored), which
# holds the hashes and the session key. A session key is created on first use and kept
# afterwards, so adding or changing one user does not sign out the others. Apply with:
#   terraform -chdir=terraform apply

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
auth_file="$script_dir/terraform/auth.auto.tfvars.json"
legacy_file="$script_dir/terraform/auth.auto.tfvars"

die() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

usage() {
    sed -n '6,10p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
    exit 1
}

command -v openssl >/dev/null || die "openssl not found."
command -v node >/dev/null || die "node not found (Node.js 22 or later)."

action=set user="" generate=false owner=false
case "${1:-}" in
    --remove) action=remove user="${2:-}" ;;
    --rotate-key) action=rotate ;;
    ""|-*) usage ;;
    *)
        user="$1"
        for option in "${@:2}"; do
            case "$option" in
                --generate) generate=true ;;
                --owner) owner=true ;;
                *) usage ;;
            esac
        done
        ;;
esac
if [[ "$action" != rotate ]]; then
    user="$(printf '%s' "$user" | tr '[:upper:]' '[:lower:]')"
    [[ "$user" =~ ^[a-z0-9-]{1,32}$ ]] || die "Username: 1–32 lowercase letters, digits or hyphens."
fi

password=""
if [[ "$action" == set ]]; then
    if $generate; then
        password="$(openssl rand -base64 18)"
    else
        printf 'Tip: generate a strong password with  %s %s --generate\n' "${BASH_SOURCE[0]}" "$user"
        # IFS= keeps leading and trailing spaces: the browser sends the password untrimmed.
        IFS= read -r -s -p "Password for $user: " password
        printf '\n'
        IFS= read -r -s -p "Confirm password: " confirm
        printf '\n'
        [[ "$password" == "$confirm" ]] || die "Passwords do not match."
        unset confirm
    fi
    (( ${#password} >= 12 )) || die "Use at least 12 characters — this is the only thing guarding the uploads."
fi

umask 077
# Hash format as hashPassword() in lambda/index.mjs. The password goes in on stdin, so
# it never appears in the process list. The file is replaced atomically.
printf '%s' "$password" | ACTION="$action" ADMIN_USER="$user" OWNER="$owner" AUTH_FILE="$auth_file" \
    SESSION_KEY_NEW="$(openssl rand -hex 32)" node -e '
    const fs = require("node:fs");
    const { pbkdf2Sync, randomBytes } = require("node:crypto");
    const { ACTION, ADMIN_USER, OWNER, AUTH_FILE, SESSION_KEY_NEW } = process.env;
    const auth = fs.existsSync(AUTH_FILE) ? JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) : {};
    auth.admin_users ??= {};
    auth.admin_owners ??= [];
    if (!auth.session_key || ACTION === "rotate") auth.session_key = SESSION_KEY_NEW;
    if (ACTION === "set") {
        const salt = randomBytes(16);
        const hash = pbkdf2Sync(fs.readFileSync(0), salt, 600000, 32, "sha256");
        auth.admin_users[ADMIN_USER] = `pbkdf2_sha256$600000$${salt.toString("hex")}$${hash.toString("hex")}`;
        if (OWNER === "true" && !auth.admin_owners.includes(ADMIN_USER)) auth.admin_owners.push(ADMIN_USER);
    } else if (ACTION === "remove") {
        if (!(ADMIN_USER in auth.admin_users)) { console.error(`error: no user ${ADMIN_USER}`); process.exit(1); }
        delete auth.admin_users[ADMIN_USER];
        auth.admin_owners = auth.admin_owners.filter((name) => name !== ADMIN_USER);
    }
    fs.writeFileSync(`${AUTH_FILE}.tmp`, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(`${AUTH_FILE}.tmp`, AUTH_FILE);
    console.error(`users: ${Object.keys(auth.admin_users).sort().join(", ") || "none"}`
        + ` · owners (may delete): ${auth.admin_owners.join(", ") || "none"}`);
'

# The single-password file from before per-user logins; its values are not used anymore.
if [[ -f "$legacy_file" ]]; then
    rm -f "$legacy_file"
    printf 'Removed the old single-password file %s\n' "$legacy_file"
fi

if [[ "$action" == set ]] && $generate; then
    printf '\nPassword for %s (shown once — send it privately):\n\n    %s\n\n' "$user" "$password"
fi
unset password

printf 'Wrote %s\n' "$auth_file"
printf 'Next: terraform -chdir=%s/terraform apply\n' "$script_dir"
