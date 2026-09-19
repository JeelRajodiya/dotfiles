My personal Linux and macOS configuration, originally forked from [Codesmith28/archConfig](https://github.com/Codesmith28/archConfig).

## Highlight: PI Agent Configurations 

<img width="2056" height="1222" alt="image" src="https://github.com/user-attachments/assets/8d153208-eda3-4678-b699-abbd6b01c402" />


Find it in [`/agents/.pi`](https://github.com/JeelRajodiya/environment/tree/2026/dotfiles/agents/.pi) 



## Setup

GNU Stow links the repository into `$HOME` without replacing conflicting files.

```bash
git clone https://github.com/JeelRajodiya/dotfiles.git ~/dotfiles
cd ~/dotfiles

bash bin/bootstrap.sh
bash bin/sync.sh
```

On Linux, optional machine setup lives under `system/linux/`:

```bash
bash system/linux/fonts/install.sh
bash system/linux/plasma/install-plugins.sh
bash system/linux/systemd/install.sh
```

## Structure

```text
bin/
  bootstrap.sh        Install packages and command-line tools
  sync.sh             Link dotfiles with GNU Stow
dotfiles/
  common/             Portable files mirroring $HOME
  agents/             Claude, Codex, OpenCode, and Pi configuration
  linux/              KDE and Plasma files mirroring $HOME
  macos/              macOS-specific paths
packages/
  Brewfile            macOS packages
  linux.txt           Reference list of manually installed Linux packages
system/linux/
  docker/             Docker installation
  fingerprint/        Fingerprint setup
  fonts/              Fontconfig setup
  grub/               GRUB helpers
  plasma/             Plasma setup helpers
  systemd/            System and user units
```

Tmux plugins are declared in `.config/tmux/tmux.conf` and installed by TPM rather than stored in this repository. Yazi plugins, flavors, Plasma themes, and the fingerprint driver package remain vendored.
