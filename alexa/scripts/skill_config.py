#!/usr/bin/env python3
"""Skill-Grundwerte pro Locale (alexa/skill.config.json).

Zentrale Quelle fuer Skill-Namen und Aufrufnamen. Rendert daraus das
Interaktionsmodell (invocationName) und das Manifest (Anzeigename) und stellt
die Werte fuer die Lambda-Umgebung bereit. Eine weitere Sprache ist damit nur
noch ein zusaetzlicher Eintrag unter "locales" plus eine Modell-Datei.

Nutzung:
  python3 alexa/scripts/skill_config.py --render-all
  python3 alexa/scripts/skill_config.py --print-env de-DE
  python3 alexa/scripts/skill_config.py --check
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "alexa" / "skill.config.json"
MODEL_DIR = REPO / "alexa" / "skill-package" / "interactionModels" / "custom"
MANIFEST = REPO / "alexa" / "skill-package" / "skill.json"
DEFAULT_LOCALE = "de-DE"

# Alexa-Aufrufname: mindestens zwei Woerter, keine Ziffern; erlaubt sind
# Buchstaben (inkl. Umlaute) und Leerzeichen.
_NAME_RE = re.compile(r"^[A-Za-zÄÖÜäöüß ]+$")


def load():
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def locales(cfg=None):
    return list((cfg or load())["locales"].keys())


def primary_locale(cfg=None):
    locs = locales(cfg)
    return DEFAULT_LOCALE if DEFAULT_LOCALE in locs else locs[0]


def validate(locale, data):
    name = data.get("invocation_name", "")
    if len(name.split()) < 2:
        raise ValueError("{}: invocation_name braucht mindestens zwei Woerter ({!r})".format(locale, name))
    if not _NAME_RE.match(name):
        raise ValueError("{}: invocation_name darf nur Buchstaben und Leerzeichen enthalten ({!r})".format(locale, name))
    if not data.get("skill_name"):
        raise ValueError("{}: skill_name fehlt".format(locale))


_VIEWPORT_RE = re.compile(
    r'\{\n\s*"mode": "([^"]+)",\n\s*"shape": "([^"]+)",\n\s*"minWidth": (\d+),\n'
    r'\s*"maxWidth": (\d+),\n\s*"minHeight": (\d+),\n\s*"maxHeight": (\d+)\n\s*\}'
)


def _dump_manifest(manifest):
    """Wie json.dumps(indent=2), setzt aber die supportedViewports wieder
    kompakt in eine Zeile - sonst erzeugt jedes Rendern ein grosses Diff."""
    text = json.dumps(manifest, ensure_ascii=False, indent=2)
    text = _VIEWPORT_RE.sub(
        lambda m: '{{ "mode": "{}", "shape": "{}", "minWidth": {}, "maxWidth": {}, '
        '"minHeight": {}, "maxHeight": {} }}'.format(*m.groups()),
        text,
    )
    return text + "\n"


def render_locale(locale, cfg=None):
    cfg = cfg or load()
    data = cfg["locales"][locale]
    validate(locale, data)

    model_path = MODEL_DIR / "{}.json".format(locale)
    model = json.loads(model_path.read_text(encoding="utf-8"))
    model["interactionModel"]["languageModel"]["invocationName"] = data["invocation_name"]
    model_path.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest["manifest"]["publishingInformation"]["locales"].setdefault(locale, {})["name"] = data["skill_name"]
    manifest["manifest"]["privacyAndCompliance"]["locales"].setdefault(locale, {})
    MANIFEST.write_text(_dump_manifest(manifest), encoding="utf-8")
    return data


def render_all(cfg=None):
    cfg = cfg or load()
    return {loc: render_locale(loc, cfg) for loc in locales(cfg)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--render-all", action="store_true", help="Modell + Manifest aus der Config schreiben")
    ap.add_argument("--check", action="store_true", help="nur validieren")
    ap.add_argument("--print-env", metavar="LOCALE", help="SKILL_NAME/ASSISTANT_NAME/INVOCATION_NAME als KEY=VALUE ausgeben")
    args = ap.parse_args()

    cfg = load()
    if args.check:
        for loc in locales(cfg):
            validate(loc, cfg["locales"][loc])
        print("OK: {} Locale(s): {}".format(len(locales(cfg)), ", ".join(locales(cfg))))
    elif args.render_all:
        print("gerendert: " + ", ".join(render_all(cfg)))
    elif args.print_env:
        data = cfg["locales"][args.print_env]
        print("SKILL_NAME={}".format(data["skill_name"]))
        print("ASSISTANT_NAME={}".format(data["assistant_name"]))
        print("INVOCATION_NAME={}".format(data["invocation_name"]))
    else:
        ap.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
