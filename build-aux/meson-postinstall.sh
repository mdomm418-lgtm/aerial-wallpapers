#!/bin/bash

# Package managers set this so we don't need to run
if [ -z "$DESTDIR" ]; then
  uuid="$1"
  echo Compiling GSettings schemas...
  glib-compile-schemas "${MESON_INSTALL_PREFIX}/share/glib-2.0/schemas"

  ext_schemas="${MESON_INSTALL_PREFIX}/share/gnome-shell/extensions/${uuid}/schemas"
  if [ -d "$ext_schemas" ]; then
    glib-compile-schemas "$ext_schemas"
  fi
fi
