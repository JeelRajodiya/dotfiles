#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname)"
echo "Starting installation on $OS..."

if [ "$OS" = "Linux" ]; then
    sudo apt-get install -y software-properties-common
    sudo add-apt-repository ppa:zhangsongcui3371/fastfetch
    sudo apt-get update
    sudo apt-get full-upgrade -y
    sudo apt-get install -y \
        7zip \
        bat \
        build-essential \
        cheese \
        cmatrix \
        curl \
        dconf-cli \
        eza \
        fastfetch \
        fd-find \
        ffmpeg \
        file \
        fzf \
        git \
        glow \
        gnome-calculator \
        golang \
        imagemagick \
        jq \
        libssl-dev \
        net-tools \
        poppler-utils \
        procps \
        ripgrep \
        stow \
        tmux \
        unzip \
        wget \
        xournalpp \
        zoxide \
        zsh

    [ -f /usr/bin/batcat ] && sudo ln -sf /usr/bin/batcat /usr/local/bin/bat
    [ -f /usr/bin/fdfind ] && sudo ln -sf /usr/bin/fdfind /usr/local/bin/fd

    # Install Starship prompt.
    curl -sS https://starship.rs/install.sh | sh
    # Install pyenv for Python version management.
    curl -fsSL https://pyenv.run | bash
    # Install Television fuzzy finder.
    curl -fsSL https://alexpasmantier.github.io/television/install.sh | bash
    # Install Atuin shell history.
    curl --proto '=https' --tlsv1.2 -LsSf https://setup.atuin.sh | sh
    # Install uv for Python command-line tools.
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"

    # Install Rust before building Yazi.
    if ! command -v cargo &>/dev/null; then
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        . "$HOME/.cargo/env"
    fi
    cargo install --locked yazi-fm yazi-cli

    # Install Kitty from its official installer.
    curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin
    mkdir -p "$HOME/.local/bin"
    ln -sf "$HOME/.local/kitty.app/bin/kitty" "$HOME/.local/kitty.app/bin/kitten" "$HOME/.local/bin/"
elif [ "$OS" = "Darwin" ]; then
    # Install Homebrew when it is not already available.
    if ! command -v brew &>/dev/null; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    brew update
    brew upgrade
    brew bundle --file="$REPO_DIR/packages/Brewfile"

    # Install Rust; the remaining macOS tools come from the Brewfile.
    if ! command -v cargo &>/dev/null; then
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        . "$HOME/.cargo/env"
    fi
else
    echo "Unsupported OS: $OS" >&2
    exit 1
fi

uv tool install graphifyy

# Install NVM and the current Node.js release.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash

# Install Oh My Zsh without opening an interactive shell.
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/robbyrussell/oh-my-zsh/master/tools/install.sh)" "" --unattended
fi

# Install the configured Oh My Zsh plugins when missing.
ZSH_CUSTOM=${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}
[ -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ] || git clone https://github.com/zsh-users/zsh-autosuggestions.git "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
[ -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ] || git clone https://github.com/zsh-users/zsh-syntax-highlighting.git "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"

# Load NVM, install Node.js, and add the global JavaScript tools.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if command -v nvm &>/dev/null; then
    nvm install node
    npm install -g pnpm bun
else
    echo "NVM failed to install or load. Skipping npm packages."
fi

# Import existing shell history when Atuin is available.
command -v atuin >/dev/null && atuin import auto || true

# Install Tmux Plugin Manager; TPM installs plugins declared in tmux.conf.
if [ ! -d "$HOME/.config/tmux/plugins/tpm" ]; then
    git clone https://github.com/tmux-plugins/tpm "$HOME/.config/tmux/plugins/tpm"
fi

echo "Installation finished."
echo "Install Nerd Fonts manually, then run bin/sync.sh."
