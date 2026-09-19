#    _               _
#   | |__   __ _ ___| |__  _ __ ___
#   | '_ \ / _` / __| '_ \| '__/ __|
#  _| |_) | (_| \__ \ | | | | | (__
# (_)_.__/ \__,_|___/_| |_|_|  \___|
#
# by Stephan Raabe (2023)
# -----------------------------------------------------
# ~/.bashrc
# -----------------------------------------------------

# Load shared profile first so env vars (PATH, NVM_DIR, etc.) are present
# even in non-interactive bash (`bash -c …`). The profile has its own
# interactive guard for aliases/prompt.
[[ -f ~/.profile ]] && source ~/.profile

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

# =====================================================
# PATH
# =====================================================

# bash-specific PATH additions
export PATH="/usr/lib/ccache/bin/:$PATH"

# =====================================================
# Prompt
# =====================================================

# -----------------------------------------------------
# START STARSHIP
# -----------------------------------------------------
eval "$(starship init bash)"

# =====================================================
# Tool integrations
# =====================================================

# NVM lazy load (NVM_DIR set in .profile) — mirrors the zsh setup.
nvm() {
    unset -f nvm
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" --no-use
    nvm "$@"
}
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# =====================================================
# ALIASES
# =====================================================

# -----------------------------------------------------
# Window Managers
# -----------------------------------------------------
alias Qtile='startx'

# -----------------------------------------------------
# GIT
# -----------------------------------------------------
alias gcredential="git config credential.helper store"

# -----------------------------------------------------
# SCRIPTS
# -----------------------------------------------------
alias ChatGPT='python ~/mychatgpt/mychatgpt.py'
alias chat='python ~/mychatgpt/mychatgpt.py'

# -----------------------------------------------------
# VIRTUAL MACHINE
# -----------------------------------------------------
alias vm='~/private/launchvm.sh'

# -----------------------------------------------------
# SCREEN RESOLUTIONS (Qtile)
# -----------------------------------------------------
alias res1='xrandr --output DisplayPort-0 --mode 2560x1440 --rate 120'
alias res2='xrandr --output DisplayPort-0 --mode 1920x1080 --rate 120'

# -----------------------------------------------------
# DEVELOPMENT
# -----------------------------------------------------
alias dotsync="~/dotfiles-versions/dotfiles/.dev/sync.sh dotfiles"

# =====================================================
# Greeting
# =====================================================

# -----------------------------------------------------
# PFETCH if on wm
# -----------------------------------------------------
echo ""
if [[ $(tty) == *"pts"* ]]; then
    fastfetch
else
    if [ -f /bin/qtile ]; then
        echo "Start Qtile X11 with command Qtile"
    fi
    if [ -f /bin/hyprctl ]; then
        echo "Start Hyprland with command Hyprland"
    fi
fi

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"


# Added by Antigravity CLI installer
export PATH="/Users/zeelrajodiya/.local/bin:$PATH"
