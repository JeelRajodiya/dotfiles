#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../dotfiles" && pwd)"
packages=(common agents)

case "$(uname)" in
    Linux) packages+=(linux) ;;
    Darwin) packages+=(macos) ;;
    *) echo "Unsupported OS: $(uname)" >&2; exit 1 ;;
esac

command -v stow >/dev/null || {
    echo "GNU Stow is required. Run bin/bootstrap.sh first." >&2
    exit 1
}

# Remove dangling or obsolete symlinks pointing to this repo before stowing
while IFS= read -r -d '' link; do
    target="$(readlink "$link")"
    case "$target" in
        "$DOTFILES_DIR"/*|*linuxConfig/dotfiles*|*linuxConfig/ubuntu*)
            if [ ! -e "$link" ]; then
                rm "$link"
            fi
            ;;
    esac
done < <(
    find "$HOME" -maxdepth 1 -type l -print0
    for dir in .ssh .config .agents .claude .codex .pi "Library/Application Support/k9s" "Library/Application Support/lazygit"; do
        [ ! -d "$HOME/$dir" ] || find "$HOME/$dir" -maxdepth 2 -type l -print0
    done
    [ ! -L "$HOME/.local/share/plasma" ] || printf '%s\0' "$HOME/.local/share/plasma"
)

stow --no-folding --dir="$DOTFILES_DIR" --target="$HOME" "${packages[@]}"
echo "Already linked: ${packages[*]}"

