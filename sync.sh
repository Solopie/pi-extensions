#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
target="${HOME:?HOME must be set}/.pi/agent/extensions"

# Refuse real directories/files and symlinks that do not point to a directory.
# Check before mkdir or any other filesystem changes.
if [[ -e "$target" || -L "$target" ]]; then
    if [[ ! -L "$target" || ! -d "$target" ]]; then
        printf 'Error: %s already exists and is not a directory symlink; nothing changed.\n' "$target" >&2
        exit 1
    fi

    if [[ "$(cd -- "$target" && pwd -P)" == "$repo_dir" ]]; then
        printf 'Already linked: %s -> %s\n' "$target" "$repo_dir"
        exit 0
    fi

    # Replace only the symlink, never its destination directory.
    ln -sfnT -- "$repo_dir" "$target"
else
    mkdir -p -- "$(dirname -- "$target")"
    ln -sT -- "$repo_dir" "$target"
fi

printf 'Linked: %s -> %s\n' "$target" "$repo_dir"
