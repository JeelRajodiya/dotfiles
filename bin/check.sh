#!/usr/bin/env bash
# Typecheck the Pi extensions and run the tests under tests/.
#
# Pi loads the extension .ts sources directly, so nothing is built and nothing catches a
# mistake before the TUI hits it at runtime. This is that check.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Pi's packages live in the global npm root. Link them in so both the editor LSP and tsc can
# resolve `@earendil-works/*` from this repo; node_modules/ is gitignored.
link_pi_packages() {
	local global_root pi_pkg
	global_root="$(npm root -g 2>/dev/null || true)"
	pi_pkg="$global_root/@earendil-works/pi-coding-agent"
	[ -d "$pi_pkg" ] || { echo "pi-coding-agent not found under $global_root" >&2; return 1; }

	mkdir -p node_modules/@earendil-works
	ln -sfn "$pi_pkg" node_modules/@earendil-works/pi-coding-agent
	for name in pi-ai pi-tui pi-agent-core; do
		local nested="$pi_pkg/node_modules/@earendil-works/$name"
		[ -d "$nested" ] || nested="$global_root/@earendil-works/$name"
		[ -d "$nested" ] && ln -sfn "$nested" "node_modules/@earendil-works/$name"
	done
	local typebox="$pi_pkg/node_modules/typebox"
	if [ -d "$typebox" ]; then
		mkdir -p node_modules/@sinclair
		ln -sfn "$typebox" node_modules/@sinclair/typebox
	fi
	# Pi bundles its own @types/node; reuse it rather than making this repo carry a dependency.
	local node_types="$pi_pkg/node_modules/@types/node"
	if [ -d "$node_types" ]; then
		mkdir -p node_modules/@types
		ln -sfn "$node_types" node_modules/@types/node
	fi
}

link_pi_packages

failed=0

if command -v tsc >/dev/null 2>&1; then
	tsc_cmd=(tsc)
elif [ -x node_modules/.bin/tsc ]; then
	tsc_cmd=(node_modules/.bin/tsc)
else
	tsc_cmd=()
fi

if [ ${#tsc_cmd[@]} -gt 0 ]; then
	echo "── typecheck ──"
	if "${tsc_cmd[@]}" -p tsconfig.json; then
		echo "typecheck OK"
	else
		failed=1
	fi
else
	echo "── typecheck skipped (no tsc; run: npm i -g typescript) ──"
fi

echo "── tests ──"
for test in tests/*.test.ts; do
	[ -e "$test" ] || continue
	if node --experimental-strip-types "$test" >/tmp/pi-check-$$.log 2>&1; then
		echo "PASS $test"
	else
		echo "FAIL $test"
		sed 's/^/      /' /tmp/pi-check-$$.log | head -12
		failed=1
	fi
	rm -f /tmp/pi-check-$$.log
done

for script in tests/*.sh; do
	[ -e "$script" ] || continue
	if bash "$script" >/dev/null 2>&1; then echo "PASS $script"; else echo "FAIL $script"; failed=1; fi
done

[ "$failed" -eq 0 ] && echo "all checks passed"
exit "$failed"
