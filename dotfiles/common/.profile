#    _ __  _ __ ___  / _(_) | ___
#   | '_ \| '__/ _ \| |_| | |/ _ \
#  _| |_) | | | (_) |  _| | |  __/
# (_) .__/|_|  \___/|_| |_|_|\___|
#   |_|

# =====================================================
# ENVIRONMENT — runs in all shells (interactive or not)
# =====================================================

# -----------------------------------------------------
# PATH: base directories
# -----------------------------------------------------
export PATH="$HOME/.local/bin:$PATH"
export PATH="/usr/local/bin:$PATH"
export PATH="/opt/homebrew/bin:$PATH"
export PATH="/opt/homebrew/opt/sqlite/bin:$PATH"

# -----------------------------------------------------
# Language runtimes
# -----------------------------------------------------

# NVM (loader lives in shell rc files; only the dir is exported here)
export NVM_DIR="$HOME/.nvm"

# Pin default Node version in PATH. Override by setting DEFAULT_NODE_VER
# to a version prefix like "20" or "v18.17"; unset = highest installed.
_default_node="$(find "$NVM_DIR/versions/node" -maxdepth 1 -name "v${DEFAULT_NODE_VER#v}*" 2>/dev/null | sort -rV | head -n 1)"
[ -n "$_default_node" ] && export PATH="$_default_node/bin:$PATH"
unset _default_node

# pnpm
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

# Bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Pyenv
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"

# Go (no fork; default GOPATH is $HOME/go per Go convention)
export PATH="$PATH:${GOPATH:-$HOME/go}/bin"

# SDKMAN
export SDKMAN_DIR="$HOME/.sdkman"

# Java — guard against empty JAVA_HOME producing a stray ":/bin"
[ -n "$JAVA_HOME" ] && export PATH="$PATH:$JAVA_HOME/bin"

# -----------------------------------------------------
# Tool configuration
# -----------------------------------------------------

# ripgrep config path
export RIPGREP_CONFIG_PATH="$HOME/.config/.ripgreprc"

# Only load MCP servers declared in Pi's global MCP config.
export PI_MCP_CONFIG_MODE=exclusive

# fzf: exhaustive search — hidden files, gitignored paths, and .git contents included
export FZF_DEFAULT_COMMAND='fd --type f --hidden --no-ignore --follow'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_ALT_C_COMMAND='fd --type d --hidden --no-ignore --follow'

# -----------------------------------------------------
# Secrets / tokens
# -----------------------------------------------------

# GitHub token for Claude Code (cached to avoid forking `gh` per shell).
# Refreshes after 24h, or delete ~/.cache/gh_token to force a refresh
# (e.g. after `gh auth login`).
if command -v gh >/dev/null 2>&1; then
    _gh_cache="$HOME/.cache/gh_token"
    if [ ! -f "$_gh_cache" ] || [ -n "$(find "$_gh_cache" -mmin +1440 2>/dev/null)" ]; then
        mkdir -p "$(dirname "$_gh_cache")"
        gh auth token 2>/dev/null >"$_gh_cache"
        chmod 600 "$_gh_cache"
    fi
    [ -s "$_gh_cache" ] && export GITHUB_PERSONAL_ACCESS_TOKEN="$(cat "$_gh_cache")"
    unset _gh_cache
fi

# =====================================================
# Interactive shell guard — everything below runs only
# in interactive shells
# =====================================================

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

# -----------------------------------------------------
# Editor / Browser
# -----------------------------------------------------

# Define Editor
export EDITOR=nvim
export BROWSER=google-chrome-stable

# -----------------------------------------------------
# Interactive tool config
# -----------------------------------------------------

# Starship prompt config
export STARSHIP_CONFIG="$HOME/.config/starship/starship.toml"

# Docker
export DOCKER_HOST=unix:///var/run/docker.sock

# Load only GEMINI_API_KEY from .env, without leaking other variables.
# Zero-fork: read line-by-line, split on '=', strip surrounding quotes.
if [ -f "$HOME/.env" ]; then
    while IFS='=' read -r _k _v; do
        [ "$_k" = "GEMINI_API_KEY" ] || continue
        _v=${_v#\"}
        _v=${_v%\"}
        export GEMINI_API_KEY="$_v"
        break
    done <"$HOME/.env"
    unset _k _v
fi

# -----------------------------------------------------
# Terminal tweaks
# -----------------------------------------------------

# fix kitty on ssh
[ "$TERM" = "xterm-kitty" ] && export TERM=xterm-256color

# Set blinking underline cursor (only when not in Neovim)
if [ "$TERM" = "xterm-256color" ] && [ -z "$VIM" ]; then
    echo -ne '\e[3 q'
fi

# -----------------------------------------------------
# Cargo (Rust)
# -----------------------------------------------------
. "$HOME/.cargo/env"

# =====================================================
# ALIASES
# =====================================================

# -----------------------------------------------------
# Basics & navigation
# -----------------------------------------------------
alias c='clear'
alias e='exit'
alias q='exit'
alias h='history'
alias hg='history | rg'

alias ls='eza  --icons'
alias ll='eza -l --icons'
alias la='eza -a --icons'
alias lla='eza -al --icons'
lt() {
    local level=${1:-1}
    eza -a --tree --level="$level" --icons
}

alias cpwd="pwd | tr -d '\n' | xclip -sel clip && echo 'pwd copied to clipboard'"
alias copy='xclip -selection clipboard'

# -----------------------------------------------------
# Shell / Python
# -----------------------------------------------------
alias source_venv='source venv/bin/activate'

# -----------------------------------------------------
# Tool shortcuts
# -----------------------------------------------------
alias bat='bat --theme=base16'
alias fd='fd --hidden'
alias fzf='fzf --preview="bat --theme=base16 -n  --color=always --style=header,grid --line-range :500 {}"'
alias ivm='f() { local file; file=$(tv); [ -n "$file" ] && "$EDITOR" "$file"; }; f'

# -----------------------------------------------------
# System info (fetchers)
# -----------------------------------------------------
alias nf='neofetch'
alias pf='pfetch'
alias ff='fastfetch'
alias cf='c && fastfetch'

# -----------------------------------------------------
# Editor shortcut
# -----------------------------------------------------
alias v='$EDITOR'
alias vim='$EDITOR'

# -----------------------------------------------------
# App launchers
# -----------------------------------------------------
alias ltspice='ltspice --enable-features=UseOzonePlatform --ozone-platform=wayland'
alias cursor='/opt/cursor.appimage --no-sandbox >/dev/null 2>&1 & disown'
alias obsidian='setsid obsidian --enable-features=UseOzonePlatform --ozone-platform=wayland'
alias obsi='setsid obsidian --enable-features=UseOzonePlatform --ozone-platform=wayland && exit -f'
alias thunar='setsid thunar'
alias files='setsid $BROWSER'
alias matrix='cmatrix -u 2'

# -----------------------------------------------------
# System control
# -----------------------------------------------------
alias shutdown='systemctl poweroff'
alias wifi='nmtui'
alias update_all='sudo apt update && sudo apt full-upgrade'
alias update-grub='sudo grub-mkconfig -o /boot/grub/grub.cfg'
alias setkb='setxkbmap us;echo "Keyboard set back to us."'
alias battery='upower -i /org/freedesktop/UPower/devices/battery_BAT0 | cat'
alias prime-run='env __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia'
netrs() {
    sudo systemctl restart NetworkManager && echo "NetworkManager restarted."
    # sudo systemctl restart iwd && echo "iwd restarted."
}

# -----------------------------------------------------
# Disk / mount
# -----------------------------------------------------
alias D='cd /media/zeel/D'
fixD() {
    sudo umount /media/zeel/D && echo "Disk unmounted."
}

# -----------------------------------------------------
# Dotfiles / scripts shortcuts
# -----------------------------------------------------
alias dot="cd ~/.config"
alias winclass="xprop | grep 'CLASS'"

# -----------------------------------------------------
# Misc / work
# -----------------------------------------------------
alias od='~/private/onedrive.sh'
alias pj='cd "/media/zeel/Local Disc 1/languages"'

# -----------------------------------------------------
# GIT
# -----------------------------------------------------
alias gs="git status"
alias ga="git add"
alias gc="git commit -m"
alias gp="git push"
alias gpl="git pull"
alias gst="git stash"
alias gsp="git stash; git pull"
alias lg='lazygit'
alias gcheck="git checkout"
alias glog="git log --graph --abbrev-commit --decorate --format=format:'%C(bold blue)%h%C(reset) - %C(bold green)(%ar)%C(reset) %C(white)%s%C(reset) %C(dim white)- %an%C(reset)%C(auto)%d%C(reset)' --all"
ghcs() {
    gh copilot suggest "$1"
}

# -----------------------------------------------------
# EDIT CONFIG FILES
# -----------------------------------------------------
alias confp='$EDITOR ~/.profile'
alias confb='$EDITOR ~/.bashrc'
alias confz='$EDITOR ~/.zshrc'
alias confn='$EDITOR ~/.config/nvim'

# -----------------------------------------------------
# EDIT NOTES
# -----------------------------------------------------
alias rough='$EDITOR ~/OneDrive/OneDrive\ Documents/notes/rough.md'
alias notes='cd ~/OneDrive/OneDrive\ Documents/notes && zed .'
alias notes-path='cd ~/OneDrive/OneDrive\ Documents/notes'
alias general='$EDITOR ~/OneDrive/OneDrive\ Documents/general.md'
alias bookmarks='$EDITOR ~/OneDrive/OneDrive\ Documents/bookmarks.md'

# =====================================================
# FUNCTIONS
# =====================================================

# -----------------------------------------------------
# Yazi file manager exit on quit:
# cd into the directory Yazi was in when you quit
# -----------------------------------------------------
function y() {
    local tmp="$(mktemp -t "yazi-cwd.XXXXXX")" cwd
    yazi "$@" --cwd-file="$tmp"
    if cwd="$(command cat -- "$tmp")" && [ -n "$cwd" ] && [ "$cwd" != "$PWD" ]; then
        builtin cd -- "$cwd"
    fi
    rm -f -- "$tmp"
}

# -----------------------------------------------------
# e6data engine
# -----------------------------------------------------
[ -f /Users/zeelrajodiya/Projects/e6data/scripts/run.sh ] && alias engine='/Users/zeelrajodiya/Projects/e6data/scripts/run.sh'

# Added by Antigravity CLI installer
export PATH="/Users/zeelrajodiya/.local/bin:$PATH"
