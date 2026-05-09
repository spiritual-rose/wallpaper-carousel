UUID    := wallpaper-carousel@rangol.se
DOMAIN  := wallpaper-carousel-rangol-se
PREFIX  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES := metadata.json extension.js prefs.js LICENSE
SCHEMA  := schemas/org.gnome.shell.extensions.wallpaper-carousel.gschema.xml
PO_FILES := $(wildcard po/*.po)
MO_FILES := $(patsubst po/%.po,locale/%/LC_MESSAGES/$(DOMAIN).mo,$(PO_FILES))

.PHONY: all install uninstall zip clean potfile check

all: schemas/gschemas.compiled $(MO_FILES)

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas schemas/

locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	mkdir -p $(dir $@)
	msgfmt -o $@ $<

install: all
	mkdir -p $(PREFIX)/schemas
	cp $(SOURCES) $(PREFIX)/
	cp $(SCHEMA) schemas/gschemas.compiled $(PREFIX)/schemas/
	if [ -d locale ]; then cp -r locale $(PREFIX)/; fi
	@echo "Installed to $(PREFIX)"
	@echo "Run: gnome-extensions enable $(UUID)"
	@echo "Then log out and back in (Wayland) or restart the shell with Alt+F2 r (X11)."

uninstall:
	rm -rf $(PREFIX)

potfile:
	xgettext --from-code=UTF-8 \
		--package-name="Wallpaper Carousel" \
		--keyword=_ --keyword=N_ \
		-o po/$(DOMAIN).pot \
		extension.js prefs.js
	@echo "Note: metadata.json strings (name/description) must be added to the .pot by hand."

zip: $(MO_FILES)
	rm -f $(UUID).zip
	zip -r $(UUID).zip $(SOURCES) $(SCHEMA)
	if [ -d locale ]; then zip -r $(UUID).zip locale; fi

check: zip
	shexli $(UUID).zip

clean:
	rm -rf schemas/gschemas.compiled $(UUID).zip locale
