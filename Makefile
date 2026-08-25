UUID    := aerial-wallpapers@michael-d-murray.com
POT_DIR := src/po
POT_FILE := $(POT_DIR)/$(UUID).pot

# `make pack` builds the same zip the release workflow publishes.
PACK_DIR := .build-pack
STAGING  := staging
DIST     := dist
ZIP      := $(DIST)/$(UUID).shell-extension.zip
EXT_DIR  := $(CURDIR)/$(STAGING)/usr/share/gnome-shell/extensions/$(UUID)

.PHONY: build typecheck install pack clean enable disable prefs reset uninstall renderer log lint lint-fix pot merge-po help

help:
	@echo "Targets:"
	@echo "  build      Build the TypeScript sources"
	@echo "  typecheck  Type-check without emitting"
	@echo "  install    Build and install the extension"
	@echo "  pack       Build an installable .shell-extension.zip in dist/"
	@echo "  clean      Remove build artifacts (.build*, src/_build, staging, dist)"
	@echo "  enable     Enable the extension"
	@echo "  disable    Disable the extension"
	@echo "  prefs      Open the extension preferences"
	@echo "  reset      Reset the extension settings"
	@echo "  uninstall  Uninstall the extension"
	@echo "  renderer   Run the renderer (pass args via ARGS=...)"
	@echo "  log        Follow the GNOME Shell log"
	@echo "  lint       Run ESLint"
	@echo "  lint-fix   Run ESLint with --fix"
	@echo "  pot        Generate the translation template (.pot)"
	@echo "  merge-po   Merge updated .pot into all .po files"

node_modules: package-lock.json
	npm install
	@touch node_modules

build: node_modules
	npm run build

typecheck: node_modules
	npm run typecheck

install: build
	rm -rf .build
	rm -rf $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
	meson setup .build --prefix=$(HOME)/.local/ && ninja -C .build install

# Installing into a DESTDIR skips the post-install hook, so the bundled schema
# has to be compiled here for the zip to be usable straight out of the box.
pack: build
	rm -rf $(PACK_DIR) $(STAGING) $(DIST)
	meson setup $(PACK_DIR) --prefix=/usr
	DESTDIR="$(CURDIR)/$(STAGING)" meson install -C $(PACK_DIR)
	glib-compile-schemas "$(EXT_DIR)/schemas"
	mkdir -p $(DIST)
	cd "$(EXT_DIR)" && zip -qr "$(CURDIR)/$(ZIP)" .
	@echo "Packaged $(ZIP)"
	@echo "Install it with: gnome-extensions install --force $(ZIP)"

clean:
	rm -rf .build $(PACK_DIR) $(STAGING) $(DIST) src/_build

enable:
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

prefs:
	gnome-extensions prefs "$(UUID)"

reset:
	gnome-extensions reset "$(UUID)"

uninstall:
	gnome-extensions uninstall "$(UUID)"

renderer: build
	gjs -m ./src/_build/renderer.js $(ARGS)

log:
	journalctl -f -o cat /usr/bin/gnome-shell

lint:
	npm run lint -- src/

lint-fix:
	npm run lint -- src/ --fix

pot:
	find src/ -iname "*.ts" -not -path "src/_build/*" -print0 | xargs -0 xgettext \
		--from-code=UTF-8 \
		--package-name="aerial-wallpapers" \
		--package-version="1" \
		--copyright-holder="Michael D. Murray" \
		--output="$(POT_FILE)"
	sed -i \
		-e "s/SOME DESCRIPTIVE TITLE\./GNOME Shell Extension - Aerial Wallpapers/" \
		-e "s/Copyright (C) YEAR/Copyright (C) 2026/" \
		-e "s/charset=CHARSET/charset=UTF-8/" \
		"$(POT_FILE)"

merge-po: pot
	@while read -r lang; do \
		[ -z "$$lang" ] && continue; \
		echo "Merging $$lang.po..."; \
		msgmerge --update --backup=none "$(POT_DIR)/$$lang.po" "$(POT_FILE)"; \
	done < "$(POT_DIR)/LINGUAS"
